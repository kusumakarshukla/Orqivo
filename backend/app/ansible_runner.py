import base64
import binascii
import json
import os
import re
import subprocess
import tempfile
from ipaddress import ip_address
from pathlib import Path
from typing import Any

from app.core.config import settings
from app.core.security import sanitize_text
from app.db.models import AutomationDefinition, Server

SAFE_SERVER_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SAFE_HOSTNAME = re.compile(r"^[A-Za-z0-9.-]{1,253}$")

PLAYBOOK_REGISTRY = {
    "restart_windows_service": "playbooks/restart_windows_service.yml",
    "get_server_health": "playbooks/get_server_health.yml",
    "get_disk_space": "playbooks/get_disk_space.yml",
    "test_windows_connection": "playbooks/test_windows_connection.yml",
    "disable_ad_account_test": "playbooks/disable_ad_account.yml",
    "create_ad_account_test": "playbooks/create_ad_account.yml",
    "disable_ad_account": "playbooks/disable_ad_account.yml",
    "create_ad_account": "playbooks/create_ad_account.yml",
}
SCRIPT_REGISTRY = {
    "restart_windows_service": "Restart-WindowsService.ps1",
    "get_server_health": "Get-ServerHealth.ps1",
    "get_disk_space": "Get-DiskSpace.ps1",
    "test_windows_connection": "test_windows_connection.yml",
    "disable_ad_account_test": "Disable-ADAccount.ps1",
    "create_ad_account_test": "Create-PermanentAccount.ps1",
    "disable_ad_account": "Disable-ADAccount.ps1",
    "create_ad_account": "Create-PermanentAccount.ps1",
}
SAFE_SERVER_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SAFE_HOSTNAME = re.compile(r"^[A-Za-z0-9.-]{1,253}$")
DEMO_ACCOUNT_AUTOMATIONS = frozenset({
    "disable_ad_account_test",
    "create_ad_account_test",
    "disable_ad_account",
    "create_ad_account",
})
POWERSHELL_OUTPUT_MARKER = "ORQIVO_POWERSHELL_OUTPUT="


def extract_powershell_host_output(stdout: str) -> str | None:
    marker_index = stdout.find(POWERSHELL_OUTPUT_MARKER)
    if marker_index < 0:
        return None

    encoded_start = marker_index + len(POWERSHELL_OUTPUT_MARKER)
    encoded_end = encoded_start
    while encoded_end < len(stdout) and stdout[encoded_end] in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=":
        encoded_end += 1

    try:
        return base64.b64decode(stdout[encoded_start:encoded_end], validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError) as exc:
        raise RuntimeError("Ansible returned invalid encoded PowerShell host output.") from exc


def validate_registered_automation(automation: AutomationDefinition) -> str:
    playbook = PLAYBOOK_REGISTRY.get(automation.playbook_key)
    script = SCRIPT_REGISTRY.get(automation.powershell_script_key)
    if not playbook or not script or automation.playbook_key != automation.powershell_script_key:
        raise ValueError(
            "Automation definition has an unapproved playbook/script key pair "
            f"({automation.playbook_key!r}, {automation.powershell_script_key!r}); "
            "run the application seed command to reconcile built-in automation keys."
        )
    return playbook


def connection_test_automation() -> AutomationDefinition:
    return AutomationDefinition(
        playbook_key="test_windows_connection",
        powershell_script_key="test_windows_connection",
        code="test_windows_connection",
        name="Test Windows Connection",
        description="Internal connection test",
        parameter_schema=[],
        risk_level="low",
        timeout_seconds=30,
        required_role="admin",
        requires_change_number=False,
        requires_confirmation=False,
        is_active=True,
    )


