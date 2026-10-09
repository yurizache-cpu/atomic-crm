// Who wrote a review, and a person's reply to the newest message (ADR 0026
// §A), end to end: signed Meta deliveries through the gateway's own login, the
// real worker runtime and the real screening, against a real Postgres. The
// model's earlier turns show the agent's own reply and the fixed
// acknowledgements verbatim and a person's reply only as the marker (W1); a
// person answers the newest message, whatever happened to it, naming the
// revision the person saw; a refused message (an image) inside that revision
// does not make the reply stale, one after it does; the protective fixed texts
// are drafted whoever holds the conversation.
//
// ALL DATA IS SYNTHETIC (BASELINE Q8). Numbers, targets and texts are invented.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { HIDDEN_TURN_MARKER } from "../frontDesk/prompt.ts";
import {
  removeFixtureModels,
  TENANT_A,
} from "../worker/testSupport/dbFixture.ts";
import { CompanyOsError } from "./errors.ts";
import {
  recordPersonReply,
  releaseConversation,
  takeOverConversation,
} from "./frontDesk.ts";
import { sendApprovedReview } from "./outboundSend.ts";
import {
  closeAgentRuntimeDatabases,
  openAgentRuntimeDatabases,
} from "./testSupport/agentRuntimeProbes.ts";
import {
  createFrontDeskHarness,
  DEAL_NAME,
  FIXED,
  FRONT_DESK_MODELS,
  reply,
} from "./testSupport/frontDeskHarness.ts";
import {
  accepted,
  addCrmContact,
  deleteCrmContacts,
  deliver,
  fakeTransport,
  gatewayDatabase,
  metaPayload,
  provisionGatewayRole,
} from "./testSupport/whatsappFixture.ts";

const TARGET = "200000000000931";
const DEVICE = "5511900000931";
const ADMINISTRATIVE = "Qual o valor da primeira sessão?";
const OPT_OUT = "Não quero mais receber mensagens.";
const PERSON_REQUEST = "Quero falar com uma pessoa, por favor.";
const DANGER = "Não quero mais viver.";
const AGENT_DRAFT = "Temos horário na terça às 19h. Posso reservar?";
const PERSON_TEXT = "Oi, aqui é da equipe: RA-PERSON-REPLY.";
const PERSON = "dbtest-person";

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

const { prepare, frontDesk, runtime, drain, send, latest, holder, revision } =
  createFrontDeskHarness(() => ({ admin, owner, db, gateway }), {
    target: TARGET,
    device: DEVICE,
    messagePrefix: "RA",
  });

beforeEach(prepare);

const act = <T>(fn: (tx: TxClient) => Promise<T>): Promise<T> =>
  owner.withTransaction(fn);

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CompanyOsError) return error.code;
    throw error;
  }
  throw new Error("the act was not refused");
};

interface ReviewRow {
  id: string;
  author: string;
  status: string;
  superseded: boolean;
}

/** The reviews of one message's task, oldest first, with the stale predicate. */
const reviewsOf = async (taskId: string): Promise<ReviewRow[]> =>
  (
    await admin.query<ReviewRow>(
      `select ri.id, ri.author, ri.status, ops.cos_review_superseded(ri.tenant_id, ri) as superseded
         from ops.review_items ri where ri.tenant_id = $1 and ri.task_id = $2
        order by ri.created_at, ri.id`,
      [TENANT_A, taskId],
    )
  ).rows;

const accept = (reviewId: string) =>
  admin.query(
    "select ops.record_review_decision($1, $2, 'accepted', $3, 'operator-cli', null)",
    [TENANT_A, reviewId, PERSON],
  );

const sendReview = (reviewId: string, providerId: string) => {
  const transport = fakeTransport(() => accepted(providerId));
  return {
    transport,
    report: sendApprovedReview(owner, transport, {
      tenantId: TENANT_A,
      reviewId,
      requestedBy: "dbtest operator",
      source: "dbtest",
    }),
  };
};

const takeOver = (conversationId: string) =>
  act((tx) =>
    takeOverConversation(tx, {
      tenantId: TENANT_A,
      conversationId,
      actor: PERSON,
    }),
  );

const personReply = (conversationId: string, expectedRevision: number) =>
  act((tx) =>
    recordPersonReply(tx, {
      tenantId: TENANT_A,
      conversationId,
      text: PERSON_TEXT,
      actor: PERSON,
      expectedRevision,
    }),
  );

const waiting = async (conversationId: string) =>
  (
    await admin.query<{ occurrences: number }>(
      `select occurrences from ops.exceptions
        where conversation_id = $1 and kind = 'message_waiting' and resolved_at is null`,
      [conversationId],
    )
  ).rows;

