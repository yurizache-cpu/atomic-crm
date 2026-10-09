// The owner's notification (ADR 0026 §D), end to end: signed Meta deliveries
// through the gateway's own login, the real worker runtime, the real screening
// and the worker's notification job, against a real Postgres. A request for a
// person tells the owner once, as an approved template naming the contact's
// first word and the time; a message waiting for a person tells the owner once
// per gap between the person's replies; due notifications of several
// conversations leave as one digest; a release or a reply sets one aside; a
// stop holds the job; quiet hours, the caps and a worker without a transport
// make it wait, never drop it; a crisis never tells the owner; the owner's own
// number writing in is refused before any conversation is written; an
// uncertain send is never repeated and is settled by its correlation; nothing
// stores, logs or events the owner's number or a name.
//
// ALL DATA IS SYNTHETIC (BASELINE Q8). Numbers, targets and texts are invented.

import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import {
  createFakeOutboundTransport,
  type ReplyTransport,
} from "../communication/replyTransport.ts";
import type {
  OutboundOutcome,
  OutboundTemplateRequest,
} from "../communication/types.ts";
import {
  removeFixtureModels,
  TENANT_A,
} from "../worker/testSupport/dbFixture.ts";
import { recordPersonReply, releaseConversation } from "./frontDesk.ts";
import {
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  openAgentRuntimeDatabases,
} from "./testSupport/agentRuntimeProbes.ts";
import {
  createFrontDeskHarness,
  DEAL_NAME,
  FRONT_DESK_MODELS,
} from "./testSupport/frontDeskHarness.ts";
import {
  addCrmContact,
  deleteCrmContacts,
  deliver,
  gatewayDatabase,
  metaPayload,
  provisionGatewayRole,
} from "./testSupport/whatsappFixture.ts";

const TARGET = "200000000000944";
const DEVICE = "5511900000944";
const SECOND_DEVICE = "5511900000945";
/** The owner's own number: no conversation and no CRM contact holds it. */
const OWNER = "5511900000946";
const PERSON = "dbtest-person";
const PERSON_REQUEST = "Quero falar com uma pessoa, por favor.";
const FOLLOW_UP = "Qual o valor da primeira sessão?";
const CRISIS_AND_PERSON =
  "Não quero mais viver. Quero falar com uma pessoa, por favor.";

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

const { prepare, frontDesk, runtime, drain, send, latest, revision } =
  createFrontDeskHarness(() => ({ admin, owner, db, gateway }), {
    target: TARGET,
    device: DEVICE,
    messagePrefix: "ON",
  });

beforeEach(prepare);

const { runAgentJob } = agentRuntimeProbes(() => ({ admin, owner, db }));

type FakeTemplates = ReturnType<typeof createFakeOutboundTransport>;

const fake = (): ReplyTransport & {
  readonly transport: FakeTemplates;
  readonly templates: FakeTemplates;
} => {
  const transport = createFakeOutboundTransport();
  return { kind: "fake", transport, templates: transport, timeoutMs: 1_000 };
};

/** A Meta transport whose template sends answer from a script. */
const scripted = (
  answer: () => OutboundOutcome,
): ReplyTransport & { readonly sent: OutboundTemplateRequest[] } => {
  const sent: OutboundTemplateRequest[] = [];
  return {
    kind: "meta",
    transport: createFakeOutboundTransport(),
    templates: {
      provider: "meta_whatsapp",
      async sendTemplate(request) {
        sent.push(request);
        return answer();
      },
    },
    timeoutMs: 1_000,
    sent,
  };
};

const act = <T>(fn: (tx: TxClient) => Promise<T>): Promise<T> =>
  owner.withTransaction(fn);

/** A quiet window that does not hold now, in São Paulo. */
const AWAKE = `(now() at time zone 'America/Sao_Paulo')::time + interval '2 hours'`;
const AWAKE_END = `(now() at time zone 'America/Sao_Paulo')::time + interval '3 hours'`;
/** A quiet window that holds now. */
const ASLEEP = `(now() at time zone 'America/Sao_Paulo')::time - interval '1 hour'`;
const ASLEEP_END = `(now() at time zone 'America/Sao_Paulo')::time + interval '1 hour'`;

