# Troubleshooting

## Login fails

Use the seeded emails `admin@example.com`, `operator@example.com`, and `viewer@example.com`. Passwords must be configured as `DEV_ADMIN_PASSWORD`, `DEV_OPERATOR_PASSWORD`, and `DEV_VIEWER_PASSWORD` in a protected environment, then restart the API and rerun the idempotent seed. No default passwords are provided.

## WinRM connection refused

Confirm the Windows host resolves from Linux, the HTTPS listener is active on 5986, the Windows firewall allows the Linux source IP, and any network ACL permits the route. Run `Test-WSMan -UseSSL -Port 5986` from Linux.

## Certificate validation failure

Check the certificate expiry, SAN/hostname match, thumbprint, internal CA chain, and Linux trust store. Do not set validation to ignore as a production workaround.

## Authentication, NTLM, or Kerberos failure

Verify the configured service account, domain format, account permissions, authentication transport compatibility, clock synchronization, and Windows event logs. Never place a password in command-line arguments or inventory.

## Missing Ansible collection or pywinrm

Run `bash scripts/install_ansible.sh`, confirm the active Python environment, and check `ansible-galaxy collection list` for `ansible.windows`.

## Script path or permission failure

Confirm the scripts are installed in `C:\Automation`, the spelling is exact, and the service account has read/execute rights. Review PowerShell logs locally.

## Job stuck in running

Check worker heartbeat with `/ready`, inspect `journalctl -u windows-automation-worker`, and check whether an Ansible process exceeded its timeout. After a crash, review the job and worker policy before requeueing.

## Job was submitted but Ansible did not run

TechHub account creation and Disable AD Account queue executable jobs directly when the protected demo configuration is complete; BitLocker requests remain review-only. Check `/ready` and confirm `worker_online` is true.

The default `MOCK_MODE=true` simulates jobs and does not invoke Ansible. Live execution additionally requires `ANSIBLE_ENABLED=true`, `AD_ACCOUNT_STATE_TEST_MODE=true`, `AD_DEMO_OU_DN` set to the demo OU, the approved Linux worker's protected credentials, and a registered active development/test target using its certificate-matching DNS name, WinRM HTTPS on 5986, and certificate validation. Do not enter credentials in the browser or connect by public IP. If the setting is absent or invalid, account create/disable returns HTTP 503 without creating a review item. Keep the service identity scoped to the demo OU; account creation and disable playbooks enforce that OU boundary.

## Database or migration failure

Confirm `DATABASE_URL`, network access, database health, and migration revision. Back up before applying a production migration.

## Browser/API or CORS failure

In local development, start the FastAPI service and confirm the Vite `/api` proxy targets its address (default `http://127.0.0.1:8000`; override with `API_PROXY_TARGET`). For Docker deployment, confirm Nginx proxies `/api/` unchanged. The browser's exact origin must be listed in `ALLOWED_ORIGINS` (comma-separated); if unset, `FRONTEND_URL` is used. Use the browser address such as `http://localhost:3000`, not a bind address such as `http://0.0.0.0:3000`. Cookies must be enabled, and HTTPS must be used in production. Inspect response status and correlation ID.

## Nginx 502 or systemd failure

Check `systemctl status`, `journalctl`, upstream bind address, environment-file permissions, Python path, and port 8000 availability. Do not expose the API port directly to the Internet.
