import base64
import csv
import hashlib
import hmac
import io
import json
import logging
import secrets
import time
from contextlib import asynccontextmanager
from calendar import monthrange
from datetime import datetime, timedelta, timezone
from ipaddress import ip_address
from typing import Any, Annotated
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session, joinedload

from app.ansible_runner import PLAYBOOK_REGISTRY, SCRIPT_REGISTRY, connection_test_automation, execute_playbook
from app.core.config import settings
from app.core.security import (
    digest_token,
    hash_password,
    sanitize_json,
    sanitize_text,
    verify_password,
)
from app.db.models import (
    AccountStateRequest,
    AuditLog,
    AutomationDefinition,
    CatalogueRequest,
    Job,
    JobEvent,
    Role,
    Server,
    User,
    UserSession,
    WorkerHeartbeat,
    utcnow,
)
from app.db.session import SessionLocal, get_db
from app.schemas import (
    AccountStateRequestInput,
    AuditFilter,
    AutomationInput,
    CatalogueRequestInput,
    JobInput,
    LoginInput,
    ServerInput,
    StatusInput,
)


class JsonLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key in ("request_id", "job_id", "mock_mode"):
            if hasattr(record, key):
                entry[key] = getattr(record, key)
        return json.dumps(entry, ensure_ascii=False)


handler = logging.StreamHandler()
handler.setFormatter(JsonLogFormatter())
logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO), handlers=[handler])
logger = logging.getLogger("windows_automation.api")
LOGIN_BUCKETS: dict[str, tuple[int, float]] = {}
SUBMISSION_BUCKETS: dict[str, tuple[int, float]] = {}
ACCOUNT_REQUEST_BUCKETS: dict[str, tuple[int, float]] = {}
CATALOGUE_REQUEST_BUCKETS: dict[str, tuple[int, float]] = {}
SSO_STATE_COOKIE = "wap_sso_state"
ACCOUNT_CREATION_CATALOGUES = frozenset({"create_permanent_account", "create_consultant_account"})
REAL_MODE_READ_ONLY_AUTOMATIONS = frozenset({
    "test_windows_connection",
    "get_server_health",
    "get_disk_space",
})


def is_localhost_cookie_host(hostname: str | None) -> bool:
    return (hostname or "").lower() in {"localhost", "127.0.0.1", "::1", "[::1]"}


def as_user(user: User) -> dict[str, Any]:
    return {
        "id": str(user.id),
        "email": user.email,
        "full_name": user.full_name,
        "role": user.role.name,
        "is_active": user.is_active,
    }


def as_automation(row: AutomationDefinition) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "code": row.code,
        "name": row.name,
        "description": row.description,
        "playbook_key": row.playbook_key,
        "powershell_script_key": row.powershell_script_key,
        "parameter_schema": row.parameter_schema,
        "risk_level": row.risk_level,
        "timeout_seconds": row.timeout_seconds,
        "required_role": row.required_role,
        "requires_change_number": row.requires_change_number,
        "requires_confirmation": row.requires_confirmation,
        "is_active": row.is_active,
        "target_os": row.target_os,
        "expected_minutes": row.expected_minutes,
    }


def as_server(row: Server) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "name": row.name,
        "display_name": row.display_name,
        "hostname": row.hostname,
        "environment": row.environment,
        "operating_system": row.operating_system,
        "winrm_port": row.winrm_port,
        "use_https": row.use_https,
        "certificate_validation": row.certificate_validation,
        "credential_reference": row.credential_reference,
        "is_active": row.is_active,
        "last_connection_status": row.last_connection_status,
        "last_connection_at": row.last_connection_at.isoformat() if row.last_connection_at else None,
    }


def mask_parameters(value: dict[str, Any]) -> dict[str, Any]:
    return sanitize_json(value)


def event_output(event: JobEvent) -> dict[str, Any]:
    return {
        "id": str(event.id),
        "event_type": event.event_type,
        "message": sanitize_text(event.message),
        "created_at": event.created_at.isoformat(),
    }


def as_job(row: Job, include_events: bool = False) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "automation_id": str(row.automation_definition_id),
        "automation_name": row.automation.name,
        "server_id": str(row.server_id),
        "server_name": row.server.display_name or row.server.name,
        "requested_by_user_id": str(row.requested_by_user_id),
        "requested_by": row.requester.full_name,
        "parent_job_id": str(row.parent_job_id) if row.parent_job_id else None,
        "status": row.status,
        "parameters": mask_parameters(row.parameters_json or {}),
        "change_number": row.change_number,
        "business_reason": row.business_reason,
        "submitted_at": row.submitted_at.isoformat(),
        "started_at": row.started_at.isoformat() if row.started_at else None,
        "completed_at": row.completed_at.isoformat() if row.completed_at else None,
        "duration_seconds": row.duration_seconds,
        "sanitized_stdout": sanitize_text(row.sanitized_stdout) if row.sanitized_stdout else None,
        "sanitized_stderr": sanitize_text(row.sanitized_stderr) if row.sanitized_stderr else None,
        "ansible_return_code": row.ansible_return_code,
        "error_summary": sanitize_text(row.error_summary) if row.error_summary else None,
        "mock_result": row.mock_result,
        "cancellation_requested": row.cancellation_requested,
        "events": [event_output(item) for item in row.events] if include_events else [],
    }


def add_event(db: Session, job_id: UUID, event_type: str, message: str, details: dict | None = None) -> None:
    db.add(JobEvent(
        job_id=job_id,
        event_type=event_type,
        message=sanitize_text(message),
        sanitized_details_json=sanitize_json(details or {}),
    ))


def add_audit(
    db: Session,
    request: Request,
    user_id: UUID | None,
    action: str,
    resource_type: str,
    resource_id: str | None,
    details: dict | None = None,
) -> None:
    db.add(AuditLog(
        user_id=user_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        sanitized_details_json=sanitize_json(details or {}),
        source_ip=(request.client.host if request.client else None),
    ))


def limited(store: dict[str, tuple[int, float]], key: str, limit: int, period: float) -> bool:
    count, reset_at = store.get(key, (0, 0))
    if reset_at <= time.monotonic():
        store[key] = (1, time.monotonic() + period)
        return True
    store[key] = (count + 1, reset_at)
    return count + 1 <= limit


def _sso_cookie_secure(request: Request) -> bool:
    return settings.app_env == "production" and not is_localhost_cookie_host(request.url.hostname)


def _sign_sso_flow(flow: dict[str, Any]) -> str:
    flow_data = {key: value for key, value in flow.items() if key != "auth_uri"}
    payload = json.dumps({"issued_at": int(time.time()), "flow": flow_data}, separators=(",", ":")).encode()
    encoded = base64.urlsafe_b64encode(payload).decode().rstrip("=")
    signature = hmac.new(settings.csrf_secret.encode(), encoded.encode(), hashlib.sha256).hexdigest()
    return f"{encoded}.{signature}"


