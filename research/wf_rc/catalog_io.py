import json
from pathlib import Path
import numpy as np
from astropy.io import fits


def read_exposure(job):
    exposure = job["inputs"]["fits"]
    with fits.open(exposure["path"]) as hdus:
        image = np.ascontiguousarray(hdus[0].data, dtype=np.float64)
    if image.ndim != 2 or not np.isfinite(image).all():
        raise ValueError("Expected a finite two-dimensional FITS image")
    return image, exposure["sha256"]


def publish_catalog(job, exposure_sha256, method, xy_flux):
    sources = [
        {"id": index, "x_px": float(x), "y_px": float(y), "flux": float(flux)}
        for index, (x, y, flux) in enumerate(xy_flux, start=1)
    ]
    data = {"exposure_sha256": exposure_sha256, "method": method, "parameters": job["parameters"],
            "coordinate_system": "zero-based detector pixel centers", "sources": sources}
    Path(job["outputDir"], "sources.json").write_text(json.dumps(data, indent=2, allow_nan=False), encoding="utf-8")
    Path(job["manifestPath"]).write_text(json.dumps({"outputs": {"catalog": "sources.json"}}), encoding="utf-8")
    print(method, "detected", len(sources), "sources")
