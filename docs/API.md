# API

All portal routes are versioned under `/api/v1`. JSON errors use a safe message; no stack trace, filesystem detail, credentials, or command strings are returned.

## Authentication

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`

Authentication uses the `wap_session` HTTP-only cookie. Mutations require the `wap_csrf` cookie value in `X-CSRF-Token`.

## Main resources

- Dashboard: `GET /api/v1/dashboard/summary`, `GET /api/v1/dashboard/activity`
- Admin analytics: `GET /api/v1/admin/automation-tracker?year=2026&month=1`
- Automations: `GET /api/v1/automations`, `GET /api/v1/automations/{id}`, `POST /api/v1/automations`, `PUT /api/v1/automations/{id}`, `PATCH /api/v1/automations/{id}/status`
- Servers: `GET /api/v1/servers`, `GET /api/v1/servers/{id}`, `POST /api/v1/servers`, `PUT /api/v1/servers/{id}`, `PATCH /api/v1/servers/{id}/status`, `POST /api/v1/servers/{id}/test-connection`
- Jobs: `POST /api/v1/jobs`, `GET /api/v1/jobs`, `GET /api/v1/jobs/{id}`, `GET /api/v1/jobs/{id}/events`, `POST /api/v1/jobs/{id}/cancel`, `POST /api/v1/jobs/{id}/retry`, `GET /api/v1/jobs/{id}/log`, `GET /api/v1/jobs/export`
- Active Directory request intake/history: `POST /api/v1/account-state-requests`, `GET /api/v1/account-state-requests`
- TechHub request intake/history: `POST /api/v1/catalogue-requests`, `GET /api/v1/catalogue-requests`, `POST /api/v1/catalogue-requests/{id}/execute`
- Audit: `GET /api/v1/audit-logs`
- Health: `GET /health`, `GET /ready`.

Job creation returns `202 Accepted`. The worker updates the status asynchronously. List endpoints accept pagination and filters; CSV export includes sanitized fields only and escapes spreadsheet formula prefixes.

Account-state submissions require an operator or administrator session and a valid CSRF token. `action` must be `disable_ad_account` or `enable_stale_account`; `sam_account_name` is limited to 1–20 ASCII letters, numbers, periods, underscores, hyphens, or dollar signs. With demo execution enabled, a disable request queues a job only for the configured non-production server and is constrained to accounts inside `AD_DEMO_OU_DN`. Otherwise the endpoint returns `503` without recording a review request. `enable_stale_account` remains intake-only. `GET /api/v1/account-state-requests` returns the 100 most recent records visible to the caller and includes job status/linkage.

TechHub account-creation and BitLocker requests require an operator or administrator session and valid CSRF token. The `catalogue` discriminator selects `create_permanent_account`, `create_consultant_account`, or `bitlocker_key_retrieval`; each form is validated against its own field and dropdown constraints. When non-production account execution is enabled and healthy, permanent/consultant account requests queue an approved job confined to `AD_DEMO_OU_DN`. Otherwise, requests remain `submitted_for_review`. An operator can queue an existing, unlinked account-creation request with `POST /api/v1/catalogue-requests/{id}/execute`; this is limited to the caller's own requests unless the caller is an administrator. Both paths require `MOCK_MODE=false`, `ANSIBLE_ENABLED=true`, the demo flag, a live worker, and the registered non-production target. BitLocker requests remain review-only and do not retrieve keys. `GET /api/v1/catalogue-requests` returns up to 100 recent records and includes job status/linkage.

The Automation Tracker endpoint is administrator-only. `year` and `month` select a calendar month; daily request trends report automation job submissions, account-state requests, and TechHub catalogue intake requests separately. Execution success/failure and average duration use completed jobs submitted during the selected month; timed-out jobs count as failures, and cancelled jobs are reported separately. The response also includes cumulative YTD completed-job metrics through the selected month and the five most-executed catalogues for that month.

```json
{
  "action": "disable_ad_account",
  "sam_account_name": "jsmith"
}
```

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
