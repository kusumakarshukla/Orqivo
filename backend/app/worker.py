import asyncio
import json
import logging
import secrets
import signal
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import joinedload

from app.ansible_runner import connection_test_automation, execute_playbook
from app.core.config import settings
from app.core.security import sanitize_json, sanitize_text
from app.db.models import (
    AccountStateRequest,
    AutomationDefinition,
    CatalogueRequest,
    Job,
    JobEvent,
    Server,
    WorkerHeartbeat,
    utcnow,
)
from app.db.session import SessionLocal

logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("windows_automation.worker")
STOP = asyncio.Event()


def sanitize_log_value(value: object) -> str:
    return "".join(char if char >= " " and char != "\x7f" else " " for char in str(value or ""))


def add_event(db, job_id: UUID, event_type: str, message: str, details: dict[str, Any] | None = None) -> None:
    db.add(JobEvent(
        job_id=job_id,
        event_type=event_type,
        message=sanitize_text(message),
        sanitized_details_json=sanitize_json(details or {}),
    ))


def sync_account_state_request(db, job_id: UUID, status: str) -> None:
    request = db.scalar(
        select(AccountStateRequest).where(AccountStateRequest.job_id == job_id)
    )
    if request is not None:
        request.status = status


def sync_catalogue_request(db, job_id: UUID, status: str) -> None:
    request = db.scalar(select(CatalogueRequest).where(CatalogueRequest.job_id == job_id))
    if request is not None:
        request.status = status


