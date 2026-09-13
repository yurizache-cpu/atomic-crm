// The Company OS domain services — a narrow, typed boundary over the database.
//
// The authority, the validation that matters, the transaction and the event
// all live in the ops.* functions (supabase/migrations/20260912200000_…). This
// module adds what TypeScript can: typed inputs, fast rejection of input that
// can never be valid, and typed errors. It never assembles a row itself, so no
// caller can write a Company OS row that skipped its checks or its event.
//
// WHO CAN CALL THIS IN PHASE 1C: a transaction running as the database owner —
// the driver-backed tests. No application role can execute the functions it
// calls (asserted in supabase/tests/company_domain_core.sql), no operator tool
// ships, and a future runtime caller arrives through a wrapper that resolves the
// tenant itself (ADR 0015), never through a postgres connection string.
//
// `tenantId` is the tenant scope the caller is ALREADY authorised for. It is
// never read from a payload, and every other id passed here is untrusted: the
// database resolves it inside that scope or answers "not found".

import type { TxClient } from "../db/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";
import { isTaskStatus, type TaskStatus } from "./taskStateMachine.ts";

export type OrgUnitStatus = "active" | "inactive";

export const ORG_UNIT_STATUSES: readonly OrgUnitStatus[] = Object.freeze([
  "active",
  "inactive",
]);

export interface DomainContext {
  /** The authorised tenant scope. Never taken from a payload. */
  readonly tenantId: string;
  /** Provenance recorded on every event this call produces. */
  readonly source: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

export interface CreateCompanyInput {
  readonly slug: string;
  readonly name: string;
}

export interface CreateDepartmentInput {
  readonly companyId: string;
  readonly slug: string;
  readonly name: string;
}

export interface CreateAgentInput {
  readonly companyId: string;
  readonly departmentId: string;
  readonly slug: string;
  readonly name: string;
  readonly role: string;
  readonly description?: string;
}

export interface CreateTaskInput {
  readonly companyId: string;
  /** Tenant vocabulary, e.g. "crm.follow_up". Only its shape is checked. */
  readonly type: string;
  readonly title: string;
  readonly description?: string;
  readonly departmentId?: string;
  readonly parentTaskId?: string;
  readonly priority?: number;
  readonly dueAt?: Date;
}

export type EventSubjectType = "company" | "department" | "agent" | "task";

export interface RecordEventInput {
  readonly companyId: string;
  /** A business fact outside the derived lifecycle namespaces. */
  readonly type: string;
  readonly subject?: { readonly type: EventSubjectType; readonly id: string };
  readonly payload?: Record<string, unknown>;
}

export interface RequestTaskExecutionInput {
  readonly taskId: string;
  readonly kind: string;
  readonly payload?: Record<string, unknown>;
  readonly idempotencyKey?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE = /^[a-z][a-z0-9_.:-]{0,127}$/;

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new CompanyOsError("malformed_identifier", `${field} is not a uuid`);
  }
  return value;
}

function optionalUuid(value: unknown, field: string): string | null {
  return value === undefined || value === null
    ? null
    : requireUuid(value, field);
}

/**
 * The tenant scope and provenance, validated before anything reaches the
 * database. A missing scope fails closed here AND in every function.
 */
function contextParams(
  context: DomainContext,
): [string, string, string | null, string | null] {
  if (context.tenantId === undefined || context.tenantId === "") {
    throw new CompanyOsError("missing_tenant_scope", "no tenant scope");
  }
  const tenantId = requireUuid(context.tenantId, "tenantId");
  if (!SOURCE.test(context.source ?? "")) {
    throw new CompanyOsError(
      "invalid_argument",
      "source is missing or malformed",
    );
  }
  return [
    tenantId,
    context.source,
    optionalUuid(context.correlationId, "correlationId"),
    optionalUuid(context.causationId, "causationId"),
  ];
}

function requireStatus(value: unknown): OrgUnitStatus {
  if (!ORG_UNIT_STATUSES.includes(value as OrgUnitStatus)) {
    throw new CompanyOsError(
      "invalid_argument",
      `${String(value)} is not a status`,
    );
  }
  return value as OrgUnitStatus;
}

async function call(
  tx: TxClient,
  sql: string,
  params: readonly unknown[],
): Promise<unknown> {
  try {
    const { rows } = await tx.query<{ result: unknown }>(sql, params);
    return rows[0]?.result;
  } catch (error) {
    throw toDomainError(error);
  }
}

async function callForId(
  tx: TxClient,
  sql: string,
  params: readonly unknown[],
): Promise<string> {
  const id = await call(tx, sql, params);
  if (typeof id !== "string") {
    throw new Error(`the database returned no id for: ${sql}`);
  }
  return id;
}

// Every service is `async`, so invalid input REJECTS the returned promise
// rather than throwing before one exists — a caller handling the promise never
// misses a validation failure.

export async function createCompany(
  tx: TxClient,
  context: DomainContext,
  input: CreateCompanyInput,
): Promise<string> {
  const [tenant, source, correlation, causation] = contextParams(context);
  return callForId(
    tx,
    "select ops.create_company($1, $2, $3, $4, $5, $6) as result",
    [tenant, input.slug, input.name, source, correlation, causation],
  );
}

