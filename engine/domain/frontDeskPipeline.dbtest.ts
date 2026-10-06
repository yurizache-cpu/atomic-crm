// The front-desk agent end to end (ADR 0023), against a real Postgres, the
// gateway's OWN constrained login and the real worker runtime, with only the
// network replaced: a signed Meta delivery from a registered test device is
// screened locally, recorded, and only the screened text reaches the model and
// the structured decisions. What the screen omitted is proven absent from the
// provider request, the Jev request and every table but the raw store.
//
// ALL DATA IS SYNTHETIC (BASELINE Q8). Numbers, targets and texts are invented.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import type {
  StructuredDecisionGateway,
  StructuredDecisionRequest,
} from "../decision/structured/types.ts";
import { createFakeModelProvider } from "../models/fakeModelProvider.ts";
import type { LeadTriage } from "../models/leadTriage.ts";
import { createModelRouter } from "../models/router.ts";
import { createHandlerRegistry } from "../worker/registry.ts";
import {
  registerFixtureModel,
  removeFixtureModels,
  resetFixtures,
  TENANT_A,
} from "../worker/testSupport/dbFixture.ts";
import {
  draftAgentConfiguration,
  publishAgentConfiguration,
  recordPersonReply,
  releaseConversation,
} from "./frontDesk.ts";
import {
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  openAgentRuntimeDatabases,
} from "./testSupport/agentRuntimeProbes.ts";
import {
  addCrmContact,
  buildClinic,
  deleteCrmContacts,
  deliver,
  gatewayDatabase,
  metaPayload,
  provisionGatewayRole,
  type Clinic,
} from "./testSupport/whatsappFixture.ts";

const GATEWAY = "openrouter";
const CHEAP = "dbtest/fd-cheap";
const STRONG = "dbtest/fd-strong";
const DECIDER = "dbtest/fd-decider-1";
const MODELS = [CHEAP, STRONG, DECIDER].map((model) => ({
  gateway: GATEWAY,
  model,
}));
const TARGET = "200000000000919";
const DEVICE = "5511900000919";
const DEAL_NAME = "dbtest-front-desk";

// The sensitive clause every leak check looks for.
const SENSITIVE = "Estou tendo crises de ansiedade";

const POLICY = {
  sendMode: "supervised",
  sanitizerPack: "health_pt_br.v1",
  contextTurns: 6,
  aiDisclosure: "Sou a assistente virtual da clínica fictícia.",
  scope: ["Agendamento, valores e dúvidas sobre o atendimento"],
  prohibited: ["Falar de sintomas ou de tratamento"],
  partyPolicy: {
    prospect: ["valores", "horários"],
    client: ["remarcação", "cancelamento"],
  },
};
const PLAYBOOK = {
  stages: [
    {
      key: "greeting",
      objective: "Cumprimentar e se apresentar como assistente virtual.",
      requiredFacts: [],
      transitions: ["answer"],
      forbidden: [],
      examples: [],
    },
    {
      key: "answer",
      objective: "Responder só com os fatos da base.",
      requiredFacts: [],
      transitions: [],
      forbidden: ["Inventar horários"],
      examples: [],
    },
  ],
};
const KNOWLEDGE = {
  domains: {
    pricing: "A primeira sessão custa R$ 200.",
    format: "Atendimento online, sessões de 50 minutos.",
  },
};
const FIXED = {
  messages: {
    safety: "Texto fixo de segurança (fictício): ligue 188 ou 192.",
    human_handoff_ack: "Uma pessoa da equipe vai continuar com você.",
    sensitive_only_prospect:
      "Esses detalhes são conversados na sessão. Posso mostrar horários?",
    sensitive_only_client:
      "Fale direto com o seu profissional pelo número que você recebeu.",
    clarification:
      "Posso ajudar com horários, valores e dúvidas. O que você precisa?",
    out_of_scope: "Por aqui eu ajudo só com o atendimento.",
    service_unavailable: "Estamos com instabilidade; uma pessoa vai responder.",
    opt_out_ack: "Certo, não enviaremos mais mensagens.",
  },
};

const reply = (draft: string, needsHumanReview = false): LeadTriage =>
  Object.freeze({
    outcome: "triaged",
    summary: "Pedido administrativo sobre horários.",
    intent: "book_appointment",
    priority: "normal",
    recommended_next_action: "Confirmar o horário.",
    response_draft: draft,
    needs_human_review: needsHumanReview,
    flags: Object.freeze([]),
  }) as LeadTriage;

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
  await removeFixtureModels(admin, MODELS);
  await admin.query("delete from public.deals where name = $1", [DEAL_NAME]);
  await deleteCrmContacts(admin);
  await closeAgentRuntimeDatabases({ admin, owner, db });
});

const { runAgentJob } = agentRuntimeProbes(() => ({ admin, owner, db }));

const price = (model: string, input: number, output: number) =>
  admin.query(
    `select ops.record_model_price($1, $2, $3, $4, true, now() - interval '1 hour',
                                   now() + interval '1 day', 'dbtest front desk price', 'dbtest')`,
    [GATEWAY, model, input, output],
  );

beforeEach(async () => {
  await resetFixtures(admin);
  await admin.query("delete from public.deals where name = $1", [DEAL_NAME]);
  await deleteCrmContacts(admin);
  await price(CHEAP, 0.1, 0.5);
  await price(STRONG, 2, 10);
  await price(DECIDER, 0.042, 0);
  await removeFixtureModels(admin, MODELS);
  await registerFixtureModel(admin, {
    gateway: GATEWAY,
    model: CHEAP,
    rank: 1,
  });
  await registerFixtureModel(admin, {
    gateway: GATEWAY,
    model: STRONG,
    rank: 2,
  });
  await registerFixtureModel(admin, {
    gateway: GATEWAY,
    model: DECIDER,
    pool: "structured_decision",
    rank: 1,
  });
});

