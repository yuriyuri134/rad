import json
import math
import time
import numpy as np
import optiland.backend as be
from optiland import optic, physical_apertures
from optiland.analysis import Distortion, SpotDiagram
from optiland.mtf import FFTMTF
from optiland.psf import FFTPSF, HuygensPSF

t0 = time.perf_counter()

# --- 1. First-Principles Mission & Gaussian RC Derivation ---
D_mm = 1000.0
EFL_target = 6000.0  # f/6.0 survey astrograph
F1 = 2.2
f1 = F1 * D_mm       # 2200.0 mm
R1 = -2.0 * f1       # -4400.0 mm
m = EFL_target / f1  # 2.7272727...
b_mm = 450.0         # Back focal clearance behind M1 vertex for corrector + filter + dewar

# Gaussian two-mirror layout
d_mm = (EFL_target - b_mm) / (m + 1.0)
s_mm = f1 - d_mm
sp_mm = d_mm + b_mm
R2 = -(2.0 * m * s_mm) / (m - 1.0)

# Exact Ritchey-Chretien conic constants (Wilson, Reflecting Telescope Optics I, Eq. 3.63)
k_obs = s_mm / f1
beta = b_mm / f1
K1 = -1.0 - (2.0 * (1.0 + beta)) / (m ** 2 * (m - beta))
K2 = -((m + 1.0) / (m - 1.0)) ** 2 - (2.0 * m * (m + 1.0)) / ((m - 1.0) ** 3 * (m - beta))

# Clear aperture / central obscuration budget for unvignetted +/- 0.60 deg FOV
fov_half_deg = 0.60
fov_rad = math.radians(fov_half_deg)
r_m2_marginal = 0.5 * D_mm * k_obs
r_m2_field_walk = d_mm * math.tan(fov_rad)
r_m2_clear = r_m2_marginal + r_m2_field_walk + 5.0
r_image_max = EFL_target * math.tan(fov_rad)
r_m1_hole = r_image_max + 15.0
r_obscuration = max(r_m2_clear, r_m1_hole)

plate_scale_arcsec_per_mm = 206264.806 / EFL_target  # 34.3775 "/mm
pixel_pitch_um = 15.0  # 15 um scientific CCD -> 0.5157 "/px

fields_deg = [0.0, 0.25, 0.42, 0.60]
wavelengths_um = [0.45, 0.55, 0.656, 0.80]


def make_bare_rc(k1=K1, k2=K2, apply_obsc=True):
    sys = optic.Optic(name="WF_RC_1000_Bare_S0")
    sys.surfaces.add(index=0, thickness=be.inf)
    sys.surfaces.add(index=1, thickness=1600.0)
    obsc = physical_apertures.RadialAperture(r_max=500.0, r_min=r_obscuration) if apply_obsc else None
    sys.surfaces.add(
        index=2,
        radius=R1,
        thickness=-d_mm,
        material="mirror",
        is_stop=True,
        conic=k1,
        aperture=obsc,
    )
    sys.surfaces.add(
        index=3,
        radius=R2,
        thickness=sp_mm,
        material="mirror",
        conic=k2,
    )
    sys.surfaces.add(index=4)
    sys.set_aperture("EPD", D_mm)
    sys.fields.set_type("angle")
    for fy in fields_deg:
        sys.fields.add(y=fy)
    for wl in wavelengths_um:
        sys.wavelengths.add(wl, is_primary=(wl == 0.55))
    return sys


s0_unobsc = make_bare_rc(apply_obsc=False)
seidels = [float(np.ravel(v)[0]) for v in s0_unobsc.aberrations.seidels()]

s0 = make_bare_rc(apply_obsc=True)
efl = float(np.ravel(s0.paraxial.f2())[0])
fno = float(np.ravel(s0.paraxial.FNO())[0])

# Multi-field, multi-wavelength SpotDiagram
sd = SpotDiagram(s0, num_rings=6)
rms_mat = np.asarray(sd.rms_spot_radius(), dtype=float)  # shape (n_fields, n_wls) in mm
# Note: verify rms_mat shape!
print("SpotDiagram rms_spot_radius shape:", rms_mat.shape, flush=True)

# Also compute polychromatic combined RMS spot per field via direct trace
poly_rms_um = {}
for idx, fy in enumerate(fields_deg):
    hy = fy / max(fields_deg)
    xs, ys = [], []
    for wl in wavelengths_um:
        s0.trace(Hx=0.0, Hy=hy, wavelength=wl, num_rays=16)
        x = np.asarray(s0.surfaces[-1].x, dtype=float)
        y = np.asarray(s0.surfaces[-1].y, dtype=float)
        inten = np.asarray(s0.surfaces[-1].intensity, dtype=float)
        mask = inten > 0
        xs.append(x[mask])
        ys.append(y[mask])
    all_x = np.concatenate(xs)
    all_y = np.concatenate(ys)
    dx = all_x - np.mean(all_x)
    dy = all_y - np.mean(all_y)
    rms_um = float(np.sqrt(np.mean(dx ** 2 + dy ** 2)) * 1000.0)
    poly_rms_um[str(fy)] = round(rms_um, 3)

