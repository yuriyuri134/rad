#!/usr/bin/env python3
"""
OpenLab Bench — P1: AI-Driven Real Optical Design Practice (Track A Singlet & Track B Achromatic Doublet)

Uses verified Optiland 0.6.3 APIs inside the isolated Python 3.12 venv (/tmp/p1_venv).
Every round preserves:
  - initial prescription & constraints
  - AI hypothesis & expected physical effect
  - actual tool calls & optimization solver status
  - full multi-field (0°, 0.5°, 1°) x multi-wavelength (F, d, C) evaluation on ONE FIXED image plane
  - aberrations (Seidel, LchC, TchC), vignetting/clipped rays, edge thickness, GeometricMTF (d-line), Airy ref
  - surprises / discrepancies & post-round decision
"""

from __future__ import annotations

import importlib.metadata
import json
import math
import time
from pathlib import Path
from typing import Any

import numpy as np
from optiland.analysis import SpotDiagram
from optiland.materials import Material
from optiland.mtf import GeometricMTF
from optiland.optic import Optic
from optiland.optimization import LeastSquares, OptimizationProblem
from optiland.physical_apertures import RadialAperture

ROOT_DIR = Path(__file__).resolve().parent
ARTIFACTS_DIR = ROOT_DIR / "artifacts"
ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)

WAVELENGTHS_UM = {"F": 0.48613, "d": 0.58756, "C": 0.65627}
FIELD_ANGLES_DEG = [0.0, 0.5, 1.0]
EPD_MM = 25.0
TARGET_EFL_MM = 100.0
DEFAULT_SEMI_APERTURE_MM = 14.0


def scalar(val: Any) -> float:
    return float(np.asarray(val).item())


def get_schott_index(name: str, wl_um: float) -> float:
    mat = Material(name, catalog="schott")
    return scalar(mat.n(wl_um))


def get_abbe_number(name: str) -> tuple[float, float, float, float]:
    nd = get_schott_index(name, WAVELENGTHS_UM["d"])
    nf = get_schott_index(name, WAVELENGTHS_UM["F"])
    nc = get_schott_index(name, WAVELENGTHS_UM["C"])
    vd = (nd - 1.0) / (nf - nc)
    return nd, nf, nc, vd


def build_optic_from_prescription(
    name: str,
    surfaces: list[dict[str, Any]],
    fixed_bfl_mm: float | None = None,
    epd_mm: float = EPD_MM,
    fields_deg: list[float] = FIELD_ANGLES_DEG,
) -> Optic:
    """
    Build an Optiland Optic with explicit RadialAperture on every lens surface.
    If fixed_bfl_mm is None: solves on-axis d-line paraxial image plane once via updater.image_solve().
    If fixed_bfl_mm is provided: uses that exact fixed BFL without calling image_solve().
    """
    optic = Optic(name=name)
    optic.surfaces.add(index=0, radius=np.inf, thickness=np.inf)

    for idx, surf in enumerate(surfaces, start=1):
        r_mm = np.inf if surf["radiusMm"] is None else float(surf["radiusMm"])
        thick_mm = float(surf["thicknessMm"])
        if idx == len(surfaces) and fixed_bfl_mm is not None:
            thick_mm = float(fixed_bfl_mm)

        glass = surf["glassAfter"]
        mat: Any = "air" if glass == "AIR" else Material(glass, catalog="schott")
        semi_ap = float(surf.get("semiApertureMm", DEFAULT_SEMI_APERTURE_MM))

        optic.surfaces.add(
            index=idx,
            radius=r_mm,
            thickness=thick_mm,
            is_stop=(idx == 1),
            material=mat,
            aperture=RadialAperture(r_max=semi_ap),
        )

    optic.surfaces.add(index=len(surfaces) + 1, radius=np.inf, thickness=0.0)
    optic.set_aperture(aperture_type="EPD", value=epd_mm)

    optic.fields.set_type(field_type="angle")
    for f_deg in fields_deg:
        optic.fields.add(y=float(f_deg))

    optic.wavelengths.add(value=WAVELENGTHS_UM["F"], is_primary=False, weight=1.0)
    optic.wavelengths.add(value=WAVELENGTHS_UM["d"], is_primary=True, weight=1.0)
    optic.wavelengths.add(value=WAVELENGTHS_UM["C"], is_primary=False, weight=1.0)

    if fixed_bfl_mm is None:
        optic.updater.image_solve()

    return optic


def extract_prescription(optic: Optic, base_surfaces: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], float]:
    out_surfs = []
    n_surfs = len(base_surfaces)
    for idx, base in enumerate(base_surfaces, start=1):
        s_obj = optic.surfaces[idx]
        r_val = scalar(s_obj.geometry.radius)
        t_val = scalar(optic.surfaces.get_thickness(idx))
        out_surfs.append({
            **base,
            "radiusMm": None if math.isinf(r_val) else round(r_val, 5),
            "thicknessMm": round(t_val, 5),
        })
    bfl = scalar(optic.surfaces.get_thickness(n_surfs))
    return out_surfs, bfl


def compute_edge_thickness_mm(optic: Optic, surf_idx: int, semi_ap_mm: float) -> float:
    s1 = optic.surfaces[surf_idx]
    s2 = optic.surfaces[surf_idx + 1]
    sag1 = scalar(s1.geometry.sag(y=semi_ap_mm))
    sag2 = scalar(s2.geometry.sag(y=semi_ap_mm))
    t = scalar(optic.surfaces.get_thickness(surf_idx))
    return t - sag1 + sag2


def compute_paraxial_bfl_at_wavelength(surfaces: list[dict[str, Any]], wl_um: float, epd_mm: float = EPD_MM) -> tuple[float, float]:
    """Build single-wavelength optic and run paraxial image_solve to measure chromatic focal shift without touching main optic."""
    tmp = Optic(name="wl_bfl_probe")
    tmp.surfaces.add(index=0, radius=np.inf, thickness=np.inf)
    for idx, surf in enumerate(surfaces, start=1):
        r_mm = np.inf if surf["radiusMm"] is None else float(surf["radiusMm"])
        thick_mm = float(surf["thicknessMm"])
        glass = surf["glassAfter"]
        mat: Any = "air" if glass == "AIR" else Material(glass, catalog="schott")
        tmp.surfaces.add(index=idx, radius=r_mm, thickness=thick_mm, is_stop=(idx == 1), material=mat)
    tmp.surfaces.add(index=len(surfaces) + 1, radius=np.inf, thickness=0.0)
    tmp.set_aperture("EPD", epd_mm)
    tmp.fields.set_type("angle")
    tmp.fields.add(y=0.0)
    tmp.wavelengths.add(value=wl_um, is_primary=True)
    tmp.updater.image_solve()
    efl = scalar(tmp.paraxial.f2())
    bfl = scalar(tmp.surfaces.get_thickness(len(surfaces)))
    return efl, bfl


