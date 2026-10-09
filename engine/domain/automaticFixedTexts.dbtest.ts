// The owner's published fixed texts leave on their own (ADR 0026 §B), end to
// end: signed Meta deliveries through the gateway's own login, the real worker
// runtime, the real screening and the worker's reply job, against a real
// Postgres. A text the operating policy lists is accepted as policy by the
// screening and carried by the job, holding every send gate; a text it does not
// list, and every model reply, waits for a person; a text that cannot leave in
// time, or past the hourly cap, is listed for a person; two close crisis
// messages send one safety text; a stop holds the job; the operator's send
// never carries it; an uncertain outcome is never sent again; a job that ends
// without settling its send leaves it listed for a person, never sent.
//
// ALL DATA IS SYNTHETIC (BASELINE Q8). Numbers, targets and texts are invented.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import {
  createFakeOutboundTransport,
  type ReplyTransport,
} from "../communication/replyTransport.ts";
import { OUTBOUND_REPLY_SEND_KIND } from "../handlers/outboundReplySend.ts";
import type {
  ExternalCallHandlerDefinition,
  HandlerRegistry,
} from "../worker/handlerRegistry.ts";
import {
  draftAgentConfiguration,
  publishAgentConfiguration,
} from "./frontDesk.ts";
import {
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
  createFrontDeskHarness,
  DEAL_NAME,
  FIXED,
  FRONT_DESK_MODELS,
  KNOWLEDGE,
  POLICY,
} from "./testSupport/frontDeskHarness.ts";
import {
  accepted,
  addCrmContact,
  deleteCrmContacts,
  fakeTransport,
  gatewayDatabase,
  provisionGatewayRole,
} from "./testSupport/whatsappFixture.ts";

const TARGET = "200000000000933";
const DEVICE = "5511900000933";
const ADMINISTRATIVE = "Qual o valor da primeira sessão?";
const DANGER = "Não quero mais viver.";
const DANGER_AGAIN = DANGER;
const OPT_OUT = "Não quero mais receber mensagens.";
const PERSON_REQUEST = "Quero falar com uma pessoa, por favor.";
const UNCLEAR = "quero falar com o Bruno";
const OTHER_UUID = "0b8f5a1e-0000-4000-8000-0000000000ff";

const AUTOMATIC = [
  "safety",
  "safety_followup",
  "human_handoff_ack",
  "opt_out_ack",
  "clarification",
];
const AUTO_POLICY = { ...POLICY, automaticFixedTexts: AUTOMATIC };
const FIXED_FOLLOWUP = {
  messages: {
    ...FIXED.messages,
    safety_followup: "Segundo texto fixo de segurança (fictício): 188.",
  },
};

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;
let gateway: WorkerDatabase;

beforeAll(() => {
  ({ admin, owner, db } = openAgentRuntimeDatabases());
  provisionGatewayRole();
  gateway = gatewayDatabase();
}, 60_000);

afterAll(async () => {
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
    messagePrefix: "AF",
  });

beforeEach(prepare);

const { runAgentJob } = agentRuntimeProbes(() => ({ admin, owner, db }));

const fake = (): ReplyTransport & {
  readonly transport: ReturnType<typeof createFakeOutboundTransport>;
} => {
  const transport = createFakeOutboundTransport();
  return { kind: "fake", transport, templates: transport, timeoutMs: 1_000 };
};

interface SendRow {
  status: string;
  authorization_kind: string;
  fixed_text_key: string | null;
  transport: string | null;
  blocked_reason: string | null;
  error_class: string | null;
}

const sends = async (): Promise<SendRow[]> =>
  (
    await admin.query<SendRow>(
      `select status, authorization_kind, fixed_text_key, transport, blocked_reason, error_class
         from ops.outbound_messages where tenant_id = $1 order by created_at, id`,
      [TENANT_A],
    )
  ).rows;

const reviewOf = async (taskId: string) =>
  (
    await admin.query<{
      id: string;
      status: string;
      reviewer: string | null;
      decision_basis: string | null;
    }>(
      `select id, status, reviewer, decision_basis from ops.review_items
        where tenant_id = $1 and task_id = $2 and author <> 'person'`,
      [TENANT_A, taskId],
    )
  ).rows[0];

const openExceptions = async (): Promise<string[]> =>
  (
    await admin.query<{ kind: string }>(
      `select kind from ops.exceptions where tenant_id = $1 and resolved_at is null order by kind`,
      [TENANT_A],
    )
  ).rows.map((row) => row.kind);

const replyJobs = async () =>
  (
    await admin.query<{ id: string; status: string }>(
      `select id, status from ops.jobs where tenant_id = $1 and kind = 'outbound.reply_send' order by created_at, id`,
      [TENANT_A],
    )
  ).rows;

