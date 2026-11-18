import json
import math
import os
import time
import warnings
import numpy as np
from astropy.io import fits
from astropy.stats import sigma_clipped_stats
from astropy.wcs import WCS
from photutils.aperture import CircularAperture, aperture_photometry
from photutils.detection import DAOStarFinder
from scipy.ndimage import rotate, shift
import sep
from optiland.analysis import CentroidReferencePoint
from optiland.analysis.image_simulation import ImageSimulationEngine
from optiland.psf import FFTPSF

from wf_rc_models import (
    D_M1_M2_BASE,
    EFL_TARGET,
    FIELDS_DEG,
    K1_RC,
    K2_RC,
    PIXEL_PITCH_UM,
    WLS_UM,
    build_rc_corrector,
)

warnings.filterwarnings("ignore")

FITS_DIR = "experiments/p2_flagship/runs/fits"
os.makedirs(FITS_DIR, exist_ok=True)

TILE_SIZE = 512
PLATE_CRVAL_RA = 180.0
PLATE_CRVAL_DEC = 0.0
# Physical detector constants
GAIN_E_PER_ADU = 1.8
READ_NOISE_E = 5.0
SKY_BG_E = 180.0


def load_system_from_branch(branch_json_path):
    with open(branch_json_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    lenses = []
    for item in data["lenses"]:
        lenses.append(
            {
                "c1": 1.0 / item["r1_mm"] if item["r1_mm"] else 0.0,
                "c2": 1.0 / item["r2_mm"] if item["r2_mm"] else 0.0,
                "tc": item["tc_mm"],
                "material": item["material"],
                "gap_after": item["gap_after_mm"],
            }
        )
    sys = build_rc_corrector(
        lenses,
        d_m1_l1=data["d_m1_l1_mm"],
        bfl=data["bfl_mm"],
        k1=data["k1"],
        k2=data["k2"],
        apply_obsc=True,
        name=data["branch_id"],
    )
    return data["branch_id"], sys, data["metrics"]["efl_mm"]


def compute_radial_centroid_and_psf_bank(sys, efl_mm, field_angles=FIELDS_DEG):
    """
    1) Trace polychromatic ray centroids at radial fields [0 .. 0.60 deg] (clamping Hy <= 1.0)
       and fit odd radial model dr(r) = c1*r + c3*r^3 + c5*r^5 to capture real optical
       distortion + lateral color/coma centroid relative to ideal EFL*tan(theta) out to 0.65 deg.
    2) Compute real polychromatic FFTPSF at `field_angles`, physically resampled onto 15 um CCD pixels.
    """
    r_trace_deg = np.linspace(0.0, 0.60, 13)
    r_real_mm = []
    max_f = max(FIELDS_DEG)
    for r_deg in r_trace_deg:
        hy = min(1.0, float(r_deg / max_f))
        ys = []
        for wl in WLS_UM:
            sys.trace(Hx=0.0, Hy=hy, wavelength=wl, num_rays=10)
            y = np.asarray(sys.surfaces[-1].y, dtype=float)
            inten = np.asarray(sys.surfaces[-1].intensity, dtype=float)
            m = inten > 0
            ys.append(y[m])
        r_real_mm.append(float(np.mean(np.concatenate(ys))))
    r_real_mm = np.asarray(r_real_mm, dtype=float)
    r_ideal_mm = efl_mm * np.tan(np.deg2rad(r_trace_deg))
    dr_trace_mm = r_real_mm - r_ideal_mm
    # Fit odd radial basis [r, r^3, r^5] and evaluate across [0.0 .. 0.65] deg
    A = np.column_stack([r_trace_deg, r_trace_deg ** 3, r_trace_deg ** 5])
    coeffs, _, _, _ = np.linalg.lstsq(A, dr_trace_mm, rcond=None)
    r_grid_deg = np.linspace(0.0, 0.65, 14)
    dr_mm_grid = coeffs[0] * r_grid_deg + coeffs[1] * (r_grid_deg ** 3) + coeffs[2] * (r_grid_deg ** 5)

    # Polychromatic FFTPSF bank resampled onto 15 um detector grid
    # Use num_rays=160, grid_size=512 -> physical box ~524 um (captures even S0 0.6 deg outer spot!)
    psf_bank = {}
    stamp_half = 24  # 49x49 CCD pixels (735 um x 735 um)
    stamp_size = 2 * stamp_half + 1
    out_coords = (np.arange(stamp_size) - stamp_half) * PIXEL_PITCH_UM

    for fy in field_angles:
        hy = fy / max_f
        # Sum normalized wavelength PSFs onto a common 15-um detector stamp
        acc_stamp = np.zeros((stamp_size, stamp_size), dtype=np.float64)
        for wl in WLS_UM:
            fp = FFTPSF(sys, field=(0.0, hy), wavelength=wl, num_rays=160, grid_size=512)
            psf_raw = np.asarray(fp.psf, dtype=np.float64)
            psf_raw = np.maximum(psf_raw, 0.0)
            psf_raw /= np.sum(psf_raw)
            wx_um, wy_um = fp._get_psf_units(fp.psf)
            dx_um = float(wx_um) / psf_raw.shape[1]
            dy_um = float(wy_um) / psf_raw.shape[0]

            # Center on raw PSF energy centroid so orientation/spread is preserved without double-counting chief shift
            yy, xx = np.mgrid[: psf_raw.shape[0], : psf_raw.shape[1]]
            cy_raw = float(np.sum(yy * psf_raw))
            cx_raw = float(np.sum(xx * psf_raw))

            # Integrate/sample onto 15 um detector pixel grid using bilinear resampling over sub-pixel bins
            # Oversample 5x5 inside each 15 um pixel for flux-conserving integration
            sub_offsets = np.linspace(-0.4, 0.4, 5) * PIXEL_PITCH_UM
            oy, ox = np.meshgrid(out_coords, out_coords, indexing="ij")
            sub_acc = np.zeros_like(acc_stamp)
            for sy_off in sub_offsets:
                for sx_off in sub_offsets:
                    ix = np.clip(np.rint(cx_raw + (ox + sx_off) / dx_um).astype(int), 0, psf_raw.shape[1] - 1)
                    iy = np.clip(np.rint(cy_raw + (oy + sy_off) / dy_um).astype(int), 0, psf_raw.shape[0] - 1)
                    sub_acc += psf_raw[iy, ix]
            if np.sum(sub_acc) > 0:
                sub_acc /= np.sum(sub_acc)
            acc_stamp += sub_acc / len(WLS_UM)

        acc_stamp /= np.sum(acc_stamp)
        psf_bank[fy] = acc_stamp
        print(f"    [PSF bank] field={fy:.2f}deg ready (4 wls FFTPSF 160x512)", flush=True)

    return r_grid_deg, dr_mm_grid, psf_bank


def make_tile_wcs(fy_center_deg, efl_mm):
    pixel_scale_deg = (206264.806 / efl_mm) * (PIXEL_PITCH_UM / 1000.0) / 3600.0
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    # Define global tangent projection centered on optical axis (RA=180, Dec=0),
    # with this tile's center located at (0, fy_center_deg) above optical axis:
    dy_px_offset = fy_center_deg / pixel_scale_deg
    w.wcs.crval = [PLATE_CRVAL_RA, PLATE_CRVAL_DEC]
    w.wcs.crpix = [TILE_SIZE / 2.0 + 0.5, TILE_SIZE / 2.0 + 0.5 - dy_px_offset]
    w.wcs.cdelt = [-pixel_scale_deg, pixel_scale_deg]
    return w, pixel_scale_deg


def simulate_tile(sys_id, fy_center, efl_mm, r_grid_deg, dr_mm_grid, psf_bank, seed=42):
    rng = np.random.default_rng(seed + int(round(fy_center * 1000)))
    wcs_tile, pix_scale_deg = make_tile_wcs(fy_center, efl_mm)
    pix_scale_arcsec = pix_scale_deg * 3600.0

    # Nearest field PSF kernel from bank
    nearest_fy = min(psf_bank.keys(), key=lambda f: abs(f - fy_center))
    base_kernel = psf_bank[nearest_fy]
    kh, kw = base_kernel.shape
    half_k = kh // 2

    # Generate 28 stars across [36, TILE_SIZE-36] with fluxes spanning bright (SNR~150) to faint (SNR~8)
    n_stars = 28
    # Keep stars well-separated (>= 26 px) for clean astrometry & photometry
    star_pix = []
    attempts = 0
    while len(star_pix) < n_stars and attempts < 2000:
        attempts += 1
        tx = float(rng.uniform(38, TILE_SIZE - 38))
        ty = float(rng.uniform(38, TILE_SIZE - 38))
        if all(math.hypot(tx - sx, ty - sy) >= 28.0 for sx, sy in star_pix):
            star_pix.append((tx, ty))

    fluxes_e = np.geomspace(45000.0, 900.0, len(star_pix))
    rng.shuffle(fluxes_e)

    image_e = np.full((TILE_SIZE, TILE_SIZE), SKY_BG_E, dtype=np.float64)
    catalog = []

    for idx, ((x_tan, y_tan), flux_e) in enumerate(zip(star_pix, fluxes_e)):
        ra, dec = wcs_tile.pixel_to_world_values(x_tan, y_tan)
        # Physical off-axis angle relative to optical axis (CRPIX in global frame)
        dx_axis_px = -(x_tan - (wcs_tile.wcs.crpix[0] - 1.0))  # East is -x
        dy_axis_px = y_tan - (wcs_tile.wcs.crpix[1] - 1.0)
        hx_deg = dx_axis_px * pix_scale_deg
        hy_deg = dy_axis_px * pix_scale_deg
        r_deg = math.hypot(hx_deg, hy_deg)

        # Apply real optical radial distortion from Optiland ray trace
        dr_mm = float(np.interp(r_deg, r_grid_deg, dr_mm_grid))
        dr_px = (dr_mm * 1000.0) / PIXEL_PITCH_UM
        if r_deg > 1e-8:
            ux = (x_tan - (wcs_tile.wcs.crpix[0] - 1.0)) / math.hypot(x_tan - (wcs_tile.wcs.crpix[0] - 1.0), dy_axis_px)
            uy = dy_axis_px / math.hypot(x_tan - (wcs_tile.wcs.crpix[0] - 1.0), dy_axis_px)
        else:
            ux, uy = 0.0, 1.0
        x_opt = x_tan + dr_px * ux
        y_opt = y_tan + dr_px * uy

        # Rotate off-axis PSF radially to match azimuth (note base PSF is along +y = 90 deg)
        az_deg = math.degrees(math.atan2(uy, ux)) - 90.0
        k_rot = rotate(base_kernel, angle=az_deg, reshape=False, order=1, mode="constant", cval=0.0)
        # Sub-pixel shift inside stamp
        ix = int(round(x_opt))
        iy = int(round(y_opt))
        fx = x_opt - ix
        fy_sub = y_opt - iy
        k_shifted = shift(k_rot, shift=(fy_sub, fx), order=1, mode="constant", cval=0.0)
        k_shifted = np.maximum(k_shifted, 0.0)
        ksum = np.sum(k_shifted)
        if ksum > 0:
            k_shifted /= ksum

        y0, y1 = iy - half_k, iy + half_k + 1
        x0, x1 = ix - half_k, ix + half_k + 1
        if y0 >= 0 and y1 <= TILE_SIZE and x0 >= 0 and x1 <= TILE_SIZE:
            image_e[y0:y1, x0:x1] += flux_e * k_shifted

        catalog.append(
            {
                "id": idx + 1,
                "ra": float(ra),
                "dec": float(dec),
                "x_tan": float(x_tan),
                "y_tan": float(y_tan),
                "x_opt": float(x_opt),
                "y_opt": float(y_opt),
                "r_deg": float(r_deg),
                "dr_arcsec": float(dr_px * pix_scale_arcsec),
                "flux_e": float(flux_e),
            }
        )

    # Photon Poisson noise + CCD read noise -> ADU
    noisy_e = rng.poisson(np.maximum(image_e, 0.0)).astype(np.float64) + rng.normal(0.0, READ_NOISE_E, size=image_e.shape)
    adu = noisy_e / GAIN_E_PER_ADU

    # Save genuine FITS with TAN WCS header
    hdr = wcs_tile.to_header()
    hdr["OBJECT"] = f"{sys_id}_f{fy_center:.2f}"
    hdr["TELESCOP"] = "OpenLab-WF-RC-1000"
    hdr["PIXSIZE"] = (PIXEL_PITCH_UM, "Detector pixel pitch (um)")
    hdr["EFL_MM"] = (float(efl_mm), "Effective focal length (mm)")
    hdr["GAIN"] = (GAIN_E_PER_ADU, "e-/ADU")
    hdr["RDNOISE"] = (READ_NOISE_E, "e- RMS")
    fits_path = os.path.join(FITS_DIR, f"{sys_id}_tile_{fy_center:.2f}deg.fits")
    fits.PrimaryHDU(data=adu.astype(np.float32), header=hdr).writeto(fits_path, overwrite=True)

    # --- Source Extraction 1: Photutils DAOStarFinder ---
    with fits.open(fits_path) as hdul:
        img = np.ascontiguousarray(hdul[0].data, dtype=np.float64)
        w_read = WCS(hdul[0].header)

    _, median_bg, std_bg = sigma_clipped_stats(img, sigma=3.0)
    daofind = DAOStarFinder(fwhm=3.0, threshold=4.5 * std_bg)
    dao_tbl = daofind(img - median_bg)

    # --- Source Extraction 2: SEP (Source Extractor) ---
    bkg = sep.Background(img)
    img_sub = img - bkg.back()
    sep_objs = sep.extract(img_sub, thresh=4.5, err=bkg.globalrms, minarea=4)

    # Match SEP & Photutils detections to truth catalog
    def analyze_detections(det_x, det_y, label):
        matched_raw_err_as = []
        matched_nodist_err_as = []
        fwhm_as_list = []
        phot_ratios = []
        match_thresh_px = 10.0 if sys_id == "S0_bare_rc" else 4.0
        used = set()
        for star in catalog:
            best_j = None
            best_d = 1e9
            for j in range(len(det_x)):
                if j in used:
                    continue
                d = math.hypot(det_x[j] - star["x_opt"], det_y[j] - star["y_opt"])
                if d < best_d:
                    best_d = d
                    best_j = j
            if best_j is not None and best_d <= match_thresh_px:
                used.add(best_j)
                dx_px, dy_px = float(det_x[best_j]), float(det_y[best_j])
                # Raw WCS RA/Dec error vs true catalog RA/Dec
                ra_m, dec_m = w_read.pixel_to_world_values(dx_px, dy_px)
                d_ra_as = (ra_m - star["ra"]) * math.cos(math.radians(star["dec"])) * 3600.0
                d_dec_as = (dec_m - star["dec"]) * 3600.0
                matched_raw_err_as.append(math.hypot(d_ra_as, d_dec_as))
                # Distortion-corrected error (detector centroid vs x_opt, y_opt)
                matched_nodist_err_as.append(math.hypot(dx_px - star["x_opt"], dy_px - star["y_opt"]) * pix_scale_arcsec)

                # Aperture photometry r=4.0 px
                ap_flux, _, _ = sep.sum_circle(img_sub, [dx_px], [dy_px], r=4.0, gain=GAIN_E_PER_ADU)
                flux_meas_e = float(ap_flux[0]) * GAIN_E_PER_ADU
                phot_ratios.append(flux_meas_e / star["flux_e"])

                # Second-moment FWHM estimate in 5-px radius box
                ix0, iy0 = int(round(dx_px)), int(round(dy_px))
                if 6 <= ix0 < TILE_SIZE - 6 and 6 <= iy0 < TILE_SIZE - 6:
                    sub = np.maximum(img_sub[iy0 - 5 : iy0 + 6, ix0 - 5 : ix0 + 6], 0.0)
                    s_sum = np.sum(sub)
                    if s_sum > 0:
                        yy_s, xx_s = np.mgrid[iy0 - 5 : iy0 + 6, ix0 - 5 : ix0 + 6]
                        r2 = (xx_s - dx_px) ** 2 + (yy_s - dy_px) ** 2
                        sig = math.sqrt(float(np.sum(r2 * sub) / (2.0 * s_sum)))
                        fwhm_as_list.append(sig * 2.3548 * pix_scale_arcsec)

        return {
            "extractor": label,
            "n_truth": len(catalog),
            "n_detected": len(det_x),
            "n_matched": len(matched_nodist_err_as),
            "completeness_pct": round(100.0 * len(matched_nodist_err_as) / len(catalog), 1),
            "astrometry_raw_wcs_rms_arcsec": round(float(np.sqrt(np.mean(np.square(matched_raw_err_as)))), 4) if matched_raw_err_as else None,
            "astrometry_post_dist_rms_arcsec": round(float(np.sqrt(np.mean(np.square(matched_nodist_err_as)))), 4) if matched_nodist_err_as else None,
            "median_fwhm_arcsec": round(float(np.median(fwhm_as_list)), 3) if fwhm_as_list else None,
            "phot_flux_recovery_median": round(float(np.median(phot_ratios)), 4) if phot_ratios else None,
            "phot_flux_scatter_pct": round(float(np.std(phot_ratios) * 100.0), 2) if phot_ratios else None,
        }

    dao_x = np.asarray(dao_tbl["xcentroid"], dtype=float) if dao_tbl is not None and len(dao_tbl) > 0 else np.array([])
    dao_y = np.asarray(dao_tbl["ycentroid"], dtype=float) if dao_tbl is not None and len(dao_tbl) > 0 else np.array([])
    sep_x = np.asarray(sep_objs["x"], dtype=float) if len(sep_objs) > 0 else np.array([])
    sep_y = np.asarray(sep_objs["y"], dtype=float) if len(sep_objs) > 0 else np.array([])

    return {
        "field_deg": fy_center,
        "fits_path": fits_path,
        "sky_rms_adu": round(float(std_bg), 3),
        "photutils": analyze_detections(dao_x, dao_y, "photutils_DAOStarFinder"),
        "sep": analyze_detections(sep_x, sep_y, "sep_extract"),
    }


def check_image_simulation_engine(sys_obj, label):
    """Cross-verify Optiland's ImageSimulationEngine and measure its native pixel pitch vs 15 um CCD."""
    t0 = time.perf_counter()
    img = np.zeros((96, 96, 3), dtype=np.float64)
    yy, xx = np.mgrid[:96, :96]
    for cx, cy in [(24, 24), (48, 48), (72, 72)]:
        g = np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * 0.8 ** 2))
        for c in range(3):
            img[:, :, c] += g
    cfg = {
        "wavelengths": [0.656, 0.55, 0.45],
        "psf_grid_shape": (3, 3),
        "psf_size": 64,
        "num_rays": 48,
        "n_components": 3,
        "oversample": 1,
        "padding": 16,
        "psf_strategy": "chief_ray",
        "distortion_reference": CentroidReferencePoint(),
    }
    eng = ImageSimulationEngine(sys_obj, config=cfg)
    sim = np.asarray(eng.run(img))
    fp_probe = FFTPSF(sys_obj, field=(0.0, 0.0), wavelength=0.55, num_rays=48, grid_size=64)
    wx_um, _ = fp_probe._get_psf_units(fp_probe.psf)
    native_pitch_um = float(wx_um) / 64.0
    return {
        "system": label,
        "elapsed_s": round(time.perf_counter() - t0, 2),
        "output_shape": list(sim.shape),
        "native_psf_pixel_pitch_um": round(native_pitch_um, 3),
        "detector_pixel_pitch_um": PIXEL_PITCH_UM,
        "note": "ImageSimulationEngine convolves at native FFTPSF pitch (~2.4 um/px) rather than physical 15 um CCD pitch.",
    }


