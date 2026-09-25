// Phase 3A.1: the follow-up engine's owner services and reads, over the
// functions of supabase/migrations/20260928120000_follow_up_engine.sql.
//
// Everything here runs on the OWNER connection (the scheduling CLI, the
// synthetic demo, the driver-backed tests). No application role can execute
// these functions, and the browser has no counterpart: it only reads the
// Agenda projection.
//
// A due follow-up is operator work, never a permission to contact anyone:
// nothing here sends, calls a model or a provider, or writes the CRM. The
// database derives every due time, enforces the state machine and refuses a
// closed occurrence any change; these wrappers only type the calls.

import type { TxClient } from "../db/types.ts";
import {
  callResult,
  contextParams,
  optionalUuid,
  requireIdempotencyKey,
  requireReasonCode,
  requireUuid,
  statusToken,
  type SchedulingContext,
} from "./schedulingCommon.ts";

export type FollowUpStatus =
  | "scheduled"
  | "due"
  | "completed"
  | "cancelled"
  | "superseded";

export const FOLLOW_UP_STATUSES: readonly FollowUpStatus[] = Object.freeze([
  "scheduled",
  "due",
  "completed",
  "cancelled",
  "superseded",
]);

/**
 * The occurrence state machine, as ops.follow_up_status_transitions() declares
 * it. The database's trigger is the only enforcement point; a driver-backed
 * test asserts the two sets are equal.
 */
export const FOLLOW_UP_STATUS_TRANSITIONS: readonly (readonly [
  FollowUpStatus,
  FollowUpStatus,
])[] = Object.freeze([
  ["scheduled", "due"],
  ["scheduled", "cancelled"],
  ["scheduled", "superseded"],
  ["due", "completed"],
  ["due", "cancelled"],
]);

export const isFollowUpStatus = (value: unknown): value is FollowUpStatus =>
  FOLLOW_UP_STATUSES.includes(value as FollowUpStatus);

export interface DefinePolicyVersionInput {
  readonly policyKey: string;
  readonly label: string;
  /** Minutes after a plan's anchor, strictly increasing, 1 to 12 of them. */
  readonly stepOffsetsMinutes: readonly number[];
}

export interface PolicyVersionResult {
  readonly policyId: string;
  readonly versionId: string;
  readonly version: number;
  /** False when the latest version already had this cadence. */
  readonly created: boolean;
}

/** What a plan follows up. At least one; never a name, number or message. */
export interface FollowUpSubject {
  readonly taskId?: string;
  readonly conversationId?: string;
  /** An opaque reference such as `lead:SYN-0142`. */
  readonly subjectRef?: string;
}

export interface SchedulePlanInput {
  readonly companyId: string;
  readonly departmentId: string;
  readonly agentId?: string;
  readonly policyKey: string;
  /** The instant the offsets count from. */
  readonly anchorAt: Date;
  readonly subject: FollowUpSubject;
  readonly idempotencyKey: string;
}

export interface SchedulePlanResult {
  readonly planId: string;
  /** False when this idempotency key already created the plan. */
  readonly created: boolean;
  readonly supersededPlanId: string | null;
}

export type CompleteFollowUpOutcome = "completed" | "already_completed";
export type CancelFollowUpOutcome = "cancelled" | "already_cancelled";

const OFFSETS_LIMIT = 12;

function requireOffsets(values: readonly number[]): number[] {
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > OFFSETS_LIMIT ||
    values.some((v) => !Number.isSafeInteger(v))
  ) {
    throw new Error(
      "a cadence is 1 to 12 whole-minute offsets; the database checks their order and range",
    );
  }
  return [...values];
}