/** The owner's act, as `front-desk notify-target record` makes it. */
const recordTarget = async (
  channelId: string,
  options: {
    readonly asleep?: boolean;
    readonly hourlyCap?: number;
    readonly digits?: string;
  } = {},
): Promise<string> => {
  const start = options.asleep ? ASLEEP : AWAKE;
  const end = options.asleep ? ASLEEP_END : AWAKE_END;
  const { rows } = await admin.query<{ id: string }>(
    `select ops.record_owner_notification_target(
       $1, $2, $3, 'aviso_fila_conversa', 'aviso_fila_resumo', 'dbtest-owner', 'pt_BR',
       array['person_requested', 'message_waiting'], (${start})::time, (${end})::time,
       'America/Sao_Paulo', $4, 30, 'Contato') as id`,
    [TENANT_A, channelId, options.digits ?? OWNER, options.hourlyCap ?? 10],
  );
  return rows[0].id;
};

interface NotificationRow {
  id: string;
  conversation_id: string;
  kind: string;
  status: string;
  block_reason: string | null;
  carried_by: string | null;
  template_kind: string | null;
  transport: string | null;
  follows_review_id: string | null;
  provider_message_key: string | null;
  error_class: string | null;
  job_id: string;
}

const notifications = async (): Promise<NotificationRow[]> =>
  (
    await admin.query<NotificationRow>(
      `select id, conversation_id, kind, status, block_reason, carried_by, template_kind, transport,
              follows_review_id, provider_message_key, error_class, job_id
         from ops.owner_notifications where tenant_id = $1 order by recorded_at, id`,
      [TENANT_A],
    )
  ).rows;

/** Makes every queued notification job available now (and its intent due). */
const dueNow = async (): Promise<void> => {
  await admin.query(
    "alter table ops.owner_notifications disable trigger owner_notifications_guard",
  );
  try {
    await admin.query(
      `update ops.owner_notifications
          set due_at = now() - interval '1 second', recorded_at = recorded_at - interval '61 seconds'
        where tenant_id = $1 and status = 'pending'`,
      [TENANT_A],
    );
  } finally {
    await admin.query(
      "alter table ops.owner_notifications enable always trigger owner_notifications_guard",
    );
  }
  await admin.query(
    `update ops.jobs set available_at = now()
      where tenant_id = $1 and kind = 'owner_notification.send' and status = 'queued'`,
    [TENANT_A],
  );
};

const notificationJobs = async () =>
  (
    await admin.query<{
      status: string;
      available_at: Date;
      attempts: number;
    }>(
      `select status, available_at, attempts from ops.jobs
        where tenant_id = $1 and kind = 'owner_notification.send' order by created_at, id`,
      [TENANT_A],
    )
  ).rows;

/** A signed delivery from another registered device of the test line. */
let sequence = 0;
const sendFrom = async (from: string, body: string): Promise<void> => {
  sequence += 1;
  const answer = await deliver(
    gateway,
    metaPayload(TARGET, {
      messages: [{ id: `wamid.ONX${sequence}`, from, body }],
    }),
  );
  expect(answer.status).toBe(200);
};

/** Every place a number or a name could be kept, as text. */
const storedText = async (): Promise<string> => {
  const { rows } = await admin.query<{ text: string }>(
    `select coalesce((select string_agg(to_jsonb(n)::text, ' ') from ops.owner_notifications n where n.tenant_id = $1), '')
         || coalesce((select string_agg(e.payload::text, ' ') from ops.events e where e.tenant_id = $1), '')
         || coalesce((select string_agg(j.payload::text || coalesce(j.last_error, ''), ' ') from ops.jobs j where j.tenant_id = $1), '')
         || coalesce((select string_agg(coalesce(je.detail, ''), ' ') from ops.job_events je where je.tenant_id = $1), '')
         as text`,
    [TENANT_A],
  );
  return rows[0].text;
};

