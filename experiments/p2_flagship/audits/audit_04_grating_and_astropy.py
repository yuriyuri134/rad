import json
import time
import numpy as np
import optiland.backend as be
from optiland import optic
from astropy.io import fits
from astropy.wcs import WCS
from photutils.detection import DAOStarFinder
import sep

out = {"grating_spectrograph": {}, "astropy_fits_photometry": {}}

# 1. Reflective Grating Spectrograph (collimated beam -> reflective grating at incidence alpha -> camera mirror -> detector)
print("=== 1. GRATING SPECTROGRAPH PHYSICS CHECK ===", flush=True)
t0 = time.perf_counter()
alpha_deg = 15.0
period_um = 1.0 / 0.6  # 600 lines/mm -> 1.66667 um
order = 1
cam_f_mm = 200.0  # radius 400 -> focal length 200

spec = optic.Optic(name="GratingCameraCheck")
spec.surfaces.add(index=0, thickness=be.inf)
spec.surfaces.add(index=1, thickness=50.0, is_stop=True)
spec.surfaces.add(
    index=2,
    radius=be.inf,
    thickness=-120.0,
    material="mirror",
    surface_type="grating",
    grating_order=order,
    grating_period=period_um,
    groove_orientation_angle=0.0,
    rx=np.deg2rad(alpha_deg),
)
# Folded off to camera mirror centered on reference wavelength 0.55 um diffraction direction
# Theoretical grating equation: sin(beta) + sin(alpha) = m * lambda / d (sign convention check!)
lam_list = [0.45, 0.55, 0.65]
spec.surfaces.add(index=3, radius=400.0, thickness=200.0, material="mirror")
spec.surfaces.add(index=4)
spec.set_aperture("EPD", 20.0)
spec.fields.set_type("angle")
spec.fields.add(y=0.0)
for wl in lam_list:
    spec.wavelengths.add(wl, is_primary=(wl == 0.55))

ys = {}
chief_angles_deg = {}
for wl in lam_list:
    spec.trace(Hx=0.0, Hy=0.0, wavelength=wl, num_rays=5)
    ys[str(wl)] = round(float(np.mean(spec.surfaces[-1].y)), 5)
    # Chief ray direction cosines after grating (surface 2)
    s2 = spec.surfaces[2]
    # Note: inspect M, N cosines on surface 2
    chief_angles_deg[str(wl)] = round(float(np.rad2deg(np.arcsin(np.clip(np.mean(s2.M), -1, 1)))), 4)

out["grating_spectrograph"] = {
    "ok": True,
    "elapsed_s": round(time.perf_counter() - t0, 4),
    "period_um": period_um,
    "order": order,
    "image_y_mm_by_wl_um": ys,
    "post_grating_M_angle_deg": chief_angles_deg,
}
print("Grating result:", json.dumps(out["grating_spectrograph"], indent=2), flush=True)

# 2. Astropy WCS + FITS + Starfield injection + DAOStarFinder + SEP recovery accuracy
print("\n=== 2. ASTROPY FITS + WCS + DAOStarFinder + SEP ===", flush=True)
t1 = time.perf_counter()
nx, ny = 512, 512
wcs = WCS(naxis=2)
wcs.wcs.crpix = [nx / 2 + 0.5, ny / 2 + 0.5]
wcs.wcs.cdelt = [-0.35 / 3600.0, 0.35 / 3600.0]
wcs.wcs.crval = [150.0, 2.2]
wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
hdr = wcs.to_header()

rng = np.random.default_rng(2026)
sky_adu = 120.0
read_noise = 6.0
img = rng.normal(sky_adu, read_noise, (ny, nx)).astype(np.float64)

yy, xx = np.mgrid[:ny, :nx]
true_stars = [
    {"id": 1, "x": 120.37, "y": 145.82, "flux": 45000.0, "sigma": 1.4},
    {"id": 2, "x": 256.14, "y": 255.69, "flux": 80000.0, "sigma": 1.35},
    {"id": 3, "x": 388.91, "y": 401.24, "flux": 22000.0, "sigma": 1.65},
    {"id": 4, "x": 410.55, "y": 95.13, "flux": 12000.0, "sigma": 1.75},
]
for st in true_stars:
    amp = st["flux"] / (2.0 * np.pi * st["sigma"] ** 2)
    star_profile = amp * np.exp(-((xx - st["x"]) ** 2 + (yy - st["y"]) ** 2) / (2.0 * st["sigma"] ** 2))
    img += star_profile
# Add Poisson noise on signal
img = rng.poisson(np.clip(img, 0, None)).astype(np.float32) + rng.normal(0.0, read_noise, (ny, nx)).astype(np.float32)

fits_path = "experiments/p2_flagship/audits/audit04_test_starfield.fits"
fits.PrimaryHDU(data=img, header=hdr).writeto(fits_path, overwrite=True)

# Read back and run both DAOStarFinder and SEP
with fits.open(fits_path) as hdul:
    data = hdul[0].data.astype(np.float64)
    w_read = WCS(hdul[0].header)

bkg = sep.Background(data)
data_sub = data - bkg.back()
rms = float(bkg.globalrms)

finder = DAOStarFinder(fwhm=3.5, threshold=5.0 * rms)
dao_tbl = finder(data_sub)
sep_objs = sep.extract(np.ascontiguousarray(data_sub), thresh=5.0 * rms)

# Match true stars to nearest detected star
dao_errors = []
sep_errors = []
for st in true_stars:
    d_dao = np.hypot(dao_tbl["xcentroid"] - st["x"], dao_tbl["ycentroid"] - st["y"])
    i_dao = int(np.argmin(d_dao))
    dao_errors.append(round(float(d_dao[i_dao]), 4))

    d_sep = np.hypot(sep_objs["x"] - st["x"], sep_objs["y"] - st["y"])
    i_sep = int(np.argmin(d_sep))
    sep_errors.append(round(float(d_sep[i_sep]), 4))

ra_true, dec_true = w_read.all_pix2world([s["x"] for s in true_stars], [s["y"] for s in true_stars], 0)

out["astropy_fits_photometry"] = {
    "ok": True,
    "elapsed_s": round(time.perf_counter() - t1, 4),
    "fits_path": fits_path,
    "dao_detected_count": len(dao_tbl),
    "sep_detected_count": len(sep_objs),
    "dao_centroid_errors_px": dao_errors,
    "sep_centroid_errors_px": sep_errors,
    "wcs_ra_sample": [round(float(r), 6) for r in ra_true],
}
print("Astropy+Photutils+SEP result:", json.dumps(out["astropy_fits_photometry"], indent=2), flush=True)

out_path = "experiments/p2_flagship/audits/audit04_grating_and_astropy.json"
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(out, fh, indent=2, ensure_ascii=False)
print(f"\nSaved {out_path}", flush=True)
