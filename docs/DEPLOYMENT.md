# Deployment

Real Ansible execution must run on the Linux automation host that can route to the registered Windows targets. Local development should use mock execution only.

## Host installation

```bash
sudo useradd --system --home /opt/windows-automation --shell /usr/sbin/nologin windows-automation
sudo install -d -o windows-automation -g windows-automation /opt/windows-automation
sudo install -d -o windows-automation -g windows-automation /opt/windows-automation/var
```

Deploy the project to `/opt/windows-automation`, then run `bash scripts/setup_linux.sh`. Create `/etc/windows-automation.env` with `root:windows-automation` ownership and mode `0640`. Set production secrets outside Git. Run migrations explicitly with `scripts/initialize_database.sh`.

Set `DEV_ADMIN_PASSWORD` in the protected production environment before starting the API or running the seed. It must be at least 14 characters; production startup and seeding fail if it is missing or a known placeholder. Production seeding synchronizes built-in user hashes with configured values and disables password login for built-in accounts without a configured password. After a password change, rerun the production seed or set the seeded admin to the same value configured as `DEV_ADMIN_PASSWORD`; startup verifies that these values match. The sample `.env.example` contains no usable passwords or secret values. For Compose deployments, update an existing account interactively with `sudo docker compose run --rm -it api python -m app.reset_password`; do not pass passwords as command-line arguments.

## Frontend and API

Build the UI from the monorepo:

```bash
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/windows-automation-portal run build
```

Serve `artifacts/windows-automation-portal/dist/public` with Nginx. Configure `/api/` to proxy to the FastAPI service on loopback port 8000. Set `FRONTEND_URL` to the exact HTTPS origin.

### Optional Azure Entra ID SSO

SSO is enabled only when all `AZURE_SSO_*` values in `.env.example` are configured. Register a single-tenant Web application in Entra ID and set its exact redirect URI to `https://<portal-host>/api/v1/auth/sso/callback`. Configure group claims for the three security groups and set each `AZURE_SSO_{ADMIN,OPERATOR,VIEWER}_GROUP_ID` to that group's object ID. Store the client secret only in the protected environment/secret manager. The SSO button appears automatically when configuration is complete; normal email/password login remains available. Users in multiple mapped groups receive the highest role (admin, then operator, then viewer); users outside those groups are denied. Group overage is rejected, so keep the SSO groups within Entra's ID-token group-claim limit or use an app registration whose assignment only emits the three relevant groups.

Set `AZURE_SSO_REDIRECT_URI` to the same exact HTTPS callback URI in every deployment and in the Entra app registration. No tenant-specific URLs or group IDs are hard-coded in the application.

Run API and worker separately:

```bash
sudo systemctl enable --now windows-automation-api.service
sudo systemctl enable --now windows-automation-worker.service
sudo systemctl status windows-automation-api.service windows-automation-worker.service
```

## Nginx, firewall, and logs

Use `deployment/nginx/default.conf` as a starting point and add TLS certificates, HSTS after HTTPS is verified, access controls, and organization-specific logging. Expose only TCP 443 to users. Allow outbound traffic from the Linux host to Windows TCP 5986 and PostgreSQL only as required. Restrict Windows inbound 5986 to the Linux host's fixed IP.

View service logs with `journalctl -u windows-automation-api -u windows-automation-worker`. Configure rotation and retention under local policy; logs must not include secrets.

## Docker Compose

For a single-host deployment, configure `.env` from `.env.example` with protected values, then:

```bash
docker compose config
docker compose build
docker compose run --rm api alembic upgrade head
docker compose run --rm api python -m app.seed
docker compose up -d
docker compose ps
```

The frontend is exposed on `WEB_PORT` (default 8080). Put a TLS-terminating reverse proxy or load balancer in front of it. Back up the Postgres volume before updates.

For incremental local development instead of the production Nginx frontend, build the dev images when first setting up or when dependency definitions change, then start with the repository script:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml build api worker frontend
./startup.sh
```

The dev overlay serves frontend source with Vite HMR and bind-mounts backend and Ansible files. Routine startup uses `--no-build`; JS, playbook, and Ansible config edits are visible without rebuilding. API code changes reload automatically; restart the worker service to load worker code changes, without rebuilding its image. The first switch from production services recreates only API, worker, and frontend containers to apply the mounts; PostgreSQL and its volume are preserved. Do not use the dev overlay for production deployment.

## Upgrade and rollback

1. Back up the database and environment file.
2. Review the code and Alembic migration.
3. Apply migrations explicitly.
4. Deploy API, worker, then frontend.
5. Verify `/health`, `/ready`, login, a mock job in a staging environment, and logs.
6. If rollback is needed, restore the prior code and use a reviewed database restore/migration plan. Do not blindly downgrade production schema.
