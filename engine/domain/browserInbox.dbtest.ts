// The browser inbox (ADR 0026 §E, SI-87), end to end: signed Meta deliveries
// through the gateway's own login, the real worker runtime with a fake reply
// transport, the read through its gate as a signed-in member, and the acts'
// callees committed, against a real Postgres. A member's reply is queued by
// its act and sent once by the worker's reply job; a release gives the
// conversation back to the agent; an act waits at most 2 s for a conversation
// another transaction holds; a reply never leaves after the contact's newer
// message, in any order of the two; a conversation's replies leave in the
// order written; without a transport a reply waits until its window ends; an
// interrupted send is never made again; a lost answer is recovered by a read;
// the operator's send never carries a person's reply; the person's text never
// reaches a model; and the acts and the screening never wait on each other in
// a cycle.
//
// ALL DATA IS SYNTHETIC (BASELINE Q8). Numbers, targets and texts are invented.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import {
  createFakeOutboundTransport,
  type ReplyTransport,
} from "../communication/replyTransport.ts";
import type { WorkerDatabase } from "../db/types.ts";
import { HIDDEN_TURN_MARKER } from "../frontDesk/prompt.ts";
import { OUTBOUND_REPLY_SEND_KIND } from "../handlers/outboundReplySend.ts";
import type {
  ExternalCallHandlerDefinition,
  HandlerRegistry,
} from "../worker/handlerRegistry.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import {
  ADMIN_URL,
  removeFixtureModels,
  TENANT_A,
} from "../worker/testSupport/dbFixture.ts";
import { waitUntil } from "../worker/testSupport/spendProbes.ts";
import { sendApprovedReview } from "./outboundSend.ts";
import {
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  openAgentRuntimeDatabases,
} from "./testSupport/agentRuntimeProbes.ts";
import {
  actCounts,
  actThroughGate,
  OTHER_PRINCIPAL,
  personSends,
  personTurns,
  PRINCIPAL,
  readConversation,
  releaseAs,
  replyAs,
} from "./testSupport/browserInbox.ts";
import {
  createFrontDeskHarness,
  DEAL_NAME,
  FRONT_DESK_MODELS,
} from "./testSupport/frontDeskHarness.ts";
import {
  accepted,
  addCrmContact,
  deleteCrmContacts,
  fakeTransport,
  gatewayDatabase,
  provisionGatewayRole,
} from "./testSupport/whatsappFixture.ts";

const TARGET = "200000000000955";
const DEVICE = "5511900000955";
/** The owner's own number: no conversation and no CRM contact holds it. */
const OWNER = "5511900000957";
const PERSON_REQUEST = "Quero falar com uma pessoa, por favor.";
const FOLLOW_UP = "Qual o valor da primeira sessão?";
const REPLY = "Olá! Aqui é a equipe da clínica fictícia. Como posso ajudar?";

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;
let gateway: WorkerDatabase;
/** The racing connections: apart from admin, whose two connections watch and read. */
let racers: Pool;

beforeAll(() => {
  ({ admin, owner, db } = openAgentRuntimeDatabases());
  provisionGatewayRole();
  gateway = gatewayDatabase();
  racers = new Pool({
    connectionString: ADMIN_URL,
    max: 2,
    statement_timeout: 15_000,
  });
}, 60_000);

afterAll(async () => {
  await racers.end();
  await gateway.close();
  await removeFixtureModels(admin, FRONT_DESK_MODELS);
  await admin.query("delete from public.deals where name = $1", [DEAL_NAME]);
  await deleteCrmContacts(admin);
  await closeAgentRuntimeDatabases({ admin, owner, db });
});

const { prepare, frontDesk, runtime, drain, send, latest, holder } =
  createFrontDeskHarness(() => ({ admin, owner, db, gateway }), {
    target: TARGET,
    device: DEVICE,
    messagePrefix: "BI",
  });

beforeEach(prepare);

const { runAgentJob } = agentRuntimeProbes(() => ({ admin, owner, db }));

const fake = (): ReplyTransport & {
  readonly transport: ReturnType<typeof createFakeOutboundTransport>;
} => {
  const transport = createFakeOutboundTransport();
  return { kind: "fake", transport, templates: transport, timeoutMs: 1_000 };
};