/** Makes every queued reply job available now (a released job waits 30 s). */
const releaseWaits = () =>
  admin.query(
    `update ops.jobs set available_at = now()
      where tenant_id = $1 and kind = 'outbound.reply_send' and status = 'queued'`,
    [TENANT_A],
  );

const keyed = (rows: SendRow[]) =>
  rows.map(({ fixed_text_key, status, blocked_reason }) => ({
    fixed_text_key,
    status,
    blocked_reason,
  }));

const sendExceptions = async (): Promise<string[]> =>
  (await openExceptions()).filter((kind) => kind.startsWith("send_"));

/** The task of the conversation's first message. */
const firstTask = async (): Promise<string> =>
  (
    await admin.query<{ task_id: string }>(
      `select task_id from ops.inbound_messages where tenant_id = $1
        order by received_at, created_at limit 1`,
      [TENANT_A],
    )
  ).rows[0].task_id;

/** Moves every send's 30 minutes into the past. */
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

/** Makes the queued reply job's next attempt its last. */
const lastAttempt = () =>
  admin.query(
    `update ops.jobs set max_attempts = 1
      where tenant_id = $1 and kind = 'outbound.reply_send' and status = 'queued'`,
    [TENANT_A],
  );

/** ops.settle_stale_reply_sends(), as the worker's reaper tick calls it. */
const sweepStaleReplies = (): Promise<number> =>
  db.withTransaction(async (tx) => {
    await tx.query("set local role ops_worker");
    const { rows } = await tx.query<{ n: number | string }>(
      "select ops.settle_stale_reply_sends() as n",
    );
    return Number(rows[0].n);
  });

/** What the screening's policy authorization answers now, under a tenant stop. */
const authorizeUnderStop = async (reviewId: string): Promise<string> => {
  const { rows } = await admin.query<{ id: string }>(
    "select ops.trip_execution_stop('tenant', 'dbtest stop', 'dbtest', $1) as id",
    [TENANT_A],
  );
  try {
    const answer = await admin.query<{ answer: string }>(
      "select ops.authorize_fixed_reply($1) as answer",
      [reviewId],
    );
    return answer.rows[0].answer;
  } finally {
    await admin.query(
      "select ops.clear_execution_stop($1, 'dbtest clear', 'dbtest')",
      [rows[0].id],
    );
  }
};

const republishPolicy = (agentId: string, policy: unknown) =>
  owner.withTransaction(async (tx) => {
    const { id } = await draftAgentConfiguration(tx, {
      tenantId: TENANT_A,
      agentId,
      kind: "operating_policy",
      content: policy,
      actor: "dbtest-owner",
    });
    await publishAgentConfiguration(tx, {
      tenantId: TENANT_A,
      versionId: id,
      actor: "dbtest-owner",
    });
  });

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
  const replaced: ExternalCallHandlerDefinition = {
    ...handler,
    async confirm(state, capabilities) {
      await before();
      return confirm.call(handler, state, capabilities);
    },
  };
  const wrapped = new Map(registry);
  wrapped.set(OUTBOUND_REPLY_SEND_KIND, replaced);
  return wrapped;
};

describe("a fixed text the owner's policy lists leaves on its own (ADR 0026 §B)", () => {
  it("sends the safety text accepted as policy, never as a person's decision, to a number the CRM does not know", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    const reply = fake();
    const { provider, registry } = runtime(undefined, {
      replyTransport: reply,
    });
    await send(DANGER);
    await drain(registry);

    const out = await latest();
    expect(out).toMatchObject({
      disposition: "fixed_reply",
      fixed_message_key: "safety",
    });
    expect(await reviewOf(out.task_id)).toMatchObject({
      status: "accepted",
      reviewer: "policy:fixed-text",
      decision_basis: "published_fixed_text",
    });
    expect(await sends()).toEqual([
      {
        status: "sent",
        authorization_kind: "fixed_text",
        fixed_text_key: "safety",
        transport: "fake",
        blocked_reason: null,
        error_class: null,
      },
    ]);
    expect(reply.transport.calls).toHaveLength(1);
    expect(
      reply.transport.calls[0].body.startsWith(FIXED.messages.safety),
    ).toBe(true);
    expect(reply.transport.calls[0].to).toBe(DEVICE);
    const { rows } = await admin.query<{ source: string }>(
      `select source from ops.events where tenant_id = $1 and type = 'communication.outbound_sent'`,
      [TENANT_A],
    );
    expect(rows).toEqual([{ source: "agent-runtime" }]);
    expect(provider.calls).toHaveLength(0);
  });

  it("leaves a text the policy does not list for a person", async () => {
    await frontDesk(KNOWLEDGE, { ...POLICY, automaticFixedTexts: ["safety"] });
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(PERSON_REQUEST);
    await drain(registry);
    const out = await latest();
    expect(out).toMatchObject({
      fixed_message_key: "human_handoff_ack",
      review_status: "pending",
    });
    expect(await sends()).toEqual([]);
    expect(await replyJobs()).toEqual([]);
    expect(reply.transport.calls).toHaveLength(0);
  });

  it("never sends a model's reply on its own, whatever the policy lists", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { provider, registry } = runtime(undefined, {
      replyTransport: reply,
    });
    await send(ADMINISTRATIVE);
    await drain(registry);
    expect(await latest()).toMatchObject({
      disposition: "model",
      review_status: "pending",
    });
    expect(provider.calls).toHaveLength(1);
    expect(await sends()).toEqual([]);
    expect(reply.transport.calls).toHaveLength(0);
  });

  it("refuses the operator's send of a reply the policy authorized", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    const { registry } = runtime(undefined, { replyTransport: fake() });
    await send(DANGER);
    await drain(registry);
    const review = await reviewOf((await latest()).task_id);
    const operator = fakeTransport(() => accepted("wamid.AF-OPERATOR"));
    await expect(
      sendApprovedReview(owner, operator, {
        tenantId: TENANT_A,
        reviewId: review.id,
        requestedBy: "dbtest operator",
        source: "dbtest",
      }),
    ).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("carried_by_job"),
    });
    expect(operator.calls).toHaveLength(0);
  });
});

