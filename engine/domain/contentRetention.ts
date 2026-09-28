// BASELINE Q8 D6/D7 (ADR 0020 §H): the owner's narrow, typed boundary over
// the AI working-content retention ledger, ops.content_retention.
//
// WHAT IS RETAINED. The AI working content of a health or person_text task: its
// description, every run's result, every review's copy of that result and the
// reviewer's note, and the unkeyed fingerprints derived from them. The clock
// starts at the database's instant of the task's latest decided review, and
// runs the relied-on authorization's days (at most 30), or 30 where none
// applied. The worker redacts a flow when its clock ends (one internal job per
// flow); nothing here is needed for that.
//
// WHAT THE OWNER CAN DO. List the ledger (never content), erase one task's
// flow now (D7: redaction on erasure), or sweep what is due and not yet
// redacted, bounded. Erasure and the sweep redact in place and delete
// nothing; the content-free audit facts stay. Each act validates before the
// database and calls exactly one function; the database still decides
// everything, including the tenant scope.

import type { TxClient } from "../db/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";

export type ContentRetentionState = "scheduled" | "due" | "redacted";

export interface ContentRetentionRow {
  readonly id: string;
  readonly tenantId: string;
  readonly taskId: string;
  readonly dataClass: string;
  readonly reviewItemId: string | null;
  readonly anchoredAt: string | null;
  readonly retentionDays: number | null;
  readonly dataAuthorizationId: string | null;
  readonly dueAt: string | null;
  readonly redactedAt: string | null;
  readonly redactionReason: string | null;
  readonly redactedBy: string | null;
  readonly state: ContentRetentionState;
}

export interface ContentErasureResult {
  readonly taskId: string;
  readonly status: "redacted" | "already_redacted";
}

export interface ContentSweepResult {
  readonly redacted: number;
  readonly inProgress: number;
}

export const MAX_LISTED_CONTENT_RETENTION = 500;
export const MAX_SWEEP_LIMIT = 1000;
export const DEFAULT_SWEEP_LIMIT = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = /^[a-z0-9][a-z0-9_.:@-]{0,127}$/;
const STATES: readonly ContentRetentionState[] = Object.freeze([
  "scheduled",
  "due",
  "redacted",
]);

const invalid = (message: string): CompanyOsError =>
  new CompanyOsError("invalid_argument", message);

const UTC = (column: string): string =>
  `case when ${column} is null then null else to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end`;

const LIST_SQL = `select r.id, r.tenant_id, r.task_id, r.data_class, r.review_item_id,
         ${UTC("r.anchored_at")} as anchored_at, r.retention_days, r.data_authorization_id,
         ${UTC("r.due_at")} as due_at, ${UTC("r.redacted_at")} as redacted_at,
         r.redaction_reason, r.redacted_by,
         case
           when r.redacted_at is not null then 'redacted'
           when r.due_at <= now() then 'due'
           else 'scheduled'
         end as state
    from ops.content_retention r
   where ($1::uuid is null or r.tenant_id = $1::uuid)
   order by r.redacted_at is not null, r.due_at nulls last, r.id
   limit $2`;

interface ContentRetentionRecord {
  id: string;
  tenant_id: string;
  task_id: string;
  data_class: string;
  review_item_id: string | null;
  anchored_at: string | null;
  retention_days: number | null;
  data_authorization_id: string | null;
  due_at: string | null;
  redacted_at: string | null;
  redaction_reason: string | null;
  redacted_by: string | null;
  state: string;
}

const requireUuid = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new CompanyOsError("malformed_identifier", `${field} is not a uuid`);
  }
  return value;
};

const requireActor = (value: unknown): string => {
  if (typeof value !== "string" || !ACTOR.test(value)) {
    throw invalid("actor is missing or malformed");
  }
  return value;
};

function toRow(record: ContentRetentionRecord): ContentRetentionRow {
  if (!STATES.includes(record.state as ContentRetentionState)) {
    throw new Error(
      "ops.content_retention produced a row with an unknown state",
    );
  }
  return {
    id: record.id,
    tenantId: record.tenant_id,
    taskId: record.task_id,
    dataClass: record.data_class,
    reviewItemId: record.review_item_id,
    anchoredAt: record.anchored_at,
    retentionDays: record.retention_days,
    dataAuthorizationId: record.data_authorization_id,
    dueAt: record.due_at,
    redactedAt: record.redacted_at,
    redactionReason: record.redaction_reason,
    redactedBy: record.redacted_by,
    state: record.state as ContentRetentionState,
  };
}

/**
 * The ledger, at most MAX_LISTED_CONTENT_RETENTION rows, open flows first. Ids,
 * classes, instants and reasons only: the ledger holds no content.
 */
export async function listContentRetention(
  tx: TxClient,
  options: { readonly tenantId?: string } = {},
): Promise<readonly ContentRetentionRow[]> {
  const tenantId =
    options.tenantId === undefined
      ? null
      : requireUuid(options.tenantId, "tenantId");
  try {
    const { rows } = await tx.query<ContentRetentionRecord>(LIST_SQL, [
      tenantId,
      MAX_LISTED_CONTENT_RETENTION,
    ]);
    return rows.map(toRow);
  } catch (error) {
    throw toDomainError(error);
  }
}

/**
 * D7: redacts one health or person_text task's AI working content now, in its
 * tenant only. Refused (invalid_state) while the flow is in progress, and for
 * any other class; not_found for a task outside the tenant.
 */
export async function eraseTaskContent(
  tx: TxClient,
  input: {
    readonly tenantId: string;
    readonly taskId: string;
    readonly actor: string;
  },
): Promise<ContentErasureResult> {
  const tenantId = requireUuid(input.tenantId, "tenantId");
  const taskId = requireUuid(input.taskId, "taskId");
  const actor = requireActor(input.actor);
  let result: { task_id?: unknown; status?: unknown } | undefined;
  try {
    const { rows } = await tx.query<{ result: typeof result }>(
      "select ops.erase_task_content($1, $2, $3) as result",
      [tenantId, taskId, actor],
    );
    result = rows[0]?.result;
  } catch (error) {
    throw toDomainError(error);
  }
  if (result?.status !== "redacted" && result?.status !== "already_redacted") {
    throw new Error("ops.erase_task_content answered outside its contract");
  }
  return { taskId, status: result.status };
}

/**
 * D6: redacts up to `limit` flows whose clock has ended and the worker has not
 * reached, skipping any another transaction holds. A repeat finds nothing.
 */
export async function sweepContentRetention(
  tx: TxClient,
  input: { readonly limit?: number; readonly actor: string },
): Promise<ContentSweepResult> {
  const limit = input.limit ?? DEFAULT_SWEEP_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SWEEP_LIMIT) {
    throw invalid(`limit must be a whole number from 1 to ${MAX_SWEEP_LIMIT}`);
  }
  const actor = requireActor(input.actor);
  let result: { redacted?: unknown; in_progress?: unknown } | undefined;
  try {
    const { rows } = await tx.query<{ result: typeof result }>(
      "select ops.sweep_content_retention($1, $2) as result",
      [limit, actor],
    );
    result = rows[0]?.result;
  } catch (error) {
    throw toDomainError(error);
  }
  if (
    typeof result?.redacted !== "number" ||
    typeof result?.in_progress !== "number"
  ) {
    throw new Error(
      "ops.sweep_content_retention answered outside its contract",
    );
  }
  return { redacted: result.redacted, inProgress: result.in_progress };
}
