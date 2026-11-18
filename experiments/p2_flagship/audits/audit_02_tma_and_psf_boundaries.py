import json
import time
import numpy as np
import optiland.backend as be
from optiland import optic, physical_apertures
from optiland.analysis import (
    CentroidReferencePoint,
    Distortion,
    EncircledEnergy,
    SpotDiagram,
)
from optiland.mtf import FFTMTF, GeometricMTF, HuygensMTF
from optiland.psf import FFTPSF, HuygensPSF, MMDFTPSF
from optiland.wavefront import Wavefront

results = {"systems": {}}


def timed_call(label, fn):
    t0 = time.perf_counter()
    try:
        out = fn()
        dt = round(time.perf_counter() - t0, 4)
        print(f"  [PASS] {label} ({dt}s): {out}", flush=True)
        return {"ok": True, "elapsed_s": dt, "summary": out}
    except Exception as e:
        dt = round(time.perf_counter() - t0, 4)
        msg = f"{type(e).__name__}: {str(e).splitlines()[0]}"
        print(f"  [FAIL] {label} ({dt}s): {msg}", flush=True)
        return {"ok": False, "elapsed_s": dt, "error": msg, "full_error": str(e)}


def build_offaxis_tma():
    # Unobscured off-axis reflective TMA testbed (arbitrary sanity geometry for API boundary check)
    sys = optic.Optic(name="OffAxisTMA_BoundaryTest")
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
    sys.wavelengths.add(0.55, is_primary=True)
    return sys


def build_coaxial_tma_biased_field():
    sys = optic.Optic(name="CoaxialBiasedTMA_BoundaryTest")
    sys.surfaces.add(index=0, thickness=be.inf)
    sys.surfaces.add(index=1, thickness=450.0, is_stop=True)
    sys.surfaces.add(index=2, radius=-1400.0, thickness=-480.0, material="mirror", conic=-1.0)
    sys.surfaces.add(index=3, radius=-380.0, thickness=540.0, material="mirror", conic=-2.4)
    sys.surfaces.add(index=4, radius=-560.0, thickness=-460.0, material="mirror", conic=-0.45)
    sys.surfaces.add(index=5)
    sys.set_aperture("EPD", 250.0)
    sys.fields.set_type("angle")
    sys.fields.add(y=0.0)
    sys.fields.add(y=0.4)
    sys.fields.add(y=0.8)
    sys.wavelengths.add(0.55, is_primary=True)
    return sys


def build_rc_plus_corrector():
    sys = optic.Optic(name="RC_Corrector_BoundaryTest")
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


def run_suite(name, builder):
    print(f"\n=== SYSTEM: {name} ===", flush=True)
    sys_res = {}
    s = builder()

    sys_res["real_raytrace"] = timed_call("real_raytrace", lambda: (
        s.trace(Hx=0.0, Hy=1.0, wavelength=0.55, num_rays=9),
        {
            "n_rays": int(np.size(s.surfaces[-1].y)),
            "y_mean_mm": round(float(np.mean(s.surfaces[-1].y)), 4),
            "y_std_mm": round(float(np.std(s.surfaces[-1].y)), 6),
        },
    )[1])

    sys_res["spot_diagram"] = timed_call("spot_diagram", lambda: (
        lambda sd: {
            "rms_radius_mm": [round(float(x), 6) for x in np.ravel(sd.rms_spot_radius())],
        }
    )(SpotDiagram(s, num_rings=4)))

    sys_res["paraxial_efl"] = timed_call("paraxial_efl", lambda: {
        "f2_mm": round(float(np.ravel(s.paraxial.f2())[0]), 4),
        "fno": round(float(np.ravel(s.paraxial.FNO())[0]), 4),
    })

    for strat in ["chief_ray", "centroid", "best_fit"]:
        sys_res[f"wavefront_{strat}"] = timed_call(f"wavefront_{strat}", lambda st=strat: (
            lambda wf: {
                "opd_rms_waves": round(float(np.std(wf.get_data((0, 1.0), 0.55).opd)), 5),
                "opd_ptv_waves": round(float(np.ptp(wf.get_data((0, 1.0), 0.55).opd)), 5),
            }
        )(Wavefront(s, num_rays=16, strategy=st)))

    for strat in ["chief_ray", "centroid", "best_fit"]:
        sys_res[f"fftpsf_{strat}"] = timed_call(f"fftpsf_{strat}", lambda st=strat: (
            lambda p: {
                "shape": list(p.psf.shape),
                "strehl": round(float(p.strehl_ratio()), 5),
                "psf_sum": round(float(np.sum(p.psf)), 4),
            }
        )(FFTPSF(s, field=(0, 1.0), wavelength=0.55, num_rays=24, grid_size=64, strategy=st)))

    for strat in ["chief_ray", "centroid", "best_fit"]:
        sys_res[f"mmdft_psf_{strat}"] = timed_call(f"mmdft_psf_{strat}", lambda st=strat: (
            lambda p: {
                "shape": list(p.psf.shape),
                "strehl": round(float(p.strehl_ratio()), 5),
            }
        )(MMDFTPSF(s, field=(0, 1.0), wavelength=0.55, num_rays=24, grid_size=64, strategy=st)))

    # Very small Huygens sampling first (num_rays=12, grid_size/image_size check)
    sys_res["huygens_psf_low"] = timed_call("huygens_psf(num_rays=12, grid_size=16)", lambda: (
        lambda p: {
            "shape": list(p.psf.shape),
            "strehl": round(float(p.strehl_ratio()), 5),
        }
    )(HuygensPSF(s, field=(0, 1.0), wavelength=0.55, num_rays=12, image_size=16)))

    sys_res["geom_mtf"] = timed_call("geom_mtf", lambda: (
        lambda m: {"has_data": hasattr(m, "mtf") and len(m.mtf) > 0}
    )(GeometricMTF(s, wavelength=0.55, num_rays=16, max_freq=50)))

    sys_res["fft_mtf"] = timed_call("fft_mtf", lambda: (
        lambda m: {"has_data": hasattr(m, "mtf") and len(m.mtf) > 0}
    )(FFTMTF(s, wavelength=0.55, num_rays=24, grid_size=64, max_freq=50)))

    sys_res["huygens_mtf"] = timed_call("huygens_mtf", lambda: (
        lambda m: {"has_data": hasattr(m, "mtf") and len(m.mtf) > 0}
    )(HuygensMTF(s, wavelength=0.55, num_rays=12, image_size=16, max_freq=50)))

    sys_res["encircled_energy"] = timed_call("encircled_energy", lambda: (
        lambda ee: {"ok": True}
    )(EncircledEnergy(s, num_rings=12)))

    sys_res["distortion_default"] = timed_call("distortion_default", lambda: (
        lambda d: {"ok": True}
    )(Distortion(s, wavelength=0.55)))

    sys_res["distortion_centroid_ref"] = timed_call("distortion_centroid_ref", lambda: (
        lambda d: {"ok": True}
    )(Distortion(s, wavelength=0.55, reference_point=CentroidReferencePoint())))

    results["systems"][name] = sys_res


run_suite("OffAxis_TMA", build_offaxis_tma)
run_suite("Coaxial_Biased_TMA", build_coaxial_tma_biased_field)
run_suite("RC_Plus_2Lens_Corrector", build_rc_plus_corrector)

out_path = "experiments/p2_flagship/audits/audit02_tma_and_psf_boundaries.json"
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(results, fh, indent=2, ensure_ascii=False)
print(f"\nSaved {out_path}", flush=True)
