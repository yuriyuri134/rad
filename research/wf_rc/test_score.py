import unittest

from score import evaluate, match


class ScoreTests(unittest.TestCase):
    def setUp(self):
        self.stars = [
            {"id": 1, "x_opt": 0.0, "y_opt": 0.0, "flux_e": 900.0, "eligible": True, "rendered": True},
            {"id": 2, "x_opt": -1.5, "y_opt": 0.0, "flux_e": 12000.0, "eligible": True, "rendered": True},
        ]
        self.detections = [{"id": 1, "x_px": -0.1, "y_px": 0.0}, {"id": 2, "x_px": 1.8, "y_px": 0.0}]

    def test_maximum_cardinality_before_shortest_distance(self):
        pairs = match(self.stars, self.detections, 2)
        self.assertEqual([(p["truth_id"], p["detection_id"]) for p in pairs], [(1, 2), (2, 1)])
        self.assertEqual(match(self.stars[::-1], self.detections[::-1], 2), pairs)

    def test_minimizes_total_distance_at_equal_cardinality(self):
        detections = [{"id": 1, "x_px": -1.4, "y_px": 0.0}, {"id": 2, "x_px": 0.2, "y_px": 0.0}]
        pairs = match(self.stars, detections, 2)
        self.assertAlmostEqual(sum(p["distance_px"] for p in pairs), 0.3)

    def test_edge_retention_and_effective_completeness_have_distinct_denominators(self):
        edge = {"id": 3, "x_opt": 12.0, "y_opt": 0.0, "flux_e": 12000.0, "eligible": False, "rendered": True}
        sources = [*self.detections, {"id": 3, "x_px": 12.0, "y_px": 0.0}, {"id": 4, "x_px": 36.0, "y_px": 0.0}]
        truth = {"exposure_sha256": "a", "stars": [*self.stars, edge]}
        measure = evaluate(truth, {"exposure_sha256": "a", "sources": sources}, 2)
        self.assertEqual(measure["field_retention"], 2 / 3)
        self.assertEqual(measure["completeness"], 1)
        self.assertEqual(measure["edge_detections_ignored"], 1)
        self.assertEqual(measure["false_detection_ids"], [4])
        self.assertEqual(measure["precision"], 2 / 3)
        with self.assertRaisesRegex(ValueError, "different exposures"):
            evaluate(truth, {"exposure_sha256": "b", "sources": sources}, 2)


if __name__ == "__main__":
    unittest.main()
