// A contact who asked to stop and writes again takes messages back (ADR 0026
// §C, owner decision 9), end to end: signed Meta deliveries through the
// gateway's own login, the real worker runtime, the real screening, the record
// job and the lift, against a real Postgres. The contact's own later message
// that is not itself an opt-out clears the contact's own system-recorded
// opt-out, as the CRM holds it when the message is screened, and the
// conversation the opt-out handed to a person goes back to the agent; a
// message from before the opt-out never lifts it; a flag a person set is never
// lifted by a message, even once the contact also opted out by message (the
// contact's own opt-out is recorded as lifted and the person's flag stays); a
// conversation a person took over, or held for another reason, stays with the
// person; a crisis message is never held by a lift that cannot take the
// profile's lock, and any other message waits for it.
//
// ALL DATA IS SYNTHETIC (BASELINE Q8). Numbers, targets and texts are invented.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import {
  createFakeOutboundTransport,
  type ReplyTransport,
} from "../communication/replyTransport.ts";
import {
  removeFixtureModels,
  TENANT_A,
} from "../worker/testSupport/dbFixture.ts";
import {
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  openAgentRuntimeDatabases,
} from "./testSupport/agentRuntimeProbes.ts";
import { takeOverConversation } from "./frontDesk.ts";
import {
  createFrontDeskHarness,
  DEAL_NAME,
  FIXED,
  FRONT_DESK_MODELS,
  KNOWLEDGE,
  POLICY,
} from "./testSupport/frontDeskHarness.ts";
import {
  addCrmContact,
  deleteCrmContacts,
  gatewayDatabase,
  provisionGatewayRole,
} from "./testSupport/whatsappFixture.ts";

const TARGET = "200000000000936";
const DEVICE = "5511900000936";
const OPT_OUT = "Não quero mais receber mensagens.";
const ADMINISTRATIVE = "Qual o valor da primeira sessão?";
const DANGER = "Não quero mais viver.";
const AUTO_ACK = { ...POLICY, automaticFixedTexts: ["opt_out_ack"] };

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
    messagePrefix: "OL",
  });

beforeEach(async () => {
  await deleteCrmContacts(admin);
  await prepare();
});

const { runAgentJob } = agentRuntimeProbes(() => ({ admin, owner, db }));

const fake = (): ReplyTransport & {
  readonly transport: ReturnType<typeof createFakeOutboundTransport>;
} => {
  const transport = createFakeOutboundTransport();
  return { kind: "fake", transport, templates: transport, timeoutMs: 1_000 };
};

/** The CRM contact the device's number resolves to, and its flag. */
const contactFlag = async (): Promise<
  { id: string; flag: boolean } | undefined
> =>
  (
    await admin.query<{ id: string; flag: boolean }>(
      `select c.id::text as id, lp.do_not_contact as flag
         from public.contacts c
         join public.lead_profiles lp on lp.contact_id = c.id,
              jsonb_array_elements(c.phone_jsonb) e
        where regexp_replace(e ->> 'number', '[^0-9]', '', 'g') = $1`,
      [DEVICE],
    )
  ).rows[0];

/** The contact's newest consent ledger entry. */
const lastEntry = async (contactId: string) =>
  (
    await admin.query<{
      from_value: boolean | null;
      to_value: boolean;
      origin: string;
      reason_ref: string | null;
    }>(
      `select from_value, to_value, origin, reason_ref from public.lead_consent_changes
        where contact_id = $1::bigint order by changed_at desc, id desc limit 1`,
      [contactId],
    )
  ).rows[0];

const acts = async () =>
  (
    await admin.query<{ act: string }>(
      "select act from ops.crm_contact_acts where tenant_id = $1 order by recorded_at, id",
      [TENANT_A],
    )
  ).rows.map((row) => row.act);

const liftEvents = async (): Promise<number> =>
  Number(
    (
      await admin.query<{ n: string }>(
        "select count(*)::text as n from ops.events where tenant_id = $1 and type = 'lead.opt_out_lifted'",
        [TENANT_A],
      )
    ).rows[0].n,
  );

/** Holds every queued agent run, or releases them. */
const holdRuns = (held: boolean) =>
  admin.query(
    `update ops.jobs set available_at = now() + case when $2 then interval '1 hour' else interval '0' end
      where tenant_id = $1 and kind = 'agent_run.execute' and status = 'queued'`,
    [TENANT_A, held],
  );

