# Linux Ansible setup

Run these steps on the Linux automation host, not on a local development workstation.

```bash
cd /opt/windows-automation
python3.12 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/ansible-galaxy collection install -r ansible/collections/requirements.yml
.venv/bin/ansible-playbook --version
```

Create a protected environment file readable only by the service account. Provide `DATABASE_URL`, `SESSION_SECRET`, `CSRF_SECRET`, `WINDOWS_USERNAME`, `WINDOWS_PASSWORD`, and the Ansible paths there. Do not place credentials in inventory files, source control, shell history, or chat. Do not use the Azure VM's local `azureuser` account as the domain automation identity. Use the exact UPN of a dedicated, least-privilege AD service account; never use Domain Admin.

## Azure domain controller over Kerberos

Live AD demo automation is separately gated and limited to the configured demo OU. Keep it disabled until the non-production target, OU, service identity, and playbooks are configured and reviewed.

Before attempting a connection, have the AD/network administrators confirm:

- The Linux worker can resolve the domain controller FQDN and reach its configured WinRM endpoint.
- The worker can reach the approved domain DNS/KDC (DNS TCP/UDP 53 and Kerberos TCP/UDP 88); its clock is synchronized to the domain's approved time source.
- WinRM HTTPS is configured with a certificate whose SAN matches the exact registered FQDN, and the internal CA chain is available as a PEM file.
- The automation identity has only the required WinRM/read permissions. Do not grant Domain Admin. Do not use the local Azure provisioning account.
- The host's `/etc/krb5.conf` contains the organization's approved realm/KDC mapping.

For Docker Compose, copy the approved Kerberos config and CA bundle to root-controlled paths on the Linux VM, then set the non-secret file paths in `.env`:

```text
WINDOWS_WINRM_TRANSPORT=kerberos
WINDOWS_USERNAME=<exact AD UPN provided by the AD administrator>
WINDOWS_PASSWORD=<inject through the root-owned protected environment file or approved secret manager>
KRB5_CONFIG_FILE=/etc/windows-automation/krb5.conf
WINDOWS_CA_CERTIFICATE_FILE=/etc/windows-automation/domain-ca-chain.pem
```

Never put an actual password in a command, source file, or chat. Restrict `.env` and certificate/config files to the service administrator (`chmod 600` for `.env`; keep the CA and Kerberos config root-owned and non-writable by the application user). Start with the Kerberos override:

```bash
docker compose -f docker-compose.yml -f docker-compose.kerberos.yml config
docker compose -f docker-compose.yml -f docker-compose.kerberos.yml build api worker
```

For normal targets, register the DC with its exact FQDN, WinRM HTTPS enabled, port 5986, and certificate validation set to `validate`. Do not select `ignore` or use an IP in place of the certificate-matching hostname.

Only after the firewall and identity are approved, use a maintenance window to set `MOCK_MODE=false` and `ANSIBLE_ENABLED=true` in the protected environment, then recreate the API and worker with the same Compose files. Run the administrator connection test first. A successful mock result is not a network test. If it passes, test the read-only health/disk catalogues against a non-production target first. The live API rejects non-read-only job submissions during this initial phase.

Use **Run approved automation** to create a job for the worker. TechHub account creation and Disable AD Account submissions queue directly to Ansible with no review step when the demo configuration is complete. Older unlinked account-creation requests can be queued from **Job History** after reviewing their details. BitLocker requests remain review-only. Jobs are rejected if the worker heartbeat is stale, the target is invalid, the demo OU is unset, or live mode is disabled. Credentials are supplied only through the protected service environment/secret manager; there is no browser field for an Ansible password. Register the target by its certificate-matching DNS FQDN, never by its public IP.

The existing health/disk playbooks call scripts under `C:\Automation`; install only the reviewed scripts and grant the service identity read/execute access. The connection test itself uses `ansible.windows.win_ping` and does not change domain state.

## Non-production AD account demo

Account create and disable forms execute automatically only when the demo flag is enabled and a valid target and OU are configured. All creates use the configured OU; disables search only within that OU and reject accounts outside it. The registered target must be active, labeled `development` or `test`, and use a DNS name, not an IP address. Normally use validated WinRM HTTPS on TCP 5986. A temporary HTTP exception is available only for the configured demo target when `AD_ACCOUNT_STATE_TEST_ALLOW_HTTP=true`, using NTLM with WinRM message encryption required on TCP 5985. This removes TLS server-certificate validation and remains vulnerable to NTLM relay; use it only on a trusted network, restrict the VM firewall/NSG to the automation host's fixed source IP, never expose 5985 publicly, and switch back to HTTPS/5986 as soon as possible. `AD_ACCOUNT_STATE_TEST_SERVER_NAME` is the registered server name, not its IP address.

