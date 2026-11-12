# Orqivo

## 1. Project overview

Orqivo is an operations portal for submitting approved Windows automation, tracking execution, and reviewing sanitized history. Local development uses mock mode. Real Ansible execution is intended for a Linux automation host with network access to Windows over WinRM HTTPS.

## 2. Architecture

The browser talks only to the portal API. The API validates roles, IDs, and parameters, stores the job in PostgreSQL, and returns HTTP 202. A background worker claims the job, runs a simulation or an approved Ansible playbook, and records status/events/output. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 3. Features

- Development login with admin, operator, and viewer roles.
- Dashboard, approved automation catalogue, dynamic run forms, job history, job details, server management, automation administration, audit log, and profile.
- PostgreSQL-backed jobs, events, audit records, servers, automation definitions, sessions, and worker heartbeat.
- Mock jobs simulate progress and success, failure, or timeout without contacting Windows.
- Production Python worker uses a playbook/script registry and one-target Ansible execution.
- Output and CSV export sanitization.

## 4. Technology stack

- UI: React, TypeScript, Vite, Tailwind CSS, Wouter routing, TanStack Query, React Hook Form, Zod, Lucide.
- API/worker: Python 3.12, FastAPI, Pydantic, SQLAlchemy 2, Alembic, Uvicorn.
- Automation: Ansible Core, `ansible.windows`, pywinrm, PowerShell 5.1, WinRM HTTPS port 5986.
- Deployment: Docker Compose, Nginx, systemd.

The application runtime uses FastAPI/SQLAlchemy. The workspace also contains a separate Express/Drizzle adapter and generated API packages; the deployment scripts and Docker configuration use the Python backend.

## 5. Project structure

```text
artifacts/windows-automation-portal/  React/Vite portal
artifacts/api-server/                 Separate Express mock API adapter
lib/api-spec/                         OpenAPI contract and generated clients
lib/db/                               Drizzle preview database models
backend/app/                          FastAPI production API, models, worker
backend/alembic/                      SQLAlchemy migration history
ansible/playbooks/                    Allowlisted Windows playbooks
ansible/inventory/                    Safe development/production examples
powershell/                           Fixed example scripts for C:\Automation
deployment/                           Docker, Nginx, and systemd files
scripts/                              Setup, migration, run, and validation helpers
docs/                                 Architecture, security, operations, and user guides
```

## 6. Development accounts

Keep `MOCK_MODE=true` for local development. Configure `DEV_ADMIN_PASSWORD`, `DEV_OPERATOR_PASSWORD`, and `DEV_VIEWER_PASSWORD` in a protected local environment before seeding accounts. No usable passwords are supplied by defaults or `.env.example`; unconfigured accounts are created without a usable password. Production requires an explicit admin password of at least 14 characters. Passwords are stored only as hashes.

Use the login page account buttons to select an email, enter its configured password, and sign in. Demo emails are `admin@example.com`, `operator@example.com`, and `viewer@example.com`. Azure Entra ID SSO can be enabled separately with deployment environment variables; the Microsoft button appears automatically when configured. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#optional-azure-entra-id-sso).

## 7. Local development setup

Requirements: Node.js 24, pnpm, Python 3.12, and PostgreSQL. macOS can run the frontend and Python API locally; real Ansible execution should run on the Linux automation host.

```bash
pnpm install
cp .env.example .env
# Edit the protected .env with a local PostgreSQL URL and random session/CSRF secrets.
python3.12 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
bash scripts/initialize_database.sh
```

Configure `.env` for the local database and development secrets, then run:

```bash
bash scripts/run_development.sh
```

Build the frontend separately with:

```bash
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/windows-automation-portal run dev
```

The local Vite server proxies `/api` requests to `http://127.0.0.1:8000`, where the FastAPI service listens by default. Start the API with `bash scripts/run_development.sh` and run the frontend in a second terminal. If the API listens on another address, set `API_PROXY_TARGET` when starting Vite.

## 8. PostgreSQL setup

