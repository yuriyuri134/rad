import math
import warnings
import numpy as np
import optiland.backend as be
from optiland import optic, physical_apertures
from optiland.analysis import Distortion
from optiland.materials import Material
from optiland.mtf import FFTMTF
from optiland.psf import FFTPSF, HuygensPSF

warnings.filterwarnings("ignore")

# Mission & First-Principles RC Baseline (WF-RC-1000)
D_MM = 1000.0
EFL_TARGET = 6000.0
F1 = 2.2
F1_MM = F1 * D_MM
R1_BASE = -4400.0
B_MM_BASE = 450.0
D_M1_M2_BASE = (EFL_TARGET - B_MM_BASE) / ((EFL_TARGET / F1_MM) + 1.0)  # 1489.02439024
R2_BASE = -2245.18613577
K1_RC = -1.12838839
K2_RC = -6.22036543
R_OBSC = 182.179

FIELDS_DEG = [0.0, 0.25, 0.42, 0.60]
WLS_UM = [0.45, 0.55, 0.656, 0.80]
PLATE_SCALE = 206264.806 / EFL_TARGET  # 34.3775 arcsec/mm
PIXEL_PITCH_UM = 15.0
PIXEL_SCALE_ARCSEC = PLATE_SCALE * PIXEL_PITCH_UM / 1000.0  # 0.51566 arcsec/px
NYQUIST_LP_MM = 1000.0 / (2.0 * PIXEL_PITCH_UM)  # 33.3333 lp/mm

_MAT_CACHE = {}


def get_material(name: str):
    if name == "Air":
        return "Air"
    if name not in _MAT_CACHE:
        _MAT_CACHE[name] = Material(name)
    return _MAT_CACHE[name]


def sag(c: float, r: float) -> float:
    arg = 1.0 - (c * r) ** 2
    if arg <= 0.0:
        return 1e6
    return (c * r * r) / (1.0 + math.sqrt(arg))


def lens_edge_thickness(c1: float, c2: float, tc: float, semi_ap: float) -> float:
    return tc + sag(c2, semi_ap) - sag(c1, semi_ap)


def build_rc_corrector(
    lenses,
    d_m1_l1: float,
    bfl: float,
    k1: float = K1_RC,
    k2: float = K2_RC,
    r1: float = R1_BASE,
    r2: float = R2_BASE,
    d_m1_m2: float = D_M1_M2_BASE,
    apply_obsc: bool = True,
    name: str = "WF_RC_1000",
    perturb: dict | None = None,
):
    """
    Build coaxial or slightly perturbed RC + refractive corrector Optic parametrically.
    lenses: list of dicts: {c1, c2, tc, material, gap_after}
            note: gap_after on the last lens is ignored in favor of `bfl`.
    perturb: optional dict with keys like:
        delta_r1, delta_r2, delta_d_m1_m2, delta_bfl,
        m2_rx_rad, m2_ry_rad, m2_dx_mm, m2_dy_mm,
        corr_rx_rad, corr_ry_rad, corr_dx_mm, corr_dy_mm,
        lens_tc_deltas, lens_gap_deltas, lens_c_deltas
    """
    p = perturb or {}
    r1_eff = r1 + float(p.get("delta_r1", 0.0))
    r2_eff = r2 + float(p.get("delta_r2", 0.0))
    d_12_eff = d_m1_m2 + float(p.get("delta_d_m1_m2", 0.0))
    bfl_eff = bfl + float(p.get("delta_bfl", 0.0))

    sys = optic.Optic(name=name)
    sys.surfaces.add(index=0, thickness=be.inf)
    sys.surfaces.add(index=1, thickness=1600.0)
    obsc = physical_apertures.RadialAperture(r_max=500.0, r_min=R_OBSC) if apply_obsc else None
    sys.surfaces.add(
        index=2,
        radius=r1_eff,
        thickness=-d_12_eff,
        material="mirror",
        is_stop=True,
        conic=float(k1),
        aperture=obsc,
    )
    sys.surfaces.add(
        index=3,
        radius=r2_eff,
        thickness=d_12_eff + float(d_m1_l1) + float(p.get("delta_d_m1_l1", 0.0)),
        material="mirror",
        conic=float(k2),
        rx=float(p.get("m2_rx_rad", 0.0)),
        ry=float(p.get("m2_ry_rad", 0.0)),
        dx=float(p.get("m2_dx_mm", 0.0)),
        dy=float(p.get("m2_dy_mm", 0.0)),
    )

    tc_deltas = p.get("lens_tc_deltas", [0.0] * len(lenses))
    gap_deltas = p.get("lens_gap_deltas", [0.0] * len(lenses))
    c_deltas = p.get("lens_c_deltas", [(0.0, 0.0)] * len(lenses))

    surf_idx = 4
    for i, lens in enumerate(lenses):
        c1 = float(lens["c1"]) + float(c_deltas[i][0])
        c2 = float(lens["c2"]) + float(c_deltas[i][1])
        r_front = 1.0 / c1 if abs(c1) > 1e-8 else be.inf
        r_back = 1.0 / c2 if abs(c2) > 1e-8 else be.inf
        tc = float(lens["tc"]) + float(tc_deltas[i])
        gap = (bfl_eff if i == len(lenses) - 1 else float(lens["gap_after"]) + float(gap_deltas[i]))
        mat = get_material(lens["material"])

        front_kwargs = dict(index=surf_idx, radius=r_front, thickness=tc, material=mat)
        if i == 0:
            front_kwargs.update(
                rx=float(p.get("corr_rx_rad", 0.0)),
                ry=float(p.get("corr_ry_rad", 0.0)),
                dx=float(p.get("corr_dx_mm", 0.0)),
                dy=float(p.get("corr_dy_mm", 0.0)),
            )
        sys.surfaces.add(**front_kwargs)
        surf_idx += 1

        sys.surfaces.add(index=surf_idx, radius=r_back, thickness=gap, material="Air")
        surf_idx += 1

    sys.surfaces.add(index=surf_idx)
    sys.set_aperture("EPD", D_MM)
    sys.fields.set_type("angle")
    for fy in FIELDS_DEG:
        sys.fields.add(y=fy)
    for wl in WLS_UM:
        sys.wavelengths.add(wl, is_primary=(wl == 0.55))
    return sys


