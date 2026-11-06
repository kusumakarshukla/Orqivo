from datetime import date, datetime
from ipaddress import ip_address
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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
    winrm_port: Literal[5986] = 5986
    use_https: Literal[True] = True
    certificate_validation: Literal["validate"] = "validate"
    credential_reference: str = Field(min_length=1, max_length=160)
    is_active: bool = True

    @field_validator("hostname")
    @classmethod
    def hostname_is_restricted(cls, value: str) -> str:
        import re

        if not re.fullmatch(r"[A-Za-z0-9.-]+", value) or value.startswith(".") or value.endswith("."):
            raise ValueError("hostname must be a DNS name")
        try:
            ip_address(value)
        except ValueError:
            return value
        raise ValueError("hostname must be a DNS name matching the WinRM certificate, not an IP address")


class JobInput(BaseModel):
    automation_id: UUID
    server_id: UUID
    parameters: dict[str, Any] = Field(default_factory=dict)
    change_number: str | None = Field(default=None, max_length=64)
    business_reason: str = Field(min_length=3, max_length=1000)
    confirmed: Literal[True]
    simulate_failure: bool = False


class AccountStateRequestInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    action: Literal["disable_ad_account", "enable_stale_account"]
    sam_account_name: str = Field(
        min_length=1,
        max_length=20,
        pattern=r"^[A-Za-z0-9._$-]+$",
    )


ParentCompany = Literal["DH-HQ", "DHCM", "DHAM", "DHE", "DHGS", "DHRE", "Merex"]
Subcompany = Literal[
    "DH-HQ", "EIT Business group", "Shamal", "Smart City", "SmartCity Kochi",
    "SmartCity Malta", "DDA", "DHAM", "DIDI", "D-Marin", "Dubai Residential",
    "TECOM Group", "Ejadah", "DH Entertainment", "Global Village", "DHRE",
    "Merex Investments Group", "Idama", "Roxy Cinemas", "Green Planet Dubai",
    "Sea Breeze", "DHI", "DHHAM", "ARN",
]


class CatalogueRequestBase(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    @model_validator(mode="before")
    @classmethod
    def reject_control_characters(cls, values: Any) -> Any:
        if isinstance(values, dict):
            for value in values.values():
                if isinstance(value, str) and any(ord(char) < 32 and char not in "\t" for char in value):
                    raise ValueError("Control characters are not allowed.")
        return values


class PermanentAccountRequestInput(CatalogueRequestBase):
    catalogue: Literal["create_permanent_account"]
    parent_company: ParentCompany
    subcompany: Subcompany
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    middle_name: str = Field(default="", max_length=100)
    line_manager_sam_account_name: str = Field(min_length=1, max_length=20, pattern=r"^[A-Za-z0-9._$-]+$")
    date_of_joining: date
    ticket_number: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._/-]+$")
    office: str = Field(min_length=1, max_length=160)
    job_title: str = Field(min_length=1, max_length=160)
    department: str = Field(min_length=1, max_length=160)
    mobile: str = Field(min_length=7, max_length=30, pattern=r"^[0-9+(). -]+$")
    staff_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._/-]+$")
    last_working_day: date
    account_type: Literal["Permanent", "Temporary"]


class ConsultantAccountRequestInput(CatalogueRequestBase):
    catalogue: Literal["create_consultant_account"]
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    middle_name: str = Field(default="", max_length=100)
    last_working_day: date
    line_manager_sam: str = Field(min_length=1, max_length=20, pattern=r"^[A-Za-z0-9._$-]+$")
    date_of_joining: date
    ticket_number: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._/-]+$")
    office: str = Field(min_length=1, max_length=160)
    job_title: str = Field(min_length=1, max_length=160)
    department: str = Field(min_length=1, max_length=160)
    mobile: str = Field(min_length=7, max_length=30, pattern=r"^[0-9+(). -]+$")
    account_type: Literal["Consultant", "Vendor"]
    parent_company: ParentCompany
    subcompany: Subcompany


class BitlockerKeyRequestInput(CatalogueRequestBase):
    catalogue: Literal["bitlocker_key_retrieval"]
    device_name: str = Field(min_length=1, max_length=253, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    ticket_number: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._/-]+$")
    requester_email: str = Field(min_length=3, max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    sd_agent_email: str = Field(min_length=3, max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


CatalogueRequestInput = Annotated[
    PermanentAccountRequestInput | ConsultantAccountRequestInput | BitlockerKeyRequestInput,
    Field(discriminator="catalogue"),
]


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
