# Linux Ansible setup

Run these steps on the Linux automation host, not in Replit.

```bash
cd /opt/windows-automation
python3.12 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/ansible-galaxy collection install -r ansible/collections/requirements.yml
.venv/bin/ansible-playbook --version
```

Create a protected environment file readable only by the service account. Provide `DATABASE_URL`, `SESSION_SECRET`, `CSRF_SECRET`, `WINDOWS_USERNAME`, `WINDOWS_PASSWORD`, and the Ansible paths there. Do not place credentials in inventory files or source control.

Check playbooks before connecting:

```bash
for file in ansible/playbooks/*.yml; do
  .venv/bin/ansible-playbook --syntax-check -i ansible/inventory/development.yml "$file"
done
```

For a controlled connectivity test, run from the host that can reach Windows:

```bash
ANSIBLE_CONFIG=/opt/windows-automation/ansible/ansible.cfg \
WINDOWS_USERNAME='DOMAIN\\automation-service' \
WINDOWS_PASSWORD='(read from a protected secret source; do not type into shell history)' \
.venv/bin/ansible-playbook \
  -i ansible/inventory/production.example.yml \
  ansible/playbooks/test_windows_connection.yml \
  --limit win-server-01
```

The command above shows the variable names only. Use a secret manager or an environment file loaded by the service manager; do not put a real value into shell history.

Manual safe playbook checks:

```bash
.venv/bin/ansible-playbook --syntax-check ansible/playbooks/restart_windows_service.yml
.venv/bin/ansible-playbook --syntax-check ansible/playbooks/get_server_health.yml
.venv/bin/ansible-playbook --syntax-check ansible/playbooks/get_disk_space.yml
```

For a real run, submit through the portal after registering the target and credentials. The API creates a temporary one-target inventory and a validated JSON extra-vars file. Review `docs/SECURITY.md` first.
