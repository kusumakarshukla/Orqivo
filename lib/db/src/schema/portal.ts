import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const rolesTable = pgTable("roles", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
  permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usersTable = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    fullName: text("full_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    roleId: uuid("role_id").notNull().references(() => rolesTable.id),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("users_email_idx").on(table.email)],
);

export const userSessionsTable = pgTable(
  "user_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    csrfHash: text("csrf_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("user_sessions_user_idx").on(table.userId), index("user_sessions_expiry_idx").on(table.expiresAt)],
);

export const serversTable = pgTable(
  "servers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull().unique(),
    displayName: text("display_name").notNull(),
    hostname: text("hostname").notNull(),
    environment: text("environment").notNull(),
    operatingSystem: text("operating_system").notNull().default("Windows Server"),
    winrmPort: integer("winrm_port").notNull().default(5986),
    useHttps: boolean("use_https").notNull().default(true),
    certificateValidation: text("certificate_validation").notNull().default("validate"),
    credentialReference: text("credential_reference").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastConnectionStatus: text("last_connection_status").notNull().default("unknown"),
    lastConnectionAt: timestamp("last_connection_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("servers_active_idx").on(table.isActive)],
);

export const automationsTable = pgTable(
  "automation_definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    playbookKey: text("playbook_key").notNull(),
    powershellScriptKey: text("powershell_script_key").notNull(),
    parameterSchema: jsonb("parameter_schema").$type<Array<Record<string, unknown>>>().notNull().default([]),
    riskLevel: text("risk_level").notNull(),
    timeoutSeconds: integer("timeout_seconds").notNull().default(600),
    requiredRole: text("required_role").notNull().default("operator"),
    requiresChangeNumber: boolean("requires_change_number").notNull().default(false),
    requiresConfirmation: boolean("requires_confirmation").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    targetOs: text("target_os").notNull().default("Windows Server"),
    expectedMinutes: integer("expected_minutes").notNull().default(2),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("automations_active_idx").on(table.isActive), index("automations_risk_idx").on(table.riskLevel)],
);

export const jobsTable = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationDefinitionId: uuid("automation_definition_id").notNull().references(() => automationsTable.id),
    serverId: uuid("server_id").notNull().references(() => serversTable.id),
    requestedByUserId: uuid("requested_by_user_id").notNull().references(() => usersTable.id),
    parentJobId: uuid("parent_job_id"),
    status: text("status").notNull().default("pending"),
    parametersJson: jsonb("parameters_json").$type<Record<string, unknown>>().notNull().default({}),
    changeNumber: text("change_number"),
    businessReason: text("business_reason").notNull(),
    ansibleReturnCode: integer("ansible_return_code"),
    sanitizedStdout: text("sanitized_stdout"),
    sanitizedStderr: text("sanitized_stderr"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    errorSummary: text("error_summary"),
    cancellationRequested: boolean("cancellation_requested").notNull().default(false),
    mockResult: boolean("mock_result").notNull().default(true),
    simulateFailure: boolean("simulate_failure").notNull().default(false),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("jobs_status_idx").on(table.status),
    index("jobs_submitted_idx").on(table.submittedAt),
    index("jobs_requester_idx").on(table.requestedByUserId),
    index("jobs_server_idx").on(table.serverId),
    index("jobs_automation_idx").on(table.automationDefinitionId),
    index("jobs_pending_idx").on(table.status, table.submittedAt),
  ],
);

export const jobEventsTable = pgTable(
  "job_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: uuid("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    message: text("message").notNull(),
    sanitizedDetailsJson: jsonb("sanitized_details_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("job_events_job_idx").on(table.jobId, table.createdAt)],
);

export const auditLogsTable = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    sanitizedDetailsJson: jsonb("sanitized_details_json").$type<Record<string, unknown>>().notNull().default({}),
    sourceIp: text("source_ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_created_idx").on(table.createdAt), index("audit_action_idx").on(table.action)],
);

export const applicationSettingsTable = pgTable("application_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: text("key").notNull().unique(),
  valueJson: jsonb("value_json").$type<unknown>().notNull().default({}),
  description: text("description").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedByUserId: uuid("updated_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
});

export const workerHeartbeatTable = pgTable("worker_heartbeat", {
  id: integer("id").primaryKey().default(1),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});
