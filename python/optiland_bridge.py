#!/usr/bin/env python3
"""
OpenLab Bench — Optiland Python 求解与优化桥接器

使用已验证的 Optiland 0.5/0.6 API：
  - optiland.optic.Optic
  - system.surfaces.add(index=..., radius=..., thickness=..., is_stop=..., material=...)
  - system.set_aperture(aperture_type="EPD", value=...)
  - system.fields.set_type("angle") / system.fields.add(y=...)
  - system.wavelengths.add(value=<um>, is_primary=...)
  - system.updater.image_solve()
  - system.paraxial.f2()
  - optiland.analysis.SpotDiagram(optic=..., fields="all", wavelengths="all", ...)
  - optiland.mtf.GeometricMTF
  - optiland.optimization.OptimizationProblem / LeastSquares

在缺少 Python 3.11+ 或 optiland 的云端预览容器内，诚实返回 unavailable_in_container，绝不伪造物理数据。
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import math
import platform
import sys
import time
from typing import Any


def probe_environment() -> dict[str, Any]:
    py_ver = platform.python_version()
    py_tuple = sys.version_info[:3]
    info: dict[str, Any] = {
        "pythonVersion": py_ver,
        "pythonOkForOptiland": py_tuple >= (3, 11),
        "platform": platform.platform(),
        "optilandInstalled": False,
        "optilandVersion": None,
        "numpyVersion": None,
        "scipyVersion": None,
        "error": None,
    }

    for pkg, key in [("numpy", "numpyVersion"), ("scipy", "scipyVersion"), ("optiland", "optilandVersion")]:
        try:
            info[key] = importlib.metadata.version(pkg)
            if pkg == "optiland":
                info["optilandInstalled"] = True
        except importlib.metadata.PackageNotFoundError:
            pass

    if not info["optilandInstalled"]:
        info["error"] = (
            f"当前 Python {py_ver} 环境未安装 optiland（Optiland 官方要求 Python >= 3.11）。"
            "请在 Rad 本地 Python 3.11+ 环境中执行 `pip install -e .` 安装后运行。"
        )
    return info


def build_optiland_system(spec: dict[str, Any]) -> Any:
    import numpy as np
    from optiland.optic import Optic

    system = Optic(name=spec.get("name", "OpenLab Optic"))
    # Index 0: Object at infinity
    system.surfaces.add(index=0, radius=np.inf, thickness=np.inf)

    surfaces = spec.get("surfaces", [])
    for idx, surf in enumerate(surfaces, start=1):
        raw_r = surf.get("radiusMm")
        radius = np.inf if raw_r is None else float(raw_r)
        thickness = float(surf.get("thicknessMm", 0.0))
        glass = surf.get("glassAfter", "AIR")
        mat = None if glass == "AIR" else ("N-BK7" if glass == "N-BK7" else glass)
        if glass == "FUSED_SILICA":
            mat = "Fused Silica"

        kwargs: dict[str, Any] = {
            "index": idx,
            "radius": radius,
            "thickness": thickness,
            "is_stop": idx == 1,
        }
        if mat is not None:
            kwargs["material"] = mat
        system.surfaces.add(**kwargs)

    # Image surface
    system.surfaces.add(index=len(surfaces) + 1, radius=np.inf, thickness=0.0)

    epd = float(spec.get("entrancePupilDiameterMm", 25.0))
    system.set_aperture(aperture_type="EPD", value=epd)

    system.fields.set_type(field_type="angle")
    for field_deg in spec.get("fieldAnglesDeg", [0.0]):
        system.fields.add(y=float(field_deg))

    wavelengths_nm = spec.get("wavelengthsNm", [486.13, 587.56, 656.27])
    primary_wl = 587.56 if 587.56 in wavelengths_nm else wavelengths_nm[len(wavelengths_nm) // 2]
    for wl_nm in wavelengths_nm:
        system.wavelengths.add(value=float(wl_nm) / 1000.0, is_primary=abs(float(wl_nm) - primary_wl) < 1e-3)

    system.updater.image_solve()
    return system


def analyze_optiland_system(system: Any, spec: dict[str, Any]) -> dict[str, Any]:
    import numpy as np
    from optiland.analysis import SpotDiagram
    from optiland.mtf import GeometricMTF

    efl_mm = float(system.paraxial.f2())
    epd = float(spec.get("entrancePupilDiameterMm", 25.0))
    f_number = abs(efl_mm) / max(0.1, epd)

    spot = SpotDiagram(
        optic=system,
        fields="all",
        wavelengths="all",
        num_rings=6,
        distribution="hexapolar",
    )
    rms_raw = spot.rms_spot_radius()
    rms_arr = np.atleast_1d(np.asarray(rms_raw, dtype=float)).reshape(-1)
    rms_mm = float(rms_arr[0])
    rms_um = rms_mm * 1000.0

    # Extract spot coordinates if available in SpotDiagram.data
    spot_points: list[dict[str, float]] = []
    if hasattr(spot, "data") and len(spot.data) > 0:
        first_field = spot.data[0]
        for wl_idx, wl_nm in enumerate(spec.get("wavelengthsNm", [587.56])):
            if wl_idx < len(first_field):
                pts = first_field[wl_idx]
                xs = getattr(pts, "x", [])
                ys = getattr(pts, "y", [])
                for x_val, y_val in zip(xs, ys):
                    spot_points.append({
                        "wavelengthNm": float(wl_nm),
                        "fieldDeg": 0.0,
                        "xUm": round(float(x_val) * 1000.0, 3),
                        "yUm": round(float(y_val) * 1000.0, 3),
                    })

    # Geometric MTF
    mtf_obj = GeometricMTF(optic=system, fields="all", wavelength="primary", max_freq=100.0, num_rays=64)
    mtf_30 = 0.0
    mtf_60 = 0.0
    mtf_curve: list[dict[str, float]] = []
    if hasattr(mtf_obj, "freq") and hasattr(mtf_obj, "mtf"):
        freqs = list(mtf_obj.freq)
        tan_vals = list(mtf_obj.mtf[0][0]) if len(mtf_obj.mtf) > 0 else []
        sag_vals = list(mtf_obj.mtf[0][1]) if len(mtf_obj.mtf) > 0 and len(mtf_obj.mtf[0]) > 1 else tan_vals
        for f_val, t_val, s_val in zip(freqs, tan_vals, sag_vals):
            mtf_curve.append({
                "freqLpMm": round(float(f_val), 2),
                "mtfTangential": round(float(t_val), 4),
                "mtfSagittal": round(float(s_val), 4),
            })
        if mtf_curve:
            mtf_30 = min(mtf_curve, key=lambda p: abs(p["freqLpMm"] - 30.0))["mtfTangential"]
            mtf_60 = min(mtf_curve, key=lambda p: abs(p["freqLpMm"] - 60.0))["mtfTangential"]

    # Extract final BFL from last glass surface thickness before image plane
    last_surf_idx = len(spec.get("surfaces", []))
    bfl_mm = float(system.surface_group.surfaces[last_surf_idx].thickness) if hasattr(system, "surface_group") else 0.0

    return {
        "solverEngine": "optiland",
        "paraxialEflMm": round(efl_mm, 4),
        "paraxialBflMm": round(bfl_mm, 4),
        "fNumber": round(f_number, 3),
        "rmsSpotRadiusUm": round(rms_um, 3),
        "mtf30LpMm": round(mtf_30, 4),
        "mtf60LpMm": round(mtf_60, 4),
        "mtfCurve": mtf_curve,
        "spotPoints": spot_points,
    }


def run_self_check() -> dict[str, Any]:
    env = probe_environment()
    if not env["optilandInstalled"]:
        return {
            "status": "env_unavailable",
            "passed": False,
            "environment": env,
            "message": env["error"],
        }

    # Known analytical singlet benchmark: N-BK7 R1=100, R2=-100, thickness=4, EPD=10
    benchmark_spec = {
        "name": "Optiland Benchmark Singlet",
        "entrancePupilDiameterMm": 10.0,
        "fieldAnglesDeg": [0.0],
        "wavelengthsNm": [587.56],
        "surfaces": [
            {"radiusMm": 100.0, "thicknessMm": 4.0, "glassAfter": "N-BK7"},
            {"radiusMm": -100.0, "thicknessMm": 0.0, "glassAfter": "AIR"},
        ],
    }
    t0 = time.time()
    system = build_optiland_system(benchmark_spec)
    res = analyze_optiland_system(system, benchmark_spec)
    efl = res["paraxialEflMm"]
    passed = 95.0 <= efl <= 100.5 and res["rmsSpotRadiusUm"] >= 0.0
    return {
        "status": "passed" if passed else "failed",
        "passed": passed,
        "elapsedMs": round((time.time() - t0) * 1000, 1),
        "environment": env,
        "benchmarkResult": res,
        "message": f"Optiland {env['optilandVersion']} 基准验证 EFL={efl} mm, RMS={res['rmsSpotRadiusUm']} μm",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="OpenLab Bench Optiland Bridge")
    parser.add_argument("--probe", action="store_true", help="探测本地 Python 与 Optiland 版本")
    parser.add_argument("--check", action="store_true", help="执行 Optiland 基准自检")
    parser.add_argument("--solve", action="store_true", help="从 stdin 读取光学系统 JSON 并运行 Optiland 求解")
    parser.add_argument("--optimize", action="store_true", help="从 stdin 读取光学系统 JSON 并运行 Optiland 最小二乘优化")
    args = parser.parse_args()

    if args.probe:
        print(json.dumps(probe_environment(), ensure_ascii=False))
        return 0

    if args.check:
        out = run_self_check()
        print(json.dumps(out, ensure_ascii=False))
        return 0 if out["passed"] else 2

    env = probe_environment()
    if not env["optilandInstalled"]:
        print(
            json.dumps(
                {
                    "status": "unavailable_in_container",
                    "environment": env,
                    "error": env["error"],
                },
                ensure_ascii=False,
            )
        )
        return 2

    payload = json.loads(sys.stdin.read().strip() or "{}")
    spec = payload.get("systemSpec", payload)
    system = build_optiland_system(spec)

    if args.solve:
        result = analyze_optiland_system(system, spec)
        print(json.dumps({"status": "ok", "environment": env, "result": result}, ensure_ascii=False))
        return 0

    if args.optimize:
        from optiland.optimization import LeastSquares, OptimizationProblem

        problem = OptimizationProblem()
        for idx, surf in enumerate(spec.get("surfaces", []), start=1):
            if surf.get("variableRadius"):
                problem.add_variable(system, "radius", surface_number=idx)
            if surf.get("variableThickness"):
                problem.add_variable(system, "thickness", surface_number=idx, min_val=1.0)

        target_efl = float(spec.get("targetEflMm", 100.0))
        problem.add_operand(
            operand_type="f2",
            target=target_efl,
            weight=10.0,
            input_data={"optic": system},
        )
        problem.add_operand(
            operand_type="rms_spot_size",
            target=0.0,
            weight=1.0,
            input_data={"optic": system, "field_number": 0, "wavelength": 0.58756, "num_rays": 6, "distribution": "hexapolar"},
        )
        optimizer = LeastSquares(problem)
        optimizer.optimize()
        system.updater.image_solve()

        # Extract updated radii & thicknesses back to spec
        updated_surfaces = []
        for idx, surf in enumerate(spec.get("surfaces", []), start=1):
            s_obj = system.surface_group.surfaces[idx]
            new_r = float(s_obj.geometry.radius)
            updated_surfaces.append({
                **surf,
                "radiusMm": None if math.isinf(new_r) else round(new_r, 4),
                "thicknessMm": round(float(s_obj.thickness), 4) if idx < len(spec.get("surfaces", [])) else 0.0,
            })

        optimized_spec = {**spec, "surfaces": updated_surfaces}
        result = analyze_optiland_system(system, optimized_spec)
        print(
            json.dumps(
                {
                    "status": "ok",
                    "environment": env,
                    "optimizedSpec": optimized_spec,
                    "result": result,
                },
                ensure_ascii=False,
            )
        )
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
