#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "Missing .env. Copy .env.example to .env and configure it before starting Orqivo." >&2
  exit 1
fi

export WEB_PORT="${WEB_PORT:-8080}"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.dev.yml)

"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" up --wait --no-build -d postgres
"${COMPOSE[@]}" run --rm api alembic upgrade head
"${COMPOSE[@]}" run --rm api python -m app.seed
"${COMPOSE[@]}" up --wait --no-build -d api worker frontend

printf 'Orqivo is starting at http://localhost:%s\n' "$WEB_PORT"
