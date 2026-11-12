import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cookieParser from "cookie-parser";
import {
  randomBytes,
  randomInt,
  createHmac,
  timingSafeEqual,
  scrypt,
} from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, asc, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  rolesTable,
  usersTable,
  userSessionsTable,
  serversTable,
  automationsTable,
  jobsTable,
  jobEventsTable,
  auditLogsTable,
  workerHeartbeatTable,
} from "@workspace/db";
import {
  LoginBody,
  CreateAutomationBody,
  UpdateAutomationBody,
  SetAutomationStatusBody,
  CreateServerBody,
  UpdateServerBody,
  SetServerStatusBody,
  CreateJobBody,
  ListJobsQueryParams,
  GetDashboardActivityQueryParams,
  ListAutomationsQueryParams,
  ListAuditLogsQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();
const SESSION_COOKIE = "wap_session";
const CSRF_COOKIE = "wap_csrf";
const mockMode = process.env.MOCK_MODE !== "false";
const isProduction = process.env.APP_ENV === "production";
const configuredSessionSecret = process.env.SESSION_SECRET;
if (
  isProduction &&
  (!configuredSessionSecret || configuredSessionSecret.length < 32)
) {
  throw new Error("Production requires a configured SESSION_SECRET of at least 32 characters.");
}
const sessionSecret =
  configuredSessionSecret || randomBytes(48).toString("hex");
const DISABLED_PASSWORD_HASH = "!disabled!";
const MIN_PRODUCTION_ADMIN_PASSWORD_LENGTH = 14;
const execFileAsync = promisify(execFile);
const failedLoginAttempts = new Map<
  string,
  { count: number; resetAt: number }
>();
const submissionAttempts = new Map<
  string,
  { count: number; resetAt: number }
>();
const RUNNING = new Set(["validating", "queued", "running"]);
const SECRET_FIELD =
  /password|secret|token|credential|authorization|(?:^|_)key(?:$|_)/i;
const PLAYBOOK_REGISTRY: Record<string, string> = {
  restart_windows_service: "playbooks/restart_windows_service.yml",
  get_server_health: "playbooks/get_server_health.yml",
  get_disk_space: "playbooks/get_disk_space.yml",
  test_windows_connection: "playbooks/test_windows_connection.yml",
};
const SCRIPT_REGISTRY: Record<string, string> = {
  restart_windows_service: "Restart-WindowsService.ps1",
  get_server_health: "Get-ServerHealth.ps1",
  get_disk_space: "Get-DiskSpace.ps1",
};

type RoleName = "admin" | "operator" | "viewer";
type SessionUser = {
  id: string;
  email: string;
  fullName: string;
  role: RoleName;
  isActive: boolean;
};
type PortalRequest = Request & { portalUser?: SessionUser };

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const normalizeEmail = (value: string) => value.trim().toLowerCase();
const asText = (value: unknown) => (typeof value === "string" ? value : "");
const now = () => new Date();

function secretDigest(value: string): string {
  return createHmac("sha256", sessionSecret).update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sanitizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(
      /(ansible_password|password|secret|token|authorization|credential)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, "$1[REDACTED]")
    .slice(0, 12000);
}

function maskParameters(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SECRET_FIELD.test(key) ? "[REDACTED]" : entry,
    ]),
  );
}

function sanitizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (!value || typeof value !== "object")
    return typeof value === "string" ? sanitizeText(value) : value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SECRET_FIELD.test(key) ? "[REDACTED]" : sanitizeJson(entry),
    ]),
  );
}

function rateLimit(
  store: Map<string, { count: number; resetAt: number }>,
  key: string,
  max: number,
  windowMs: number,
): boolean {
  const current = store.get(key);
  const timestamp = Date.now();
  if (!current || current.resetAt <= timestamp) {
    store.set(key, { count: 1, resetAt: timestamp + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= max;
}

function rejectCrossSite(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const origin = req.get("origin");
  if (
    !origin ||
    req.method === "GET" ||
    req.method === "HEAD" ||
    req.method === "OPTIONS"
  ) {
    next();
    return;
  }
  const expected = process.env.FRONTEND_URL;
  try {
    const originUrl = new URL(origin);
    if (
      expected
        ? originUrl.origin === new URL(expected).origin
        : originUrl.host === req.get("host")
    ) {
      next();
      return;
    }
  } catch {
    // Reject invalid Origin values.
  }
  res.status(403).json({ error: "Request origin is not allowed" });
}

router.use(cookieParser());
router.use((req, res, next) => {
  const correlationId = String(req.id || randomBytes(12).toString("hex"));
  const safeCorrelationId = /^[A-Za-z0-9._-]{1,128}$/.test(correlationId)
    ? correlationId
    : randomBytes(16).toString("hex");
  res.setHeader("X-Correlation-ID", safeCorrelationId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  next();
});
router.use(rejectCrossSite);

async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) =>
      error ? reject(error) : resolve(key as Buffer),
    );
  });
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

async function passwordMatches(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [scheme, salt, expected] = encoded.split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const actual = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) =>
      error ? reject(error) : resolve(key as Buffer),
    );
  });
  return safeEqual(actual.toString("hex"), expected);
}

