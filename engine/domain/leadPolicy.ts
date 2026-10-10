// ADR 0026 §C: the owner's lead policy, the one knob of the gateway's lead
// creation. A WhatsApp number the CRM does not know becomes a lead only while
// a policy is in force: at most its daily cap a day (the day in its time
// zone), named with its placeholder unless the sender's profile gave a benign
// first name. One in force per tenant; recording a new one retires the old in
// the same transaction; retiring it stops creation.
//
// Each act validates before the database and calls exactly one function; the
// database still decides everything (the time zone exists, the bounds, one in
// force). No command prints a number or a name but the owner's placeholder.

import type { TxClient } from "../db/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = /^[A-Za-z0-9._:@-]{1,200}$/;

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

const requireText = (value: unknown, field: string, max: number): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new CompanyOsError(
      "invalid_argument",
      `${field} is missing or too long`,
    );
  }
  return value;
};

const UTC = (column: string): string =>
  `case when ${column} is null then null else to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end`;

export interface LeadPolicy {
  readonly id: string;
  readonly dailyCap: number;
  readonly timeZone: string;
  readonly namePlaceholder: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  /** Leads created today, the day in the policy's time zone. */
  readonly createdToday: number;
}

/** The policy in force, or null when none is: nothing is created then. */
export async function showLeadPolicy(
  tx: TxClient,
  input: { readonly tenantId: string },
): Promise<{ readonly policy: LeadPolicy | null }> {
  const tenantId = requireUuid(input.tenantId, "tenantId");
  try {
    const { rows } = await tx.query<{
      id: string;
      daily_cap: number;
      time_zone: string;
      name_placeholder: string;
      recorded_by: string;
      recorded_at: string;
      created_today: string;
    }>(
      `select p.id, p.daily_cap, p.time_zone, p.name_placeholder, p.recorded_by,
              ${UTC("p.recorded_at")} as recorded_at,
              (select count(*) from ops.crm_contact_acts a
                where a.tenant_id = p.tenant_id and a.act = 'created'
                  and (a.recorded_at at time zone p.time_zone)::date = (now() at time zone p.time_zone)::date
              )::text as created_today
         from ops.crm_lead_policies p
        where p.tenant_id = $1 and p.retired_at is null`,
      [tenantId],
    );
    const row = rows[0];
    if (row === undefined) return { policy: null };
    return {
      policy: {
        id: row.id,
        dailyCap: row.daily_cap,
        timeZone: row.time_zone,
        namePlaceholder: row.name_placeholder,
        recordedBy: row.recorded_by,
        recordedAt: row.recorded_at,
        createdToday: Number(row.created_today),
      },
    };
  } catch (error) {
    throw toDomainError(error);
  }
}

/** Records a policy in force, retiring the one before it. */
export async function recordLeadPolicy(
  tx: TxClient,
  input: {
    readonly tenantId: string;
    readonly dailyCap: number;
    readonly timeZone: string;
    readonly namePlaceholder: string;
    readonly actor: string;
  },
): Promise<{ readonly result: "recorded"; readonly id: string }> {
  const tenantId = requireUuid(input.tenantId, "tenantId");
  if (
    !Number.isInteger(input.dailyCap) ||
    input.dailyCap < 1 ||
    input.dailyCap > 1000
  ) {
    throw new CompanyOsError(
      "invalid_argument",
      "the daily cap must be an integer from 1 to 1000",
    );
  }
  const timeZone = requireText(input.timeZone, "timeZone", 64);
  const placeholder = requireText(input.namePlaceholder, "namePlaceholder", 40);
  const actor = requireActor(input.actor);
  try {
    const { rows } = await tx.query<{ id: string }>(
      "select ops.record_crm_lead_policy($1, $2, $3, $4, $5) as id",
      [tenantId, input.dailyCap, timeZone, placeholder, actor],
    );
    const id = rows[0]?.id;
    if (typeof id !== "string" || !UUID.test(id)) {
      throw new Error(
        "ops.record_crm_lead_policy answered outside its contract",
      );
    }
    return { result: "recorded", id };
  } catch (error) {
    throw toDomainError(error);
  }
}

/** Retires the policy in force; with none in force, nothing is created. */
export async function retireLeadPolicy(
  tx: TxClient,
  input: {
    readonly tenantId: string;
    readonly reason: string;
    readonly actor: string;
  },
): Promise<{ readonly result: "retired" | "none_in_force" }> {
  const tenantId = requireUuid(input.tenantId, "tenantId");
  const reason = requireText(input.reason, "reason", 200);
  const actor = requireActor(input.actor);
  try {
    const { rows } = await tx.query<{ retired: boolean }>(
      "select ops.retire_crm_lead_policy($1, $2, $3) as retired",
      [tenantId, reason, actor],
    );
    return { result: rows[0]?.retired === true ? "retired" : "none_in_force" };
  } catch (error) {
    throw toDomainError(error);
  }
}
