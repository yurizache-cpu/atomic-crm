// ADR 0021 W5 (decided 2026-10-04 by owner delegation): the owner's narrow,
// typed boundary over the WhatsApp sender numbers' retention ledger,
// ops.contact_identifier_retention.
//
// WHAT IS RETAINED. A conversation's phone number, until 12 months after the
// sender's last message. The worker erases it then (one internal job per
// conversation); nothing here is needed for that.
//
// WHAT THE OWNER CAN DO. List the ledger (never a number), erase a person's
// number now on their request (with the AI working content of every
// protected flow it admitted), or sweep what is due and not yet erased,
// bounded. Erasure leaves the conversation's tombstone in place of the number
// and deletes nothing. A number is an INPUT to the erasure act and is never
// returned or printed.

import type { TxClient } from "../db/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";

export type ContactIdentifierState = "scheduled" | "due" | "erased";

export interface ContactIdentifierRow {
  readonly conversationId: string;
  readonly tenantId: string;
  readonly lastMessageAt: string;
  readonly dueAt: string;
  readonly erasedAt: string | null;
  readonly erasureReason: string | null;
  readonly erasedBy: string | null;
  readonly state: ContactIdentifierState;
}

export const MAX_LISTED_CONTACT_IDENTIFIERS = 500;
export const MAX_IDENTIFIER_SWEEP_LIMIT = 1000;
export const DEFAULT_IDENTIFIER_SWEEP_LIMIT = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = /^[a-z0-9][a-z0-9_.:@-]{0,127}$/;
/** A WhatsApp id: the number with its country code, digits only. */
const NUMBER = /^[0-9]{6,20}$/;
const STATES: readonly ContactIdentifierState[] = Object.freeze([
  "scheduled",
  "due",
  "erased",
]);

const invalid = (message: string): CompanyOsError =>
  new CompanyOsError("invalid_argument", message);

const UTC = (column: string): string =>
  `case when ${column} is null then null else to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end`;

const LIST_SQL = `select r.conversation_id, r.tenant_id, ${UTC("r.last_message_at")} as last_message_at,
         ${UTC("r.due_at")} as due_at, ${UTC("r.erased_at")} as erased_at, r.erasure_reason, r.erased_by,
         case
           when r.erased_at is not null then 'erased'
           when r.due_at <= now() then 'due'
           else 'scheduled'
         end as state
    from ops.contact_identifier_retention r
   where ($1::uuid is null or r.tenant_id = $1::uuid)
   order by r.erased_at is not null, r.due_at, r.conversation_id
   limit $2`;

interface ContactIdentifierRecord {
  conversation_id: string;
  tenant_id: string;
  last_message_at: string;
  due_at: string;
  erased_at: string | null;
  erasure_reason: string | null;
  erased_by: string | null;
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

/** The ledger, at most MAX_LISTED_CONTACT_IDENTIFIERS rows, open clocks first. Never a number. */
export async function listContactIdentifierRetention(
  tx: TxClient,
  options: { readonly tenantId?: string } = {},
): Promise<readonly ContactIdentifierRow[]> {
  const tenantId =
    options.tenantId === undefined
      ? null
      : requireUuid(options.tenantId, "tenantId");
  let rows: ContactIdentifierRecord[];
  try {
    ({ rows } = await tx.query<ContactIdentifierRecord>(LIST_SQL, [
      tenantId,
      MAX_LISTED_CONTACT_IDENTIFIERS,
    ]));
  } catch (error) {
    throw toDomainError(error);
  }
  return rows.map((row) => {
    if (!STATES.includes(row.state as ContactIdentifierState)) {
      throw new Error(
        "ops.contact_identifier_retention produced a row with an unknown state",
      );
    }
    return {
      conversationId: row.conversation_id,
      tenantId: row.tenant_id,
      lastMessageAt: row.last_message_at,
      dueAt: row.due_at,
      erasedAt: row.erased_at,
      erasureReason: row.erasure_reason,
      erasedBy: row.erased_by,
      state: row.state as ContactIdentifierState,
    };
  });
}

/**
 * A person's request: erases their number from every conversation of the
 * tenant, with the AI working content of every protected flow it admitted.
 * Refused (invalid_state, nothing erased) while such a flow is in progress.
 * Answers how many conversations lost the number; never the number.
 */
export async function eraseContactByNumber(
  tx: TxClient,
  input: {
    readonly tenantId: string;
    readonly number: string;
    readonly actor: string;
  },
): Promise<{ readonly conversationsErased: number }> {
  const tenantId = requireUuid(input.tenantId, "tenantId");
  if (typeof input.number !== "string" || !NUMBER.test(input.number)) {
    throw invalid("the number must be 6 to 20 digits, with its country code");
  }
  const actor = requireActor(input.actor);
  let count: unknown;
  try {
    const { rows } = await tx.query<{ count: unknown }>(
      "select ops.erase_contact_by_number($1, $2, $3) as count",
      [tenantId, input.number, actor],
    );
    count = rows[0]?.count;
  } catch (error) {
    throw toDomainError(error);
  }
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    throw new Error(
      "ops.erase_contact_by_number answered outside its contract",
    );
  }
  return { conversationsErased: count };
}

/** Erases, bounded, the numbers whose retention ended and the worker has not reached. */
export async function sweepContactIdentifierRetention(
  tx: TxClient,
  input: { readonly limit?: number; readonly actor: string },
): Promise<{ readonly erased: number }> {
  const limit = input.limit ?? DEFAULT_IDENTIFIER_SWEEP_LIMIT;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_IDENTIFIER_SWEEP_LIMIT
  ) {
    throw invalid(
      `limit must be a whole number from 1 to ${MAX_IDENTIFIER_SWEEP_LIMIT}`,
    );
  }
  const actor = requireActor(input.actor);
  let count: unknown;
  try {
    const { rows } = await tx.query<{ count: unknown }>(
      "select ops.sweep_contact_identifier_retention($1, $2) as count",
      [limit, actor],
    );
    count = rows[0]?.count;
  } catch (error) {
    throw toDomainError(error);
  }
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    throw new Error(
      "ops.sweep_contact_identifier_retention answered outside its contract",
    );
  }
  return { erased: count };
}