def execute_playbook(
    automation: AutomationDefinition,
    server: Server,
    parameters: dict[str, Any],
    timeout_seconds: int,
) -> dict[str, Any]:
    playbook = validate_registered_automation(automation)
    if not settings.ansible_enabled:
        raise RuntimeError("Real automation is disabled. Enable it on the Linux automation host.")
    if not settings.windows_username or not settings.windows_password:
        raise RuntimeError("Windows credentials are not configured on the Linux automation host.")
    transport = settings.windows_winrm_transport.lower()
    if transport not in {"kerberos", "ntlm"}:
        raise RuntimeError("Only the approved Kerberos or NTLM WinRM transports are supported.")
    if transport == "kerberos" and "@" not in settings.windows_username:
        raise RuntimeError("Kerberos requires the Windows username to be the account's UPN.")
    krb5_config = os.environ.get("KRB5_CONFIG")
    if transport == "kerberos" and (
        not krb5_config
        or not Path(krb5_config).is_absolute()
        or not Path(krb5_config).is_file()
        or not os.access(krb5_config, os.R_OK)
    ):
        raise RuntimeError("Kerberos requires a readable KRB5_CONFIG file on the automation host.")

    if not SAFE_SERVER_NAME.fullmatch(server.name) or not SAFE_HOSTNAME.fullmatch(server.hostname):
        raise ValueError("The target server is not valid for Ansible execution.")
    try:
        ip_address(server.hostname)
    except ValueError:
        pass
    else:
        raise ValueError("The target must use a DNS hostname, not an IP address.")


    workdir = Path(settings.ansible_working_directory).resolve()
    if not workdir.is_absolute():
        raise RuntimeError("Ansible working directory must be an absolute path.")
    approved_playbook = (workdir / playbook).resolve()
    if workdir not in approved_playbook.parents:
        raise RuntimeError("Resolved playbook path is outside the approved Ansible directory.")

    with tempfile.TemporaryDirectory(prefix="windows-automation-") as temp_dir:
        temp_path = Path(temp_dir)
        inventory = {
            "all": {
                "children": {
                    "windows": {
                        "hosts": {
                            server.name: {
                                "ansible_host": server.hostname,
                                "ansible_connection": "winrm",
                                "ansible_port": server.winrm_port,
                                "ansible_winrm_scheme": "https" if server.use_https else "http",
                                "ansible_winrm_transport": transport,
                                "ansible_user": "{{ lookup('env', 'WINDOWS_USERNAME') }}",
                                # Ansible's required variable is resolved only from the protected process environment.
                                "ansible_password": "{{ lookup('env', 'WINDOWS_PASSWORD') }}"
                            }
                        }
                    }
                }
            }
        }
        host_vars = inventory["all"]["children"]["windows"]["hosts"][server.name]
        if server.use_https:
            host_vars["ansible_winrm_server_cert_validation"] = "validate"
        else:
            host_vars["ansible_winrm_message_encryption"] = "always"
        inventory_file = temp_path / "inventory.json"
        vars_file = temp_path / "vars.json"
        inventory_file.write_text(json.dumps(inventory), encoding="utf-8")
        extra_vars = {"target_host": server.name, **parameters}
        if automation.playbook_key in DEMO_ACCOUNT_AUTOMATIONS:
            if not settings.ad_account_state_test_mode or not settings.ad_demo_ou_dn:
                raise RuntimeError("AD account scripts require the guarded demo mode and configured OU.")
            if (
                server.name != settings.ad_account_state_test_server_name
                or server.environment.casefold() not in {"development", "test"}
            ):
                raise RuntimeError("AD account scripts are restricted to the configured non-production target.")
            extra_vars["demo_ou_dn"] = settings.ad_demo_ou_dn

        vars_file.write_text(json.dumps(extra_vars), encoding="utf-8")
        inventory_file.chmod(0o600)
        vars_file.chmod(0o600)
        environment = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": os.environ.get("HOME", "/tmp"),
            "ANSIBLE_CONFIG": settings.ansible_config,
            "ANSIBLE_NOCOLOR": "1",
            "WINDOWS_USERNAME": settings.windows_username,
            "WINDOWS_PASSWORD": settings.windows_password,
        }
        if transport == "kerberos":
            environment["KRB5_CONFIG"] = krb5_config
        command = [
            settings.ansible_binary,
            "-i",
            str(inventory_file),
            str(approved_playbook),
            "--limit",
            server.name,
            "--extra-vars",
            f"@{vars_file}",
        ]
        try:
            completed = subprocess.run(
                command,
                cwd=workdir,
                env=environment,
                capture_output=True,
                text=True,
                timeout=min(max(timeout_seconds, 1), 3600),
                check=False,
                shell=False,
            )
            stdout = completed.stdout
            if automation.playbook_key in DEMO_ACCOUNT_AUTOMATIONS:
                powershell_output = extract_powershell_host_output(stdout)
                if powershell_output is not None:
                    stdout = powershell_output
                elif completed.returncode == 0:
                    stdout = ""
            return {
                "return_code": completed.returncode,
                "stdout": sanitize_text(stdout),
                "stderr": sanitize_text(completed.stderr),
            }
        except subprocess.TimeoutExpired as exc:
            return {
                "return_code": 124,
                "stdout": sanitize_text(exc.stdout),
                "stderr": "Ansible execution exceeded the configured timeout.",
            }
        except OSError as exc:
            return {
                "return_code": 1,
                "stdout": "",
                "stderr": sanitize_text(f"Ansible could not start: {exc.strerror or 'execution error'}"),
            }