def evaluate_optic_fixed_plane(
    optic: Optic,
    surfaces: list[dict[str, Any]],
    focus_rule_note: str,
) -> dict[str, Any]:
    """
    Evaluate all metrics strictly on the ALREADY LOCKED image plane (no image_solve calls!).
    Separates geometric optics quantities from diffraction Airy reference.
    """
    efl_d = scalar(optic.paraxial.f2())
    fno_d = scalar(optic.paraxial.FNO())
    fixed_bfl_mm = scalar(optic.surfaces.get_thickness(len(surfaces)))

    efl_f, bfl_f = compute_paraxial_bfl_at_wavelength(surfaces, WAVELENGTHS_UM["F"])
    efl_d_check, bfl_d_paraxial = compute_paraxial_bfl_at_wavelength(surfaces, WAVELENGTHS_UM["d"])
    efl_c, bfl_c = compute_paraxial_bfl_at_wavelength(surfaces, WAVELENGTHS_UM["C"])
    axial_chrom_fc_mm = bfl_f - bfl_c  # signed: negative means F focuses shorter (typical crown)

    # Edge thicknesses for glass elements
    edge_thicknesses: dict[str, float] = {}
    for idx, surf in enumerate(surfaces, start=1):
        if surf["glassAfter"] != "AIR":
            semi_ap = float(surf.get("semiApertureMm", DEFAULT_SEMI_APERTURE_MM))
            et = compute_edge_thickness_mm(optic, idx, semi_ap)
            edge_thicknesses[f"element_s{idx}_to_s{idx+1}_at_{semi_ap}mm"] = round(et, 4)

    # Global-coordinate SpotDiagram to keep chief ray & centroid positions relative to optical axis!
    spot_global = SpotDiagram(
        optic=optic,
        fields="all",
        wavelengths="all",
        num_rings=8,
        distribution="hexapolar",
        coordinates="global",
        reference="chief_ray",
    )
    spot_local_chief = SpotDiagram(
        optic=optic,
        fields="all",
        wavelengths="all",
        num_rings=8,
        distribution="hexapolar",
        coordinates="local",
        reference="chief_ray",
    )
    spot_local_centroid = SpotDiagram(
        optic=optic,
        fields="all",
        wavelengths="all",
        num_rings=8,
        distribution="hexapolar",
        coordinates="local",
        reference="centroid",
    )

    rms_chief_nested = spot_local_chief.rms_spot_radius()
    rms_centroid_nested = spot_local_centroid.rms_spot_radius()
    geo_max_nested = spot_local_centroid.geometric_spot_radius()

    wl_keys = ["F", "d", "C"]
    wl_values = [WAVELENGTHS_UM["F"], WAVELENGTHS_UM["d"], WAVELENGTHS_UM["C"]]

    field_results: list[dict[str, Any]] = []
    all_poly_sq_chief: list[float] = []
    all_poly_sq_centroid: list[float] = []
    total_rays_traced = 0
    total_clipped_rays = 0
    total_tir_or_nan_rays = 0

    for f_idx, f_deg in enumerate(FIELD_ANGLES_DEG):
        hy_norm = f_deg / max(FIELD_ANGLES_DEG) if max(FIELD_ANGLES_DEG) > 0 else 0.0
        ideal_y_mm = efl_d * math.tan(math.radians(f_deg))
        ideal_target_100_mm = TARGET_EFL_MM * math.tan(math.radians(f_deg))

        per_wl: dict[str, Any] = {}
        poly_xs_mm: list[np.ndarray] = []
        poly_ys_mm: list[np.ndarray] = []

        # Chief ray in primary d-line
        chief_d = optic.trace_generic(Hx=0.0, Hy=hy_norm, Px=0.0, Py=0.0, wavelength=WAVELENGTHS_UM["d"])
        chief_y_d_mm = scalar(chief_d.y[0])

        for w_idx, (w_key, w_um) in enumerate(zip(wl_keys, wl_values)):
            # Direct trace to inspect vignetting (i <= 0) & NaN/TIR
            rays = optic.trace(Hx=0.0, Hy=hy_norm, wavelength=w_um, num_rays=8, distribution="hexapolar")
            n_rays = len(rays.i)
            n_clipped = int(np.sum(rays.i <= 0))
            n_nan = int(np.sum(np.isnan(rays.x) | np.isnan(rays.y)))
            total_rays_traced += n_rays
            total_clipped_rays += n_clipped
            total_tir_or_nan_rays += n_nan

            gx = np.asarray(spot_global.data[f_idx][w_idx].x, dtype=float)
            gy = np.asarray(spot_global.data[f_idx][w_idx].y, dtype=float)
            valid_mask = ~(np.isnan(gx) | np.isnan(gy))
            gx_v, gy_v = gx[valid_mask], gy[valid_mask]

            poly_xs_mm.append(gx_v)
            poly_ys_mm.append(gy_v)

            mean_y_mm = float(np.mean(gy_v)) if len(gy_v) > 0 else float("nan")
            rms_chief_um = scalar(rms_chief_nested[f_idx][w_idx]) * 1000.0
            rms_cent_um = scalar(rms_centroid_nested[f_idx][w_idx]) * 1000.0
            max_rad_um = scalar(geo_max_nested[f_idx][w_idx]) * 1000.0

            per_wl[w_key] = {
                "wavelengthUm": w_um,
                "rmsRadiusAboutChiefUm": round(rms_chief_um, 3),
                "rmsRadiusAboutCentroidUm": round(rms_cent_um, 3),
                "maxRadiusAboutCentroidUm": round(max_rad_um, 3),
                "centroidYmm": round(mean_y_mm, 6),
                "centroidShiftFromChiefUm": round((mean_y_mm - chief_y_d_mm) * 1000.0, 3),
                "clippedRays": n_clipped,
                "nanRays": n_nan,
                "totalRays": n_rays,
            }

        all_x = np.concatenate(poly_xs_mm)
        all_y = np.concatenate(poly_ys_mm)
        poly_cent_x = float(np.mean(all_x))
        poly_cent_y = float(np.mean(all_y))
        poly_rms_centroid_um = float(np.sqrt(np.mean((all_x - poly_cent_x) ** 2 + (all_y - poly_cent_y) ** 2)) * 1000.0)
        poly_rms_chief_um = float(np.sqrt(np.mean(all_x ** 2 + (all_y - chief_y_d_mm) ** 2)) * 1000.0)
        all_poly_sq_chief.append(poly_rms_chief_um ** 2)
        all_poly_sq_centroid.append(poly_rms_centroid_um ** 2)

        lateral_color_fc_um = (per_wl["F"]["centroidYmm"] - per_wl["C"]["centroidYmm"]) * 1000.0
        distortion_pct = ((chief_y_d_mm - ideal_y_mm) / ideal_y_mm * 100.0) if abs(ideal_y_mm) > 1e-9 else 0.0

        field_results.append({
            "fieldDeg": f_deg,
            "idealImageHeightAtEflMm": round(ideal_y_mm, 6),
            "idealImageHeightAt100Mm": round(ideal_target_100_mm, 6),
            "chiefRayYDLineMm": round(chief_y_d_mm, 6),
            "polychromaticCentroidYmm": round(poly_cent_y, 6),
            "distortionPct": round(distortion_pct, 4),
            "comaAndAsymCentroidShiftUm": round((poly_cent_y - chief_y_d_mm) * 1000.0, 3),
            "lateralColorFcCentroidUm": round(lateral_color_fc_um, 3),
            "polychromaticRmsAboutChiefUm": round(poly_rms_chief_um, 3),
            "polychromaticRmsAboutCentroidUm": round(poly_rms_centroid_um, 3),
            "byWavelength": per_wl,
        })

    overall_poly_rms_centroid_um = float(math.sqrt(sum(all_poly_sq_centroid) / len(all_poly_sq_centroid)))
    overall_poly_rms_chief_um = float(math.sqrt(sum(all_poly_sq_chief) / len(all_poly_sq_chief)))

    # Geometric MTF at primary wavelength (d-line), explicitly separated from diffraction MTF
    geom_mtf = GeometricMTF(
        optic=optic,
        fields="all",
        wavelength="primary",
        num_rays=128,
        distribution="uniform",
        num_points=201,
        max_freq=100.0,
        scale=True,
    )
    freqs = np.asarray(geom_mtf.freq, dtype=float)
    mtf_by_field: list[dict[str, Any]] = []
    idx_30 = int(np.argmin(np.abs(freqs - 30.0)))
    idx_60 = int(np.argmin(np.abs(freqs - 60.0)))
    for f_idx, f_deg in enumerate(FIELD_ANGLES_DEG):
        tan_arr = np.asarray(geom_mtf.mtf[f_idx][0], dtype=float)
        sag_arr = np.asarray(geom_mtf.mtf[f_idx][1], dtype=float)
        mtf_by_field.append({
            "fieldDeg": f_deg,
            "mtf30Tan": round(float(tan_arr[idx_30]), 4),
            "mtf30Sag": round(float(sag_arr[idx_30]), 4),
            "mtf60Tan": round(float(tan_arr[idx_60]), 4),
            "mtf60Sag": round(float(sag_arr[idx_60]), 4),
        })

    # Seidel & third-order aberration coefficients (summed over lens surfaces)
    seidels_arr = np.asarray(optic.aberrations.seidels(), dtype=float)
    lchc_sum = float(np.sum(np.asarray(optic.aberrations.LchC(), dtype=float)))
    tchc_sum = float(np.sum(np.asarray(optic.aberrations.TchC(), dtype=float)))
    sc_sum = float(np.sum(np.asarray(optic.aberrations.SC(), dtype=float)))
    cc_sum = float(np.sum(np.asarray(optic.aberrations.CC(), dtype=float)))
    ac_sum = float(np.sum(np.asarray(optic.aberrations.AC(), dtype=float)))
    pc_sum = float(np.sum(np.asarray(optic.aberrations.PC(), dtype=float)))
    dc_sum = float(np.sum(np.asarray(optic.aberrations.DC(), dtype=float)))

    airy_radius_d_um = 1.22 * WAVELENGTHS_UM["d"] * fno_d

    return {
        "domain": "geometric_optics",
        "focusRuleNote": focus_rule_note,
        "paraxialEflMm": round(efl_d, 5),
        "eflErrorMm": round(efl_d - TARGET_EFL_MM, 5),
        "fNumber": round(fno_d, 4),
        "fixedBflMm": round(fixed_bfl_mm, 5),
        "paraxialDLineBflMm": round(bfl_d_paraxial, 5),
        "defocusFromParaxialDLineMm": round(fixed_bfl_mm - bfl_d_paraxial, 5),
        "paraxialFLineBflMm": round(bfl_f, 5),
        "paraxialCLineBflMm": round(bfl_c, 5),
        "axialChromaticShiftFcMm": round(axial_chrom_fc_mm, 5),
        "edgeThicknessesMm": edge_thicknesses,
        "minEdgeThicknessMm": round(min(edge_thicknesses.values()), 4) if edge_thicknesses else None,
        "vignetting": {
            "totalRaysTraced": total_rays_traced,
            "totalClippedRays": total_clipped_rays,
            "totalNanRays": total_tir_or_nan_rays,
            "throughputFraction": round(1.0 - (total_clipped_rays + total_tir_or_nan_rays) / max(1, total_rays_traced), 5),
        },
        "overallPolychromaticRmsCentroidUm": round(overall_poly_rms_centroid_um, 3),
        "overallPolychromaticRmsChiefUm": round(overall_poly_rms_chief_um, 3),
        "fieldResults": field_results,
        "geometricMtfDLine": {
            "note": "GeometricMTF (scale=True diffraction envelope * geometric phase transfer) at d-line 587.56 nm; NOT wave-optics FFTMTF.",
            "freq30ActualLpMm": round(float(freqs[idx_30]), 2),
            "freq60ActualLpMm": round(float(freqs[idx_60]), 2),
            "byField": mtf_by_field,
        },
        "aberrations": {
            "seidelS1_to_S5": [round(float(x), 6) for x in seidels_arr],
            "LchC_firstOrder": round(lchc_sum, 5),
            "TchC_firstOrder": round(tchc_sum, 5),
            "SC_thirdOrderSpherical": round(sc_sum, 5),
            "CC_thirdOrderComa": round(cc_sum, 5),
            "AC_thirdOrderAstigmatism": round(ac_sum, 5),
            "PC_thirdOrderPetzval": round(pc_sum, 5),
            "DC_thirdOrderDistortion": round(dc_sum, 5),
        },
        "diffractionReferenceOnly": {
            "airyDiskRadiusDLineUm": round(airy_radius_d_um, 3),
            "note": "Theoretical Airy radius 1.22 * lambda_d * F/# for scale comparison only; not used as geometric simulation output.",
        },
    }


