#!/usr/bin/env python3
"""Independent unit tests for verify_physics.py pure-NumPy optical formulas."""

import math
import unittest

from experiments.p1_optics.verify_physics import (
    paraxial_efl_bfl,
    refractive_index,
    sphere_sag,
    trace_3d_ray,
)


class TestIndependentPhysics(unittest.TestCase):
    def test_n_bk7_abbe_number(self):
        nd = refractive_index("N-BK7", 0.58756)
        nf = refractive_index("N-BK7", 0.48613)
        nc = refractive_index("N-BK7", 0.65627)
        vd = (nd - 1.0) / (nf - nc)
        self.assertAlmostEqual(nd, 1.51680, places=4)
        self.assertAlmostEqual(vd, 64.17, places=1)

    def test_thick_singlet_paraxial_efl(self):
        # Symmetric N-BK7 lens R1=100, R2=-100, t=4mm
        surfs = [
            {"radiusMm": 100.0, "thicknessMm": 4.0, "glassAfter": "N-BK7", "semiApertureMm": 14.0},
            {"radiusMm": -100.0, "thicknessMm": 0.0, "glassAfter": "AIR", "semiApertureMm": 14.0},
        ]
        efl, bfl = paraxial_efl_bfl(surfs, 0.58756)
        # Lensmaker thick lens: 1/f = (n-1)*(2/R - (n-1)*t/(n*R^2))
        n = refractive_index("N-BK7", 0.58756)
        expected_inv_f = (n - 1.0) * (2.0 / 100.0 - (n - 1.0) * 4.0 / (n * 10000.0))
        self.assertAlmostEqual(efl, 1.0 / expected_inv_f, places=4)
        self.assertLess(bfl, efl)

    def test_edge_thickness_sag_and_clipping(self):
        # For R=50, y=10 -> sag = 50 - sqrt(2500 - 100) = 50 - sqrt(2400)
        self.assertAlmostEqual(sphere_sag(50.0, 10.0), 50.0 - math.sqrt(2400.0), places=6)
        surfs = [
            {"radiusMm": 100.0, "thicknessMm": 4.0, "glassAfter": "N-BK7", "semiApertureMm": 10.0},
            {"radiusMm": -100.0, "thicknessMm": 95.0, "glassAfter": "AIR", "semiApertureMm": 10.0},
        ]
        # Ray at y=11mm must be clipped at semiAperture=10mm
        _, _, clipped, tir = trace_3d_ray(surfs, [0.0, 4.0], 99.0, 0.58756, 0.0, 11.0, -10.0, 0.0, 0.0, 1.0)
        self.assertTrue(clipped)
        self.assertFalse(tir)


if __name__ == "__main__":
    unittest.main()
