import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path

BRIDGE_PATH = Path(__file__).resolve().parent / "optiland_bridge.py"
HAS_OPTILAND = importlib.util.find_spec("optiland") is not None


class TestOptilandBridge(unittest.TestCase):
    def test_probe_reports_real_python_environment(self):
        proc = subprocess.run(
            [sys.executable, str(BRIDGE_PATH), "--probe"],
            capture_output=True,
            text=True,
            check=True,
        )
        data = json.loads(proc.stdout)
        self.assertIn("pythonVersion", data)
        self.assertEqual(data["optilandInstalled"], HAS_OPTILAND)
        if not HAS_OPTILAND:
            self.assertIsNotNone(data["error"])

    @unittest.skipUnless(HAS_OPTILAND, "optiland 未在当前 Python 环境中安装（跳过真算例，仅本地 Python 3.11+ 环境运行）")
    def test_optiland_self_check_and_solve(self):
        proc = subprocess.run(
            [sys.executable, str(BRIDGE_PATH), "--check"],
            capture_output=True,
            text=True,
            check=True,
        )
        data = json.loads(proc.stdout)
        self.assertTrue(data["passed"])
        self.assertGreater(data["benchmarkResult"]["paraxialEflMm"], 90.0)


if __name__ == "__main__":
    unittest.main()
