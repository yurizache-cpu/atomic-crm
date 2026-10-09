// ADR 0023: the owner's narrow, typed boundary over the front-desk agent.
//
// Configuration: draft a version of one kind (operating policy, playbook,
// knowledge, fixed messages), publish it, list and show versions. The agent
// reads only the published version; a version is never edited, a new one is
// drafted. Conversations: list their state (never a number, never a text),
// take one over, release it, and record a person's reply. Screenings: counts
// by class and disposition, never a text.
//
// Each act validates before the database and calls exactly one function; the
// database still decides everything.

import type { TxClient } from "../db/types.ts";
import {
  CONFIGURATION_KINDS,
  validateConfiguration,
  type ConfigurationKind,
} from "../frontDesk/configuration.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = /^[A-Za-z0-9._:@-]{1,200}$/;
// Control characters other than a line break.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x01-\x09\x0b-\x1f\x7f]/;
export const MAX_REPLY_LENGTH = 2000;
export const MAX_LISTED = 200;
/** The largest conversation revision a person's reply may name. */
export const MAX_REVISION = 999_999_999;

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

const requireKind = (value: unknown): ConfigurationKind => {
  if (
    typeof value !== "string" ||
    !(CONFIGURATION_KINDS as readonly string[]).includes(value)
  ) {
    throw invalid(`kind must be one of ${CONFIGURATION_KINDS.join(", ")}`);
  }
  return value as ConfigurationKind;
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

// ---------------------------------------------------------------------------
// Configuration.
// ---------------------------------------------------------------------------

export interface ConfigurationVersionRow {
  readonly id: string;
  readonly agentId: string;
  readonly kind: ConfigurationKind;
  readonly version: number;
  readonly status: "draft" | "published" | "superseded";
  readonly contentSha256: string;
  readonly draftedBy: string;
  readonly draftedAt: string;
  readonly publishedBy: string | null;
  readonly publishedAt: string | null;
  readonly supersededAt: string | null;
}

const VERSION_COLUMNS = `v.id, v.agent_id, v.kind, v.version, v.status, v.content_sha256, v.drafted_by,
       ${UTC("v.drafted_at")} as drafted_at, v.published_by, ${UTC("v.published_at")} as published_at,
       ${UTC("v.superseded_at")} as superseded_at`;

interface VersionRecord {
  id: string;
  agent_id: string;
  kind: ConfigurationKind;
  version: number;
  status: "draft" | "published" | "superseded";
  content_sha256: string;
  drafted_by: string;
  drafted_at: string;
  published_by: string | null;
  published_at: string | null;
  superseded_at: string | null;
  content?: unknown;
}

const toVersionRow = (row: VersionRecord): ConfigurationVersionRow => ({
  id: row.id,
  agentId: row.agent_id,
  kind: row.kind,
  version: row.version,
  status: row.status,
  contentSha256: row.content_sha256,
  draftedBy: row.drafted_by,
  draftedAt: row.drafted_at,
  publishedBy: row.published_by,
  publishedAt: row.published_at,
  supersededAt: row.superseded_at,
});

/** Drafts a new version of one kind, after checking its full authoring shape. */
export async function draftAgentConfiguration(
  tx: TxClient,
  input: {
    readonly tenantId: string;
    readonly agentId: string;
    readonly kind: string;
    readonly content: unknown;
    readonly actor: string;
  },
): Promise<{ readonly id: string }> {
  const tenantId = requireUuid(input.tenantId, "tenantId");
  const agentId = requireUuid(input.agentId, "agentId");
  const kind = requireKind(input.kind);
  const actor = requireActor(input.actor);
  const checked = validateConfiguration(kind, input.content);
  if (!checked.ok) {
    throw invalid(
      `the ${kind} content is invalid: ${checked.problems.slice(0, 10).join("; ")}`,
    );
  }
  const id = await one<unknown>(
    tx,
    "select ops.draft_agent_configuration($1, $2, $3, $4::jsonb, $5) as answer",
    [tenantId, agentId, kind, JSON.stringify(checked.content), actor],
  );
  if (typeof id !== "string" || !UUID.test(id)) {
    throw new Error(
      "ops.draft_agent_configuration answered outside its contract",
    );
  }
  return { id };
}

/** Publishes a draft, superseding the published version of its kind. */
export async function publishAgentConfiguration(
  tx: TxClient,
  input: {
    readonly tenantId: string;
    readonly versionId: string;
    readonly actor: string;
  },
): Promise<Record<string, unknown>> {
  const answer = await one<Record<string, unknown>>(
    tx,
    "select ops.publish_agent_configuration($1, $2, $3) as answer",
    [
      requireUuid(input.tenantId, "tenantId"),
      requireUuid(input.versionId, "versionId"),
      requireActor(input.actor),
    ],
  );
  if (!answer || typeof answer !== "object") {
    throw new Error(
      "ops.publish_agent_configuration answered outside its contract",
    );
  }
  return answer;
}

/** The tenant's versions, newest first, without their content. */
export async function listAgentConfigurations(
  tx: TxClient,
  input: { readonly tenantId: string; readonly agentId?: string },
): Promise<readonly ConfigurationVersionRow[]> {
  const tenantId = requireUuid(input.tenantId, "tenantId");
  const agentId =
    input.agentId === undefined ? null : requireUuid(input.agentId, "agentId");
  try {
    const { rows } = await tx.query<VersionRecord>(
      `select ${VERSION_COLUMNS}
         from ops.agent_configuration_versions v
        where v.tenant_id = $1 and ($2::uuid is null or v.agent_id = $2)
        order by v.agent_id, v.kind, v.version desc
        limit $3`,
      [tenantId, agentId, MAX_LISTED],
    );
    return rows.map(toVersionRow);
  } catch (error) {
    throw toDomainError(error);
  }
}

/** One version with its content. */
export async function showAgentConfiguration(
  tx: TxClient,
  input: { readonly tenantId: string; readonly versionId: string },
): Promise<ConfigurationVersionRow & { readonly content: unknown }> {
  const tenantId = requireUuid(input.tenantId, "tenantId");
  const versionId = requireUuid(input.versionId, "versionId");
  try {
    const { rows } = await tx.query<VersionRecord>(
      `select ${VERSION_COLUMNS}, v.content
         from ops.agent_configuration_versions v
        where v.tenant_id = $1 and v.id = $2`,
      [tenantId, versionId],
    );
    if (!rows[0])
      throw new CompanyOsError(
        "not_found",
        "no such configuration version in this tenant",
      );
    return { ...toVersionRow(rows[0]), content: rows[0].content };
  } catch (error) {
    throw toDomainError(error);
  }
}

// ---------------------------------------------------------------------------
// Conversations.
// ---------------------------------------------------------------------------

export interface ConversationStateRow {
  readonly conversationId: string;
  readonly partyKind: "prospect" | "client" | "unknown";
  readonly phase: "new" | "engaged" | "closed";
  readonly holder: "agent" | "person";
  readonly holderReason: string | null;
  readonly holderChangedAt: string | null;
  readonly updatedAt: string;
  /** How many messages the contact sent, admitted or refused: a person's reply names it. */
  readonly revision: number;
}

/** The tenant's conversation states, most recently changed first. No number, no text. */
export async function listConversationStates(
  tx: TxClient,
  input: { readonly tenantId: string },
): Promise<readonly ConversationStateRow[]> {
  const tenantId = requireUuid(input.tenantId, "tenantId");
  try {
    const { rows } = await tx.query<{
      conversation_id: string;
      party_kind: ConversationStateRow["partyKind"];
      phase: ConversationStateRow["phase"];
      holder: ConversationStateRow["holder"];
      holder_reason: string | null;
      holder_changed_at: string | null;
      updated_at: string;
      revision: number;
    }>(
      `select s.conversation_id, s.party_kind, s.phase, s.holder, s.holder_reason,
              ${UTC("s.holder_changed_at")} as holder_changed_at, ${UTC("s.updated_at")} as updated_at,
              ops.cos_conversation_revision(s.tenant_id, s.conversation_id) as revision
         from ops.conversation_states s
        where s.tenant_id = $1
        order by s.updated_at desc
        limit $2`,
      [tenantId, MAX_LISTED],
    );
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      partyKind: row.party_kind,
      phase: row.phase,
      holder: row.holder,
      holderReason: row.holder_reason,
      holderChangedAt: row.holder_changed_at,
      updatedAt: row.updated_at,
      revision: row.revision,
    }));
  } catch (error) {
    throw toDomainError(error);
  }
}