const waitingSince = async (conversationId: string): Promise<string> =>
  (
    await admin.query<{ at: string }>(
      `select to_char(min(waiting_since) at time zone 'America/Sao_Paulo', 'HH24:MI') as at
         from ops.owner_notifications where conversation_id = $1`,
      [conversationId],
    )
  ).rows[0].at;

const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

describe("a request for a person tells the owner once (ADR 0026 §D)", () => {
  it("sends the episode template to the owner's number with the contact's first word and the time, and keeps neither", async () => {
    const clinic = await frontDesk();
    await addCrmContact(admin, DEVICE);
    await recordTarget(clinic.channelId);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });

    await send(PERSON_REQUEST);
    await drain(registry);
    const out = await latest();
    const [intent] = await notifications();
    expect(intent).toMatchObject({
      conversation_id: out.conversation_id,
      kind: "person_requested",
      status: "pending",
      follows_review_id: null,
    });
    // The debounce: nothing leaves for a minute.
    const [job] = await notificationJobs();
    expect(job.status).toBe("queued");
    expect(job.available_at.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(reply.templates.templateCalls).toHaveLength(0);

    // The contact keeps writing: the owner was already told.
    await send(FOLLOW_UP);
    await drain(registry);
    expect(await notifications()).toHaveLength(1);

    await dueNow();
    await drain(registry);
    expect(reply.templates.templateCalls).toEqual([
      {
        providerTarget: TARGET,
        to: OWNER,
        templateName: "aviso_fila_conversa",
        languageCode: "pt_BR",
        bodyParameters: ["dbtestwa", await waitingSince(out.conversation_id)],
        correlation: `owner-notification:${intent.id}`,
      },
    ]);
    const [sent] = await notifications();
    expect(sent).toMatchObject({
      status: "sent",
      template_kind: "episode",
      transport: "fake",
      provider_message_key: sha256(`fake.owner-notification:${intent.id}`),
    });
    // No reply went to the contact, and nothing kept the number or the name.
    expect(reply.transport.calls).toHaveLength(0);
    const kept = await storedText();
    expect(kept).not.toContain(OWNER);
    expect(kept).not.toContain(OWNER.slice(4));
    expect(kept).not.toContain("dbtestwa");
    const { rows: events } = await admin.query<{ type: string }>(
      "select type from ops.events where tenant_id = $1 and type like '%notification%'",
      [TENANT_A],
    );
    expect(events).toEqual([]);
  });

  it("tells the owner again only after a person replied, once per gap", async () => {
    const clinic = await frontDesk();
    await addCrmContact(admin, DEVICE);
    await recordTarget(clinic.channelId);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });

    await send(PERSON_REQUEST);
    await drain(registry);
    const out = await latest();
    await dueNow();
    await drain(registry);
    expect(reply.templates.templateCalls).toHaveLength(1);

    const seen = await revision(out.conversation_id);
    await act((tx) =>
      recordPersonReply(tx, {
        tenantId: TENANT_A,
        conversationId: out.conversation_id,
        text: "Olá! Já vou te atender.",
        actor: PERSON,
        expectedRevision: seen,
      }),
    );

    await send(FOLLOW_UP);
    await drain(registry);
    await send("Mais uma pergunta, por favor.");
    await drain(registry);
    const rows = await notifications();
    expect(rows.map(({ kind, status }) => ({ kind, status }))).toEqual([
      { kind: "person_requested", status: "sent" },
      { kind: "message_waiting", status: "pending" },
    ]);
    expect(rows[1].follows_review_id).not.toBeNull();

    await dueNow();
    await drain(registry);
    expect(reply.templates.templateCalls).toHaveLength(2);
  });

  it("carries every due notification of the target in one digest naming how many conversations wait", async () => {
    const clinic = await frontDesk();
    await addCrmContact(admin, DEVICE);
    await addCrmContact(admin, SECOND_DEVICE);
    await admin.query("select ops.register_test_sender($1, $2, $3, 'dbtest')", [
      TENANT_A,
      clinic.channelId,
      SECOND_DEVICE,
    ]);
    await recordTarget(clinic.channelId);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });

    await send(PERSON_REQUEST);
    await sendFrom(SECOND_DEVICE, PERSON_REQUEST);
    await drain(registry);
    expect(await notifications()).toHaveLength(2);

    await dueNow();
    await drain(registry);
    expect(reply.templates.templateCalls).toHaveLength(1);
    expect(reply.templates.templateCalls[0]).toMatchObject({
      templateName: "aviso_fila_resumo",
      bodyParameters: ["2"],
    });
    const [carrier, carried] = await notifications();
    expect(carrier).toMatchObject({ status: "sent", template_kind: "digest" });
    expect(carried).toMatchObject({
      status: "coalesced",
      carried_by: carrier.id,
    });
    // The carried notification's own job settles without a call.
    expect((await notificationJobs()).map((j) => j.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
  });
});

