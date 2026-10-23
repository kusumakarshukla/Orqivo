#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v python3.12 >/dev/null || {
  echo "Python 3.12 is required. Install it using your Linux distribution's supported package source." >&2
  exit 1
}
python3.12 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/ansible-galaxy collection install -r ansible/collections/requirements.yml
echo "Python and Ansible dependencies installed. Configure a protected .env file before starting services."
