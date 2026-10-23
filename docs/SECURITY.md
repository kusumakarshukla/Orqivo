# Security

- Keep `MOCK_MODE=true` for Replit and local development.
- For real execution, use a dedicated least-privilege Windows service account, internal-CA certificate validation, and a firewall allowlist from the Linux automation host to TCP 5986.
- Set `ANSIBLE_ENABLED=true` only on the Linux host after network, credentials, certificates, and playbooks are reviewed.
- Store session, CSRF, and Windows credentials in a secret manager or protected environment file. Do not commit `.env`.
- Configure all three development passwords through Replit Secrets; never use a shared/default password.
- Use a unique, random `SESSION_SECRET` and `CSRF_SECRET` in production and rotate them through the approved process.
- API users cannot supply commands, paths, inventories, vault files, or arbitrary Ansible variables.
- Server and automation administration is restricted to admins and audited with before/after data. Secret-like keys are redacted.
- Job output is sanitized before storage and before display. Review any new script output fields before exposing them.
- CSV export escapes formula-leading characters.
- Disable public API docs in production unless explicitly approved.
- Add TLS, rate limiting at the edge, backups, monitoring, patch management, and a formal review of the Windows service allowlist before go-live.
- The Windows PowerShell service restart is a state-changing operation. Validate it in a non-production environment first.

The initial development-account login is not a production identity provider. Microsoft Entra ID OIDC is not implemented or simulated. Add it only with approved tenant, app, callback, and certificate/secret configuration.