/** get_review's conversation block for one review, as the browser reads it. */
const page = async (reviewId: string): Promise<Record<string, unknown>> =>
  (
    await admin.query<{ conversation: Record<string, unknown> }>(
      "select ops.cos_review_conversation(ri.tenant_id, ri) as conversation from ops.review_items ri where ri.id = $1",
      [reviewId],
    )
  ).rows[0].conversation;

/** How many structured and shadow decisions the tenant has. */
const decisionCounts = async () =>
  (
    await admin.query<{ structured: string; shadow: string }>(
      `select (select count(*) from ops.structured_decisions where tenant_id = $1)::text as structured,
              (select count(*) from ops.decision_evaluations where tenant_id = $1)::text as shadow`,
      [TENANT_A],
    )
  ).rows[0];

const image = (id: string) =>
  deliver(
    gateway,
    metaPayload(TARGET, {
      messages: [{ id, from: DEVICE, body: "", kind: "image" }],
    }),
  );

describe("the model's earlier turns are keyed on who wrote each reply (ADR 0026 §A, W1)", () => {
  it("shows the model the agent's own reply and the handoff acknowledgement verbatim, and a person's reply only as the marker", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { provider, registry } = runtime(reply(AGENT_DRAFT));

    await send(ADMINISTRATIVE);
    await drain(registry);
    const first = await latest();
    const [agentReview] = await reviewsOf(first.task_id);
    expect(agentReview).toMatchObject({ author: "agent" });
    await accept(agentReview.id);
    expect(
      await sendReview(agentReview.id, "wamid.RA-OUT1").report,
    ).toMatchObject({ status: "sent" });

    await send(PERSON_REQUEST);
    await drain(registry);
    const asked = await latest();
    expect(asked).toMatchObject({ fixed_message_key: "human_handoff_ack" });
    const [ackReview] = await reviewsOf(asked.task_id);
    expect(ackReview).toMatchObject({ author: "fixed" });
    await accept(ackReview.id);
    expect(
      await sendReview(ackReview.id, "wamid.RA-OUT2").report,
    ).toMatchObject({ status: "sent" });

    // The person answers the request itself: a second review on that run,
    // with its own pending event, and nothing for Jev or the shadow layer.
    const decided = await decisionCounts();
    const recorded = await personReply(
      asked.conversation_id,
      await revision(asked.conversation_id),
    );
    const { rows: pending } = await admin.query<{ key: string }>(
      `select idempotency_key as key from ops.events
        where tenant_id = $1 and type = 'lead_triage.review_pending' and subject_id = $2
        order by seq`,
      [TENANT_A, asked.task_id],
    );
    expect(pending.map((row) => row.key)).toEqual([
      `review:${ackReview.id}:pending`,
      `review:${String(recorded.review_item_id)}:pending`,
    ]);
    expect(await decisionCounts()).toEqual(decided);
    expect(
      await sendReview(String(recorded.review_item_id), "wamid.RA-OUT3").report,
    ).toMatchObject({
      status: "sent",
    });

    await act((tx) =>
      releaseConversation(tx, {
        tenantId: TENANT_A,
        conversationId: asked.conversation_id,
        actor: PERSON,
      }),
    );
    await send("E vocês atendem online?");
    await drain(registry);
    expect(provider.calls).toHaveLength(2);
    const input = provider.calls[1].input;
    expect(input).toContain(AGENT_DRAFT);
    expect(input).toContain(FIXED.messages.human_handoff_ack);
    expect(input).toContain(HIDDEN_TURN_MARKER);
    expect(input).not.toContain("RA-PERSON-REPLY");
  });

  it("answers a message the model answered with a person's reply that never reaches the provider, and makes the agent's draft stale", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { provider, registry } = runtime(reply(AGENT_DRAFT));
    await send(ADMINISTRATIVE);
    await drain(registry);
    const out = await latest();
    expect(out).toMatchObject({
      disposition: "model",
      review_status: "pending",
    });

    await takeOver(out.conversation_id);
    const recorded = await personReply(
      out.conversation_id,
      await revision(out.conversation_id),
    );
    const reviews = await reviewsOf(out.task_id);
    expect(
      reviews.map(({ author, status, superseded }) => ({
        author,
        status,
        superseded,
      })),
    ).toEqual([
      { author: "agent", status: "pending", superseded: true },
      { author: "person", status: "accepted", superseded: false },
    ]);
    // The review page says who wrote each reply, and that a person answered
    // the agent's draft (not that the contact wrote again).
    expect(await page(reviews[0].id)).toMatchObject({
      author: "agent",
      answeredByPerson: true,
      newerMessage: false,
    });
    expect(await page(reviews[1].id)).toMatchObject({
      author: "person",
      answeredByPerson: false,
      newerMessage: false,
      replyDraft: PERSON_TEXT,
    });
    // The agent's draft for that message can no longer leave: a person answered it.
    await accept(reviews[0].id);
    const stale = sendReview(reviews[0].id, "wamid.never");
    await expect(stale.report).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("newer_message"),
    });
    expect(stale.transport.calls).toHaveLength(0);
    expect(
      await sendReview(String(recorded.review_item_id), "wamid.RA-OUT4").report,
    ).toMatchObject({
      status: "sent",
    });

    await act((tx) =>
      releaseConversation(tx, {
        tenantId: TENANT_A,
        conversationId: out.conversation_id,
        actor: PERSON,
      }),
    );
    await send("E vocês atendem online?");
    await drain(registry);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].input).toContain(HIDDEN_TURN_MARKER);
    expect(provider.calls[1].input).not.toContain("RA-PERSON-REPLY");
  });
});

