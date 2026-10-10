// ADR 0026 §D: the owner's notification target and the notifications it
// produced. The target is the owner's own number, the test channel the
// notification is sent from, the two approved utility templates, the kinds,
// quiet hours and caps. One in force per tenant; recording a new one retires
// the old in the same transaction; retiring it stops every notification (none
// is recorded, and one already recorded is blocked when its job runs).
//
// Each act validates before the database and calls exactly one function; the
// database still decides everything. Nothing here returns, prints or echoes
// the number: the show answers whether one is recorded, and an error message
// never carries a value (SI-86).

import type { TxClient } from "../db/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = /^[A-Za-z0-9._:@-]{1,200}$/;
const DIGITS = /^[1-9][0-9]{7,14}$/;
const TEMPLATE = /^[a-z0-9_]{1,512}$/;
const LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const KINDS: readonly string[] = ["person_requested", "message_waiting"];
const LISTED = 50;
const LISTED_ALL = 500;

const invalid = (message: string): CompanyOsError =>
  new CompanyOsError("invalid_argument", message);

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

const requireMatch = (
  value: unknown,
  pattern: RegExp,
  message: string,
): string => {
  if (typeof value !== "string" || !pattern.test(value)) throw invalid(message);
  return value;
};

const requireCap = (value: unknown, max: number, field: string): number => {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw invalid(`${field} must be an integer from 1 to ${max}`);
  }
  return value;
};

const UTC = (column: string): string =>
  `case when ${column} is null then null else to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end`;

export interface OwnerNotificationTarget {
  readonly id: string;
  readonly channelId: string;
  readonly episodeTemplate: string;
  readonly digestTemplate: string;
  readonly language: string;
  readonly kinds: readonly string[];
  readonly quietStart: string;
  readonly quietEnd: string;
  readonly timeZone: string;
  readonly hourlyCap: number;
  readonly dailyCap: number;
  readonly fallbackName: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  /** Whether a number is recorded: the number itself is never shown. */
  readonly numberRecorded: boolean;
  /** The number is a sender the owner registered on the target's channel. */
  readonly registeredTestSenderOnChannel: boolean;
  /** A CRM contact carries the number (only a registered sender may). */
  readonly crmContactHoldsNumber: boolean;
}

/** The target in force, or null when none is: nothing is notified then. */
export async function showOwnerNotificationTarget(
  tx: TxClient,
  input: { readonly tenantId: string },
): Promise<{ readonly target: OwnerNotificationTarget | null }> {
  const tenantId = requireUuid(input.tenantId, "tenantId");
  try {
    const { rows } = await tx.query<{
      id: string;
      channel_id: string;
      episode_template: string;
      digest_template: string;
      template_language: string;
      kinds: string[];
      quiet_start: string;
      quiet_end: string;
      time_zone: string;
      hourly_cap: number;
      daily_cap: number;
      name_fallback: string;
      recorded_by: string;
      recorded_at: string;
      number_recorded: boolean;
      registered: boolean;
      crm_holds: boolean;
    }>(
      `select t.id, t.channel_id, t.episode_template, t.digest_template, t.template_language, t.kinds,
              to_char(t.quiet_start, 'HH24:MI') as quiet_start, to_char(t.quiet_end, 'HH24:MI') as quiet_end,
              t.time_zone, t.hourly_cap, t.daily_cap, t.name_fallback, t.recorded_by,
              ${UTC("t.recorded_at")} as recorded_at,
              t.digits is not null as number_recorded,
              exists (select 1 from unnest(ops.owner_number_forms(t.digits)) f
                       where ops.registered_test_sender(t.tenant_id, t.channel_id, f)) as registered,
              exists (select 1 from unnest(ops.owner_number_forms(t.digits)) f
                       where ops.crm_contact_by_phone(t.tenant_id, f) ->> 'state' in ('found', 'ambiguous')
                          or (ops.crm_contact_by_phone(t.tenant_id, f) ->> 'state' is distinct from 'unavailable'
                              and ops.crm_phone_suffix_match(f))) as crm_holds
         from ops.owner_notification_targets t
        where t.tenant_id = $1 and t.retired_at is null`,
      [tenantId],
    );
    const row = rows[0];
    if (row === undefined) return { target: null };
    return {
      target: {
        id: row.id,
        channelId: row.channel_id,
        episodeTemplate: row.episode_template,
        digestTemplate: row.digest_template,
        language: row.template_language,
        kinds: row.kinds,
        quietStart: row.quiet_start,
        quietEnd: row.quiet_end,
        timeZone: row.time_zone,
        hourlyCap: row.hourly_cap,
        dailyCap: row.daily_cap,
        fallbackName: row.name_fallback,
        recordedBy: row.recorded_by,
        recordedAt: row.recorded_at,
        numberRecorded: row.number_recorded,
        registeredTestSenderOnChannel: row.registered,
        crmContactHoldsNumber: row.crm_holds,
      },
    };
  } catch (error) {
    throw toDomainError(error);
  }
}