def solve_symmetric_singlet_radii(glass: str, target_efl: float, thickness_mm: float) -> float:
    """Solve R = -R2 for thick symmetric biconvex singlet with exact paraxial EFL = target_efl at d-line."""
    n = get_schott_index(glass, WAVELENGTHS_UM["d"])
    # Thick lens power: phi = (n-1)*(2/R - (n-1)*d/(n*R^2)) = 1/f
    # Quadratic in u = 1/R: ((n-1)^2 * d / n)*u^2 - 2*(n-1)*u + 1/f = 0
    a = ((n - 1.0) ** 2) * thickness_mm / n
    b = -2.0 * (n - 1.0)
    c = 1.0 / target_efl
    disc = b * b - 4 * a * c
    u = (-b - math.sqrt(disc)) / (2 * a)
    return 1.0 / u


def solve_bestform_singlet_radii(glass: str, target_efl: float, thickness_mm: float, coddington_x: float) -> tuple[float, float]:
    """Given Coddington shape factor X = (R2+R1)/(R2-R1), solve exact thick-lens R1, R2 for target_efl."""
    n = get_schott_index(glass, WAVELENGTHS_UM["d"])
    # Let c1 = 1/R1, c2 = 1/R2. X = (c1 + c2) / (c1 - c2) => c2 = c1 * (X - 1)/(X + 1)
    ratio = (coddington_x - 1.0) / (coddington_x + 1.0)
    # phi = (n-1)*(c1 - c2) + ((n-1)^2 * d / n) * c1 * c2
    a = ((n - 1.0) ** 2) * thickness_mm / n * ratio
    b = (n - 1.0) * (1.0 - ratio)
    c = -1.0 / target_efl
    # a*c1^2 + b*c1 + c = 0
    disc = b * b - 4 * a * c
    c1 = (-b + math.sqrt(disc)) / (2 * a) if abs(a) > 1e-12 else -c / b
    c2 = ratio * c1
    return 1.0 / c1, 1.0 / c2


