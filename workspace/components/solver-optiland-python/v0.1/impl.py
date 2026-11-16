#!/usr/bin/env python3
"""
组件入口：调用仓库根目录 python/optiland_bridge.py。
Rad 可直接修改此脚本或根目录 bridge，将自定义 Optiland 求解/公差逻辑接入工作台。
"""
import subprocess
import sys
from pathlib import Path

BRIDGE = Path(__file__).resolve().parents[4] / "python" / "optiland_bridge.py"

if __name__ == "__main__":
    proc = subprocess.run([sys.executable, str(BRIDGE), *sys.argv[1:]], stdin=sys.stdin)
    raise SystemExit(proc.returncode)
