// Execution stops — ADR 0010's kill switch (ADR 0016 §11, widened by ADR 0017 §6)
// — as a narrow, typed owner boundary over ops.execution_stops.
//
// WHAT A STOP DOES. An active stop holds every external job it covers, at one of
// six scopes: global, tenant, company, department, agent, or job_kind (every job
// of one external kind, for one tenant or for all). The database checks it, and
// this module never does: a covered job is passed over at the lease and stays
// queued without consuming an attempt; the external_call runtime asks again
// before any external call; and an agent run is also refused when it is requested
// (recorded as a cancelled run naming the stop, with no job) and again at its
// start. Every read follows a shared advisory lock that trip and clear take
// exclusively, so a trip that has returned is seen by every later lease and
// start. It never interrupts a call already on the wire.
//
// DENY WINS. Any active stop that covers a job holds it; a clear narrower scope
// never outweighs a stopped wider one. There is no force or override parameter,
// and there must never be one: an escape hatch is how a kill switch becomes
// advisory (ADR 0010). An act carries who and why, and nothing else.
//
// WHO. Every act through this module is a human one. The actor prefix `system:`
// is reserved for the database's automatic trips (the spend ceiling sweep), and a
// stop's origin is derived from it, so a human act naming it is refused here. The
// prefix `principal:` is reserved for a Company OS member the operator surface
// identified (Phase 2C), so an owner-CLI label can never be mistaken for one.
// Owner and system stops on the same target are separate rows: clearing one never
// clears the other.
//
// CLEARING is an owner act recorded on the row — who, why and when — and, apart
// from redacting free text to the literal [redacted], it is the only change a
// stop ever sees. An active stop cannot be deleted, and the table cannot be
// truncated. Nothing clears a stop automatically. Tripping an active target again
// answers with the same stop; once it is cleared, the next trip is a new stop and
// the cleared one stays as history.
//
// WHO CAN CALL THIS: a transaction running as the database owner, in practice
// `npm run execution-stop` (engine/cli/executionStop.ts). No application role
// holds any privilege on ops.execution_stops or can execute the functions called
// here. Like companyOs.ts, each act validates before the database, calls exactly
// one function and never assembles a row. The reads are plain reads: a stop list
// has no function to go through, and no tenant to scope it.
//
// The target check mirrors ops.trip_execution_stop, in its order, so a malformed
// target is refused without a round trip. The database still decides, including
// whether each id exists inside its tenant and whether a kind is external.

import type { TxClient } from "../db/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";

export type ExecutionStopScope =
  | "global"
  | "tenant"
  | "company"
  | "department"
  | "agent"
  | "job_kind";

export const EXECUTION_STOP_SCOPES: readonly ExecutionStopScope[] =
  Object.freeze([
    "global",
    "tenant",
    "company",
    "department",
    "agent",
    "job_kind",
  ]);

export type ExecutionStopOrigin = "owner" | "system";

export interface ExecutionStopTarget {
  readonly scope: ExecutionStopScope;
  /** Required for every scope but global and job_kind; optional for job_kind. */
  readonly tenantId?: string;
  readonly companyId?: string;
  readonly departmentId?: string;
  readonly agentId?: string;
  /** Only for scope job_kind: an external job kind, e.g. `agent_run.execute`. */
  readonly jobKind?: string;
}

export interface ExecutionStopAct {
  /** Why: 1 to 500 characters, not blank. Recorded on the row. */
  readonly reason: string;
  /** Who: a label such as `owner` or `ops:oncall`, never `system:…`. Recorded on the row. */
  readonly actor: string;
}

export interface ExecutionStopRow {
  readonly id: string;
  readonly scope: ExecutionStopScope;
  readonly tenantId: string | null;
  readonly companyId: string | null;
  readonly departmentId: string | null;
  readonly agentId: string | null;
  readonly jobKind: string | null;
  /** Derived by the database from the actor: `system:` is a system stop. */
  readonly origin: ExecutionStopOrigin;
  readonly reason: string;
  readonly trippedBy: string;
  /** ISO 8601, from the database's clock. */
  readonly trippedAt: string;
  readonly clearedBy: string | null;
  readonly clearedReason: string | null;
  readonly clearedAt: string | null;
}