describe("what keeps an automatic text from leaving (ADR 0026 §B)", () => {
  it("waits without a transport, then blocks the text for a person once it is out of date", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime();
    await send(DANGER);
    await drain(registry);
    expect(await sends()).toMatchObject([
      { status: "authorized", transport: null },
    ]);
    expect(await replyJobs()).toMatchObject([{ status: "queued" }]);

    // Its 30 minutes pass.
    await admin.query(
      "alter table ops.outbound_messages disable trigger outbound_messages_guard",
    );
    await admin.query(
      "update ops.outbound_messages set fresh_until = now() - interval '1 second' where tenant_id = $1",
      [TENANT_A],
    );
    await admin.query(
      "alter table ops.outbound_messages enable always trigger outbound_messages_guard",
    );
    await releaseWaits();
    await drain(registry);
    expect(await sends()).toMatchObject([
      { status: "blocked", blocked_reason: "transport_not_configured" },
    ]);
    expect(await openExceptions()).toEqual(["send_blocked"]);
  });

  it("sends the second safety text to a later crisis message", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY, undefined, FIXED_FOLLOWUP);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(DANGER);
    await drain(registry);
    expect(reply.transport.calls).toHaveLength(1);
    expect(
      reply.transport.calls[0].body.startsWith(FIXED.messages.safety),
    ).toBe(true);

    // A second crisis message: the second safety text.
    await send(DANGER_AGAIN);
    await drain(registry);
    expect(await latest()).toMatchObject({
      fixed_message_key: "safety_followup",
    });
    expect(reply.transport.calls).toHaveLength(2);
    expect(
      reply.transport.calls[1].body.startsWith(
        FIXED_FOLLOWUP.messages.safety_followup,
      ),
    ).toBe(true);
  });

  it("waits while a newer message is screened, then sends only the newer safety text", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY, undefined, FIXED_FOLLOWUP);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    // Both crisis messages arrive before any is screened.
    await send(DANGER);
    await send(DANGER_AGAIN);
    await drain(registry);
    await releaseWaits();
    await drain(registry);

    expect(reply.transport.calls).toHaveLength(1);
    expect(
      reply.transport.calls[0].body.startsWith(
        FIXED_FOLLOWUP.messages.safety_followup,
      ),
    ).toBe(true);
    expect(
      (await sends()).map(({ fixed_text_key, status, blocked_reason }) => ({
        fixed_text_key,
        status,
        blocked_reason,
      })),
    ).toEqual([
      {
        fixed_text_key: "safety",
        status: "blocked",
        blocked_reason: "newer_message",
      },
      {
        fixed_text_key: "safety_followup",
        status: "sent",
        blocked_reason: null,
      },
    ]);
    // A text the contact's newer text replaced is no one's to chase.
    expect(
      (await openExceptions()).filter((kind) => kind.startsWith("send_")),
    ).toEqual([]);
  });

  it("gives the safety text's job back while a newer message is still to be screened", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY, undefined, FIXED_FOLLOWUP);
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(DANGER);
    expect(await runAgentJob(registry)).toMatchObject({
      outcome: "succeeded",
      kind: "agent_run.execute",
    });
    // The contact writes again before the safety text's job runs.
    await send(DANGER_AGAIN);
    expect(await runAgentJob(registry)).toMatchObject({
      outcome: "deferred",
      kind: "outbound.reply_send",
      detail: expect.stringContaining("status=waiting"),
    });
    expect(reply.transport.calls).toHaveLength(0);
    expect(await sends()).toMatchObject([{ status: "authorized" }]);
    // The newer message is screened (its own safety text), then both jobs run.
    expect(await runAgentJob(registry)).toMatchObject({
      outcome: "succeeded",
      kind: "agent_run.execute",
    });
    await releaseWaits();
    await drain(registry);
    expect(reply.transport.calls).toHaveLength(1);
    expect(
      (await sends()).map(({ fixed_text_key, status }) => ({
        fixed_text_key,
        status,
      })),
    ).toEqual([
      { fixed_text_key: "safety", status: "blocked" },
      { fixed_text_key: "safety_followup", status: "sent" },
    ]);
  });

  it("sends the opt-out acknowledgement, and still the safety text to a contact who asked to stop", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(OPT_OUT);
    await drain(registry);
    await send(DANGER);
    await drain(registry);
    expect(
      (await sends()).map(({ fixed_text_key, status }) => ({
        fixed_text_key,
        status,
      })),
    ).toEqual([
      { fixed_text_key: "opt_out_ack", status: "sent" },
      { fixed_text_key: "safety", status: "sent" },
    ]);
  });

  it("holds the conversation for a person past three automatic texts in an hour", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    for (let i = 0; i < 4; i += 1) {
      await send(UNCLEAR);
      await drain(registry);
    }
    expect(reply.transport.calls).toHaveLength(3);
    const out = await latest();
    expect(out).toMatchObject({
      fixed_message_key: "clarification",
      review_status: "pending",
    });
    expect(await holder(out.conversation_id)).toMatchObject({
      holder: "person",
      holder_reason: "automatic_cap",
    });
    expect(await openExceptions()).toEqual(["send_blocked"]);
  });

  it("holds the reply job under a stop on its agent, and sends once the stop is cleared", async () => {
    const clinic = await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(DANGER);
    // Screen it, then stop the agent before its reply job runs.
    await runAgentJob(registry);
    const { rows } = await admin.query<{ id: string }>(
      "select ops.trip_execution_stop('agent', 'dbtest stop', 'dbtest', $1, $2, null, $3) as id",
      [TENANT_A, clinic.companyId, clinic.agentId],
    );
    await drain(registry);
    expect(reply.transport.calls).toHaveLength(0);
    expect(await sends()).toMatchObject([{ status: "authorized" }]);

    await admin.query(
      "select ops.clear_execution_stop($1, 'dbtest clear', 'dbtest')",
      [rows[0].id],
    );
    await drain(registry);
    expect(reply.transport.calls).toHaveLength(1);
    expect(await sends()).toMatchObject([{ status: "sent" }]);
  });
});

