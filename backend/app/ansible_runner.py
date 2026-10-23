import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from app.core.config import settings
from app.core.security import sanitize_text
from app.db.models import AutomationDefinition, Server

PLAYBOOK_REGISTRY = {
    "restart_windows_service": "playbooks/restart_windows_service.yml",
    "get_server_health": "playbooks/get_server_health.yml",
    "get_disk_space": "playbooks/get_disk_space.yml",
    "test_windows_connection": "playbooks/test_windows_connection.yml",
}
SCRIPT_REGISTRY = {
    "restart_windows_service": "Restart-WindowsService.ps1",
    "get_server_health": "Get-ServerHealth.ps1",
    "get_disk_space": "Get-DiskSpace.ps1",
    "test_windows_connection": "test_windows_connection.yml",
}
SAFE_SERVER_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SAFE_HOSTNAME = re.compile(r"^[A-Za-z0-9.-]{1,253}$")


def validate_registered_automation(automation: AutomationDefinition) -> str:
    playbook = PLAYBOOK_REGISTRY.get(automation.playbook_key)
    script = SCRIPT_REGISTRY.get(automation.powershell_script_key)
    if not playbook or not script or automation.playbook_key != automation.powershell_script_key:
        raise ValueError("Automation definition does not reference an approved playbook and script.")
    return playbook


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
    if not SAFE_SERVER_NAME.fullmatch(server.name) or not SAFE_HOSTNAME.fullmatch(server.hostname):
        raise ValueError("The target server is not valid for Ansible execution.")
    if server.use_https and server.winrm_port != 5986:
        raise ValueError("WinRM HTTPS must use port 5986.")
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
                                "ansible_winrm_scheme": "https",
                                "ansible_winrm_transport": settings.windows_winrm_transport,
                                "ansible_winrm_server_cert_validation": server.certificate_validation,
                                "ansible_user": "{{ lookup('env', 'WINDOWS_USERNAME') }}",
                                "ansible_password": "{{ lookup('env', 'WINDOWS_PASSWORD') }}",
                            }
                        }
                    }
                }
            }
        }
        inventory_file = temp_path / "inventory.json"
        vars_file = temp_path / "vars.json"
        inventory_file.write_text(json.dumps(inventory), encoding="utf-8")
        vars_file.write_text(
            json.dumps({"target_host": server.name, **parameters}),
            encoding="utf-8",
        )
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
            return {
                "return_code": completed.returncode,
                "stdout": sanitize_text(completed.stdout),
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