const asRecord = (value: unknown, fn: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${fn} answered outside its contract`);
  }
  return value as Record<string, unknown>;
};

export async function defineFollowUpPolicyVersion(
  tx: TxClient,
  context: SchedulingContext,
  input: DefinePolicyVersionInput,
): Promise<PolicyVersionResult> {
  const [tenantId, actor] = contextParams(context);
  const result = asRecord(
    await callResult(
      tx,
      "select ops.define_follow_up_policy_version($1, $2, $3, $4::integer[], $5) as result",
      [
        tenantId,
        input.policyKey,
        input.label,
        requireOffsets(input.stepOffsetsMinutes),
        actor,
      ],
    ),
    "ops.define_follow_up_policy_version",
  );
  return {
    policyId: String(result.policy_id),
    versionId: String(result.version_id),
    version: Number(result.version),
    created: result.created === true,
  };
}

export async function scheduleFollowUpPlan(
  tx: TxClient,
  context: SchedulingContext,
  input: SchedulePlanInput,
): Promise<SchedulePlanResult> {
  const [tenantId, actor, source] = contextParams(context);
  if (!(input.anchorAt instanceof Date) || Number.isNaN(+input.anchorAt)) {
    throw new Error("anchorAt is not a valid instant");
  }
  const result = asRecord(
    await callResult(
      tx,
      "select ops.schedule_follow_up_plan($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) as result",
      [
        tenantId,
        requireUuid(input.companyId, "companyId"),
        requireUuid(input.departmentId, "departmentId"),
        optionalUuid(input.agentId, "agentId"),
        input.policyKey,
        input.anchorAt.toISOString(),
        optionalUuid(input.subject.taskId, "taskId"),
        optionalUuid(input.subject.conversationId, "conversationId"),
        input.subject.subjectRef ?? null,
        requireIdempotencyKey(input.idempotencyKey),
        actor,
        source,
      ],
    ),
    "ops.schedule_follow_up_plan",
  );
  return {
    planId: String(result.plan_id),
    created: result.created === true,
    supersededPlanId:
      typeof result.superseded_plan_id === "string"
        ? result.superseded_plan_id
        : null,
  };
}

/** Records that a person did a DUE follow-up. A repeat is harmless. */
export async function completeFollowUp(
  tx: TxClient,
  context: SchedulingContext,
  followUpId: string,
): Promise<CompleteFollowUpOutcome> {
  const [tenantId, actor, source] = contextParams(context);
  return statusToken(
    await callResult(
      tx,
      "select ops.complete_follow_up($1, $2, $3, $4) as result",
      [tenantId, requireUuid(followUpId, "followUpId"), actor, source],
    ),
    ["completed", "already_completed"] as const,
    "ops.complete_follow_up",
  );
}

/** Cancels a scheduled or due follow-up, with a reason code. A repeat is harmless. */
export async function cancelFollowUp(
  tx: TxClient,
  context: SchedulingContext,
  followUpId: string,
  reason: string,
): Promise<CancelFollowUpOutcome> {
  const [tenantId, actor, source] = contextParams(context);
  return statusToken(
    await callResult(
      tx,
      "select ops.cancel_follow_up($1, $2, $3, $4, $5) as result",
      [
        tenantId,
        requireUuid(followUpId, "followUpId"),
        requireReasonCode(reason),
        actor,
        source,
      ],
    ),
    ["cancelled", "already_cancelled"] as const,
    "ops.cancel_follow_up",
  );
}

/** Cancels a plan and every open occurrence of it. A repeat is harmless. */
export async function cancelFollowUpPlan(
  tx: TxClient,
  context: SchedulingContext,
  planId: string,
  reason: string,
): Promise<CancelFollowUpOutcome> {
  const [tenantId, actor, source] = contextParams(context);
  return statusToken(
    await callResult(
      tx,
      "select ops.cancel_follow_up_plan($1, $2, $3, $4, $5) as result",
      [
        tenantId,
        requireUuid(planId, "planId"),
        requireReasonCode(reason),
        actor,
        source,
      ],
    ),
    ["cancelled", "already_cancelled"] as const,
    "ops.cancel_follow_up_plan",
  );
}

/** One occurrence as the operator's list shows it: ids, times and states only. */
export interface FollowUpRow {
  readonly id: string;
  readonly tenantId: string;
  readonly planId: string;
  readonly step: number;
  readonly stepCount: number;
  /** ISO 8601, from the database. */
  readonly dueAt: string;
  readonly status: FollowUpStatus;
  readonly taskId: string | null;
  readonly conversationId: string | null;
  readonly closeReason: string | null;
}

export interface ListFollowUpsOptions {
  readonly tenantId?: string;
  readonly status?: FollowUpStatus;
  readonly limit?: number;
}

export const MAX_LISTED_FOLLOW_UPS = 200;

/**
 * Follow-ups by due time, oldest first. No subject reference, actor label or
 * policy label is read: the list is what a person needs to act on (which one,
 * when, in what state, and the task or conversation it follows up).
 */
export async function listFollowUps(
  tx: TxClient,
  options: ListFollowUpsOptions = {},
): Promise<FollowUpRow[]> {
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? 50), 1),
    MAX_LISTED_FOLLOW_UPS,
  );
  const { rows } = await tx.query<{
    id: string;
    tenant_id: string;
    plan_id: string;
    step_number: number;
    step_count: number;
    due_at: Date;
    status: FollowUpStatus;
    task_id: string | null;
    conversation_id: string | null;
    close_reason: string | null;
  }>(
    `select f.id, f.tenant_id, f.plan_id, f.step_number, f.step_count, f.due_at, f.status,
            p.task_id, p.conversation_id, f.close_reason
       from ops.follow_ups f
       join ops.follow_up_plans p on p.tenant_id = f.tenant_id and p.id = f.plan_id
      where ($1::uuid is null or f.tenant_id = $1::uuid)
        and ($2::text is null or f.status = $2::text)
      order by f.due_at, f.id
      limit $3`,
    [optionalUuid(options.tenantId, "tenantId"), options.status ?? null, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    planId: row.plan_id,
    step: row.step_number,
    stepCount: row.step_count,
    dueAt: new Date(row.due_at).toISOString(),
    status: row.status,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    closeReason: row.close_reason,
  }));
}
