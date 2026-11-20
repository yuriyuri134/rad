import json
import sys
from pathlib import Path

from stage3_fits_astrometry_pipeline import make_shared_starfield

job = json.load(sys.stdin)
p = job["parameters"]
field = make_shared_starfield(p["field_deg"], p["seed"], p["reference_efl_mm"])
Path(job["outputDir"], "sky.json").write_text(json.dumps(field, allow_nan=False), encoding="utf-8")
Path(job["manifestPath"]).write_text(json.dumps({"outputs": {"sky": "sky.json"}}), encoding="utf-8")
print("Generated", len(field["stars"]), "sky sources at", field["field_deg"], "degrees")
