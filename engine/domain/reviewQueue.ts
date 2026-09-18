// The human review queue — what an operator sees, and how a decision is
// recorded.
//
// READS are select-only and bounded, in the shape runtimeReadModelRuns.ts
// established: SQL in a module constant, every variable a bound parameter,
// timestamps formatted as UTC text in SQL, and an unrecognised enum value
// throwing rather than being typed through.
//
// THE DECISION is one call to ops.record_review_decision. Everything that makes
// it safe is there: pending leaves once, a terminal item is final, the same
// decision recorded again is a no-op rather than a second fact, and accepting
// is refused when the admission recorded do_not_contact.
//
// WHAT AN OPERATOR IS SHOWN. The advisory result, the identifiers, and the
// consent state. Not the lead's own message: the operator surface of Phase 2A
// is a CLI whose output is a log line, and a person's words do not belong in
// one. The task holds the message for whoever needs to read it in the UI a
// later phase builds.

import type { TxClient } from "../db/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";
import { readRows } from "./runtimeReadModelRuns.ts";

export type ReviewStatus = "pending" | "accepted" | "rejected" | "needs_edit";

export const REVIEW_STATUSES: readonly ReviewStatus[] = Object.freeze([
  "pending",
  "accepted",
  "rejected",
  "needs_edit",
]);

/** The three a person may record. `pending` is where an item starts, not a decision. */
export type ReviewDecision = Exclude<ReviewStatus, "pending">;

export const REVIEW_DECISIONS: readonly ReviewDecision[] = Object.freeze([
  "accepted",
  "rejected",
  "needs_edit",
]);

export const isReviewDecision = (value: unknown): value is ReviewDecision =>
  typeof value === "string" &&
  (REVIEW_DECISIONS as readonly string[]).includes(value);

export const isReviewStatus = (value: unknown): value is ReviewStatus =>
  typeof value === "string" &&
  (REVIEW_STATUSES as readonly string[]).includes(value);

export const MAX_LISTED_REVIEWS = 200;
export const DEFAULT_LISTED_REVIEWS = 50;
export const MAX_REVIEW_NOTE_LENGTH = 1000;

export interface ReviewItemRow {
  readonly id: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly taskId: string;
  readonly agentRunId: string;
  readonly capability: string;
  readonly status: ReviewStatus;
  readonly doNotContact: boolean;
  readonly reviewer: string | null;
  readonly decisionNote: string | null;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
}

/** A listed item plus the advice itself. Only the detail read returns it. */
export interface ReviewItemDetail extends ReviewItemRow {
  readonly proposed: unknown;
}

export interface ListReviewsOptions {
  readonly tenantId?: string;
  readonly status?: ReviewStatus;
  /** 1 to MAX_LISTED_REVIEWS; DEFAULT_LISTED_REVIEWS when absent. */
  readonly limit?: number;
}

export interface RecordDecisionInput {
  readonly reviewId: string;
  readonly decision: ReviewDecision;
  /** Who decided. Recorded verbatim, and it is the audit trail. */
  readonly reviewer: string;
  readonly note?: string;
}

export interface RecordedDecision {
  readonly reviewItemId: string;
  readonly status: ReviewStatus;
  /** False when this call found the same decision already recorded. */
  readonly recorded: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE = /^[a-z][a-z0-9_.:-]{0,127}$/;
/** The reviewer_format CHECK, character for character. */
const REVIEWER = /^[\x21-\x7e][\x20-\x7e]{0,199}$/;

const UTC = (column: string): string =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Every column a listing returns. The advice itself is NOT among them. */
const LIST_COLUMNS = `v.id, v.tenant_id, v.company_id, v.task_id, v.agent_run_id,
       v.capability, v.status, v.do_not_contact, v.reviewer, v.decision_note,
       ${UTC("v.created_at")} as created_at,
       ${UTC("v.reviewed_at")} as reviewed_at`;

const LIST_SQL = `select ${LIST_COLUMNS}
    from ops.review_items v
   where ($1::uuid is null or v.tenant_id = $1::uuid)
     and ($2::text is null or v.status = $2::text)
   order by v.status = 'pending' desc, v.created_at desc
   limit $3`;

const DETAIL_SQL = `select ${LIST_COLUMNS}, v.proposed
    from ops.review_items v
   where v.id = $1::uuid and ($2::uuid is null or v.tenant_id = $2::uuid)`;

interface ReviewRecord {
  readonly id: string;
  readonly tenant_id: string;
  readonly company_id: string;
  readonly task_id: string;
  readonly agent_run_id: string;
  readonly capability: string;
  readonly status: string;
  readonly do_not_contact: boolean;
  readonly reviewer: string | null;
  readonly decision_note: string | null;
  readonly created_at: string;
  readonly reviewed_at: string | null;
  readonly proposed?: unknown;
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new CompanyOsError("malformed_identifier", `${field} is not a uuid`);
  }
  return value;
}