const conversationAct =
  (fn: "take_over_conversation" | "release_conversation") =>
  async (
    tx: TxClient,
    input: {
      readonly tenantId: string;
      readonly conversationId: string;
      readonly actor: string;
    },
  ): Promise<Record<string, unknown>> => {
    const answer = await one<Record<string, unknown>>(
      tx,
      `select ops.${fn}($1, $2, $3) as answer`,
      [
        requireUuid(input.tenantId, "tenantId"),
        requireUuid(input.conversationId, "conversationId"),
        requireActor(input.actor),
      ],
    );
    if (!answer || typeof answer !== "object")
      throw new Error(`ops.${fn} answered outside its contract`);
    return answer;
  };

/** A person takes the conversation over: the agent stops answering it. */
export const takeOverConversation = conversationAct("take_over_conversation");
/** The person gives the conversation back to the agent. */
export const releaseConversation = conversationAct("release_conversation");

/**
 * A person's reply to the newest message of a conversation the person holds,
 * naming the revision the listing showed: recorded as an accepted review, sent
 * by `messaging send`. A conversation that moved since is refused.
 *
 * The browser inbox (ADR 0026 §E, SI-87) records its reply through the same
 * review logic (ops.open_person_reply_review, shared with
 * ops.record_person_reply; only the source differs), but in the same act asks
 * for its send, which the worker's reply job carries; this owner path still
 * sends nothing until `messaging send`.
 */
