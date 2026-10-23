#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
.venv/bin/pip install 'ansible-core>=2.16,<3.0' 'pywinrm>=0.4,<1.0'
.venv/bin/ansible-galaxy collection install -r ansible/collections/requirements.yml
.venv/bin/ansible-playbook --version