describe("a person replies to the newest message, naming the revision the person saw (ADR 0026 §A)", () => {
  it("lets a person answer a request for a person after the contact sent an image, and the reply leaves", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime();
    await send(PERSON_REQUEST);
    await drain(registry);
    const asked = await latest();
    expect(await holder(asked.conversation_id)).toMatchObject({
      holder: "person",
    });

    // The image is refused on the record, and waits for the person.
    await send("", "image");
    expect(await waiting(asked.conversation_id)).toEqual([{ occurrences: 1 }]);
    expect(await revision(asked.conversation_id)).toBe(2);

    // A listing older than the image is refused; the current one answers.
    expect(await refusal(personReply(asked.conversation_id, 1))).toBe(
      "invalid_state",
    );
    const recorded = await personReply(asked.conversation_id, 2);
    expect(recorded).toMatchObject({ state: "recorded", revision: 2 });
    const sent = sendReview(String(recorded.review_item_id), "wamid.RA-OUT5");
    expect(await sent.report).toMatchObject({
      status: "sent",
      providerCalled: true,
    });
    expect(sent.transport.calls).toHaveLength(1);

    // The acknowledgement drafted for that message is stale: a person answered it.
    const reviews = await reviewsOf(asked.task_id);
    expect(
      reviews.map(({ author, superseded }) => ({ author, superseded })),
    ).toEqual([
      { author: "fixed", superseded: true },
      { author: "person", superseded: false },
    ]);
  });

  it("makes a person's reply stale once the contact writes after the revision the person saw", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime();
    await send(PERSON_REQUEST);
    await drain(registry);
    const asked = await latest();
    const recorded = await personReply(
      asked.conversation_id,
      await revision(asked.conversation_id),
    );
    await send("", "image");
    const stale = sendReview(String(recorded.review_item_id), "wamid.never");
    await expect(stale.report).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("newer_message"),
    });
    expect(stale.transport.calls).toHaveLength(0);
  });

  it("refuses a reply outside the 24-hour window, and a sixth reply until the contact writes again", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime();
    await send(PERSON_REQUEST);
    await drain(registry);
    const asked = await latest();

    await admin.query(
      "update ops.conversations set last_inbound_at = now() - interval '25 hours' where id = $1",
      [asked.conversation_id],
    );
    expect(
      await refusal(
        personReply(
          asked.conversation_id,
          await revision(asked.conversation_id),
        ),
      ),
    ).toBe("invalid_state");
    // Any message reopens the window, a refused one included.
    await send("", "image");
    const current = await revision(asked.conversation_id);
    for (let i = 0; i < 5; i += 1) {
      expect(await personReply(asked.conversation_id, current)).toMatchObject({
        state: "recorded",
      });
    }
    expect(await refusal(personReply(asked.conversation_id, current))).toBe(
      "invalid_state",
    );
    expect(
      (await reviewsOf(asked.task_id)).filter((row) => row.author === "person"),
    ).toHaveLength(5);
    // The contact sends another image: room for five more replies.
    await send("", "image");
    expect(await personReply(asked.conversation_id, current + 1)).toMatchObject(
      { state: "recorded", revision: current + 1 },
    );
  });

  it("answers the newest message while its run waits (a stop, an idle worker), and the screening then holds it", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { provider, registry } = runtime();
    await send(ADMINISTRATIVE);
    await drain(registry);
    const first = await latest();
    await takeOver(first.conversation_id);

    // A new message, not yet screened: its run is pending.
    await send("Vocês atendem aos sábados?");
    const recorded = await personReply(
      first.conversation_id,
      await revision(first.conversation_id),
    );
    expect(recorded).toMatchObject({ state: "recorded" });
    const { rows } = await admin.query<{ status: string }>(
      `select r.status from ops.review_items ri join ops.agent_runs r on r.id = ri.agent_run_id
        where ri.id = $1`,
      [recorded.review_item_id],
    );
    expect(rows).toEqual([{ status: "pending" }]);

    // Screened later, under a person: held, no model, nothing drafted.
    await drain(registry);
    expect(await latest()).toMatchObject({
      disposition: "held_for_person",
      review_status: null,
    });
    expect(provider.calls).toHaveLength(1);
  });
});

