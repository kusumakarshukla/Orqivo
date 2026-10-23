# Database

PostgreSQL is the system of record. SQLAlchemy 2.x models and Alembic migrations are in `backend/`; the Replit preview uses the shared PostgreSQL database through Drizzle.

## Tables

`roles`, `users`, `user_sessions`, `servers`, `automation_definitions`, `jobs`, `job_events`, `audit_logs`, `application_settings`, and `worker_heartbeat`.

Indexes cover job status/time/requester/server/automation, event job/time, audit time/action, active servers, and active/risk-filtered automations.

## Initialize or update

```bash
cd backend
PYTHONPATH=. ../.venv/bin/alembic upgrade head
PYTHONPATH=. ../.venv/bin/python -m app.seed
```

The seed operation is idempotent. Set the three `DEV_*_PASSWORD` secrets before seeding accounts. A missing development password leaves that seeded account disabled for login until configured.

Never use startup-time DDL in production. Review migrations and take a verified backup before schema upgrades.