def evaluate_optical_system(sys, num_rays=14, compute_psf=True, compute_mtf=True, has_tilt=False):
    out = {"valid": False}
    if not has_tilt:
        try:
            efl = float(np.ravel(sys.paraxial.f2())[0])
            fno = float(np.ravel(sys.paraxial.FNO())[0])
        except Exception:
            efl, fno = float("nan"), float("nan")
    else:
        efl, fno = float("nan"), float("nan")

    rms_poly = {}
    rms_550 = {}
    chief_y_550 = {}
    max_semi_ap_per_lens = {}
    clipped = 0
    total_rays = 0
    n_lenses_surfs = len(sys.surfaces) - 5  # surfaces 4 .. -2

    for fy in FIELDS_DEG:
        hy = fy / max(FIELDS_DEG)
        xs, ys = [], []
        xs55, ys55 = [], []
        for wl in WLS_UM:
            sys.trace(Hx=0.0, Hy=hy, wavelength=wl, num_rays=num_rays)
            x = np.asarray(sys.surfaces[-1].x, dtype=float)
            y = np.asarray(sys.surfaces[-1].y, dtype=float)
            inten = np.asarray(sys.surfaces[-1].intensity, dtype=float)
            mask = inten > 0
            total_rays += len(x)
            clipped += int(np.sum(~mask))
            if np.sum(mask) < 5:
                return {"valid": False, "efl_mm": efl}
            xs.append(x[mask])
            ys.append(y[mask])
            for s_idx in range(4, len(sys.surfaces) - 1):
                sx = np.asarray(sys.surfaces[s_idx].x, dtype=float)[mask]
                sy = np.asarray(sys.surfaces[s_idx].y, dtype=float)[mask]
                r_max = float(np.max(np.hypot(sx, sy)))
                max_semi_ap_per_lens[s_idx] = max(max_semi_ap_per_lens.get(s_idx, 0.0), r_max)

            if abs(wl - 0.55) < 1e-6:
                xs55.append(x[mask])
                ys55.append(y[mask])
                sys.trace_generic(Hx=0.0, Hy=hy, Px=0.0, Py=0.0, wavelength=0.55)
                chief_y_550[str(fy)] = float(np.ravel(sys.surfaces[-1].y)[0])

        all_x = np.concatenate(xs)
        all_y = np.concatenate(ys)
        cx, cy = float(np.mean(all_x)), float(np.mean(all_y))
        rms_poly[str(fy)] = float(np.sqrt(np.mean((all_x - cx) ** 2 + (all_y - cy) ** 2)) * 1000.0)

        x55 = np.concatenate(xs55)
        y55 = np.concatenate(ys55)
        c55x, c55y = float(np.mean(x55)), float(np.mean(y55))
        rms_550[str(fy)] = float(np.sqrt(np.mean((x55 - c55x) ** 2 + (y55 - c55y) ** 2)) * 1000.0)

    out = {
        "valid": True,
        "efl_mm": round(efl, 3) if np.isfinite(efl) else None,
        "fno": round(fno, 4) if np.isfinite(fno) else None,
        "rms_um_poly_by_field": {k: round(v, 3) for k, v in rms_poly.items()},
        "rms_um_550nm_by_field": {k: round(v, 3) for k, v in rms_550.items()},
        "max_rms_poly_um": round(max(rms_poly.values()), 3),
        "mean_rms_poly_um": round(float(np.mean(list(rms_poly.values()))), 3),
        "rms_arcsec_poly_by_field": {
            k: round((v / 1000.0) * (206264.806 / (efl if np.isfinite(efl) else EFL_TARGET)), 4)
            for k, v in rms_poly.items()
        },
        "chief_y_550nm_mm": {k: round(v, 5) for k, v in chief_y_550.items()},
        "clipped_rays": clipped,
        "total_rays": total_rays,
        "lens_clear_semi_apertures_mm": {str(k): round(v, 2) for k, v in max_semi_ap_per_lens.items()},
    }

    if compute_psf:
        fft_strehls = {}
        huy_strehls = {}
        strat = "best_fit" if has_tilt else "chief_ray"
        for fy in [0.0, 0.25, 0.42, 0.60]:
            hy = fy / max(FIELDS_DEG)
            fp = FFTPSF(sys, field=(0.0, hy), wavelength=0.55, num_rays=64, grid_size=128, strategy=strat)
            fft_strehls[str(fy)] = round(float(fp.strehl_ratio()), 5)
        if not has_tilt:
            for fy in [0.0, 0.42, 0.60]:
                hy = fy / max(FIELDS_DEG)
                hp = HuygensPSF(sys, field=(0.0, hy), wavelength=0.55, num_rays=32, image_size=32)
                huy_strehls[str(fy)] = round(float(hp.strehl_ratio()), 5)
        out["fft_strehl_550nm"] = fft_strehls
        if huy_strehls:
            out["huygens_strehl_550nm"] = huy_strehls

    if compute_mtf and not has_tilt:
        mtf_calc = FFTMTF(sys, wavelength=0.55, num_rays=64, grid_size=256, max_freq=60)
        mtf_nyq = {}
        for idx, fy in enumerate(FIELDS_DEG):
            tan, sag_m = mtf_calc.mtf[idx]
            f_axis = np.asarray(mtf_calc.freq[idx], dtype=float)
            mtf_nyq[str(fy)] = {
                "tangential": round(float(np.interp(NYQUIST_LP_MM, f_axis, np.asarray(tan, dtype=float))), 4),
                "sagittal": round(float(np.interp(NYQUIST_LP_MM, f_axis, np.asarray(sag_m, dtype=float))), 4),
            }
        out["mtf_33lp_mm_550nm"] = mtf_nyq

    if not has_tilt:
        dist = Distortion(sys, wavelengths=[0.55])
        d_arr = np.ravel(np.asarray(dist.data[0], dtype=float))
        hy_grid = np.linspace(1e-10, 1.0, len(d_arr))
        max_f = max(FIELDS_DEG)
        out["distortion_pct_by_field"] = {
            str(fy): round(float(np.interp(fy / max_f, hy_grid, d_arr)), 5) for fy in FIELDS_DEG
        }
        out["distortion_pct_max_abs"] = round(float(np.max(np.abs(d_arr))), 5)
    else:
        dist = Distortion(sys, wavelengths=[0.55], method="nonparaxial")
        d_arr = np.ravel(np.asarray(dist.data[0], dtype=float))
        out["distortion_pct_max_abs"] = round(float(np.max(np.abs(d_arr))), 5)

    return out
