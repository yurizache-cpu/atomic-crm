// Outbound messages: the database half of a human-approved send (Phase 2B).
//
// A send is never a side effect of anything. It exists only because a person
// explicitly asked to send an ACCEPTED review (`requestOutboundSend`), and it
// leaves the process only after the database said, in the transaction that
// records it as in flight, that it may (`beginOutboundSend`). Each call below is
// one owner service; what makes it safe lives there:
//
//   * request: accepted reviews only, idempotent per review, refused (and
//     nothing recorded) unless the FRESH eligibility check passes;
//   * begin: re-checks eligibility immediately before the call, records
//     `blocked` or `sending`, and only then answers the text and the recipient;
//   * settle: records what the one call produced, and only for a send still
//     `sending`, so a status callback that already resolved it is never undone;
//   * mark indeterminate: a person's record that a send interrupted mid-call is
//     of unknown outcome. Nothing is ever sent again by the system.
//
// READS never return the text that was sent: it is the review's own draft and
// stays there.

import type { TxClient } from "../db/types.ts";
import type {
  OutboundOutcome,
  OutboundRequest,
} from "../communication/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";
import { readRows } from "./runtimeReadModelRuns.ts";

export type OutboundStatus =
  | "authorized"
  | "blocked"
  | "sending"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "indeterminate";

export const OUTBOUND_STATUSES: readonly OutboundStatus[] = Object.freeze([
  "authorized",
  "blocked",
  "sending",
  "sent",
  "delivered",
  "read",
  "failed",
  "indeterminate",
]);

export const isOutboundStatus = (value: unknown): value is OutboundStatus =>
  typeof value === "string" &&
  (OUTBOUND_STATUSES as readonly string[]).includes(value);

export interface RequestSendInput {
  readonly tenantId: string;
  readonly reviewId: string;
  /** Who asked. Recorded verbatim; it is the audit trail. */
  readonly requestedBy: string;
  readonly source: string;
}

export interface RequestedSend {
  readonly outboundMessageId: string;
  readonly status: OutboundStatus;
  /** False when an earlier request already created this send. */
  readonly created: boolean;
}

/** What begin answered: permission for exactly one call, or why not. */
export type BegunSend =
  | { readonly state: "send"; readonly request: OutboundRequest }
  | { readonly state: "blocked"; readonly reason: string }
  | { readonly state: Exclude<OutboundStatus, "authorized" | "blocked"> };

export interface OutboundRow {
  readonly id: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly channelId: string;
  readonly conversationId: string;
  readonly reviewItemId: string;
  readonly taskId: string;
  readonly status: OutboundStatus;
  readonly requestedBy: string;
  readonly blockedReason: string | null;
  readonly providerMessageId: string | null;
  readonly errorCode: string | null;
  readonly errorClass: string | null;
  readonly authorizedAt: string;
  readonly sendingAt: string | null;
  readonly settledAt: string | null;
  readonly deliveredAt: string | null;
  readonly readAt: string | null;
}

export const MAX_LISTED_OUTBOUND = 200;
export const DEFAULT_LISTED_OUTBOUND = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE = /^[a-z][a-z0-9_.:-]{0,127}$/;
/** The requested_by CHECK, character for character. */
const OPERATOR = /^[\x21-\x7e][\x20-\x7e]{0,199}$/;

const requireUuid = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new CompanyOsError("malformed_identifier", `${field} is not a uuid`);
  }
  return value;
};

const callJson = async (
  tx: TxClient,
  sql: string,
  params: readonly unknown[],
  fn: string,
): Promise<Record<string, unknown>> => {
  let result: unknown;
  try {
    result = (await tx.query<{ result: unknown }>(sql, params)).rows[0]?.result;
  } catch (error) {
    throw toDomainError(error);
  }
  if (typeof result !== "object" || result === null) {
    throw new Error(`${fn} returned no answer`);
  }
  return result as Record<string, unknown>;
};

const statusOf = (value: unknown, fn: string): OutboundStatus => {
  if (!isOutboundStatus(value)) {
    throw new Error(`${fn} answered a status this module does not know`);
  }
  return value;
};

