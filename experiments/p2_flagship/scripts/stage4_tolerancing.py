import argparse
import json
import math
import os
import time
import numpy as np
from scipy.optimize import minimize_scalar
from optiland.psf import FFTPSF

from wf_rc_models import FIELDS_DEG, WLS_UM, build_rc_corrector

RUNS_DIR = "experiments/p2_flagship/runs"


def load_branch_spec(branch_key):
    path = os.path.join(RUNS_DIR, f"branch_{branch_key}.json")
    with open(path, "r", encoding="utf-8") as fh:
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
    return data, lenses


def eval_mean_rms_um(lenses, d_m1_l1, bfl, k1, k2, perturb, num_rays=5, wls=(0.45, 0.55, 0.80)):
    sys = build_rc_corrector(
        lenses,
        d_m1_l1=d_m1_l1,
        bfl=bfl,
        k1=k1,
        k2=k2,
        apply_obsc=True,
        perturb=perturb,
    )
    max_f = max(FIELDS_DEG)
    # Sample +Hy, -Hy, +Hx at outer field when tilted/decentered to capture asymmetric coma!
    field_pts = [(0.0, 0.0), (0.0, 0.42 / max_f), (0.0, 1.0), (0.0, -1.0), (1.0, 0.0)]
    rms_list = []
    for hx, hy in field_pts:
        xs, ys = [], []
        for wl in wls:
            sys.trace(Hx=hx, Hy=hy, wavelength=wl, num_rays=num_rays)
            x = np.asarray(sys.surfaces[-1].x, dtype=float)
            y = np.asarray(sys.surfaces[-1].y, dtype=float)
            inten = np.asarray(sys.surfaces[-1].intensity, dtype=float)
            m = (inten > 0) & np.isfinite(x) & np.isfinite(y)
            if np.sum(m) < 8:
                return 1e4, {}, sys
            xs.append(x[m])
            ys.append(y[m])
        ax = np.concatenate(xs)
        ay = np.concatenate(ys)
        cx, cy = float(np.mean(ax)), float(np.mean(ay))
        rms = float(np.sqrt(np.mean((ax - cx) ** 2 + (ay - cy) ** 2)) * 1000.0)
        rms_list.append(rms)

    by_lbl = {
        "center": round(rms_list[0], 3),
        "mid_0.42": round(rms_list[1], 3),
        "edge_+Y": round(rms_list[2], 3),
        "edge_-Y": round(rms_list[3], 3),
        "edge_+X": round(rms_list[4], 3),
    }
    return float(np.mean(rms_list)), by_lbl, sys


def compensate_bfl_and_eval(lenses, d_m1_l1, bfl, k1, k2, perturb_base, bfl_bound=12.0):
    def obj(dbfl):
        p = dict(perturb_base)
        p["delta_bfl"] = float(dbfl)
        val, _, _ = eval_mean_rms_um(lenses, d_m1_l1, bfl, k1, k2, p, num_rays=4, wls=(0.55,))
        return val

    res = minimize_scalar(obj, bounds=(-bfl_bound, bfl_bound), method="bounded", options={"xatol": 0.005, "maxiter": 25})
    best_dbfl = float(res.x)
    p_comp = dict(perturb_base)
    p_comp["delta_bfl"] = best_dbfl
    mean_rms, by_lbl, sys_comp = eval_mean_rms_um(lenses, d_m1_l1, bfl, k1, k2, p_comp, num_rays=8, wls=WLS_UM)
    max_rms = max(by_lbl.values()) if by_lbl else 1e4

    # Real best_fit FFTPSF Strehl at 0° and 0.6° (explicitly supports tilted/decentered systems!)
    fp0 = FFTPSF(sys_comp, field=(0.0, 0.0), wavelength=0.55, num_rays=48, grid_size=128, strategy="best_fit")
    fp6 = FFTPSF(sys_comp, field=(0.0, 1.0), wavelength=0.55, num_rays=48, grid_size=128, strategy="best_fit")
    return {
        "comp_delta_bfl_mm": round(best_dbfl, 4),
        "mean_rms_um": round(mean_rms, 3),
        "max_rms_um": round(max_rms, 3),
        "rms_by_field_um": by_lbl,
        "strehl_550_center": round(float(fp0.strehl_ratio()), 4),
        "strehl_550_edge": round(float(fp6.strehl_ratio()), 4),
    }