let seedPromise: Promise<void> | undefined;
async function ensureSeeded(): Promise<void> {
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    if (isProduction) {
      const adminPassword = process.env.DEV_ADMIN_PASSWORD;
      if (
        !adminPassword ||
        adminPassword.trim().length < MIN_PRODUCTION_ADMIN_PASSWORD_LENGTH ||
        ["admin", "operator", "viewer", "password", "changeme"].includes(
          adminPassword.toLowerCase(),
        )
      ) {
        throw new Error(
          "Production requires DEV_ADMIN_PASSWORD with at least 14 characters and no known placeholder.",
        );
      }
    }
    const roles = [
      {
        name: "admin",
        description: "Manage servers, automations, and audit history",
        permissions: [
          "view",
          "submit",
          "retry",
          "manage_servers",
          "manage_automations",
          "audit",
        ],
      },
      {
        name: "operator",
        description: "Run approved automations and review execution history",
        permissions: ["view", "submit", "retry"],
      },
      {
        name: "viewer",
        description: "View the dashboard, catalogue, and permitted job history",
        permissions: ["view"],
      },
    ];
    await db.insert(rolesTable).values(roles).onConflictDoNothing();
    const existingUsers = await db
      .select({ email: usersTable.email, passwordHash: usersTable.passwordHash })
      .from(usersTable);
    const existing = new Map(existingUsers.map((user) => [user.email, user.passwordHash]));
    const roleRows = await db.select().from(rolesTable);
    const roleIds = new Map(roleRows.map((role) => [role.name, role.id]));
    const userSeeds: Array<[string, string, RoleName, string | undefined]> = [
      [
        "admin@example.com",
        "Admin User",
        "admin",
        process.env.DEV_ADMIN_PASSWORD,
      ],
      [
        "operator@example.com",
        "Operator User",
        "operator",
        process.env.DEV_OPERATOR_PASSWORD,
      ],
      [
        "viewer@example.com",
        "Viewer User",
        "viewer",
        process.env.DEV_VIEWER_PASSWORD,
      ],
    ];
    for (const [email, fullName, role, password] of userSeeds) {
      const existingPassword = existing.get(email);
      if (!existing.has(email) && roleIds.has(role)) {
        await db
          .insert(usersTable)
          .values({
            email,
            fullName,
            roleId: roleIds.get(role)!,
            passwordHash: password
              ? await passwordHash(password)
              : DISABLED_PASSWORD_HASH,
            isActive: true,
          })
          .onConflictDoNothing();
      } else if (isProduction && existing.has(email)) {
        await db
          .update(usersTable)
          .set({
            passwordHash: password
              ? await passwordHash(password)
              : DISABLED_PASSWORD_HASH,
            updatedAt: now(),
          })
          .where(eq(usersTable.email, email));
      } else if (
        password &&
        existingPassword &&
        !existingPassword.startsWith("scrypt$")
      ) {
        await db
          .update(usersTable)
          .set({ passwordHash: await passwordHash(password), updatedAt: now() })
          .where(eq(usersTable.email, email));
      }
    }
    const serverSeeds = [
      {
        name: "win-server-01",
        displayName: "Windows Server 01",
        hostname: "win-server-01.invalid",
        environment: "Development",
        operatingSystem: "Windows Server 2022",
        winrmPort: 5986,
        useHttps: true,
        certificateValidation: "validate",
        credentialReference: "windows-automation-host",
        isActive: true,
      },
      {
        name: "win-server-02",
        displayName: "Windows Server 02",
        hostname: "win-server-02.invalid",
        environment: "Development",
        operatingSystem: "Windows Server 2022",
        winrmPort: 5986,
        useHttps: true,
        certificateValidation: "validate",
        credentialReference: "windows-automation-host",
        isActive: true,
      },
    ];
    for (const server of serverSeeds) {
      await db.insert(serversTable).values(server).onConflictDoNothing();
    }
    const automationSeeds = [
      {
        code: "restart_windows_service",
        name: "Restart Windows Service",
        description:
          "Restart or start an approved Windows service and verify its final state.",
        playbookKey: "restart_windows_service",
        powershellScriptKey: "restart_windows_service",
        parameterSchema: [
          {
            name: "service_name",
            label: "Service",
            type: "select",
            required: true,
            options: ["Spooler", "W32Time", "Dnscache", "LanmanServer"],
          },
        ],
        riskLevel: "medium",
        timeoutSeconds: 300,
        requiredRole: "operator",
        requiresChangeNumber: true,
        requiresConfirmation: true,
        isActive: true,
        targetOs: "Windows Server",
        expectedMinutes: 3,
      },
      {
        code: "get_server_health",
        name: "Get Windows Server Health",
        description:
          "Collect operating-system, uptime, CPU, memory, and service-health information.",
        playbookKey: "get_server_health",
        powershellScriptKey: "get_server_health",
        parameterSchema: [],
        riskLevel: "low",
        timeoutSeconds: 180,
        requiredRole: "operator",
        requiresChangeNumber: false,
        requiresConfirmation: true,
        isActive: true,
        targetOs: "Windows Server",
        expectedMinutes: 2,
      },
      {
        code: "get_disk_space",
        name: "Get Disk Space",
        description:
          "Read total, used, free, and free-percent values for selected fixed drives.",
        playbookKey: "get_disk_space",
        powershellScriptKey: "get_disk_space",
        parameterSchema: [
          {
            name: "drive_letters",
            label: "Drive letters",
            type: "multi-select",
            required: true,
            options: ["C", "D", "E", "F"],
          },
        ],
        riskLevel: "low",
        timeoutSeconds: 180,
        requiredRole: "operator",
        requiresChangeNumber: false,
        requiresConfirmation: true,
        isActive: true,
        targetOs: "Windows Server",
        expectedMinutes: 2,
      },
    ];
    const existingAutomations = await db
      .select({ code: automationsTable.code })
      .from(automationsTable);
    const automationCodes = new Set(
      existingAutomations.map((automation) => automation.code),
    );
    for (const automation of automationSeeds) {
      if (!automationCodes.has(automation.code)) {
        await db
          .insert(automationsTable)
          .values(automation)
          .onConflictDoNothing();
      }
    }
    await db
      .insert(workerHeartbeatTable)
      .values({ id: 1, lastSeenAt: now() })
      .onConflictDoNothing();
  })().catch((error) => {
    seedPromise = undefined;
    throw error;
  });
  return seedPromise;
}

async function userFromSession(req: Request): Promise<SessionUser | null> {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (typeof raw !== "string" || raw.length < 32) return null;
  const hash = secretDigest(raw);
  const [session] = await db
    .select()
    .from(userSessionsTable)
    .where(eq(userSessionsTable.tokenHash, hash))
    .limit(1);
  if (!session || session.expiresAt <= now()) return null;
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, session.userId))
    .limit(1);
  if (!user || !user.isActive) return null;
  const [role] = await db
    .select()
    .from(rolesTable)
    .where(eq(rolesTable.id, user.roleId))
    .limit(1);
  if (!role || !["admin", "operator", "viewer"].includes(role.name))
    return null;
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: role.name as RoleName,
    isActive: user.isActive,
  };
}

async function requireUser(
  req: PortalRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await ensureSeeded();
    const user = await userFromSession(req);
    if (!user) {
      res.status(401).json({ error: "Sign in to continue" });
      return;
    }
    req.portalUser = user;
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const csrf = req.get("x-csrf-token");
      const cookie = req.cookies?.[CSRF_COOKIE];
      if (
        !csrf ||
        !cookie ||
        !safeEqual(secretDigest(csrf), secretDigest(cookie))
      ) {
        res.status(403).json({ error: "CSRF validation failed" });
        return;
      }
      const [session] = await db
        .select()
        .from(userSessionsTable)
        .where(
          eq(
            userSessionsTable.tokenHash,
            secretDigest(req.cookies[SESSION_COOKIE]),
          ),
        )
        .limit(1);
      if (!session || !safeEqual(session.csrfHash, secretDigest(csrf))) {
        res.status(403).json({ error: "CSRF validation failed" });
        return;
      }
    }
    next();
  } catch (error) {
    next(error);
  }
}

function requireRole(...roles: RoleName[]) {
  return (req: PortalRequest, res: Response, next: NextFunction): void => {
    if (!req.portalUser || !roles.includes(req.portalUser.role)) {
      res
        .status(403)
        .json({ error: "You do not have permission to perform this action" });
      return;
    }
    next();
  };
}

async function appendAudit(
  req: Request,
  userId: string | null,
  action: string,
  resourceType: string,
  resourceId: string | null,
  details: unknown = {},
): Promise<void> {
  await db.insert(auditLogsTable).values({
    userId,
    action,
    resourceType,
    resourceId,
    sanitizedDetailsJson: sanitizeJson(details) as Record<string, unknown>,
    sourceIp: req.ip?.slice(0, 100) ?? null,
  });
}

async function addJobEvent(
  jobId: string,
  eventType: string,
  message: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(jobEventsTable).values({
    jobId,
    eventType,
    message: sanitizeText(message),
    sanitizedDetailsJson: sanitizeJson(details) as Record<string, unknown>,
  });
}

function automationResponse(row: typeof automationsTable.$inferSelect) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    playbook_key: row.playbookKey,
    powershell_script_key: row.powershellScriptKey,
    parameter_schema: row.parameterSchema,
    risk_level: row.riskLevel,
    timeout_seconds: row.timeoutSeconds,
    required_role: row.requiredRole,
    requires_change_number: row.requiresChangeNumber,
    requires_confirmation: row.requiresConfirmation,
    is_active: row.isActive,
    target_os: row.targetOs,
    expected_minutes: row.expectedMinutes,
  };
}