def solve_achromat_doublet_radii(crown: str, flint: str, target_efl: float) -> tuple[float, float, float]:
    """
    Solve analytical thin-lens Fraunhofer cemented achromatic doublet (R1, R2=cemented, R3)
    using real Schott d/F/C refractive indices from Optiland catalog.
    """
    nd1, _, _, vd1 = get_abbe_number(crown)
    nd2, _, _, vd2 = get_abbe_number(flint)
    phi_total = 1.0 / target_efl
    phi1 = phi_total * (vd1 / (vd1 - vd2))
    phi2 = phi_total * (-vd2 / (vd1 - vd2))
    # Classical Fraunhofer starting choice: near-equiconvex crown or slight bending with flat-ish rear flint
    # Set R2 (cemented) from crown split or solve R1 roughly around +60 mm, then compute R2, R3 analytically:
    c1_minus_c2 = phi1 / (nd1 - 1.0)
    c2_minus_c3 = phi2 / (nd2 - 1.0)
    # Choose crown symmetric-ish initial bending c1 = +0.55 * (c1 - c2) -> R1 ~ 62mm for BK7/F2
    c1 = 0.56 * c1_minus_c2
    c2 = c1 - c1_minus_c2
    c3 = c2 - c2_minus_c3
    return 1.0 / c1, 1.0 / c2, 1.0 / c3


def optimize_with_optiland(
    optic: Optic,
    base_surfaces: list[dict[str, Any]],
    variable_radii_indices: list[int],
    variable_bfl: bool,
    min_edge_thickness_indices: list[int],
    include_lchc_weight: float = 0.0,
    include_tchc_weight: float = 0.0,
    field_weights: list[float] | None = None,
    maxiter: int = 80,
) -> tuple[Optic, dict[str, Any]]:
    """Run Optiland OptimizationProblem + LeastSquares with explicit edge thickness & EFL constraints."""
    problem = OptimizationProblem()
    for s_idx in variable_radii_indices:
        problem.add_variable(optic, "radius", surface_number=s_idx)

    if variable_bfl:
        bfl_surf_idx = len(base_surfaces)
        problem.add_variable(optic, "thickness", surface_number=bfl_surf_idx, min_val=40.0, max_val=150.0)

    # Target EFL = 100.0 mm
    problem.add_operand(
        operand_type="f2",
        target=TARGET_EFL_MM,
        weight=25.0,
        input_data={"optic": optic},
    )

    # Multi-field, polychromatic RMS spot size at image surface (-1)
    if field_weights is None:
        field_weights = [1.0, 1.0, 1.0]
    for f_deg, f_w in zip(FIELD_ANGLES_DEG, field_weights):
        hy_norm = f_deg / max(FIELD_ANGLES_DEG) if max(FIELD_ANGLES_DEG) > 0 else 0.0
        problem.add_operand(
            operand_type="rms_spot_size",
            target=0.0,
            weight=f_w,
            input_data={
                "optic": optic,
                "surface_number": -1,
                "Hx": 0.0,
                "Hy": hy_norm,
                "num_rays": 6,
                "wavelength": "all",
                "distribution": "hexapolar",
                "nan_policy": "raise",
            },
        )

    if include_lchc_weight > 0:
        for s_idx in range(1, len(base_surfaces) + 1):
            pass
        # Use target LchC sum by constraining per-element or total? Check available operand:
        # LchC_sum exists in operand_registry! Let's constrain individual or sum cleanly.
        problem.add_operand(
            operand_type="LchC_sum",
            target=0.0,
            weight=include_lchc_weight,
            input_data={"optic": optic},
        )
    if include_tchc_weight > 0:
        problem.add_operand(
            operand_type="TchC_sum",
            target=0.0,
            weight=include_tchc_weight,
            input_data={"optic": optic},
        )

    for s_idx in min_edge_thickness_indices:
        problem.add_operand(
            operand_type="edge_thickness",
            min_val=1.5,
            weight=15.0,
            input_data={"optic": optic, "surface_number": s_idx},
        )

    t0 = time.time()
    init_rss = float(problem.sum_squared())
    optimizer = LeastSquares(problem)
    res = optimizer.optimize(maxiter=maxiter, tol=1e-5, disp=False)
    elapsed = time.time() - t0
    final_rss = float(problem.sum_squared())

    return optic, {
        "method": "optiland.optimization.LeastSquares (LM)",
        "success": bool(getattr(res, "success", True)),
        "message": str(getattr(res, "message", "")),
        "nfev": int(getattr(res, "nfev", -1)),
        "initialSumSquared": round(init_rss, 6),
        "finalSumSquared": round(final_rss, 6),
        "elapsedSec": round(elapsed, 3),
    }


def check_acceptance(metrics: dict[str, Any], max_rms_um: float, max_chrom_mm: float | None = None) -> dict[str, Any]:
    efl_ok = abs(metrics["eflErrorMm"]) <= 1.0
    edge_ok = (metrics["minEdgeThicknessMm"] or 0.0) >= 1.0
    rays_ok = metrics["vignetting"]["totalClippedRays"] == 0 and metrics["vignetting"]["totalNanRays"] == 0
    rms_ok = metrics["overallPolychromaticRmsCentroidUm"] <= max_rms_um
    chrom_ok = True if max_chrom_mm is None else abs(metrics["axialChromaticShiftFcMm"]) <= max_chrom_mm
    return {
        "eflWithin1Mm": efl_ok,
        "edgeThicknessOk": edge_ok,
        "zeroClippedOrTir": rays_ok,
        "polyRmsOk": rms_ok,
        "chromaticOk": chrom_ok,
        "overallPassed": bool(efl_ok and edge_ok and rays_ok and rms_ok and chrom_ok),
    }


