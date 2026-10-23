#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/backend"
export PYTHONPATH="$ROOT/backend"
export APP_ENV=production
exec "$ROOT/.venv/bin/uvicorn" app.main:app --host "${APP_HOST:-127.0.0.1}" --port "${APP_PORT:-8000}" --proxy-headers
