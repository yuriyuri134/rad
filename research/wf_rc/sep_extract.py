import json
import sys

import sep
from catalog_io import read_exposure, publish_catalog

job = json.load(sys.stdin)
image, digest = read_exposure(job)
background = sep.Background(image)
p = job["parameters"]
sources = sep.extract(image - background.back(), p["threshold_sigma"],
                      err=background.globalrms, minarea=p["minarea"])
publish_catalog(job, digest, "sep", zip(sources["x"], sources["y"], sources["flux"]))