/** A front desk whose contact asked for a person: the conversation waits. */
const waitingConversation = async (
  registry: HandlerRegistry,
): Promise<{ taskId: string; conversationId: string; revision: number }> => {
  await send(PERSON_REQUEST);
  await drain(registry);
  const out = await latest();
  const { revision } = await readConversation(owner, out.task_id);
  return {
    taskId: out.task_id,
    conversationId: out.conversation_id,
    revision,
  };
};

/** Makes every reply job available now (a released job waits 30 s). */
const releaseWaits = () =>
  admin.query(
    "update ops.jobs set available_at = now() where tenant_id = $1 and kind = $2",
    [TENANT_A, OUTBOUND_REPLY_SEND_KIND],
  );

/** Moves every send's bound into the past, the guard set aside meanwhile. */
const expireSends = async (): Promise<void> => {
  await admin.query(
    "alter table ops.outbound_messages disable trigger outbound_messages_guard",
  );
  try {
    await admin.query(
      "update ops.outbound_messages set fresh_until = now() - interval '1 second' where tenant_id = $1",
      [TENANT_A],
    );
  } finally {
    await admin.query(
      "alter table ops.outbound_messages enable always trigger outbound_messages_guard",
    );
  }
};

const openKinds = async (conversationId: string): Promise<string[]> =>
  (
    await admin.query<{ kind: string }>(
      `select kind from ops.exceptions
        where tenant_id = $1 and conversation_id = $2 and resolved_at is null order by kind`,
      [TENANT_A, conversationId],
    )
  ).rows.map((row) => row.kind);

/** The registry with `before` run as the reply job's last gate begins. */
const beforeConfirm = (
  registry: HandlerRegistry,
  before: () => Promise<void>,
): HandlerRegistry => {
  const handler = registry.get(
    OUTBOUND_REPLY_SEND_KIND,
  ) as ExternalCallHandlerDefinition;
  const confirm = handler.confirm;
  if (confirm === undefined) throw new Error("the reply job has no last gate");
  const wrapped = new Map(registry);
  wrapped.set(OUTBOUND_REPLY_SEND_KIND, {
    ...handler,
    async confirm(state, capabilities) {
      await before();
      return confirm.call(handler, state, capabilities);
    },
  } satisfies ExternalCallHandlerDefinition);
  return wrapped;
};