export async function setCompanyStatus(
  tx: TxClient,
  context: DomainContext,
  companyId: string,
  status: OrgUnitStatus,
): Promise<void> {
  const [tenant, source, correlation, causation] = contextParams(context);
  await call(
    tx,
    "select ops.set_company_status($1, $2, $3, $4, $5, $6) as result",
    [
      tenant,
      requireUuid(companyId, "companyId"),
      requireStatus(status),
      source,
      correlation,
      causation,
    ],
  );
}

export async function createDepartment(
  tx: TxClient,
  context: DomainContext,
  input: CreateDepartmentInput,
): Promise<string> {
  const [tenant, source, correlation, causation] = contextParams(context);
  return callForId(
    tx,
    "select ops.create_department($1, $2, $3, $4, $5, $6, $7) as result",
    [
      tenant,
      requireUuid(input.companyId, "companyId"),
      input.slug,
      input.name,
      source,
      correlation,
      causation,
    ],
  );
}

export async function setDepartmentStatus(
  tx: TxClient,
  context: DomainContext,
  departmentId: string,
  status: OrgUnitStatus,
): Promise<void> {
  const [tenant, source, correlation, causation] = contextParams(context);
  await call(
    tx,
    "select ops.set_department_status($1, $2, $3, $4, $5, $6) as result",
    [
      tenant,
      requireUuid(departmentId, "departmentId"),
      requireStatus(status),
      source,
      correlation,
      causation,
    ],
  );
}

export async function createAgent(
  tx: TxClient,
  context: DomainContext,
  input: CreateAgentInput,
): Promise<string> {
  const [tenant, source, correlation, causation] = contextParams(context);
  return callForId(
    tx,
    "select ops.create_agent($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as result",
    [
      tenant,
      requireUuid(input.companyId, "companyId"),
      requireUuid(input.departmentId, "departmentId"),
      input.slug,
      input.name,
      input.role,
      source,
      input.description ?? null,
      correlation,
      causation,
    ],
  );
}

export async function setAgentStatus(
  tx: TxClient,
  context: DomainContext,
  agentId: string,
  status: OrgUnitStatus,
): Promise<void> {
  const [tenant, source, correlation, causation] = contextParams(context);
  await call(
    tx,
    "select ops.set_agent_status($1, $2, $3, $4, $5, $6) as result",
    [
      tenant,
      requireUuid(agentId, "agentId"),
      requireStatus(status),
      source,
      correlation,
      causation,
    ],
  );
}

export async function createTask(
  tx: TxClient,
  context: DomainContext,
  input: CreateTaskInput,
): Promise<string> {
  const [tenant, source, correlation, causation] = contextParams(context);
  return callForId(
    tx,
    "select ops.create_task($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) as result",
    [
      tenant,
      requireUuid(input.companyId, "companyId"),
      input.type,
      input.title,
      source,
      input.description ?? null,
      optionalUuid(input.departmentId, "departmentId"),
      optionalUuid(input.parentTaskId, "parentTaskId"),
      input.priority ?? 100,
      input.dueAt ?? null,
      correlation,
      causation,
    ],
  );
}

/** Deterministic: the caller names the agent; the database decides if it may. */
export async function assignTask(
  tx: TxClient,
  context: DomainContext,
  taskId: string,
  agentId: string,
): Promise<void> {
  const [tenant, source, correlation, causation] = contextParams(context);
  await call(tx, "select ops.assign_task($1, $2, $3, $4, $5, $6) as result", [
    tenant,
    requireUuid(taskId, "taskId"),
    requireUuid(agentId, "agentId"),
    source,
    correlation,
    causation,
  ]);
}

export async function transitionTask(
  tx: TxClient,
  context: DomainContext,
  taskId: string,
  toStatus: TaskStatus,
): Promise<void> {
  const [tenant, source, correlation, causation] = contextParams(context);
  if (!isTaskStatus(toStatus)) {
    throw new CompanyOsError(
      "invalid_argument",
      `${String(toStatus)} is not a task status`,
    );
  }
  await call(
    tx,
    "select ops.transition_task($1, $2, $3, $4, $5, $6) as result",
    [
      tenant,
      requireUuid(taskId, "taskId"),
      toStatus,
      source,
      correlation,
      causation,
    ],
  );
}

export async function recordEvent(
  tx: TxClient,
  context: DomainContext,
  input: RecordEventInput,
): Promise<string> {
  const [tenant, source, correlation, causation] = contextParams(context);
  return callForId(
    tx,
    "select ops.record_event($1, $2, $3, $4, $5, $6, $7, $8, $9) as result",
    [
      tenant,
      requireUuid(input.companyId, "companyId"),
      input.type,
      source,
      input.subject?.type ?? null,
      input.subject ? requireUuid(input.subject.id, "subject.id") : null,
      JSON.stringify(input.payload ?? {}),
      correlation,
      causation,
    ],
  );
}

/** Refused for every kind in Phase 1C: ops.task_executable_kinds() is empty. */
export async function requestTaskExecution(
  tx: TxClient,
  context: DomainContext,
  input: RequestTaskExecutionInput,
): Promise<string> {
  const [tenant, source, correlation, causation] = contextParams(context);
  return callForId(
    tx,
    "select ops.request_task_execution($1, $2, $3, $4, $5, $6, $7, $8) as result",
    [
      tenant,
      requireUuid(input.taskId, "taskId"),
      input.kind,
      source,
      JSON.stringify(input.payload ?? {}),
      input.idempotencyKey ?? null,
      correlation,
      causation,
    ],
  );
}