describe("a notification leaves only while it still tells the owner something", () => {
  it("sets aside a request a person released before it was due, calling no one", async () => {
    const clinic = await frontDesk();
    await addCrmContact(admin, DEVICE);
    await recordTarget(clinic.channelId);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(PERSON_REQUEST);
    await drain(registry);
    const out = await latest();
    await act((tx) =>
      releaseConversation(tx, {
        tenantId: TENANT_A,
        conversationId: out.conversation_id,
        actor: PERSON,
      }),
    );
    await dueNow();
    await drain(registry);
    expect((await notifications())[0].status).toBe("skipped_resolved");
    expect(reply.templates.templateCalls).toHaveLength(0);
  });

  it("never tells the owner about a crisis message, even one asking for a person", async () => {
    const clinic = await frontDesk();
    await addCrmContact(admin, DEVICE);
    await recordTarget(clinic.channelId);
    const { registry } = runtime(undefined, { replyTransport: fake() });
    await send(CRISIS_AND_PERSON);
    await drain(registry);
    expect(await notifications()).toEqual([]);
  });

  it("records nothing without a target, and nothing once the owner retired it", async () => {
    const clinic = await frontDesk();
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(PERSON_REQUEST);
    await drain(registry);
    expect(await notifications()).toEqual([]);

    await recordTarget(clinic.channelId);
    await admin.query(
      "select ops.retire_owner_notification_target($1, 'dbtest retire', 'dbtest-owner')",
      [TENANT_A],
    );
    await send(FOLLOW_UP);
    await drain(registry);
    expect(await notifications()).toEqual([]);
  });

  it("blocks a notification whose target was replaced before it left", async () => {
    const clinic = await frontDesk();
    await addCrmContact(admin, DEVICE);
    await recordTarget(clinic.channelId);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(PERSON_REQUEST);
    await drain(registry);
    await recordTarget(clinic.channelId, { digits: "5511900000947" });
    await dueNow();
    await drain(registry);
    expect((await notifications())[0]).toMatchObject({
      status: "blocked",
      block_reason: "target_changed",
    });
    expect(reply.templates.templateCalls).toHaveLength(0);
  });
});

