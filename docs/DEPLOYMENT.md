# Deployment

Real Ansible execution must run on the Linux automation host that can route to the registered Windows targets. Replit is for development and mock execution only.

## Host installation

```bash
sudo useradd --system --home /opt/windows-automation --shell /usr/sbin/nologin windows-automation
sudo install -d -o windows-automation -g windows-automation /opt/windows-automation
sudo install -d -o windows-automation -g windows-automation /opt/windows-automation/var
```

Deploy the project to `/opt/windows-automation`, then run `bash scripts/setup_linux.sh`. Create `/etc/windows-automation.env` with `root:windows-automation` ownership and mode `0640`. Set production secrets outside Git. Run migrations explicitly with `scripts/initialize_database.sh`.

## Frontend and API

Build the UI from the monorepo:

```bash
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/windows-automation-portal run build
```

Serve `artifacts/windows-automation-portal/dist/public` with Nginx. Configure `/api/` to proxy to the FastAPI service on loopback port 8000. Set `FRONTEND_URL` to the exact HTTPS origin.

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

## Upgrade and rollback

1. Back up the database and environment file.
2. Review the code and Alembic migration.
3. Apply migrations explicitly.
4. Deploy API, worker, then frontend.
5. Verify `/health`, `/ready`, login, a mock job in a staging environment, and logs.
6. If rollback is needed, restore the prior code and use a reviewed database restore/migration plan. Do not blindly downgrade production schema.
