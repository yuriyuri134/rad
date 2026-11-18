import argparse
import json
import math
import os
import time
import numpy as np
from scipy.optimize import least_squares
from wf_rc_models import (
    EFL_TARGET,
    FIELDS_DEG,
    K1_RC,
    K2_RC,
    build_rc_corrector,
    evaluate_optical_system,
    lens_edge_thickness,
)

WLS_OPT = [0.45, 0.55, 0.80]
FIELD_WEIGHTS = {0.0: 1.0, 0.25: 1.1, 0.42: 1.3, 0.60: 1.6}
RUNS_DIR = "experiments/p2_flagship/runs"


def unpack_vector(u, spec_meta):
    n_lenses = len(spec_meta["materials"])
    tcs = spec_meta["thicknesses"]
    unlock_conics = spec_meta.get("unlock_conics", False)
    curvs = [float(u[i]) * 1e-3 for i in range(2 * n_lenses)]
    d_m1_l1 = float(u[2 * n_lenses]) * 100.0
    gaps = [float(u[2 * n_lenses + 1 + j]) * 100.0 for j in range(n_lenses - 1)]
    bfl = float(u[3 * n_lenses]) * 100.0
    if unlock_conics:
        k1 = float(u[3 * n_lenses + 1])
        k2 = float(u[3 * n_lenses + 2])
    else:
        k1, k2 = K1_RC, K2_RC

    lenses = []
    for l_idx in range(n_lenses):
        lenses.append(
            {
                "c1": curvs[2 * l_idx],
                "c2": curvs[2 * l_idx + 1],
                "tc": tcs[l_idx],
                "material": spec_meta["materials"][l_idx],
                "gap_after": gaps[l_idx] if l_idx < n_lenses - 1 else bfl,
            }
        )
    return lenses, d_m1_l1, bfl, k1, k2


def make_ray_residual_fn(spec_meta, num_rays_opt=4):
    n_lenses = len(spec_meta["materials"])
    tcs = spec_meta["thicknesses"]
    counter = {"n": 0}

    probe_sys = build_rc_corrector(
        [{"c1": 0.0, "c2": 0.0, "tc": tcs[i], "material": spec_meta["materials"][i], "gap_after": 60.0} for i in range(n_lenses)],
        d_m1_l1=150.0,
        bfl=80.0,
    )
    probe_sys.trace(Hx=0.0, Hy=0.0, wavelength=0.55, num_rays=num_rays_opt)
    N_SLOTS = len(probe_sys.surfaces[-1].x)
    M_PER_FW = 2 * N_SLOTS
    N_EXTRA = 2 + n_lenses
    TOTAL_M = len(FIELDS_DEG) * len(WLS_OPT) * M_PER_FW + N_EXTRA

    def residuals(u):
        counter["n"] += 1
        lenses, d_m1_l1, bfl, k1, k2 = unpack_vector(u, spec_meta)
        try:
            sys = build_rc_corrector(lenses, d_m1_l1=d_m1_l1, bfl=bfl, k1=k1, k2=k2, apply_obsc=True)
            efl = float(np.ravel(sys.paraxial.f2())[0])
        except Exception:
            return np.full(TOTAL_M, 500.0)

        if not np.isfinite(efl) or abs(efl) > 25000.0:
            return np.full(TOTAL_M, 500.0)

        out = np.zeros(TOTAL_M, dtype=float)
        ptr = 0
        max_r_surf = {}
        for fy in FIELDS_DEG:
            hy = fy / max(FIELDS_DEG)
            wf = FIELD_WEIGHTS[fy]
            wl_data = []
            all_x, all_y = [], []
            for wl in WLS_OPT:
                try:
                    sys.trace(Hx=0.0, Hy=hy, wavelength=wl, num_rays=num_rays_opt)
                    x = np.asarray(sys.surfaces[-1].x, dtype=float)
                    y = np.asarray(sys.surfaces[-1].y, dtype=float)
                    inten = np.asarray(sys.surfaces[-1].intensity, dtype=float)
                    mask = (inten > 0) & np.isfinite(x) & np.isfinite(y)
                    if np.sum(mask) < 8 or len(x) != N_SLOTS:
                        return np.full(TOTAL_M, 500.0)
                    wl_data.append((x, y, mask))
                    all_x.append(x[mask])
                    all_y.append(y[mask])
                    for s_idx in range(4, len(sys.surfaces) - 1):
                        sx = np.asarray(sys.surfaces[s_idx].x, dtype=float)[mask]
                        sy = np.asarray(sys.surfaces[s_idx].y, dtype=float)[mask]
                        r_m = float(np.max(np.hypot(sx, sy)))
                        max_r_surf[s_idx] = max(max_r_surf.get(s_idx, 0.0), r_m)
                except Exception:
                    return np.full(TOTAL_M, 500.0)

            cat_x = np.concatenate(all_x)
            cat_y = np.concatenate(all_y)
            cx, cy = float(np.mean(cat_x)), float(np.mean(cat_y))
            norm_scale = wf * (1000.0 / math.sqrt(max(len(cat_x) / len(WLS_OPT), 1.0)))
            for (x, y, mask) in wl_data:
                out[ptr : ptr + N_SLOTS] = np.where(mask, (x - cx) * norm_scale, 0.0)
                out[ptr + N_SLOTS : ptr + 2 * N_SLOTS] = np.where(mask, (y - cy) * norm_scale, 0.0)
                ptr += 2 * N_SLOTS

        out[ptr] = (efl - EFL_TARGET) * 0.4
        ptr += 1

        total_behind = d_m1_l1 + sum(tcs) + sum(l["gap_after"] for l in lenses[:-1]) + bfl
        if total_behind < 300.0:
            out[ptr] = (300.0 - total_behind) * 2.0
        elif total_behind > 680.0:
            out[ptr] = (total_behind - 680.0) * 2.0
        else:
            out[ptr] = 0.0
        ptr += 1

        for l_idx in range(n_lenses):
            s_front = 4 + 2 * l_idx
            semi = max(max_r_surf.get(s_front, 70.0), max_r_surf.get(s_front + 1, 70.0)) + 5.0
            c1 = lenses[l_idx]["c1"]
            c2 = lenses[l_idx]["c2"]
            if abs(c1 * semi) >= 0.90 or abs(c2 * semi) >= 0.90:
                out[ptr] = 200.0
            else:
                et = lens_edge_thickness(c1, c2, tcs[l_idx], semi)
                out[ptr] = max(0.0, 7.0 - et) * 20.0
            ptr += 1

        return out

    return residuals, counter


