# Redeploying Code Changes

Run these commands from the project root, where `docker-compose.yml` and `.env` are located.

## Rebuild and deploy all application services

```bash
docker compose build api worker frontend
```

If the change includes a database migration, apply it using the newly built API image:

```bash
docker compose run --rm --no-deps api alembic upgrade head
```

If the change adds or updates seeded automation definitions, run the seed command:

```bash
docker compose run --rm --no-deps api alembic upgrade head
docker compose run --rm --no-deps api python -m app.seed
docker compose up -d --no-deps --force-recreate api worker frontend

```

Recreate the application services:

```bash
docker compose up -d --no-deps --force-recreate api worker frontend
```

This leaves PostgreSQL running and preserves its data volume.

## Frontend-only change

For a frontend-only change, rebuild and recreate only the frontend:

```bash
docker compose up -d --build --no-deps --force-recreate frontend
```

## Verify the deployment

```bash
docker compose ps
docker compose logs --tail=100 api worker
curl -I http://localhost:8080/
docker compose exec -T api python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/ready').read().decode())"
```

The readiness response should report the database connected and worker online.

## Important precautions

- Back up the database before applying production migrations.
- Check for pending jobs before restarting the worker. When live Ansible is enabled, the worker may pick up queued jobs after it starts.
- Keep `.env` and all credentials private. Do not paste secrets into commands, chat, logs, or source control.
- Do not run `startup.sh` for redeployment: it starts with `docker compose down -v`, which removes the PostgreSQL data volume.
- Do not use `docker compose down -v` to restart or update the application.