def compensate_m2_shim_and_bfl_eval(lenses, d_m1_l1, bfl, k1, k2, perturb_base):
    """
    Realistic integration regime: measure fabricated mirror radii (R1, R2),
    shim M1-M2 axial spacing once (+/- 0.8 mm) so focus returns to nominal BFL,
    plus final +/- 3 mm instrument focus stage.
    """
    base_m2_d = perturb_base.get("delta_d_m1_m2", 0.0)

    def obj_m2(shim_mm):
        p = dict(perturb_base)
        p["delta_d_m1_m2"] = base_m2_d + float(shim_mm)
        val, _, _ = eval_mean_rms_um(lenses, d_m1_l1, bfl, k1, k2, p, num_rays=4, wls=(0.55,))
        return val

    res_m2 = minimize_scalar(obj_m2, bounds=(-0.8, 0.8), method="bounded", options={"xatol": 0.002, "maxiter": 20})
    p_shimmed = dict(perturb_base)
    p_shimmed["delta_d_m1_m2"] = base_m2_d + float(res_m2.x)
    out = compensate_bfl_and_eval(lenses, d_m1_l1, bfl, k1, k2, p_shimmed, bfl_bound=3.0)
    out["comp_m2_shim_mm"] = round(float(res_m2.x), 4)
    return out