# Cross-verify FFTPSF vs HuygensPSF on-axis and at 0.42 deg (550 nm)
psf_compare = {}
for fy in [0.0, 0.42, 0.60]:
    hy = fy / max(fields_deg)
    f_psf = FFTPSF(s0, field=(0.0, hy), wavelength=0.55, num_rays=64, grid_size=128)
    h_psf = HuygensPSF(s0, field=(0.0, hy), wavelength=0.55, num_rays=32, image_size=32)
    psf_compare[str(fy)] = {
        "fft_strehl": round(float(f_psf.strehl_ratio()), 5),
        "huygens_strehl": round(float(h_psf.strehl_ratio()), 5),
    }

dist = Distortion(s0, wavelengths=[0.55])
dist_pct = [round(float(v), 5) for v in np.ravel(dist.data[0])]

# FFTMTF at 0.55 um (check 33.33 lp/mm = Nyquist for 15 um pixels!)
mtf_calc = FFTMTF(s0, wavelength=0.55, num_rays=64, grid_size=256, max_freq=60)
mtf_at_nyq = {}
for idx, fy in enumerate(fields_deg):
    tan, sag = mtf_calc.mtf[idx]
    tan_arr = np.asarray(tan, dtype=float)
    sag_arr = np.asarray(sag, dtype=float)
    f_axis = np.asarray(mtf_calc.freq[idx], dtype=float)
    mtf_at_nyq[str(fy)] = {
        "freq_lp_mm": 33.33,
        "tangential": round(float(np.interp(33.333, f_axis, tan_arr)), 4),
        "sagittal": round(float(np.interp(33.333, f_axis, sag_arr)), 4),
    }

out = {
    "system_id": "S0_bare_rc",
    "description": "Analytical 1.0m f/6.0 Ritchey-Chretien baseline (no refractive corrector)",
    "prescription": {
        "D_mm": D_mm,
        "EFL_target_mm": EFL_target,
        "F1": F1,
        "f1_mm": f1,
        "R1_mm": R1,
        "K1": round(K1, 8),
        "d_M1_M2_mm": round(d_mm, 6),
        "R2_mm": round(R2, 6),
        "K2": round(K2, 8),
        "sp_M2_to_focus_mm": round(sp_mm, 6),
        "back_clearance_behind_M1_mm": b_mm,
        "central_obscuration_r_min_mm": round(r_obscuration, 3),
        "linear_obscuration_ratio": round(r_obscuration / 500.0, 4),
        "area_obscuration_ratio": round((r_obscuration / 500.0) ** 2, 4),
    },
    "paraxial": {
        "efl_mm": round(efl, 4),
        "fno": round(fno, 4),
        "plate_scale_arcsec_per_mm": round(plate_scale_arcsec_per_mm, 4),
        "pixel_pitch_um": pixel_pitch_um,
        "pixel_scale_arcsec_per_px": round(plate_scale_arcsec_per_mm * pixel_pitch_um / 1000.0, 4),
    },
    "seidel_coefficients_waves_approx": {
        "SI_spherical": round(seidels[0], 8),
        "SII_coma": round(seidels[1], 8),
        "SIII_astigmatism": round(seidels[2], 6),
        "SIV_petzval": round(seidels[3], 6),
        "SV_distortion": round(seidels[4], 6),
    },
    "polychromatic_rms_spot_um_by_field_deg": poly_rms_um,
    "polychromatic_rms_spot_arcsec_by_field_deg": {
        k: round((v / 1000.0) * plate_scale_arcsec_per_mm, 4) for k, v in poly_rms_um.items()
    },
    "psf_strehl_550nm_cross_check": psf_compare,
    "mtf_at_33lp_mm_550nm": mtf_at_nyq,
    "distortion_pct_max_abs": round(float(np.max(np.abs(dist_pct))), 5),
    "elapsed_s": round(time.perf_counter() - t0, 3),
}

out_path = "experiments/p2_flagship/runs/S0_bare_rc.json"
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(out, fh, indent=2, ensure_ascii=False)

print("\n=== S0 BARE RC SUMMARY ===", flush=True)
print(json.dumps(out, indent=2, ensure_ascii=False), flush=True)
