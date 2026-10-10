// The browser inbox (ADR 0026 §E, SI-87) as engine/domain/browserInbox.dbtest.ts
// reaches it over the real `pg` driver:
//
//   - the read through its identity gate, as a signed-in member, in a
//     transaction that is rolled back (companyOsMember.ts), its answer parsed
//     by the browser's own contract;
//   - the two acts through their callees, as the gate calls them once the
//     member is resolved, COMMITTED, so the worker can carry what they record
//     (the identity half, the second factor included, is
//     supabase/tests/browser_inbox.sql and the live probe); the local seed's
//     non-production exemption waives the second factor here, as SI-74 says;
//   - an act through its gate itself, rolled back, for the 2 s bound.
//
// ALL DATA IS SYNTHETIC. The principals below are labels, not people.

import type { Pool, PoolClient } from "pg";
import {
  ConversationSchema,
  ReleaseConversationResultSchema,
  ReplyToConversationResultSchema,
  type AvailableConversation,
  type ConversationTurn,
  type ReleaseConversationResult,
  type ReplyToConversationResult,
} from "../../../contracts/company-os-api/index.ts";
import type { WorkerDatabase } from "../../db/types.ts";
import { TENANT_A } from "../../worker/testSupport/dbFixture.ts";
import {
  memberIdentity,
  readAsMember,
  signInAsMember,
} from "./companyOsMember.ts";

/** The actor label the gate would pass for a resolved member. */
export const PRINCIPAL = "principal:00000000-0000-4000-8000-0000000005a1";
export const OTHER_PRINCIPAL = "principal:00000000-0000-4000-8000-0000000005b2";

export const REPLY_SQL =
  "select ops.reply_to_conversation_as_member($1, $2, $3, $4, $5)::text as body";
const RELEASE_SQL =
  "select ops.release_conversation_as_member($1, $2, $3, $4)::text as body";

type Queryable = Pool | PoolClient;

/** A member's reply, recorded and committed (or refused) by the act's callee. */
export async function replyAs(
  db: Queryable,
  taskId: string,
  text: string,
  revision: number,
  actor: string = PRINCIPAL,
): Promise<ReplyToConversationResult> {
  const { rows } = await db.query<{ body: string }>(REPLY_SQL, [
    TENANT_A,
    actor,
    taskId,
    text,
    revision,
  ]);
  return ReplyToConversationResultSchema.parse(JSON.parse(rows[0].body));
}

/** A member's release, by the act's callee. */
export async function releaseAs(
  db: Queryable,
  taskId: string,
  revision: number,
  actor: string = PRINCIPAL,
): Promise<ReleaseConversationResult> {
  const { rows } = await db.query<{ body: string }>(RELEASE_SQL, [
    TENANT_A,
    actor,
    taskId,
    revision,
  ]);
  return ReleaseConversationResultSchema.parse(JSON.parse(rows[0].body));
}

/** get_conversation through its gate as a signed-in member, as the browser parses it. */
export async function readConversation(
  owner: WorkerDatabase,
  taskId: string,
): Promise<AvailableConversation> {
  const answer = await readAsMember(owner, TENANT_A, async (member) =>
    ConversationSchema.parse(
      (await member.read("get_conversation", { p_task_id: taskId })).value,
    ),
  );
  if (answer.status !== "available") {
    throw new Error(`the conversation is ${answer.status}, not available`);
  }
  return answer;
}

/** The person replies a conversation shows, oldest first. */
export const personTurns = (
  conversation: AvailableConversation,
): Extract<ConversationTurn, { kind: "reply" }>[] =>
  conversation.turns.filter(
    (turn): turn is Extract<ConversationTurn, { kind: "reply" }> =>
      turn.kind === "reply" && turn.author === "person",
  );

class RolledBack {}

export interface GateAnswer {
  /** The SQLSTATE the gate raised, or undefined when it answered. */
  readonly code: string | undefined;
  /** How long the call took, in milliseconds. */
  readonly ms: number;
}

/**
 * One call through an act's identity gate as a signed-in member, in a
 * transaction that is always rolled back: its SQLSTATE and its duration.
 */
export async function actThroughGate(
  owner: WorkerDatabase,
  sql: string,
  params: readonly unknown[],
): Promise<GateAnswer> {
  let code: string | undefined;
  let ms = 0;
  try {
    await owner.withTransaction(async (tx) => {
      await signInAsMember(tx, TENANT_A, memberIdentity());
      const started = Date.now();
      try {
        await tx.query(sql, params);
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      ms = Date.now() - started;
      throw new RolledBack();
    });
  } catch (outcome) {
    if (!(outcome instanceof RolledBack)) throw outcome;
  }
  return { code, ms };
}

export interface PersonSend {
  id: string;
  status: string;
  blocked_reason: string | null;
  error_class: string | null;
  text: string;
  reviewer: string;
}

/** The tenant's person_reply sends, in the order their reviews were written. */
export async function personSends(admin: Pool): Promise<PersonSend[]> {
  const { rows } = await admin.query<PersonSend>(
    `select o.id, o.status, o.blocked_reason, o.error_class,
            ri.proposed ->> 'response_draft' as text, ri.reviewer
       from ops.outbound_messages o
       join ops.review_items ri on ri.id = o.review_item_id
       join ops.events e on e.idempotency_key = format('review:%s:pending', ri.id)
      where o.tenant_id = $1 and o.authorization_kind = 'person_reply'
      order by e.seq`,
    [TENANT_A],
  );
  return rows;
}

/** What the acts wrote: person reviews, person_reply sends and reply jobs. */
export async function actCounts(admin: Pool): Promise<Record<string, number>> {
  const { rows } = await admin.query<Record<string, number>>(
    `select (select count(*)::int from ops.review_items where tenant_id = $1 and author = 'person') as reviews,
            (select count(*)::int from ops.outbound_messages
              where tenant_id = $1 and authorization_kind = 'person_reply') as sends,
            (select count(*)::int from ops.jobs where tenant_id = $1 and kind = 'outbound.reply_send') as jobs`,
    [TENANT_A],
  );
  return rows[0];
}