def _read_sso_flow(cookie: str) -> dict[str, Any]:
    try:
        encoded, signature = cookie.rsplit(".", 1)
        expected = hmac.new(settings.csrf_secret.encode(), encoded.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError("Invalid SSO state signature.")
        payload = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        value = json.loads(payload)
        issued_at = int(value["issued_at"])
        if issued_at > int(time.time()) + 30 or time.time() - issued_at > 600:
            raise ValueError("SSO state has expired.")
        flow = value["flow"]
        if not isinstance(flow, dict) or not flow.get("state") or not flow.get("nonce"):
            raise ValueError("SSO state is incomplete.")
        return flow
    except (KeyError, TypeError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError("Invalid SSO state cookie.") from exc


def _azure_sso_client():
    if not settings.azure_sso_enabled:
        raise HTTPException(status_code=404, detail="Azure SSO is not configured.")
    import msal

    return msal.ConfidentialClientApplication(
        settings.azure_sso_client_id,
        authority=f"https://login.microsoftonline.com/{settings.azure_sso_tenant_id}",
        client_credential=settings.azure_sso_client_secret,
    )


def _sso_failure_redirect(code: str, request: Request) -> RedirectResponse:
    response = RedirectResponse(
        f"{settings.frontend_url.rstrip('/')}/login?sso_error={code}",
        status_code=303,
    )
    response.delete_cookie(
        SSO_STATE_COOKIE,
        path="/",
        secure=_sso_cookie_secure(request),
        samesite="lax",
    )
    return response


def _role_from_sso_groups(groups: object) -> str | None:
    if not isinstance(groups, list):
        return None
    memberships = {value.lower() for value in groups if isinstance(value, str)}
    for role in ("admin", "operator", "viewer"):
        configured_id = getattr(settings, f"azure_sso_{role}_group_id")
        if configured_id and configured_id.strip().lower() in memberships:
            return role
    return None


def _establish_user_session(
    user: User,
    request: Request,
    response: Response,
    db: Session,
    auth_method: str,
) -> dict[str, Any]:
    token = secrets.token_urlsafe(48)
    csrf = secrets.token_urlsafe(32)
    expires = utcnow() + timedelta(hours=8)
    db.add(UserSession(
        user_id=user.id,
        token_hash=digest_token(token),
        csrf_hash=digest_token(csrf),
        expires_at=expires,
    ))
    user.last_login_at = utcnow()
    add_audit(db, request, user.id, "login", "user", str(user.id), {"method": auth_method, "email": user.email})
    db.commit()
    secure_cookie = _sso_cookie_secure(request)
    response.set_cookie(
        "wap_session", token, httponly=True, secure=secure_cookie,
        samesite="lax", path="/", expires=expires,
    )
    response.set_cookie(
        "wap_csrf", csrf, httponly=False, secure=secure_cookie,
        samesite="lax", path="/", expires=expires,
    )
    return as_user(user)


def worker_is_online(db: Session) -> bool:
    heartbeat = db.get(WorkerHeartbeat, 1)
    return bool(heartbeat and (utcnow() - heartbeat.last_seen_at).total_seconds() < 15)


def configured_ad_account_test_server(db: Session) -> Server | None:
    server_name = settings.ad_account_state_test_server_name
    if not server_name:
        return None
    server = db.scalar(select(Server).where(Server.name == server_name))
    if (
        server is None
        or not server.is_active
        or server.environment.casefold() not in {"development", "test"}
    ):
        return None
    try:
        ip_address(server.hostname)
    except ValueError:
        pass
    else:
        return None

    if server.use_https:
        return server if server.winrm_port == 5986 and server.certificate_validation == "validate" else None
    return (
        server
        if settings.ad_account_state_test_allow_http
        and settings.windows_winrm_transport.casefold() == "ntlm"
        and server.winrm_port == 5985
        else None
    )


def get_ad_account_test_automation(db: Session) -> AutomationDefinition:
    automation = db.scalar(
        select(AutomationDefinition).where(AutomationDefinition.code == "disable_ad_account")
    )
    if automation is None:
        automation = AutomationDefinition(
            code="disable_ad_account",
            name="Disable AD Account",
            description="Disable and verify an account on the configured non-production AD test target.",
            playbook_key="disable_ad_account",
            powershell_script_key="disable_ad_account",
            parameter_schema=[{
                "name": "sam_account_name",
                "label": "SamAccountName",
                "type": "text",
                "required": True,
                "options": [],
            }],
            risk_level="high",
            timeout_seconds=180,
            required_role="operator",
            requires_change_number=False,
            requires_confirmation=True,
            is_active=True,
            target_os="Windows Server",
            expected_minutes=2,
        )
        db.add(automation)
        db.flush()
    return automation


def queue_catalogue_account_creation(
    db: Session,
    row: CatalogueRequest,
    user: User,
    request: Request,
    audit_action: str,
) -> Job:
    if row.catalogue not in ACCOUNT_CREATION_CATALOGUES:
        raise HTTPException(status_code=400, detail="This catalogue cannot be executed as an account creation.")
    if not settings.ad_account_state_test_mode:
        raise HTTPException(status_code=503, detail="Non-production account creation is not enabled.")
    if settings.mock_mode or not settings.ansible_enabled:
        raise HTTPException(
            status_code=503,
            detail="Non-production account creation requires MOCK_MODE=false and ANSIBLE_ENABLED=true.",
        )
    server = configured_ad_account_test_server(db)
    if server is None:
        raise HTTPException(
            status_code=503,
            detail="The account-creation target must be an active registered development/test DNS host using the approved WinRM transport.",
        )
    if not settings.ad_demo_ou_dn:
        raise HTTPException(status_code=503, detail="The non-production account-creation OU is not configured.")
    if not worker_is_online(db):
        raise HTTPException(status_code=503, detail="Automation worker is unavailable; the request was not queued.")

    try:
        validated_request = TypeAdapter(CatalogueRequestInput).validate_python({
            "catalogue": row.catalogue,
            **(row.request_data or {}),
        })
    except ValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail="Stored account-creation request details failed validation; the request was not queued.",
        ) from exc

    automation = db.scalar(
        select(AutomationDefinition).where(AutomationDefinition.code == "create_ad_account")
    )
    if (
        automation is None
        or not automation.is_active
        or automation.playbook_key not in PLAYBOOK_REGISTRY
        or automation.powershell_script_key not in SCRIPT_REGISTRY
        or automation.playbook_key != "create_ad_account"
        or automation.powershell_script_key != "create_ad_account"
    ):
        raise HTTPException(status_code=503, detail="The approved demo account-creation automation is unavailable.")

    job = Job(
        automation_definition_id=automation.id,
        server_id=server.id,
        requested_by_user_id=user.id,
        status="pending",
        parameters_json=validated_request.model_dump(mode="json", exclude={"catalogue"}),
        business_reason="Create account in the Active Directory",
        mock_result=False,
    )
    db.add(job)
    db.flush()
    row.job_id = job.id
    row.status = "queued"
    add_event(db, job.id, "submitted", "Non-production account-creation automation submitted", {
        "automation": automation.code,
        "server": server.name,
        "mock": False,
    })
    add_event(db, job.id, "validated", "Request and target passed non-production validation")
    add_audit(
        db,
        request,
        user.id,
        audit_action,
        "catalogue_request",
        str(row.id),
        {"catalogue": row.catalogue, "job_id": str(job.id)},
    )
    return job


def validate_parameters(automation: AutomationDefinition, values: dict[str, Any]) -> str | None:
    schema = automation.parameter_schema or []
    approved = {item["name"]: item for item in schema}
    if set(values) - set(approved):
        return "One or more parameters are not approved."
    for name, definition in approved.items():
        value = values.get(name)
        if definition.get("required") and (value is None or value == "" or value == []):
            return f"{definition.get('label', name)} is required."
        if value is None or value == "":
            continue
        if definition.get("type") == "select" and value not in definition.get("options", []):
            return f"{definition.get('label', name)} is not an approved selection."
        if definition.get("type") == "multi-select":
            if not isinstance(value, list) or any(entry not in definition.get("options", []) for entry in value):
                return f"{definition.get('label', name)} contains an unapproved selection."
        if definition.get("type") == "number" and (not isinstance(value, (int, float)) or isinstance(value, bool)):
            return f"{definition.get('label', name)} must be a number."
        if definition.get("type") == "text" and (not isinstance(value, str) or len(value) > 500 or "\n" in value or "\r" in value):
            return f"{definition.get('label', name)} is invalid."
    return None


def get_authenticated_user(request: Request, db: Session = Depends(get_db)) -> User:
    raw_token = request.cookies.get("wap_session")
    if not raw_token:
        raise HTTPException(status_code=401, detail="Sign in to continue")
    session = db.scalar(
        select(UserSession)
        .options(joinedload(UserSession.user).joinedload(User.role))
        .where(UserSession.token_hash == digest_token(raw_token))
    )
    if session is None or session.expires_at <= utcnow() or not session.user.is_active:
        raise HTTPException(status_code=401, detail="Sign in to continue")
    return session.user


def role_dependency(*roles: str):
    def check(user: User = Depends(get_authenticated_user)) -> User:
        if user.role.name not in roles:
            raise HTTPException(status_code=403, detail="You do not have permission to perform this action")
        return user
    return check


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.app_env == "production" and (not settings.session_secret or not settings.csrf_secret):
        raise RuntimeError("SESSION_SECRET and CSRF_SECRET must be configured in production.")
    logger.info("API starting", extra={"mock_mode": settings.mock_mode})
    yield
    logger.info("API stopping")


app = FastAPI(
    title=settings.app_name,
    docs_url="/api/docs" if settings.enable_api_docs and settings.app_env != "production" else None,
    redoc_url=None,
    openapi_url="/api/openapi.json" if settings.enable_api_docs and settings.app_env != "production" else None,
    lifespan=lifespan,
)
allowed_origins = [
    origin.strip().rstrip("/")
    for origin in (settings.allowed_origins or settings.frontend_url).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-CSRF-Token", "X-Correlation-ID"],
)


@app.middleware("http")
async def security_and_request_logging(request: Request, call_next):
    correlation_id = request.headers.get("x-correlation-id") or str(uuid4())
    origin = request.headers.get("origin")
    if origin and origin not in allowed_origins:
        return Response(content='{"error":"Request origin is not allowed"}', status_code=403, media_type="application/json")
    if request.method not in {"GET", "HEAD", "OPTIONS"} and not request.url.path.endswith("/auth/login"):
        csrf_header = request.headers.get("x-csrf-token")
        csrf_cookie = request.cookies.get("wap_csrf")
        session_token = request.cookies.get("wap_session")
        if not csrf_header or not csrf_cookie or not secrets.compare_digest(csrf_header, csrf_cookie) or not session_token:
            return Response(content='{"error":"CSRF validation failed"}', status_code=403, media_type="application/json")
        with SessionLocal() as db:
            session = db.scalar(select(UserSession).where(UserSession.token_hash == digest_token(session_token)))
            if session is None or not secrets.compare_digest(session.csrf_hash, digest_token(csrf_header)):
                return Response(content='{"error":"CSRF validation failed"}', status_code=403, media_type="application/json")
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > 32768:
        return Response(content='{"error":"Request body is too large"}', status_code=413, media_type="application/json")
    started = time.monotonic()
    response = await call_next(request)
    response.headers["X-Correlation-ID"] = correlation_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    logger.info(
        "Request completed",
        extra={"request_id": correlation_id, "duration_ms": round((time.monotonic() - started) * 1000), "status": response.status_code},
    )
    return response


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
def ready(db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        db.execute(select(1))
        if not worker_is_online(db):
            raise HTTPException(status_code=503, detail="Worker is unavailable")
        return {
            "status": "ready",
            "database": "connected",
            "worker_online": True,
            "mock_mode": settings.mock_mode,
            "ansible_enabled": settings.ansible_enabled,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Database is unavailable") from exc


@app.get("/api/v1/auth/options")
def auth_options() -> dict[str, bool]:
    return {"azure_sso_enabled": settings.azure_sso_enabled}


@app.get("/api/v1/auth/sso/login")
def azure_sso_login(request: Request) -> RedirectResponse:
    client = _azure_sso_client()
    if settings.app_env == "production" and not (settings.azure_sso_redirect_uri or "").startswith("https://"):
        raise HTTPException(status_code=503, detail="Azure SSO requires an HTTPS callback URL in production.")
    flow = client.initiate_auth_code_flow(
        scopes=["openid", "profile", "email"],
        redirect_uri=settings.azure_sso_redirect_uri,
        response_mode="query",
    )
    if flow.get("error") or not flow.get("auth_uri"):
        logger.error("Could not initialize Azure SSO authorization flow")
        raise HTTPException(status_code=503, detail="Azure SSO could not be initialized.")
    response = RedirectResponse(flow["auth_uri"], status_code=302)
    response.set_cookie(
        SSO_STATE_COOKIE,
        _sign_sso_flow(flow),
        httponly=True,
        secure=_sso_cookie_secure(request),
        samesite="lax",
        path="/",
        max_age=600,
    )
    return response


@app.get("/api/v1/auth/sso/callback")
def azure_sso_callback(
    request: Request,
    db: Session = Depends(get_db),
) -> RedirectResponse:
    response = _sso_failure_redirect("authentication_failed", request)
    signed_flow = request.cookies.get(SSO_STATE_COOKIE)
    if not signed_flow or not settings.azure_sso_enabled:
        return response
    try:
        flow = _read_sso_flow(signed_flow)
        client = _azure_sso_client()
        result = client.acquire_token_by_auth_code_flow(flow, dict(request.query_params))
        claims = result.get("id_token_claims") if isinstance(result, dict) else None
        if not isinstance(claims, dict):
            logger.warning("Azure SSO callback returned no validated identity claims")
            return response
        tenant_claim = claims.get("tid")
        if not isinstance(tenant_claim, str) or tenant_claim.lower() != settings.azure_sso_tenant_id.lower():
            logger.warning("Azure SSO callback tenant did not match configured tenant")
            return response
        if claims.get("aud") != settings.azure_sso_client_id:
            logger.warning("Azure SSO callback audience did not match configured client")
            return response
        if "groups" in claims.get("_claim_names", {}) or claims.get("hasgroups"):
            logger.warning("Azure SSO group overage requires a smaller group claim set")
            return response
        role_name = _role_from_sso_groups(claims.get("groups"))
        if not role_name:
            logger.warning("Azure SSO user did not match a configured portal role group")
            return _sso_failure_redirect("not_authorized", request)
        email = claims.get("preferred_username") or claims.get("email") or claims.get("upn")
        if not isinstance(email, str) or not email.strip() or len(email) > 320:
            logger.warning("Azure SSO identity did not contain a usable email or UPN")
            return response
        email = email.strip().lower()
        role = db.scalar(select(Role).where(Role.name == role_name))
        if role is None:
            logger.error("Configured Azure SSO role is missing from the database")
            return response
        user = db.scalar(
            select(User).options(joinedload(User.role)).where(func.lower(User.email) == email)
        )
        if user is not None and not user.is_active:
            logger.warning("Azure SSO login rejected for inactive portal user")
            return _sso_failure_redirect("not_authorized", request)
        full_name = claims.get("name")
        if not isinstance(full_name, str) or not full_name.strip():
            full_name = email
        if user is None:
            user = User(
                email=email,
                full_name=full_name.strip()[:160],
                password_hash=hash_password(secrets.token_urlsafe(64)),
                role=role,
            )
            db.add(user)
            db.flush()
        else:
            user.role = role
            user.full_name = full_name.strip()[:160]
        result_response = RedirectResponse(
            f"{settings.frontend_url.rstrip('/')}/dashboard",
            status_code=303,
        )
        result_response.delete_cookie(
            SSO_STATE_COOKIE,
            path="/",
            secure=_sso_cookie_secure(request),
            samesite="lax",
        )
        _establish_user_session(user, request, result_response, db, "azure_sso")
        return result_response
    except (ValueError, KeyError, TypeError):
        logger.warning("Azure SSO callback state or response was invalid")
        return response
    except Exception:
        logger.exception("Azure SSO callback failed")
        return response


@app.post("/api/v1/auth/login")
def login(body: dict, request: Request, response: Response, db: Session = Depends(get_db)) -> dict[str, Any]:
    key = request.client.host if request.client else "unknown"
    if not limited(LOGIN_BUCKETS, key, 10, 300):
        raise HTTPException(status_code=429, detail="Too many login attempts. Try again later.")
    try:
        parsed = LoginInput.model_validate(body)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Enter a valid email and password") from exc
    user = db.scalar(
        select(User).options(joinedload(User.role)).where(func.lower(User.email) == parsed.email.strip().lower())
    )
    if user is None or not user.is_active or not verify_password(parsed.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Email or password is incorrect")
    return _establish_user_session(user, request, response, db, "password")


@app.post("/api/v1/auth/logout", status_code=204)
def logout(request: Request, response: Response, user: User = Depends(get_authenticated_user), db: Session = Depends(get_db)) -> Response:
    raw = request.cookies.get("wap_session")
    if raw:
        session = db.scalar(select(UserSession).where(UserSession.token_hash == digest_token(raw)))
        if session:
            db.delete(session)
    add_audit(db, request, user.id, "logout", "user", str(user.id))
    db.commit()
    secure_cookie = settings.app_env == "production" and not is_localhost_cookie_host(request.url.hostname)
    response.delete_cookie("wap_session", path="/", secure=secure_cookie, samesite="lax")
    response.delete_cookie("wap_csrf", path="/", secure=secure_cookie, samesite="lax")
    response.status_code = 204
    return response


@app.get("/api/v1/auth/me")
def me(user: User = Depends(get_authenticated_user)) -> dict[str, Any]:
    return as_user(user)


@app.get("/api/v1/dashboard/summary")
def dashboard_summary(_: User = Depends(get_authenticated_user), db: Session = Depends(get_db)) -> dict[str, Any]:
    groups = db.execute(select(Job.status, func.count(Job.id)).group_by(Job.status)).all()
    counts = {status: int(count) for status, count in groups}
    total = sum(counts.values())
    successful = counts.get("successful", 0)
    completed = successful + counts.get("failed", 0) + counts.get("timed_out", 0)
    worker_online = worker_is_online(db)
    return {
        "total": total, "running": counts.get("running", 0), "successful": successful,
        "failed": counts.get("failed", 0),
        "success_rate": round(100 * successful / completed, 1) if completed else 0,
        "mock_mode": settings.mock_mode,
        "ansible_enabled": settings.ansible_enabled,
        "worker_online": worker_online,
        "by_status": counts,
    }


@app.get("/api/v1/admin/automation-tracker")
def automation_tracker(
    year: int = Query(ge=2000, le=2100),
    month: int = Query(ge=1, le=12),
    _: User = Depends(role_dependency("admin")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    month_start = datetime(year, month, 1, tzinfo=timezone.utc)
    if month == 12:
        month_end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        month_end = datetime(year, month + 1, 1, tzinfo=timezone.utc)
    year_start = datetime(year, 1, 1, tzinfo=timezone.utc)
    completed_statuses = ("successful", "failed", "timed_out")
    completed_count = func.sum(case((Job.status.in_(completed_statuses), 1), else_=0))
    success_count = func.sum(case((Job.status == "successful", 1), else_=0))
    failure_count = func.sum(case((Job.status.in_(("failed", "timed_out")), 1), else_=0))
    cancelled_count = func.sum(case((Job.status == "cancelled", 1), else_=0))
    average_duration = func.avg(case(
        (Job.status.in_(completed_statuses), Job.duration_seconds),
        else_=None,
    ))

    def job_metrics(start: datetime, end: datetime) -> dict[str, Any]:
        total, successful, failed, cancelled, average = db.execute(
            select(
                completed_count,
                success_count,
                failure_count,
                cancelled_count,
                average_duration,
            ).where(Job.submitted_at >= start, Job.submitted_at < end)
        ).one()
        return {
            "total_executed": int(total or 0),
            "successful": int(successful or 0),
            "failed": int(failed or 0),
            "cancelled": int(cancelled or 0),
            "success_rate": round(100 * int(successful or 0) / int(total or 1), 1),
            "failure_rate": round(100 * int(failed or 0) / int(total or 1), 1),
            "average_duration_seconds": round(float(average), 1) if average is not None else None,
        }

    month_metrics = job_metrics(month_start, month_end)
    ytd_metrics = job_metrics(year_start, month_end)

    job_day = func.date_trunc("day", Job.submitted_at).label("request_day")
    job_daily = db.execute(
        select(job_day, func.count(Job.id))
        .where(Job.submitted_at >= month_start, Job.submitted_at < month_end)
        .group_by(job_day)
    ).all()
    account_request_day = func.date_trunc("day", AccountStateRequest.submitted_at).label("request_day")
    request_daily = db.execute(
        select(account_request_day, func.count(AccountStateRequest.id))
        .where(AccountStateRequest.submitted_at >= month_start, AccountStateRequest.submitted_at < month_end)
        .group_by(account_request_day)
    ).all()
    catalogue_request_day = func.date_trunc("day", CatalogueRequest.submitted_at).label("request_day")
    catalogue_daily = db.execute(
        select(catalogue_request_day, func.count(CatalogueRequest.id))
        .where(CatalogueRequest.submitted_at >= month_start, CatalogueRequest.submitted_at < month_end)
        .group_by(catalogue_request_day)
    ).all()
    daily_counts: dict[str, dict[str, int]] = {}
    for day, count in job_daily:
        daily_counts.setdefault(day.date().isoformat(), {"job_requests": 0, "account_requests": 0, "catalogue_requests": 0})["job_requests"] = int(count)
    for day, count in request_daily:
        daily_counts.setdefault(day.date().isoformat(), {"job_requests": 0, "account_requests": 0, "catalogue_requests": 0})["account_requests"] = int(count)
    for day, count in catalogue_daily:
        daily_counts.setdefault(day.date().isoformat(), {"job_requests": 0, "account_requests": 0, "catalogue_requests": 0})["catalogue_requests"] = int(count)

    daily = []
    for day in range(1, monthrange(year, month)[1] + 1):
        day_key = f"{year:04d}-{month:02d}-{day:02d}"
        counts = daily_counts.get(day_key, {"job_requests": 0, "account_requests": 0, "catalogue_requests": 0})
        daily.append({
            "date": day_key,
            **counts,
            "total_requests": counts["job_requests"] + counts["account_requests"] + counts["catalogue_requests"],
        })

    top_catalogues = db.execute(
        select(
            AutomationDefinition.code,
            AutomationDefinition.name,
            func.count(Job.id),
            func.sum(case((Job.status == "successful", 1), else_=0)),
            func.sum(case((Job.status.in_(("failed", "timed_out")), 1), else_=0)),
        )
        .join(Job, Job.automation_definition_id == AutomationDefinition.id)
        .where(
            Job.submitted_at >= month_start,
            Job.submitted_at < month_end,
            Job.status.in_(completed_statuses),
        )
        .group_by(AutomationDefinition.code, AutomationDefinition.name)
        .order_by(func.count(Job.id).desc(), AutomationDefinition.name)
        .limit(5)
    ).all()

    return {
        "year": year,
        "month": month,
        "month_label": month_start.strftime("%B %Y"),
        "total_requests": sum(item["total_requests"] for item in daily),
        **month_metrics,
        "ytd": ytd_metrics,
        "daily": daily,
        "top_catalogues": [
            {
                "code": code,
                "name": name,
                "total_executed": int(total),
                "successful": int(successful or 0),
                "failed": int(failed or 0),
            }
            for code, name, total, successful, failed in top_catalogues
        ],
    }


@app.get("/api/v1/dashboard/activity")
def dashboard_activity(
    limit: int = Query(default=10, ge=1, le=50),
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    query = select(Job).options(
        joinedload(Job.automation), joinedload(Job.server), joinedload(Job.requester)
    ).order_by(Job.submitted_at.desc()).limit(limit)
    if user.role.name == "viewer":
        query = query.where(Job.requested_by_user_id == user.id)
    jobs = db.scalars(query).unique().all()
    return [as_job(item) for item in jobs]


@app.get("/api/v1/automations")
def list_automations(
    search: str | None = None,
    risk: str | None = None,
    active: bool | None = None,
    _: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    query = select(AutomationDefinition).order_by(AutomationDefinition.name)
    if active is not None:
        query = query.where(AutomationDefinition.is_active == active)
    if risk:
        query = query.where(AutomationDefinition.risk_level == risk)
    if search:
        query = query.where(or_(
            AutomationDefinition.name.ilike(f"%{search}%"),
            AutomationDefinition.description.ilike(f"%{search}%"),
            AutomationDefinition.code.ilike(f"%{search}%"),
        ))
    return [as_automation(item) for item in db.scalars(query).all()]


@app.get("/api/v1/automations/{automation_id}")
def get_automation(automation_id: UUID, _: User = Depends(get_authenticated_user), db: Session = Depends(get_db)) -> dict[str, Any]:
    row = db.get(AutomationDefinition, automation_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Automation not found")
    return as_automation(row)


def validate_automation_registration(body: AutomationInput) -> None:
    if body.playbook_key not in PLAYBOOK_REGISTRY:
        raise HTTPException(status_code=400, detail="Playbook key is not registered")
    if body.powershell_script_key not in SCRIPT_REGISTRY or body.playbook_key != body.powershell_script_key:
        raise HTTPException(status_code=400, detail="PowerShell script key is not registered for this playbook")


@app.post("/api/v1/account-state-requests", status_code=202)
def create_account_state_request(
    body: AccountStateRequestInput,
    request: Request,
    user: User = Depends(role_dependency("operator", "admin")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    if not limited(ACCOUNT_REQUEST_BUCKETS, str(user.id), 10, 3600):
        raise HTTPException(status_code=429, detail="Request submission limit reached")

    test_automation_enabled = (
        body.action == "disable_ad_account"
        and settings.ad_account_state_test_mode
    )
    job: Job | None = None
    if test_automation_enabled:
        if settings.mock_mode or not settings.ansible_enabled:
            raise HTTPException(
                status_code=503,
                detail="Non-production AD test execution requires MOCK_MODE=false and ANSIBLE_ENABLED=true.",
            )
        server = configured_ad_account_test_server(db)
        if server is None:
            raise HTTPException(
                status_code=503,
                detail="The AD test target must be a registered development/test DNS host using validated HTTPS/5986 or explicitly enabled NTLM-protected HTTP/5985.",
            )
        if not worker_is_online(db):
            raise HTTPException(status_code=503, detail="Automation worker is unavailable; the request was not queued.")
        automation = get_ad_account_test_automation(db)
        job = Job(
            automation_definition_id=automation.id,
            server_id=server.id,
            requested_by_user_id=user.id,
            status="pending",
            parameters_json={"sam_account_name": body.sam_account_name},
            business_reason="Disable account on configured non-production test target",
            mock_result=False,
        )
        db.add(job)
        db.flush()
        add_event(db, job.id, "submitted", "Non-production AD test automation submitted", {
            "automation": automation.code,
            "server": server.name,
            "mock": False,
        })
        add_event(db, job.id, "validated", "Target and SamAccountName passed non-production validation")

    row = AccountStateRequest(
        action=body.action,
        sam_account_name=body.sam_account_name,
        requested_by_user_id=user.id,
        job_id=job.id if job is not None else None,
        status="queued" if test_automation_enabled else "awaiting_automation_integration",
    )
    db.add(row)
    db.flush()
    add_audit(
        db,
        request,
        user.id,
        "account_state_request_submitted",
        "account_state_request",
        str(row.id),
        {"action": row.action, "job_id": str(row.job_id) if row.job_id else None},
    )
    db.commit()
    db.refresh(row)
    return {
        "id": str(row.id),
        "action": row.action,
        "status": row.status,
        "job_id": str(row.job_id) if row.job_id else None,
        "submitted_at": row.submitted_at.isoformat(),
    }


@app.get("/api/v1/account-state-requests")
def list_account_state_requests(
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    query = (
        select(AccountStateRequest, User.full_name)
        .join(User, AccountStateRequest.requested_by_user_id == User.id)
        .order_by(AccountStateRequest.submitted_at.desc())
        .limit(100)
    )
    if user.role.name != "admin":
        query = query.where(AccountStateRequest.requested_by_user_id == user.id)
    return [
        {
            "id": str(row.id),
            "action": row.action,
            "sam_account_name": row.sam_account_name,
            "status": row.status,
            "job_id": str(row.job_id) if row.job_id else None,
            "submitted_at": row.submitted_at.isoformat(),
            "requested_by": requester_name,
        }
        for row, requester_name in db.execute(query).all()
    ]


@app.post("/api/v1/catalogue-requests", status_code=202)
def create_catalogue_request(
    body: CatalogueRequestInput,
    request: Request,
    user: User = Depends(role_dependency("operator", "admin")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    if not limited(CATALOGUE_REQUEST_BUCKETS, str(user.id), 10, 3600):
        raise HTTPException(status_code=429, detail="Request submission limit reached")

    row = CatalogueRequest(
        catalogue=body.catalogue,
        request_data=body.model_dump(mode="json", exclude={"catalogue"}),
        requested_by_user_id=user.id,
    )
    db.add(row)
    db.flush()
    if row.catalogue in ACCOUNT_CREATION_CATALOGUES and settings.ad_account_state_test_mode:
        queue_catalogue_account_creation(
            db, row, user, request, "catalogue_account_creation_queued"
        )
    else:
        add_audit(
            db,
            request,
            user.id,
            "catalogue_request_submitted",
            "catalogue_request",
            str(row.id),
            {"catalogue": row.catalogue},
        )
    db.commit()
    db.refresh(row)
    return {
        "id": str(row.id),
        "catalogue": row.catalogue,
        "status": row.status,
        "job_id": str(row.job_id) if row.job_id else None,
        "submitted_at": row.submitted_at.isoformat(),
    }


@app.post("/api/v1/catalogue-requests/{request_id}/execute", status_code=202)
def execute_catalogue_request(
    request_id: UUID,
    request: Request,
    user: User = Depends(role_dependency("operator", "admin")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    if not limited(CATALOGUE_REQUEST_BUCKETS, str(user.id), 10, 3600):
        raise HTTPException(status_code=429, detail="Request submission limit reached")

    row = db.scalar(
        select(CatalogueRequest)
        .where(CatalogueRequest.id == request_id)
        .with_for_update()
    )
    if row is None or (user.role.name != "admin" and row.requested_by_user_id != user.id):
        raise HTTPException(status_code=404, detail="Catalogue request not found")
    if row.job_id is not None or row.status != "submitted_for_review":
        raise HTTPException(status_code=409, detail="This request is not available for execution.")

    job = queue_catalogue_account_creation(
        db, row, user, request, "catalogue_account_creation_queued"
    )
    db.commit()
    db.refresh(row)
    return {
        "id": str(row.id),
        "catalogue": row.catalogue,
        "status": row.status,
        "job_id": str(job.id),
        "submitted_at": row.submitted_at.isoformat(),
    }


@app.get("/api/v1/catalogue-requests")
def list_catalogue_requests(
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    query = (
        select(CatalogueRequest, User.full_name)
        .join(User, CatalogueRequest.requested_by_user_id == User.id)
        .order_by(CatalogueRequest.submitted_at.desc())
        .limit(100)
    )
    if user.role.name != "admin":
        query = query.where(CatalogueRequest.requested_by_user_id == user.id)
    return [
        {
            "id": str(row.id),
            "catalogue": row.catalogue,
            "request_data": row.request_data,
            "status": row.status,
            "job_id": str(row.job_id) if row.job_id else None,
            "submitted_at": row.submitted_at.isoformat(),
            "requested_by": requester_name,
        }
        for row, requester_name in db.execute(query).all()
    ]


@app.post("/api/v1/automations", status_code=201)
def create_automation(
    body: AutomationInput,
    request: Request,
    user: User = Depends(role_dependency("admin")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    validate_automation_registration(body)
    row = AutomationDefinition(**body.model_dump(mode="json"))
    db.add(row)
    db.flush()
    add_audit(db, request, user.id, "automation_created", "automation", str(row.id), {"after": as_automation(row)})
    db.commit()
    db.refresh(row)
    return as_automation(row)


@app.put("/api/v1/automations/{automation_id}")
def update_automation(
    automation_id: UUID,
    body: AutomationInput,
    request: Request,
    user: User = Depends(role_dependency("admin")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    validate_automation_registration(body)
    row = db.get(AutomationDefinition, automation_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Automation not found")
    before = as_automation(row)
    for key, value in body.model_dump(mode="json").items():
        setattr(row, key, value)
    row.updated_at = utcnow()
    add_audit(db, request, user.id, "automation_updated", "automation", str(row.id), {"before": before, "after": body.model_dump(mode="json")})
    db.commit()
    db.refresh(row)
    return as_automation(row)


@app.patch("/api/v1/automations/{automation_id}/status")
def set_automation_status(
    automation_id: UUID,
    body: StatusInput,
    request: Request,
    user: User = Depends(role_dependency("admin")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    row = db.get(AutomationDefinition, automation_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Automation not found")
    before = row.is_active
    row.is_active = body.is_active
    row.updated_at = utcnow()
    add_audit(db, request, user.id, "automation_status_changed", "automation", str(row.id), {"before": before, "after": body.is_active})
    db.commit()
    db.refresh(row)
    return as_automation(row)


@app.get("/api/v1/servers")
def list_servers(_: User = Depends(get_authenticated_user), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return [as_server(row) for row in db.scalars(select(Server).order_by(Server.name)).all()]


@app.get("/api/v1/servers/{server_id}")
def get_server(server_id: UUID, _: User = Depends(get_authenticated_user), db: Session = Depends(get_db)) -> dict[str, Any]:
    row = db.get(Server, server_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Server not found")
    return as_server(row)


@app.post("/api/v1/servers", status_code=201)
def create_server(
    body: ServerInput,
    request: Request,
    user: User = Depends(role_dependency("admin")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    if body.use_https and body.winrm_port != 5986:
        raise HTTPException(status_code=400, detail="WinRM HTTPS uses port 5986")
    row = Server(**body.model_dump())
    db.add(row)
    db.flush()
    add_audit(db, request, user.id, "server_created", "server", str(row.id), {"after": as_server(row)})
    db.commit()
    db.refresh(row)
    return as_server(row)


@app.put("/api/v1/servers/{server_id}")
def update_server(
    server_id: UUID,
    body: ServerInput,
    request: Request,
    user: User = Depends(role_dependency("admin")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    if body.use_https and body.winrm_port != 5986:
        raise HTTPException(status_code=400, detail="WinRM HTTPS uses port 5986")
    row = db.get(Server, server_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Server not found")
    before = as_server(row)
    for key, value in body.model_dump().items():
        setattr(row, key, value)
    row.updated_at = utcnow()
    after = as_server(row)
    add_audit(db, request, user.id, "server_updated", "server", str(row.id), {"before": before, "after": after})
    db.commit()
    db.refresh(row)
    return as_server(row)


@app.patch("/api/v1/servers/{server_id}/status")
def set_server_status(
    server_id: UUID,
    body: StatusInput,
    request: Request,
    user: User = Depends(role_dependency("admin")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    row = db.get(Server, server_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Server not found")
    before = row.is_active
    row.is_active = body.is_active
    row.updated_at = utcnow()
    add_audit(db, request, user.id, "server_status_changed", "server", str(row.id), {"before": before, "after": body.is_active})
    db.commit()
    db.refresh(row)
    return as_server(row)


@app.post("/api/v1/servers/{server_id}/test-connection")
async def test_server_connection(
    server_id: UUID,
    request: Request,
    user: User = Depends(role_dependency("admin")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    server = db.get(Server, server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="Server not found")
    if settings.mock_mode:
        success = True
        message = "Mock connection successful. No Windows server was contacted."
    else:
        result = await __import__("asyncio").to_thread(execute_playbook, connection_test_automation(), server, {}, 30)
        success = result["return_code"] == 0
        message = "WinRM HTTPS connection succeeded." if success else "WinRM connection failed. Review the sanitized server-side logs."
    server.last_connection_status = "success" if success else "failed"
    server.last_connection_at = utcnow()
    add_audit(db, request, user.id, "server_connection_tested", "server", str(server.id), {"success": success, "mock": settings.mock_mode})
    db.commit()
    return {"success": success, "message": message, "tested_at": utcnow().isoformat(), "mock": settings.mock_mode}


@app.post("/api/v1/jobs", status_code=202)
def create_job(
    body: JobInput,
    request: Request,
    user: User = Depends(role_dependency("operator", "admin")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    if not limited(SUBMISSION_BUCKETS, str(user.id), 20, 3600):
        raise HTTPException(status_code=429, detail="Job submission limit reached")
    automation = db.get(AutomationDefinition, body.automation_id)
    server = db.get(Server, body.server_id)
    if automation is None or not automation.is_active or automation.playbook_key not in PLAYBOOK_REGISTRY or automation.powershell_script_key not in SCRIPT_REGISTRY:
        raise HTTPException(status_code=400, detail="Automation is inactive or not approved")
    if not settings.mock_mode and (
        automation.code not in REAL_MODE_READ_ONLY_AUTOMATIONS
        or automation.playbook_key not in REAL_MODE_READ_ONLY_AUTOMATIONS
        or automation.powershell_script_key not in REAL_MODE_READ_ONLY_AUTOMATIONS
    ):
        raise HTTPException(
            status_code=403,
            detail="Only approved read-only automations are enabled for the initial live rollout.",
        )
    if server is None or not server.is_active:
        raise HTTPException(status_code=400, detail="Target server is inactive or unavailable")
    if not worker_is_online(db):
        raise HTTPException(status_code=503, detail="Automation worker is unavailable; the job was not queued.")
    if not settings.mock_mode and not settings.ansible_enabled:
        raise HTTPException(status_code=503, detail="Live Ansible execution is disabled on this deployment.")
    error = validate_parameters(automation, body.parameters)
    if error:
        raise HTTPException(status_code=400, detail=error)
    if automation.requires_change_number and not __import__("re").fullmatch(r"[A-Za-z][A-Za-z0-9_-]{1,31}", body.change_number or ""):
        raise HTTPException(status_code=400, detail="A valid change or incident number is required")
    if body.simulate_failure and not settings.mock_mode:
        raise HTTPException(status_code=400, detail="Failure simulation is only available in mock mode")
    row = Job(
        automation_definition_id=automation.id,
        server_id=server.id,
        requested_by_user_id=user.id,
        status="pending",
        parameters_json=body.parameters,
        change_number=body.change_number,
        business_reason=body.business_reason,
        mock_result=settings.mock_mode,
        simulate_failure=body.simulate_failure and settings.mock_mode,
    )
    db.add(row)
    db.flush()
    add_event(db, row.id, "submitted", "Automation request submitted", {"mock": settings.mock_mode})
    add_event(db, row.id, "validated", "Request passed server-side validation")
    add_audit(db, request, user.id, "job_submitted", "job", str(row.id), {
        "automation": automation.code,
        "server": server.name,
        "parameters": mask_parameters(body.parameters),
    })
    db.commit()
    row = db.scalar(
        select(Job).options(
            joinedload(Job.automation), joinedload(Job.server),
            joinedload(Job.requester), joinedload(Job.events),
        ).where(Job.id == row.id)
    )
    return as_job(row, include_events=True)


def job_query_for_user(user: User):
    query = select(Job).options(
        joinedload(Job.automation), joinedload(Job.server),
        joinedload(Job.requester), joinedload(Job.events),
    )
    if user.role.name == "viewer":
        query = query.where(Job.requested_by_user_id == user.id)
    return query


@app.get("/api/v1/jobs")
def list_jobs(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    search: str | None = None,
    status: str | None = None,
    automation_id: UUID | None = None,
    server_id: UUID | None = None,
    user_id: UUID | None = None,
    from_date: str | None = Query(default=None, alias="from"),
    to_date: str | None = Query(default=None, alias="to"),
    sort: str = "newest",
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    conditions = []
    if user.role.name == "viewer":
        conditions.append(Job.requested_by_user_id == user.id)
    if status:
        conditions.append(Job.status == status)
    if automation_id:
        conditions.append(Job.automation_definition_id == automation_id)
    if server_id:
        conditions.append(Job.server_id == server_id)
    if user_id and user.role.name == "admin":
        conditions.append(Job.requested_by_user_id == user_id)
    if from_date:
        try:
            conditions.append(Job.submitted_at >= datetime.fromisoformat(from_date).replace(tzinfo=timezone.utc))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid start date") from exc
    if to_date:
        try:
            conditions.append(Job.submitted_at <= datetime.fromisoformat(to_date).replace(tzinfo=timezone.utc) + timedelta(days=1))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid end date") from exc
    if search:
        pattern = f"%{search}%"
        conditions.append(or_(
            Job.business_reason.ilike(pattern),
            Job.automation.has(AutomationDefinition.name.ilike(pattern)),
            Job.server.has(or_(Server.name.ilike(pattern), Server.display_name.ilike(pattern))),
            Job.requester.has(User.full_name.ilike(pattern)),
        ))
    where = and_(*conditions) if conditions else True
    total = db.scalar(select(func.count(Job.id)).where(where)) or 0
    execution_time = func.coalesce(Job.started_at, Job.submitted_at)
    order = execution_time.asc() if sort == "oldest" else execution_time.desc()
    rows = db.scalars(
        job_query_for_user(user)
        .where(*conditions)
        .order_by(order, Job.submitted_at.desc(), Job.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).unique().all()
    return {"items": [as_job(row) for row in rows], "total": int(total), "page": page, "page_size": page_size}


def get_job_or_404(job_id: UUID, user: User, db: Session) -> Job:
    row = db.scalar(job_query_for_user(user).where(Job.id == job_id))
    if row is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return row


@app.get("/api/v1/jobs/export")
def export_jobs(user: User = Depends(get_authenticated_user), db: Session = Depends(get_db)) -> Response:
    execution_time = func.coalesce(Job.started_at, Job.submitted_at)
    rows = db.scalars(
        job_query_for_user(user)
        .order_by(execution_time.desc(), Job.submitted_at.desc(), Job.id.desc())
        .limit(5000)
    ).unique().all()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["job_id", "automation", "server", "requested_by", "status", "execution_time", "completed_at", "change_number", "business_reason"])
    for row in rows:
        values = [
            str(row.id), row.automation.name, row.server.display_name, row.requester.full_name,
            row.status, (row.started_at or row.submitted_at).isoformat(), row.completed_at.isoformat() if row.completed_at else "",
            row.change_number or "", row.business_reason,
        ]
        writer.writerow([("'" if str(value).startswith(("=", "+", "-", "@", "\t", "\r")) else "") + sanitize_text(value) for value in values])
    return Response(
        output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="automation-jobs.csv"'},
    )


@app.get("/api/v1/jobs/{job_id}")
def get_job(job_id: UUID, user: User = Depends(get_authenticated_user), db: Session = Depends(get_db)) -> dict[str, Any]:
    return as_job(get_job_or_404(job_id, user, db), include_events=True)


@app.get("/api/v1/jobs/{job_id}/events")
def get_job_events(job_id: UUID, user: User = Depends(get_authenticated_user), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    job = get_job_or_404(job_id, user, db)
    return [event_output(event) for event in job.events]


@app.post("/api/v1/jobs/{job_id}/cancel")
def cancel_job(
    job_id: UUID,
    request: Request,
    user: User = Depends(role_dependency("operator", "admin")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    job = get_job_or_404(job_id, user, db)
    if job.status not in {"pending", "queued"}:
        raise HTTPException(status_code=409, detail="This job can no longer be cancelled")
    job.status = "cancelled"
    job.completed_at = utcnow()
    job.cancellation_requested = True
    add_event(db, job.id, "cancelled", "Job cancelled before execution")
    add_audit(db, request, user.id, "job_cancelled", "job", str(job.id))
    db.commit()
    db.refresh(job)
    return as_job(job, include_events=True)


@app.post("/api/v1/jobs/{job_id}/retry", status_code=202)
def retry_job(
    job_id: UUID,
    request: Request,
    user: User = Depends(role_dependency("operator", "admin")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    parent = get_job_or_404(job_id, user, db)
    if parent.status not in {"failed", "timed_out"}:
        raise HTTPException(status_code=409, detail="Only failed or timed-out jobs can be retried")
    retry = Job(
        automation_definition_id=parent.automation_definition_id,
        server_id=parent.server_id,
        requested_by_user_id=user.id,
        parent_job_id=parent.id,
        status="pending",
        parameters_json=parent.parameters_json,
        change_number=parent.change_number,
        business_reason=parent.business_reason,
        mock_result=settings.mock_mode,
    )
    db.add(retry)
    db.flush()
    add_event(db, retry.id, "submitted", f"Retry of job {parent.id} submitted", {"parent_job_id": str(parent.id)})
    add_event(db, retry.id, "validated", "Retry request passed server-side validation")
    add_audit(db, request, user.id, "job_retried", "job", str(retry.id), {"parent_job_id": str(parent.id)})
    db.commit()
    retry = get_job_or_404(retry.id, user, db)
    return as_job(retry, include_events=True)


@app.get("/api/v1/jobs/{job_id}/log")
def download_job_log(
    job_id: UUID,
    request: Request,
    user: User = Depends(get_authenticated_user),
    db: Session = Depends(get_db),
) -> Response:
    job = get_job_or_404(job_id, user, db)
    add_audit(db, request, user.id, "job_log_downloaded", "job", str(job.id))
    db.commit()
    content = "\n".join([
        f"Job {job.id}",
        f"Status: {job.status}",
        f"Exit code: {job.ansible_return_code if job.ansible_return_code is not None else 'n/a'}",
        "",
        "STDOUT",
        sanitize_text(job.sanitized_stdout),
        "",
        "STDERR",
        sanitize_text(job.sanitized_stderr),
    ])
    return Response(content, media_type="text/plain; charset=utf-8")


@app.get("/api/v1/audit-logs")
def list_audit_logs(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    search: str | None = None,
    _: User = Depends(role_dependency("admin")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    conditions = []
    if search:
        pattern = f"%{search}%"
        conditions.append(or_(AuditLog.action.ilike(pattern), AuditLog.resource_type.ilike(pattern)))
    where = and_(*conditions) if conditions else True
    total = db.scalar(select(func.count(AuditLog.id)).where(where)) or 0
    rows = db.scalars(select(AuditLog).where(where).order_by(AuditLog.created_at.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    items = []
    for row in rows:
        audit_user = db.get(User, row.user_id) if row.user_id else None
        items.append({
            "id": str(row.id), "user_id": str(row.user_id) if row.user_id else None,
            "user_name": audit_user.full_name if audit_user else "System",
            "action": row.action, "resource_type": row.resource_type,
            "resource_id": row.resource_id, "details": sanitize_json(row.sanitized_details_json),
            "created_at": row.created_at.isoformat(),
        })
    return {"items": items, "total": int(total), "page": page, "page_size": page_size}
