import json
import math
import time
import numpy as np
from scipy.optimize import least_squares
import optiland.backend as be
from optiland import optic, physical_apertures
from optiland.analysis import Distortion
from optiland.psf import FFTPSF

# Base RC geometry from Stage 1 (verified SI=0, SII=0)
D_MM = 1000.0
EFL_TARGET = 6000.0
R1_BASE = -4400.0
D_M1_M2_BASE = 1489.02439024
R2_BASE = -2245.18613577
K1_RC = -1.12838839
K2_RC = -6.22036543
R_OBSC = 182.179

FIELDS_DEG = [0.0, 0.25, 0.42, 0.60]
WLS_UM = [0.45, 0.55, 0.656, 0.80]
PLATE_SCALE = 206264.806 / EFL_TARGET  # 34.3775 arcsec/mm


def sag(c: float, r: float) -> float:
    arg = 1.0 - (c * r) ** 2
    if arg <= 0.0:
        return 1e6
    return (c * r * r) / (1.0 + math.sqrt(arg))


def lens_edge_thickness(c1: float, c2: float, tc: float, semi_ap: float) -> float:
    return tc + sag(c2, semi_ap) - sag(c1, semi_ap)


def build_2lens_system(vec, apply_obsc=True):
    # vec = [c1, c2, c3, c4, d_m1_to_l1, gap12, bfl]
    c1, c2, c3, c4, d_m1_l1, gap12, bfl = [float(x) for x in vec]
    t_l1, t_l2 = 20.0, 16.0
    r_vals = [1.0 / c if abs(c) > 1e-8 else be.inf for c in (c1, c2, c3, c4)]

    sys = optic.Optic(name="WF_RC_1000_S1_2Lens")
    sys.surfaces.add(index=0, thickness=be.inf)
    sys.surfaces.add(index=1, thickness=1600.0)
    obsc = physical_apertures.RadialAperture(r_max=500.0, r_min=R_OBSC) if apply_obsc else None
    sys.surfaces.add(index=2, radius=R1_BASE, thickness=-D_M1_M2_BASE, material="mirror", is_stop=True, conic=K1_RC, aperture=obsc)
    sys.surfaces.add(index=3, radius=R2_BASE, thickness=D_M1_M2_BASE + d_m1_l1, material="mirror", conic=K2_RC)
    sys.surfaces.add(index=4, radius=r_vals[0], thickness=t_l1, material=("Fused Silica", "Malitson"))
    sys.surfaces.add(index=5, radius=r_vals[1], thickness=gap12, material="Air")
    sys.surfaces.add(index=6, radius=r_vals[2], thickness=t_l2, material=("Fused Silica", "Malitson"))
    sys.surfaces.add(index=7, radius=r_vals[3], thickness=bfl, material="Air")
    sys.surfaces.add(index=8)
    sys.set_aperture("EPD", D_MM)
    sys.fields.set_type("angle")
    for fy in FIELDS_DEG:
        sys.fields.add(y=fy)
    for wl in WLS_UM:
        sys.wavelengths.add(wl, is_primary=(wl == 0.55))
    return sys


def build_3lens_system(vec, unlock_conics=False, apply_obsc=True):
    # vec = [c1..c6, d_m1_l1, gap12, gap23, bfl, (k1, k2)]
    c1, c2, c3, c4, c5, c6, d_m1_l1, gap12, gap23, bfl = [float(x) for x in vec[:10]]
    k1 = float(vec[10]) if unlock_conics else K1_RC
    k2 = float(vec[11]) if unlock_conics else K2_RC
    t_l1, t_l2, t_l3 = 22.0, 14.0, 20.0
    r_vals = [1.0 / c if abs(c) > 1e-8 else be.inf for c in (c1, c2, c3, c4, c5, c6)]

    sys = optic.Optic(name="WF_RC_1000_Wynne_3Lens")
    sys.surfaces.add(index=0, thickness=be.inf)
    sys.surfaces.add(index=1, thickness=1600.0)
    obsc = physical_apertures.RadialAperture(r_max=500.0, r_min=R_OBSC) if apply_obsc else None
    sys.surfaces.add(index=2, radius=R1_BASE, thickness=-D_M1_M2_BASE, material="mirror", is_stop=True, conic=k1, aperture=obsc)
    sys.surfaces.add(index=3, radius=R2_BASE, thickness=D_M1_M2_BASE + d_m1_l1, material="mirror", conic=k2)
    sys.surfaces.add(index=4, radius=r_vals[0], thickness=t_l1, material=("Fused Silica", "Malitson"))
    sys.surfaces.add(index=5, radius=r_vals[1], thickness=gap12, material="Air")
    sys.surfaces.add(index=6, radius=r_vals[2], thickness=t_l2, material=("Fused Silica", "Malitson"))
    sys.surfaces.add(index=7, radius=r_vals[3], thickness=gap23, material="Air")
    sys.surfaces.add(index=8, radius=r_vals[4], thickness=t_l3, material=("Fused Silica", "Malitson"))
    sys.surfaces.add(index=9, radius=r_vals[5], thickness=bfl, material="Air")
    sys.surfaces.add(index=10)
    sys.set_aperture("EPD", D_MM)
    sys.fields.set_type("angle")
    for fy in FIELDS_DEG:
        sys.fields.add(y=fy)
    for wl in WLS_UM:
        sys.wavelengths.add(wl, is_primary=(wl == 0.55))
    return sys