describe("an automatic text is sent at most once (ADR 0026 §B, SI-50)", () => {
  it("records an uncertain answer indeterminate and lists it for a person, never sending again", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const uncertain = fakeTransport(() => ({
      kind: "ambiguous",
      errorClass: "provider_timeout",
    }));
    const { registry } = runtime(undefined, {
      replyTransport: {
        kind: "meta",
        transport: uncertain,
        templates: null,
        timeoutMs: 1_000,
      },
    });
    await send(DANGER);
    await drain(registry);
    expect(await sends()).toMatchObject([
      { status: "indeterminate", error_class: "provider_timeout" },
    ]);
    expect(await openExceptions()).toEqual(["send_indeterminate"]);
    await drain(registry);
    expect(uncertain.calls).toHaveLength(1);
  });

  it("records a send an earlier attempt left in flight as indeterminate, without calling again", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(DANGER);
    await runAgentJob(registry);
    // The worker dies right after the call, before its settlement commits.
    await runAgentJob(registry, {
      onCallFinished: async () => {
        throw new Error("dbtest: the worker died after the call");
      },
    });
    expect(reply.transport.calls).toHaveLength(1);
    expect(await sends()).toMatchObject([{ status: "sending" }]);

    await admin.query(
      `update ops.jobs set available_at = now() where tenant_id = $1 and kind = 'outbound.reply_send'`,
      [TENANT_A],
    );
    await drain(registry);
    expect(reply.transport.calls).toHaveLength(1);
    expect(await sends()).toMatchObject([
      { status: "indeterminate", error_class: "execution_interrupted" },
    ]);
    expect(await openExceptions()).toEqual(["send_indeterminate"]);
  });

  it("puts the send back, never calling, when a newer message is admitted as its last gate runs", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY, undefined, FIXED_FOLLOWUP);
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(DANGER);
    expect(await runAgentJob(registry)).toMatchObject({
      outcome: "succeeded",
      kind: "agent_run.execute",
    });
    // The contact writes again after the send began and before its last gate.
    const racing = beforeConfirm(registry, () => send(DANGER_AGAIN));
    expect(await runAgentJob(racing)).toMatchObject({
      outcome: "deferred",
      kind: OUTBOUND_REPLY_SEND_KIND,
      detail: expect.stringContaining("status=waiting"),
    });
    expect(reply.transport.calls).toHaveLength(0);
    expect(await sends()).toMatchObject([
      { status: "authorized", transport: null },
    ]);

    // The newer message is screened, and only its safety text leaves.
    await drain(registry);
    await releaseWaits();
    await drain(registry);
    expect(reply.transport.calls).toHaveLength(1);
    expect(
      reply.transport.calls[0].body.startsWith(
        FIXED_FOLLOWUP.messages.safety_followup,
      ),
    ).toBe(true);
    expect(keyed(await sends())).toEqual([
      {
        fixed_text_key: "safety",
        status: "blocked",
        blocked_reason: "newer_message",
      },
      {
        fixed_text_key: "safety_followup",
        status: "sent",
        blocked_reason: null,
      },
    ]);
  });

  it("settles failed, never calling, a send whose number was erased after it began", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(DANGER);
    await runAgentJob(registry);
    const { conversation_id: conversationId } = await latest();
    const erasing = beforeConfirm(registry, async () => {
      await admin.query(
        "select ops.erase_contact_identifier($1, $2, 'erasure', 'dbtest')",
        [TENANT_A, conversationId],
      );
    });
    expect(await runAgentJob(erasing)).toMatchObject({
      outcome: "succeeded",
      kind: OUTBOUND_REPLY_SEND_KIND,
    });
    expect(reply.transport.calls).toHaveLength(0);
    expect(await sends()).toMatchObject([
      { status: "failed", error_class: "contact_erased" },
    ]);
  });

  it("waits a bounded time for a conversation another call holds, puts the send back, and sends it later", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(DANGER);
    await runAgentJob(registry);
    const { conversation_id: conversationId } = await latest();
    const other = await admin.connect();
    try {
      await other.query("begin");
      await other.query(
        "select 1 from ops.conversations where id = $1 for update",
        [conversationId],
      );
      expect(await runAgentJob(registry)).toMatchObject({
        outcome: "deferred",
        kind: OUTBOUND_REPLY_SEND_KIND,
      });
    } finally {
      await other.query("rollback");
      other.release();
    }
    expect(reply.transport.calls).toHaveLength(0);
    expect(await sends()).toMatchObject([
      { status: "authorized", transport: null },
    ]);

    await releaseWaits();
    await drain(registry);
    expect(reply.transport.calls).toHaveLength(1);
    expect(await sends()).toMatchObject([{ status: "sent" }]);
  }, 30_000);

  it("holds a send whose stop was tripped after it began, never calling, and sends it once the stop is cleared", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(DANGER);
    await runAgentJob(registry);
    const { conversation_id: conversationId } = await latest();
    const other = await admin.connect();
    let job: ReturnType<typeof runAgentJob> | undefined;
    let stopId = "";
    try {
      await other.query("begin");
      await other.query(
        "select 1 from ops.conversations where id = $1 for update",
        [conversationId],
      );
      // The send begins; its last gate then waits for the conversation.
      job = runAgentJob(registry);
      await waitUntil(
        async () => (await sends()).some((row) => row.status === "sending"),
        "the send did not begin",
        3_000,
      );
      // A stop tripped now, after the send began and before its call.
      const { rows } = await admin.query<{ id: string }>(
        "select ops.trip_execution_stop('tenant', 'dbtest stop', 'dbtest', $1) as id",
        [TENANT_A],
      );
      stopId = rows[0].id;
    } finally {
      await other.query("rollback");
      other.release();
    }
    await expect(job).resolves.toMatchObject({
      outcome: "deferred",
      kind: OUTBOUND_REPLY_SEND_KIND,
    });
    expect(reply.transport.calls).toHaveLength(0);
    expect(await sends()).toMatchObject([
      { status: "authorized", transport: null },
    ]);

    await admin.query(
      "select ops.clear_execution_stop($1, 'dbtest clear', 'dbtest')",
      [stopId],
    );
    await releaseWaits();
    await drain(registry);
    expect(reply.transport.calls).toHaveLength(1);
    expect(await sends()).toMatchObject([{ status: "sent" }]);
  }, 30_000);
});

