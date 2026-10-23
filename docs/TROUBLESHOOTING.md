# Troubleshooting

## Login fails

Use the seeded emails `admin@example.com`, `operator@example.com`, and `viewer@example.com`. Passwords must be configured as `DEV_ADMIN_PASSWORD`, `DEV_OPERATOR_PASSWORD`, and `DEV_VIEWER_PASSWORD` in Replit Secrets or the protected Linux environment, then restart the API and rerun the idempotent seed. No default passwords are provided.

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

## Database or migration failure

Confirm `DATABASE_URL`, network access, database health, and migration revision. Back up before applying a production migration.

## Browser/API or CORS failure

Confirm Nginx proxies `/api/` unchanged, `FRONTEND_URL` exactly matches the browser origin, cookies are enabled, and HTTPS is used in production. Inspect response status and correlation ID.

## Nginx 502 or systemd failure

Check `systemctl status`, `journalctl`, upstream bind address, environment-file permissions, Python path, and port 8000 availability. Do not expose the API port directly to the Internet.