/** Asks for the send of an accepted review. Calls no provider. */
export async function requestOutboundSend(
  tx: TxClient,
  input: RequestSendInput,
): Promise<RequestedSend> {
  if (
    typeof input.requestedBy !== "string" ||
    !OPERATOR.test(input.requestedBy)
  ) {
    throw new CompanyOsError(
      "invalid_argument",
      "the operator label is missing or malformed",
    );
  }
  if (typeof input.source !== "string" || !SOURCE.test(input.source)) {
    throw new CompanyOsError(
      "invalid_argument",
      "source is missing or malformed",
    );
  }
  const answer = await callJson(
    tx,
    "select ops.request_outbound_send($1, $2, $3, $4) as result",
    [
      requireUuid(input.tenantId, "tenantId"),
      requireUuid(input.reviewId, "reviewId"),
      input.requestedBy,
      input.source,
    ],
    "ops.request_outbound_send",
  );
  const id = answer.outbound_message_id;
  if (typeof id !== "string") {
    throw new Error("ops.request_outbound_send returned no send");
  }
  return Object.freeze({
    outboundMessageId: id,
    status: statusOf(answer.status, "ops.request_outbound_send"),
    created: answer.created === true,
  });
}

/** The last gate: the one call may happen only when this answers `send`. */
export async function beginOutboundSend(
  tx: TxClient,
  tenantId: string,
  outboundMessageId: string,
): Promise<BegunSend> {
  const answer = await callJson(
    tx,
    "select ops.begin_outbound_send($1, $2) as result",
    [
      requireUuid(tenantId, "tenantId"),
      requireUuid(outboundMessageId, "outboundMessageId"),
    ],
    "ops.begin_outbound_send",
  );
  if (answer.state === "send") {
    const { provider_target, to, body, outbound_message_id } = answer;
    if (
      typeof provider_target !== "string" ||
      typeof to !== "string" ||
      typeof body !== "string" ||
      typeof outbound_message_id !== "string"
    ) {
      throw new Error(
        "ops.begin_outbound_send answered send without a request",
      );
    }
    return Object.freeze({
      state: "send",
      request: Object.freeze({
        providerTarget: provider_target,
        to,
        body,
        correlation: outbound_message_id,
      }),
    });
  }
  if (answer.state === "blocked") {
    return Object.freeze({
      state: "blocked",
      reason: typeof answer.reason === "string" ? answer.reason : "unknown",
    });
  }
  const state = statusOf(answer.state, "ops.begin_outbound_send");
  if (state === "authorized" || state === "blocked") {
    throw new Error("ops.begin_outbound_send answered an impossible state");
  }
  return Object.freeze({ state });
}

/** Records what the one call produced. False when the send had already moved on. */
export async function settleOutboundSend(
  tx: TxClient,
  tenantId: string,
  outboundMessageId: string,
  outcome: OutboundOutcome,
): Promise<{ readonly status: OutboundStatus; readonly settled: boolean }> {
  const params =
    outcome.kind === "accepted"
      ? ["sent", outcome.providerMessageId, null, null]
      : outcome.kind === "rejected"
        ? ["failed", null, outcome.errorCode, outcome.errorClass]
        : ["indeterminate", null, null, outcome.errorClass];
  const answer = await callJson(
    tx,
    "select ops.settle_outbound_send($1, $2, $3, $4, $5, $6) as result",
    [
      requireUuid(tenantId, "tenantId"),
      requireUuid(outboundMessageId, "outboundMessageId"),
      ...params,
    ],
    "ops.settle_outbound_send",
  );
  return Object.freeze({
    status: statusOf(answer.state, "ops.settle_outbound_send"),
    settled: answer.settled === true,
  });
}

/** A person's record that an interrupted send's outcome is unknown. Sends nothing. */
export async function markOutboundIndeterminate(
  tx: TxClient,
  tenantId: string,
  outboundMessageId: string,
  actor: string,
): Promise<void> {
  if (typeof actor !== "string" || !OPERATOR.test(actor)) {
    throw new CompanyOsError(
      "invalid_argument",
      "the operator label is missing or malformed",
    );
  }
  await callJson(
    tx,
    "select ops.mark_outbound_indeterminate($1, $2, $3) as result",
    [
      requireUuid(tenantId, "tenantId"),
      requireUuid(outboundMessageId, "outboundMessageId"),
      actor,
    ],
    "ops.mark_outbound_indeterminate",
  );
}