function serverResponse(row: typeof serversTable.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    display_name: row.displayName,
    hostname: row.hostname,
    environment: row.environment,
    operating_system: row.operatingSystem,
    winrm_port: row.winrmPort,
    use_https: row.useHttps,
    certificate_validation: row.certificateValidation,
    credential_reference: row.credentialReference,
    is_active: row.isActive,
    last_connection_status: row.lastConnectionStatus,
    last_connection_at: row.lastConnectionAt?.toISOString() ?? null,
  };
}

async function jobResponse(
  row: typeof jobsTable.$inferSelect,
  includeEvents = false,
) {
  const [[automation], [server], [user]] = await Promise.all([
    db
      .select()
      .from(automationsTable)
      .where(eq(automationsTable.id, row.automationDefinitionId))
      .limit(1),
    db
      .select()
      .from(serversTable)
      .where(eq(serversTable.id, row.serverId))
      .limit(1),
    db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, row.requestedByUserId))
      .limit(1),
  ]);
  const events = includeEvents
    ? await db
      .select()
      .from(jobEventsTable)
      .where(eq(jobEventsTable.jobId, row.id))
      .orderBy(asc(jobEventsTable.createdAt))
    : [];
  return {
    id: row.id,
    automation_id: row.automationDefinitionId,
    automation_name: automation?.name ?? "Unknown automation",
    server_id: row.serverId,
    server_name: server?.displayName ?? server?.name ?? "Unknown server",
    requested_by_user_id: row.requestedByUserId,
    requested_by: user?.fullName ?? "Unknown user",
    parent_job_id: row.parentJobId,
    status: row.status,
    parameters: maskParameters(row.parametersJson),
    change_number: row.changeNumber,
    business_reason: row.businessReason,
    submitted_at: row.submittedAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    completed_at: row.completedAt?.toISOString() ?? null,
    duration_seconds: row.durationSeconds,
    sanitized_stdout: row.sanitizedStdout
      ? sanitizeText(row.sanitizedStdout)
      : null,
    sanitized_stderr: row.sanitizedStderr
      ? sanitizeText(row.sanitizedStderr)
      : null,
    ansible_return_code: row.ansibleReturnCode,
    error_summary: row.errorSummary ? sanitizeText(row.errorSummary) : null,
    mock_result: row.mockResult,
    cancellation_requested: row.cancellationRequested,
    events: events.map((event) => ({
      id: event.id,
      event_type: event.eventType,
      message: sanitizeText(event.message),
      created_at: event.createdAt.toISOString(),
    })),
  };
}

function validateParameters(
  schema: Array<Record<string, unknown>>,
  parameters: unknown,
): string | null {
  if (
    !parameters ||
    typeof parameters !== "object" ||
    Array.isArray(parameters)
  )
    return "Parameters must be an object";
  const values = parameters as Record<string, unknown>;
  const allowed = new Set(schema.map((item) => String(item.name)));
  if (Object.keys(values).some((name) => !allowed.has(name)))
    return "One or more parameters are not approved";
  for (const item of schema) {
    const name = String(item.name);
    const value = values[name];
    if (
      item.required &&
      (value == null ||
        value === "" ||
        (Array.isArray(value) && value.length === 0))
    ) {
      return `${String(item.label ?? name)} is required`;
    }
    if (value == null || value === "") continue;
    if (
      item.type === "select" &&
      (!Array.isArray(item.options) ||
        !(item.options as unknown[]).includes(value))
    ) {
      return `${String(item.label ?? name)} is not an approved selection`;
    }
    if (
      item.type === "multi-select" &&
      (!Array.isArray(value) ||
        !Array.isArray(item.options) ||
        value.some((entry) => !(item.options as unknown[]).includes(entry)))
    ) {
      return `${String(item.label ?? name)} contains an unapproved selection`;
    }
    if (
      item.type === "number" &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      return `${String(item.label ?? name)} must be a number`;
    }
    if (
      item.type === "text" &&
      (typeof value !== "string" || value.length > 500 || /[\r\n]/.test(value))
    ) {
      return `${String(item.label ?? name)} is invalid`;
    }
  }
  return null;
}

function safeHost(value: string): boolean {
  return (
    value.length <= 253 &&
    /^[A-Za-z0-9.-]+$/.test(value) &&
    !value.startsWith(".") &&
    !value.endsWith(".")
  );
}