def main():
    t0 = time.perf_counter()
    # Load S0 (bare RC)
    s0 = build_rc_corrector([], d_m1_l1=450.0, bfl=0.0, apply_obsc=True, name="S0_bare_rc")
    systems = [("S0_bare_rc", s0, EFL_TARGET)]

    for key in ["S1", "S2", "S3", "S4"]:
        p = f"experiments/p2_flagship/runs/branch_{key}.json"
        if os.path.exists(p):
            bid, sys_obj, efl_mm = load_system_from_branch(p)
            systems.append((bid, sys_obj, efl_mm))

    results = {}
    for sys_id, sys_obj, efl_mm in systems:
        print(f"\n=== STAGE 3 FITS PIPELINE: {sys_id} (EFL={efl_mm}mm) ===", flush=True)
        ts = time.perf_counter()
        r_grid, dr_grid, psf_bank = compute_radial_centroid_and_psf_bank(sys_obj, efl_mm)
        tiles = []
        for fy in FIELDS_DEG:
            t_res = simulate_tile(sys_id, fy, efl_mm, r_grid, dr_grid, psf_bank)
            tiles.append(t_res)
            print(
                f"  fy={fy:.2f}deg | Photutils: comp={t_res['photutils']['completeness_pct']}%, "
                f"rawWCS={t_res['photutils']['astrometry_raw_wcs_rms_arcsec']}\", "
                f"postDist={t_res['photutils']['astrometry_post_dist_rms_arcsec']}\", "
                f"FWHM={t_res['photutils']['median_fwhm_arcsec']}\", phot={t_res['photutils']['phot_flux_recovery_median']} | "
                f"SEP: comp={t_res['sep']['completeness_pct']}%, postDist={t_res['sep']['astrometry_post_dist_rms_arcsec']}\"",
                flush=True,
            )
        results[sys_id] = {
            "efl_mm": efl_mm,
            "max_distortion_offset_um": round(float(np.max(np.abs(dr_grid)) * 1000.0), 2),
            "tiles": tiles,
            "elapsed_s": round(time.perf_counter() - ts, 2),
        }
        with open("experiments/p2_flagship/runs/stage3_fits_astrometry.partial.json", "w", encoding="utf-8") as fh:
            json.dump({"systems": results}, fh, indent=2, ensure_ascii=False)

    # Cross-check ImageSimulationEngine on winning system (S3)
    best_id, best_sys, _ = next(
        (s for s in systems if s[0].startswith("S3_")),
        systems[-1],
    )
    img_sim_audit = check_image_simulation_engine(best_sys, best_id)
    print(f"\nImageSimulationEngine audit: {img_sim_audit}", flush=True)

    summary = {
        "systems": results,
        "image_simulation_engine_audit": img_sim_audit,
        "total_elapsed_s": round(time.perf_counter() - t0, 2),
    }
    out_path = "experiments/p2_flagship/runs/stage3_fits_astrometry.json"
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2, ensure_ascii=False)
    print(f"\nSaved {out_path}", flush=True)


if __name__ == "__main__":
    main()
