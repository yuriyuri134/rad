#!/usr/bin/env bash
# OpenLab Bench v2 — 科学 Python 运行环境幂等重建脚本
# 用法:
#   bash scripts/setup_python_env.sh             # 默认在项目根目录创建持久化 ./.venv (推荐 Windows WSL2 / Linux / macOS)
#   bash scripts/setup_python_env.sh --tmp       # 在 /tmp/p2_venv 创建环境 (兼容云端临时容器)
#   bash scripts/setup_python_env.sh /custom/dir # 在自定义路径创建环境
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_VENV="${REPO_ROOT}/.venv"

if [[ "${1:-}" == "--tmp" ]]; then
  TARGET_VENV="/tmp/p2_venv"
elif [[ -n "${1:-}" ]]; then
  TARGET_VENV="$1"
fi

echo "[openlab-env] 目标 Python 虚拟环境路径: ${TARGET_VENV}"

export PATH="$HOME/.local/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  echo "[openlab-env] 未检测到 uv，正在安装 uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi

if [[ ! -x "${TARGET_VENV}/bin/python" ]]; then
  echo "[openlab-env] 正在使用 uv 创建 Python 3.12 虚拟环境..."
  uv venv "${TARGET_VENV}" --python 3.12
fi

if [[ -f "${REPO_ROOT}/requirements-scientific.lock.txt" ]]; then
  echo "[openlab-env] 正在按 requirements-scientific.lock.txt 安装精确锁定版本..."
  uv pip install --python "${TARGET_VENV}/bin/python" -r "${REPO_ROOT}/requirements-scientific.lock.txt" || {
    echo "[openlab-env] 精确平台轮子回退：安装核心科学包固定版本..."
    uv pip install --python "${TARGET_VENV}/bin/python" \
      "optiland==0.6.3" \
      "numpy>=2.0.0" \
      "scipy>=1.14.0" \
      "astropy>=7.0.0" \
      "sep>=1.4.0" \
      "photutils>=2.0.0"
  }
else
  uv pip install --python "${TARGET_VENV}/bin/python" \
    "optiland==0.6.3" \
    "numpy>=2.0.0" \
    "scipy>=1.14.0" \
    "astropy>=7.0.0" \
    "sep>=1.4.0" \
    "photutils>=2.0.0"
fi

echo "[openlab-env] 验证科学计算包可用性:"
"${TARGET_VENV}/bin/python" -u -c "
import importlib.metadata as m, platform
pkgs = {p: m.version(p) for p in ['optiland', 'numpy', 'scipy', 'astropy', 'sep', 'photutils']}
print('Python:', platform.python_version(), 'Packages:', pkgs)
"
echo "[openlab-env] 环境就绪。server/python_env.ts 自动探测顺序: OPENLAB_PYTHON_BIN -> ./.venv/bin/python -> /tmp/p2_venv/bin/python -> python3。"
