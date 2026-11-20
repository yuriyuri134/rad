import json
import sys

from astropy.stats import sigma_clipped_stats
from photutils.detection import DAOStarFinder
from catalog_io import read_exposure, publish_catalog

job = json.load(sys.stdin)
image, digest = read_exposure(job)
_, median, sigma = sigma_clipped_stats(image, sigma=3.0)
p = job["parameters"]
result = DAOStarFinder(fwhm=p["fwhm_px"], threshold=p["threshold_sigma"] * sigma)(image - median)
rows = [] if result is None else zip(result["x_centroid"], result["y_centroid"], result["flux"])
publish_catalog(job, digest, "dao", rows)