def summarize_mc(mc_trials):
    max_rms_arr = np.array([t["max_rms_um"] for t in mc_trials])
    mean_rms_arr = np.array([t["mean_rms_um"] for t in mc_trials])
    strehl_c_arr = np.array([t["strehl_550_center"] for t in mc_trials])
    strehl_e_arr = np.array([t["strehl_550_edge"] for t in mc_trials])
    return {
        "n_trials": len(mc_trials),
        "max_rms_um_p50": round(float(np.percentile(max_rms_arr, 50)), 3),
        "max_rms_um_p80": round(float(np.percentile(max_rms_arr, 80)), 3),
        "max_rms_um_p95": round(float(np.percentile(max_rms_arr, 95)), 3),
        "mean_rms_um_p50": round(float(np.percentile(mean_rms_arr, 50)), 3),
        "mean_rms_um_p80": round(float(np.percentile(mean_rms_arr, 80)), 3),
        "strehl_center_p50": round(float(np.percentile(strehl_c_arr, 50)), 4),
        "strehl_center_p20": round(float(np.percentile(strehl_c_arr, 20)), 4),
        "strehl_edge_p50": round(float(np.percentile(strehl_e_arr, 50)), 4),
        "strehl_edge_p20": round(float(np.percentile(strehl_e_arr, 20)), 4),
        "yield_max_rms_le_7_5um_pct": round(float(100.0 * np.mean(max_rms_arr <= 7.5)), 1),
        "yield_max_rms_le_10_0um_pct": round(float(100.0 * np.mean(max_rms_arr <= 10.0)), 1),
        "yield_max_rms_le_15_0um_pct": round(float(100.0 * np.mean(max_rms_arr <= 15.0)), 1),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--branch", default="S3")
    parser.add_argument("--trials", type=int, default=40)
    args = parser.parse_args()

    bkey = args.branch
    if not os.path.exists(os.path.join(RUNS_DIR, f"branch_{bkey}.json")):
        bkey = "S2"

    data, lenses = load_branch_spec(bkey)
    d_m1_l1 = data["d_m1_l1_mm"]
    bfl = data["bfl_mm"]
    k1 = data["k1"]
    k2 = data["k2"]

    print(f"\n=== STAGE 4 TOLERANCING v2: {data['branch_id']} (trials={args.trials}) ===", flush=True)
    t0 = time.perf_counter()

    nom = compensate_bfl_and_eval(lenses, d_m1_l1, bfl, k1, k2, {}, bfl_bound=12.0)
    print(f"Nominal: {nom}", flush=True)

    arcsec_to_rad = math.pi / (180.0 * 3600.0)
    oat_cases = [
        ("M1_R1_+1.5mm", {"delta_r1": 1.5}),
        ("M2_R2_+1.0mm", {"delta_r2": 1.0}),
        ("M1_M2_spacing_+0.05mm", {"delta_d_m1_m2": 0.05}),
        ("M2_tilt_20arcsec", {"m2_rx_rad": 20.0 * arcsec_to_rad}),
        ("M2_decenter_0.05mm", {"m2_dy_mm": 0.05}),
        ("Corrector_spacing_+0.10mm", {"delta_d_m1_l1": 0.10}),
        ("Corrector_tilt_60arcsec", {"corr_rx_rad": 60.0 * arcsec_to_rad}),
        ("Corrector_decenter_0.10mm", {"corr_dy_mm": 0.10}),
        ("L1_c1_+0.1pct", {"lens_c_deltas": [(lenses[0]["c1"] * 0.001, 0.0)] + [(0.0, 0.0)] * (len(lenses) - 1)}),
    ]
    oat_results = []
    for name, p_dict in oat_cases:
        uncomp_rms, _, _ = eval_mean_rms_um(lenses, d_m1_l1, bfl, k1, k2, p_dict, num_rays=6, wls=WLS_UM)
        comp_res = compensate_bfl_and_eval(lenses, d_m1_l1, bfl, k1, k2, p_dict, bfl_bound=12.0)
        entry = {
            "perturbation": name,
            "uncomp_mean_rms_um": round(uncomp_rms, 3),
            **comp_res,
            "delta_max_rms_um": round(comp_res["max_rms_um"] - nom["max_rms_um"], 3),
        }
        oat_results.append(entry)
        print(f"  OAT {name:26s}: uncomp={entry['uncomp_mean_rms_um']:6.2f}um -> comp_max={entry['max_rms_um']:6.2f}um (d_bfl={entry['comp_delta_bfl_mm']:+.3f}mm, Strehl_edge={entry['strehl_550_edge']})", flush=True)

    # Compare M1_R1_+1.5mm under M2-spacing shim vs BFL-only refocus
    r1_shimmed = compensate_m2_shim_and_bfl_eval(lenses, d_m1_l1, bfl, k1, k2, {"delta_r1": 1.5})
    print(f"  OAT M1_R1_+1.5mm (M2 shim + BFL): max_rms={r1_shimmed['max_rms_um']}um, m2_shim={r1_shimmed['comp_m2_shim_mm']}mm, d_bfl={r1_shimmed['comp_delta_bfl_mm']}mm, Strehl_edge={r1_shimmed['strehl_550_edge']}", flush=True)

    rng = np.random.default_rng(2026)
    mc_bfl_only = []
    mc_m2_shimmed = []
    for i in range(args.trials):
        c_deltas = [(l["c1"] * rng.uniform(-0.001, 0.001), l["c2"] * rng.uniform(-0.001, 0.001)) for l in lenses]
        p = {
            "delta_r1": float(rng.uniform(-1.5, 1.5)),
            "delta_r2": float(rng.uniform(-1.0, 1.0)),
            "delta_d_m1_m2": float(rng.uniform(-0.05, 0.05)),
            "m2_rx_rad": float(rng.uniform(-20.0, 20.0) * arcsec_to_rad),
            "m2_ry_rad": float(rng.uniform(-20.0, 20.0) * arcsec_to_rad),
            "m2_dx_mm": float(rng.uniform(-0.05, 0.05)),
            "m2_dy_mm": float(rng.uniform(-0.05, 0.05)),
            "delta_d_m1_l1": float(rng.uniform(-0.10, 0.10)),
            "corr_rx_rad": float(rng.uniform(-60.0, 60.0) * arcsec_to_rad),
            "corr_ry_rad": float(rng.uniform(-60.0, 60.0) * arcsec_to_rad),
            "corr_dx_mm": float(rng.uniform(-0.10, 0.10)),
            "corr_dy_mm": float(rng.uniform(-0.10, 0.10)),
            "lens_tc_deltas": [float(rng.uniform(-0.05, 0.05)) for _ in lenses],
            "lens_gap_deltas": [float(rng.uniform(-0.05, 0.05)) for _ in lenses],
            "lens_c_deltas": c_deltas,
        }
        res_bfl = compensate_bfl_and_eval(lenses, d_m1_l1, bfl, k1, k2, p, bfl_bound=12.0)
        res_shim = compensate_m2_shim_and_bfl_eval(lenses, d_m1_l1, bfl, k1, k2, p)
        mc_bfl_only.append(res_bfl)
        mc_m2_shimmed.append(res_shim)
        if (i + 1) % 10 == 0 or i == 0:
            print(
                f"  MC {i+1}/{args.trials}: BFL-12mm max_rms={res_bfl['max_rms_um']}um (Strehl={res_bfl['strehl_550_edge']}) | "
                f"M2-shim max_rms={res_shim['max_rms_um']}um (Strehl={res_shim['strehl_550_edge']})",
                flush=True,
            )

    stats_bfl = summarize_mc(mc_bfl_only)
    stats_shim = summarize_mc(mc_m2_shimmed)
    summary = {
        "branch_id": data["branch_id"],
        "tolerances_applied": {
            "R1_mm": "+/- 1.5",
            "R2_mm": "+/- 1.0",
            "M1_M2_spacing_mm": "+/- 0.05",
            "M2_tilt_arcsec": "+/- 20",
            "M2_decenter_mm": "+/- 0.05",
            "Corrector_axial_mm": "+/- 0.10",
            "Corrector_tilt_arcsec": "+/- 60",
            "Corrector_decenter_mm": "+/- 0.10",
            "Lens_radius_rel": "+/- 0.1%",
            "Lens_tc_gap_mm": "+/- 0.05",
        },
        "nominal": nom,
        "oat_sensitivities_bfl_12mm": oat_results,
        "oat_m1_r1_with_m2_shim": r1_shimmed,
        "monte_carlo_bfl_12mm": stats_bfl,
        "monte_carlo_m2_shim_plus_bfl_3mm": stats_shim,
        "elapsed_s": round(time.perf_counter() - t0, 2),
    }

    out_path = os.path.join(RUNS_DIR, "stage4_tolerancing.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2, ensure_ascii=False)
    print(f"\nSaved {out_path}", flush=True)
    print(f"  BFL-12mm stats: {stats_bfl}", flush=True)
    print(f"  M2-shim  stats: {stats_shim}", flush=True)


if __name__ == "__main__":
    main()
