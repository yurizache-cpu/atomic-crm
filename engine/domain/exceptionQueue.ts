// ADR 0025 Part A: the owner's narrow, typed boundary over the exception queue.
//
// The database raises and reconciles every exception where the facts are
// decided (the screening, a send's state, a release); nothing here raises one.
// The owner lists them (kinds, priorities, ids and instants, never a text, a
// number or a CRM id), resolves or dismisses one, and syncs a tenant's send
// exceptions after a send act could not record them. The send act syncs its
// own send through syncSendExceptions, in a transaction of its own after the
// one that called the provider.
//
// Each act validates before the database and calls exactly one function; the
// database still decides everything.

import type { TxClient } from "../db/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = /^[A-Za-z0-9._:@-]{1,200}$/;
export const MAX_LISTED_EXCEPTIONS = 200;

/** The resolutions a person records; released and reconciled are the database's. */
export const PERSON_RESOLUTIONS = ["resolved", "dismissed"] as const;
export type PersonResolution = (typeof PERSON_RESOLUTIONS)[number];

const requireUuid = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new CompanyOsError("malformed_identifier", `${field} is not a uuid`);
  }
  return value;
};

const requireActor = (value: unknown): string => {
  if (typeof value !== "string" || !ACTOR.test(value)) {
    throw new CompanyOsError(
      "invalid_argument",
      "actor is missing or malformed",
    );
  }
  return value;
};

const UTC = (column: string): string =>
  `case when ${column} is null then null else to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end`;

async function one<T>(
  tx: TxClient,
  sql: string,
  params: unknown[],
): Promise<T | undefined> {
  try {
    const { rows } = await tx.query<{ answer: T }>(sql, params);
    return rows[0]?.answer;
  } catch (error) {
    throw toDomainError(error);
  }
}

export interface ExceptionRow {
  readonly id: string;
  readonly kind: string;
  readonly priority: "urgent" | "high" | "normal";
  readonly subjectKind: "conversation" | "outbound_message";
  readonly conversationId: string;
  readonly outboundMessageId: string | null;
  readonly taskId: string;
  readonly detail: string | null;
  readonly raisedAt: string;
  readonly raisedBy: string;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  readonly resolution: string | null;
}

/**
 * The tenant's open exceptions (or, with `all`, every one), most urgent first,
 * then oldest first. Ids, kinds and instants only.
 */
export async function listExceptions(
  tx: TxClient,
  input: { readonly tenantId: string; readonly all?: boolean },
): Promise<readonly ExceptionRow[]> {
  const tenantId = requireUuid(input.tenantId, "tenantId");
  try {
    const { rows } = await tx.query<{
      id: string;
      kind: string;
      priority: ExceptionRow["priority"];
      subject_kind: ExceptionRow["subjectKind"];
      conversation_id: string;
      outbound_message_id: string | null;
      task_id: string;
      detail: string | null;
      raised_at: string;
      raised_by: string;
      resolved_at: string | null;
      resolved_by: string | null;
      resolution: string | null;
    }>(
      `select e.id, e.kind, e.priority, e.subject_kind, e.conversation_id, e.outbound_message_id, e.task_id,
              e.detail, ${UTC("e.raised_at")} as raised_at, e.raised_by, ${UTC("e.resolved_at")} as resolved_at,
              e.resolved_by, e.resolution
         from ops.exceptions e
        where e.tenant_id = $1 and ($2 or e.resolved_at is null)
        order by e.resolved_at is not null,
                 case e.priority when 'urgent' then 0 when 'high' then 1 else 2 end,
                 e.raised_at, e.id
        limit $3`,
      [tenantId, input.all === true, MAX_LISTED_EXCEPTIONS],
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      priority: row.priority,
      subjectKind: row.subject_kind,
      conversationId: row.conversation_id,
      outboundMessageId: row.outbound_message_id,
      taskId: row.task_id,
      detail: row.detail,
      raisedAt: row.raised_at,
      raisedBy: row.raised_by,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
      resolution: row.resolution,
    }));
  } catch (error) {
    throw toDomainError(error);
  }
}

/** A person resolves or dismisses one exception; a repeat answers `already_resolved`. */
export async function resolveException(
  tx: TxClient,
  input: {
    readonly tenantId: string;
    readonly exceptionId: string;
    readonly resolution: string;
    readonly actor: string;
  },
): Promise<Record<string, unknown>> {
  if (!(PERSON_RESOLUTIONS as readonly string[]).includes(input.resolution)) {
    throw new CompanyOsError(
      "invalid_argument",
      `resolution must be one of ${PERSON_RESOLUTIONS.join(", ")}`,
    );
  }
  const answer = await one<Record<string, unknown>>(
    tx,
    "select ops.resolve_exception($1, $2, $3, $4) as answer",
    [
      requireUuid(input.tenantId, "tenantId"),
      requireUuid(input.exceptionId, "exceptionId"),
      input.resolution,
      requireActor(input.actor),
    ],
  );
  if (!answer || typeof answer !== "object")
    throw new Error("ops.resolve_exception answered outside its contract");
  return answer;
}

export interface SyncCounts {
  readonly opened: number;
  readonly closed: number;
}

const counts = (answer: unknown, fn: string): SyncCounts => {
  const value = answer as { opened?: unknown; closed?: unknown } | undefined;
  if (
    !value ||
    !Number.isInteger(value.opened) ||
    !Number.isInteger(value.closed)
  ) {
    throw new Error(`${fn} answered outside its contract`);
  }
  return { opened: value.opened as number, closed: value.closed as number };
};

/** One send's exceptions, derived from its state. */
export async function syncSendExceptions(
  tx: TxClient,
  tenantId: string,
  outboundMessageId: string,
): Promise<SyncCounts> {
  return counts(
    await one(
      tx,
      "select ops.sync_send_exceptions($1, $2, 'operator-cli') as answer",
      [
        requireUuid(tenantId, "tenantId"),
        requireUuid(outboundMessageId, "outboundMessageId"),
      ],
    ),
    "ops.sync_send_exceptions",
  );
}

/** Every send of the tenant, once: the recovery after a send act could not sync. */
export async function syncTenantSendExceptions(
  tx: TxClient,
  input: { readonly tenantId: string },
): Promise<SyncCounts & { readonly sends: number }> {
  const answer = await one<{ sends?: unknown }>(
    tx,
    "select ops.sync_tenant_send_exceptions($1) as answer",
    [requireUuid(input.tenantId, "tenantId")],
  );
  const synced = counts(answer, "ops.sync_tenant_send_exceptions");
  if (!Number.isInteger(answer?.sends))
    throw new Error(
      "ops.sync_tenant_send_exceptions answered outside its contract",
    );
  return { sends: answer?.sends as number, ...synced };
}
