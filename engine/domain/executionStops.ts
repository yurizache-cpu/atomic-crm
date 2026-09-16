// Execution stops — ADR 0010's kill switch in its minimal Phase 1D shape
// (ADR 0016 §11) — as a narrow, typed owner boundary over ops.execution_stops.
//
// WHAT A STOP DOES. An active stop refuses every NEW agent run it covers, at one
// of five scopes: global, tenant, company, department, agent. The database checks
// it twice, and this module neither: when a run is requested
// (ops.request_agent_run records the refusal as a cancelled run naming the stop,
// and creates no job), and again immediately before the provider call
// (ops.start_agent_run). Both reads follow a shared advisory lock that trip and
// clear take exclusively, so a trip that has returned is seen by every later
// start. It never interrupts a call already on the wire.
//
// DENY WINS. Any active stop that covers a run refuses it; a clear narrower scope
// never outweighs a stopped wider one. There is no force or override parameter,
// and there must never be one: an escape hatch is how a kill switch becomes
// advisory (ADR 0010). An act carries who and why, and nothing else.
//
// CLEARING is an owner act recorded on the row — who, why and when — and, apart
// from redacting free text to the literal [redacted], it is the only change a
// stop ever sees. An active stop cannot be deleted, and the table cannot be
// truncated. Nothing clears a stop automatically. Tripping
// an active target again answers with the same stop; once it is cleared, the next
// trip is a new stop and the cleared one stays as history.
//
// WHO CAN CALL THIS: a transaction running as the database owner, in practice
// `npm run execution-stop` (engine/cli/executionStop.ts). No application role
// holds any privilege on ops.execution_stops or can execute the functions called
// here (asserted in supabase/tests/agent_runtime.sql). Like companyOs.ts, each act
// validates before the database, calls exactly one function and never assembles a
// row. `listExecutionStops` is the one plain read: a stop list has no function to
// go through, and no tenant to scope it — a global stop belongs to none.
//
// The target check mirrors ops.trip_execution_stop, in its order, so a malformed
// target is refused without a round trip. The database still decides, including
// whether each id exists inside its tenant.

import type { TxClient } from "../db/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";

export type ExecutionStopScope =
  | "global"
  | "tenant"
  | "company"
  | "department"
  | "agent";

export const EXECUTION_STOP_SCOPES: readonly ExecutionStopScope[] =
  Object.freeze(["global", "tenant", "company", "department", "agent"]);

export interface ExecutionStopTarget {
  readonly scope: ExecutionStopScope;
  readonly tenantId?: string;
  readonly companyId?: string;
  readonly departmentId?: string;
  readonly agentId?: string;
}

export interface ExecutionStopAct {
  /** Why: 1 to 500 characters, not blank. Recorded on the row. */
  readonly reason: string;
  /** Who: a label such as `owner` or `ops:oncall`. Recorded on the row. */
  readonly actor: string;
}

export interface ExecutionStopRow {
  readonly id: string;
  readonly scope: ExecutionStopScope;
  readonly tenantId: string | null;
  readonly companyId: string | null;
  readonly departmentId: string | null;
  readonly agentId: string | null;
  readonly reason: string;
  readonly trippedBy: string;
  /** ISO 8601, from the database's clock. */
  readonly trippedAt: string;
  readonly clearedBy: string | null;
  readonly clearedReason: string | null;
  readonly clearedAt: string | null;
}

/** A list is bounded: the newest this many stops. */
export const MAX_LISTED_EXECUTION_STOPS = 200;

type Coordinate = "tenantId" | "companyId" | "departmentId" | "agentId";

// The execution_stops_scope_shape CHECK, as data: the coordinates each scope
// names. Every coordinate a scope does not name must be absent.
const SCOPE_COORDINATES: Readonly<
  Record<ExecutionStopScope, readonly Coordinate[]>
> = Object.freeze({
  global: [],
  tenant: ["tenantId"],
  company: ["tenantId", "companyId"],
  department: ["tenantId", "companyId", "departmentId"],
  agent: ["tenantId", "companyId", "agentId"],
});

