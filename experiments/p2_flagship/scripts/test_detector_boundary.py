import unittest
import numpy as np

from stage3_fits_astrometry_pipeline import add_detector_stamp, make_shared_starfield


class DetectorBoundaryTests(unittest.TestCase):
    def test_edge_partially_renders_and_preserves_energy_loss(self):
        image = np.zeros((5, 5))
        psf = np.full((3, 3), 1 / 9)
        self.assertAlmostEqual(add_detector_stamp(image, psf, 0, 2, 90), 2 / 3)
        self.assertAlmostEqual(image.sum(), 60)
        self.assertEqual(add_detector_stamp(image, psf, -4, 2, 90), 0)
        self.assertAlmostEqual(image.sum(), 60)

    def test_shared_field_is_deterministic_in_sky_coordinates(self):
        a = make_shared_starfield(0.6, seed=829)
        self.assertEqual(a, make_shared_starfield(0.6, seed=829))
        self.assertNotEqual(a["stars"], make_shared_starfield(0.6, seed=120)["stars"])
        self.assertEqual(len(a["stars"]), 28)


if __name__ == "__main__":
    unittest.main()
