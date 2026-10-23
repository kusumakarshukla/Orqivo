import csv
import io
import json
import logging
import secrets
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Annotated
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, joinedload

from app.ansible_runner import PLAYBOOK_REGISTRY, SCRIPT_REGISTRY, execute_playbook
from app.core.config import settings
from app.core.security import (
    digest_token,
    hash_password,
    sanitize_json,
    sanitize_text,
    verify_password,
)
from app.db.models import (
    AuditLog,
    AutomationDefinition,
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
    AuditFilter,
    AutomationInput,
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
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-CSRF-Token", "X-Correlation-ID"],
)


@app.middleware("http")
async def security_and_request_logging(request: Request, call_next):
    correlation_id = request.headers.get("x-correlation-id") or str(uuid4())
    origin = request.headers.get("origin")
    if origin and origin != settings.frontend_url:
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
        heartbeat = db.get(WorkerHeartbeat, 1)
        worker_online = bool(heartbeat and (utcnow() - heartbeat.last_seen_at).total_seconds() < 15)
        if not worker_online:
            raise HTTPException(status_code=503, detail="Worker is unavailable")
        return {"status": "ready", "database": "connected", "worker_online": True, "mock_mode": settings.mock_mode}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Database is unavailable") from exc


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
    add_audit(db, request, user.id, "login", "user", str(user.id), {"email": user.email})
    db.commit()
    response.set_cookie(
        "wap_session", token, httponly=True, secure=settings.app_env == "production",
        samesite="lax", path="/", expires=expires,
    )
    response.set_cookie(
        "wap_csrf", csrf, httponly=False, secure=settings.app_env == "production",
        samesite="lax", path="/", expires=expires,
    )
    return as_user(user)


@app.post("/api/v1/auth/logout", status_code=204)
def logout(request: Request, response: Response, user: User = Depends(get_authenticated_user), db: Session = Depends(get_db)) -> Response:
    raw = request.cookies.get("wap_session")
    if raw:
        session = db.scalar(select(UserSession).where(UserSession.token_hash == digest_token(raw)))
        if session:
            db.delete(session)
    add_audit(db, request, user.id, "logout", "user", str(user.id))
    db.commit()
    response.delete_cookie("wap_session", path="/", secure=settings.app_env == "production", samesite="lax")
    response.delete_cookie("wap_csrf", path="/", secure=settings.app_env == "production", samesite="lax")
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
    heartbeat = db.get(WorkerHeartbeat, 1)
    worker_online = bool(heartbeat and (utcnow() - heartbeat.last_seen_at).total_seconds() < 15)
    return {
        "total": total, "running": counts.get("running", 0), "successful": successful,
        "failed": counts.get("failed", 0),
        "success_rate": round(100 * successful / completed, 1) if completed else 0,
        "mock_mode": settings.mock_mode, "worker_online": worker_online, "by_status": counts,
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
        from app.db.models import AutomationDefinition

        test_automation = AutomationDefinition(
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
        result = await __import__("asyncio").to_thread(execute_playbook, test_automation, server, {}, 30)
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
    if server is None or not server.is_active:
        raise HTTPException(status_code=400, detail="Target server is inactive or unavailable")
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
    order = Job.submitted_at.asc() if sort == "oldest" else Job.submitted_at.desc()
    rows = db.scalars(job_query_for_user(user).where(*conditions).order_by(order).offset((page - 1) * page_size).limit(page_size)).unique().all()
    return {"items": [as_job(row) for row in rows], "total": int(total), "page": page, "page_size": page_size}


def get_job_or_404(job_id: UUID, user: User, db: Session) -> Job:
    row = db.scalar(job_query_for_user(user).where(Job.id == job_id))
    if row is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return row


@app.get("/api/v1/jobs/export")
def export_jobs(user: User = Depends(get_authenticated_user), db: Session = Depends(get_db)) -> Response:
    rows = db.scalars(job_query_for_user(user).order_by(Job.submitted_at.desc()).limit(5000)).unique().all()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["job_id", "automation", "server", "requested_by", "status", "submitted_at", "completed_at", "change_number", "business_reason"])
    for row in rows:
        values = [
            str(row.id), row.automation.name, row.server.display_name, row.requester.full_name,
            row.status, row.submitted_at.isoformat(), row.completed_at.isoformat() if row.completed_at else "",
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