export interface ExecutionStopTripOutcome {
  readonly stopId: string;
  /** `already_stopped`: an active stop at the same target and origin absorbed the trip. */
  readonly outcome: "stopped" | "already_stopped";
  /** Who tripped the stop that is now active: this act's actor, or the earlier one's. */
  readonly trippedBy: string;
}

/** A list is bounded: the newest this many stops. */
export const MAX_LISTED_EXECUTION_STOPS = 200;

type Coordinate =
  | "tenantId"
  | "companyId"
  | "departmentId"
  | "agentId"
  | "jobKind";

// The execution_stops_scope_shape CHECK, as data: the coordinates each scope
// requires, and the ones it may name. Every other coordinate must be absent.
const SCOPE_COORDINATES: Readonly<
  Record<
    ExecutionStopScope,
    {
      readonly required: readonly Coordinate[];
      readonly optional: readonly Coordinate[];
    }
  >
> = Object.freeze({
  global: { required: [], optional: [] },
  tenant: { required: ["tenantId"], optional: [] },
  company: { required: ["tenantId", "companyId"], optional: [] },
  department: {
    required: ["tenantId", "companyId", "departmentId"],
    optional: [],
  },
  agent: { required: ["tenantId", "companyId", "agentId"], optional: [] },
  job_kind: { required: ["jobKind"], optional: ["tenantId"] },
});

const COORDINATES: readonly Coordinate[] = Object.freeze([
  "tenantId",
  "companyId",
  "departmentId",
  "agentId",
  "jobKind",
]);

/** Scopes that need no tenant. */
const TENANTLESS_SCOPES: readonly ExecutionStopScope[] = Object.freeze([
  "global",
  "job_kind",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = /^[a-z0-9][a-z0-9_.:@-]{0,127}$/;
const SYSTEM_ACTOR_PREFIX = "system:";
const PRINCIPAL_ACTOR_PREFIX = "principal:";
// The execution_stops_job_kind_format CHECK. ASCII only, so a JS length and
// char_length agree.
const JOB_KIND = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const MAX_JOB_KIND_LENGTH = 100;
const MAX_REASON_LENGTH = 500;
// btrim() with no characters argument trims SPACES only, and the reason CHECK
// measures char_length(btrim(reason)). Mirrored exactly, in code points.
const EDGE_SPACES = /^ +| +$/g;
const ORIGINS: readonly ExecutionStopOrigin[] = Object.freeze([
  "owner",
  "system",
]);

// `pg` turns timestamptz into a Date parsed in the process's time zone, and
// to_json(timestamptz) renders the offset of the SESSION's TimeZone (measured:
// +00:00 under UTC, -03:00 under America/Sao_Paulo for the same stop). Rendered
// in UTC here, the text is the same for every caller and every session.
const LIST_SQL = `select s.id, s.scope, s.tenant_id, s.company_id, s.department_id, s.agent_id,
       s.job_kind, s.origin, s.reason, s.tripped_by,
       to_char(s.tripped_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as tripped_at,
       s.cleared_by, s.cleared_reason,
       to_char(s.cleared_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cleared_at
  from ops.execution_stops s
 where $1::boolean or s.cleared_at is null
 order by s.tripped_at desc, s.id
 limit $2`;

// The insert guard sets tripped_at to now(), the transaction's timestamp, so a
// stop this transaction recorded is the one whose tripped_at equals it.
const OUTCOME_SQL = `select s.tripped_by, s.reason, s.tripped_at = now() as recorded_now
  from ops.execution_stops s
 where s.id = $1`;

interface ExecutionStopRecord {
  id: string;
  scope: string;
  tenant_id: string | null;
  company_id: string | null;
  department_id: string | null;
  agent_id: string | null;
  job_kind: string | null;
  origin: string;
  reason: string;
  tripped_by: string;
  tripped_at: string;
  cleared_by: string | null;
  cleared_reason: string | null;
  cleared_at: string | null;
}

export function isExecutionStopScope(
  value: unknown,
): value is ExecutionStopScope {
  return (
    typeof value === "string" &&
    (EXECUTION_STOP_SCOPES as readonly string[]).includes(value)
  );
}

const isAbsent = (value: unknown): boolean =>
  value === undefined || value === null;

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new CompanyOsError("malformed_identifier", `${field} is not a uuid`);
  }
  return value;
}