describe("the gates a policy send passes, and their order (ADR 0026 §B)", () => {
  it("withholds the safety text, unlisted, when the contact asks to stop before it leaves", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(DANGER);
    expect(await runAgentJob(registry)).toMatchObject({
      outcome: "succeeded",
      kind: "agent_run.execute",
    });
    await send(OPT_OUT);
    await drain(registry);
    await releaseWaits();
    await drain(registry);

    expect(reply.transport.calls).toHaveLength(1);
    expect(
      reply.transport.calls[0].body.startsWith(FIXED.messages.opt_out_ack),
    ).toBe(true);
    expect(keyed(await sends())).toEqual([
      {
        fixed_text_key: "safety",
        status: "blocked",
        blocked_reason: "newer_message",
      },
      { fixed_text_key: "opt_out_ack", status: "sent", blocked_reason: null },
    ]);
    expect(await sendExceptions()).toEqual([]);
  });

  it("leaves the safety text with a person when the contact's later opt-out was screened first", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(DANGER);
    await send(OPT_OUT);
    // The crisis message's screening runs after the opt-out's.
    await admin.query(
      `update ops.jobs set available_at = now() + interval '1 hour'
        where id = (select id from ops.jobs
                     where tenant_id = $1 and kind = 'agent_run.execute' and status = 'queued'
                     order by created_at, id limit 1)`,
      [TENANT_A],
    );
    await drain(registry);
    await admin.query(
      `update ops.jobs set available_at = now()
        where tenant_id = $1 and kind = 'agent_run.execute' and status = 'queued'`,
      [TENANT_A],
    );
    await drain(registry);

    expect(keyed(await sends())).toEqual([
      { fixed_text_key: "opt_out_ack", status: "sent", blocked_reason: null },
    ]);
    expect(await reviewOf(await firstTask())).toMatchObject({
      status: "pending",
      decision_basis: null,
    });
    expect(reply.transport.calls).toHaveLength(1);
  });

  it("sends the safety text to a number the CRM marks do-not-contact, and nothing else", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE, { doNotContact: true });
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(UNCLEAR);
    await drain(registry);
    // No reply can reach the contact: nothing is drafted for that message.
    expect(await latest()).toMatchObject({ disposition: "held_for_person" });
    expect(await reviewOf(await firstTask())).toBeUndefined();
    await send(DANGER);
    await drain(registry);

    expect(keyed(await sends())).toEqual([
      { fixed_text_key: "safety", status: "sent", blocked_reason: null },
    ]);
    expect(reply.transport.calls).toHaveLength(1);
  });

  it("blocks an authorized text the owner took off the list before it left, and lists it", async () => {
    const clinic = await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const { registry: idle } = runtime();
    await send(DANGER);
    await drain(idle);
    expect(await sends()).toMatchObject([{ status: "authorized" }]);

    await republishPolicy(clinic.agentId, {
      ...POLICY,
      automaticFixedTexts: ["clarification"],
    });
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await releaseWaits();
    await drain(registry);
    expect(reply.transport.calls).toHaveLength(0);
    expect(await sends()).toMatchObject([
      { status: "blocked", blocked_reason: "not_automatic" },
    ]);
    expect(await sendExceptions()).toEqual(["send_blocked"]);
  });

  it("never counts the safety texts toward the hourly cap", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY, undefined, FIXED_FOLLOWUP);
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    for (let i = 0; i < 4; i += 1) {
      await send(DANGER);
      await drain(registry);
    }
    expect(reply.transport.calls).toHaveLength(4);
    expect((await sends()).map(({ status }) => status)).toEqual([
      "sent",
      "sent",
      "sent",
      "sent",
    ]);
    const { conversation_id: conversationId } = await latest();
    expect((await holder(conversationId)).holder_reason).not.toBe(
      "automatic_cap",
    );
    expect(await sendExceptions()).toEqual([]);
  });

  it("sends only the newest of a burst of clarifications, and never counts the replaced ones toward the cap", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    // Four messages, all screened before any reply can leave.
    const { registry: idle } = runtime();
    for (let i = 0; i < 4; i += 1) await send(UNCLEAR);
    await drain(idle);

    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await releaseWaits();
    await drain(registry);
    expect(reply.transport.calls).toHaveLength(1);
    expect(
      (await sends()).map(({ status, blocked_reason }) => ({
        status,
        blocked_reason,
      })),
    ).toEqual([
      { status: "blocked", blocked_reason: "newer_message" },
      { status: "blocked", blocked_reason: "newer_message" },
      { status: "blocked", blocked_reason: "newer_message" },
      { status: "sent", blocked_reason: null },
    ]);
    const { conversation_id: conversationId } = await latest();
    expect((await holder(conversationId)).holder_reason).not.toBe(
      "automatic_cap",
    );
    expect(await sendExceptions()).toEqual([]);
  });

  it("lists for a person a text the transport refused", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const refusing = fakeTransport(() => ({
      kind: "rejected",
      errorCode: "131026",
      errorClass: "recipient_unavailable",
    }));
    const { registry } = runtime(undefined, {
      replyTransport: {
        kind: "meta",
        transport: refusing,
        templates: null,
        timeoutMs: 1_000,
      },
    });
    await send(DANGER);
    await drain(registry);
    expect(await sends()).toMatchObject([
      { status: "failed", error_class: "recipient_unavailable" },
    ]);
    expect(await sendExceptions()).toEqual(["send_failed"]);
    await drain(registry);
    expect(refusing.calls).toHaveLength(1);
  });

  it("judges the contact before a stop: an ambiguous number's safety text stays with a person", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime(undefined, { replyTransport: fake() });
    await send(DANGER);
    await drain(registry);
    const review = await reviewOf((await latest()).task_id);
    expect(review.status).toBe("pending");
    expect(await authorizeUnderStop(review.id)).toBe("supervised");
    expect(await sends()).toEqual([]);
  });

  it("judges the contact before a stop: an open opt-out refuses every text but its acknowledgement", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime(undefined, { replyTransport: fake() });
    await send(OPT_OUT);
    // The screening, then the acknowledgement; the opt-out's record in the CRM
    // (ADR 0026 §C), moved to now by the acknowledgement, is held back here.
    expect(await runAgentJob(registry)).toMatchObject({
      kind: "agent_run.execute",
    });
    expect(await runAgentJob(registry)).toMatchObject({
      kind: OUTBOUND_REPLY_SEND_KIND,
    });
    const out = await latest();
    expect(keyed(await sends())).toEqual([
      { fixed_text_key: "opt_out_ack", status: "sent", blocked_reason: null },
    ]);
    await admin.query(
      `update ops.jobs set available_at = now() + interval '1 hour'
        where tenant_id = $1 and kind = 'crm.opt_out_record' and status = 'queued'`,
      [TENANT_A],
    );
    const reasonUnderStop = async (key: string): Promise<string> => {
      const { rows } = await admin.query<{ reason: string }>(
        `select ops.reply_send_eligibility($1, jsonb_populate_record(null::ops.outbound_messages,
                  jsonb_build_object('tenant_id', $1::uuid, 'conversation_id', $2::uuid,
                                     'task_id', $3::uuid, 'fixed_text_key', $4::text))) ->> 'reason' as reason`,
        [TENANT_A, out.conversation_id, out.task_id, key],
      );
      return rows[0].reason;
    };
    const { rows } = await admin.query<{ id: string }>(
      "select ops.trip_execution_stop('tenant', 'dbtest stop', 'dbtest', $1) as id",
      [TENANT_A],
    );
    try {
      expect(await reasonUnderStop("clarification")).toBe("opt_out_open");
      expect(await reasonUnderStop("opt_out_ack")).toBe("execution_stopped");
      // Once the opt-out is recorded in the CRM, the contact gate comes first
      // for every text but a safety text, under the stop as without it.
      await admin.query(
        `update ops.jobs set available_at = now()
          where tenant_id = $1 and kind = 'crm.opt_out_record' and status = 'queued'`,
        [TENANT_A],
      );
      expect(await runAgentJob(registry)).toMatchObject({
        kind: "crm.opt_out_record",
        detail: "crm_opt_out_record=recorded",
      });
      expect(await reasonUnderStop("clarification")).toBe("do_not_contact");
      expect(await reasonUnderStop("opt_out_ack")).toBe("do_not_contact");
    } finally {
      await admin.query(
        "select ops.clear_execution_stop($1, 'dbtest clear', 'dbtest')",
        [rows[0].id],
      );
    }
  });

  it("blocks a replaced text as stale before it judges its freshness, so only the newest is listed", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const { registry: idle } = runtime();
    await send(UNCLEAR);
    await drain(idle);
    await send(UNCLEAR);
    await drain(idle);
    await expireSends();
    await releaseWaits();
    await drain(idle);
    expect(
      (await sends()).map(({ status, blocked_reason }) => ({
        status,
        blocked_reason,
      })),
    ).toEqual([
      { status: "blocked", blocked_reason: "newer_message" },
      { status: "blocked", blocked_reason: "transport_not_configured" },
    ]);
    expect(await sendExceptions()).toEqual(["send_blocked"]);
  });

  it("blocks, on the owner's sync, an out-of-date text whose job is still queued", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const { registry: idle } = runtime();
    await send(UNCLEAR);
    await drain(idle);
    await send(UNCLEAR);
    await drain(idle);
    await expireSends();
    expect(await replyJobs()).toMatchObject([
      { status: "queued" },
      { status: "queued" },
    ]);

    await admin.query("select ops.sync_tenant_send_exceptions($1)", [TENANT_A]);
    expect(
      (await sends()).map(({ status, blocked_reason }) => ({
        status,
        blocked_reason,
      })),
    ).toEqual([
      { status: "blocked", blocked_reason: "newer_message" },
      { status: "blocked", blocked_reason: "fixed_text_expired" },
    ]);
    expect(await sendExceptions()).toEqual(["send_blocked"]);

    // The jobs then settle without calling anyone.
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await releaseWaits();
    await drain(registry);
    expect(reply.transport.calls).toHaveLength(0);
    expect(await replyJobs()).toMatchObject([
      { status: "succeeded" },
      { status: "succeeded" },
    ]);
  });
});