export interface OwnerNotificationTargetInput {
  readonly tenantId: string;
  readonly channelId: string;
  /** The owner's own number, digits with the country code; never echoed. */
  readonly digits: string;
  readonly episodeTemplate: string;
  readonly digestTemplate: string;
  readonly actor: string;
  readonly language?: string;
  readonly kinds?: readonly string[];
  /** HH:MM in the target's time zone. */
  readonly quietStart?: string;
  readonly quietEnd?: string;
  readonly timeZone?: string;
  readonly hourlyCap?: number;
  readonly dailyCap?: number;
  readonly fallbackName?: string;
}

/** Records the target in force, retiring the one before it. */
export async function recordOwnerNotificationTarget(
  tx: TxClient,
  input: OwnerNotificationTargetInput,
): Promise<{
  readonly result: "recorded";
  readonly id: string;
  readonly registeredTestSenderOnChannel: boolean;
}> {
  const tenantId = requireUuid(input.tenantId, "tenantId");
  const channelId = requireUuid(input.channelId, "channelId");
  const digits = requireMatch(
    input.digits,
    DIGITS,
    "the number is 8 to 15 digits with the country code, no plus sign",
  );
  const episode = requireMatch(
    input.episodeTemplate,
    TEMPLATE,
    "the episode template name is malformed",
  );
  const digest = requireMatch(
    input.digestTemplate,
    TEMPLATE,
    "the digest template name is malformed",
  );
  if (episode === digest) throw invalid("the two templates must differ");
  const actor = requireActor(input.actor);
  const language = requireMatch(
    input.language ?? "pt_BR",
    LANGUAGE,
    "the template language is malformed",
  );
  const kinds = input.kinds ?? KINDS;
  if (
    kinds.length < 1 ||
    kinds.length > 2 ||
    new Set(kinds).size !== kinds.length ||
    kinds.some((kind) => !KINDS.includes(kind))
  ) {
    throw invalid(
      "the kinds are person_requested and message_waiting, once each",
    );
  }
  const quietStart = requireMatch(
    input.quietStart ?? "22:00",
    CLOCK,
    "the quiet hours are HH:MM-HH:MM",
  );
  const quietEnd = requireMatch(
    input.quietEnd ?? "08:00",
    CLOCK,
    "the quiet hours are HH:MM-HH:MM",
  );
  if (quietStart === quietEnd)
    throw invalid("the quiet hours start and end at different times");
  const timeZone = requireMatch(
    input.timeZone ?? "America/Sao_Paulo",
    /^[A-Za-z0-9_+/-]{1,64}$/,
    "the time zone is malformed",
  );
  const hourlyCap = requireCap(input.hourlyCap ?? 10, 60, "the hourly cap");
  const dailyCap = requireCap(input.dailyCap ?? 30, 200, "the daily cap");
  if (hourlyCap > dailyCap)
    throw invalid("the hourly cap is not above the daily cap");
  const fallback = requireMatch(
    input.fallbackName ?? "Contato",
    /^(?=.{1,20}$)\p{L}+(?: \p{L}+)*$/u,
    "the fallback word is 1 to 20 letters",
  );
  try {
    const { rows } = await tx.query<{ id: string }>(
      `select ops.record_owner_notification_target(
         $1, $2, $3, $4, $5, $6, $7, $8::text[], $9::time, $10::time, $11, $12, $13, $14) as id`,
      [
        tenantId,
        channelId,
        digits,
        episode,
        digest,
        actor,
        language,
        kinds,
        quietStart,
        quietEnd,
        timeZone,
        hourlyCap,
        dailyCap,
        fallback,
      ],
    );
    const id = rows[0]?.id;
    if (typeof id !== "string" || !UUID.test(id)) {
      throw new Error(
        "ops.record_owner_notification_target answered outside its contract",
      );
    }
    const registered = await tx.query<{ registered: boolean }>(
      `select exists (select 1 from unnest(ops.owner_number_forms(t.digits)) f
                       where ops.registered_test_sender(t.tenant_id, t.channel_id, f)) as registered
         from ops.owner_notification_targets t where t.id = $1`,
      [id],
    );
    return {
      result: "recorded",
      id,
      registeredTestSenderOnChannel: registered.rows[0]?.registered === true,
    };
  } catch (error) {
    throw toDomainError(error);
  }
}