const COORDINATES: readonly Coordinate[] = Object.freeze([
  "tenantId",
  "companyId",
  "departmentId",
  "agentId",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = /^[a-z0-9][a-z0-9_.:@-]{0,127}$/;
const MAX_REASON_LENGTH = 500;
// btrim() with no characters argument trims SPACES only, and the reason CHECK
// measures char_length(btrim(reason)). Mirrored exactly, in code points.
const EDGE_SPACES = /^ +| +$/g;

// `pg` turns timestamptz into a Date parsed in the process's time zone, and
// to_json(timestamptz) renders the offset of the SESSION's TimeZone (measured:
// +00:00 under UTC, -03:00 under America/Sao_Paulo for the same stop). Rendered
// in UTC here, the text is the same for every caller and every session.
const LIST_SQL = `select s.id, s.scope, s.tenant_id, s.company_id, s.department_id, s.agent_id,
       s.reason, s.tripped_by,
       to_char(s.tripped_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as tripped_at,
       s.cleared_by, s.cleared_reason,
       to_char(s.cleared_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cleared_at
  from ops.execution_stops s
 where $1::boolean or s.cleared_at is null
 order by s.tripped_at desc, s.id
 limit $2`;

interface ExecutionStopRecord {
  id: string;
  scope: string;
  tenant_id: string | null;
  company_id: string | null;
  department_id: string | null;
  agent_id: string | null;
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

/** [scope, tenant, company, department, agent], in ops.trip_execution_stop's order of refusal. */
function targetParams(
  target: ExecutionStopTarget,
): [
  ExecutionStopScope,
  string | null,
  string | null,
  string | null,
  string | null,
] {
  const { scope } = target;
  if (!isExecutionStopScope(scope)) {
    throw new CompanyOsError(
      "invalid_argument",
      `${String(scope)} is not a stop scope`,
    );
  }
  if (
    scope !== "global" &&
    (isAbsent(target.tenantId) || target.tenantId === "")
  ) {
    throw new CompanyOsError(
      "missing_tenant_scope",
      "a scoped stop needs its tenant",
    );
  }
  const named = SCOPE_COORDINATES[scope];
  for (const coordinate of COORDINATES) {
    if (isAbsent(target[coordinate]) === named.includes(coordinate)) {
      throw new CompanyOsError(
        "invalid_argument",
        `the target does not match scope ${scope}`,
      );
    }
  }
  return [
    scope,
    optionalUuid(target.tenantId, "tenantId"),
    optionalUuid(target.companyId, "companyId"),
    optionalUuid(target.departmentId, "departmentId"),
    optionalUuid(target.agentId, "agentId"),
  ];
}

/**
 * Never looser than the database. It is stricter in one place: a reason with no
 * visible character is refused here, although btrim(), which trims only spaces,
 * would let a tab-only reason through.
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
  return [reason, actor];
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

function toRow(record: ExecutionStopRecord): ExecutionStopRow {
  if (!isExecutionStopScope(record.scope)) {
    throw new Error("ops.execution_stops returned a row with an unknown scope");
  }
  return {
    id: record.id,
    scope: record.scope,
    tenantId: record.tenant_id,
    companyId: record.company_id,
    departmentId: record.department_id,
    agentId: record.agent_id,
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
  const [scope, tenantId, companyId, departmentId, agentId] =
    targetParams(target);
  const [reason, actor] = actParams(act);
  const id = await call(
    tx,
    "select ops.trip_execution_stop($1, $2, $3, $4, $5, $6, $7) as result",
    [scope, reason, actor, tenantId, companyId, departmentId, agentId],
  );
  if (typeof id !== "string") {
    throw new Error("the database returned no execution stop id");
  }
  return id;
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
  let records: ExecutionStopRecord[];
  try {
    ({ rows: records } = await tx.query<ExecutionStopRecord>(LIST_SQL, [
      includeCleared,
      MAX_LISTED_EXECUTION_STOPS,
    ]));
  } catch (error) {
    throw toDomainError(error);
  }
  return records.map(toRow);
}
