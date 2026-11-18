import ast
import importlib
import importlib.metadata as meta
import json
import os
import time
import optiland

t0 = time.perf_counter()
pkg_dir = os.path.dirname(optiland.__file__)

report = {
    "versions": {
        p: meta.version(p)
        for p in ["optiland", "numpy", "scipy", "astropy", "sep", "photutils"]
    },
    "optiland_dir": pkg_dir,
    "modules_by_subdir": {},
    "analysis_files": [],
    "image_simulation_import_check": {},
    "keyword_hits": {},
    "samples": {},
}

for root, dirs, files in os.walk(pkg_dir):
    if "__pycache__" in root:
        continue
    rel = os.path.relpath(root, pkg_dir)
    py_files = sorted(f for f in files if f.endswith(".py"))
    if py_files:
        report["modules_by_subdir"][rel] = py_files

analysis_dir = os.path.join(pkg_dir, "analysis")
if os.path.isdir(analysis_dir):
    report["analysis_files"] = sorted(os.listdir(analysis_dir))

# Explicit check for ImageSimulationEngine & related modules
for mod_path in [
    "optiland.analysis.image_simulation",
    "optiland.image_simulation",
    "optiland.simulation",
    "optiland.analysis",
]:
    try:
        m = importlib.import_module(mod_path)
        attrs = [a for a in dir(m) if "sim" in a.lower() or "image" in a.lower() or "psf" in a.lower() or "warp" in a.lower()]
        report["image_simulation_import_check"][mod_path] = {
            "imported": True,
            "matching_attrs": attrs,
        }
    except Exception as e:
        report["image_simulation_import_check"][mod_path] = {
            "imported": False,
            "error": f"{type(e).__name__}: {e}",
        }

keywords = [
    "ImageSimulation",
    "image_simulation",
    "DistortionWarper",
    "EigenPSF",
    "TMA",
    "ThreeMirror",
    "Ritchey",
    "Grating",
    "Spectrometer",
    "FieldCorrector",
]
hits = {k: [] for k in keywords}
for rel_dir, py_files in report["modules_by_subdir"].items():
    for fn in py_files:
        rel_file = fn if rel_dir == "." else os.path.join(rel_dir, fn)
        full_path = os.path.join(pkg_dir, rel_file)
        with open(full_path, "r", encoding="utf-8", errors="ignore") as fh:
            txt = fh.read()
        for kw in keywords:
            if kw.lower() in txt.lower():
                hits[kw].append(rel_file)
report["keyword_hits"] = hits

samples_dir = os.path.join(pkg_dir, "samples")
for fn in sorted(os.listdir(samples_dir)):
    if fn.endswith(".py") and not fn.startswith("__"):
        src = open(os.path.join(samples_dir, fn), "r", encoding="utf-8").read()
        tree = ast.parse(src)
        cls_info = []
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                doc = ast.get_docstring(node) or ""
                cls_info.append({"name": node.name, "doc": doc.strip().splitlines()[0] if doc.strip() else ""})
        report["samples"][fn] = cls_info

# Inspect wavefront strategies available in 0.6.3
import optiland.wavefront.strategy as wf_strat
with open(wf_strat.__file__, "r", encoding="utf-8") as fh:
    wf_src = fh.read()
wf_tree = ast.parse(wf_src)
report["wavefront_strategy_classes"] = [
    n.name for n in wf_tree.body if isinstance(n, ast.ClassDef)
]

# Inspect tolerancing operands available
import optiland.optimization.operand as op_mod
import optiland.tolerancing.perturbation as pert_mod
report["tolerancing_perturbation_classes"] = [
    n for n in dir(pert_mod) if not n.startswith("_")
]

report["elapsed_sec"] = round(time.perf_counter() - t0, 3)

out_path = "experiments/p2_flagship/audits/audit01_package_inventory.json"
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(report, fh, indent=2, ensure_ascii=False)

print("=== VERSIONS ===", flush=True)
print(json.dumps(report["versions"], indent=2), flush=True)
print("\n=== ANALYSIS FILES ===", flush=True)
print(report["analysis_files"], flush=True)
print("\n=== IMAGE SIMULATION IMPORT CHECK ===", flush=True)
print(json.dumps(report["image_simulation_import_check"], indent=2), flush=True)
print("\n=== KEYWORD HITS ===", flush=True)
print(json.dumps(report["keyword_hits"], indent=2), flush=True)
print("\n=== WAVEFRONT STRATEGIES ===", flush=True)
print(report["wavefront_strategy_classes"], flush=True)
print("\n=== TELESCOPE / MISC SAMPLES ===", flush=True)
for fn in ["telescopes.py", "miscellaneous.py", "objectives.py", "infrared.py", "lithography.py"]:
    print(f"  {fn}: {report['samples'].get(fn, [])}", flush=True)
print(f"\nSaved {out_path} in {report['elapsed_sec']}s", flush=True)