describe("a notification waits, and is never dropped, while it cannot leave", () => {
  it("is held by a stop of the channel's unit and leaves once the stop is cleared", async () => {
    const clinic = await frontDesk();
    await addCrmContact(admin, DEVICE);
    await recordTarget(clinic.channelId);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(PERSON_REQUEST);
    await drain(registry);
    const { rows } = await admin.query<{ id: string }>(
      "select ops.trip_execution_stop('agent', 'dbtest stop', 'dbtest', $1, $2, null, $3) as id",
      [TENANT_A, clinic.companyId, clinic.agentId],
    );
    try {
      await dueNow();
      expect((await runAgentJob(registry)).outcome).not.toBe("succeeded");
      expect((await notifications())[0].status).toBe("pending");
      expect(reply.templates.templateCalls).toHaveLength(0);
    } finally {
      await admin.query(
        "select ops.clear_execution_stop($1, 'dbtest clear', 'dbtest')",
        [rows[0].id],
      );
    }
    await dueNow();
    await drain(registry);
    expect((await notifications())[0].status).toBe("sent");
    expect(reply.templates.templateCalls).toHaveLength(1);
  });

  it("waits for the end of the quiet hours", async () => {
    const clinic = await frontDesk();
    await addCrmContact(admin, DEVICE);
    await recordTarget(clinic.channelId, { asleep: true });
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(PERSON_REQUEST);
    await drain(registry);
    await dueNow();
    await drain(registry);
    expect((await notifications())[0].status).toBe("pending");
    const [job] = await notificationJobs();
    expect(job.status).toBe("queued");
    // Released until the window's end, an hour from now, the attempt given back.
    expect(job.available_at.getTime()).toBeGreaterThan(
      Date.now() + 50 * 60_000,
    );
    expect(job.attempts).toBe(0);
    expect(reply.templates.templateCalls).toHaveLength(0);
  });

  it("waits past the hourly cap instead of sending", async () => {
    const clinic = await frontDesk();
    await addCrmContact(admin, DEVICE);
    await addCrmContact(admin, SECOND_DEVICE);
    await admin.query("select ops.register_test_sender($1, $2, $3, 'dbtest')", [
      TENANT_A,
      clinic.channelId,
      SECOND_DEVICE,
    ]);
    await recordTarget(clinic.channelId, { hourlyCap: 1 });
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(PERSON_REQUEST);
    await drain(registry);
    await dueNow();
    await drain(registry);
    expect(reply.templates.templateCalls).toHaveLength(1);

    await sendFrom(SECOND_DEVICE, PERSON_REQUEST);
    await drain(registry);
    await dueNow();
    await drain(registry);
    expect(reply.templates.templateCalls).toHaveLength(1);
    expect((await notifications()).map((n) => n.status)).toEqual([
      "sent",
      "pending",
    ]);
    const jobs = await notificationJobs();
    expect(jobs[1].status).toBe("queued");
    expect(jobs[1].available_at.getTime()).toBeGreaterThan(
      Date.now() + 50 * 60_000,
    );
  });

  it("waits for a worker with a transport, and expires after a day", async () => {
    const clinic = await frontDesk();
    await addCrmContact(admin, DEVICE);
    await recordTarget(clinic.channelId);
    const { registry } = runtime();
    await send(PERSON_REQUEST);
    await drain(registry);
    await dueNow();
    await drain(registry);
    expect((await notifications())[0].status).toBe("pending");
    expect((await notificationJobs())[0].status).toBe("queued");

    await admin.query(
      "alter table ops.owner_notifications disable trigger owner_notifications_guard",
    );
    try {
      await admin.query(
        "update ops.owner_notifications set expires_at = now() - interval '1 second' where tenant_id = $1",
        [TENANT_A],
      );
    } finally {
      await admin.query(
        "alter table ops.owner_notifications enable always trigger owner_notifications_guard",
      );
    }
    await dueNow();
    await drain(registry);
    expect((await notifications())[0].status).toBe("expired");
  });
});