export async function recordPersonReply(
  tx: TxClient,
  input: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly text: string;
    readonly actor: string;
    readonly expectedRevision: number;
  },
): Promise<Record<string, unknown>> {
  const text = input.text;
  if (
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.expectedRevision > MAX_REVISION
  ) {
    throw invalid("name the revision the conversation listing showed");
  }
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    [...text].length > MAX_REPLY_LENGTH ||
    !/\S/.test(text) ||
    CONTROL.test(text)
  ) {
    throw invalid(
      `a reply has 1 to ${MAX_REPLY_LENGTH} characters, is not blank, and has no control character but a line break`,
    );
  }
  const answer = await one<Record<string, unknown>>(
    tx,
    "select ops.record_person_reply($1, $2, $3, $4, $5) as answer",
    [
      requireUuid(input.tenantId, "tenantId"),
      requireUuid(input.conversationId, "conversationId"),
      text,
      requireActor(input.actor),
      input.expectedRevision,
    ],
  );
  if (!answer || typeof answer !== "object")
    throw new Error("ops.record_person_reply answered outside its contract");
  return answer;
}

// ---------------------------------------------------------------------------
// Screenings.
// ---------------------------------------------------------------------------

export interface ScreeningCount {
  readonly messageClass: string;
  readonly disposition: string;
  readonly count: number;
}

/** How the tenant's messages were screened, by class and disposition. Counts only. */
export async function screeningSummary(
  tx: TxClient,
  input: { readonly tenantId: string },
): Promise<readonly ScreeningCount[]> {
  const tenantId = requireUuid(input.tenantId, "tenantId");
  try {
    const { rows } = await tx.query<{
      message_class: string;
      disposition: string;
      count: string;
    }>(
      `select s.message_class, s.disposition, count(*)::text as count
         from ops.inbound_screenings s
        where s.tenant_id = $1
        group by s.message_class, s.disposition
        order by s.message_class, s.disposition`,
      [tenantId],
    );
    return rows.map((row) => ({
      messageClass: row.message_class,
      disposition: row.disposition,
      count: Number(row.count),
    }));
  } catch (error) {
    throw toDomainError(error);
  }
}