def claim_one() -> UUID | None:
    with SessionLocal.begin() as db:
        job = db.scalar(
            select(Job)
            .where(Job.status == "pending")
            .order_by(Job.submitted_at)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if job is None:
            return None
        job.status = "running"
        job.started_at = utcnow()
        job.claimed_at = utcnow()
        job.updated_at = utcnow()
        sync_account_state_request(db, job.id, "running")
        sync_catalogue_request(db, job.id, "running")
        add_event(db, job.id, "started", "Background worker started execution")
        return job.id


def mock_result(automation: AutomationDefinition, server: Server, parameters: dict) -> str:
    if automation.code == "get_disk_space":
        drives = parameters.get("drive_letters", ["C"])
        payload = {
            "success": True,
            "drives": [
                {
                    "drive": f"{str(letter).upper()}:",
                    "total_gb": 240.0,
                    "used_gb": 128.4,
                    "free_gb": 111.6,
                    "free_percent": 46.5,
                }
                for letter in drives
            ],
        }
    elif automation.code == "get_server_health":
        payload = {
            "success": True,
            "hostname": server.name,
            "operating_system": server.operating_system,
            "uptime_hours": 183.2,
            "cpu_percent": 18.4,
            "memory_percent": 62.1,
            "services_healthy": 4,
        }
    else:
        payload = {
            "success": True,
            "service": parameters.get("service_name", "Spooler"),
            "before": "Running",
            "after": "Running",
            "action": "Restarted",
        }
    return json.dumps(payload, indent=2)


async def execute_job(job_id: UUID) -> None:
    started = datetime.now(timezone.utc)
    try:
        with SessionLocal() as db:
            job = db.scalar(
                select(Job)
                .options(joinedload(Job.automation), joinedload(Job.server))
                .where(Job.id == job_id)
            )
            if job is None:
                return
            automation = job.automation
            server = job.server
            parameters = dict(job.parameters_json or {})
            is_simulation = settings.mock_mode

        if is_simulation:
            duration_ms = 2000 + secrets.randbelow(6001)
            stages = [
                (0.15, "validated", "Request validated against the approved parameter schema"),
                (0.38, "connected", "Mock WinRM HTTPS connection established"),
                (0.70, "script_executed", f"Mock PowerShell script {automation.powershell_script_key} executed"),
            ]
            last = 0.0
            for progress, event_type, message in stages:
                await asyncio.sleep(max(0, (progress - last) * duration_ms / 1000))
                last = progress
                with SessionLocal.begin() as db:
                    add_event(db, job_id, event_type, message, {"mock": True})
            await asyncio.sleep(max(0, (1 - last) * duration_ms / 1000))
            timed_out = secrets.randbelow(1_000_000) < int(
                max(0.0, min(1.0, settings.mock_timeout_rate)) * 1_000_000
            )
            failed = job.simulate_failure or secrets.randbelow(1_000_000) < int(
                max(0.0, min(1.0, settings.mock_failure_rate)) * 1_000_000
            )
            status = "timed_out" if timed_out else "failed" if failed else "successful"
            stdout = "[MOCK RESULT]\n" + mock_result(automation, server, parameters)
            stderr = (
                "Job exceeded the configured execution timeout (simulated)."
                if timed_out
                else "The simulated PowerShell operation returned a non-zero exit code."
                if failed
                else ""
            )
            return_code = 124 if timed_out else 1 if failed else 0
        else:
            with SessionLocal.begin() as db:
                connection_mode = "HTTPS" if server.use_https else "HTTP with NTLM message encryption"
                add_event(db, job_id, "connecting", f"Testing WinRM {connection_mode} connectivity")
            connection_result = await asyncio.to_thread(
                execute_playbook, connection_test_automation(), server, {}, 30
            )
            connection_return_code = int(connection_result["return_code"])
            if connection_return_code != 0:
                return_code = connection_return_code
                stdout = connection_result["stdout"]
                stderr = connection_result["stderr"]
                with SessionLocal.begin() as db:
                    add_event(
                        db,
                        job_id,
                        "connection_failed",
                        "WinRM connection test failed; automation was not run.",
                        {"return_code": return_code},
                    )
            else:
                with SessionLocal.begin() as db:
                    add_event(db, job_id, "connected", f"WinRM {connection_mode} connection established")
                    add_event(db, job_id, "script_executed", f"Running approved script {automation.powershell_script_key}")
                result = await asyncio.to_thread(
                    execute_playbook,
                    automation,
                    server,
                    parameters,
                    min(automation.timeout_seconds, settings.ansible_job_timeout_seconds),
                )
                return_code = int(result["return_code"])
                stdout = result["stdout"]
                stderr = result["stderr"]
            status = "successful" if return_code == 0 else "timed_out" if return_code == 124 else "failed"

        completed = datetime.now(timezone.utc)
        duration_seconds = max(1, int((completed - started).total_seconds()))
        with SessionLocal.begin() as db:
            job = db.get(Job, job_id)
            if job is None:
                return
            job.status = status
            job.completed_at = completed
            job.duration_seconds = duration_seconds
            job.ansible_return_code = return_code
            job.sanitized_stdout = sanitize_text(stdout)
            job.sanitized_stderr = sanitize_text(stderr)
            job.error_summary = None if status == "successful" else sanitize_text(stderr)
            job.mock_result = settings.mock_mode
            job.updated_at = completed
            sync_account_state_request(db, job_id, status)
            sync_catalogue_request(db, job_id, status)
            add_event(
                db,
                job_id,
                status,
                "Mock automation completed successfully" if status == "successful" and settings.mock_mode
                else "Ansible automation completed successfully" if status == "successful"
                else f"Automation {status.replace('_', ' ')}",
                {"mock": settings.mock_mode, "return_code": return_code},
            )
    except Exception as exc:  # noqa: BLE001 - worker must persist a safe failed result.
        message = sanitize_text(str(exc))
        logger.error(
            "Job execution failed: %s",
            sanitize_log_value(message),
            extra={"job_id": str(job_id)},
        )
        with SessionLocal.begin() as db:
            job = db.get(Job, job_id)
            if job is not None:
                job.status = "failed"
                job.completed_at = utcnow()
                job.duration_seconds = max(1, int((datetime.now(timezone.utc) - started).total_seconds()))
                job.ansible_return_code = 1
                job.sanitized_stderr = message
                job.error_summary = message
                job.updated_at = utcnow()
                sync_account_state_request(db, job_id, "failed")
                sync_catalogue_request(db, job_id, "failed")
                add_event(db, job_id, "failed", message, {"mock": settings.mock_mode})


async def heartbeat() -> None:
    with SessionLocal.begin() as db:
        row = db.get(WorkerHeartbeat, 1)
        if row is None:
            db.add(WorkerHeartbeat(id=1, last_seen_at=utcnow()))
        else:
            row.last_seen_at = utcnow()


async def run_worker() -> None:
    active: set[asyncio.Task] = set()
    limit = max(1, settings.max_concurrent_jobs)
    logger.info("Worker started", extra={"mock_mode": settings.mock_mode, "max_concurrent_jobs": limit})
    while not STOP.is_set():
        try:
            await heartbeat()
            active = {task for task in active if not task.done()}
            while len(active) < limit:
                job_id = await asyncio.to_thread(claim_one)
                if job_id is None:
                    break
                task = asyncio.create_task(execute_job(job_id))
                active.add(task)
            await asyncio.sleep(1)
        except Exception as exc:
            logger.error(
                "Worker polling failed: %s",
                sanitize_log_value(sanitize_text(exc)),
            )
            await asyncio.sleep(3)
    if active:
        await asyncio.gather(*active, return_exceptions=True)
    logger.info("Worker stopped")


def request_stop() -> None:
    STOP.set()


def main() -> None:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, request_stop)
    try:
        loop.run_until_complete(run_worker())
    finally:
        loop.close()


if __name__ == "__main__":
    main()