Before enabling, create a dedicated non-production OU and verify the service identity has only the required rights in that OU. The API's OU setting is the boundary for both creation and disable operations. The playbook creates enabled accounts with a randomly generated initial password that is not returned or logged, and requires a password change at next logon. No additional group membership is assigned. Set the following in the protected service environment; never put a password or user credentials in the browser or a playbook:

```text
MOCK_MODE=false
ANSIBLE_ENABLED=true
AD_ACCOUNT_STATE_TEST_MODE=true
AD_ACCOUNT_STATE_TEST_SERVER_NAME=<registered-non-production-server-name>
AD_ACCOUNT_STATE_TEST_ALLOW_HTTP=true
AD_DEMO_OU_DN=OU=Test,DC=corp,DC=contoso,DC=com
```

`enable_stale_account` remains intake-only. The runner independently checks the feature flag, target name/environment, configured transport/port, and OU. For HTTPS it requires certificate validation on 5986; HTTP is accepted only for the configured demo target, on 5985, with NTLM message encryption. Other targets always require HTTPS. The create playbook creates only within the configured OU; the disable playbook validates the SamAccountName and resolves the object using the OU as its search base. Request history links to job status so the demo can show queued/running/success/failure.

The target needs the Active Directory PowerShell module. Deploy `powershell/Create-PermanentAccount.ps1`, `powershell/Create-ConsultantAccount.ps1`, and `powershell/Disable-ADAccount.ps1` to their matching fixed paths under `C:\Automation` on the non-production target. The create playbook selects one of the two fixed account scripts based only on the validated `account_type`; each script creates only inside the configured demo OU. The disable script accepts only `SamAccountName`; its playbook sets the configured demo OU in the remote process environment, so the script can constrain its lookup without accepting an OU parameter. Ansible's `win_powershell` task invokes the deployed script through a fixed `Invoke-Command -ScriptBlock` on the target (not a second WinRM hop). `Write-Host` progress messages are forwarded from `host_out`; the worker extracts them from Ansible output so successful job stdout contains the PowerShell messages rather than Ansible task logs. Ansible diagnostics are retained when a run fails.

After configuring the protected environment and registering the certificate-matching DNS target, apply the schema migration and restart the app:

```bash
docker compose build api worker frontend
docker compose run --rm api alembic upgrade head
docker compose run --rm api python -m app.seed
docker compose up -d --no-deps api worker frontend
```

Test only with disposable demo accounts. Never use this path for production account changes. Set `AD_DEMO_OU_DN` only in the protected runtime environment. Do not enable live demo mode while `AD_ACCOUNT_STATE_TEST_SERVER_NAME` still contains an IP address or an untrusted target.

Check playbooks before connecting:

```bash
for file in ansible/playbooks/*.yml; do
  .venv/bin/ansible-playbook --syntax-check -i ansible/inventory/development.yml "$file"
done
```

For a controlled connectivity test, run from the host that can reach Windows:

```bash
ANSIBLE_CONFIG=/opt/windows-automation/ansible/ansible.cfg \
WINDOWS_USERNAME='DOMAIN\\automation-service' \
WINDOWS_PASSWORD='(read from a protected secret source; do not type into shell history)' \
.venv/bin/ansible-playbook \
  -i ansible/inventory/production.example.yml \
  ansible/playbooks/test_windows_connection.yml \
  --limit win-server-01
```

The command above shows the variable names only. Use a secret manager or an environment file loaded by the service manager; do not put a real value into shell history.

Manual safe playbook checks:

```bash
.venv/bin/ansible-playbook --syntax-check ansible/playbooks/restart_windows_service.yml
.venv/bin/ansible-playbook --syntax-check ansible/playbooks/get_server_health.yml
.venv/bin/ansible-playbook --syntax-check ansible/playbooks/get_disk_space.yml
```

For a real run, submit through the portal after registering the target and credentials. The API creates a temporary one-target inventory and a validated JSON extra-vars file. Review `docs/SECURITY.md` first.