function requireUuid(value: unknown, field: string): string {
  const id = optionalUuid(value, field);
  if (id === null) {
    throw new CompanyOsError("malformed_identifier", `${field} is not a uuid`);
  }
  return id;
}

function boundedLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LISTED_REVIEWS;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_LISTED_REVIEWS
  ) {
    throw new CompanyOsError(
      "invalid_argument",
      `limit must be an integer between 1 and ${MAX_LISTED_REVIEWS}`,
    );
  }
  return value;
}

function optionalStatus(value: unknown): ReviewStatus | null {
  if (value === undefined || value === null) return null;
  if (!isReviewStatus(value)) {
    throw new CompanyOsError(
      "invalid_argument",
      `status must be one of ${REVIEW_STATUSES.join(", ")}`,
    );
  }
  return value;
}

function toReviewRow(record: ReviewRecord): ReviewItemRow {
  if (!isReviewStatus(record.status)) {
    throw new Error("ops.review_items returned an item with an unknown status");
  }
  return Object.freeze({
    id: record.id,
    tenantId: record.tenant_id,
    companyId: record.company_id,
    taskId: record.task_id,
    agentRunId: record.agent_run_id,
    capability: record.capability,
    status: record.status,
    doNotContact: record.do_not_contact,
    reviewer: record.reviewer,
    decisionNote: record.decision_note,
    createdAt: record.created_at,
    reviewedAt: record.reviewed_at,
  });
}

/** Pending items first, newest first within each group. */
export async function listReviewItems(
  tx: TxClient,
  options: ListReviewsOptions = {},
): Promise<readonly ReviewItemRow[]> {
  const rows = await readRows<ReviewRecord>(tx, LIST_SQL, [
    optionalUuid(options.tenantId, "tenantId"),
    optionalStatus(options.status),
    boundedLimit(options.limit),
  ]);
  return Object.freeze(rows.map(toReviewRow));
}

/** One item, with the advice a person is being asked to decide about. */
export async function readReviewItem(
  tx: TxClient,
  reviewId: string,
  options: { readonly tenantId?: string } = {},
): Promise<ReviewItemDetail | undefined> {
  const rows = await readRows<ReviewRecord>(tx, DETAIL_SQL, [
    requireUuid(reviewId, "reviewId"),
    optionalUuid(options.tenantId, "tenantId"),
  ]);
  const record = rows[0];
  if (record === undefined) return undefined;
  return Object.freeze({ ...toReviewRow(record), proposed: record.proposed });
}

/**
 * Records one person's decision. Resolves with `recorded: false` when the same
 * person had already recorded the same decision — a redelivered command, not a
 * second decision. Any other change to a decided item is refused
 * (invalid_state), and accepting an item whose lead must not be contacted is
 * refused (refused).
 *
 * `async`, so invalid input REJECTS the returned promise rather than throwing
 * before one exists.
 */
export async function recordReviewDecision(
  tx: TxClient,
  context: { readonly tenantId: string; readonly source: string },
  input: RecordDecisionInput,
): Promise<RecordedDecision> {
  if (typeof context.source !== "string" || !SOURCE.test(context.source)) {
    throw new CompanyOsError(
      "invalid_argument",
      "source is missing or malformed",
    );
  }
  if (!isReviewDecision(input.decision)) {
    throw new CompanyOsError(
      "invalid_argument",
      `decision must be one of ${REVIEW_DECISIONS.join(", ")}`,
    );
  }
  if (typeof input.reviewer !== "string" || !REVIEWER.test(input.reviewer)) {
    throw new CompanyOsError(
      "invalid_argument",
      "reviewer must name the person deciding, in 1 to 200 printable characters",
    );
  }
  if (
    input.note !== undefined &&
    (typeof input.note !== "string" ||
      input.note.length > MAX_REVIEW_NOTE_LENGTH)
  ) {
    throw new CompanyOsError(
      "invalid_argument",
      `note must be at most ${MAX_REVIEW_NOTE_LENGTH} characters`,
    );
  }

  const params = [
    requireUuid(context.tenantId, "tenantId"),
    requireUuid(input.reviewId, "reviewId"),
    input.decision,
    input.reviewer,
    context.source,
    input.note ?? null,
  ] as const;

  let recorded: unknown;
  try {
    const { rows } = await tx.query<{ result: unknown }>(
      "select ops.record_review_decision($1, $2, $3, $4, $5, $6) as result",
      params,
    );
    recorded = rows[0]?.result;
  } catch (error) {
    throw toDomainError(error);
  }

  const record = recorded as Record<string, unknown> | undefined;
  const reviewItemId = record?.review_item_id;
  const status = record?.status;
  if (typeof reviewItemId !== "string" || !isReviewStatus(status)) {
    throw new Error("ops.record_review_decision returned no decision");
  }
  return Object.freeze({
    reviewItemId,
    status,
    recorded: record?.recorded === true,
  });
}
