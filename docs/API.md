# API

All portal routes are versioned under `/api/v1`. JSON errors use a safe message; no stack trace, filesystem detail, credentials, or command strings are returned.

## Authentication

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`

Authentication uses the `wap_session` HTTP-only cookie. Mutations require the `wap_csrf` cookie value in `X-CSRF-Token`.

## Main resources

- Dashboard: `GET /api/v1/dashboard/summary`, `GET /api/v1/dashboard/activity`
- Automations: `GET /api/v1/automations`, `GET /api/v1/automations/{id}`, `POST /api/v1/automations`, `PUT /api/v1/automations/{id}`, `PATCH /api/v1/automations/{id}/status`
- Servers: `GET /api/v1/servers`, `GET /api/v1/servers/{id}`, `POST /api/v1/servers`, `PUT /api/v1/servers/{id}`, `PATCH /api/v1/servers/{id}/status`, `POST /api/v1/servers/{id}/test-connection`
- Jobs: `POST /api/v1/jobs`, `GET /api/v1/jobs`, `GET /api/v1/jobs/{id}`, `GET /api/v1/jobs/{id}/events`, `POST /api/v1/jobs/{id}/cancel`, `POST /api/v1/jobs/{id}/retry`, `GET /api/v1/jobs/{id}/log`, `GET /api/v1/jobs/export`
- Audit: `GET /api/v1/audit-logs`
- Health: `GET /health`, `GET /ready`; Replit adapter also exposes `/api/healthz`.

Job creation returns `202 Accepted`. The worker updates the status asynchronously. List endpoints accept pagination and filters; CSV export includes sanitized fields only and escapes spreadsheet formula prefixes.

## Job states

`pending`, `validating`, `queued`, `running`, `successful`, `failed`, `cancelled`, `timed_out`.

## Example request

```json
{
  "automation_id": "registered-automation-uuid",
  "server_id": "registered-server-uuid",
  "parameters": {"service_name": "Spooler"},
  "change_number": "CHG-12345",
  "business_reason": "Restore approved print service operation",
  "confirmed": true
}
```

Do not copy the sample UUIDs literally. Use IDs returned by the catalogue and server endpoints.