/** A clinic with a receptionist agent whose four configuration kinds are published. */
const frontDesk = async (knowledge: unknown = KNOWLEDGE): Promise<Clinic> => {
  const clinic = await buildClinic(owner, TENANT_A, TARGET, "test", [DEVICE]);
  await admin.query(
    `select ops.record_agent_profile($1, $2, 'Answer contacts on administrative matters.',
       array['lead_triage'], array['test'], 1000000, 'America/Sao_Paulo',
       '{"lead_triage": "reception_low_cost"}'::jsonb, 'dbtest')`,
    [TENANT_A, clinic.agentId],
  );
  for (const [kind, content] of [
    ["operating_policy", POLICY],
    ["playbook", PLAYBOOK],
    ["knowledge", knowledge],
    ["fixed_messages", FIXED],
  ] as const) {
    await owner.withTransaction(async (tx) => {
      const { id } = await draftAgentConfiguration(tx, {
        tenantId: TENANT_A,
        agentId: clinic.agentId,
        kind,
        content,
        actor: "dbtest-owner",
      });
      await publishAgentConfiguration(tx, {
        tenantId: TENANT_A,
        versionId: id,
        actor: "dbtest-owner",
      });
    });
  }
  return clinic;
};

const decisionsGateway = () => {
  const asked: StructuredDecisionRequest[] = [];
  const gateway_: StructuredDecisionGateway = {
    name: GATEWAY,
    decide: async (request) => {
      asked.push(request);
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(request.questions)) {
        if (question.type === "noul")
          answers[key] = { type: "noul", noul: 0.2 };
        if (question.type === "score")
          answers[key] = { type: "score", score: 0.4, confidence: 0.7 };
        if (question.type === "choice")
          answers[key] = {
            type: "choice",
            choice: Object.keys(question.criteria)[0],
            confidence: 0.6,
          };
      }
      return {
        gateway: GATEWAY,
        model: request.model,
        providerRoute: "TypeSafe",
        responseId: "gen-dec-fd",
        answers,
        inputTokens: 300,
        outputTokens: 20,
        reportedCostMicros: 13,
        latencyMs: 400,
      };
    },
  };
  return { gateway: gateway_, asked };
};

const runtime = (
  answer: LeadTriage = reply("Temos horário na terça. Posso reservar?"),
) => {
  const provider = createFakeModelProvider(
    {
      type: "respond",
      content: answer,
      providerRoute: "OpenAI",
      reportedCostMicros: 191,
    },
    { name: GATEWAY },
  );
  const decisions = decisionsGateway();
  const modelRouter = createModelRouter({
    routes: new Map(),
    providers: new Map(),
    gateway: { provider, tiers: ["standard"] },
  });
  const registry = createHandlerRegistry({
    modelRouter,
    structuredDecisionGateway: decisions.gateway,
    requestsStructuredDecisions: true,
  });
  return { provider, decisions, registry };
};

const drain = async (registry: ReturnType<typeof runtime>["registry"]) => {
  for (let i = 0; i < 10; i += 1) {
    if ((await runAgentJob(registry)).outcome === "idle") return;
  }
};

let sequence = 0;
const send = async (body: string) => {
  sequence += 1;
  const answer = await deliver(
    gateway,
    metaPayload(TARGET, {
      messages: [{ id: `wamid.FD${sequence}`, from: DEVICE, body }],
    }),
  );
  expect(answer.status).toBe(200);
};

interface Outcome {
  task_id: string;
  run_status: string;
  error_code: string | null;
  message_class: string;
  disposition: string;
  fixed_message_key: string | null;
  model_input: string | null;
  party_kind: string;
  review_status: string | null;
  proposed: LeadTriage | null;
  conversation_id: string;
}

/** The latest message's run, screening and review. */
const latest = async (): Promise<Outcome> => {
  const { rows } = await admin.query<Outcome>(
    `select i.task_id, r.status as run_status, r.error_code, s.message_class, s.disposition,
            s.fixed_message_key, s.model_input, s.party_kind, ri.status as review_status, ri.proposed,
            i.conversation_id
       from ops.inbound_messages i
       join ops.agent_runs r on r.id = i.agent_run_id
       join ops.inbound_screenings s on s.agent_run_id = r.id
       left join ops.review_items ri on ri.agent_run_id = r.id
      where i.tenant_id = $1
      order by i.received_at desc, i.created_at desc
      limit 1`,
    [TENANT_A],
  );
  return rows[0];
};

const holder = async (conversationId: string) =>
  (
    await admin.query<{
      holder: string;
      holder_reason: string | null;
      party_kind: string;
    }>(
      "select holder, holder_reason, party_kind from ops.conversation_states where conversation_id = $1",
      [conversationId],
    )
  ).rows[0];

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
  });

  it("case 6: a reply stating a fact the agent was not given goes to a person; a grounded one does not", async () => {
    await frontDesk();
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

  it("answers danger with the fixed safety text, flags it, and hands the conversation to a person", async () => {
    await frontDesk();
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
    expect(await holder(out.conversation_id)).toMatchObject({
      holder: "person",
      holder_reason: "safety",
    });
    expect(provider.calls).toHaveLength(0);
    expect(decisions.asked).toHaveLength(0);
  });

  it("asks an unrecognised message to clarify, without a model", async () => {
    await frontDesk();
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
