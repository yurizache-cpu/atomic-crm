// The front-desk agent end to end (ADR 0023), against a real Postgres, the
// gateway's OWN constrained login and the real worker runtime, with only the
// network replaced: a signed Meta delivery from a registered test device is
// screened locally, recorded, and only the screened text reaches the model and
// the structured decisions. What the screen omitted is proven absent from the
// provider request, the Jev request and every table but the raw store.
//
// A reply goes only to a CRM contact (ADR 0021 W6), and since ADR 0025 A3 a
// message no reply can reach gets no model at all, so every case that expects
// the model registers its sender as a CRM contact first.
// exceptionQueue.dbtest.ts covers the contacts no reply can reach.
//
// ALL DATA IS SYNTHETIC (BASELINE Q8). Numbers, targets and texts are invented.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import {
  removeFixtureModels,
  TENANT_A,
} from "../worker/testSupport/dbFixture.ts";
import { recordPersonReply, releaseConversation } from "./frontDesk.ts";
import {
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
  reply,
} from "./testSupport/frontDeskHarness.ts";
import {
  addCrmContact,
  deleteCrmContacts,
  gatewayDatabase,
  provisionGatewayRole,
} from "./testSupport/whatsappFixture.ts";

const TARGET = "200000000000919";
const DEVICE = "5511900000919";

// The sensitive clause every leak check looks for.
const SENSITIVE = "Estou tendo crises de ansiedade";

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
    messagePrefix: "FD",
  });

beforeEach(prepare);

/** ADR 0025: the conversation's exceptions, oldest first. */
const exceptionsOn = async (conversationId: string) =>
  (
    await admin.query<{
      kind: string;
      priority: string;
      resolution: string | null;
      resolved_by: string | null;
    }>(
      `select kind, priority, resolution, resolved_by from ops.exceptions
        where conversation_id = $1 order by raised_at, id`,
      [conversationId],
    )
  ).rows;

/**
 * Everything our code persisted or sent for the tenant, except the raw store
 * (ops.tasks.description), as one text to search.
 */
const everythingButTheRawStore = async (
  provider: ReturnType<typeof runtime>["provider"],
  decisions: ReturnType<typeof runtime>["decisions"],
): Promise<string> => {
  const { rows } = await admin.query<{ dump: string }>(
    `select concat_ws(' ',
       (select string_agg(to_jsonb(r)::text, ' ') from ops.agent_runs r where r.tenant_id = $1),
       (select string_agg(to_jsonb(d)::text, ' ') from ops.structured_decisions d where d.tenant_id = $1),
       (select string_agg(to_jsonb(e)::text, ' ') from ops.events e where e.tenant_id = $1),
       (select string_agg(to_jsonb(x)::text, ' ') from ops.agent_run_routes x where x.tenant_id = $1),
       (select string_agg(to_jsonb(s)::text, ' ') from ops.inbound_screenings s where s.tenant_id = $1),
       (select string_agg(to_jsonb(ri)::text, ' ') from ops.review_items ri where ri.tenant_id = $1),
       (select string_agg(to_jsonb(c)::text, ' ') from ops.conversation_transitions c where c.tenant_id = $1),
       (select string_agg(to_jsonb(j)::text, ' ') from ops.jobs j where j.tenant_id = $1),
       (select string_agg(to_jsonb(je)::text, ' ') from ops.job_events je where je.tenant_id = $1)) as dump`,
    [TENANT_A],
  );
  return [
    rows[0].dump,
    JSON.stringify(provider.calls),
    JSON.stringify(decisions.asked),
  ].join(" ");
};