def run_branch(branch_key, branch_id, spec_meta, seeds, lb, ub, max_nfev=120):
    print(f"\n=== BRANCH {branch_id} ({len(seeds)} seeds, max_nfev={max_nfev}) ===", flush=True)
    t0 = time.perf_counter()
    res_fn, counter = make_ray_residual_fn(spec_meta, num_rays_opt=4)

    best_sol = None
    best_cost = float("inf")
    seed_summaries = []

    for idx, u0 in enumerate(seeds):
        t_s = time.perf_counter()
        n_before = counter["n"]
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
        n_used = counter["n"] - n_before
        dt_s = round(time.perf_counter() - t_s, 2)
        print(f"  seed {idx}: cost={sol.cost:.2f}, nfev={n_used}, dt={dt_s}s, status={sol.status}", flush=True)
        seed_summaries.append({"seed": idx, "cost": round(float(sol.cost), 3), "nfev": n_used, "dt_s": dt_s, "status": int(sol.status)})
        if sol.cost < best_cost:
            best_cost = sol.cost
            best_sol = sol

    ckpt_path = os.path.join(RUNS_DIR, f"checkpoint_{branch_key}.json")
    with open(ckpt_path, "w", encoding="utf-8") as fh:
        json.dump({"branch_key": branch_key, "best_u": [float(v) for v in best_sol.x], "best_cost": float(best_cost), "seed_runs": seed_summaries}, fh, indent=2)

    lenses, d_m1_l1, bfl, k1, k2 = unpack_vector(best_sol.x, spec_meta)
    best_sys = build_rc_corrector(lenses, d_m1_l1=d_m1_l1, bfl=bfl, k1=k1, k2=k2, apply_obsc=True, name=branch_id)
    metrics = evaluate_optical_system(best_sys, num_rays=16, compute_psf=True, compute_mtf=True)

    edge_checks = []
    for l_idx, lens in enumerate(lenses):
        sf = 4 + 2 * l_idx
        semi = max(
            metrics["lens_clear_semi_apertures_mm"].get(str(sf), 70.0),
            metrics["lens_clear_semi_apertures_mm"].get(str(sf + 1), 70.0),
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

    total_behind_m1 = d_m1_l1 + sum(l["tc"] for l in lenses) + sum(l["gap_after"] for l in lenses[:-1]) + bfl
    out = {
        "branch_key": branch_key,
        "branch_id": branch_id,
        "materials": spec_meta["materials"],
        "unlock_conics": spec_meta.get("unlock_conics", False),
        "k1": round(k1, 7),
        "k2": round(k2, 7),
        "d_m1_l1_mm": round(d_m1_l1, 3),
        "bfl_mm": round(bfl, 3),
        "total_behind_m1_mm": round(total_behind_m1, 3),
        "lenses": edge_checks,
        "best_u": [round(float(v), 6) for v in best_sol.x],
        "seed_runs": seed_summaries,
        "elapsed_total_s": round(time.perf_counter() - t0, 2),
        "metrics": metrics,
    }

    out_path = os.path.join(RUNS_DIR, f"branch_{branch_key}.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
    print(
        f"  BEST {branch_id}: EFL={metrics['efl_mm']}mm, maxRMS_poly={metrics['max_rms_poly_um']}um, "
        f"RMS_poly={metrics['rms_um_poly_by_field']}, RMS_550={metrics['rms_um_550nm_by_field']}, "
        f"Strehl550={metrics['fft_strehl_550nm']}, Dist={metrics['distortion_pct_max_abs']}% -> Saved {out_path}",
        flush=True,
    )
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--branch", required=True, choices=["S1", "S2", "S3", "S4", "merge"])
    args = parser.parse_args()

    lb_s2 = np.array([-6.0, -6.0, -7.0, -7.0, -6.0, -6.0, 0.4, 0.1, 0.1, 0.55])
    ub_s2 = np.array([ 6.0,  6.0,  7.0,  7.0,  6.0,  6.0, 3.0, 2.5, 2.5, 2.2])

    if args.branch == "S1":
        meta = {"materials": ["Fused Silica", "Fused Silica"], "thicknesses": [20.0, 16.0], "unlock_conics": False}
        seeds = [
            np.array([1.8, 0.8, -1.2, 0.2, 1.8, 0.9, 1.1]),
            np.array([0.8, -0.8, -2.5, -1.5, 1.5, 1.2, 1.0]),
        ]
        lb = np.array([-6.0, -6.0, -6.0, -6.0, 0.5, 0.1, 0.55])
        ub = np.array([ 6.0,  6.0,  6.0,  6.0, 3.5, 2.5, 2.5])
        run_branch("S1", "S1_2Lens_FS_RC", meta, seeds, lb, ub, max_nfev=120)

    elif args.branch == "S2":
        meta = {"materials": ["Fused Silica", "Fused Silica", "Fused Silica"], "thicknesses": [22.0, 14.0, 20.0], "unlock_conics": False}
        seeds = [
            np.array([ 1.8, -0.4, -2.5,  1.8,  1.2, -0.5, 1.2, 0.9, 1.0, 0.85]),
            np.array([ 2.2,  0.8, -2.0,  2.2,  1.5,  0.4, 1.0, 1.1, 0.8, 0.95]),
        ]
        run_branch("S2", "S2_3Lens_Wynne_FS_RC", meta, seeds, lb_s2, ub_s2, max_nfev=130)

    elif args.branch == "S3":
        s2_path = os.path.join(RUNS_DIR, "branch_S2.json")
        with open(s2_path, "r", encoding="utf-8") as fh:
            s2_u = json.load(fh)["best_u"]
        meta = {"materials": ["Fused Silica", "Fused Silica", "Fused Silica"], "thicknesses": [22.0, 14.0, 20.0], "unlock_conics": True}
        seeds = [
            np.array(s2_u + [K1_RC, K2_RC]),
            np.array(s2_u + [-1.08, -5.5]),
        ]
        lb = np.array(list(lb_s2) + [-1.6, -9.0])
        ub = np.array(list(ub_s2) + [-0.8, -3.5])
        run_branch("S3", "S3_3Lens_Wynne_FS_QuasiRC", meta, seeds, lb, ub, max_nfev=110)

    elif args.branch == "S4":
        s2_path = os.path.join(RUNS_DIR, "branch_S2.json")
        with open(s2_path, "r", encoding="utf-8") as fh:
            s2_u = json.load(fh)["best_u"]
        meta = {"materials": ["Fused Silica", "F2", "Fused Silica"], "thicknesses": [22.0, 14.0, 20.0], "unlock_conics": False}
        seeds = [np.array(s2_u)]
        run_branch("S4", "S4_3Lens_Wynne_FS_F2_RC", meta, seeds, lb_s2, ub_s2, max_nfev=85)

    elif args.branch == "merge":
        merged = {}
        for k in ["S1", "S2", "S3", "S4"]:
            p = os.path.join(RUNS_DIR, f"branch_{k}.json")
            if os.path.exists(p):
                with open(p, "r", encoding="utf-8") as fh:
                    merged[k] = json.load(fh)
        out_path = os.path.join(RUNS_DIR, "S1_to_S4_correctors_v2.json")
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(merged, fh, indent=2, ensure_ascii=False)
        print(f"Merged {list(merged.keys())} -> {out_path}", flush=True)


if __name__ == "__main__":
    main()
