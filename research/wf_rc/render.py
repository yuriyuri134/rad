import hashlib
import json
import sys
from pathlib import Path

from stage3_fits_astrometry_pipeline import (
    build_system_from_prescription, compute_radial_centroid_and_psf_bank, render_tile,
)

job = json.load(sys.stdin)
inputs = job["inputs"]
prescription = json.loads(Path(inputs["prescription"]["path"]).read_text(encoding="utf-8"))
sky = json.loads(Path(inputs["sky"]["path"]).read_text(encoding="utf-8"))
system_id, system, efl = build_system_from_prescription(prescription)
grid, distortion, psf = compute_radial_centroid_and_psf_bank(system, efl, [sky["field_deg"]])
fits_file = Path(job["outputDir"], system_id + "_" + format(sky["field_deg"], ".2f") + "deg.fits")
truth = render_tile(system_id, efl, grid, distortion, psf, sky, job["parameters"]["noise_seed"], fits_file)
with fits_file.open("rb") as fh:
    truth["exposure_sha256"] = hashlib.file_digest(fh, "sha256").hexdigest()
truth["sky_artifact_id"] = inputs["sky"]["id"]
truth["prescription_sha256"] = inputs["prescription"]["sha256"]
Path(job["outputDir"], "truth.json").write_text(json.dumps(truth, indent=2, allow_nan=False), encoding="utf-8")
Path(job["manifestPath"]).write_text(json.dumps({"outputs": {"fits": fits_file.name, "truth": "truth.json"}}), encoding="utf-8")
print("Rendered", sum(star["rendered"] for star in truth["stars"]), "of", len(truth["stars"]),
      "injected stars;", sum(star["eligible"] for star in truth["stars"]), "eligible")
