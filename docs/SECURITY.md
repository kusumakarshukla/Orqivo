# Security

- Keep `MOCK_MODE=true` for local development.
- For real execution, use a dedicated least-privilege AD service identity with Kerberos, internal-CA certificate validation, and a firewall allowlist from the Linux automation host to WinRM HTTPS TCP 5986 plus approved DNS/KDC/time services. Never use a domain administrator or local Azure provisioning account.
- Set `ANSIBLE_ENABLED=true` only on the Linux host after network, credentials, certificates, and playbooks are reviewed.
- Store session, CSRF, and Windows credentials in a secret manager or root-owned protected environment file. Do not commit `.env` or send secrets in chat, tickets, or shell history.
- Configure all three development passwords through a protected environment; never use a shared/default password.
- Use a unique, random `SESSION_SECRET` and `CSRF_SECRET` in production and rotate them through the approved process.
- API users cannot supply commands, paths, inventories, vault files, or arbitrary Ansible variables.
- Server and automation administration is restricted to admins and audited with before/after data. Secret-like keys are redacted.
- Job output is sanitized before storage and before display. Review any new script output fields before exposing them.
- CSV export escapes formula-leading characters.
- Disable public API docs in production unless explicitly approved.
- Add TLS, rate limiting at the edge, backups, monitoring, patch management, and a formal review of the Windows service allowlist before go-live.
- The Windows PowerShell service restart is a state-changing operation. Validate it in a non-production environment first.
- Account create/disable demo jobs are restricted to one registered development/test target and the protected `AD_DEMO_OU_DN`; disable lookups use that OU as their search base. Keep the service identity's AD permissions scoped to that OU, do not add arbitrary groups, and use only disposable demo accounts. The random initial password is not returned or logged and must be changed at first logon.
- BitLocker retrieval remains review-only. Do not enable the account demo against production or an AD environment connected to production accounts.

Azure Entra ID SSO uses the configured single tenant and authorization-code flow. Keep the client secret in a secret manager, register only the exact HTTPS callback, and configure the three portal role group object IDs. SSO users must be members of a configured group; group claims overage is denied rather than granting a default role. Roles are synchronized from group membership at each login, and inactive portal users remain blocked. Normal password login remains available as a separate option.