/** Whether a reply could be sent on the send's conversation right now, and why not. */
export async function readSendEligibility(
  tx: TxClient,
  tenantId: string,
  conversationId: string,
): Promise<{ readonly eligible: boolean; readonly reason: string | null }> {
  const answer = await callJson(
    tx,
    "select ops.whatsapp_send_eligibility($1, $2) as result",
    [
      requireUuid(tenantId, "tenantId"),
      requireUuid(conversationId, "conversationId"),
    ],
    "ops.whatsapp_send_eligibility",
  );
  return Object.freeze({
    eligible: answer.eligible === true,
    reason: typeof answer.reason === "string" ? answer.reason : null,
  });
}

interface OutboundRecord {
  id: string;
  tenant_id: string;
  company_id: string;
  channel_id: string;
  conversation_id: string;
  review_item_id: string;
  task_id: string;
  status: string;
  requested_by: string;
  blocked_reason: string | null;
  provider_message_id: string | null;
  error_code: string | null;
  error_class: string | null;
  authorized_at: string;
  sending_at: string | null;
  settled_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
}

const UTC = (column: string): string =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Ids, states and times. Never the text, never the recipient. */
const COLUMNS = `o.id, o.tenant_id, o.company_id, o.channel_id, o.conversation_id,
       o.review_item_id, o.task_id, o.status, o.requested_by, o.blocked_reason,
       o.provider_message_id, o.error_code, o.error_class,
       ${UTC("o.authorized_at")} as authorized_at, ${UTC("o.sending_at")} as sending_at,
       ${UTC("o.settled_at")} as settled_at, ${UTC("o.delivered_at")} as delivered_at,
       ${UTC("o.read_at")} as read_at`;

const LIST_SQL = `select ${COLUMNS}
    from ops.outbound_messages o
   where ($1::uuid is null or o.tenant_id = $1::uuid)
     and ($2::text is null or o.status = $2::text)
   order by o.updated_at desc
   limit $3`;

const DETAIL_SQL = `select ${COLUMNS}
    from ops.outbound_messages o
   where o.id = $1 and ($2::uuid is null or o.tenant_id = $2::uuid)`;

const toRow = (record: OutboundRecord): OutboundRow =>
  Object.freeze({
    id: record.id,
    tenantId: record.tenant_id,
    companyId: record.company_id,
    channelId: record.channel_id,
    conversationId: record.conversation_id,
    reviewItemId: record.review_item_id,
    taskId: record.task_id,
    status: statusOf(record.status, "ops.outbound_messages"),
    requestedBy: record.requested_by,
    blockedReason: record.blocked_reason,
    providerMessageId: record.provider_message_id,
    errorCode: record.error_code,
    errorClass: record.error_class,
    authorizedAt: record.authorized_at,
    sendingAt: record.sending_at,
    settledAt: record.settled_at,
    deliveredAt: record.delivered_at,
    readAt: record.read_at,
  });

export async function listOutbound(
  tx: TxClient,
  options: {
    readonly tenantId?: string;
    readonly status?: OutboundStatus;
    readonly limit?: number;
  } = {},
): Promise<OutboundRow[]> {
  const limit = options.limit ?? DEFAULT_LISTED_OUTBOUND;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LISTED_OUTBOUND) {
    throw new CompanyOsError(
      "invalid_argument",
      `limit is 1 to ${MAX_LISTED_OUTBOUND}`,
    );
  }
  if (options.status !== undefined && !isOutboundStatus(options.status)) {
    throw new CompanyOsError("invalid_argument", "unknown outbound status");
  }
  const records = await readRows<OutboundRecord>(tx, LIST_SQL, [
    options.tenantId === undefined
      ? null
      : requireUuid(options.tenantId, "tenantId"),
    options.status ?? null,
    limit,
  ]);
  return records.map(toRow);
}

export async function readOutbound(
  tx: TxClient,
  outboundMessageId: string,
  options: { readonly tenantId?: string } = {},
): Promise<OutboundRow | null> {
  const records = await readRows<OutboundRecord>(tx, DETAIL_SQL, [
    requireUuid(outboundMessageId, "outboundMessageId"),
    options.tenantId === undefined
      ? null
      : requireUuid(options.tenantId, "tenantId"),
  ]);
  return records[0] ? toRow(records[0]) : null;
}
