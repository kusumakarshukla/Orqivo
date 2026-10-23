#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/backend"
export PYTHONPATH="$ROOT/backend"
"$ROOT/.venv/bin/alembic" upgrade head
"$ROOT/.venv/bin/python" -m app.seed
echo "Database migration and idempotent development seed completed."