async function runAnsible(
  playbookKey: string,
  server: typeof serversTable.$inferSelect,
  parameters: Record<string, unknown>,
  timeoutSeconds: number,
) {
  const playbook = PLAYBOOK_REGISTRY[playbookKey];
  if (!playbook)
    throw new Error("Automation does not reference an approved playbook");
  if (process.env.ANSIBLE_ENABLED !== "true")
    throw new Error(
      "Real execution is disabled. Set ANSIBLE_ENABLED=true on the Linux automation host.",
    );
  if (!safeHost(server.hostname) || !/^[a-zA-Z0-9_-]{1,64}$/.test(server.name))
    throw new Error("Target server is not valid for Ansible execution");
  const workingDirectory = process.env.ANSIBLE_WORKING_DIRECTORY;
  const binary = process.env.ANSIBLE_BINARY || "/usr/bin/ansible-playbook";
  if (!workingDirectory || !path.isAbsolute(workingDirectory))
    throw new Error(
      "Ansible working directory must be configured as an absolute path",
    );
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "wap-"));
  const inventoryPath = path.join(temporaryDirectory, "inventory.yml");
  const varsPath = path.join(temporaryDirectory, "extra-vars.json");
  const inventory = {
    all: {
      children: {
        windows: {
          hosts: {
            [server.name]: {
              ansible_host: server.hostname,
              ansible_connection: "winrm",
              ansible_port: server.winrmPort || 5986,
              ansible_winrm_scheme: "https",
              ansible_winrm_transport:
                process.env.WINDOWS_WINRM_TRANSPORT || "ntlm",
              ansible_winrm_server_cert_validation:
                server.certificateValidation === "ignore"
                  ? "ignore"
                  : "validate",
              ansible_user: "{{ lookup('env', 'WINDOWS_USERNAME') }}",
              ansible_password: "{{ lookup('env', 'WINDOWS_PASSWORD') }}",
            },
          },
        },
      },
    },
  };
  try {
    await writeFile(inventoryPath, JSON.stringify(inventory), { mode: 0o600 });
    await writeFile(
      varsPath,
      JSON.stringify({ target_host: server.name, ...parameters }),
      { mode: 0o600 },
    );
    await chmod(inventoryPath, 0o600);
    await chmod(varsPath, 0o600);
    const minimalEnv = {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: process.env.HOME || "/tmp",
      ANSIBLE_CONFIG:
        process.env.ANSIBLE_CONFIG ||
        path.join(workingDirectory, "ansible.cfg"),
      WINDOWS_USERNAME: process.env.WINDOWS_USERNAME || "",
      WINDOWS_PASSWORD: process.env.WINDOWS_PASSWORD || "",
      ANSIBLE_NOCOLOR: "1",
      ANSIBLE_HOST_KEY_CHECKING: "False",
    };
    const result = await execFileAsync(
      binary,
      [
        "-i",
        inventoryPath,
        path.join(workingDirectory, playbook),
        "--limit",
        server.name,
        "--extra-vars",
        `@${varsPath}`,
      ],
      {
        cwd: workingDirectory,
        env: minimalEnv,
        timeout: Math.min(timeoutSeconds, 3600) * 1000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
    return {
      code: 0,
      stdout: sanitizeText(result.stdout),
      stderr: sanitizeText(result.stderr),
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: sanitizeText(err.stdout),
      stderr: sanitizeText(
        err.stderr || err.message || "Ansible execution failed",
      ),
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function processJob(jobId: string): Promise<void> {
  const [row] = await db
    .update(jobsTable)
    .set({
      status: "running",
      startedAt: now(),
      claimedAt: now(),
      updatedAt: now(),
    })
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.status, "queued")))
    .returning();
  if (!row) return;
  const started = Date.now();
  await addJobEvent(row.id, "started", "Execution started");
  try {
    const [automation] = await db
      .select()
      .from(automationsTable)
      .where(eq(automationsTable.id, row.automationDefinitionId))
      .limit(1);
    const [server] = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.id, row.serverId))
      .limit(1);
    if (!automation || !server)
      throw new Error("Automation or target server is no longer available");
    if (row.cancellationRequested) {
      await db
        .update(jobsTable)
        .set({ status: "cancelled", completedAt: now(), updatedAt: now() })
        .where(eq(jobsTable.id, row.id));
      await addJobEvent(
        row.id,
        "cancelled",
        "Execution cancelled before it started",
      );
      return;
    }
    if (mockMode) {
      const totalMs = 2000 + randomInt(6000);
      const stages = [
        {
          progress: 0.18,
          type: "validated",
          text: "Request validated against the approved parameter schema",
        },
        {
          progress: 0.4,
          type: "connected",
          text: "Mock WinRM HTTPS connection established",
        },
        {
          progress: 0.72,
          type: "script_executed",
          text: `Mock PowerShell script ${automation.powershellScriptKey} executed`,
        },
      ];
      for (const stage of stages) {
        await pause(
          Math.floor((totalMs * stage.progress) / (stages.length + 1)),
        );
        if (row.cancellationRequested) break;
        await addJobEvent(row.id, stage.type, stage.text, { mock: true });
      }
      await pause(Math.max(200, totalMs - totalMs * 0.72));
      const failureRate = Math.min(
        1,
        Math.max(0, Number(process.env.MOCK_FAILURE_RATE || 0)),
      );
      const timeoutRate = Math.min(
        1,
        Math.max(0, Number(process.env.MOCK_TIMEOUT_RATE || 0)),
      );
      const timedOut = randomInt(1_000_000) / 1_000_000 < timeoutRate;
      const failed =
        row.simulateFailure ||
        randomInt(1_000_000) / 1_000_000 < failureRate;
      const status = timedOut ? "timed_out" : failed ? "failed" : "successful";
      const resultText =
        automation.code === "get_disk_space"
          ? JSON.stringify(
            {
              drives: [
                {
                  drive: "C:",
                  total_gb: 240,
                  used_gb: 128.4,
                  free_gb: 111.6,
                  free_percent: 46.5,
                },
              ],
            },
            null,
            2,
          )
          : automation.code === "get_server_health"
            ? JSON.stringify(
              {
                hostname: server.name,
                operating_system: server.operatingSystem,
                uptime_hours: 183.2,
                cpu_percent: 18.4,
                memory_percent: 62.1,
                services_healthy: 6,
              },
              null,
              2,
            )
            : JSON.stringify(
              {
                service:
                  (row.parametersJson as Record<string, unknown>)
                    .service_name ?? "Spooler",
                before: "Running",
                after: "Running",
                action: "Restarted",
              },
              null,
              2,
            );
      const stderr = timedOut
        ? "Job exceeded the configured execution timeout (simulated)."
        : failed
          ? "The simulated PowerShell operation returned a non-zero exit code."
          : "";
      await db
        .update(jobsTable)
        .set({
          status,
          completedAt: now(),
          durationSeconds: Math.max(
            1,
            Math.round((Date.now() - started) / 1000),
          ),
          ansibleReturnCode:
            status === "successful" ? 0 : status === "timed_out" ? 124 : 1,
          sanitizedStdout: sanitizeText(`[MOCK RESULT]\n${resultText}`),
          sanitizedStderr: sanitizeText(stderr),
          errorSummary: status === "successful" ? null : sanitizeText(stderr),
          updatedAt: now(),
        })
        .where(eq(jobsTable.id, row.id));
      await addJobEvent(
        row.id,
        status,
        status === "successful"
          ? "Mock automation completed successfully"
          : status === "timed_out"
            ? "Mock execution timed out"
            : "Mock execution failed",
        { mock: true },
      );
    } else {
      if (!process.env.WINDOWS_USERNAME || !process.env.WINDOWS_PASSWORD) {
        throw new Error(
          "Windows credentials are not configured in the Linux automation host environment",
        );
      }
      await db
        .update(jobsTable)
        .set({ status: "running", updatedAt: now() })
        .where(eq(jobsTable.id, row.id));
      await addJobEvent(
        row.id,
        "connected",
        "Connecting to the allowlisted Windows host over WinRM HTTPS",
      );
      await addJobEvent(
        row.id,
        "script_executed",
        `Executing the registered PowerShell script ${automation.powershellScriptKey}`,
      );
      const result = await runAnsible(
        automation.playbookKey,
        server,
        row.parametersJson as Record<string, unknown>,
        automation.timeoutSeconds,
      );
      const status =
        result.code === 0
          ? "successful"
          : result.code === 124
            ? "timed_out"
            : "failed";
      await db
        .update(jobsTable)
        .set({
          status,
          completedAt: now(),
          durationSeconds: Math.max(
            1,
            Math.round((Date.now() - started) / 1000),
          ),
          ansibleReturnCode: result.code,
          sanitizedStdout: result.stdout,
          sanitizedStderr: result.stderr,
          errorSummary:
            status === "successful"
              ? null
              : sanitizeText(result.stderr || "Ansible execution failed"),
          mockResult: false,
          updatedAt: now(),
        })
        .where(eq(jobsTable.id, row.id));
      await addJobEvent(
        row.id,
        status,
        status === "successful"
          ? "Ansible automation completed"
          : "Ansible automation failed",
        { return_code: result.code },
      );
    }
  } catch (error) {
    const message = sanitizeText(
      (error as Error).message || "Job execution failed",
    );
    await db
      .update(jobsTable)
      .set({
        status: "failed",
        completedAt: now(),
        durationSeconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
        ansibleReturnCode: 1,
        sanitizedStderr: message,
        errorSummary: message,
        mockResult: mockMode,
        updatedAt: now(),
      })
      .where(eq(jobsTable.id, row.id));
    await addJobEvent(row.id, "failed", message, { mock: mockMode });
  }
}