/** Resolves once a backend matching `where` waits on a lock. */
const lockWaiting = async (where: string, message: string): Promise<void> =>
  waitUntil(
    async () =>
      (
        await admin.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and ${where}`,
        )
      ).rows[0].n > 0,
    message,
    5_000,
  );

const pidOf = async (client: PoolClient): Promise<number> =>
  (await client.query<{ pid: number }>("select pg_backend_pid() as pid"))
    .rows[0].pid;

describe("a member's reply from the browser inbox (ADR 0026 §E, SI-87)", () => {
  it("queues the reply, sends it once through the worker and shows it sent; the owner hears of the next message after it", async () => {
    const clinic = await frontDesk();
    await addCrmContact(admin, DEVICE);
    await admin.query(
      `select ops.record_owner_notification_target(
         $1, $2, $3, 'aviso_fila_conversa', 'aviso_fila_resumo', 'dbtest-owner', 'pt_BR',
         array['person_requested', 'message_waiting'],
         ((now() at time zone 'America/Sao_Paulo')::time + interval '2 hours')::time,
         ((now() at time zone 'America/Sao_Paulo')::time + interval '3 hours')::time,
         'America/Sao_Paulo', 10, 30, 'Contato')`,
      [TENANT_A, clinic.channelId, OWNER],
    );
    const reply = fake();
    const { provider, registry } = runtime(undefined, {
      replyTransport: reply,
    });
    await send(PERSON_REQUEST);
    await drain(registry);

    // The waiting list names the conversation by a task of its own.
    const { rows: listed } = await admin.query<{
      list: { total: number; items: { ref: string }[] };
    }>("select ops.cos_waiting_list($1, clock_timestamp()) as list", [
      TENANT_A,
    ]);
    expect(listed[0].list.total).toBe(1);
    const ref = listed[0].list.items[0].ref;
    const seen = await readConversation(owner, ref);
    expect(seen).toMatchObject({
      holder: "person",
      allowedActs: { reply: true, release: true },
      replyUnavailable: null,
    });

    expect(await replyAs(admin, ref, REPLY, seen.revision)).toMatchObject({
      outcome: "queued",
      revision: seen.revision,
      reason: null,
    });
    await drain(registry);
    expect(reply.transport.calls).toHaveLength(1);
    expect(reply.transport.calls[0]).toMatchObject({ to: DEVICE, body: REPLY });
    const [sent] = await personSends(admin);
    expect(sent).toMatchObject({ status: "sent", reviewer: PRINCIPAL });
    expect(personTurns(await readConversation(owner, ref))).toEqual([
      expect.objectContaining({
        text: REPLY,
        delivery: "sent",
        automatic: false,
        fixedKey: null,
      }),
    ]);

    // The contact writes again: the owner is told, after this reply.
    await send(FOLLOW_UP);
    await drain(registry);
    const { rows: told } = await admin.query<{
      kind: string;
      follows: string | null;
    }>(
      `select n.kind, ri.proposed ->> 'response_draft' as follows
         from ops.owner_notifications n
         left join ops.review_items ri on ri.id = n.follows_review_id
        where n.tenant_id = $1 order by n.recorded_at, n.id`,
      [TENANT_A],
    );
    expect(told).toEqual([
      { kind: "person_requested", follows: null },
      { kind: "message_waiting", follows: REPLY },
    ]);
    expect(reply.transport.calls).toHaveLength(1);
    expect(provider.calls).toHaveLength(0);
  });

  it("gives the conversation back to the agent, whose next answer is the model's", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { provider, registry } = runtime();
    const { taskId, conversationId, revision } =
      await waitingConversation(registry);

    expect(await releaseAs(admin, taskId, revision)).toMatchObject({
      outcome: "released",
      revision,
    });
    expect(await holder(conversationId)).toMatchObject({ holder: "agent" });
    expect(await openKinds(conversationId)).toEqual([]);

    await send(FOLLOW_UP);
    await drain(registry);
    expect(await latest()).toMatchObject({ disposition: "model" });
    expect(provider.calls).toHaveLength(1);
    expect(await openKinds(conversationId)).toEqual([]);
  });

  it("answers a retryable refusal after the 2 s bound while another transaction holds the conversation, recording nothing", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime();
    const { taskId, conversationId, revision } =
      await waitingConversation(registry);
    const before = await actCounts(admin);

    const other = await racers.connect();
    try {
      await other.query("begin");
      await other.query(
        "select 1 from ops.conversations where id = $1 for no key update",
        [conversationId],
      );
      const answers = [
        await actThroughGate(
          owner,
          "select company_os_api.reply_to_conversation($1, $2, $3)",
          [taskId, REPLY, revision],
        ),
        await actThroughGate(
          owner,
          "select company_os_api.release_conversation($1, $2)",
          [taskId, revision],
        ),
      ];
      for (const answer of answers) {
        expect(answer.code).toBe("OS429");
        expect(answer.ms).toBeGreaterThanOrEqual(1_900);
        expect(answer.ms).toBeLessThan(3_000);
      }
    } finally {
      await other.query("rollback");
      other.release();
    }
    expect(await actCounts(admin)).toEqual(before);
    expect(await holder(conversationId)).toMatchObject({ holder: "person" });
  }, 30_000);

  it("never sends a reply after the contact's newer message, in any order of the two", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    const { taskId } = await waitingConversation(registry);
    const revisionNow = async () =>
      (await readConversation(owner, taskId)).revision;

    // (a) The act holds the conversation: the contact's message waits at its
    //     admission until the act commits, then makes the reply stale.
    const actor = await racers.connect();
    try {
      await actor.query("begin");
      expect(
        await replyAs(actor, taskId, "Resposta A.", await revisionNow()),
      ).toMatchObject({ outcome: "queued" });
      const delivery = send("Mais uma coisa.");
      await lockWaiting(
        "usename = 'ops_gateway_login'",
        "the contact's message never waited for the reply's act",
      );
      await actor.query("commit");
      await delivery;
    } finally {
      await actor.query("rollback").catch(() => undefined);
      actor.release();
    }
    await drain(registry);

    // (b) The message first: the act is answered stale, recording nothing.
    const seen = await revisionNow();
    await send("E outra.");
    await drain(registry);
    const before = await actCounts(admin);
    expect(await replyAs(admin, taskId, "Resposta B.", seen)).toMatchObject({
      outcome: "stale",
      revision: seen + 1,
    });
    expect(await actCounts(admin)).toEqual(before);

    // (c) The message comes after the send began and before its last gate.
    expect(
      await replyAs(admin, taskId, "Resposta C.", await revisionNow()),
    ).toMatchObject({ outcome: "queued" });
    const racing = beforeConfirm(registry, () => send("Ainda outra."));
    expect(await runAgentJob(racing)).toMatchObject({
      kind: OUTBOUND_REPLY_SEND_KIND,
    });

    // (d) Both at once, however they interleave, the member having read the
    //     conversation before the message.
    const seenLast = await revisionNow();
    const [, raced] = await Promise.all([
      send("Uma última."),
      replyAs(admin, taskId, "Resposta D.", seenLast),
    ]);
    expect(["queued", "stale"]).toContain(raced.outcome);
    await drain(registry);
    await releaseWaits();
    await drain(registry);

    expect(reply.transport.calls).toHaveLength(0);
    const sends = await personSends(admin);
    expect(
      sends.map(({ text, status, blocked_reason, error_class }) => ({
        text,
        status,
        reason: blocked_reason ?? error_class,
      })),
    ).toEqual([
      { text: "Resposta A.", status: "blocked", reason: "newer_message" },
      { text: "Resposta C.", status: "failed", reason: "newer_message" },
      ...(raced.outcome === "queued"
        ? [
            {
              text: "Resposta D.",
              status: expect.stringMatching(/^(blocked|failed)$/),
              reason: "newer_message",
            },
          ]
        : []),
    ]);
  }, 60_000);

  it("sends two members' replies in the order written, whichever worker takes which job (20 runs)", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    const { taskId } = await waitingConversation(registry);

    for (let i = 1; i <= 20; i += 1) {
      if (i > 1) {
        await send(`Mensagem ${i}.`);
        await drain(registry);
      }
      const { revision } = await readConversation(owner, taskId);
      expect(
        await replyAs(admin, taskId, `Primeira ${i}.`, revision),
      ).toMatchObject({ outcome: "queued" });
      expect(
        await replyAs(
          admin,
          taskId,
          `Segunda ${i}.`,
          revision,
          OTHER_PRINCIPAL,
        ),
      ).toMatchObject({ outcome: "queued" });
      await Promise.all([
        runOneJob(db, { workerId: "dbtest-inbox-1", registry }),
        runOneJob(db, { workerId: "dbtest-inbox-2", registry }),
      ]);
      await releaseWaits();
      await drain(registry);
      expect(reply.transport.calls.slice(-2).map((call) => call.body)).toEqual([
        `Primeira ${i}.`,
        `Segunda ${i}.`,
      ]);
    }
    expect(reply.transport.calls).toHaveLength(40);
  }, 120_000);

  it("waits without a transport, its job given back every 30 s, until the window ends, then lists it for a person", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime();
    const { taskId, conversationId, revision } =
      await waitingConversation(registry);
    await replyAs(admin, taskId, REPLY, revision);

    for (let cycle = 0; cycle < 2; cycle += 1) {
      await releaseWaits();
      expect(await runAgentJob(registry)).toMatchObject({
        outcome: "deferred",
        kind: OUTBOUND_REPLY_SEND_KIND,
      });
      const { rows } = await admin.query<{
        status: string;
        attempts: number;
        wait_ms: number;
      }>(
        `select status, attempts,
                (extract(epoch from available_at - now()) * 1000)::int as wait_ms
           from ops.jobs where tenant_id = $1 and kind = $2`,
        [TENANT_A, OUTBOUND_REPLY_SEND_KIND],
      );
      expect(rows).toEqual([
        { status: "queued", attempts: 0, wait_ms: expect.any(Number) },
      ]);
      expect(rows[0].wait_ms).toBeGreaterThan(25_000);
      expect(rows[0].wait_ms).toBeLessThanOrEqual(30_000);
    }
    expect(await personSends(admin)).toMatchObject([{ status: "authorized" }]);

    // The window ends.
    await expireSends();
    await releaseWaits();
    await drain(registry);
    expect(await personSends(admin)).toMatchObject([
      { status: "blocked", blocked_reason: "transport_not_configured" },
    ]);
    expect(await openKinds(conversationId)).toContain("send_blocked");
  });

  it("records a send interrupted after its call indeterminate and never calls again", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    const { taskId, revision } = await waitingConversation(registry);
    await replyAs(admin, taskId, REPLY, revision);

    // The worker dies right after the call, before its settlement commits.
    await runAgentJob(registry, {
      onCallFinished: async () => {
        throw new Error("dbtest: the worker died after the call");
      },
    });
    expect(reply.transport.calls).toHaveLength(1);
    expect(await personSends(admin)).toMatchObject([{ status: "sending" }]);

    await releaseWaits();
    await drain(registry);
    expect(reply.transport.calls).toHaveLength(1);
    expect(await personSends(admin)).toMatchObject([
      { status: "indeterminate", error_class: "execution_interrupted" },
    ]);
    expect(personTurns(await readConversation(owner, taskId))).toEqual([
      expect.objectContaining({
        delivery: "uncertain",
        reason: "execution_interrupted",
      }),
    ]);
  });

  it("recovers a lost answer by a read, and the resubmitted reply records nothing", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime();
    const { taskId, revision } = await waitingConversation(registry);

    // The act commits and its answer never reaches the browser.
    const client = await racers.connect();
    try {
      await client.query("begin");
      await replyAs(client, taskId, REPLY, revision);
      await client.query("commit");
    } finally {
      client.release();
    }

    expect(personTurns(await readConversation(owner, taskId))).toEqual([
      expect.objectContaining({ text: REPLY, delivery: "queued" }),
    ]);
    const before = await actCounts(admin);
    expect(await replyAs(admin, taskId, REPLY, revision)).toMatchObject({
      outcome: "already_recorded",
      revision,
      reason: null,
    });
    expect(await actCounts(admin)).toEqual(before);
  });

  it("refuses the operator's send of a person's reply its job carries", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime();
    const { taskId, revision } = await waitingConversation(registry);
    await replyAs(admin, taskId, REPLY, revision);
    const { rows } = await admin.query<{ id: string }>(
      "select id from ops.review_items where tenant_id = $1 and author = 'person'",
      [TENANT_A],
    );

    const operator = fakeTransport(() => accepted("wamid.BI-OPERATOR"));
    await expect(
      sendApprovedReview(owner, operator, {
        tenantId: TENANT_A,
        reviewId: rows[0].id,
        requestedBy: "dbtest operator",
        source: "dbtest",
      }),
    ).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("carried_by_job"),
    });
    expect(operator.calls).toHaveLength(0);
  });

  it("never shows the person's text to the model (SI-80)", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { provider, registry } = runtime(undefined, {
      replyTransport: reply,
    });
    const { taskId, revision } = await waitingConversation(registry);
    const secret = "Podemos conversar amanhã. SENTINEL-PERSON-SECRET";
    await replyAs(admin, taskId, secret, revision);
    await drain(registry);
    expect(reply.transport.calls).toHaveLength(1);

    const seen = await readConversation(owner, taskId);
    expect(await releaseAs(admin, taskId, seen.revision)).toMatchObject({
      outcome: "released",
    });
    await send(FOLLOW_UP);
    await drain(registry);
    expect(await latest()).toMatchObject({ disposition: "model" });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].input).toContain(HIDDEN_TURN_MARKER);
    expect(provider.calls[0].input).not.toContain("SENTINEL-PERSON-SECRET");
  });

  it("takes the conversation and its state in an order the screening's own never closes into a cycle", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime();
    const { taskId, conversationId, revision } =
      await waitingConversation(registry);

    const screening = await racers.connect();
    const actor = await racers.connect();
    try {
      // The screening's order: the state for update, later the conversation
      // for key share only.
      await screening.query("begin");
      await screening.query("set local lock_timeout = '1s'");
      await screening.query(
        "select 1 from ops.conversation_states where conversation_id = $1 for update",
        [conversationId],
      );
      // The act takes the conversation, then waits for the state.
      await actor.query("begin");
      const actorPid = await pidOf(actor);
      const act = replyAs(actor, taskId, REPLY, revision);
      await lockWaiting(
        `pid = ${actorPid}`,
        "the act never waited for the conversation's state",
      );
      // Key share admits the act's no-key-update lock: no wait, no cycle.
      await screening.query(
        "select 1 from ops.conversations where id = $1 for key share",
        [conversationId],
      );
      await screening.query("commit");
      expect(await act).toMatchObject({ outcome: "queued" });
      await actor.query("commit");
    } finally {
      await screening.query("rollback").catch(() => undefined);
      await actor.query("rollback").catch(() => undefined);
      screening.release();
      actor.release();
    }
    expect(await actCounts(admin)).toMatchObject({ reviews: 1, sends: 1 });
  });
});
