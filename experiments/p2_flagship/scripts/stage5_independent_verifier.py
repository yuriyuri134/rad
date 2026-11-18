import glob
import json
import math
import os
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from wf_rc_models import (
    D_M1_M2_BASE,
    K1_RC,
    K2_RC,
    PIXEL_PITCH_UM,
    R1_BASE,
    R2_BASE,
    WLS_UM,
    build_rc_corrector,
    get_material,
)

RUNS_DIR = "experiments/p2_flagship/runs"


def abcd_paraxial_efl_bfl(surfaces):
    """
    Pure NumPy 2x2 paraxial ABCD matrix trace across coaxial reflective + refractive surfaces.
    surfaces: list of (radius_mm_or_None, thickness_after_mm, n_before, n_after)
    State vector: [y, n * u] (reduced angle), sign convention:
      refraction/reflection power phi = (n_after - n_before) / R (with n -> -n on reflection, or
      equivalently with positive optical path distance |t| and alternating n sign on reflection!).
    Using standard optical sign-reversal reflection convention:
      At a mirror in air (n_in = +1), n_out = -1, thickness t_after < 0 so t/n > 0!
      Wait: let's track n_signed directly across every surface and thickness t_signed!
      Refraction/reflection matrix (for [y, n*u]):
        P = [[1, 0], [-(n_out - n_in)/R, 1]]  -> wait: n'*u' = n*u - y*(n'-n)/R!
      Transfer matrix:
        T = [[1, t / n_out], [0, 1]] -> y_next = y + t * u' = y + (t / n_out) * (n_out * u')!
    """
    M = np.eye(2, dtype=np.float64)
    for r_mm, t_mm, n_in, n_out in surfaces:
        phi = 0.0 if (r_mm is None or not np.isfinite(r_mm)) else (n_out - n_in) / r_mm
        P = np.array([[1.0, 0.0], [-phi, 1.0]], dtype=np.float64)
        M = P @ M
        if t_mm is not None:
            T = np.array([[1.0, t_mm / n_out], [0.0, 1.0]], dtype=np.float64)
            M = T @ M
    # System matrix from M1 to last surface vertex (with t_mm=None on last surface):
    # Wait: if last transfer is excluded, M = [[A, B], [C, D]] maps [y1, n1*u1] -> [y_last, n_last*u_last]
    # Collimated input u1 = 0 => y_last = A * y1, n_last * u_last = C * y1
    # Effective focal length EFL = -1 / C (for n_in=1, n_final=1 after even reflections)
    # BFL = -A / C
    A, B = M[0, 0], M[0, 1]
    C, D = M[1, 0], M[1, 1]
    efl = -1.0 / C
    bfl = -A / C
    return float(efl), float(bfl)


def verify_abcd_for_branch(branch_json_path):
    with open(branch_json_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)

    wl = 0.55
    n_sign = 1.0
    surfs = [
        (R1_BASE, -D_M1_M2_BASE, 1.0, -1.0),
        (R2_BASE, D_M1_M2_BASE + data["d_m1_l1_mm"], -1.0, 1.0),
    ]
    n_prev = 1.0
    for idx, l in enumerate(data["lenses"]):
        n_glass = float(np.ravel(get_material(l["material"]).n(wl))[0])
        surfs.append((l["r1_mm"], l["tc_mm"], n_prev, n_glass))
        t_after = None if idx == len(data["lenses"]) - 1 else l["gap_after_mm"]
        surfs.append((l["r2_mm"], t_after, n_glass, 1.0))
        n_prev = 1.0

    abcd_efl, abcd_bfl = abcd_paraxial_efl_bfl(surfs)
    opt_efl = data["metrics"]["efl_mm"]
    opt_bfl = data["bfl_mm"]
    return {
        "branch_id": data["branch_id"],
        "abcd_efl_mm": round(abcd_efl, 4),
        "optiland_efl_mm": opt_efl,
        "efl_diff_mm": round(abs(abcd_efl - opt_efl), 4),
        "abcd_paraxial_bfl_mm": round(abcd_bfl, 4),
        "optimized_bfl_mm": opt_bfl,
        "defocus_from_paraxial_mm": round(opt_bfl - abcd_bfl, 4),
    }


def verify_rc_analytical():
    surfs_s0 = [
        (R1_BASE, -D_M1_M2_BASE, 1.0, -1.0),
        (R2_BASE, None, -1.0, 1.0),
    ]
    efl, bfl_from_m2 = abcd_paraxial_efl_bfl(surfs_s0)
    s0 = build_rc_corrector([], d_m1_l1=450.0, bfl=0.0, apply_obsc=False)
    seidels = [float(np.ravel(v)[0]) for v in s0.aberrations.seidels()]
    return {
        "abcd_s0_efl_mm": round(efl, 6),
        "abcd_s0_bfl_from_m2_mm": round(bfl_from_m2, 6),
        "expected_bfl_from_m2_mm": round(D_M1_M2_BASE + 450.0, 6),
        "seidel_SI": round(seidels[0], 10),
        "seidel_SII": round(seidels[1], 10),
    }


def verify_fits_outputs():
    fits_files = sorted(glob.glob("experiments/p2_flagship/runs/fits/*.fits"))
    checks = []
    for fp in fits_files:
        with fits.open(fp) as hdul:
            hdr = hdul[0].header
            data = hdul[0].data
            w = WCS(hdr)
            pix_scale_as = abs(hdr["CDELT1"]) * 3600.0
            checks.append(
                {
                    "file": os.path.basename(fp),
                    "shape": list(data.shape),
                    "ctype": list(w.wcs.ctype),
                    "pix_scale_arcsec": round(float(pix_scale_as), 4),
                    "finite_all": bool(np.all(np.isfinite(data))),
                    "min_adu": round(float(np.min(data)), 2),
                    "max_adu": round(float(np.max(data)), 2),
                }
            )
    return checks


def main():
    abcd_checks = []
    for k in ["S1", "S2", "S3", "S4"]:
        p = os.path.join(RUNS_DIR, f"branch_{k}.json")
        if os.path.exists(p):
            abcd_checks.append(verify_abcd_for_branch(p))

    report = {
        "rc_analytical_and_abcd_check": verify_rc_analytical(),
        "corrector_abcd_cross_checks": abcd_checks,
        "fits_header_and_wcs_audit": verify_fits_outputs(),
    }
    out_path = os.path.join(RUNS_DIR, "stage5_independent_verification.json")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)
    print(json.dumps(report, indent=2, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
