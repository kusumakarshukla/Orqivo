from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Windows Automation Portal"
    app_env: str = "development"
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    frontend_url: str = "http://localhost:5173"
    database_url: str
    session_secret: str
    csrf_secret: str
    mock_mode: bool = True
    mock_failure_rate: float = 0
    mock_timeout_rate: float = 0
    ansible_enabled: bool = False
    ansible_binary: str = "/usr/bin/ansible-playbook"
    ansible_config: str = "/opt/windows-automation/ansible/ansible.cfg"
    ansible_working_directory: str = "/opt/windows-automation/ansible"
    ansible_job_timeout_seconds: int = 600
    max_concurrent_jobs: int = 2
    windows_username: str | None = None
    windows_password: str | None = None
    windows_winrm_port: int = 5986
    windows_winrm_transport: str = "ntlm"
    windows_cert_validation: str = "validate"
    log_level: str = "INFO"
    enable_api_docs: bool = True
    dev_admin_password: str="admin" | None = None
    dev_operator_password: str ="operator"| None = None
    dev_viewer_password: str ="viewer"| None = None

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )


settings = Settings()
