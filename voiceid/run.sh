#!/bin/bash
cd "$(dirname "$0")"
exec .venv/bin/uvicorn app:app --host 127.0.0.1 --port ${SPEAKER_ID_PORT:-8788}
