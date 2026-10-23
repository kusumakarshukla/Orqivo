#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MODE="${1:-all}"

python3.12 --version
if [[ "$MODE" == "--ansible-only" || "$MODE" == "all" ]]; then
  command -v ansible-playbook >/dev/null
  ansible-galaxy collection list | grep -q 'ansible.windows'
  for playbook in ansible/playbooks/*.yml; do
    ansible-playbook --syntax-check -i ansible/inventory/development.yml "$playbook"
  done
fi
if [[ "$MODE" == "all" ]]; then
  .venv/bin/python -m compileall -q backend/app
  curl --fail --silent "${API_HEALTH_URL:-http://127.0.0.1:8000/health}"
  echo
fi