def evaluate_system(sys, num_rays=8, compute_psf=False):
    efl = float(np.ravel(sys.paraxial.f2())[0])
    fno = float(np.ravel(sys.paraxial.FNO())[0])

    # Polychromatic spot residuals relative to field-centroid across all wavelengths
    rms_um_by_field = {}
    max_semi_ap_per_lens = {}
    clipped = 0
    total_rays = 0
    chief_y_by_field_wl = {}

    for fy in FIELDS_DEG:
        hy = fy / max(FIELDS_DEG)
        xs, ys = [], []
        chief_y_by_field_wl[str(fy)] = {}
        for wl in WLS_UM:
            sys.trace(Hx=0.0, Hy=hy, wavelength=wl, num_rays=num_rays)
            x = np.asarray(sys.surfaces[-1].x, dtype=float)
            y = np.asarray(sys.surfaces[-1].y, dtype=float)
            inten = np.asarray(sys.surfaces[-1].intensity, dtype=float)
            mask = inten > 0
            total_rays += len(x)
            clipped += int(np.sum(~mask))
            if np.sum(mask) < 5:
                return {"valid": False, "efl": efl}
            xs.append(x[mask])
            ys.append(y[mask])
            chief_y_by_field_wl[str(fy)][str(wl)] = float(np.mean(y[mask]))
            # Track clear aperture needed at refractive surfaces (index 4..-2)
            for s_idx in range(4, len(sys.surfaces) - 1):
                sx = np.asarray(sys.surfaces[s_idx].x, dtype=float)[mask]
                sy = np.asarray(sys.surfaces[s_idx].y, dtype=float)[mask]
                r_max = float(np.max(np.hypot(sx, sy)))
                max_semi_ap_per_lens[s_idx] = max(max_semi_ap_per_lens.get(s_idx, 0.0), r_max)

        all_x = np.concatenate(xs)
        all_y = np.concatenate(ys)
        cx, cy = float(np.mean(all_x)), float(np.mean(all_y))
        rms_um = float(np.sqrt(np.mean((all_x - cx) ** 2 + (all_y - cy) ** 2)) * 1000.0)
        rms_um_by_field[str(fy)] = rms_um

    res = {
        "valid": True,
        "efl_mm": round(efl, 3),
        "fno": round(fno, 4),
        "rms_um_by_field": {k: round(v, 3) for k, v in rms_um_by_field.items()},
        "max_rms_um": round(max(rms_um_by_field.values()), 3),
        "mean_rms_um": round(float(np.mean(list(rms_um_by_field.values()))), 3),
        "clipped_rays": clipped,
        "total_rays": total_rays,
        "lens_clear_semi_apertures_mm": {str(k): round(v, 2) for k, v in max_semi_ap_per_lens.items()},
    }

    if compute_psf:
        strehls = {}
        for fy in [0.0, 0.42, 0.60]:
            hy = fy / max(FIELDS_DEG)
            fp = FFTPSF(sys, field=(0.0, hy), wavelength=0.55, num_rays=64, grid_size=128)
            strehls[str(fy)] = round(float(fp.strehl_ratio()), 5)
        res["fft_strehl_550nm"] = strehls
        dist = Distortion(sys, wavelengths=[0.55])
        res["distortion_pct_max_abs"] = round(float(np.max(np.abs(dist.data[0]))), 5)

    return res