describe("the protective texts are drafted whoever holds the conversation (ADR 0026 §A)", () => {
  it("drafts the opt-out acknowledgement in a conversation a person holds; the message still waits, and the release waits for a person", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { provider, registry } = runtime();
    await send(ADMINISTRATIVE);
    await drain(registry);
    const first = await latest();
    await takeOver(first.conversation_id);

    await send(OPT_OUT);
    await drain(registry);
    const out = await latest();
    expect(out).toMatchObject({
      disposition: "fixed_reply",
      fixed_message_key: "opt_out_ack",
      error_code: "front_desk_fixed_reply",
      review_status: "pending",
    });
    expect(out.proposed).toMatchObject({
      response_draft: FIXED.messages.opt_out_ack,
      recommended_next_action:
        "Send the acknowledgement, then record the opt-out in the CRM.",
    });
    expect(await holder(first.conversation_id)).toMatchObject({
      holder: "person",
      holder_reason: "operator",
    });
    const { rows } = await admin.query<{ kind: string }>(
      `select kind from ops.exceptions where conversation_id = $1 and resolved_at is null order by kind`,
      [first.conversation_id],
    );
    expect(rows.map((row) => row.kind)).toEqual(["message_waiting", "opt_out"]);
    expect(
      await refusal(
        act((tx) =>
          releaseConversation(tx, {
            tenantId: TENANT_A,
            conversationId: first.conversation_id,
            actor: PERSON,
          }),
        ),
      ),
    ).toBe("invalid_state");
    expect(provider.calls).toHaveLength(1);
  });

  it("still sends the safety text after a person replied to the crisis message; only the contact's next message makes it stale", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime();
    await send(ADMINISTRATIVE);
    await drain(registry);
    const first = await latest();
    await takeOver(first.conversation_id);

    await send(DANGER);
    await drain(registry);
    const crisis = await latest();
    expect(crisis).toMatchObject({
      fixed_message_key: "safety",
      review_status: "pending",
    });
    await personReply(
      crisis.conversation_id,
      await revision(crisis.conversation_id),
    );
    const [safety, person] = await reviewsOf(crisis.task_id);
    expect([safety.author, person.author]).toEqual(["fixed", "person"]);
    expect(safety.superseded).toBe(false);
    expect(await page(safety.id)).toMatchObject({
      answeredByPerson: false,
      newerMessage: false,
    });
    await accept(safety.id);
    const sent = sendReview(safety.id, "wamid.RA-SAFETY");
    expect(await sent.report).toMatchObject({ status: "sent" });
    expect(sent.transport.calls).toHaveLength(1);

    // A second crisis message: its safety text is stale once the contact
    // writes again, as any reply is.
    await send(DANGER);
    await drain(registry);
    const again = await latest();
    await send("", "image");
    const [stale] = await reviewsOf(again.task_id);
    expect(stale).toMatchObject({ author: "fixed", superseded: true });
  });

  it("counts a refused message for the person who holds the conversation, once per message, and none while the agent holds it", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime();
    await send(ADMINISTRATIVE);
    await drain(registry);
    const first = await latest();

    await send("", "image");
    expect(await waiting(first.conversation_id)).toEqual([]);

    await takeOver(first.conversation_id);
    expect((await image("wamid.RA-IMAGE")).status).toBe(200);
    // Meta redelivers the same message: it is answered with its refusal, and
    // counted once.
    expect((await image("wamid.RA-IMAGE")).status).toBe(200);
    expect(await waiting(first.conversation_id)).toEqual([{ occurrences: 1 }]);
    expect((await image("wamid.RA-IMAGE-2")).status).toBe(200);
    expect(await waiting(first.conversation_id)).toEqual([{ occurrences: 2 }]);

    // Two deliveries of one message at once: one refusal, one count.
    const answers = await Promise.all([
      image("wamid.RA-IMAGE-3"),
      image("wamid.RA-IMAGE-3"),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(await waiting(first.conversation_id)).toEqual([{ occurrences: 3 }]);
    expect(await revision(first.conversation_id)).toBe(5);
  });
});