describe("the predicate the policy decides by holds only for the review the screen drafted (ADR 0026 §B)", () => {
  it("refuses every altered copy of a review it accepts", async () => {
    const clinic = await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime();
    await send(UNCLEAR);
    await drain(registry);
    const out = await latest();
    const review = await reviewOf(out.task_id);
    expect(review).toMatchObject({ decision_basis: "published_fixed_text" });
    const { rows: listing } = await admin.query<{ id: string }>(
      `select id from ops.agent_configuration_versions
        where tenant_id = $1 and agent_id = $2 and kind = 'operating_policy'
          and content -> 'automaticFixedTexts' ? 'clarification'`,
      [TENANT_A, clinic.agentId],
    );

    const holds = async (
      change: Record<string, unknown>,
      currentPolicy: string | null = null,
    ): Promise<boolean> => {
      const { rows } = await admin.query<{ holds: boolean }>(
        `select ops.review_is_published_fixed_text(jsonb_populate_record(ri, $2::jsonb), $3) as holds
           from ops.review_items ri where ri.id = $1`,
        [review.id, JSON.stringify(change), currentPolicy],
      );
      return rows[0].holds;
    };

    expect(await holds({})).toBe(true);
    expect(await holds({}, listing[0].id)).toBe(true);
    expect(
      await holds({ proposed: { response_draft: "Outro texto fictício." } }),
    ).toBe(false);
    expect(await holds({ proposed: {} })).toBe(false);
    expect(await holds({ author: "agent" })).toBe(false);
    expect(await holds({ content_redacted_at: new Date().toISOString() })).toBe(
      false,
    );
    expect(await holds({ do_not_contact: true })).toBe(false);
    expect(await holds({ agent_run_id: OTHER_UUID })).toBe(false);
    expect(await holds({ task_id: OTHER_UUID })).toBe(false);
    expect(await holds({ tenant_id: OTHER_UUID })).toBe(false);

    // A policy published since that no longer lists the key.
    await republishPolicy(clinic.agentId, {
      ...POLICY,
      automaticFixedTexts: ["safety"],
    });
    const { rows: current } = await admin.query<{ id: string }>(
      `select id from ops.agent_configuration_versions
        where tenant_id = $1 and agent_id = $2 and kind = 'operating_policy'
          and content -> 'automaticFixedTexts' = '["safety"]'::jsonb`,
      [TENANT_A, clinic.agentId],
    );
    expect(await holds({}, current[0].id)).toBe(false);
  });
});

