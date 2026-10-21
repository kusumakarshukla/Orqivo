from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


RoleName = Literal["admin", "operator", "viewer"]
RiskLevel = Literal["low", "medium", "high"]


class LoginInput(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)


class ParameterDefinition(BaseModel):
    name: str = Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")
    label: str = Field(min_length=1, max_length=100)
    type: Literal["text", "select", "multi-select", "number"]
    required: bool = True
    options: list[str] = Field(default_factory=list, max_length=100)
    placeholder: str | None = None
    sensitive: bool = False
    min: float | None = None
    max: float | None = None


class AutomationInput(BaseModel):
    code: str = Field(pattern=r"^[a-z][a-z0-9_]{1,79}$")
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(min_length=1, max_length=2000)
    playbook_key: str
    powershell_script_key: str
    parameter_schema: list[ParameterDefinition] = Field(default_factory=list, max_length=30)
    risk_level: RiskLevel
    timeout_seconds: int = Field(ge=1, le=3600)
    required_role: RoleName = "operator"
    requires_change_number: bool = False
    requires_confirmation: bool = True
    is_active: bool = True


class ServerInput(BaseModel):
    name: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    display_name: str = Field(min_length=1, max_length=160)
    hostname: str = Field(min_length=1, max_length=253)
    environment: str = Field(min_length=1, max_length=64)
    operating_system: str = Field(min_length=1, max_length=120)
    winrm_port: int = Field(ge=1, le=65535)
    use_https: bool = True
    certificate_validation: Literal["validate", "ignore"] = "validate"
    credential_reference: str = Field(min_length=1, max_length=160)
    is_active: bool = True

    @field_validator("hostname")
    @classmethod
    def hostname_is_restricted(cls, value: str) -> str:
        import re

        if not re.fullmatch(r"[A-Za-z0-9.-]+", value) or value.startswith(".") or value.endswith("."):
            raise ValueError("hostname must be a DNS name or IPv4 address")
        return value


class JobInput(BaseModel):
    automation_id: UUID
    server_id: UUID
    parameters: dict[str, Any] = Field(default_factory=dict)
    change_number: str | None = Field(default=None, max_length=64)
    business_reason: str = Field(min_length=3, max_length=1000)
    confirmed: Literal[True]
    simulate_failure: bool = False


class StatusInput(BaseModel):
    is_active: bool


class UserOutput(BaseModel):
    id: UUID
    email: str
    full_name: str
    role: RoleName
    is_active: bool


class JobFilter(BaseModel):
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=20, ge=1, le=100)
    search: str | None = None
    status: str | None = None
    automation_id: UUID | None = None
    server_id: UUID | None = None
    user_id: UUID | None = None
    sort: Literal["newest", "oldest"] = "newest"


class AuditFilter(BaseModel):
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=50, ge=1, le=100)
    search: str | None = None


class ApiError(BaseModel):
    error: str


class JobEventOutput(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    event_type: str
    message: str
    created_at: datetime