Create a database and least-privilege application account. Set `DATABASE_URL` in a protected environment; never hardcode credentials.

For the Python backend, apply migrations and seed data. Set required account passwords in the protected environment first; production seeding fails if `DEV_ADMIN_PASSWORD` is missing or weak:

```bash
make migrate
make seed
```

The initial development seed includes two mock servers, three automation definitions, and three roles/users. Passwords are configured separately; there are no default passwords.

## 9. Linux Ansible server setup

Use the Linux server that can reach the Windows Server. Install Python 3.12, the project requirements, Ansible Core, pywinrm, and the `ansible.windows` collection:

```bash
bash scripts/setup_linux.sh
bash scripts/install_ansible.sh
bash scripts/verify_setup.sh --ansible-only
```

Set the protected Ansible and Windows environment values as described in [docs/ANSIBLE_SETUP.md](docs/ANSIBLE_SETUP.md). Do not test real WinRM from a development workstation.

## 10. Windows Server WinRM setup

Prepare an HTTPS listener on port 5986 with a trusted certificate and restrict inbound firewall access to the Linux automation host's fixed IP. Deploy the approved scripts to `C:\Automation` and grant least-privilege read/execute access to the automation account. Follow [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md) and have changes reviewed by the Windows/security team.

## 11. PowerShell script deployment

Copy `powershell/Restart-WindowsService.ps1`, `powershell/Get-ServerHealth.ps1`, `powershell/Get-DiskSpace.ps1`, `powershell/Create-PermanentAccount.ps1`, `powershell/Create-ConsultantAccount.ps1`, and `powershell/Disable-ADAccount.ps1` to `C:\Automation`. Run health and disk checks first. Account scripts are restricted to the configured demo OU and must only be enabled for the approved non-production target. Restarting a service changes state and must be validated on a non-production host before production use.

## 12. Environment variables

See [.env.example](.env.example). Important values include `DATABASE_URL`, `SESSION_SECRET`, `CSRF_SECRET`, `MOCK_MODE`, `ANSIBLE_ENABLED`, `ANSIBLE_BINARY`, `ANSIBLE_CONFIG`, `ANSIBLE_WORKING_DIRECTORY`, `WINDOWS_USERNAME`, `WINDOWS_PASSWORD`, `WINDOWS_WINRM_TRANSPORT`, the three `DEV_*_PASSWORD` values, and the optional `AZURE_SSO_*` values.

Never commit `.env`. Use a protected local environment file for development and an approved secret manager or protected environment file for production. Production fails closed if session/CSRF secrets or the admin password are missing, weak, or do not match the stored seeded admin. Run the production seed after setting the admin password; it synchronizes built-in user password hashes to configured values and disables password login for built-in accounts whose password is not configured. To reset an existing account without putting the password in shell history, run `python -m app.reset_password` from the backend environment, or in Docker run `sudo docker compose run --rm -it api python -m app.reset_password`; enter the account email and new password at the hidden prompts. For the seeded production admin, the entered password must match `DEV_ADMIN_PASSWORD`. Use at least 14 characters and do not send passwords in chat or tickets.

## 13. Database migrations

The separate Drizzle workspace package has its own development schema command:

```bash
pnpm --filter @workspace/db run push
```

The Linux FastAPI backend uses Alembic:

```bash
cd backend
PYTHONPATH=. ../.venv/bin/alembic upgrade head
PYTHONPATH=. ../.venv/bin/python -m app.seed
```

Review migration changes and back up the database before production upgrades.

## 14. Running in mock mode

Set `MOCK_MODE=true` and leave `ANSIBLE_ENABLED=false`. Mock jobs persist to PostgreSQL, include events, and return clearly labeled mock results. `MOCK_FAILURE_RATE` and `MOCK_TIMEOUT_RATE` can exercise failure outcomes in a development environment.

## 15. Running with real Ansible

Only enable on the Linux automation host after WinRM, firewall, certificate, service-account, and playbook review:

```text
APP_ENV=production
MOCK_MODE=false
ANSIBLE_ENABLED=true
```

Use a dedicated least-privilege AD identity and inject its password only through the host's secret manager or a root-owned protected environment file. For Docker Compose, use [docker-compose.kerberos.yml](docker-compose.kerberos.yml) to mount the approved Kerberos config and internal CA chain, as described in [docs/ANSIBLE_SETUP.md](docs/ANSIBLE_SETUP.md). Optional live demo account create/disable jobs are gated to a configured non-production target and `AD_DEMO_OU_DN`; account create/disable playbooks do not add group memberships. BitLocker remains review-only. Complete the demo setup only for an isolated test domain.

## 16. Running tests

Available checks:

```bash
pnpm run typecheck
python3.12 -m compileall -q backend/app
make ansible-check
```

The initial build includes typechecked workspace packages and the frontend; automated acceptance, browser end-to-end tests, and real WinRM tests still need to be completed before production sign-off. Run host-side syntax checks only where Ansible is installed.

## 17. Production deployment

Install to `/opt/windows-automation`, configure `/etc/windows-automation.env` with restrictive permissions, run explicit migrations, and enable separate API and worker systemd units. Nginx serves the built frontend and proxies `/api/` to FastAPI. Details: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## 18. Nginx configuration

Start with `deployment/nginx/default.conf`; add TLS certificates and organization-specific access/logging policies. Expose HTTPS only, proxy `/api/` unchanged, and keep the API port on loopback or an internal Docker network.

## 19. systemd services

Templates are in `deployment/systemd/`. Copy them into `/etc/systemd/system/`, check paths and service account permissions, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now windows-automation-api.service windows-automation-worker.service
sudo systemctl status windows-automation-api.service windows-automation-worker.service
```

## 20. Docker deployment

Configure a protected `.env` from `.env.example`, then:

```bash
docker compose config
docker compose build
docker compose run --rm api alembic upgrade head
docker compose run --rm api python -m app.seed
docker compose up -d
```

Use `docker compose down` to stop services. Do not use `docker compose down -v` unless intentionally deleting the database volume and its data.

## 20.1 Incremental Docker development

Use the development Compose overlay for local work. It keeps dependencies in the images and mounts the frontend, backend, and Ansible source from your working tree.

On first setup, build the images once and start the app:

```bash
make docker-build
./startup.sh
```

Open `http://localhost:8080` (or the configured `WEB_PORT`). To start the app again later, run `./startup.sh`; routine starts do not rebuild images. To stop the app, run `make docker-down`.

### After changing code

- **JavaScript/TypeScript:** Edit the frontend files as usual. Vite watches the mounted source and updates the browser with HMR; refresh the page if an update is not visible. No rebuild or container restart is normally needed.
- **Python API:** Edit files under `backend/app`. Uvicorn reloads the API automatically. If you add a database migration, apply it with:

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm api alembic upgrade head
  ```

- **Python worker:** Worker source is mounted, but the worker process does not auto-reload. After editing worker code, restart only that service:

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.dev.yml restart worker
  ```

- **Ansible:** Playbooks, inventory, `ansible.cfg`, and collection requirements are mounted into the API and worker containers. Playbook and configuration edits are available to the next Ansible execution without rebuilding or restarting. If you change the collection requirements, rebuild the API/worker images with `docker compose -f docker-compose.yml -f docker-compose.dev.yml build api worker` to install the updated collections.

Rebuild the development images only when dependency definitions change, such as `backend/requirements.txt`, `ansible/collections/requirements.yml`, `pnpm-lock.yaml`, or a workspace `package.json`; then run `./startup.sh` to apply them. The dev overlay keeps the existing PostgreSQL service and data volume.

## 20.2 Adding an automation catalogue entry

The catalogue record controls the name, description, risk, permissions, timeout, and run-form fields shown in the portal. Real execution is separately allowlisted in the Python Ansible runner; adding a record in the admin UI alone does not make a new playbook executable.