const optionalUuid = (value: unknown, field: string): string | null =>
  isAbsent(value) ? null : requireUuid(value, field);

function optionalJobKind(value: unknown): string | null {
  if (isAbsent(value)) return null;
  if (
    typeof value !== "string" ||
    value.length > MAX_JOB_KIND_LENGTH ||
    !JOB_KIND.test(value)
  ) {
    throw new CompanyOsError(
      "invalid_argument",
      "jobKind is not a job kind such as agent_run.execute",
    );
  }
  return value;
}

type TargetParams = [
  ExecutionStopScope,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
];

/** [scope, tenant, company, department, agent, jobKind], in ops.trip_execution_stop's order of refusal. */
function targetParams(target: ExecutionStopTarget): TargetParams {
  const { scope } = target;
  if (!isExecutionStopScope(scope)) {
    throw new CompanyOsError(
      "invalid_argument",
      `${String(scope)} is not a stop scope`,
    );
  }
  if (
    !TENANTLESS_SCOPES.includes(scope) &&
    (isAbsent(target.tenantId) || target.tenantId === "")
  ) {
    throw new CompanyOsError(
      "missing_tenant_scope",
      "a scoped stop needs its tenant",
    );
  }
  const { required, optional } = SCOPE_COORDINATES[scope];
  for (const coordinate of COORDINATES) {
    if (optional.includes(coordinate)) continue;
    if (isAbsent(target[coordinate]) === required.includes(coordinate)) {
      throw new CompanyOsError(
        "invalid_argument",
        `the target does not match scope ${scope}`,
      );
    }
  }
  const jobKind = optionalJobKind(target.jobKind);
  return [
    scope,
    optionalUuid(target.tenantId, "tenantId"),
    optionalUuid(target.companyId, "companyId"),
    optionalUuid(target.departmentId, "departmentId"),
    optionalUuid(target.agentId, "agentId"),
    jobKind,
  ];
}

/**
 * Never looser than the database. It is stricter in two places: a reason with no
 * visible character is refused here, although btrim(), which trims only spaces,
 * would let a tab-only reason through; and the `system:` actor prefix, which the
 * database reads as an automatic trip, and the `principal:` prefix, which names a
 * Company OS member the operator surface identified, are refused for every act
 * made here.
 */
function actParams(act: ExecutionStopAct): [string, string] {
  const { reason, actor } = act;
  if (
    typeof reason !== "string" ||
    !/\S/.test(reason) ||
    [...reason.replace(EDGE_SPACES, "")].length > MAX_REASON_LENGTH
  ) {
    throw new CompanyOsError(
      "invalid_argument",
      `reason must be 1 to ${MAX_REASON_LENGTH} characters and not blank`,
    );
  }
  if (typeof actor !== "string" || !ACTOR.test(actor)) {
    throw new CompanyOsError(
      "invalid_argument",
      "actor is missing or malformed",
    );
  }
  if (actor.startsWith(SYSTEM_ACTOR_PREFIX)) {
    throw new CompanyOsError(
      "invalid_argument",
      "the actor prefix system: is reserved for automatic trips; a person names themselves",
    );
  }
  if (actor.startsWith(PRINCIPAL_ACTOR_PREFIX)) {
    throw new CompanyOsError(
      "invalid_argument",
      "the actor prefix principal: is reserved for a Company OS member the operator surface identified; a person at the owner CLI names themselves",
    );
  }
  return [reason, actor];
}

async function query<TRow>(
  tx: TxClient,
  sql: string,
  params: readonly unknown[],
): Promise<TRow[]> {
  try {
    return (await tx.query<TRow>(sql, params)).rows;
  } catch (error) {
    throw toDomainError(error);
  }
}

async function call(
  tx: TxClient,
  sql: string,
  params: readonly unknown[],
): Promise<unknown> {
  const rows = await query<{ result: unknown }>(tx, sql, params);
  return rows[0]?.result;
}

