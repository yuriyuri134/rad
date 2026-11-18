#!/usr/bin/env bash
set -euo pipefail

VENV_DIR="/tmp/p2_venv"
if [ -x "$VENV_DIR/bin/python" ]; then
  echo "Using existing $VENV_DIR"
  exit 0
fi

export PATH="$HOME/.local/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi

uv venv "$VENV_DIR" --python 3.12
uv pip install --python "$VENV_DIR/bin/python" \
  "optiland==0.6.3" \
  "numpy==2.5.5" \
  "scipy==1.18.1" \
  "astropy==8.0.2" \
  "sep==1.4.1" \
  "photutils==3.1.1"

"$VENV_DIR/bin/python" -u -c "import importlib.metadata as m; print({p: m.version(p) for p in ['optiland','numpy','scipy','astropy','sep','photutils']})"
