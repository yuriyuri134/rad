import json
import time
import numpy as np
import optiland.backend as be
from optiland import optic, physical_apertures
from optiland.analysis import CentroidReferencePoint
from optiland.analysis.image_simulation import ImageSimulationEngine


def make_star_image(size=128):
    img = np.zeros((size, size, 3), dtype=np.float64)
    coords = [(32, 32), (64, 64), (96, 96), (32, 96), (96, 32)]
    yy, xx = np.mgrid[:size, :size]
    for x0, y0 in coords:
        g = np.exp(-((xx - x0) ** 2 + (yy - y0) ** 2) / (2 * 0.8 ** 2))
        for c in range(3):
            img[:, :, c] += g
    return img


def build_rc_corrector():
    sys = optic.Optic(name="RC_ImgSim")
    sys.surfaces.add(index=0, thickness=be.inf)
    sys.surfaces.add(index=1, thickness=1500.0)
    obsc = physical_apertures.RadialAperture(r_max=500.0, r_min=160.0)
    sys.surfaces.add(index=2, radius=-4000.0, thickness=-1450.0, material="mirror", is_stop=True, conic=-1.06, aperture=obsc)
    sys.surfaces.add(index=3, radius=-1550.0, thickness=1820.0, material="mirror", conic=-3.2)
    sys.surfaces.add(index=4, radius=320.0, thickness=18.0, material="Fused Silica")
    sys.surfaces.add(index=5, radius=190.0, thickness=45.0, material="Air")
    sys.surfaces.add(index=6, radius=-280.0, thickness=15.0, material="Fused Silica")
    sys.surfaces.add(index=7, radius=420.0, thickness=120.0, material="Air")
    sys.surfaces.add(index=8)
    sys.set_aperture("EPD", 1000.0)
    sys.fields.set_type("angle")
    sys.fields.add(y=0.0)
    sys.fields.add(y=0.4)
    sys.fields.add(y=0.75)
    sys.wavelengths.add(0.45)
    sys.wavelengths.add(0.55, is_primary=True)
    sys.wavelengths.add(0.75)
    return sys


def build_offaxis_tma():
    sys = optic.Optic(name="TMA_ImgSim")
    sys.surfaces.add(index=0, thickness=be.inf)
    sys.surfaces.add(index=1, thickness=400.0, is_stop=True)
    sys.surfaces.add(index=2, radius=-1200.0, thickness=-350.0, material="mirror", conic=-1.0, rx=np.deg2rad(8.0))
    sys.surfaces.add(index=3, radius=-400.0, thickness=420.0, material="mirror", conic=-2.5, rx=np.deg2rad(-10.0), dy=80.0)
    sys.surfaces.add(index=4, radius=-550.0, thickness=-500.0, material="mirror", conic=-0.5, rx=np.deg2rad(6.0), dy=-40.0)
    sys.surfaces.add(index=5)
    sys.set_aperture("EPD", 200.0)
    sys.fields.set_type("angle")
    sys.fields.add(y=0.0)
    sys.fields.add(y=0.5)
    sys.wavelengths.add(0.45)
    sys.wavelengths.add(0.55, is_primary=True)
    sys.wavelengths.add(0.65)
    return sys


src_img = make_star_image(128)
out = {}

for label, builder, extra_cfg in [
    ("RC_Corrector_default", build_rc_corrector, {}),
    ("RC_Corrector_centroid_ref", build_rc_corrector, {"distortion_reference": CentroidReferencePoint(), "psf_strategy": "best_fit"}),
    ("OffAxis_TMA_best_fit", build_offaxis_tma, {"distortion_reference": CentroidReferencePoint(), "psf_strategy": "best_fit"}),
]:
    print(f"\n=== IMAGE SIMULATION: {label} ===", flush=True)
    t0 = time.perf_counter()
    try:
        cfg = {
            "wavelength": [0.65, 0.55, 0.45],
            "psf_grid_shape": (3, 3),
            "psf_size": 32,
            "num_rays": 24,
            "n_components": 4,
            "oversample": 1,
            "padding": 16,
            **extra_cfg,
        }
        eng = ImageSimulationEngine(builder(), config=cfg)
        sim = eng.run(src_img)
        dt = round(time.perf_counter() - t0, 3)
        arr = np.asarray(sim)
        print(f"  [PASS] {label} ({dt}s): shape={arr.shape}, min={arr.min():.4f}, max={arr.max():.4f}, sum={arr.sum():.2f}", flush=True)
        out[label] = {
            "ok": True,
            "elapsed_s": dt,
            "output_shape": list(arr.shape),
            "min": round(float(arr.min()), 5),
            "max": round(float(arr.max()), 5),
            "sum": round(float(arr.sum()), 3),
        }
    except Exception as e:
        dt = round(time.perf_counter() - t0, 3)
        msg = f"{type(e).__name__}: {str(e).splitlines()[0]}"
        print(f"  [FAIL] {label} ({dt}s): {msg}", flush=True)
        out[label] = {"ok": False, "elapsed_s": dt, "error": msg, "full_error": str(e)}

out_path = "experiments/p2_flagship/audits/audit05_image_simulation.json"
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(out, fh, indent=2, ensure_ascii=False)
print(f"\nSaved {out_path}", flush=True)