describe("a send its job left unsettled is closed out by the reaper (ADR 0026 §B)", () => {
  it("blocks and lists a text whose job ran out of attempts before it began", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    // A transport bound longer than the lease: every attempt refuses to begin.
    const slow = fake();
    const { registry } = runtime(undefined, {
      replyTransport: { ...slow, timeoutMs: 600_000 },
    });
    await send(DANGER);
    await runAgentJob(registry);
    await lastAttempt();
    expect(await runAgentJob(registry)).toMatchObject({
      kind: OUTBOUND_REPLY_SEND_KIND,
    });
    expect(await replyJobs()).toMatchObject([{ status: "failed" }]);
    expect(await sends()).toMatchObject([{ status: "authorized" }]);

    expect(await sweepStaleReplies()).toBe(1);
    expect(await sends()).toMatchObject([
      { status: "blocked", blocked_reason: "job_failed" },
    ]);
    expect(await sendExceptions()).toEqual(["send_blocked"]);
    expect(await sweepStaleReplies()).toBe(0);
    expect(slow.transport.calls).toHaveLength(0);
  });

  it("records indeterminate a send whose last attempt died after the call, never calling again", async () => {
    await frontDesk(KNOWLEDGE, AUTO_POLICY);
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(DANGER);
    await runAgentJob(registry);
    await lastAttempt();
    await runAgentJob(registry, {
      onCallFinished: async () => {
        throw new Error("dbtest: the worker died after the call");
      },
    });
    expect(await replyJobs()).toMatchObject([{ status: "failed" }]);
    expect(await sends()).toMatchObject([{ status: "sending" }]);

    expect(await sweepStaleReplies()).toBe(1);
    expect(await sends()).toMatchObject([
      { status: "indeterminate", error_class: "execution_interrupted" },
    ]);
    expect(await sendExceptions()).toEqual(["send_indeterminate"]);
    await drain(registry);
    expect(reply.transport.calls).toHaveLength(1);
  });
});
