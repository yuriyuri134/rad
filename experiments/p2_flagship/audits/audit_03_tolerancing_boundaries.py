import json
import time
import numpy as np
import optiland.backend as be
from optiland import optic, physical_apertures, tolerancing
from optiland.tolerancing.monte_carlo import MonteCarlo
from optiland.tolerancing.perturbation import DistributionSampler, RangeSampler
from optiland.tolerancing.sensitivity_analysis import SensitivityAnalysis


def build_rc_corrector():
    sys = optic.Optic(name="RC_TolTest")
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
    sys.fields.add(y=0.5)
    sys.wavelengths.add(0.55, is_primary=True)
    return sys


def build_offaxis_tma():
    sys = optic.Optic(name="TMA_TolTest")
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


def test_tolerancing(label, builder, surf_m2=3, surf_comp=7):
    print(f"\n=== TOLERANCING: {label} ===", flush=True)
    out = {}
    s = builder()
    tol = tolerancing.Tolerancing(s)
    tol.add_perturbation("radius", RangeSampler(start=-5.0, end=5.0, steps=3), surface_number=2)
    tol.add_perturbation("thickness", RangeSampler(start=-0.2, end=0.2, steps=3), surface_number=surf_m2)
    tol.add_perturbation("tilt", DistributionSampler("normal", seed=42, loc=0.0, scale=1e-4), surface_number=surf_m2, axis="x")
    tol.add_perturbation("decenter", DistributionSampler("normal", seed=43, loc=0.0, scale=0.05), surface_number=surf_m2, axis="y")
    tol.add_compensator("thickness", surface_number=surf_comp)
    tol.add_operand(
        operand_type="rms_spot_size",
        input_data={"optic": s, "surface_number": -1, "Hx": 0.0, "Hy": 0.0, "wavelength": 0.55, "num_rays": 5},
        target=0.0,
        weight=1.0,
    )
    tol.add_operand(
        operand_type="rms_spot_size",
        input_data={"optic": s, "surface_number": -1, "Hx": 0.0, "Hy": 1.0, "wavelength": 0.55, "num_rays": 5},
        target=0.0,
        weight=1.0,
    )

    t0 = time.perf_counter()
    try:
        sa = SensitivityAnalysis(tol)
        sa.run()
        df_sa = sa.get_results()
        dt = round(time.perf_counter() - t0, 3)
        print(f"  [PASS] SensitivityAnalysis ({dt}s): shape={df_sa.shape}", flush=True)
        print(df_sa.head(6).to_string(), flush=True)
        out["sensitivity"] = {"ok": True, "elapsed_s": dt, "shape": list(df_sa.shape), "columns": list(df_sa.columns)}
    except Exception as e:
        dt = round(time.perf_counter() - t0, 3)
        print(f"  [FAIL] SensitivityAnalysis ({dt}s): {type(e).__name__}: {e}", flush=True)
        out["sensitivity"] = {"ok": False, "elapsed_s": dt, "error": f"{type(e).__name__}: {e}"}

    s2 = builder()
    tol_mc = tolerancing.Tolerancing(s2)
    tol_mc.add_perturbation("radius", DistributionSampler("normal", seed=101, loc=0.0, scale=2.5), surface_number=2)
    tol_mc.add_perturbation("thickness", DistributionSampler("normal", seed=102, loc=0.0, scale=0.1), surface_number=surf_m2)
    tol_mc.add_perturbation("tilt", DistributionSampler("normal", seed=103, loc=0.0, scale=1e-4), surface_number=surf_m2, axis="x")
    tol_mc.add_perturbation("decenter", DistributionSampler("normal", seed=104, loc=0.0, scale=0.05), surface_number=surf_m2, axis="y")
    tol_mc.add_compensator("thickness", surface_number=surf_comp)
    tol_mc.add_operand(
        operand_type="rms_spot_size",
        input_data={"optic": s2, "surface_number": -1, "Hx": 0.0, "Hy": 0.0, "wavelength": 0.55, "num_rays": 5},
        target=0.0,
        weight=1.0,
    )
    tol_mc.add_operand(
        operand_type="rms_spot_size",
        input_data={"optic": s2, "surface_number": -1, "Hx": 0.0, "Hy": 1.0, "wavelength": 0.55, "num_rays": 5},
        target=0.0,
        weight=1.0,
    )

    t1 = time.perf_counter()
    try:
        mc = MonteCarlo(tol_mc)
        mc.run(num_iterations=10)
        df_mc = mc.get_results()
        dt = round(time.perf_counter() - t1, 3)
        print(f"  [PASS] MonteCarlo(N=10) ({dt}s): shape={df_mc.shape}", flush=True)
        print(df_mc.head(5).to_string(), flush=True)
        out["monte_carlo"] = {"ok": True, "elapsed_s": dt, "shape": list(df_mc.shape), "columns": list(df_mc.columns)}
    except Exception as e:
        dt = round(time.perf_counter() - t1, 3)
        print(f"  [FAIL] MonteCarlo ({dt}s): {type(e).__name__}: {e}", flush=True)
        out["monte_carlo"] = {"ok": False, "elapsed_s": dt, "error": f"{type(e).__name__}: {e}"}

    return out


res = {
    "RC_Corrector": test_tolerancing("RC_Corrector", build_rc_corrector, surf_m2=3, surf_comp=7),
    "OffAxis_TMA": test_tolerancing("OffAxis_TMA", build_offaxis_tma, surf_m2=3, surf_comp=4),
}

out_path = "experiments/p2_flagship/audits/audit03_tolerancing_boundaries.json"
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(res, fh, indent=2, ensure_ascii=False)
print(f"\nSaved {out_path}", flush=True)
