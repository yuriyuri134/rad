import inspect
import json
import numpy as np
import optiland.backend as be
from optiland import optic, physical_apertures
from optiland.analysis import CentroidReferencePoint, Distortion, EncircledEnergy
from optiland.psf import FFTPSF, MMDFTPSF
from optiland.psf.fft import ScalarFFTPSF


def build_offaxis_tma():
    sys = optic.Optic(name="OffAxisTMA_Deep")
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


def build_rc_plus_corrector():
    sys = optic.Optic(name="RC_Deep")
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
    sys.wavelengths.add(0.55, is_primary=True)
    return sys


print("=== Signatures ===", flush=True)
print("EncircledEnergy:", inspect.signature(EncircledEnergy.__init__), flush=True)
print("Distortion:", inspect.signature(Distortion.__init__), flush=True)
print("ScalarFFTPSF._get_working_FNO source:", flush=True)
print(inspect.getsource(ScalarFFTPSF._get_working_FNO), flush=True)

report = {}
for name, builder in [("OffAxis_TMA", build_offaxis_tma), ("RC_Corrector", build_rc_plus_corrector)]:
    s = builder()
    entry = {}
    p = FFTPSF(s, field=(0, 1.0), wavelength=0.55, num_rays=32, grid_size=64, strategy="best_fit")
    try:
        fno = p._get_working_FNO()
        entry["fftpsf_working_FNO"] = {"ok": True, "fno": float(np.ravel(fno)[0])}
    except Exception as e:
        entry["fftpsf_working_FNO"] = {"ok": False, "error": f"{type(e).__name__}: {str(e).splitlines()[0]}"}

    try:
        x_ext, y_ext = p._get_psf_units(p.psf)
        entry["fftpsf_physical_extent_um"] = {"ok": True, "x_um": float(x_ext), "y_um": float(y_ext)}
    except Exception as e:
        entry["fftpsf_physical_extent_um"] = {"ok": False, "error": f"{type(e).__name__}: {str(e).splitlines()[0]}"}

    try:
        mmdft = MMDFTPSF(s, field=(0, 1.0), wavelength=0.55, num_rays=32, grid_size=64, strategy="best_fit")
        entry["mmdft_psf_32"] = {"ok": True, "shape": list(mmdft.psf.shape), "strehl": float(mmdft.strehl_ratio())}
    except Exception as e:
        entry["mmdft_psf_32"] = {"ok": False, "error": f"{type(e).__name__}: {str(e).splitlines()[0]}"}

    try:
        ee = EncircledEnergy(s)
        entry["encircled_energy"] = {"ok": True, "ee_len": len(ee.ee)}
    except Exception as e:
        entry["encircled_energy"] = {"ok": False, "error": f"{type(e).__name__}: {str(e).splitlines()[0]}"}

    try:
        d = Distortion(s, reference_point=CentroidReferencePoint())
        entry["distortion_centroid"] = {"ok": True, "data_shape": [int(x) for x in np.shape(d.data)]}
    except Exception as e:
        entry["distortion_centroid"] = {"ok": False, "error": f"{type(e).__name__}: {str(e).splitlines()[0]}"}

    report[name] = entry

print("\n=== Deep Boundary Report ===", flush=True)
print(json.dumps(report, indent=2), flush=True)
with open("experiments/p2_flagship/audits/audit02b_deep_checks.json", "w", encoding="utf-8") as fh:
    json.dump(report, fh, indent=2, ensure_ascii=False)
