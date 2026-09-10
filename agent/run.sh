#!/usr/bin/env bash
# vesper-ai voice agent worker (LiveKit).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  "${PYTHON:-$HOME/.local/bin/python3.12}" -m venv .venv
  .venv/bin/pip -q install --upgrade pip
  .venv/bin/pip -q install -r requirements.txt
fi

# 'dev' = connect to LIVEKIT_URL and wait for room dispatch. 'download-files' preloads models.
exec .venv/bin/python worker.py "${1:-dev}"