let workerStarted = false;
let workerBusy = false;
async function workerTick(): Promise<void> {
  if (workerBusy) return;
  workerBusy = true;
  try {
    await ensureSeeded();
    await db
      .insert(workerHeartbeatTable)
      .values({ id: 1, lastSeenAt: now() })
      .onConflictDoUpdate({
        target: workerHeartbeatTable.id,
        set: { lastSeenAt: now() },
      });
    const [active] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobsTable)
      .where(sql`${jobsTable.status} in ('validating', 'queued', 'running')`);
    const maxJobs = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 2));
    const available = Math.max(0, maxJobs - Number(active?.count ?? 0));
    if (!available) return;
    const pending = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.status, "pending"))
      .orderBy(asc(jobsTable.submittedAt))
      .limit(available);
    for (const job of pending) {
      const [claimed] = await db
        .update(jobsTable)
        .set({ status: "queued", updatedAt: now() })
        .where(and(eq(jobsTable.id, job.id), eq(jobsTable.status, "pending")))
        .returning({ id: jobsTable.id });
      if (claimed) void processJob(claimed.id);
    }
  } catch (error) {
    // The API still serves health and reports the worker as unavailable on database errors.
    logger.error(
      { error: sanitizeText((error as Error).message) },
      "Portal worker tick failed",
    );
  } finally {
    workerBusy = false;
  }
}

export function startPortalWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  const timer = setInterval(() => void workerTick(), 1000);
  timer.unref();
  void workerTick();
}

router.post("/v1/auth/login", async (req, res): Promise<void> => {
  await ensureSeeded();
  const key = req.ip || "unknown";
  if (!rateLimit(failedLoginAttempts, key, 10, 5 * 60 * 1000)) {
    res
      .status(429)
      .json({ error: "Too many login attempts. Try again later." });
    return;
  }
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid email and password" });
    return;
  }
  const email = normalizeEmail(parsed.data.email);
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);
  const passwordOkay =
    user && user.isActive
      ? await passwordMatches(parsed.data.password, user.passwordHash)
      : false;
  if (!user || !passwordOkay) {
    res
      .status(401)
      .json({
        error:
          "Email or password is incorrect. Development account passwords are configured by the project administrator.",
      });
    return;
  }
  const [role] = await db
    .select()
    .from(rolesTable)
    .where(eq(rolesTable.id, user.roleId))
    .limit(1);
  if (!role) {
    res.status(401).json({ error: "Account role is unavailable" });
    return;
  }
  const token = randomBytes(32).toString("hex");
  const csrf = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  await db.insert(userSessionsTable).values({
    userId: user.id,
    tokenHash: secretDigest(token),
    csrfHash: secretDigest(csrf),
    expiresAt,
  });
  await db
    .update(usersTable)
    .set({ lastLoginAt: now(), updatedAt: now() })
    .where(eq(usersTable.id, user.id));
  const cookieOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
  res.cookie(SESSION_COOKIE, token, cookieOptions);
  res.cookie(CSRF_COOKIE, csrf, { ...cookieOptions, httpOnly: false });
  await appendAudit(req, user.id, "login", "user", user.id, {
    email: user.email,
  });
  res.json({
    id: user.id,
    email: user.email,
    full_name: user.fullName,
    role: role.name,
    is_active: user.isActive,
  });
});

router.post(
  "/v1/auth/logout",
  requireUser,
  async (req: PortalRequest, res): Promise<void> => {
    const raw = req.cookies?.[SESSION_COOKIE];
    if (raw) {
      await db
        .delete(userSessionsTable)
        .where(eq(userSessionsTable.tokenHash, secretDigest(raw)));
    }
    await appendAudit(
      req,
      req.portalUser?.id ?? null,
      "logout",
      "user",
      req.portalUser?.id ?? null,
    );
    res.clearCookie(SESSION_COOKIE, {
      path: "/",
      secure: isProduction,
      sameSite: "lax",
    });
    res.clearCookie(CSRF_COOKIE, {
      path: "/",
      secure: isProduction,
      sameSite: "lax",
    });
    res.status(204).end();
  },
);

router.get("/v1/auth/me", requireUser, (req: PortalRequest, res) => {
  const user = req.portalUser!;
  res.json({
    id: user.id,
    email: user.email,
    full_name: user.fullName,
    role: user.role,
    is_active: user.isActive,
  });
});

router.get(
  "/v1/dashboard/summary",
  requireUser,
  async (_req, res): Promise<void> => {
    await ensureSeeded();
    const [totalRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobsTable);
    const grouped = await db
      .select({ status: jobsTable.status, count: sql<number>`count(*)::int` })
      .from(jobsTable)
      .groupBy(jobsTable.status);
    const counts = Object.fromEntries(
      grouped.map((item) => [item.status, Number(item.count)]),
    );
    const total = Number(totalRow?.count ?? 0);
    const successful = counts.successful ?? 0;
    const completed =
      successful + (counts.failed ?? 0) + (counts.timed_out ?? 0);
    const [heartbeat] = await db
      .select()
      .from(workerHeartbeatTable)
      .where(eq(workerHeartbeatTable.id, 1))
      .limit(1);
    res.json({
      total,
      running: counts.running ?? 0,
      successful,
      failed: counts.failed ?? 0,
      success_rate: completed
        ? Math.round((successful / completed) * 1000) / 10
        : 0,
      mock_mode: mockMode,
      worker_online: Boolean(
        heartbeat && Date.now() - heartbeat.lastSeenAt.getTime() < 15000,
      ),
      by_status: counts,
    });
  },
);

router.get(
  "/v1/dashboard/activity",
  requireUser,
  async (req, res): Promise<void> => {
    const parsed = GetDashboardActivityQueryParams.safeParse(req.query);
    const limit = parsed.success ? parsed.data.limit : 10;
    const rows = await db
      .select()
      .from(jobsTable)
      .orderBy(desc(jobsTable.submittedAt))
      .limit(limit);
    const jobs = await Promise.all(rows.map((row) => jobResponse(row)));
    res.json(jobs);
  },
);

router.get("/v1/automations", requireUser, async (req, res): Promise<void> => {
  const parsed = ListAutomationsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid catalogue filters" });
    return;
  }
  const rows = await db
    .select()
    .from(automationsTable)
    .orderBy(asc(automationsTable.name));
  const filtered = rows.filter((item) => {
    if (
      parsed.data.active !== undefined &&
      item.isActive !== parsed.data.active
    )
      return false;
    if (parsed.data.risk && item.riskLevel !== parsed.data.risk) return false;
    if (
      parsed.data.search &&
      !`${item.name} ${item.description} ${item.code}`
        .toLowerCase()
        .includes(parsed.data.search.toLowerCase())
    )
      return false;
    return true;
  });
  res.json(filtered.map(automationResponse));
});

router.get(
  "/v1/automations/:id",
  requireUser,
  async (req, res): Promise<void> => {
    const [row] = await db
      .select()
      .from(automationsTable)
      .where(eq(automationsTable.id, String(req.params.id)))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Automation not found" });
      return;
    }
    res.json(automationResponse(row));
  },
);

router.post(
  "/v1/automations",
  requireUser,
  requireRole("admin"),
  async (req: PortalRequest, res): Promise<void> => {
    const parsed = CreateAutomationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Automation definition is invalid" });
      return;
    }
    const input = parsed.data;
    if (
      !PLAYBOOK_REGISTRY[input.playbook_key] ||
      SCRIPT_REGISTRY[input.powershell_script_key] !==
      SCRIPT_REGISTRY[input.playbook_key]
    ) {
      res
        .status(400)
        .json({
          error: "Only registered playbook and script keys are permitted",
        });
      return;
    }
    const [created] = await db
      .insert(automationsTable)
      .values({
        code: input.code,
        name: input.name,
        description: input.description,
        playbookKey: input.playbook_key,
        powershellScriptKey: input.powershell_script_key,
        parameterSchema: input.parameter_schema,
        riskLevel: input.risk_level,
        timeoutSeconds: input.timeout_seconds,
        requiredRole: input.required_role,
        requiresChangeNumber: input.requires_change_number,
        requiresConfirmation: input.requires_confirmation,
        isActive: input.is_active,
      })
      .returning();
    await appendAudit(
      req,
      req.portalUser!.id,
      "automation_created",
      "automation",
      created.id,
      { before: null, after: automationResponse(created) },
    );
    res.status(201).json(automationResponse(created));
  },
);