/** Retires the target in force; with none in force, nothing is notified. */
export async function retireOwnerNotificationTarget(
  tx: TxClient,
  input: {
    readonly tenantId: string;
    readonly reason: string;
    readonly actor: string;
  },
): Promise<{ readonly result: "retired" | "none_in_force" }> {
  const tenantId = requireUuid(input.tenantId, "tenantId");
  if (
    typeof input.reason !== "string" ||
    input.reason.length < 1 ||
    input.reason.length > 200
  ) {
    throw invalid("the reason is 1 to 200 characters");
  }
  const actor = requireActor(input.actor);
  try {
    const { rows } = await tx.query<{ retired: boolean }>(
      "select ops.retire_owner_notification_target($1, $2, $3) as retired",
      [tenantId, input.reason, actor],
    );
    return { result: rows[0]?.retired === true ? "retired" : "none_in_force" };
  } catch (error) {
    throw toDomainError(error);
  }
}

export interface OwnerNotificationRow {
  readonly id: string;
  readonly conversationId: string;
  readonly kind: string;
  readonly status: string;
  readonly blockReason: string | null;
  readonly templateKind: string | null;
  readonly carriedBy: string | null;
  readonly recordedAt: string;
  readonly dueAt: string;
  readonly sendingAt: string | null;
  readonly settledAt: string | null;
}

/** The newest notifications, the most recent first: never a number, a name or an order. */
export async function listOwnerNotifications(
  tx: TxClient,
  input: { readonly tenantId: string; readonly all?: boolean },
): Promise<{
  readonly notifications: readonly OwnerNotificationRow[];
  readonly truncated: boolean;
}> {
  const tenantId = requireUuid(input.tenantId, "tenantId");
  const limit = input.all === true ? LISTED_ALL : LISTED;
  try {
    const { rows } = await tx.query<{
      id: string;
      conversation_id: string;
      kind: string;
      status: string;
      block_reason: string | null;
      template_kind: string | null;
      carried_by: string | null;
      recorded_at: string;
      due_at: string;
      sending_at: string | null;
      settled_at: string | null;
    }>(
      `select n.id, n.conversation_id, n.kind, n.status, n.block_reason, n.template_kind, n.carried_by,
              ${UTC("n.recorded_at")} as recorded_at, ${UTC("n.due_at")} as due_at,
              ${UTC("n.sending_at")} as sending_at, ${UTC("n.settled_at")} as settled_at
         from ops.owner_notifications n
        where n.tenant_id = $1
        order by n.recorded_at desc, n.id
        limit $2`,
      [tenantId, limit + 1],
    );
    return {
      notifications: rows.slice(0, limit).map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        kind: row.kind,
        status: row.status,
        blockReason: row.block_reason,
        templateKind: row.template_kind,
        carriedBy: row.carried_by,
        recordedAt: row.recorded_at,
        dueAt: row.due_at,
        sendingAt: row.sending_at,
        settledAt: row.settled_at,
      })),
      truncated: rows.length > limit,
    };
  } catch (error) {
    throw toDomainError(error);
  }
}
