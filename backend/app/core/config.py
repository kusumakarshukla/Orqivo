from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Orqivo"
    app_env: str = "development"
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    frontend_url: str = "http://localhost:5173"
    allowed_origins: str | None = None
    database_url: str
    session_secret: str
    csrf_secret: str
    mock_mode: bool = True
    mock_failure_rate: float = 0
    mock_timeout_rate: float = 0
    ansible_enabled: bool = False
    ansible_binary: str = "/usr/local/bin/ansible-playbook"
    ansible_config: str = "/opt/windows-automation/ansible/ansible.cfg"
    ansible_working_directory: str = "/opt/windows-automation/ansible"
    ansible_job_timeout_seconds: int = 600
    max_concurrent_jobs: int = 2
    windows_username: str | None = None
    windows_password: str | None = None
    windows_winrm_port: int = 5985
    windows_winrm_transport: str = "ntlm"
    windows_cert_validation: str = "validate"
    windows_ca_certificate_path: str | None = None
    ad_account_state_test_mode: bool = False
    ad_account_state_test_server_name: str | None = None
    ad_account_state_test_allow_http: bool = False
    ad_demo_ou_dn: str | None = None
    log_level: str = "INFO"
    enable_api_docs: bool = True
    dev_admin_password: str | None = None
    dev_operator_password: str | None = None
    dev_viewer_password: str | None = None
    azure_sso_tenant_id: str | None = None
    azure_sso_client_id: str | None = None
    azure_sso_client_secret: str | None = None
    azure_sso_redirect_uri: str | None = None
    azure_sso_admin_group_id: str | None = None
    azure_sso_operator_group_id: str | None = None
    azure_sso_viewer_group_id: str | None = None

    @property
    def azure_sso_enabled(self) -> bool:
        required = (
            self.azure_sso_tenant_id,
            self.azure_sso_client_id,
            self.azure_sso_client_secret,
            self.azure_sso_redirect_uri,
            self.azure_sso_admin_group_id,
            self.azure_sso_operator_group_id,
            self.azure_sso_viewer_group_id,
        )
        group_ids = required[-3:]
        return (
            all(value and value.strip() for value in required)
            and len({value.strip().lower() for value in group_ids if value}) == 3
        )

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )


settings = Settings()


def validate_production_admin_password(password: str | None) -> None:
    if (
        password is None
        or not password.strip()
        or len(password) < 14
        or password.casefold() in {"admin", "operator", "viewer", "password", "changeme"}
    ):
        raise RuntimeError(
            "Production requires DEV_ADMIN_PASSWORD to be explicitly configured "
            "with at least 14 characters and not a known placeholder."
        )