/** Makes the queued record job due now. */
const recordDue = () =>
  admin.query(
    `update ops.jobs set available_at = now()
      where tenant_id = $1 and kind = 'crm.opt_out_record' and status = 'queued'`,
    [TENANT_A],
  );

/** The opt-out sent and recorded by the system, with its acknowledgement left automatically. */
const optedOut = async (registry: ReturnType<typeof runtime>["registry"]) => {
  await send(OPT_OUT);
  await drain(registry);
  // An automatic acknowledgement leaves the record at the window's end.
  await recordDue();
  await drain(registry);
  const contact = await contactFlag();
  expect(contact?.flag).toBe(true);
  expect(await lastEntry(contact!.id)).toMatchObject({
    origin: "system_opt_out",
  });
  const optOut = await latest();
  expect(await holder(optOut.conversation_id)).toMatchObject({
    holder: "person",
    holder_reason: "opt_out",
  });
  return { contactId: contact!.id, conversationId: optOut.conversation_id };
};

/** Holds the contact's lead profile from another connection while `body` runs. */
const withProfileLocked = async (
  contactId: string,
  body: () => Promise<void>,
): Promise<void> => {
  const client = await admin.connect();
  try {
    await client.query("begin");
    await client.query(
      "select 1 from public.lead_profiles where contact_id = $1::bigint for update",
      [contactId],
    );
    await body();
  } finally {
    await client.query("rollback");
    client.release();
  }
};