def make_residual_fn(builder, n_lenses, unlock_conics=False):
    eval_counter = {"n": 0}

    def residuals(vec):
        eval_counter["n"] += 1
        try:
            sys = builder(vec, unlock_conics=unlock_conics) if n_lenses == 3 else builder(vec)
        except Exception:
            return np.full(40, 1e3)

        try:
            efl = float(np.ravel(sys.paraxial.f2())[0])
        except Exception:
            return np.full(40, 1e3)

        if not np.isfinite(efl) or abs(efl) > 25000:
            return np.full(40, 1e3)

        # Spot residuals at 4 fields x 4 wavelengths (num_rays=5 for fast inner iterations)
        res_list = []
        max_r_surf = {}
        for fy in FIELDS_DEG:
            hy = fy / max(FIELDS_DEG)
            w_field = 1.0 if fy == 0.0 else (1.2 if fy < 0.5 else 1.5)
            xs, ys = [], []
            for wl in WLS_UM:
                try:
                    sys.trace(Hx=0.0, Hy=hy, wavelength=wl, num_rays=5)
                    x = np.asarray(sys.surfaces[-1].x, dtype=float)
                    y = np.asarray(sys.surfaces[-1].y, dtype=float)
                    inten = np.asarray(sys.surfaces[-1].intensity, dtype=float)
                    mask = inten > 0
                    if np.sum(mask) < 10:
                        return np.full(40, 500.0)
                    xs.append(x[mask])
                    ys.append(y[mask])
                    for s_idx in range(4, len(sys.surfaces) - 1):
                        sx = np.asarray(sys.surfaces[s_idx].x, dtype=float)[mask]
                        sy = np.asarray(sys.surfaces[s_idx].y, dtype=float)[mask]
                        r_m = float(np.max(np.hypot(sx, sy)))
                        max_r_surf[s_idx] = max(max_r_surf.get(s_idx, 0.0), r_m)
                except Exception:
                    return np.full(40, 500.0)
            all_x = np.concatenate(xs)
            all_y = np.concatenate(ys)
            cx, cy = float(np.mean(all_x)), float(np.mean(all_y))
            rms_um = math.sqrt(float(np.mean((all_x - cx) ** 2 + (all_y - cy) ** 2))) * 1000.0
            res_list.append(w_field * rms_um)

        # EFL constraint (~6000 mm)
        res_list.append((efl - EFL_TARGET) / 25.0)

        # Edge thickness & sag physical manufacturability check for each lens
        curvatures = vec[: 2 * n_lenses]
        thick_lenses = [20.0, 16.0] if n_lenses == 2 else [22.0, 14.0, 20.0]
        for l_idx in range(n_lenses):
            c_front = float(curvatures[2 * l_idx])
            c_back = float(curvatures[2 * l_idx + 1])
            s_front_idx = 4 + 2 * l_idx
            semi_ap = max(max_r_surf.get(s_front_idx, 70.0), max_r_surf.get(s_front_idx + 1, 70.0)) + 5.0
            # Check valid sag and edge thickness >= 7 mm
            if abs(c_front * semi_ap) >= 0.92 or abs(c_back * semi_ap) >= 0.92:
                res_list.append(200.0)
            else:
                et = lens_edge_thickness(c_front, c_back, thick_lenses[l_idx], semi_ap)
                res_list.append(max(0.0, 7.0 - et) * 15.0)

        # Pad to fixed length 16
        while len(res_list) < 16:
            res_list.append(0.0)
        return np.asarray(res_list[:16], dtype=float)

    return residuals, eval_counter


