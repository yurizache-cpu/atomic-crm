// The front-desk agent's driver-backed harness (ADR 0023, ADR 0025): a
// receptionist agent with its four configuration kinds published, the real
// worker runtime on a scripted model provider and a scripted structured-decision
// gateway, and signed Meta deliveries through the gateway's own constrained
// login. Shared by frontDeskPipeline.dbtest.ts and exceptionQueue.dbtest.ts.
//
// Each suite owns its connections and its lifecycle; the harness takes an
// accessor because a suite opens them in `beforeAll`. It lives in engine/domain
// because only there may code import the domain services, the worker runtime
// and the database fixture together (eslint.config.js).
//
// ALL DATA IS SYNTHETIC (BASELINE Q8). Numbers, targets and texts are invented.

import { expect } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../../db/types.ts";
import type {
  StructuredDecisionGateway,
  StructuredDecisionRequest,
} from "../../decision/structured/types.ts";
import { createFakeModelProvider } from "../../models/fakeModelProvider.ts";
import type { LeadTriage } from "../../models/leadTriage.ts";
import { createModelRouter } from "../../models/router.ts";
import { createHandlerRegistry } from "../../worker/registry.ts";
import {
  registerFixtureModel,
  removeFixtureModels,
  resetFixtures,
  TENANT_A,
} from "../../worker/testSupport/dbFixture.ts";
import {
  draftAgentConfiguration,
  publishAgentConfiguration,
} from "../frontDesk.ts";
import { agentRuntimeProbes } from "./agentRuntimeProbes.ts";
import {
  buildClinic,
  deleteCrmContacts,
  deliver,
  metaPayload,
  type Clinic,
} from "./whatsappFixture.ts";

export const GATEWAY = "openrouter";
const CHEAP = "dbtest/fd-cheap";
const STRONG = "dbtest/fd-strong";
const DECIDER = "dbtest/fd-decider-1";
export const FRONT_DESK_MODELS = [CHEAP, STRONG, DECIDER].map((model) => ({
  gateway: GATEWAY,
  model,
}));
export const DEAL_NAME = "dbtest-front-desk";

