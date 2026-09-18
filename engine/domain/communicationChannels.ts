// Communication channels: the TRUSTED mapping from a provider target to one
// tenant, company and triage agent (Phase 2B).
//
// A WhatsApp webhook names the receiving number by its provider id. That id
// selects a tenant only through a row an owner wrote here: the gateway's
// database functions look it up, and a payload has no other way to name a
// tenant, a company or an agent. One provider target belongs to one channel
// across all tenants; configuring another tenant's target is refused.
//
// MODE. `test` carries synthetic traffic and may create work and send.
// `production` may do neither while BASELINE Q8 is open: the database refuses
// both, whatever this module is asked (ops.guard_inbound_message_q8,
// ops.guard_outbound_message). Choosing `production` here only records intent.

import type { TxClient } from "../db/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";
import { readRows } from "./runtimeReadModelRuns.ts";

export type ChannelMode = "test" | "production";

export const CHANNEL_MODES: readonly ChannelMode[] = Object.freeze([
  "test",
  "production",
]);

export const isChannelMode = (value: unknown): value is ChannelMode =>
  typeof value === "string" &&
  (CHANNEL_MODES as readonly string[]).includes(value);

export interface ConfigureChannelInput {
  readonly tenantId: string;
  readonly companyId: string;
  readonly agentId: string;
  /** The provider's id for the receiving number: digits only. */
  readonly providerTarget: string;
  readonly mode: ChannelMode;
  readonly label: string;
  /** Who configured it. The communication_channels configured_by format. */
  readonly actor: string;
  readonly active?: boolean;
}

export interface ChannelRow {
  readonly id: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly agentId: string;
  readonly provider: string;
  readonly providerTarget: string;
  readonly mode: ChannelMode;
  readonly active: boolean;
  readonly label: string;
  readonly updatedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET = /^[0-9]{1,32}$/;
const LABEL = /^[\x20-\x7e]{1,100}$/;
const ACTOR = /^[a-z0-9][a-z0-9_.:@-]{0,127}$/;

const requireUuid = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new CompanyOsError("malformed_identifier", `${field} is not a uuid`);
  }
  return value;
};

/** Creates the channel, or updates this tenant's own; resolves to its id. */
export async function configureWhatsAppChannel(
  tx: TxClient,
  input: ConfigureChannelInput,
): Promise<string> {
  if (!TARGET.test(input.providerTarget)) {
    throw new CompanyOsError(
      "invalid_argument",
      "a provider target is 1 to 32 digits",
    );
  }
  if (!isChannelMode(input.mode)) {
    throw new CompanyOsError(
      "invalid_argument",
      "a channel mode is test or production",
    );
  }
  if (!LABEL.test(input.label) || input.label.trim() === "") {
    throw new CompanyOsError(
      "invalid_argument",
      "a channel label is 1 to 100 printable characters",
    );
  }
  if (!ACTOR.test(input.actor)) {
    throw new CompanyOsError(
      "invalid_argument",
      "the actor is missing or malformed",
    );
  }
  try {
    const { rows } = await tx.query<{ id: string }>(
      "select ops.configure_whatsapp_channel($1, $2, $3, $4, $5, $6, $7, $8) as id",
      [
        requireUuid(input.tenantId, "tenantId"),
        requireUuid(input.companyId, "companyId"),
        requireUuid(input.agentId, "agentId"),
        input.providerTarget,
        input.mode,
        input.label,
        input.actor,
        input.active ?? true,
      ],
    );
    const id = rows[0]?.id;
    if (typeof id !== "string") {
      throw new Error("ops.configure_whatsapp_channel returned no channel");
    }
    return id;
  } catch (error) {
    throw toDomainError(error);
  }
}

interface ChannelRecord {
  id: string;
  tenant_id: string;
  company_id: string;
  agent_id: string;
  provider: string;
  provider_target: string;
  mode: string;
  active: boolean;
  label: string;
  updated_at: string;
}

const LIST_SQL = `select c.id, c.tenant_id, c.company_id, c.agent_id, c.provider,
       c.provider_target, c.mode, c.active, c.label,
       to_char(c.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
  from ops.communication_channels c
 where ($1::uuid is null or c.tenant_id = $1::uuid)
 order by c.created_at
 limit 200`;

export async function listChannels(
  tx: TxClient,
  options: { readonly tenantId?: string } = {},
): Promise<ChannelRow[]> {
  const tenantId =
    options.tenantId === undefined
      ? null
      : requireUuid(options.tenantId, "tenantId");
  const records = await readRows<ChannelRecord>(tx, LIST_SQL, [tenantId]);
  return records.map((record) => {
    if (!isChannelMode(record.mode)) {
      throw new Error("ops.communication_channels returned an unknown mode");
    }
    return Object.freeze({
      id: record.id,
      tenantId: record.tenant_id,
      companyId: record.company_id,
      agentId: record.agent_id,
      provider: record.provider,
      providerTarget: record.provider_target,
      mode: record.mode,
      active: record.active,
      label: record.label,
      updatedAt: record.updated_at,
    });
  });
}