1. **Create the implementation.**
   - Add an Ansible playbook under `ansible/playbooks/`. For a script already deployed on Windows, use `ansible.windows.win_powershell` with a fixed `Invoke-Command -ScriptBlock`; pass the fixed script path and validated arguments as separate parameters, and invoke it with `& $Path @Arguments` inside the block. The Ansible module already runs on the Windows target, so do not add `-ComputerName` and create an unnecessary second WinRM hop. Keep `ansible.windows` at version 3.1.0 or later for existing `remote_src` tasks. Do not embed the PowerShell implementation in the playbook. For AD account automations, forward `host_out` (PowerShell `Write-Host` messages) through the `ORQIVO_POWERSHELL_OUTPUT=` base64 marker, which the runner extracts from successful Ansible output.
   - Add the PowerShell script under `powershell/`. Have the Windows administrator deploy the reviewed script to a fixed path under `C:\Automation` on each target before enabling the automation.
   - Keep the playbook limited to the approved action and target. Validate all inputs in the API and playbook; do not accept arbitrary command, script, or playbook paths.
2. **Register the implementation** in `backend/app/ansible_runner.py`. Add the same key to `PLAYBOOK_REGISTRY` and `SCRIPT_REGISTRY`; map it to the playbook path and remote PowerShell script filename. The keys must match because the runner rejects unregistered or mismatched keys.
3. **Add the catalogue definition** to the `AUTOMATIONS` list in `backend/app/seed.py`. Set its `code`, display name and description, matching `playbook_key` and `powershell_script_key`, parameter schema, risk level, timeout, required role, confirmation/change-number requirements, and `is_active`. Parameter fields use `text`, `select`, `multi-select`, or `number`; supply approved `options` for select fields.
4. **Validate and seed** in Docker development mode:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm api \
     ansible-playbook --syntax-check \
     -i ansible/inventory/development.yml \
     ansible/playbooks/<new-playbook>.yml
   docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm api python -m app.seed
   ```

   Seeding inserts a new catalogue definition by `code`; it does not overwrite existing definitions. For an existing code, update that record through the admin UI or a reviewed database migration as appropriate.
5. **Restart the worker and test safely.** Restart the worker so it loads any new registry entries:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.dev.yml restart worker
   ```

   In the portal, verify the entry appears in the catalogue, its dynamic form enforces the approved parameters, and a mock run produces the expected timeline/output. Use real WinRM only from the approved Linux automation host, against an authorized non-production target, after review and configuration. Deploy and verify the PowerShell script on the Windows target before any real run.

