# Windows Automation Portal

## 1. Project overview

An operations portal for submitting approved Windows automation, tracking execution, and reviewing sanitized history. Replit/local development uses mock mode. Real Ansible execution is intended for a Linux automation host with network access to Windows over WinRM HTTPS.

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
- Replit preview API: Express, TypeScript, Drizzle ORM, PostgreSQL.
- Linux production API/worker: Python 3.12, FastAPI, Pydantic, SQLAlchemy 2, Alembic, Uvicorn.
- Automation: Ansible Core, `ansible.windows`, pywinrm, PowerShell 5.1, WinRM HTTPS port 5986.
- Deployment: Docker Compose, Nginx, systemd.

The Replit workspace uses its built-in Express/Drizzle API runtime for the live preview. The Linux production implementation is FastAPI/SQLAlchemy; keep the API contract aligned when changing either backend.

## 5. Project structure

```text
artifacts/windows-automation-portal/  React/Vite portal
artifacts/api-server/                 Replit mock API and worker adapter
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

## 6. Quick start in Replit

The managed web and API workflows start the preview. Keep `MOCK_MODE=true`; Replit does not need access to a Windows server. Configure `DEV_ADMIN_PASSWORD`, `DEV_OPERATOR_PASSWORD`, and `DEV_VIEWER_PASSWORD` in Replit Secrets to use the development accounts. The API stores only password hashes. Restart the API workflow after changing those secrets so seeded accounts pick them up.

Use the login page account buttons to select an email, enter its configured password, and sign in. Demo emails are `admin@example.com`, `operator@example.com`, and `viewer@example.com`.

## 7. Local development setup

Requirements: Node.js 24, pnpm, Python 3.12, and PostgreSQL.

```bash
pnpm install
cp .env.example .env
# Edit the protected .env with a local PostgreSQL URL and random session/CSRF secrets.
bash scripts/setup_linux.sh
bash scripts/initialize_database.sh
```

For the workspace preview adapter, start the managed API and web workflows in Replit. For the production-style Python API locally, configure `.env`, then run:

```bash
bash scripts/run_development.sh
```

Build the frontend separately with:

```bash
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/windows-automation-portal run dev
```

## 8. PostgreSQL setup

Create a database and least-privilege application account. Set `DATABASE_URL` in a protected environment. The Replit preview uses the platform-provided `DATABASE_URL`; never hardcode it.

For the Python backend, apply migrations and seed data:

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

Set the protected Ansible and Windows environment values as described in [docs/ANSIBLE_SETUP.md](docs/ANSIBLE_SETUP.md). Do not test real WinRM from Replit.

## 10. Windows Server WinRM setup

Prepare an HTTPS listener on port 5986 with a trusted certificate and restrict inbound firewall access to the Linux automation host's fixed IP. Deploy the approved scripts to `C:\Automation` and grant least-privilege read/execute access to the automation account. Follow [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md) and have changes reviewed by the Windows/security team.

## 11. PowerShell script deployment

Copy `powershell/Restart-WindowsService.ps1`, `powershell/Get-ServerHealth.ps1`, and `powershell/Get-DiskSpace.ps1` to `C:\Automation`. Run health and disk checks first. Restarting a service changes state and must be validated on a non-production host before production use.

## 12. Environment variables

See [.env.example](.env.example). Important values include `DATABASE_URL`, `SESSION_SECRET`, `CSRF_SECRET`, `MOCK_MODE`, `ANSIBLE_ENABLED`, `ANSIBLE_BINARY`, `ANSIBLE_CONFIG`, `ANSIBLE_WORKING_DIRECTORY`, `WINDOWS_USERNAME`, `WINDOWS_PASSWORD`, `WINDOWS_WINRM_TRANSPORT`, and the three `DEV_*_PASSWORD` values.

Never commit `.env`. Configure Replit credentials through Replit Secrets. Production must fail closed if session/CSRF secrets or Windows credentials are missing.

## 13. Database migrations

The Replit preview uses Drizzle schema changes in `lib/db/src/schema/`; for development, apply with:

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

Set `MOCK_MODE=true` and leave `ANSIBLE_ENABLED=false`. The Replit preview is mock-first and does not start Ansible. Mock jobs persist to PostgreSQL, include events, and return clearly labeled mock results. `MOCK_FAILURE_RATE` and `MOCK_TIMEOUT_RATE` can exercise failure outcomes in a development environment.

## 15. Running with real Ansible

Only enable on the Linux automation host after WinRM, firewall, certificate, service-account, and playbook review:

```text
APP_ENV=production
MOCK_MODE=false
ANSIBLE_ENABLED=true
```

Set `WINDOWS_USERNAME` and `WINDOWS_PASSWORD` through the host's secret manager or protected environment. The API accepts automation/server IDs, not raw paths or commands. Real execution must be tested on the Linux host; it was not tested from Replit.

## 16. Running tests

Available checks:

```bash
pnpm run typecheck
python3.12 -m compileall -q backend/app
make ansible-check
```

The initial build includes a typechecked Replit API and frontend; automated acceptance, browser end-to-end tests, and real WinRM tests still need to be completed before production sign-off. Run host-side syntax checks only where Ansible is installed.

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

## 21. Security checklist

See [docs/SECURITY.md](docs/SECURITY.md). Confirm mock mode is off only on the approved Linux host; secrets are protected; WinRM uses HTTPS and trusted certificates; firewall rules are source-restricted; service account rights are least-privilege; API docs are disabled or access-controlled; backups and log retention are configured.

## 22. Troubleshooting

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for login, WinRM, certificate, transport, collection, script, database, CORS, Nginx, worker, and systemd diagnostics.

## 23. Known limitations

- The Replit preview API and Linux production FastAPI implementation are separate runtimes and must be kept contract-aligned.
- The initial sign-in is development-only; Microsoft Entra ID OIDC is not implemented.
- Replit runs mock mode only. Real WinRM connectivity, certificate trust, PowerShell behavior, and production performance have not been tested.
- Automated backend/frontend acceptance suites and browser end-to-end tests are not yet complete.
- Audit records are append-only through the application, but database-level immutability and retention controls must be configured operationally.

## 24. Production hardening recommendations

Complete security review and automated tests; use enterprise identity, MFA, and approved role provisioning; configure TLS and network segmentation; add monitoring/alerting and database backups with restore drills; review all service allowlists and output fields; define retention and incident response; test concurrency and crash recovery; validate the full API contract between preview and production; perform controlled staging runs before enabling production automation.