describe("a notification is sent at most once", () => {
  it("never repeats an uncertain send, and settles it by its correlation and the owner's number", async () => {
    const clinic = await frontDesk();
    await addCrmContact(admin, DEVICE);
    await recordTarget(clinic.channelId);
    const uncertain = scripted(() => ({
      kind: "ambiguous",
      errorClass: "timeout",
    }));
    const { registry } = runtime(undefined, { replyTransport: uncertain });
    await send(PERSON_REQUEST);
    await drain(registry);
    await dueNow();
    await drain(registry);
    await dueNow();
    await drain(registry);
    expect(uncertain.sent).toHaveLength(1);
    const [note] = await notifications();
    expect(note).toMatchObject({
      status: "indeterminate",
      provider_message_key: null,
    });

    // A status for another recipient is not this notification's.
    const status = (recipient: string) =>
      deliver(
        gateway,
        metaPayload(TARGET, {
          statuses: [
            {
              id: "wamid.ONSTATUS1",
              status: "delivered",
              recipient,
              correlation: `owner-notification:${note.id}`,
            },
          ],
        }),
      );
    expect((await status(DEVICE)).status).toBe(200);
    expect((await notifications())[0].status).toBe("indeterminate");
    expect((await status(OWNER)).status).toBe(200);
    expect((await notifications())[0]).toMatchObject({
      status: "delivered",
      provider_message_key: sha256("wamid.ONSTATUS1"),
    });
    // No exception and no event: a notification's outcome tells no one.
    const { rows } = await admin.query<{ kind: string }>(
      "select kind from ops.exceptions where tenant_id = $1 and kind like 'send_%'",
      [TENANT_A],
    );
    expect(rows).toEqual([]);
  });

  it("fails what a refused send carried, so a later message may tell the owner", async () => {
    const clinic = await frontDesk();
    await addCrmContact(admin, DEVICE);
    await addCrmContact(admin, SECOND_DEVICE);
    await admin.query("select ops.register_test_sender($1, $2, $3, 'dbtest')", [
      TENANT_A,
      clinic.channelId,
      SECOND_DEVICE,
    ]);
    await recordTarget(clinic.channelId);
    const refusing = scripted(() => ({
      kind: "rejected",
      errorCode: "132001",
      errorClass: "provider_rejected",
    }));
    const { registry } = runtime(undefined, { replyTransport: refusing });
    await send(PERSON_REQUEST);
    await sendFrom(SECOND_DEVICE, PERSON_REQUEST);
    await drain(registry);
    await dueNow();
    await drain(registry);
    expect(refusing.sent).toHaveLength(1);
    expect((await notifications()).map((n) => n.status)).toEqual([
      "failed",
      "carrier_failed",
    ]);

    // The gap is free again: the next waiting message records a new one.
    await send(FOLLOW_UP);
    await drain(registry);
    expect((await notifications()).map((n) => n.status)).toEqual([
      "failed",
      "carrier_failed",
      "pending",
    ]);
  });

  it("settles a notification whose job ended without settling it, never calling", async () => {
    const clinic = await frontDesk();
    await addCrmContact(admin, DEVICE);
    await recordTarget(clinic.channelId);
    const { registry } = runtime();
    await send(PERSON_REQUEST);
    await drain(registry);
    await admin.query(
      `update ops.jobs set status = 'failed', last_error = 'dbtest'
        where tenant_id = $1 and kind = 'owner_notification.send'`,
      [TENANT_A],
    );
    const settled = await db.withTransaction(async (tx) => {
      await tx.query("set local role ops_worker");
      const { rows } = await tx.query<{ n: number }>(
        "select ops.settle_stale_owner_notifications() as n",
      );
      return Number(rows[0].n);
    });
    expect(settled).toBe(1);
    expect((await notifications())[0]).toMatchObject({
      status: "blocked",
      block_reason: "job_failed",
    });
  });
});

describe("the owner's own number is never a lead", () => {
  it("refuses the owner's number at admission before any conversation is written", async () => {
    const clinic = await frontDesk();
    await recordTarget(clinic.channelId);
    await sendFrom(OWNER, "Oi, sou eu.");
    const { rows } = await admin.query<{ n: number }>(
      "select count(*)::int as n from ops.conversations where tenant_id = $1",
      [TENANT_A],
    );
    expect(rows[0].n).toBe(0);
    const { rows: refused } = await admin.query<{ payload: unknown }>(
      "select payload from ops.events where tenant_id = $1 and type = 'communication.inbound_refused'",
      [TENANT_A],
    );
    expect(refused).toEqual([
      { payload: { channel_id: clinic.channelId, reason: "owner_number" } },
    ]);
  });

  it("refuses to record a number a conversation or a CRM contact holds", async () => {
    const clinic = await frontDesk();
    await addCrmContact(admin, "5511900000948");
    const refusal = (digits: string) =>
      recordTarget(clinic.channelId, { digits }).then(
        () => "recorded",
        (error: { code?: string; message?: string }) =>
          `${error.code}: ${error.message}`,
      );
    expect(await refusal("5511900000948")).toMatch(/^OS409: .*CRM contact/);
    // The owner's own registered device stays a test sender, and may be the target.
    expect(await refusal(DEVICE)).toBe("recorded");
  });
});