router.put(
  "/v1/automations/:id",
  requireUser,
  requireRole("admin"),
  async (req: PortalRequest, res): Promise<void> => {
    const parsed = UpdateAutomationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Automation definition is invalid" });
      return;
    }
    const input = parsed.data;
    if (
      !PLAYBOOK_REGISTRY[input.playbook_key] ||
      SCRIPT_REGISTRY[input.powershell_script_key] !==
      SCRIPT_REGISTRY[input.playbook_key]
    ) {
      res
        .status(400)
        .json({
          error: "Only registered playbook and script keys are permitted",
        });
      return;
    }
    const [before] = await db
      .select()
      .from(automationsTable)
      .where(eq(automationsTable.id, String(req.params.id)))
      .limit(1);
    if (!before) {
      res.status(404).json({ error: "Automation not found" });
      return;
    }
    const [updated] = await db
      .update(automationsTable)
      .set({
        code: input.code,
        name: input.name,
        description: input.description,
        playbookKey: input.playbook_key,
        powershellScriptKey: input.powershell_script_key,
        parameterSchema: input.parameter_schema,
        riskLevel: input.risk_level,
        timeoutSeconds: input.timeout_seconds,
        requiredRole: input.required_role,
        requiresChangeNumber: input.requires_change_number,
        requiresConfirmation: input.requires_confirmation,
        isActive: input.is_active,
        updatedAt: now(),
      })
      .where(eq(automationsTable.id, before.id))
      .returning();
    await appendAudit(
      req,
      req.portalUser!.id,
      "automation_updated",
      "automation",
      updated.id,
      {
        before: automationResponse(before),
        after: automationResponse(updated),
      },
    );
    res.json(automationResponse(updated));
  },
);

router.patch(
  "/v1/automations/:id/status",
  requireUser,
  requireRole("admin"),
  async (req: PortalRequest, res): Promise<void> => {
    const parsed = SetAutomationStatusBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Status must include is_active" });
      return;
    }
    const [before] = await db
      .select()
      .from(automationsTable)
      .where(eq(automationsTable.id, String(req.params.id)))
      .limit(1);
    if (!before) {
      res.status(404).json({ error: "Automation not found" });
      return;
    }
    const [updated] = await db
      .update(automationsTable)
      .set({ isActive: parsed.data.is_active, updatedAt: now() })
      .where(eq(automationsTable.id, before.id))
      .returning();
    await appendAudit(
      req,
      req.portalUser!.id,
      "automation_status_changed",
      "automation",
      updated.id,
      {
        before: { is_active: before.isActive },
        after: { is_active: updated.isActive },
      },
    );
    res.json(automationResponse(updated));
  },
);

router.get("/v1/servers", requireUser, async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(serversTable)
    .orderBy(asc(serversTable.name));
  res.json(rows.map(serverResponse));
});

router.get("/v1/servers/:id", requireUser, async (req, res): Promise<void> => {
  const [row] = await db
    .select()
    .from(serversTable)
    .where(eq(serversTable.id, String(req.params.id)))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Server not found" });
    return;
  }
  res.json(serverResponse(row));
});

router.post(
  "/v1/servers",
  requireUser,
  requireRole("admin"),
  async (req: PortalRequest, res): Promise<void> => {
    const parsed = CreateServerBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Server definition is invalid" });
      return;
    }
    const input = parsed.data;
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(input.name) ||
      !safeHost(input.hostname)
    ) {
      res.status(400).json({ error: "Server name or hostname is invalid" });
      return;
    }
    if (input.use_https && input.winrm_port !== 5986) {
      res
        .status(400)
        .json({ error: "WinRM over HTTPS must use the approved port 5986" });
      return;
    }
    const [created] = await db
      .insert(serversTable)
      .values({
        name: input.name,
        displayName: input.display_name,
        hostname: input.hostname,
        environment: input.environment,
        operatingSystem: input.operating_system,
        winrmPort: input.winrm_port,
        useHttps: input.use_https,
        certificateValidation: input.certificate_validation,
        credentialReference: input.credential_reference,
        isActive: input.is_active,
      })
      .returning();
    await appendAudit(
      req,
      req.portalUser!.id,
      "server_created",
      "server",
      created.id,
      { before: null, after: serverResponse(created) },
    );
    res.status(201).json(serverResponse(created));
  },
);

router.put(
  "/v1/servers/:id",
  requireUser,
  requireRole("admin"),
  async (req: PortalRequest, res): Promise<void> => {
    const parsed = UpdateServerBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Server definition is invalid" });
      return;
    }
    const input = parsed.data;
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(input.name) ||
      !safeHost(input.hostname) ||
      (input.use_https && input.winrm_port !== 5986)
    ) {
      res
        .status(400)
        .json({ error: "Server name, hostname, or WinRM port is invalid" });
      return;
    }
    const [before] = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.id, String(req.params.id)))
      .limit(1);
    if (!before) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const [updated] = await db
      .update(serversTable)
      .set({
        name: input.name,
        displayName: input.display_name,
        hostname: input.hostname,
        environment: input.environment,
        operatingSystem: input.operating_system,
        winrmPort: input.winrm_port,
        useHttps: input.use_https,
        certificateValidation: input.certificate_validation,
        credentialReference: input.credential_reference,
        isActive: input.is_active,
        updatedAt: now(),
      })
      .where(eq(serversTable.id, before.id))
      .returning();
    await appendAudit(
      req,
      req.portalUser!.id,
      "server_updated",
      "server",
      updated.id,
      { before: serverResponse(before), after: serverResponse(updated) },
    );
    res.json(serverResponse(updated));
  },
);

router.patch(
  "/v1/servers/:id/status",
  requireUser,
  requireRole("admin"),
  async (req: PortalRequest, res): Promise<void> => {
    const parsed = SetServerStatusBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Status must include is_active" });
      return;
    }
    const [before] = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.id, String(req.params.id)))
      .limit(1);
    if (!before) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    const [updated] = await db
      .update(serversTable)
      .set({ isActive: parsed.data.is_active, updatedAt: now() })
      .where(eq(serversTable.id, before.id))
      .returning();
    await appendAudit(
      req,
      req.portalUser!.id,
      "server_status_changed",
      "server",
      updated.id,
      {
        before: { is_active: before.isActive },
        after: { is_active: updated.isActive },
      },
    );
    res.json(serverResponse(updated));
  },
);