describe("the front-desk agent screens before any model (ADR 0023)", () => {
  it("case 1: an administrative question goes to the model whole, and to Jev whole", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { provider, decisions, registry } = runtime();
    await send("Qual o valor da primeira sessão?");
    await drain(registry);

    const out = await latest();
    expect(out).toMatchObject({
      run_status: "succeeded",
      message_class: "administrative",
      disposition: "model",
      model_input: "Qual o valor da primeira sessão?",
      party_kind: "prospect",
      review_status: "pending",
    });
    expect(provider.calls).toHaveLength(1);
    const input = provider.calls[0].input;
    expect(input).toContain("Qual o valor da primeira sessão?");
    // The prompt carries the published knowledge, never the raw task.
    expect(input).toContain("A primeira sessão custa R$ 200.");
    expect(provider.calls[0].instructions).toContain("virtual front desk");
    // Prompt v4: the database says when the contact wrote, on the agent's clock.
    expect(input).toMatch(
      /"receivedAt":\{"at":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}","label":/,
    );
    const business = decisions.asked.find((r) => "intent" in r.questions)!;
    expect(business.state).toMatchObject({
      message: "Qual o valor da primeira sessão?",
    });
  });

  it("case 2: a mixed message reaches the model and Jev without its sensitive clause, and the request proceeds", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { provider, decisions, registry } = runtime();
    await send(`${SENSITIVE} e queria saber se tem horário terça.`);
    await drain(registry);

    const out = await latest();
    expect(out).toMatchObject({
      run_status: "succeeded",
      message_class: "mixed",
      disposition: "model",
      model_input: "[trecho omitido] queria saber se tem horário terça.",
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].input).toContain(
      "queria saber se tem horário terça.",
    );
    const business = decisions.asked.find((r) => "intent" in r.questions)!;
    expect(business.state).toMatchObject({
      message: "[trecho omitido] queria saber se tem horário terça.",
    });

    // The clause is absent from everything but the raw store.
    const dump = await everythingButTheRawStore(provider, decisions);
    expect(dump).not.toContain(SENSITIVE);
    expect(dump.toLowerCase()).not.toContain("ansiedade");
    const { rows } = await admin.query<{ description: string }>(
      "select description from ops.tasks where id = $1",
      [out.task_id],
    );
    expect(rows[0].description).toContain(SENSITIVE);
  });

  it("case 3: a message with only sensitive content never reaches a model; a fixed reply waits for review", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { provider, decisions, registry } = runtime();
    await send("Tenho tido crises de pânico e não durmo direito.");
    await drain(registry);

    const out = await latest();
    expect(out).toMatchObject({
      run_status: "cancelled",
      error_code: "front_desk_fixed_reply",
      message_class: "sensitive_only",
      disposition: "fixed_reply",
      fixed_message_key: "sensitive_only_prospect",
      model_input: null,
      review_status: "pending",
    });
    expect(out.proposed?.response_draft).toBe(
      FIXED.messages.sensitive_only_prospect,
    );
    expect(provider.calls).toHaveLength(0);
    expect(decisions.asked).toHaveLength(0);
    const dump = await everythingButTheRawStore(provider, decisions);
    expect(dump.toLowerCase()).not.toContain("pânico");
  });

  it("case 4: a client's administrative request is served as logistics, and a client's sensitive message is sent to the professional", async () => {
    await frontDesk();
    const contact = await addCrmContact(admin, DEVICE);
    await admin.query(
      `insert into public.deals (name, stage, contact_ids, converted_at)
       values ($1, 'won', array[$2::bigint], now())`,
      [DEAL_NAME, contact],
    );
    const { provider, registry } = runtime();
    await send("Preciso remarcar a sessão de quinta para sexta às 19h.");
    await drain(registry);

    const out = await latest();
    expect(out).toMatchObject({
      message_class: "administrative",
      disposition: "model",
      party_kind: "client",
    });
    expect(provider.calls[0].input).toContain('"partyKind":"client"');
    expect(await holder(out.conversation_id)).toMatchObject({
      party_kind: "client",
      holder: "agent",
    });

    await send("Sou paciente e estou com muita ansiedade.");
    await drain(registry);
    expect(await latest()).toMatchObject({
      disposition: "fixed_reply",
      fixed_message_key: "sensitive_only_client",
    });
    expect(provider.calls).toHaveLength(1);
  });

  it("case 5: a request for a person hands the conversation over; the agent stops until it is released", async () => {
    await frontDesk();
    // A reply goes only to a CRM contact (ADR 0021 W6).
    await addCrmContact(admin, DEVICE);
    const { provider, registry } = runtime();
    await send("Quero falar com uma pessoa, por favor.");
    await drain(registry);
    const asked = await latest();
    expect(asked).toMatchObject({
      disposition: "fixed_reply",
      fixed_message_key: "human_handoff_ack",
    });
    expect(await holder(asked.conversation_id)).toMatchObject({
      holder: "person",
      holder_reason: "person_requested",
    });

    // While a person holds it, nothing reaches a model and no review opens.
    await send("Qual o valor da primeira sessão?");
    await drain(registry);
    const held = await latest();
    expect(held).toMatchObject({
      run_status: "cancelled",
      error_code: "front_desk_held_for_person",
      disposition: "held_for_person",
      review_status: null,
    });
    expect(provider.calls).toHaveLength(0);

    // The person replies; the reply is an accepted review the send act carries.
    const recorded = await owner.withTransaction((tx) =>
      recordPersonReply(tx, {
        tenantId: TENANT_A,
        conversationId: held.conversation_id,
        text: "Oi! A primeira sessão custa R$ 200.",
        actor: "dbtest-person",
      }),
    );
    expect(recorded).toMatchObject({ state: "recorded" });
    expect((await latest()).review_status).toBe("accepted");

    // Released, the agent answers again.
    await owner.withTransaction((tx) =>
      releaseConversation(tx, {
        tenantId: TENANT_A,
        conversationId: held.conversation_id,
        actor: "dbtest-person",
      }),
    );
    await send("E vocês atendem online?");
    await drain(registry);
    expect(await latest()).toMatchObject({
      disposition: "model",
      run_status: "succeeded",
    });
    expect(provider.calls).toHaveLength(1);
    // A turn the model may not read is shown only as a marker.
    expect(provider.calls[0].input).toContain("[mensagem não mostrada]");

    // ADR 0025: the request reached the queue once, the held message was
    // counted for the person, and the release resolved both.
    expect(await exceptionsOn(held.conversation_id)).toEqual([
      {
        kind: "person_requested",
        priority: "high",
        resolution: "released",
        resolved_by: "dbtest-person",
      },
      {
        kind: "message_waiting",
        priority: "normal",
        resolution: "released",
        resolved_by: "dbtest-person",
      },
    ]);
  });

  it("case 6: a reply stating a fact the agent was not given goes to a person; a grounded one does not", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const ungrounded = runtime(
      reply("A primeira sessão custa R$ 999 e temos horário às 07:30."),
    );
    await send("Qual o valor da primeira sessão?");
    await drain(ungrounded.registry);
    const first = await latest();
    expect(first.proposed).toMatchObject({ needs_human_review: true });
    expect(first.proposed?.flags).toContain("unclear");

    const grounded = runtime(reply("A primeira sessão custa R$ 200."));
    await send("E qual o formato das sessões?");
    await drain(grounded.registry);
    const second = await latest();
    expect(second.proposed).toMatchObject({ needs_human_review: false });
    expect(second.proposed?.flags).not.toContain("unclear");
  });

  it("answers danger with the fixed safety text and flags it; the conversation stays with the agent", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { provider, decisions, registry } = runtime();
    await send("Não quero mais viver.");
    await drain(registry);
    const out = await latest();
    expect(out).toMatchObject({
      message_class: "safety",
      disposition: "fixed_reply",
      fixed_message_key: "safety",
      model_input: null,
    });
    expect(out.proposed).toMatchObject({
      priority: "high",
      flags: ["possible_crisis"],
    });
    expect(out.proposed?.response_draft).toBe(FIXED.messages.safety);
    // Owner decision, 2026-10-08: the front desk answers leads, not
    // patients, and the owner does not take a crisis: the conversation stays
    // with the agent, and nothing reaches the exception queue (ADR 0025).
    expect(await holder(out.conversation_id)).toMatchObject({
      holder: "agent",
      holder_reason: null,
    });
    expect(provider.calls).toHaveLength(0);
    expect(decisions.asked).toHaveLength(0);
    expect(await exceptionsOn(out.conversation_id)).toEqual([]);
  });

  it("pack v4: asking for someone the policy names hands the conversation over; asking for anyone else does not", async () => {
    await frontDesk(KNOWLEDGE, {
      ...POLICY,
      sanitizerPack: "health_pt_br.v4",
      handoffNames: ["Rafael"],
    });
    await addCrmContact(admin, DEVICE);
    const { provider, registry } = runtime();
    // A name the policy does not list asks for no one the front desk has.
    await send("quero falar com o Bruno");
    await drain(registry);
    expect(await latest()).toMatchObject({
      disposition: "fixed_reply",
      fixed_message_key: "clarification",
    });
    await send("quero falar com o Rafael");
    await drain(registry);
    const asked = await latest();
    expect(asked).toMatchObject({
      disposition: "fixed_reply",
      fixed_message_key: "human_handoff_ack",
    });
    expect(await holder(asked.conversation_id)).toMatchObject({
      holder: "person",
      holder_reason: "person_requested",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("asks an unrecognised message to clarify, without a model", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { provider, registry } = runtime();
    await send("as coisas estão pesadas");
    await drain(registry);
    expect(await latest()).toMatchObject({
      message_class: "unknown",
      disposition: "fixed_reply",
      fixed_message_key: "clarification",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("gives the model earlier turns as screened text only", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { provider, registry } = runtime();
    await send(`${SENSITIVE}, queria marcar.`);
    await drain(registry);
    await send("Pode ser terça às 19h?");
    await drain(registry);
    expect(provider.calls).toHaveLength(2);
    const second = provider.calls[1].input;
    expect(second).toContain("Pode ser terça às 19h?");
    expect(second).toContain("[trecho omitido], queria marcar.");
    expect(second.toLowerCase()).not.toContain("ansiedade");
  });
});