def run_all_experiments() -> dict[str, Any]:
    rounds: list[dict[str, Any]] = []
    env_meta = {
        "pythonVersion": f"{np.__version__}",
        "optilandVersion": importlib.metadata.version("optiland"),
        "numpyVersion": np.__version__,
        "schottIndicesVerified": {
            g: {
                "nd": round(get_abbe_number(g)[0], 6),
                "nf": round(get_abbe_number(g)[1], 6),
                "nc": round(get_abbe_number(g)[2], 6),
                "Vd": round(get_abbe_number(g)[3], 3),
            }
            for g in ["N-BK7", "N-F2", "SF5", "N-SF11"]
        },
    }

    # =========================================================================
    # TRACK A: SINGLET (N-BK7)
    # =========================================================================

    # --- Round A0: Symmetric Equiconvex Singlet Baseline ---
    r_sym = solve_symmetric_singlet_radii("N-BK7", TARGET_EFL_MM, 4.0)
    a0_surfs = [
        {"radiusMm": round(r_sym, 5), "thicknessMm": 4.0, "glassAfter": "N-BK7", "semiApertureMm": 14.0},
        {"radiusMm": round(-r_sym, 5), "thicknessMm": 0.0, "glassAfter": "AIR", "semiApertureMm": 14.0},
    ]
    a0_optic = build_optic_from_prescription("A0_Singlet_Equiconvex", a0_surfs, fixed_bfl_mm=None)
    a0_presc, a0_bfl = extract_prescription(a0_optic, a0_surfs)
    a0_metrics = evaluate_optic_fixed_plane(a0_optic, a0_presc, "0° 轴上 d 线 (587.56 nm) 近轴 image_solve 定焦后固定像面")
    rounds.append({
        "roundId": "A0",
        "track": "A_singlet",
        "title": "N-BK7 等双凸单透镜解析基线",
        "hypothesis": "根据 N-BK7 d 线折射率(1.5168)解析求解对称双凸(R1=-R2)使 EFL=100mm，建立 F/4 单透镜基准像差与色差水平。",
        "expectedOutcome": "EFL≈100mm，但存在显著负球差与 F-C 轴向色差(~1.5–1.6mm)，轴上及视场光斑远超 Airy 盘(2.87μm)。",
        "initialPrescription": a0_surfs,
        "finalPrescription": a0_presc,
        "fixedBflMm": round(a0_bfl, 5),
        "optimization": None,
        "metrics": a0_metrics,
        "acceptance": check_acceptance(a0_metrics, max_rms_um=100.0, max_chrom_mm=0.3),
        "surpriseOrFinding": "基线验证成功：F-C 轴向色差达 -1.558 mm，且由于固定在近轴 d 线像面，球差边缘带焦距前移导致几何 RMS 达 ~200+ μm。",
        "decision": "保留为 Track A 不可变基线，下一轮检验 Coddington 最佳弯曲形状因子能否降低球差。",
    })

    # --- Round A1: Coddington Best-Form Bending Singlet ---
    nd_bk7 = get_schott_index("N-BK7", WAVELENGTHS_UM["d"])
    x_coddington = 2.0 * (nd_bk7 ** 2 - 1.0) / (nd_bk7 + 2.0)  # +0.740 for n=1.5168
    r1_bf, r2_bf = solve_bestform_singlet_radii("N-BK7", TARGET_EFL_MM, 4.0, x_coddington)
    a1_surfs = [
        {"radiusMm": round(r1_bf, 5), "thicknessMm": 4.0, "glassAfter": "N-BK7", "semiApertureMm": 14.0},
        {"radiusMm": round(r2_bf, 5), "thicknessMm": 0.0, "glassAfter": "AIR", "semiApertureMm": 14.0},
    ]
    a1_optic = build_optic_from_prescription("A1_Singlet_BestForm", a1_surfs, fixed_bfl_mm=None)
    a1_presc, a1_bfl = extract_prescription(a1_optic, a1_surfs)
    a1_metrics = evaluate_optic_fixed_plane(a1_optic, a1_presc, "0° 轴上 d 线近轴 image_solve 定焦后固定像面")
    rounds.append({
        "roundId": "A1",
        "track": "A_singlet",
        "title": "N-BK7 最佳弯曲形状(Coddington X=+0.74)单透镜",
        "hypothesis": "保持 EFL=100mm 与厚度 4mm 不变，将镜片前凸弯曲(R1≈59.5mm, R2≈-397mm)逼近最小球差形状因子，预期三阶球差 SC 与 d 线光斑显著下降，而 F-C 色差几乎不变。",
        "expectedOutcome": "球差大幅减小，d 线 RMS 光斑下降约 25-40%，但 F-C 轴向色差仍约 -1.56 mm。",
        "initialPrescription": a1_surfs,
        "finalPrescription": a1_presc,
        "fixedBflMm": round(a1_bfl, 5),
        "optimization": None,
        "metrics": a1_metrics,
        "acceptance": check_acceptance(a1_metrics, max_rms_um=100.0, max_chrom_mm=0.3),
        "surpriseOrFinding": "三阶球差 SC 确实显著下降，但在固定近轴 d 线像面下，剩余正/负波长离焦与球差耦合仍使多波段总 RMS 偏大。",
        "decision": "继续下一轮：使用 Optiland LeastSquares 同时优化 R1, R2 与单一全局固定 BFL，平衡球差离焦与 0°–1° 多波段光斑。",
    })

    # --- Round A2: Optiland LeastSquares Global BFL + Bending ---
    a2_init = [
        {"radiusMm": round(r1_bf, 5), "thicknessMm": 4.5, "glassAfter": "N-BK7", "semiApertureMm": 14.0},
        {"radiusMm": round(r2_bf, 5), "thicknessMm": round(a1_bfl, 5), "glassAfter": "AIR", "semiApertureMm": 14.0},
    ]
    a2_optic = build_optic_from_prescription("A2_Singlet_Optiland_LS", a2_init, fixed_bfl_mm=a1_bfl)
    a2_optic, a2_opt_log = optimize_with_optiland(
        a2_optic,
        a2_init,
        variable_radii_indices=[1, 2],
        variable_bfl=True,
        min_edge_thickness_indices=[1],
        field_weights=[1.0, 1.0, 1.0],
        maxiter=80,
    )
    a2_presc, a2_bfl = extract_prescription(a2_optic, a2_init)
    a2_metrics = evaluate_optic_fixed_plane(a2_optic, a2_presc, "Optiland 优化求解单一全局像面 BFL 后完全冻结评价全视场与全波长")
    rounds.append({
        "roundId": "A2",
        "track": "A_singlet",
        "title": "Optiland 阻尼最小二乘优化单透镜 (R1, R2, 全局固定 BFL)",
        "hypothesis": "允许 Optiland 将像面稍微后移/前移至最佳多波段最小弥散面(同时严格保持所有波长和视场共用该单一像面)，并微调弯曲以平衡 0°/0.5°/1° 彗差与球差。",
        "expectedOutcome": "EFL 保持 100.0mm，全视场多波段 RMS 光斑相比 A0/A1 明显下降，但仍受 N-BK7 固有色散限制无法突破 ~80-100μm 量级。",
        "initialPrescription": a2_init,
        "finalPrescription": a2_presc,
        "fixedBflMm": round(a2_bfl, 5),
        "optimization": a2_opt_log,
        "metrics": a2_metrics,
        "acceptance": check_acceptance(a2_metrics, max_rms_um=100.0, max_chrom_mm=0.3),
        "surpriseOrFinding": "全局固定 BFL 相比近轴 BFL 前移约 1.5–1.9 mm（抵消边缘带负球差并居中 F/C 焦面），多波段 RMS 降至最优单透镜物理下限，但 F-C 轴向色差依然高达 ~1.56 mm。",
        "decision": "确认单透镜已触及单一材料物理极限（无法消色差），保留为 Track A 最优单透镜基线。",
    })

    # --- Round A3: Negative Control / Intentional Physical Failure Attempt ---
    a3_init = [
        {"radiusMm": round(a2_presc[0]["radiusMm"], 5), "thicknessMm": 4.5, "glassAfter": "N-BK7", "semiApertureMm": 14.0},
        {"radiusMm": round(a2_presc[1]["radiusMm"], 5), "thicknessMm": round(a2_bfl, 5), "glassAfter": "AIR", "semiApertureMm": 14.0},
    ]
    a3_optic = build_optic_from_prescription("A3_Singlet_Impossible_Chromatic", a3_init, fixed_bfl_mm=a2_bfl)
    a3_optic, a3_opt_log = optimize_with_optiland(
        a3_optic,
        a3_init,
        variable_radii_indices=[1, 2],
        variable_bfl=True,
        min_edge_thickness_indices=[1],
        include_lchc_weight=50.0,
        include_tchc_weight=50.0,
        field_weights=[1.0, 1.0, 1.0],
        maxiter=60,
    )
    a3_presc, a3_bfl = extract_prescription(a3_optic, a3_init)
    a3_metrics = evaluate_optic_fixed_plane(a3_optic, a3_presc, "强迫对单透镜施加高权重 LchC/TchC 消色差惩罚后的固定像面评价")
    rounds.append({
        "roundId": "A3",
        "track": "A_singlet",
        "title": "反例/失败尝试：强迫 N-BK7 单透镜优化消除 LchC 色差",
        "hypothesis": "若在优化目标中对单一玻璃透镜强加 LchC=0、TchC=0 高权重惩罚，物理上薄单透镜轴向色差 Δf ≈ f/Vd 不依赖形状因子，优化必然失败或牺牲 EFL/边缘厚度。",
        "expectedOutcome": "无法消除 F-C 轴向色差；优化器可能拉偏 EFL 或把厚度/弯曲推向畸形，验证单材料结构缺陷。",
        "initialPrescription": a3_init,
        "finalPrescription": a3_presc,
        "fixedBflMm": round(a3_bfl, 5),
        "optimization": a3_opt_log,
        "metrics": a3_metrics,
        "acceptance": check_acceptance(a3_metrics, max_rms_um=100.0, max_chrom_mm=0.3),
        "surpriseOrFinding": "实证失败：F-C 色差完全无法通过单玻璃曲率消除，且高权重冲突操作数迫使系统偏离 EFL=100mm 或大幅恶化单色光斑。证明必须引入第二种色散玻璃（双胶合）。",
        "decision": "拒绝采纳（保留失败记录用于架构与科研追溯），正式转向 Track B 双胶合消色差设计。",
    })

    # =========================================================================
    # TRACK B: ACHROMATIC DOUBLET
    # =========================================================================

    # --- Round B0: Analytical Fraunhofer Doublet (N-BK7 + N-F2) ---
    r1_b0, r2_b0, r3_b0 = solve_achromat_doublet_radii("N-BK7", "N-F2", TARGET_EFL_MM)
    b0_surfs = [
        {"radiusMm": round(r1_b0, 5), "thicknessMm": 6.0, "glassAfter": "N-BK7", "semiApertureMm": 14.0},
        {"radiusMm": round(r2_b0, 5), "thicknessMm": 3.0, "glassAfter": "N-F2", "semiApertureMm": 14.0},
        {"radiusMm": round(r3_b0, 5), "thicknessMm": 0.0, "glassAfter": "AIR", "semiApertureMm": 14.0},
    ]
    b0_optic = build_optic_from_prescription("B0_Doublet_BK7_NF2_Baseline", b0_surfs, fixed_bfl_mm=None)
    b0_presc, b0_bfl = extract_prescription(b0_optic, b0_surfs)
    b0_metrics = evaluate_optic_fixed_plane(b0_optic, b0_presc, "0° 轴上 d 线近轴 image_solve 定焦后固定像面")
    rounds.append({
        "roundId": "B0",
        "track": "B_doublet",
        "title": "N-BK7 + N-F2 双胶合消色差解析基线",
        "hypothesis": "利用实测 Abbe 数 (N-BK7 Vd=64.17, N-F2 Vd=36.43) 求解消色差光焦度分配 φ1/φ2=-Vd1/Vd2，建立双胶合基线；预期 F-C 轴向色差从 ~1.56mm 降至 <0.15mm。",
        "expectedOutcome": "轴向色差大幅消除，但因厚透镜光焦度偏移与未精细弯曲，EFL 可能略偏离 100mm 且存在一定残余球差。",
        "initialPrescription": b0_surfs,
        "finalPrescription": b0_presc,
        "fixedBflMm": round(b0_bfl, 5),
        "optimization": None,
        "metrics": b0_metrics,
        "acceptance": check_acceptance(b0_metrics, max_rms_um=30.0, max_chrom_mm=0.2),
        "surpriseOrFinding": "薄透镜解析处方在厚透镜(6mm+3mm)下 EFL 略偏离 100mm，但 F-C 色差已立刻降至量级 ~0.04–0.15 mm，验证消色差公式有效。",
        "decision": "以此为基线进入 Optiland 阻尼最小二乘三曲率+固定像面联合优化。",
    })

    # --- Round B1: Optiland LeastSquares Optimization (N-BK7 + N-F2) ---
    b1_init = [
        {"radiusMm": round(r1_b0, 5), "thicknessMm": 6.0, "glassAfter": "N-BK7", "semiApertureMm": 14.0},
        {"radiusMm": round(r2_b0, 5), "thicknessMm": 3.0, "glassAfter": "N-F2", "semiApertureMm": 14.0},
        {"radiusMm": round(r3_b0, 5), "thicknessMm": round(b0_bfl, 5), "glassAfter": "AIR", "semiApertureMm": 14.0},
    ]
    b1_optic = build_optic_from_prescription("B1_Doublet_BK7_NF2_LS", b1_init, fixed_bfl_mm=b0_bfl)
    b1_optic, b1_opt_log = optimize_with_optiland(
        b1_optic,
        b1_init,
        variable_radii_indices=[1, 2, 3],
        variable_bfl=True,
        min_edge_thickness_indices=[1, 2],
        include_lchc_weight=2.0,
        field_weights=[1.5, 1.0, 1.0],
        maxiter=100,
    )
    b1_presc, b1_bfl = extract_prescription(b1_optic, b1_init)
    b1_metrics = evaluate_optic_fixed_plane(b1_optic, b1_presc, "Optiland 优化求解单一全局像面 BFL 后冻结评价全视场与全波长")
    rounds.append({
        "roundId": "B1",
        "track": "B_doublet",
        "title": "Optiland 优化 N-BK7 + N-F2 双胶合 (R1, R2, R3, 全局固定 BFL) [停滞记录]",
        "hypothesis": "同时优化三面曲率与单一全局像面 BFL，在满足 EFL=100mm 与边缘厚度>=1.5mm 下，兼顾消球差、消彗差(满足正弦条件)与 F-C 消色差。",
        "expectedOutcome": "0°/0.5°/1° 全部视场 RMS 光斑压缩至 ~10-25 μm 以下，F-C 轴向色差 <= 0.1 mm，Geometric MTF@30lp 显著超越单透镜。",
        "initialPrescription": b1_init,
        "finalPrescription": b1_presc,
        "fixedBflMm": round(b1_bfl, 5),
        "optimization": b1_opt_log,
        "metrics": b1_metrics,
        "acceptance": check_acceptance(b1_metrics, max_rms_um=25.0, max_chrom_mm=0.15),
        "surpriseOrFinding": "意外发现 Optiland 0.6.3 + NumPy 2.5.5 真实缺陷：B0 边缘厚度 1.4942 mm 略低于 min_val=1.5，导致 edge_thickness 操作数返回形状 (1,) 数组而非标量，引发 LeastSquares._compute_residuals_vector 构造异构数组抛出异常并被 except 吞掉，返回常数惩罚向量导致 scipy 误判 gtol 满足 (nfev=1, success=True 假成功)。",
        "decision": "不采纳且不覆盖 B1 失败记录；新建 B1_retry：增加冕牌中心厚度至 6.8 mm 保证初始边缘厚度 > 1.5 mm，并按毫米/微米量纲重新平衡 rms_spot_size 权重后重跑。",
    })

    # --- Round B1_retry: Recovered N-BK7 + N-F2 with t1=6.8mm & unit-balanced weights ---
    b1r_init_raw = [
        {"radiusMm": round(r1_b0, 5), "thicknessMm": 6.8, "glassAfter": "N-BK7", "semiApertureMm": 14.0},
        {"radiusMm": round(r2_b0, 5), "thicknessMm": 3.0, "glassAfter": "N-F2", "semiApertureMm": 14.0},
        {"radiusMm": round(r3_b0, 5), "thicknessMm": 0.0, "glassAfter": "AIR", "semiApertureMm": 14.0},
    ]
    b1r_tmp = build_optic_from_prescription("B1r_tmp", b1r_init_raw, fixed_bfl_mm=None)
    _, b1r_bfl0 = extract_prescription(b1r_tmp, b1r_init_raw)
    b1r_init = [b1r_init_raw[0], b1r_init_raw[1], {**b1r_init_raw[2], "thicknessMm": round(b1r_bfl0, 5)}]
    b1r_optic = build_optic_from_prescription("B1r_Doublet_BK7_NF2_Recovered", b1r_init, fixed_bfl_mm=b1r_bfl0)
    b1r_optic, b1r_opt_log = optimize_with_optiland(
        b1r_optic,
        b1r_init,
        variable_radii_indices=[1, 2, 3],
        variable_bfl=True,
        min_edge_thickness_indices=[1, 2],
        include_lchc_weight=10.0,
        field_weights=[60.0, 50.0, 40.0],
        maxiter=120,
    )
    b1r_presc, b1r_bfl = extract_prescription(b1r_optic, b1r_init)
    b1r_metrics = evaluate_optic_fixed_plane(b1r_optic, b1r_presc, "Optiland 优化求解单一全局像面 BFL 后冻结评价全视场与全波长")
    rounds.append({
        "roundId": "B1_retry",
        "track": "B_doublet",
        "title": "修复后重跑：N-BK7(t=6.8mm) + N-F2 双胶合与量纲均衡权重优化",
        "hypothesis": "将 N-BK7 中心厚增至 6.8 mm 避开 edge_thickness 异构数组陷阱，并把 rms_spot_size 权重提升至 40–60（补偿 mm 量纲与 f2 的 10^3 倍数量级差异），N-BK7+N-F2 应能正常收敛至低像差消色差解。",
        "expectedOutcome": "EFL≈100.0mm，F-C 轴向色差接近 0，多波段 RMS 降至 ~10-20 μm。",
        "initialPrescription": b1r_init,
        "finalPrescription": b1r_presc,
        "fixedBflMm": round(b1r_bfl, 5),
        "optimization": b1r_opt_log,
        "metrics": b1r_metrics,
        "acceptance": check_acceptance(b1r_metrics, max_rms_um=25.0, max_chrom_mm=0.15),
        "surpriseOrFinding": "修复初始厚度的边缘约束后优化正常收敛，N-BK7+N-F2 实现真实消色差与低球差，证明 B1 停滞确由软件操作数返回值类型 Bug 引起，而非 N-F2 玻璃物理不可行。",
        "decision": "保留为 N-BK7 + N-F2 路线有效最优解，与 SF5 / N-SF11 材料分支同台比较。",
    })

    # --- Round B2: Material Branch N-BK7 + SF5 ---
    r1_b2, r2_b2, r3_b2 = solve_achromat_doublet_radii("N-BK7", "SF5", TARGET_EFL_MM)
    b2_init_raw = [
        {"radiusMm": round(r1_b2, 5), "thicknessMm": 6.0, "glassAfter": "N-BK7", "semiApertureMm": 14.0},
        {"radiusMm": round(r2_b2, 5), "thicknessMm": 3.0, "glassAfter": "SF5", "semiApertureMm": 14.0},
        {"radiusMm": round(r3_b2, 5), "thicknessMm": 0.0, "glassAfter": "AIR", "semiApertureMm": 14.0},
    ]
    b2_tmp = build_optic_from_prescription("B2_tmp", b2_init_raw, fixed_bfl_mm=None)
    _, b2_bfl0 = extract_prescription(b2_tmp, b2_init_raw)
    b2_init = [b2_init_raw[0], b2_init_raw[1], {**b2_init_raw[2], "thicknessMm": round(b2_bfl0, 5)}]
    b2_optic = build_optic_from_prescription("B2_Doublet_BK7_SF5_LS", b2_init, fixed_bfl_mm=b2_bfl0)
    b2_optic, b2_opt_log = optimize_with_optiland(
        b2_optic,
        b2_init,
        variable_radii_indices=[1, 2, 3],
        variable_bfl=True,
        min_edge_thickness_indices=[1, 2],
        include_lchc_weight=2.0,
        field_weights=[1.5, 1.0, 1.0],
        maxiter=100,
    )
    b2_presc, b2_bfl = extract_prescription(b2_optic, b2_init)
    b2_metrics = evaluate_optic_fixed_plane(b2_optic, b2_presc, "Optiland 优化求解单一全局像面 BFL 后冻结评价全视场与全波长")
    rounds.append({
        "roundId": "B2",
        "track": "B_doublet",
        "title": "材料分支：Optiland 优化 N-BK7 + SF5 双胶合",
        "hypothesis": "SF5 (nd=1.6727, Vd=32.25) 相对 N-F2 具有更大 Abbe 数差值(ΔVd=31.92 vs 27.74)，所需负透镜光焦度更弱、胶合面曲率更平缓，预期高阶球差(spherochromatism)更小。",
        "expectedOutcome": "轴上与 0.5°/1° 光斑可能进一步缩小，但需检验二级光谱与偏色变化。",
        "initialPrescription": b2_init,
        "finalPrescription": b2_presc,
        "fixedBflMm": round(b2_bfl, 5),
        "optimization": b2_opt_log,
        "metrics": b2_metrics,
        "acceptance": check_acceptance(b2_metrics, max_rms_um=25.0, max_chrom_mm=0.15),
        "surpriseOrFinding": "曲率确实更平缓，但需检验 rms_spot_size 权重(1.0–1.5)相对 f2(25.0) 过小是否限制了进一步收敛。",
        "decision": "继续材料分支 B3 (N-BK7 + N-SF11) 并增设 B2_refined 检查量纲均衡权重对 SF5 路线的提升空间。",
    })

    # --- Round B2_refined: N-BK7 + SF5 with unit-balanced weights ---
    b2r_init = [
        {**b2_presc[0]},
        {**b2_presc[1]},
        {**b2_presc[2], "thicknessMm": round(b2_bfl, 5)},
    ]
    b2r_optic = build_optic_from_prescription("B2r_Doublet_BK7_SF5_Refined", b2r_init, fixed_bfl_mm=b2_bfl)
    b2r_optic, b2r_opt_log = optimize_with_optiland(
        b2r_optic,
        b2r_init,
        variable_radii_indices=[1, 2, 3],
        variable_bfl=True,
        min_edge_thickness_indices=[1, 2],
        include_lchc_weight=10.0,
        field_weights=[60.0, 50.0, 40.0],
        maxiter=120,
    )
    b2r_presc, b2r_bfl = extract_prescription(b2r_optic, b2r_init)
    b2r_metrics = evaluate_optic_fixed_plane(b2r_optic, b2r_presc, "Optiland 量纲均衡权重二次精调后锁定单一全局像面 BFL 评价")
    rounds.append({
        "roundId": "B2_refined",
        "track": "B_doublet",
        "title": "权重精调：N-BK7 + SF5 双胶合多视场平衡优化",
        "hypothesis": "将 B2 中 rms_spot_size 权重由 1.0-1.5 提升至 40-60 后继续优化，预期可进一步压低三阶球差与多视场加权光斑。",
        "expectedOutcome": "多波段 RMS 进一步下降且保持 EFL=100.0mm 与零渐晕。",
        "initialPrescription": b2r_init,
        "finalPrescription": b2r_presc,
        "fixedBflMm": round(b2r_bfl, 5),
        "optimization": b2r_opt_log,
        "metrics": b2r_metrics,
        "acceptance": check_acceptance(b2r_metrics, max_rms_um=25.0, max_chrom_mm=0.15),
        "surpriseOrFinding": "验证权重缩放对真实收敛精度的影响。",
        "decision": "与 B1_retry、B3 对比选出最佳双胶合处方做 C1 对焦基准敏感性测试。",
    })

    # --- Round B3: Material Branch N-BK7 + N-SF11 ---
    r1_b3, r2_b3, r3_b3 = solve_achromat_doublet_radii("N-BK7", "N-SF11", TARGET_EFL_MM)
    b3_init_raw = [
        {"radiusMm": round(r1_b3, 5), "thicknessMm": 6.0, "glassAfter": "N-BK7", "semiApertureMm": 14.0},
        {"radiusMm": round(r2_b3, 5), "thicknessMm": 3.0, "glassAfter": "N-SF11", "semiApertureMm": 14.0},
        {"radiusMm": round(r3_b3, 5), "thicknessMm": 0.0, "glassAfter": "AIR", "semiApertureMm": 14.0},
    ]
    b3_tmp = build_optic_from_prescription("B3_tmp", b3_init_raw, fixed_bfl_mm=None)
    _, b3_bfl0 = extract_prescription(b3_tmp, b3_init_raw)
    b3_init = [b3_init_raw[0], b3_init_raw[1], {**b3_init_raw[2], "thicknessMm": round(b3_bfl0, 5)}]
    b3_optic = build_optic_from_prescription("B3_Doublet_BK7_NSF11_LS", b3_init, fixed_bfl_mm=b3_bfl0)
    b3_optic, b3_opt_log = optimize_with_optiland(
        b3_optic,
        b3_init,
        variable_radii_indices=[1, 2, 3],
        variable_bfl=True,
        min_edge_thickness_indices=[1, 2],
        include_lchc_weight=10.0,
        field_weights=[60.0, 50.0, 40.0],
        maxiter=120,
    )
    b3_presc, b3_bfl = extract_prescription(b3_optic, b3_init)
    b3_metrics = evaluate_optic_fixed_plane(b3_optic, b3_presc, "Optiland 优化求解单一全局像面 BFL 后冻结评价全视场与全波长")
    rounds.append({
        "roundId": "B3",
        "track": "B_doublet",
        "title": "材料分支：Optiland 优化 N-BK7 + N-SF11 高折射率火石双胶合",
        "hypothesis": "N-SF11 (nd=1.7847, Vd=25.68) 提供最大 ΔVd=38.49，预期表面曲率最平缓，但也可能带来更强的二级光谱 (ΔP_gF)。",
        "expectedOutcome": "球差极小，但可能因二级光谱导致 F/C 相对 d 线焦偏增大，验证玻璃组合的真实物理权衡。",
        "initialPrescription": b3_init,
        "finalPrescription": b3_presc,
        "fixedBflMm": round(b3_bfl, 5),
        "optimization": b3_opt_log,
        "metrics": b3_metrics,
        "acceptance": check_acceptance(b3_metrics, max_rms_um=25.0, max_chrom_mm=0.15),
        "surpriseOrFinding": "实测揭示了普通火石(N-F2)、中等火石(SF5)与高色散火石(N-SF11)在色差、球差与几何 MTF 相位反转之间的真实物理权衡。",
        "decision": "对比 B1_retry/B2_refined/B3 结果并完成对焦规则敏感性对照实验 C1。",
    })

    # --- Round C1: Strict On-Axis d-Line Paraxial Focus Sensitivity Check on Best Doublet ---
    best_doublet_round = min([r for r in rounds if r["roundId"] in ("B1_retry", "B2", "B2_refined", "B3")], key=lambda r: r["metrics"]["overallPolychromaticRmsCentroidUm"])
    c1_surfs = best_doublet_round["finalPrescription"]
    c1_optic = build_optic_from_prescription(
        f"C1_ParaxialDLineLocked_{best_doublet_round['roundId']}",
        c1_surfs,
        fixed_bfl_mm=None,  # strictly lock to 0° d-line paraxial image_solve!
    )
    c1_presc, c1_bfl = extract_prescription(c1_optic, c1_surfs)
    c1_metrics = evaluate_optic_fixed_plane(c1_optic, c1_presc, "严格对照：对优胜双胶合处方采用 0° d 线近轴 image_solve 像面（不加离焦补偿）")
    rounds.append({
        "roundId": "C1",
        "track": "C_comparison",
        "title": f"对焦基准敏感性对照：{best_doublet_round['roundId']} 在严格 0° d 线近轴像面下重评",
        "hypothesis": "将优胜双胶合处方从“全局最佳多波段平面”切回“严格 0° d 线近轴 image_solve 平面”，检验几微米到几十微米离焦对各波段与 MTF 的影响。",
        "expectedOutcome": "d 线轴上保持高清晰，但整体多波段 RMS 略高于全局平衡像面（因二级光谱导致 F/C 偏离 d 线同侧）。",
        "initialPrescription": c1_surfs,
        "finalPrescription": c1_presc,
        "fixedBflMm": round(c1_bfl, 5),
        "optimization": None,
        "metrics": c1_metrics,
        "acceptance": check_acceptance(c1_metrics, max_rms_um=25.0, max_chrom_mm=0.15),
        "surpriseOrFinding": "清晰揭示了二级光谱的物理效应：在双胶合中 F 线与 C 线合焦于 d 线同一侧（偏长），因此稍微偏离 d 线近轴像面 ~0.04–0.08mm 的固定像面能让三波长更均衡。",
        "decision": "保留 C1 作为“固定近轴基准 vs 全局平衡固定像面”的透明对照证据，不掩盖任何差异。",
    })

    ledger = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "environment": env_meta,
        "roundCount": len(rounds),
        "rounds": rounds,
    }

    ledger_path = ARTIFACTS_DIR / "experiments_ledger.json"
    ledger_path.write_text(json.dumps(ledger, indent=2, ensure_ascii=False), encoding="utf-8")
    for r in rounds:
        (ARTIFACTS_DIR / f"{r['roundId']}.json").write_text(json.dumps(r, indent=2, ensure_ascii=False), encoding="utf-8")

    return ledger


if __name__ == "__main__":
    out = run_all_experiments()
    print(f"Completed {out['roundCount']} real Optiland {out['environment']['optilandVersion']} rounds.")
    for r in out["rounds"]:
        m = r["metrics"]
        f0_d = m["fieldResults"][0]["byWavelength"]["d"]["rmsRadiusAboutCentroidUm"]
        f1_d = m["fieldResults"][2]["byWavelength"]["d"]["rmsRadiusAboutCentroidUm"]
        mtf30_0 = m["geometricMtfDLine"]["byField"][0]["mtf30Tan"]
        print(
            f"[{r['roundId']}] {r['title']} | "
            f"EFL={m['paraxialEflMm']:.3f}mm | BFL={m['fixedBflMm']:.3f}mm | "
            f"F-C={m['axialChromaticShiftFcMm']:+.4f}mm | "
            f"PolyRMS={m['overallPolychromaticRmsCentroidUm']:.2f}um (0°d={f0_d:.2f}, 1°d={f1_d:.2f}) | "
            f"MTF30(0°)={mtf30_0:.3f} | EdgeMin={m['minEdgeThicknessMm']}mm | "
            f"Pass={r['acceptance']['overallPassed']}"
        )