def optimize_branch(name, builder, x0, lb, ub, n_lenses, unlock_conics=False, max_nfev=90):
    print(f"\n=== OPTIMIZING BRANCH: {name} ===", flush=True)
    t0 = time.perf_counter()
    res_fn, counter = make_residual_fn(builder, n_lenses, unlock_conics=unlock_conics)
    sol = least_squares(
        res_fn,
        x0,
        bounds=(lb, ub),
        method="trf",
        max_nfev=max_nfev,
        ftol=1e-4,
        xtol=1e-4,
        diff_step=1e-4,
    )
    dt = round(time.perf_counter() - t0, 2)
    best_sys = builder(sol.x, unlock_conics=unlock_conics) if n_lenses == 3 else builder(sol.x)
    metrics = evaluate_system(best_sys, num_rays=14, compute_psf=True)

    # Check exact lens radii, edge thicknesses & back-focus clearance
    radii_mm = [round(1.0 / c, 3) if abs(c) > 1e-8 else None for c in sol.x[: 2 * n_lenses]]
    thick_lenses = [20.0, 16.0] if n_lenses == 2 else [22.0, 14.0, 20.0]
    edge_th = []
    for l_idx in range(n_lenses):
        s_front_idx = 4 + 2 * l_idx
        semi = max(
            metrics["lens_clear_semi_apertures_mm"].get(str(s_front_idx), 70.0),
            metrics["lens_clear_semi_apertures_mm"].get(str(s_front_idx + 1), 70.0),
        ) + 5.0
        et = lens_edge_thickness(float(sol.x[2 * l_idx]), float(sol.x[2 * l_idx + 1]), thick_lenses[l_idx], semi)
        edge_th.append({"lens": l_idx + 1, "clear_semi_ap_mm": round(semi, 2), "edge_thickness_mm": round(et, 2)})

    out = {
        "branch_id": name,
        "elapsed_s": dt,
        "nfev": counter["n"],
        "success": bool(sol.success),
        "vector": [round(float(v), 7) for v in sol.x],
        "radii_mm": radii_mm,
        "edge_thickness_check": edge_th,
        "metrics": metrics,
    }
    print(f"  Done in {dt}s (nfev={counter['n']}), EFL={metrics.get('efl_mm')}mm, RMS={metrics.get('rms_um_by_field')}, Strehl={metrics.get('fft_strehl_550nm')}", flush=True)
    return out


# Branch S1: 2-Element Fused Silica Field Corrector (fixed RC K1, K2)
# Initial guess: weak meniscus/positive-negative doublet near focus
x0_s1 = np.array([0.0020, 0.0012, -0.0025, 0.0005, 180.0, 90.0, 110.0])
lb_s1 = np.array([-0.006, -0.006, -0.008, -0.006, 60.0, 10.0, 55.0])
ub_s1 = np.array([ 0.006,  0.006,  0.006,  0.006, 320.0, 220.0, 220.0])
res_s1 = optimize_branch("S1_2Lens_FS_RC", build_2lens_system, x0_s1, lb_s1, ub_s1, n_lenses=2, max_nfev=90)

# Branch S2: 3-Element All-Spherical Fused Silica Wynne Corrector (fixed RC K1, K2)
# [c1..c6, d_m1_l1, gap12, gap23, bfl]
x0_s2 = np.array([0.0018, 0.0004, -0.0020, -0.0030, -0.0018, 0.0005, 120.0, 80.0, 90.0, 85.0])
lb_s2 = np.array([-0.006, -0.006, -0.008, -0.008, -0.008, -0.006,  40.0, 10.0, 10.0, 55.0])
ub_s2 = np.array([ 0.006,  0.006,  0.006,  0.006,  0.006,  0.006, 260.0, 200.0, 200.0, 180.0])
res_s2 = optimize_branch("S2_3Lens_Wynne_FS_RC", build_3lens_system, x0_s2, lb_s2, ub_s2, n_lenses=3, unlock_conics=False, max_nfev=110)

# Branch S3: Quasi-RC (unlock K1, K2) + 3-Element Fused Silica Wynne Corrector seeded from S2
x0_s3 = np.array(list(res_s2["vector"]) + [K1_RC, K2_RC])
lb_s3 = np.array(list(lb_s2) + [-1.5, -9.0])
ub_s3 = np.array(list(ub_s2) + [-0.8, -3.5])
res_s3 = optimize_branch("S3_3Lens_Wynne_FS_QuasiRC", build_3lens_system, x0_s3, lb_s3, ub_s3, n_lenses=3, unlock_conics=True, max_nfev=100)

summary = {"S1": res_s1, "S2": res_s2, "S3": res_s3}
out_path = "experiments/p2_flagship/runs/S1_S2_S3_correctors.json"
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(summary, fh, indent=2, ensure_ascii=False)
print(f"\nSaved {out_path}", flush=True)