describe("a contact who asked to stop and writes again takes messages back (ADR 0026 §C)", () => {
  it("lifts the contact's own opt-out on a later message, gives the conversation back and lets the agent answer", async () => {
    await frontDesk(KNOWLEDGE, AUTO_ACK);
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime(undefined, { replyTransport: fake() });
    const { contactId, conversationId } = await optedOut(registry);

    await send(ADMINISTRATIVE);
    await drain(registry);
    const after = await latest();
    expect(after).toMatchObject({
      disposition: "model",
      review_status: "pending",
    });
    expect((await contactFlag())?.flag).toBe(false);
    expect(await lastEntry(contactId)).toEqual({
      from_value: true,
      to_value: false,
      origin: "system_lift",
      reason_ref: `task:${after.task_id}`,
    });
    expect(await holder(conversationId)).toMatchObject({
      holder: "agent",
      holder_reason: null,
    });
    const { rows } = await admin.query<{ do_not_contact: boolean }>(
      "select do_not_contact from ops.review_items where tenant_id = $1 and task_id = $2 and author = 'agent'",
      [TENANT_A, after.task_id],
    );
    expect(rows).toEqual([{ do_not_contact: false }]);
    expect(await acts()).toEqual(["opted_out", "opt_out_lifted"]);
    expect(await liftEvents()).toBe(1);
    const open = await admin.query(
      `select 1 from ops.exceptions where tenant_id = $1 and resolved_at is null
          and kind in ('do_not_contact', 'opt_out', 'message_waiting')`,
      [TENANT_A],
    );
    expect(open.rows).toEqual([]);
  });

  it("lifts it for a message admitted before the record and screened after it", async () => {
    await frontDesk(KNOWLEDGE, POLICY);
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime(undefined, { replyTransport: fake() });
    await send(OPT_OUT);
    await drain(registry);
    expect((await contactFlag())?.flag).toBe(false);

    // The next message is admitted while the CRM has no opt-out yet; the
    // opt-out is recorded before the message is screened.
    await send(ADMINISTRATIVE);
    await holdRuns(true);
    await recordDue();
    expect(await runAgentJob(registry)).toMatchObject({
      kind: "crm.opt_out_record",
      detail: "crm_opt_out_record=recorded",
    });
    expect((await contactFlag())?.flag).toBe(true);
    await holdRuns(false);
    await drain(registry);

    const after = await latest();
    expect(after).toMatchObject({ disposition: "model" });
    expect((await contactFlag())?.flag).toBe(false);
    expect(await holder(after.conversation_id)).toMatchObject({
      holder: "agent",
    });
    expect(await acts()).toEqual(["opted_out", "opt_out_lifted"]);
  });

  it("never lifts it for a message from before the opt-out, screened after the record", async () => {
    await frontDesk(KNOWLEDGE, AUTO_ACK);
    const contactId = await addCrmContact(admin, DEVICE);
    const { registry } = runtime(undefined, { replyTransport: fake() });
    await send(ADMINISTRATIVE);
    await holdRuns(true);
    await send(OPT_OUT);
    await drain(registry);
    await recordDue();
    await drain(registry);
    expect((await contactFlag())?.flag).toBe(true);

    await holdRuns(false);
    await drain(registry);
    expect((await contactFlag())?.flag).toBe(true);
    expect(await lastEntry(contactId)).toMatchObject({
      origin: "system_opt_out",
    });
    expect(await acts()).toEqual(["opted_out"]);
    expect(await liftEvents()).toBe(0);
  });

  it("never lifts a flag a person set", async () => {
    await frontDesk(KNOWLEDGE, POLICY);
    const contactId = await addCrmContact(admin, DEVICE, {
      doNotContact: true,
    });
    const { registry } = runtime(undefined, { replyTransport: fake() });
    await send(ADMINISTRATIVE);
    await drain(registry);
    expect(await latest()).toMatchObject({ disposition: "held_for_person" });
    expect((await contactFlag())?.flag).toBe(true);
    expect(await lastEntry(contactId)).toMatchObject({ origin: "person" });
    expect(await acts()).toEqual([]);
  });

  it("still drafts the safety text when the lift cannot take the profile's lock, and a later message lifts it", async () => {
    await frontDesk(KNOWLEDGE, AUTO_ACK);
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime(undefined, { replyTransport: fake() });
    const { contactId, conversationId } = await optedOut(registry);

    await withProfileLocked(contactId, async () => {
      await send(DANGER);
      await drain(registry);
    });
    const crisis = await latest();
    expect(crisis).toMatchObject({
      disposition: "fixed_reply",
      fixed_message_key: "safety",
      review_status: "pending",
    });
    expect(crisis.proposed?.response_draft).toBe(FIXED.messages.safety);
    expect((await contactFlag())?.flag).toBe(true);
    expect(await liftEvents()).toBe(0);

    await send(ADMINISTRATIVE);
    await drain(registry);
    expect((await contactFlag())?.flag).toBe(false);
    expect(await latest()).toMatchObject({ disposition: "model" });
    expect(await holder(conversationId)).toMatchObject({ holder: "agent" });
  });

  it("makes any other message wait for the profile's lock, then lifts it", async () => {
    await frontDesk(KNOWLEDGE, AUTO_ACK);
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime(undefined, { replyTransport: fake() });
    const { contactId } = await optedOut(registry);

    await withProfileLocked(contactId, async () => {
      await send(ADMINISTRATIVE);
      expect(await runAgentJob(registry)).toMatchObject({
        kind: "agent_run.execute",
        outcome: "retry",
      });
    });
    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from ops.inbound_screenings s join ops.inbound_messages m on m.task_id = s.task_id where m.tenant_id = $1",
      [TENANT_A],
    );
    // Only the opt-out was screened: the waiting message left nothing.
    expect(rows[0].n).toBe("1");
    expect((await contactFlag())?.flag).toBe(true);

    await admin.query(
      `update ops.jobs set available_at = now()
        where tenant_id = $1 and kind = 'agent_run.execute' and status = 'queued'`,
      [TENANT_A],
    );
    await drain(registry);
    expect((await contactFlag())?.flag).toBe(false);
    expect(await latest()).toMatchObject({ disposition: "model" });
  });

  it("never lifts a flag a person set, even once the contact also asked to stop by message and the system recorded it", async () => {
    await frontDesk(KNOWLEDGE, AUTO_ACK);
    const contactId = await addCrmContact(admin, DEVICE, {
      doNotContact: true,
    });
    const { registry } = runtime(undefined, { replyTransport: fake() });
    await send(OPT_OUT);
    await drain(registry);
    await recordDue();
    await drain(registry);
    expect(await lastEntry(contactId)).toMatchObject({
      to_value: true,
      origin: "system_opt_out",
    });

    await send(ADMINISTRATIVE);
    await drain(registry);
    const after = await latest();
    expect(after).toMatchObject({ disposition: "held_for_person" });
    expect((await contactFlag())?.flag).toBe(true);
    // The contact's own opt-out is recorded as lifted; the person's flag stays.
    expect(await lastEntry(contactId)).toEqual({
      from_value: true,
      to_value: true,
      origin: "system_lift",
      reason_ref: `task:${after.task_id}`,
    });
    expect(await holder(after.conversation_id)).toMatchObject({
      holder: "person",
    });
    expect(await liftEvents()).toBe(0);
  });

  it("keeps a conversation a person took over with the person when the contact's later message lifts the opt-out", async () => {
    await frontDesk(KNOWLEDGE, AUTO_ACK);
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime(undefined, { replyTransport: fake() });
    const { conversationId } = await optedOut(registry);
    await owner.withTransaction((tx) =>
      takeOverConversation(tx, {
        tenantId: TENANT_A,
        conversationId,
        actor: "dbtest-person",
      }),
    );

    await send(ADMINISTRATIVE);
    await drain(registry);
    expect((await contactFlag())?.flag).toBe(false);
    expect(await latest()).toMatchObject({ disposition: "held_for_person" });
    expect(await holder(conversationId)).toMatchObject({
      holder: "person",
      holder_reason: "operator",
    });
  });

  it("keeps the conversation with a person while another reason for a person is open", async () => {
    await frontDesk(KNOWLEDGE, AUTO_ACK);
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime(undefined, { replyTransport: fake() });
    const { conversationId } = await optedOut(registry);
    const optOut = await latest();
    await admin.query(
      `select ops.open_exception($1, (select company_id from ops.conversations where id = $2), $3,
                                 'person_requested', $2, null, null, 'dbtest')`,
      [TENANT_A, conversationId, optOut.task_id],
    );

    await send(ADMINISTRATIVE);
    await drain(registry);
    expect((await contactFlag())?.flag).toBe(false);
    expect(await latest()).toMatchObject({ disposition: "held_for_person" });
    expect(await holder(conversationId)).toMatchObject({
      holder: "person",
      holder_reason: "opt_out",
    });
  });

  it("answers every message admitted while the opt-out was recorded once one of them lifted it", async () => {
    await frontDesk(KNOWLEDGE, AUTO_ACK);
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime(undefined, { replyTransport: fake() });
    await optedOut(registry);

    await holdRuns(true);
    await send(ADMINISTRATIVE);
    await send("E vocês atendem online?");
    await holdRuns(false);
    await drain(registry);
    const { rows } = await admin.query<{
      disposition: string;
      opt_out_cleared: boolean;
    }>(
      `select s.disposition, s.opt_out_cleared
         from ops.inbound_screenings s join ops.inbound_messages m on m.task_id = s.task_id
        where m.tenant_id = $1 and not s.opt_out_requested
        order by m.received_at, m.created_at`,
      [TENANT_A],
    );
    expect(rows).toEqual([
      { disposition: "model", opt_out_cleared: true },
      { disposition: "model", opt_out_cleared: true },
    ]);
    expect(await acts()).toEqual(["opted_out", "opt_out_lifted"]);
    expect(await liftEvents()).toBe(1);
    const open = await admin.query(
      `select 1 from ops.exceptions where tenant_id = $1 and resolved_at is null
          and kind in ('do_not_contact', 'message_waiting')`,
      [TENANT_A],
    );
    expect(open.rows).toEqual([]);
  });

  it("lets an automatic fixed text reach the contact once the message lifted the opt-out", async () => {
    await frontDesk(KNOWLEDGE, {
      ...POLICY,
      automaticFixedTexts: ["opt_out_ack", "human_handoff_ack"],
    });
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await optedOut(registry);
    expect(reply.transport.calls).toHaveLength(1);

    await send("Quero falar com uma pessoa.");
    await drain(registry);
    const after = await latest();
    expect(after).toMatchObject({
      disposition: "fixed_reply",
      fixed_message_key: "human_handoff_ack",
    });
    const { rows } = await admin.query<{ do_not_contact: boolean }>(
      "select do_not_contact from ops.review_items where tenant_id = $1 and task_id = $2 and author = 'fixed'",
      [TENANT_A, after.task_id],
    );
    expect(rows).toEqual([{ do_not_contact: false }]);
    expect(reply.transport.calls).toHaveLength(2);
    expect(await acts()).toContain("opt_out_lifted");
  });
});