function toRow(record: ExecutionStopRecord): ExecutionStopRow {
  if (!isExecutionStopScope(record.scope)) {
    throw new Error("ops.execution_stops returned a row with an unknown scope");
  }
  if (!ORIGINS.includes(record.origin as ExecutionStopOrigin)) {
    throw new Error(
      "ops.execution_stops returned a row with an unknown origin",
    );
  }
  return {
    id: record.id,
    scope: record.scope,
    tenantId: record.tenant_id,
    companyId: record.company_id,
    departmentId: record.department_id,
    agentId: record.agent_id,
    jobKind: record.job_kind,
    origin: record.origin as ExecutionStopOrigin,
    reason: record.reason,
    trippedBy: record.tripped_by,
    trippedAt: record.tripped_at,
    clearedBy: record.cleared_by,
    clearedReason: record.cleared_reason,
    clearedAt: record.cleared_at,
  };
}

// Every service is `async`, so invalid input REJECTS the returned promise rather
// than throwing before one exists.

/** Trips a stop and resolves to its id; an already-active identical target answers with its stop. */
export async function tripExecutionStop(
  tx: TxClient,
  target: ExecutionStopTarget,
  act: ExecutionStopAct,
): Promise<string> {
  const [scope, tenantId, companyId, departmentId, agentId, jobKind] =
    targetParams(target);
  const [reason, actor] = actParams(act);
  const id = await call(
    tx,
    "select ops.trip_execution_stop($1, $2, $3, $4, $5, $6, $7, $8) as result",
    [scope, reason, actor, tenantId, companyId, departmentId, agentId, jobKind],
  );
  if (typeof id !== "string") {
    throw new Error("the database returned no execution stop id");
  }
  return id;
}

/**
 * Trips a stop, then reads it back in the same transaction to say whether THIS
 * act recorded it. `stopped` only when the active stop was recorded now, by this
 * actor, with this reason; otherwise an existing stop at the same target and
 * origin absorbed the trip, and `trippedBy` names who tripped it.
 */
export async function tripExecutionStopWithOutcome(
  tx: TxClient,
  target: ExecutionStopTarget,
  act: ExecutionStopAct,
): Promise<ExecutionStopTripOutcome> {
  const stopId = await tripExecutionStop(tx, target, act);
  const [row] = await query<{
    tripped_by: string;
    reason: string;
    recorded_now: boolean;
  }>(tx, OUTCOME_SQL, [stopId]);
  if (row === undefined || typeof row.tripped_by !== "string") {
    throw new Error("the execution stop the database returned is unreadable");
  }
  const recordedByThisAct =
    row.recorded_now === true &&
    row.tripped_by === act.actor &&
    row.reason === act.reason;
  return {
    stopId,
    outcome: recordedByThisAct ? "stopped" : "already_stopped",
    trippedBy: row.tripped_by,
  };
}

/**
 * Clears an active stop. Resolves to true when this act cleared it, false when it
 * was already cleared — in which case nothing changed and the first clearing
 * stands. An unknown stop is `not_found`.
 */
export async function clearExecutionStop(
  tx: TxClient,
  stopId: string,
  act: ExecutionStopAct,
): Promise<boolean> {
  const id = requireUuid(stopId, "stopId");
  const [reason, actor] = actParams(act);
  const cleared = await call(
    tx,
    "select ops.clear_execution_stop($1, $2, $3) as result",
    [id, reason, actor],
  );
  if (typeof cleared !== "boolean") {
    throw new Error("the database returned no clearing outcome");
  }
  return cleared;
}

/** The newest stops first, at most MAX_LISTED_EXECUTION_STOPS; active ones only unless `includeCleared`. */
export async function listExecutionStops(
  tx: TxClient,
  options: { readonly includeCleared?: boolean } = {},
): Promise<readonly ExecutionStopRow[]> {
  const includeCleared = options.includeCleared ?? false;
  if (typeof includeCleared !== "boolean") {
    throw new CompanyOsError(
      "invalid_argument",
      "includeCleared must be a boolean",
    );
  }
  const records = await query<ExecutionStopRecord>(tx, LIST_SQL, [
    includeCleared,
    MAX_LISTED_EXECUTION_STOPS,
  ]);
  return records.map(toRow);
}
