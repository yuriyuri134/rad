import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment


def match(truth, detections, radius):
    # Charge each unmatched truth more than the maximum possible sum of valid
    # distances. Minimizing total cost therefore maximizes cardinality first.
    if not truth or not detections:
        return []
    truth = sorted(truth, key=lambda row: row["id"])
    detections = sorted(detections, key=lambda row: row["id"])
    a = np.array([(row["x_opt"], row["y_opt"]) for row in truth])
    b = np.array([(row["x_px"], row["y_px"]) for row in detections])
    delta = a[:, None] - b[None, :]
    distance = np.linalg.norm(delta, axis=2)
    penalty = (min(len(truth), len(detections)) + 1) * radius
    costs = np.concatenate([np.where(distance <= radius, distance, 2 * penalty),
                            np.full((len(truth), len(truth)), penalty)], axis=1)
    rows, cols = linear_sum_assignment(costs)
    return [
        {"truth_id": truth[i]["id"], "detection_id": detections[j]["id"],
         "dx_px": float(-delta[i, j, 0]), "dy_px": float(-delta[i, j, 1]),
         "distance_px": float(distance[i, j]), "injected_flux_e": truth[i]["flux_e"]}
        for i, j in zip(rows, cols) if j < len(detections) and distance[i, j] <= radius
    ]


def evaluate(truth, catalog, radius):
    if truth["exposure_sha256"] != catalog["exposure_sha256"]:
        raise ValueError("Truth and detections belong to different exposures")
    stars, detections = truth["stars"], catalog["sources"]
    if len({row["id"] for row in stars}) != len(stars) or len({row["id"] for row in detections}) != len(detections):
        raise ValueError("Duplicate source IDs")
    eligible = [row for row in stars if row["eligible"]]
    edge_stars = [row for row in stars if row["rendered"] and not row["eligible"]]
    matches = match(eligible, detections, radius)
    matched_truth = {pair["truth_id"] for pair in matches}
    matched_detections = {pair["detection_id"] for pair in matches}
    unmatched = [row for row in detections if row["id"] not in matched_detections]
    edge_matches = match(edge_stars, unmatched, radius)
    ignored = {row["detection_id"] for row in edge_matches}
    missed = [row["id"] for row in eligible if row["id"] not in matched_truth]
    false_detections = [row["id"] for row in unmatched if row["id"] not in ignored]
    evaluated_detections = len(detections) - len(ignored)
    by_flux = []
    for label, lower, upper in [("faint", 0, 3000), ("mid", 3000, 12000), ("bright", 12000, math.inf)]:
        in_bin = [row for row in stars if lower <= row["flux_e"] < upper]
        evaluable = [row for row in in_bin if row["eligible"]]
        recovered = sum(row["id"] in matched_truth for row in evaluable)
        by_flux.append({"group": label, "min_e": lower, "max_e_exclusive": upper if math.isfinite(upper) else None,
                        "injected": len(in_bin), "eligible": len(evaluable), "matched": recovered,
                        "completeness": recovered / len(evaluable) if evaluable else None})
    return {
        "radius_px": radius, "truth_total": len(stars), "truth_eligible": len(eligible),
        "field_retention": len(eligible) / len(stars) if stars else None,
        "detected": len(detections), "evaluated_detections": evaluated_detections, "matched": len(matches),
        "missed": len(missed), "false_detections": len(false_detections), "edge_detections_ignored": len(ignored),
        "completeness": len(matches) / len(eligible) if eligible else None,
        "precision": len(matches) / evaluated_detections if evaluated_detections else None,
        "position_rms_px": math.sqrt(sum(row["distance_px"] ** 2 for row in matches) / len(matches)) if matches else None,
        "matches": matches, "missed_truth_ids": missed, "false_detection_ids": false_detections,
        "ignored_edge_matches": edge_matches, "by_flux": by_flux,
    }


def main():
    job = json.load(sys.stdin)
    truth = json.loads(Path(job["inputs"]["truth"]["path"]).read_text(encoding="utf-8"))
    sources = json.loads(Path(job["inputs"]["catalog"]["path"]).read_text(encoding="utf-8"))
    radius = job["parameters"]["radius_px"]
    data = evaluate(truth, sources, radius)
    data.update({key: truth[key] for key in ("system", "field_deg", "exposure_sha256", "sky_artifact_id", "eligibility")})
    data.update(method=sources["method"], configuration=sources["parameters"],
                truth_id=job["inputs"]["truth"]["id"], catalog_id=job["inputs"]["catalog"]["id"])
    data["position_rms_arcsec"] = None if data["position_rms_px"] is None else data["position_rms_px"] * truth["pixel_scale_arcsec"]
    data["radius_sensitivity"] = [
        {key: result[key] for key in ("radius_px", "matched", "completeness", "precision", "position_rms_px")}
        for result in [evaluate(truth, sources, r) for r in sorted({1, 2, 3, 4, 5, radius})]
    ]
    Path(job["outputDir"], "evaluation.json").write_text(json.dumps(data, indent=2, allow_nan=False), encoding="utf-8")
    Path(job["manifestPath"]).write_text(json.dumps({"outputs": {"evaluation": "evaluation.json"}}), encoding="utf-8")
    print("Matched", data["matched"], "of", data["truth_eligible"], "eligible stars")


if __name__ == "__main__":
    main()