router.post(
  "/v1/servers/:id/test-connection",
  requireUser,
  requireRole("admin"),
  async (req: PortalRequest, res): Promise<void> => {
    const [server] = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.id, String(req.params.id)))
      .limit(1);
    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    let success = false;
    let message = "";
    if (mockMode) {
      success = true;
      message = "Mock connection successful. No Windows server was contacted.";
    } else {
      const result = await runAnsible(
        "test_windows_connection",
        server,
        {},
        30,
      );
      success = result.code === 0;
      message = success
        ? "WinRM HTTPS connection succeeded."
        : "WinRM connection failed. Review the sanitized server-side logs.";
    }
    const testedAt = now();
    await db
      .update(serversTable)
      .set({
        lastConnectionStatus: success ? "success" : "failed",
        lastConnectionAt: testedAt,
        updatedAt: testedAt,
      })
      .where(eq(serversTable.id, server.id));
    await appendAudit(
      req,
      req.portalUser!.id,
      "server_connection_tested",
      "server",
      server.id,
      { success, mock: mockMode },
    );
    res.json({
      success,
      message,
      tested_at: testedAt.toISOString(),
      mock: mockMode,
    });
  },
);

router.get(
  "/v1/jobs",
  requireUser,
  async (req: PortalRequest, res): Promise<void> => {
    const parsed = ListJobsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid job filters" });
      return;
    }
    const filters = parsed.data;
    const conditions = [];
    if (filters.status) conditions.push(eq(jobsTable.status, filters.status));
    if (filters.automation_id)
      conditions.push(
        eq(jobsTable.automationDefinitionId, filters.automation_id),
      );
    if (filters.server_id)
      conditions.push(eq(jobsTable.serverId, filters.server_id));
    if (filters.user_id)
      conditions.push(eq(jobsTable.requestedByUserId, filters.user_id));
    if (req.portalUser?.role === "viewer")
      conditions.push(eq(jobsTable.requestedByUserId, req.portalUser.id));
    if (filters.from)
      conditions.push(
        gte(jobsTable.submittedAt, new Date(`${filters.from}T00:00:00.000Z`)),
      );
    if (filters.to)
      conditions.push(
        lte(jobsTable.submittedAt, new Date(`${filters.to}T23:59:59.999Z`)),
      );
    if (filters.search) {
      const matchingAutomations = await db
        .select({ id: automationsTable.id })
        .from(automationsTable)
        .where(ilike(automationsTable.name, `%${filters.search}%`));
      const matchingServers = await db
        .select({ id: serversTable.id })
        .from(serversTable)
        .where(
          or(
            ilike(serversTable.name, `%${filters.search}%`),
            ilike(serversTable.displayName, `%${filters.search}%`),
          ),
        );
      const matchingUsers = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(ilike(usersTable.fullName, `%${filters.search}%`));
      const searchConditions = [
        ilike(jobsTable.businessReason, `%${filters.search}%`),
        ...(matchingAutomations.length
          ? [
            sql`${jobsTable.automationDefinitionId} in (${sql.join(
              matchingAutomations.map((row) => sql`${row.id}`),
              sql`, `,
            )})`,
          ]
          : []),
        ...(matchingServers.length
          ? [
            sql`${jobsTable.serverId} in (${sql.join(
              matchingServers.map((row) => sql`${row.id}`),
              sql`, `,
            )})`,
          ]
          : []),
        ...(matchingUsers.length
          ? [
            sql`${jobsTable.requestedByUserId} in (${sql.join(
              matchingUsers.map((row) => sql`${row.id}`),
              sql`, `,
            )})`,
          ]
          : []),
      ];
      conditions.push(or(...searchConditions)!);
    }
    const whereClause = conditions.length ? and(...conditions) : undefined;
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobsTable)
      .where(whereClause);
    const page = filters.page || 1;
    const pageSize = filters.page_size || 20;
    const rows = await db
      .select()
      .from(jobsTable)
      .where(whereClause)
      .orderBy(
        filters.sort === "oldest"
          ? asc(jobsTable.submittedAt)
          : desc(jobsTable.submittedAt),
      )
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const items = await Promise.all(rows.map((row) => jobResponse(row)));
    res.json({
      items,
      total: Number(countRow?.count ?? 0),
      page,
      page_size: pageSize,
    });
  },
);

router.post(
  "/v1/jobs",
  requireUser,
  requireRole("operator", "admin"),
  async (req: PortalRequest, res): Promise<void> => {
    const key = req.portalUser!.id;
    if (!rateLimit(submissionAttempts, key, 20, 60 * 60 * 1000)) {
      res
        .status(429)
        .json({ error: "Job submission limit reached. Try again later." });
      return;
    }
    const parsed = CreateJobBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Job request is invalid" });
      return;
    }
    const input = parsed.data;
    const [[automation], [server]] = await Promise.all([
      db
        .select()
        .from(automationsTable)
        .where(eq(automationsTable.id, input.automation_id))
        .limit(1),
      db
        .select()
        .from(serversTable)
        .where(eq(serversTable.id, input.server_id))
        .limit(1),
    ]);
    if (
      !automation ||
      !automation.isActive ||
      !PLAYBOOK_REGISTRY[automation.playbookKey] ||
      SCRIPT_REGISTRY[automation.powershellScriptKey] !==
      SCRIPT_REGISTRY[automation.playbookKey]
    ) {
      res
        .status(400)
        .json({ error: "Automation is inactive or not allowlisted" });
      return;
    }
    if (!server || !server.isActive) {
      res
        .status(400)
        .json({ error: "Target server is inactive or unavailable" });
      return;
    }
    const parameterError = validateParameters(
      automation.parameterSchema,
      input.parameters,
    );
    if (parameterError) {
      res.status(400).json({ error: parameterError });
      return;
    }
    if (automation.requiresConfirmation && input.confirmed !== true) {
      res
        .status(400)
        .json({ error: "Confirm the automation before submitting" });
      return;
    }
    if (
      automation.requiresChangeNumber &&
      !/^[A-Za-z][A-Za-z0-9_-]{1,31}$/.test(input.change_number || "")
    ) {
      res
        .status(400)
        .json({ error: "A valid change or incident number is required" });
      return;
    }
    if (!mockMode && input.simulate_failure) {
      res
        .status(400)
        .json({ error: "Failure simulation is available only in mock mode" });
      return;
    }
    const [created] = await db
      .insert(jobsTable)
      .values({
        automationDefinitionId: automation.id,
        serverId: server.id,
        requestedByUserId: req.portalUser!.id,
        status: "pending",
        parametersJson: input.parameters as Record<string, unknown>,
        changeNumber: input.change_number || null,
        businessReason: input.business_reason,
        mockResult: mockMode,
        simulateFailure: Boolean(input.simulate_failure && mockMode),
      })
      .returning();
    await addJobEvent(created.id, "submitted", "Automation request submitted", {
      mock: mockMode,
    });
    await addJobEvent(
      created.id,
      "validated",
      "Request passed server-side validation",
    );
    await appendAudit(
      req,
      req.portalUser!.id,
      "job_submitted",
      "job",
      created.id,
      {
        automation: automation.code,
        server: server.name,
        parameters: maskParameters(input.parameters),
      },
    );
    res.status(202).json(await jobResponse(created, true));
  },
);