export const POLICY = {
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
export const KNOWLEDGE = {
  domains: {
    pricing: "A primeira sessão custa R$ 200.",
    format: "Atendimento online, sessões de 50 minutos.",
  },
};
export const FIXED = {
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

export type ConfigurationKindName =
  | "operating_policy"
  | "playbook"
  | "knowledge"
  | "fixed_messages";

export const reply = (draft: string, needsHumanReview = false): LeadTriage =>
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

export interface FrontDeskConnections {
  readonly admin: Pool;
  readonly owner: WorkerDatabase;
  readonly db: WorkerDatabase;
  readonly gateway: WorkerDatabase;
}

export interface Outcome {
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

export interface FrontDeskOptions {
  /** The test line's provider target. */
  readonly target: string;
  /** The registered test device every message comes from. */
  readonly device: string;
  /** A prefix for the deliveries' provider message ids, unique per suite. */
  readonly messagePrefix: string;
}

export function createFrontDeskHarness(
  connections: () => FrontDeskConnections,
  options: FrontDeskOptions,
) {
  const { runAgentJob } = agentRuntimeProbes(() => {
    const { admin, owner, db } = connections();
    return { admin, owner, db };
  });

  const price = (model: string, input: number, output: number) =>
    connections().admin.query(
      `select ops.record_model_price($1, $2, $3, $4, true, now() - interval '1 hour',
                                     now() + interval '1 day', 'dbtest front desk price', 'dbtest')`,
      [GATEWAY, model, input, output],
    );

  /** Every case starts from no Company OS row, no CRM contact and the three priced models. */
  const prepare = async (): Promise<void> => {
    const { admin } = connections();
    await resetFixtures(admin);
    await admin.query("delete from public.deals where name = $1", [DEAL_NAME]);
    await deleteCrmContacts(admin);
    await price(CHEAP, 0.1, 0.5);
    await price(STRONG, 2, 10);
    await price(DECIDER, 0.042, 0);
    await removeFixtureModels(admin, FRONT_DESK_MODELS);
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
  };

  /** A clinic with a receptionist agent whose configuration kinds are published. */
  const frontDesk = async (
    knowledge: unknown = KNOWLEDGE,
    policy: unknown = POLICY,
    kinds: readonly ConfigurationKindName[] = [
      "operating_policy",
      "playbook",
      "knowledge",
      "fixed_messages",
    ],
  ): Promise<Clinic> => {
    const { admin, owner } = connections();
    const clinic = await buildClinic(owner, TENANT_A, options.target, "test", [
      options.device,
    ]);
    await admin.query(
      `select ops.record_agent_profile($1, $2, 'Answer contacts on administrative matters.',
         array['lead_triage'], array['test'], 1000000, 'America/Sao_Paulo',
         '{"lead_triage": "reception_low_cost"}'::jsonb, 'dbtest')`,
      [TENANT_A, clinic.agentId],
    );
    const contents: Record<ConfigurationKindName, unknown> = {
      operating_policy: policy,
      playbook: PLAYBOOK,
      knowledge,
      fixed_messages: FIXED,
    };
    for (const kind of kinds) {
      await owner.withTransaction(async (tx) => {
        const { id } = await draftAgentConfiguration(tx, {
          tenantId: TENANT_A,
          agentId: clinic.agentId,
          kind,
          content: contents[kind],
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
    const scripted: StructuredDecisionGateway = {
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
    return { gateway: scripted, asked };
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

  const drain = async (
    registry: ReturnType<typeof runtime>["registry"],
  ): Promise<void> => {
    for (let i = 0; i < 10; i += 1) {
      if ((await runAgentJob(registry)).outcome === "idle") return;
    }
  };

  let sequence = 0;
  /** One signed delivery from the device: a text, or an image the store refuses on the record. */
  const send = async (
    body: string,
    kind: "text" | "image" = "text",
  ): Promise<void> => {
    sequence += 1;
    const answer = await deliver(
      connections().gateway,
      metaPayload(options.target, {
        messages: [
          {
            id: `wamid.${options.messagePrefix}${sequence}`,
            from: options.device,
            body,
            kind,
          },
        ],
      }),
    );
    expect(answer.status).toBe(200);
  };

  /** The latest message's run, screening and the review the agent or a fixed text drafted. */
  const latest = async (): Promise<Outcome> => {
    const { rows } = await connections().admin.query<Outcome>(
      `select i.task_id, r.status as run_status, r.error_code, s.message_class, s.disposition,
              s.fixed_message_key, s.model_input, s.party_kind, ri.status as review_status, ri.proposed,
              i.conversation_id
         from ops.inbound_messages i
         join ops.agent_runs r on r.id = i.agent_run_id
         join ops.inbound_screenings s on s.agent_run_id = r.id
         left join ops.review_items ri on ri.agent_run_id = r.id and ri.author <> 'person'
        where i.tenant_id = $1
        order by i.received_at desc, i.created_at desc
        limit 1`,
      [TENANT_A],
    );
    return rows[0];
  };

  const holder = async (conversationId: string) =>
    (
      await connections().admin.query<{
        holder: string;
        holder_reason: string | null;
        party_kind: string;
      }>(
        "select holder, holder_reason, party_kind from ops.conversation_states where conversation_id = $1",
        [conversationId],
      )
    ).rows[0];

  /** The conversation's revision, as `front-desk conversations` prints it. */
  const revision = async (conversationId: string): Promise<number> =>
    (
      await connections().admin.query<{ revision: number }>(
        "select ops.cos_conversation_revision(tenant_id, id) as revision from ops.conversations where id = $1",
        [conversationId],
      )
    ).rows[0].revision;

  return { prepare, frontDesk, runtime, drain, send, latest, holder, revision };
}
