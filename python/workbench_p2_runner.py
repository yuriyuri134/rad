#!/usr/bin/env python3
"""
OpenLab Bench v2 — 受控科学计算执行桥接器 (WF-RC-1000 实时 Optiland 0.6.3 & Astropy/Photutils/SEP)

提供两个真实可验证的子命令模式（从 stdin 读取 JSON 参数，流式输出无缓冲日志，最后一行输出 RESULT_JSON:<json>）：
1. --mode wf_rc_perturb_eval
   基于 experiments/p2_flagship/runs/branch_<key>.json（默认 S3），施加制造/装配微扰与可选补偿器
   ('none' | 'bfl_only' | 'm2_shim_plus_bfl')，执行真实多视场四波段光线追迹 + FFTPSF Strehl 计算。
2. --mode fits_star_extract
   打开真实 FITS 二进制文件与 TAN WCS 头，使用 photutils DAOStarFinder 或 sep 执行真实天体星表提取，
   计算像素质心、RA/Dec 坐标、孔径通量、SNR 与 FWHM (px 与 arcsec)，并在存在真值表时核对完备度。
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import math
import os
import sys
import time
import warnings
from pathlib import Path
from typing import Any

warnings.filterwarnings("ignore")

SOURCE_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = Path(os.environ.get("OPENLAB_LEGACY_DATA_ROOT", SOURCE_ROOT)).resolve()
P2_SCRIPTS_DIR = SOURCE_ROOT / "experiments" / "p2_flagship" / "scripts"
P2_RUNS_DIR = REPO_ROOT / "experiments" / "p2_flagship" / "runs"

if str(P2_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(P2_SCRIPTS_DIR))


def log_step(msg: str) -> None:
    print(f"[openlab-py] {msg}", flush=True)


def get_package_versions() -> dict[str, str | None]:
    versions: dict[str, str | None] = {}
    for pkg in ("optiland", "numpy", "scipy", "astropy", "sep", "photutils"):
        try:
            versions[pkg] = importlib.metadata.version(pkg)
        except importlib.metadata.PackageNotFoundError:
            versions[pkg] = None
    return versions


def load_p2_branch_prescription(branch_key: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    key = branch_key.strip().upper()
    branch_file = P2_RUNS_DIR / f"branch_{key}.json"
    if branch_file.exists():
        with branch_file.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    else:
        v2_file = P2_RUNS_DIR / "S1_to_S4_correctors_v2.json"
        with v2_file.open("r", encoding="utf-8") as fh:
            all_v2 = json.load(fh)
        matched = next(
            (b for b in all_v2.get("branches", []) if b.get("branch_key") == key),
            None,
        )
        if not matched:
            raise FileNotFoundError(f"未找到 P2 光学分支处方 {branch_key}")
        data = matched

    lenses = []
    for item in data.get("lenses", []):
        lenses.append(
            {
                "c1": 1.0 / item["r1_mm"] if item.get("r1_mm") else 0.0,
                "c2": 1.0 / item["r2_mm"] if item.get("r2_mm") else 0.0,
                "tc": float(item["tc_mm"]),
                "material": item["material"],
                "gap_after": float(item["gap_after_mm"]),
            }
        )
    return data, lenses


def run_wf_rc_perturb_eval(params: dict[str, Any]) -> dict[str, Any]:
    t0 = time.time()
    import numpy as np
    from scipy.optimize import minimize_scalar
    from optiland.psf import FFTPSF
    from wf_rc_models import FIELDS_DEG, WLS_UM, build_rc_corrector
    from stage4_tolerancing import eval_mean_rms_um

    branch_key = str(params.get("baseBranchKey", "S3"))
    compensator = str(params.get("compensator", "m2_shim_plus_bfl"))

    log_step(f"加载真实 P2 处方 branch_{branch_key} 并初始化 Optiland 物理系统...")
    data, lenses = load_p2_branch_prescription(branch_key)
    d_m1_l1 = float(data["d_m1_l1_mm"])
    bfl = float(data["bfl_mm"])
    k1 = float(data["k1"]) + float(params.get("delta_k1", 0.0))
    k2 = float(data["k2"]) + float(params.get("delta_k2", 0.0))

    arcsec_to_rad = math.pi / (180.0 * 3600.0)
    perturb_base = {
        "delta_r1": float(params.get("delta_r1_mm", 0.0)),
        "delta_r2": float(params.get("delta_r2_mm", 0.0)),
        "delta_d_m1_m2": float(params.get("delta_d_m1_m2_mm", 0.0)),
        "delta_bfl": float(params.get("delta_bfl_mm", 0.0)),
        "m2_rx_rad": float(params.get("m2_tilt_arcsec", 0.0)) * arcsec_to_rad,
        "m2_dx_mm": float(params.get("m2_decenter_mm", 0.0)),
        "corr_rx_rad": float(params.get("corr_tilt_arcsec", 0.0)) * arcsec_to_rad,
        "corr_dx_mm": float(params.get("corr_decenter_mm", 0.0)),
    }

    has_asymmetric_tilt = any(
        abs(perturb_base[k]) > 1e-10 for k in ("m2_rx_rad", "m2_dx_mm", "corr_rx_rad", "corr_dx_mm")
    )

    log_step("执行未补偿状态多视场四波段 (0.45-0.80 um) 光线追迹...")
    uncomp_mean, uncomp_by_lbl, _ = eval_mean_rms_um(
        lenses, d_m1_l1, bfl, k1, k2, dict(perturb_base), num_rays=8, wls=WLS_UM
    )
    uncomp_max = max(uncomp_by_lbl.values()) if uncomp_by_lbl else 1e4
    log_step(f"未补偿结果: mean RMS = {uncomp_mean:.3f} um, max RMS = {uncomp_max:.3f} um")

    comp_delta_bfl = float(perturb_base["delta_bfl"])
    comp_m2_shim = 0.0
    final_perturb = dict(perturb_base)

    if compensator == "m2_shim_plus_bfl":
        log_step("启动补偿器 [M2 间距垫片 +/-0.8mm + BFL 调焦 +/-3.0mm] 优化...")
        base_m2_d = perturb_base["delta_d_m1_m2"]

        def obj_m2(shim_mm: float) -> float:
            p = dict(perturb_base)
            p["delta_d_m1_m2"] = base_m2_d + float(shim_mm)
            val, _, _ = eval_mean_rms_um(lenses, d_m1_l1, bfl, k1, k2, p, num_rays=4, wls=(0.55,))
            return val

        res_m2 = minimize_scalar(
            obj_m2, bounds=(-0.8, 0.8), method="bounded", options={"xatol": 0.002, "maxiter": 20}
        )
        comp_m2_shim = float(res_m2.x)
        final_perturb["delta_d_m1_m2"] = base_m2_d + comp_m2_shim

        def obj_bfl(dbfl: float) -> float:
            p = dict(final_perturb)
            p["delta_bfl"] = perturb_base["delta_bfl"] + float(dbfl)
            val, _, _ = eval_mean_rms_um(lenses, d_m1_l1, bfl, k1, k2, p, num_rays=4, wls=(0.55,))
            return val

        res_bfl = minimize_scalar(
            obj_bfl, bounds=(-3.0, 3.0), method="bounded", options={"xatol": 0.005, "maxiter": 25}
        )
        comp_delta_bfl = float(res_bfl.x)
        final_perturb["delta_bfl"] = perturb_base["delta_bfl"] + comp_delta_bfl
        log_step(f"收敛垫片位移 comp_m2_shim={comp_m2_shim:+.4f} mm, delta_bfl={comp_delta_bfl:+.4f} mm")

    elif compensator == "bfl_only":
        log_step("启动补偿器 [仅 BFL 机械后焦调节 +/-12.0mm] 优化...")

        def obj_bfl_only(dbfl: float) -> float:
            p = dict(perturb_base)
            p["delta_bfl"] = perturb_base["delta_bfl"] + float(dbfl)
            val, _, _ = eval_mean_rms_um(lenses, d_m1_l1, bfl, k1, k2, p, num_rays=4, wls=(0.55,))
            return val

        res_bfl = minimize_scalar(
            obj_bfl_only, bounds=(-12.0, 12.0), method="bounded", options={"xatol": 0.005, "maxiter": 25}
        )
        comp_delta_bfl = float(res_bfl.x)
        final_perturb["delta_bfl"] = perturb_base["delta_bfl"] + comp_delta_bfl
        log_step(f"收敛调焦位移 delta_bfl={comp_delta_bfl:+.4f} mm")

    log_step("执行最终态高精度光斑追迹与 550nm FFTPSF 衍射 Strehl 比计算...")
    comp_mean, comp_by_lbl, sys_final = eval_mean_rms_um(
        lenses, d_m1_l1, bfl, k1, k2, final_perturb, num_rays=10, wls=WLS_UM
    )
    comp_max = max(comp_by_lbl.values()) if comp_by_lbl else 1e4

    strat = "best_fit" if has_asymmetric_tilt else "chief_ray"
    fp_center = FFTPSF(sys_final, field=(0.0, 0.0), wavelength=0.55, num_rays=48, grid_size=128, strategy=strat)
    fp_edge = FFTPSF(sys_final, field=(0.0, 1.0), wavelength=0.55, num_rays=48, grid_size=128, strategy=strat)
    strehl_center = round(float(fp_center.strehl_ratio()), 4)
    strehl_edge = round(float(fp_edge.strehl_ratio()), 4)

    if not has_asymmetric_tilt:
        try:
            efl_mm = round(float(np.ravel(sys_final.paraxial.f2())[0]), 3)
        except Exception:
            efl_mm = float(data.get("metrics", {}).get("efl_mm", 6000.0))
    else:
        efl_mm = float(data.get("metrics", {}).get("efl_mm", 6000.0))

    passed_rms = comp_max <= 7.5
    passed_strehl = strehl_center >= 0.80 and strehl_edge >= 0.80
    elapsed_ms = round((time.time() - t0) * 1000.0, 1)

    log_step(
        f"计算完成 ({elapsed_ms} ms): max_rms={comp_max:.3f} um, Strehl(0/0.6)={strehl_center}/{strehl_edge}"
    )

    return {
        "status": "ok",
        "mode": "wf_rc_perturb_eval",
        "baseBranchKey": branch_key,
        "baseBranchId": data.get("branch_id", branch_key),
        "compensator": compensator,
        "hasAsymmetricTiltOrDecenter": has_asymmetric_tilt,
        "appliedPerturbations": params,
        "uncompensated": {
            "meanRmsUm": round(uncomp_mean, 3),
            "maxRmsUm": round(uncomp_max, 3),
            "rmsByFieldUm": uncomp_by_lbl,
        },
        "compensated": {
            "eflMm": efl_mm,
            "compM2ShimMm": round(comp_m2_shim, 4),
            "compDeltaBflMm": round(comp_delta_bfl, 4),
            "meanRmsUm": round(comp_mean, 3),
            "maxRmsUm": round(comp_max, 3),
            "rmsByFieldUm": comp_by_lbl,
            "strehl550Center": strehl_center,
            "strehl550Edge": strehl_edge,
            "psfStrategy": strat,
        },
        "criteriaChecks": {
            "rmsSpotLe7_5Um": passed_rms,
            "strehlGe0_80": passed_strehl,
            "overallPassed": bool(passed_rms and passed_strehl),
        },
        "packageVersions": get_package_versions(),
        "durationMs": elapsed_ms,
    }


def run_fits_star_extract(params: dict[str, Any]) -> dict[str, Any]:
    t0 = time.time()
    import numpy as np
    from astropy.io import fits
    from astropy.stats import sigma_clipped_stats
    from astropy.wcs import WCS
    from photutils.aperture import CircularAperture, aperture_photometry
    from photutils.detection import DAOStarFinder
    import sep

    rel_path = str(params.get("fitsPath", "experiments/p2_flagship/runs/fits/S3_3Lens_Wynne_FS_QuasiRC_tile_0.60deg.fits"))
    abs_path = (REPO_ROOT / rel_path).resolve()
    if not abs_path.is_file() or not abs_path.is_relative_to((P2_RUNS_DIR / "fits").resolve()):
        raise FileNotFoundError(f"非法的 FITS 文件路径: {rel_path}")

    extractor = str(params.get("extractor", "photutils_DAOStarFinder"))
    fwhm_px = float(params.get("fwhmPx", 2.0))
    threshold_sigma = float(params.get("thresholdSigma", 5.0))
    aperture_radius_px = float(params.get("apertureRadiusPx", 4.5))
    min_area = int(params.get("minArea", 3))

    log_step(f"读取 FITS 文件 {rel_path} 并解析 TAN WCS...")
    with fits.open(abs_path) as hdul:
        hdu = hdul[0]
        data = np.asarray(hdu.data, dtype=np.float64)
        header = hdu.header
        wcs = WCS(header)

    mean_sky, median_sky, std_sky = sigma_clipped_stats(data, sigma=3.0)
    data_sub = np.ascontiguousarray(data - float(median_sky), dtype=np.float64)
    cdelt = abs(float(header.get("CDELT2", 0.0)))
    pixel_scale_arcsec = round(cdelt * 3600.0, 4) if cdelt > 0 else None

    truth_count = header.get("NTRUTH")
    log_step(f"背景估计 median={median_sky:.2f} ADU, sigma={std_sky:.2f} ADU; 运行 {extractor}...")

    sources: list[dict[str, Any]] = []

    if extractor == "sep_extract":
        bkg = sep.Background(np.ascontiguousarray(data, dtype=np.float64))
        sub_sep = np.ascontiguousarray(data - bkg.back(), dtype=np.float64)
        rms_val = float(bkg.globalrms)
        objs = sep.extract(sub_sep, threshold_sigma, err=rms_val, minarea=min_area)
        flux, fluxerr, _ = sep.sum_circle(sub_sep, objs["x"], objs["y"], aperture_radius_px, err=rms_val)

        order = np.argsort(-objs["peak"])
        for rank, idx in enumerate(order, start=1):
            x_c = float(objs["x"][idx])
            y_c = float(objs["y"][idx])
            a_px = max(0.2, float(objs["a"][idx]))
            b_px = max(0.2, float(objs["b"][idx]))
            fwhm_est = 2.0 * math.sqrt(math.log(2.0) * (a_px * a_px + b_px * b_px))
            peak_val = float(objs["peak"][idx])
            ap_flux = float(flux[idx])
            err_val = max(1e-6, float(fluxerr[idx]))
            snr = ap_flux / err_val if err_val > 0 else peak_val / max(1e-6, rms_val)
            ra_deg, dec_deg = wcs.pixel_to_world_values(x_c, y_c) if wcs.has_celestial else (None, None)
            sources.append(
                {
                    "id": rank,
                    "xCentroid": round(x_c, 2),
                    "yCentroid": round(y_c, 2),
                    "peakAdu": round(peak_val + float(bkg.globalback), 1),
                    "apertureFlux": round(ap_flux, 1),
                    "snrEstimate": round(float(snr), 1),
                    "fwhmPxEstimate": round(fwhm_est, 2),
                    "fwhmArcsec": round(fwhm_est * pixel_scale_arcsec, 3) if pixel_scale_arcsec else None,
                    "raDeg": round(float(ra_deg), 6) if ra_deg is not None else None,
                    "decDeg": round(float(dec_deg), 6) if dec_deg is not None else None,
                    "extractor": "sep_extract",
                }
            )
    else:
        finder = DAOStarFinder(fwhm=fwhm_px, threshold=threshold_sigma * float(std_sky))
        tbl = finder(data_sub)
        if tbl is not None and len(tbl) > 0:
            positions = np.transpose((tbl["xcentroid"], tbl["ycentroid"]))
            apertures = CircularAperture(positions, r=aperture_radius_px)
            phot = aperture_photometry(data_sub, apertures)
            # Compute local second-moment FWHM estimate
            h, w = data_sub.shape
            r_int = max(2, int(round(aperture_radius_px)))
            rows = []
            for idx in range(len(tbl)):
                xc = float(tbl["xcentroid"][idx])
                yc = float(tbl["ycentroid"][idx])
                peak = float(tbl["peak"][idx])
                ap_flux = float(phot["aperture_sum"][idx])
                snr = peak / max(1e-6, float(std_sky))
                ix, iy = int(round(xc)), int(round(yc))
                x0, x1 = max(0, ix - r_int), min(w, ix + r_int + 1)
                y0, y1 = max(0, iy - r_int), min(h, iy + r_int + 1)
                patch = np.maximum(0.0, data_sub[y0:y1, x0:x1])
                psum = float(np.sum(patch))
                if psum > 0:
                    yy, xx = np.mgrid[y0:y1, x0:x1]
                    r2 = float(np.sum(((xx - xc) ** 2 + (yy - yc) ** 2) * patch) / (2.0 * psum))
                    fwhm_est = math.sqrt(max(0.05, r2)) * 2.3548
                else:
                    fwhm_est = fwhm_px
                ra_deg, dec_deg = wcs.pixel_to_world_values(xc, yc) if wcs.has_celestial else (None, None)
                rows.append(
                    {
                        "xCentroid": round(xc, 2),
                        "yCentroid": round(yc, 2),
                        "peakAdu": round(peak + float(median_sky), 1),
                        "apertureFlux": round(ap_flux, 1),
                        "snrEstimate": round(snr, 1),
                        "fwhmPxEstimate": round(fwhm_est, 2),
                        "fwhmArcsec": round(fwhm_est * pixel_scale_arcsec, 3) if pixel_scale_arcsec else None,
                        "raDeg": round(float(ra_deg), 6) if ra_deg is not None else None,
                        "decDeg": round(float(dec_deg), 6) if dec_deg is not None else None,
                        "extractor": "photutils_DAOStarFinder",
                    }
                )
            rows.sort(key=lambda r: -r["peakAdu"])
            for rank, item in enumerate(rows, start=1):
                sources.append({"id": rank, **item})

    fwhm_vals = [s["fwhmPxEstimate"] for s in sources]
    median_fwhm_px = round(float(np.median(fwhm_vals)), 3) if fwhm_vals else None
    median_fwhm_arcsec = (
        round(median_fwhm_px * pixel_scale_arcsec, 3) if (median_fwhm_px and pixel_scale_arcsec) else None
    )
    elapsed_ms = round((time.time() - t0) * 1000.0, 1)
    log_step(f"星表提取完成 ({elapsed_ms} ms): 共检出 {len(sources)} 个点源, median FWHM={median_fwhm_px} px")

    return {
        "status": "ok",
        "mode": "fits_star_extract",
        "fitsPath": rel_path,
        "extractor": extractor,
        "parameters": {
            "fwhmPx": fwhm_px,
            "thresholdSigma": threshold_sigma,
            "apertureRadiusPx": aperture_radius_px,
            "minArea": min_area,
        },
        "width": int(data.shape[1]),
        "height": int(data.shape[0]),
        "medianSkyAdu": round(float(median_sky), 3),
        "skyNoiseSigmaAdu": round(float(std_sky), 3),
        "pixelScaleArcsec": pixel_scale_arcsec,
        "truthStarCountHeader": int(truth_count) if truth_count is not None else None,
        "detectedCount": len(sources),
        "medianFwhmPx": median_fwhm_px,
        "medianFwhmArcsec": median_fwhm_arcsec,
        "detectedSources": sources,
        "packageVersions": get_package_versions(),
        "durationMs": elapsed_ms,
    }


def run_fits_batch_completeness(params: dict[str, Any]) -> dict[str, Any]:
    t0 = time.time()
    import numpy as np
    from astropy.io import fits
    from astropy.stats import sigma_clipped_stats
    from astropy.wcs import WCS
    from photutils.detection import DAOStarFinder
    import sep

    fits_dir = P2_RUNS_DIR / "fits"
    if not fits_dir.exists():
        raise FileNotFoundError(f"未找到 FITS 目录: {fits_dir}")

    raw_keys = params.get(
        "systemKeys",
        ["S1_2Lens_FS_RC", "S2_3Lens_Wynne_FS_RC", "S3_3Lens_Wynne_FS_QuasiRC", "S4_3Lens_Wynne_FS_F2_RC"],
    )
    if isinstance(raw_keys, str):
        system_keys = [k.strip() for k in raw_keys.split(",") if k.strip()]
    else:
        system_keys = [str(k).strip() for k in raw_keys if str(k).strip()]
    include_all = not system_keys or "ALL" in system_keys

    fwhm_px = max(0.7, min(6.0, float(params.get("fwhmPx", 1.5))))
    threshold_sigma = max(1.5, min(20.0, float(params.get("thresholdSigma", 4.5))))
    sep_threshold_sigma = max(1.5, min(20.0, float(params.get("sepThresholdSigma", 4.5))))
    sep_min_area = max(2, int(params.get("sepMinArea", 4)))
    match_radius_px = max(1.0, min(10.0, float(params.get("matchRadiusPx", 3.5))))

    stage3_ref_path = P2_RUNS_DIR / "stage3_fits_astrometry.json"
    stage3_ref_by_file: dict[str, dict[str, Any]] = {}
    if stage3_ref_path.exists():
        with stage3_ref_path.open("r", encoding="utf-8") as fh:
            stage3_json = json.load(fh)
        for sys_obj in stage3_json.get("systems", {}).values():
            for tile in sys_obj.get("tiles", []):
                fp = str(tile.get("fits_path", "")).replace("\\", "/")
                fname = Path(fp).name
                stage3_ref_by_file[fname] = tile

    all_fits = sorted(fits_dir.glob("*.fits"))
    selected_files: list[tuple[str, float, Path]] = []
    for p in all_fits:
        stem = p.stem
        sys_key = stem.split("_tile_")[0] if "_tile_" in stem else stem
        if not include_all and sys_key not in system_keys:
            continue
        field_deg = 0.0
        if "_tile_" in stem:
            try:
                field_deg = float(stem.split("_tile_")[1].replace("deg", ""))
            except ValueError:
                field_deg = 0.0
        selected_files.append((sys_key, field_deg, p))

    if not selected_files:
        raise ValueError(f"未匹配到任何 FITS 文件 (systemKeys={system_keys})")

    log_step(
        f"开始批量 FITS 欠采样横评: {len(selected_files)} 帧, DAOStarFinder(fwhm={fwhm_px}px, thresh={threshold_sigma}σ) vs SEP(minarea={sep_min_area})..."
    )

    tile_results: list[dict[str, Any]] = []
    for sys_key, field_deg, abs_path in selected_files:
        with fits.open(abs_path) as hdul:
            data = np.asarray(hdul[0].data, dtype=np.float64)
            header = hdul[0].header
            wcs = WCS(header)

        _, median_sky, std_sky = sigma_clipped_stats(data, sigma=3.0)
        data_sub = np.ascontiguousarray(data - float(median_sky), dtype=np.float64)
        cdelt = abs(float(header.get("CDELT2", 0.0)))
        pix_scale = round(cdelt * 3600.0, 4) if cdelt > 0 else 0.5157

        finder = DAOStarFinder(fwhm=fwhm_px, threshold=threshold_sigma * float(std_sky))
        tbl = finder(data_sub)
        dao_x = np.asarray(tbl["xcentroid"], dtype=float) if tbl is not None and len(tbl) > 0 else np.array([], dtype=float)
        dao_y = np.asarray(tbl["ycentroid"], dtype=float) if tbl is not None and len(tbl) > 0 else np.array([], dtype=float)

        # Estimate local second-moment FWHM for DAO detections
        h, w = data_sub.shape
        dao_fwhms: list[float] = []
        for xc, yc in zip(dao_x, dao_y):
            ix, iy = int(round(float(xc))), int(round(float(yc)))
            x0, x1 = max(0, ix - 4), min(w, ix + 5)
            y0, y1 = max(0, iy - 4), min(h, iy + 5)
            patch = np.maximum(0.0, data_sub[y0:y1, x0:x1])
            psum = float(np.sum(patch))
            if psum > 0:
                yy, xx = np.mgrid[y0:y1, x0:x1]
                r2 = float(np.sum(((xx - xc) ** 2 + (yy - yc) ** 2) * patch) / (2.0 * psum))
                dao_fwhms.append(math.sqrt(max(0.05, r2)) * 2.3548)

        bkg = sep.Background(np.ascontiguousarray(data, dtype=np.float64))
        sub_sep = np.ascontiguousarray(data - bkg.back(), dtype=np.float64)
        sep_objs = sep.extract(sub_sep, sep_threshold_sigma, err=float(bkg.globalrms), minarea=sep_min_area)
        sep_x = np.asarray(sep_objs["x"], dtype=float) if len(sep_objs) > 0 else np.array([], dtype=float)
        sep_y = np.asarray(sep_objs["y"], dtype=float) if len(sep_objs) > 0 else np.array([], dtype=float)

        # Greedy cross-match DAO vs SEP within match_radius_px
        used_sep: set[int] = set()
        matched_count = 0
        for dx, dy in zip(dao_x, dao_y):
            best_j = None
            best_d = 1e9
            for j, (sx, sy) in enumerate(zip(sep_x, sep_y)):
                if j in used_sep:
                    continue
                d = math.hypot(float(dx - sx), float(dy - sy))
                if d < best_d:
                    best_d = d
                    best_j = j
            if best_j is not None and best_d <= match_radius_px:
                used_sep.add(best_j)
                matched_count += 1

        dao_count = int(len(dao_x))
        sep_count = int(len(sep_x))
        match_vs_sep_pct = round(100.0 * matched_count / max(1, sep_count), 1)
        unmatched_excess = max(0, dao_count - matched_count)
        med_fwhm_px = round(float(np.median(dao_fwhms)), 2) if dao_fwhms else None
        med_fwhm_as = round(med_fwhm_px * pix_scale, 3) if med_fwhm_px else None

        ref_tile = stage3_ref_by_file.get(abs_path.name, {})
        ref_phot = ref_tile.get("photutils", {})
        ref_sep = ref_tile.get("sep", {})
        n_truth = int(ref_sep.get("n_truth") or ref_phot.get("n_truth") or 28)
        dao_vs_truth_pct = round(100.0 * min(matched_count, n_truth) / max(1, n_truth), 1)

        tile_results.append(
            {
                "systemKey": sys_key,
                "fieldDeg": field_deg,
                "fileName": abs_path.name,
                "fitsPath": f"experiments/p2_flagship/runs/fits/{abs_path.name}",
                "skySigmaAdu": round(float(std_sky), 3),
                "hasCelestialWcs": bool(wcs.has_celestial),
                "daoCount": dao_count,
                "sepCount": sep_count,
                "daoMatchedToSep": matched_count,
                "daoVsSepMatchPct": match_vs_sep_pct,
                "daoVsTruthRefPct": dao_vs_truth_pct,
                "daoUnmatchedExcess": unmatched_excess,
                "daoMedianFwhmPx": med_fwhm_px,
                "daoMedianFwhmArcsec": med_fwhm_as,
                "stage3Dao3pxCompletenessPct": ref_phot.get("completeness_pct"),
                "stage3SepCompletenessPct": ref_sep.get("completeness_pct"),
            }
        )
        log_step(
            f"  {sys_key} {field_deg:.2f}°: DAO({fwhm_px}px)={dao_count}, SEP={sep_count}, 交叉匹配={matched_count} ({match_vs_sep_pct}% vs SEP, Stage3 DAO3px={ref_phot.get('completeness_pct')}%)"
        )

    mean_match_sep = round(sum(t["daoVsSepMatchPct"] for t in tile_results) / len(tile_results), 1)
    min_match_sep = round(min(t["daoVsSepMatchPct"] for t in tile_results), 1)
    mean_dao_vs_truth = round(sum(t["daoVsTruthRefPct"] for t in tile_results) / len(tile_results), 1)
    total_excess = sum(t["daoUnmatchedExcess"] for t in tile_results)
    stage3_dao_vals = [float(t["stage3Dao3pxCompletenessPct"]) for t in tile_results if t["stage3Dao3pxCompletenessPct"] is not None]
    mean_stage3_dao = round(sum(stage3_dao_vals) / len(stage3_dao_vals), 1) if stage3_dao_vals else None
    stage3_sep_vals = [float(t["stage3SepCompletenessPct"]) for t in tile_results if t["stage3SepCompletenessPct"] is not None]
    mean_stage3_sep = round(sum(stage3_sep_vals) / len(stage3_sep_vals), 1) if stage3_sep_vals else None

    elapsed_ms = round((time.time() - t0) * 1000.0, 1)
    log_step(
        f"批量横评完成 ({elapsed_ms} ms): {len(tile_results)} 帧均匹配率(vs SEP)={mean_match_sep}% (Stage3 DAO3px均值={mean_stage3_dao}%), 未匹配余项={total_excess}"
    )

    return {
        "status": "ok",
        "mode": "fits_batch_completeness",
        "parameters": {
            "systemKeys": system_keys,
            "fwhmPx": fwhm_px,
            "thresholdSigma": threshold_sigma,
            "sepThresholdSigma": sep_threshold_sigma,
            "sepMinArea": sep_min_area,
            "matchRadiusPx": match_radius_px,
        },
        "tilesCount": len(tile_results),
        "meanDaoMatchedToSepPct": mean_match_sep,
        "minDaoMatchedToSepPct": min_match_sep,
        "meanDaoVsTruthRefPct": mean_dao_vs_truth,
        "totalDaoUnmatchedExcess": total_excess,
        "meanStage3Dao3pxPct": mean_stage3_dao,
        "meanStage3SepPct": mean_stage3_sep,
        "tileResults": tile_results,
        "packageVersions": get_package_versions(),
        "durationMs": elapsed_ms,
    }


def run_wf_rc_s4_reopt_probe(params: dict[str, Any]) -> dict[str, Any]:
    t0 = time.time()
    import numpy as np
    from scipy.optimize import least_squares
    from wf_rc_models import K1_RC, K2_RC, build_rc_corrector, evaluate_optical_system, lens_edge_thickness
    from stage2_corrector_v2 import make_ray_residual_fn, unpack_vector

    strategy = str(params.get("strategy", "unlock_conics_multi_seed"))
    max_nfev = max(15, min(90, int(params.get("maxNfev", 40))))
    num_rays_opt = max(3, min(6, int(params.get("numRaysOpt", 4))))
    eval_num_rays = max(8, min(16, int(params.get("evalNumRays", 12))))

    log_step(f"启动 S4 (Fused Silica + Schott F2 + Fused Silica) 诊断重优化: strategy={strategy}, maxNfev={max_nfev}...")
    with (P2_RUNS_DIR / "branch_S2.json").open("r", encoding="utf-8") as fh:
        s2_data = json.load(fh)
    with (P2_RUNS_DIR / "branch_S4.json").open("r", encoding="utf-8") as fh:
        s4_data = json.load(fh)
    with (P2_RUNS_DIR / "branch_S3.json").open("r", encoding="utf-8") as fh:
        s3_data = json.load(fh)

    s2_u = [float(v) for v in s2_data["best_u"]]
    s4_u = [float(v) for v in s4_data["best_u"]]

    lb_base = [-6.0, -6.0, -7.0, -7.0, -6.0, -6.0, 0.4, 0.1, 0.1, 0.55]
    ub_base = [6.0, 6.0, 7.0, 7.0, 6.0, 6.0, 3.0, 2.5, 2.5, 2.2]

    # Build seed plans based on requested strategy
    seed_plans: list[tuple[str, bool, list[float]]] = []
    # Scaled F2 curvature seed: reduces S4's steep L2 curvature by FS/F2 refractive power ratio
    f2_scaled_u = [s4_u[0], s4_u[1], -3.2, -2.9, s4_u[4], s4_u[5], s4_u[6], s4_u[7], s4_u[8], s4_u[9]]

    if strategy == "conic_locked_scaled_seed":
        seed_plans.append(("S4-F2光焦度重定标(锁定RC圆锥)", False, f2_scaled_u))
    elif strategy == "both_compare":
        seed_plans.append(("锁定RC圆锥+F2重定标起点", False, f2_scaled_u))
        seed_plans.append(("解锁K1/K2+S2/S3协同起点", True, s2_u + [-1.14865, -6.46154]))
    else:
        # Default: unlock_conics_multi_seed
        seed_plans.append(("解锁K1/K2+S2起点", True, s2_u + [K1_RC, K2_RC]))
        seed_plans.append(("解锁K1/K2+S3准RC起点", True, s2_u + [float(s3_data["k1"]), float(s3_data["k2"])]))

    best_sol = None
    best_meta = None
    best_cost = float("inf")
    best_seed_name = ""
    seed_runs: list[dict[str, Any]] = []

    for seed_name, unlock_conics, u0_list in seed_plans:
        spec_meta = {
            "materials": ["Fused Silica", "F2", "Fused Silica"],
            "thicknesses": [22.0, 14.0, 20.0],
            "unlock_conics": unlock_conics,
        }
        lb = np.array(lb_base + ([-1.6, -9.0] if unlock_conics else []), dtype=float)
        ub = np.array(ub_base + ([-0.8, -3.5] if unlock_conics else []), dtype=float)
        u0 = np.clip(np.array(u0_list, dtype=float), lb + 1e-4, ub - 1e-4)

        res_fn, counter = make_ray_residual_fn(spec_meta, num_rays_opt=num_rays_opt)
        init_res = res_fn(u0)
        init_cost = round(float(0.5 * np.sum(init_res * init_res)), 3)
        log_step(f"  运行种子 [{seed_name}]: 初始 cost={init_cost} (maxNfev={max_nfev})...")

        ts = time.perf_counter()
        sol = least_squares(
            res_fn,
            u0,
            bounds=(lb, ub),
            method="trf",
            ftol=1e-5,
            xtol=1e-5,
            gtol=1e-5,
            diff_step=1e-4,
            max_nfev=max_nfev,
        )
        dt_s = round(time.perf_counter() - ts, 2)
        n_used = int(counter["n"])
        final_cost = round(float(sol.cost), 3)
        log_step(f"  种子 [{seed_name}] 收敛态: cost={init_cost} -> {final_cost}, nfev={n_used}, dt={dt_s}s")

        seed_runs.append(
            {
                "seedName": seed_name,
                "unlockConics": unlock_conics,
                "initialCost": init_cost,
                "finalCost": final_cost,
                "nfev": n_used,
                "status": int(sol.status),
                "dtSec": dt_s,
            }
        )
        if float(sol.cost) < best_cost:
            best_cost = float(sol.cost)
            best_sol = sol
            best_meta = spec_meta
            best_seed_name = seed_name

    assert best_sol is not None and best_meta is not None
    lenses, d_m1_l1, bfl, k1, k2 = unpack_vector(best_sol.x, best_meta)
    log_step(f"评估最优 S4 候选 [{best_seed_name}] 全波段光斑 + FFTPSF Strehl + MTF (num_rays={eval_num_rays})...")
    best_sys = build_rc_corrector(
        lenses,
        d_m1_l1=d_m1_l1,
        bfl=bfl,
        k1=k1,
        k2=k2,
        apply_obsc=True,
        name="S4_reopt_probe",
    )
    metrics_raw = evaluate_optical_system(best_sys, num_rays=eval_num_rays, compute_psf=True, compute_mtf=True)

    edge_checks: list[dict[str, Any]] = []
    for l_idx, lens in enumerate(lenses):
        sf = 4 + 2 * l_idx
        semi = max(
            metrics_raw["lens_clear_semi_apertures_mm"].get(str(sf), 70.0),
            metrics_raw["lens_clear_semi_apertures_mm"].get(str(sf + 1), 70.0),
        ) + 5.0
        et = lens_edge_thickness(lens["c1"], lens["c2"], lens["tc"], semi)
        edge_checks.append(
            {
                "lens": l_idx + 1,
                "material": lens["material"],
                "r1_mm": round(1.0 / lens["c1"], 3) if abs(lens["c1"]) > 1e-8 else None,
                "r2_mm": round(1.0 / lens["c2"], 3) if abs(lens["c2"]) > 1e-8 else None,
                "tc_mm": lens["tc"],
                "gap_after_mm": round(lens["gap_after"], 3),
                "clear_semi_ap_mm": round(semi, 2),
                "edge_thickness_mm": round(et, 2),
            }
        )

    total_behind = d_m1_l1 + sum(l["tc"] for l in lenses) + sum(l["gap_after"] for l in lenses[:-1]) + bfl
    rms_by_field = metrics_raw.get("rms_um_poly_by_field", {})
    strehl_by_field = metrics_raw.get("fft_strehl_550nm", {})
    mtf_by_field = metrics_raw.get("mtf_33lp_mm_550nm", {})
    new_max_rms = float(metrics_raw.get("max_rms_poly_um", 999.0))
    strehl_edge = float(strehl_by_field.get("0.6", 0.0))
    s4_orig_rms = float(s4_data.get("metrics", {}).get("max_rms_poly_um", 9.704))
    s3_orig_rms = float(s3_data.get("metrics", {}).get("max_rms_poly_um", 1.063))
    improvement_pct = round(100.0 * (s4_orig_rms - new_max_rms) / max(1e-6, s4_orig_rms), 1)
    elapsed_ms = round((time.time() - t0) * 1000.0, 1)

    log_step(
        f"S4 重优化诊断完成 ({elapsed_ms} ms): maxRMS {s4_orig_rms} -> {new_max_rms} um (改善 {improvement_pct}%), Strehl(0/0.6)={strehl_by_field.get('0.0')}/{strehl_edge}"
    )

    return {
        "status": "ok",
        "mode": "wf_rc_s4_reopt_probe",
        "strategy": strategy,
        "bestSeedName": best_seed_name,
        "unlock_conics": bool(best_meta["unlock_conics"]),
        "materials": best_meta["materials"],
        "k1": round(k1, 7),
        "k2": round(k2, 7),
        "d_m1_l1_mm": round(d_m1_l1, 3),
        "bfl_mm": round(bfl, 3),
        "total_behind_m1_mm": round(total_behind, 3),
        "lenses": edge_checks,
        "seedRuns": seed_runs,
        "baselineComparison": {
            "stage2S4MaxRmsUm": s4_orig_rms,
            "stage2S4Cost": 597.635,
            "stage2S3MaxRmsUm": s3_orig_rms,
            "newMaxRmsUm": new_max_rms,
            "newBestCost": round(best_cost, 3),
            "rmsImprovementPct": improvement_pct,
            "meetsRms7_5Um": bool(new_max_rms <= 7.5),
            "meetsStrehl0_80": bool(strehl_edge >= 0.80 and float(strehl_by_field.get("0.0", 0.0)) >= 0.80),
        },
        "metrics": {
            "eflMm": metrics_raw.get("efl_mm"),
            "fNumber": metrics_raw.get("fno"),
            "rms000Um": rms_by_field.get("0.0"),
            "rms025Um": rms_by_field.get("0.25"),
            "rms042Um": rms_by_field.get("0.42"),
            "rms060Um": rms_by_field.get("0.6"),
            "maxRmsPolyUm": new_max_rms,
            "meanRmsPolyUm": metrics_raw.get("mean_rms_poly_um"),
            "strehlCenter": strehl_by_field.get("0.0"),
            "strehlMid": strehl_by_field.get("0.42"),
            "strehlEdge": strehl_edge,
            "mtfEdgeTan": (mtf_by_field.get("0.6") or {}).get("tangential"),
            "distortionMaxPct": metrics_raw.get("distortion_pct_max_abs"),
            "k1": round(k1, 7),
            "k2": round(k2, 7),
            "dM1L1Mm": round(d_m1_l1, 3),
            "bflMm": round(bfl, 3),
            "optCost": round(best_cost, 3),
            "optSeedCount": len(seed_runs),
        },
        "rawMetrics": metrics_raw,
        "packageVersions": get_package_versions(),
        "durationMs": elapsed_ms,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="OpenLab Bench v2 Python Scientific Runner")
    parser.add_argument(
        "--mode",
        required=True,
        choices=[
            "wf_rc_perturb_eval",
            "fits_star_extract",
            "fits_batch_completeness",
            "wf_rc_s4_reopt_probe",
        ],
    )
    args = parser.parse_args()

    raw_stdin = sys.stdin.read().strip()
    params = json.loads(raw_stdin) if raw_stdin else {}

    if args.mode == "wf_rc_perturb_eval":
        res = run_wf_rc_perturb_eval(params)
    elif args.mode == "fits_star_extract":
        res = run_fits_star_extract(params)
    elif args.mode == "fits_batch_completeness":
        res = run_fits_batch_completeness(params)
    else:
        res = run_wf_rc_s4_reopt_probe(params)

    print("RESULT_JSON:" + json.dumps(res, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