For code changes, this dev setup uses bind mounts, so routine JavaScript, Python, playbook, and Ansible configuration changes do not require an image rebuild. Rebuild only if dependency definitions change; see [Incremental Docker development](#201-incremental-docker-development).

### Example: Create an AD group

For a basic form with **AD group name**, **members**, and **owner**, no JavaScript change is needed: the existing run form is generated from `parameter_schema`. Use text fields for all three values. For example, represent members as a semicolon-separated list of UPNs because the current form has no directory-backed user picker. Run the PowerShell as a separate script on the target, rather than embedding its code in the Ansible playbook:

```python
{
    "code": "create_ad_group",
    "name": "Create AD Group",
    "description": "Create an approved AD group and add the requested members.",
    "playbook_key": "create_ad_group",
    "powershell_script_key": "create_ad_group",
    "parameter_schema": [
        {
            "name": "group_name",
            "label": "AD group name",
            "type": "text",
            "required": True,
            "placeholder": "APP-Example-Users",
        },
        {
            "name": "members",
            "label": "Members (semicolon-separated UPNs)",
            "type": "text",
            "required": True,
            "placeholder": "user1@example.com; user2@example.com",
        },
        {
            "name": "owner",
            "label": "Owner UPN",
            "type": "text",
            "required": True,
            "placeholder": "owner@example.com",
        },
    ],
    "risk_level": "high",
    "timeout_seconds": 300,
    "required_role": "operator",
    "requires_change_number": True,
    "requires_confirmation": True,
    "is_active": True,
    "target_os": "Windows Server",
    "expected_minutes": 5,
}
```

Add the definition to `AUTOMATIONS` in `backend/app/seed.py`, then:

1. Add `create_ad_group` to both `PLAYBOOK_REGISTRY` and `SCRIPT_REGISTRY` in `backend/app/ansible_runner.py`, pointing to `playbooks/create_ad_group.yml` and the deployed script filename.
2. Create `ansible/playbooks/create_ad_group.yml` and `powershell/Create-ADGroup.ps1`. In the playbook, invoke the fixed path `C:\Automation\Create-ADGroup.ps1` through `Invoke-Command -ScriptBlock`, passing the path and validated parameters separately. Have the Windows administrator deploy the reviewed script to that path on the approved target.
3. Validate the parameter values before execution. Extend `validate_parameters` in `backend/app/main.py` with checks specific to this operation: enforce the organization’s group-name convention and length, split and validate each member UPN, reject duplicates or excessive member counts, and validate the owner. In the playbook/script, independently verify that the owner and every member resolve to permitted directory users, and constrain group creation to an approved OU and group scope/type. Do not rely on browser validation or accept a caller-selected OU, arbitrary group type, or raw command.
4. Syntax-check the playbook, seed the new catalogue entry, and restart the worker:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm api \
     ansible-playbook --syntax-check \
     -i ansible/inventory/development.yml \
     ansible/playbooks/create_ad_group.yml
   docker compose -f docker-compose.yml -f docker-compose.dev.yml run --rm api python -m app.seed
   docker compose -f docker-compose.yml -f docker-compose.dev.yml restart worker
   pnpm --filter @workspace/windows-automation-portal run typecheck
   ```

5. In the PowerShell script, set `$Ansible.Result` to a safe structured result (for example, success, group name, and distinguished name, but no credentials), and use `Write-Host` for user-facing status messages. In the playbook, register the `win_powershell` task with `no_log: true`. To show only those PowerShell messages in job stdout, forward `host_out` through the marker and add the automation key to the runner's output-extraction set; keep the result assertion independent from display text.
6. Confirm the three fields render, verify invalid values are rejected, and run a mock test. Before real execution, get directory/security approval, use a non-production OU and target, and test with disposable users. Do not add a production group-creation path until its authorization, audit, ownership, and membership policies are reviewed.

If members should be selected from a live directory search or shown as removable member chips instead of entered as text, that is a custom UI feature: add the component and API lookup/validation flow in `artifacts/windows-automation-portal/src/App.tsx` and the relevant `backend/app` endpoint/schema. Keep final validation server-side even when the picker is present.

## 21. Security checklist

See [docs/SECURITY.md](docs/SECURITY.md). Confirm mock mode is off only on the approved Linux host; secrets are protected; WinRM uses HTTPS and trusted certificates; firewall rules are source-restricted; service account rights are least-privilege; API docs are disabled or access-controlled; backups and log retention are configured.

## 22. Troubleshooting

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for login, WinRM, certificate, transport, collection, script, database, CORS, Nginx, worker, and systemd diagnostics.

## 23. Known limitations

- Azure Entra ID SSO is optional and deployment-configurable through `AZURE_SSO_*`; normal password login remains available.
- Real WinRM connectivity, certificate trust, PowerShell behavior, and production performance have not been tested.
- Automated backend/frontend acceptance suites and browser end-to-end tests are not yet complete.
- Audit records are append-only through the application, but database-level immutability and retention controls must be configured operationally.

## 24. Production hardening recommendations

Complete security review and automated tests; use enterprise identity, MFA, and approved role provisioning; configure TLS and network segmentation; add monitoring/alerting and database backups with restore drills; review all service allowlists and output fields; define retention and incident response; test concurrency and crash recovery; perform controlled staging runs before enabling production automation.
# sREBUILD
docker compose build api worker frontend