router.get(
  "/v1/jobs/export",
  requireUser,
  async (req: PortalRequest, res): Promise<void> => {
    const rows = await db
      .select()
      .from(jobsTable)
      .where(
        req.portalUser?.role === "viewer"
          ? eq(jobsTable.requestedByUserId, req.portalUser.id)
          : undefined,
      )
      .orderBy(desc(jobsTable.submittedAt))
      .limit(5000);
    const headings = [
      "job_id",
      "automation",
      "server",
      "requested_by",
      "status",
      "submitted_at",
      "completed_at",
      "change_number",
      "business_reason",
    ];
    const formulaSafe = (value: unknown) => {
      const string = sanitizeText(value == null ? "" : String(value));
      return `"${(/^[=+\-@\t\r]/.test(string) ? `'${string}` : string).replace(/"/g, '""')}"`;
    };
    const records = await Promise.all(
      rows.map(async (row) => {
        const [job] = await db
          .select()
          .from(jobsTable)
          .where(eq(jobsTable.id, row.id))
          .limit(1);
        const values = await jobResponse(job);
        return [
          values.id,
          values.automation_name,
          values.server_name,
          values.requested_by,
          values.status,
          values.submitted_at,
          values.completed_at,
          values.change_number,
          values.business_reason,
        ]
          .map(formulaSafe)
          .join(",");
      }),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="automation-jobs.csv"',
    );
    res.send([headings.join(","), ...records].join("\r\n"));
  },
);

router.get(
  "/v1/jobs/:id",
  requireUser,
  async (req: PortalRequest, res): Promise<void> => {
    const [row] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, String(req.params.id)))
      .limit(1);
    if (
      !row ||
      (req.portalUser?.role === "viewer" &&
        row.requestedByUserId !== req.portalUser.id)
    ) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json(await jobResponse(row, true));
  },
);

router.get(
  "/v1/jobs/:id/events",
  requireUser,
  async (req: PortalRequest, res): Promise<void> => {
    const [job] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, String(req.params.id)))
      .limit(1);
    if (
      !job ||
      (req.portalUser?.role === "viewer" &&
        job.requestedByUserId !== req.portalUser.id)
    ) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    const events = await db
      .select()
      .from(jobEventsTable)
      .where(eq(jobEventsTable.jobId, job.id))
      .orderBy(asc(jobEventsTable.createdAt));
    res.json(
      events.map((event) => ({
        id: event.id,
        event_type: event.eventType,
        message: sanitizeText(event.message),
        created_at: event.createdAt.toISOString(),
      })),
    );
  },
);

router.post(
  "/v1/jobs/:id/cancel",
  requireUser,
  requireRole("operator", "admin"),
  async (req: PortalRequest, res): Promise<void> => {
    const [job] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, String(req.params.id)))
      .limit(1);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (job.status !== "pending" && job.status !== "queued") {
      res.status(409).json({ error: "This job can no longer be cancelled" });
      return;
    }
    const [updated] = await db
      .update(jobsTable)
      .set({
        status: "cancelled",
        completedAt: now(),
        cancellationRequested: true,
        updatedAt: now(),
      })
      .where(eq(jobsTable.id, job.id))
      .returning();
    await addJobEvent(job.id, "cancelled", "Job cancelled before execution");
    await appendAudit(req, req.portalUser!.id, "job_cancelled", "job", job.id);
    res.json(await jobResponse(updated, true));
  },
);

router.post(
  "/v1/jobs/:id/retry",
  requireUser,
  requireRole("operator", "admin"),
  async (req: PortalRequest, res): Promise<void> => {
    const [parent] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, String(req.params.id)))
      .limit(1);
    if (!parent) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    if (!["failed", "timed_out"].includes(parent.status)) {
      res
        .status(409)
        .json({ error: "Only failed or timed-out jobs can be retried" });
      return;
    }
    const [retry] = await db
      .insert(jobsTable)
      .values({
        automationDefinitionId: parent.automationDefinitionId,
        serverId: parent.serverId,
        requestedByUserId: req.portalUser!.id,
        parentJobId: parent.id,
        status: "pending",
        parametersJson: parent.parametersJson,
        changeNumber: parent.changeNumber,
        businessReason: parent.businessReason,
        mockResult: mockMode,
        simulateFailure: false,
      })
      .returning();
    await addJobEvent(
      retry.id,
      "submitted",
      `Retry of job ${parent.id} submitted`,
      { parent_job_id: parent.id },
    );
    await addJobEvent(
      retry.id,
      "validated",
      "Retry request passed server-side validation",
    );
    await appendAudit(req, req.portalUser!.id, "job_retried", "job", retry.id, {
      parent_job_id: parent.id,
    });
    res.status(202).json(await jobResponse(retry, true));
  },
);

router.get(
  "/v1/jobs/:id/log",
  requireUser,
  async (req: PortalRequest, res): Promise<void> => {
    const [job] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, String(req.params.id)))
      .limit(1);
    if (
      !job ||
      (req.portalUser?.role === "viewer" &&
        job.requestedByUserId !== req.portalUser.id)
    ) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    await appendAudit(
      req,
      req.portalUser!.id,
      "job_log_downloaded",
      "job",
      job.id,
    );
    res
      .type("text/plain")
      .send(
        [
          `Job ${job.id}`,
          `Status: ${job.status}`,
          `Exit code: ${job.ansibleReturnCode ?? "n/a"}`,
          "",
          "STDOUT",
          sanitizeText(job.sanitizedStdout),
          "",
          "STDERR",
          sanitizeText(job.sanitizedStderr),
        ].join("\n"),
      );
  },
);

router.get(
  "/v1/audit-logs",
  requireUser,
  requireRole("admin"),
  async (req, res): Promise<void> => {
    const parsed = ListAuditLogsQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid audit filters" });
      return;
    }
    const filters = parsed.data;
    const conditions = filters.search
      ? [
        or(
          ilike(auditLogsTable.action, `%${filters.search}%`),
          ilike(auditLogsTable.resourceType, `%${filters.search}%`),
        )!,
      ]
      : [];
    const whereClause = conditions.length ? and(...conditions) : undefined;
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogsTable)
      .where(whereClause);
    const page = filters.page || 1;
    const pageSize = filters.page_size || 50;
    const rows = await db
      .select()
      .from(auditLogsTable)
      .where(whereClause)
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const items = await Promise.all(
      rows.map(async (row) => {
        const [user] = row.userId
          ? await db
            .select()
            .from(usersTable)
            .where(eq(usersTable.id, row.userId))
            .limit(1)
          : [];
        return {
          id: row.id,
          user_id: row.userId,
          user_name: user?.fullName ?? "System",
          action: row.action,
          resource_type: row.resourceType,
          resource_id: row.resourceId,
          details: sanitizeJson(row.sanitizedDetailsJson),
          created_at: row.createdAt.toISOString(),
        };
      }),
    );
    res.json({
      items,
      total: Number(countRow?.count ?? 0),
      page,
      page_size: pageSize,
    });
  },
);

router.get("/ready", async (_req, res): Promise<void> => {
  try {
    await ensureSeeded();
    const [heartbeat] = await db
      .select()
      .from(workerHeartbeatTable)
      .where(eq(workerHeartbeatTable.id, 1))
      .limit(1);
    const workerOnline = Boolean(
      heartbeat && Date.now() - heartbeat.lastSeenAt.getTime() < 15000,
    );
    res
      .status(workerOnline ? 200 : 503)
      .json({
        status: workerOnline ? "ready" : "worker_unavailable",
        database: "connected",
        worker_online: workerOnline,
        mock_mode: mockMode,
      });
  } catch {
    res
      .status(503)
      .json({
        status: "not_ready",
        database: "unavailable",
        worker_online: false,
        mock_mode: mockMode,
      });
  }
});

export default router;
