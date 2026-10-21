from sqlalchemy import select

from app.core.config import settings
from app.core.security import hash_password
from app.db.models import AutomationDefinition, Role, Server, User
from app.db.session import SessionLocal

ROLE_DATA = [
    ("admin", "Manage servers, automations, and audit history", ["view", "submit", "retry", "manage_servers", "manage_automations", "audit"]),
    ("operator", "Run approved automations and review execution history", ["view", "submit", "retry"]),
    ("viewer", "View the dashboard, catalogue, and permitted job history", ["view"]),
]
USER_DATA = [
    ("admin@example.com", "Admin User", "admin", settings.dev_admin_password),
    ("operator@example.com", "Operator User", "operator", settings.dev_operator_password),
    ("viewer@example.com", "Viewer User", "viewer", settings.dev_viewer_password),
]
SERVER_DATA = [
    ("win-server-01", "Windows Server 01", "win-server-01.invalid"),
    ("win-server-02", "Windows Server 02", "win-server-02.invalid"),
]

AUTOMATIONS = [
    {
        "code": "restart_windows_service",
        "name": "Restart Windows Service",
        "description": "Restart or start an approved Windows service and verify its final state.",
        "playbook_key": "restart_windows_service",
        "powershell_script_key": "restart_windows_service",
        "parameter_schema": [{
            "name": "service_name", "label": "Service", "type": "select", "required": True,
            "options": ["Spooler", "W32Time", "Dnscache", "LanmanServer"],
        }],
        "risk_level": "medium", "timeout_seconds": 300, "required_role": "operator",
        "requires_change_number": True, "requires_confirmation": True, "is_active": True,
        "target_os": "Windows Server", "expected_minutes": 3,
    },
    {
        "code": "get_server_health",
        "name": "Get Windows Server Health",
        "description": "Collect operating-system, uptime, CPU, memory, and service-health information.",
        "playbook_key": "get_server_health", "powershell_script_key": "get_server_health",
        "parameter_schema": [], "risk_level": "low", "timeout_seconds": 180,
        "required_role": "operator", "requires_change_number": False,
        "requires_confirmation": True, "is_active": True,
        "target_os": "Windows Server", "expected_minutes": 2,
    },
    {
        "code": "get_disk_space",
        "name": "Get Disk Space",
        "description": "Read total, used, free, and free-percent values for selected fixed drives.",
        "playbook_key": "get_disk_space", "powershell_script_key": "get_disk_space",
        "parameter_schema": [{
            "name": "drive_letters", "label": "Drive letters", "type": "multi-select", "required": True,
            "options": ["C", "D", "E", "F"],
        }],
        "risk_level": "low", "timeout_seconds": 180, "required_role": "operator",
        "requires_change_number": False, "requires_confirmation": True, "is_active": True,
        "target_os": "Windows Server", "expected_minutes": 2,
    },
]


def seed() -> None:
    with SessionLocal.begin() as db:
        roles = {role.name: role for role in db.scalars(select(Role)).all()}
        for name, description, permissions in ROLE_DATA:
            if name not in roles:
                role = Role(name=name, description=description, permissions=permissions)
                db.add(role)
                roles[name] = role
        db.flush()

        users = {user.email: user for user in db.scalars(select(User)).all()}
        for email, full_name, role_name, password in USER_DATA:
            if email not in users:
                users[email] = User(
                    email=email,
                    full_name=full_name,
                    role_id=roles[role_name].id,
                    password_hash=hash_password(password) if password else "password-not-configured",
                )
                db.add(users[email])

        servers = {server.name for server in db.scalars(select(Server)).all()}
        for name, display_name, hostname in SERVER_DATA:
            if name not in servers:
                db.add(Server(
                    name=name, display_name=display_name, hostname=hostname,
                    environment="Development", operating_system="Windows Server 2022",
                    winrm_port=5986, use_https=True, certificate_validation="validate",
                    credential_reference="WINDOWS_PASSWORD",
                ))

        automations = {item.code for item in db.scalars(select(AutomationDefinition)).all()}
        for item in AUTOMATIONS:
            if item["code"] not in automations:
                db.add(AutomationDefinition(**item))


if __name__ == "__main__":
    seed()
