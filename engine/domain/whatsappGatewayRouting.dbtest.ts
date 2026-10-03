// WhatsApp through the Company OS model layer (ADR 0018 + ADR 0022), against a
// real Postgres, the gateway's OWN constrained login and the real worker
// runtime, with only the network replaced: a signed Meta delivery from a
// registered test device becomes `test` data, its triage runs on the agent's
// AUTHORIZED pool through the gateway (never a model named in code), and the
// Jev decisions run after it in shadow. A message from any other number is
// `health`: Q8 refuses it before any model or decision, as before.
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
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  openAgentRuntimeDatabases,
} from "./testSupport/agentRuntimeProbes.ts";
import {
  buildClinic,
  deliver,
  gatewayDatabase,
  metaPayload,
  provisionGatewayRole,
} from "./testSupport/whatsappFixture.ts";

const GATEWAY = "openrouter";
const CHEAP = "dbtest/wa-cheap";
const STRONG = "dbtest/wa-strong";
const DECIDER = "dbtest/wa-decider-1";
const MODELS = [CHEAP, STRONG, DECIDER].map((model) => ({
  gateway: GATEWAY,
  model,
}));
const TARGET = "200000000000909";
const TEST_DEVICE = "5511900000909";
const UNREGISTERED = "5511900000910";

const ADVICE: LeadTriage = Object.freeze({
  outcome: "triaged",
  summary: "A synthetic enquiry about prices and how sessions work.",
  intent: "pricing",
  priority: "normal",
  recommended_next_action: "Share how a first session works and the prices.",
  response_draft: "Oi! Obrigado por escrever.",
  needs_human_review: true,
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
  await closeAgentRuntimeDatabases({ admin, owner, db });
});

const { runAgentJob } = agentRuntimeProbes(() => ({ admin, owner, db }));

const price = (model: string, input: number, output: number) =>
  admin.query(
    `select ops.record_model_price($1, $2, $3, $4, true, now() - interval '1 hour',
                                   now() + interval '1 day', 'dbtest whatsapp price', 'dbtest')`,
    [GATEWAY, model, input, output],
  );

beforeEach(async () => {
  await resetFixtures(admin);
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
        responseId: "gen-dec-wa",
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

const runtime = () => {
  const provider = createFakeModelProvider(
    {
      type: "respond",
      content: ADVICE,
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
  for (let i = 0; i < 8; i += 1) {
    if ((await runAgentJob(registry)).outcome === "idle") return;
  }
};

const inbound = async () =>
  (
    await admin.query<{
      agent_run_id: string;
      data_class: string;
      run_status: string;
      error_code: string | null;
      provider: string | null;
      model: string | null;
    }>(
      `select i.agent_run_id, t.data_class, r.status as run_status, r.error_code, r.provider, r.model
         from ops.inbound_messages i
         join ops.tasks t on t.id = i.task_id
         join ops.agent_runs r on r.id = i.agent_run_id
        where i.tenant_id = $1 order by i.created_at`,
      [TENANT_A],
    )
  ).rows;

describe("WhatsApp through the Company OS model layer", () => {
  it("routes a registered test device's message through the agent's authorized pool on the gateway, then Jev in shadow", async () => {
    const clinic = await buildClinic(owner, TENANT_A, TARGET, "test", [
      TEST_DEVICE,
    ]);
    await admin.query(
      `select ops.record_agent_profile($1, $2, 'Triage test enquiries for a person to review.',
         array['lead_triage'], array['test'], 1000000, 'America/Sao_Paulo',
         '{"lead_triage": "reception_low_cost"}'::jsonb, 'dbtest')`,
      [TENANT_A, clinic.agentId],
    );
    const { provider, decisions, registry } = runtime();

    const answer = await deliver(
      gateway,
      metaPayload(TARGET, {
        messages: [
          {
            id: "wamid.GW0909",
            from: TEST_DEVICE,
            body: "Oi, quanto custa a primeira conversa?",
          },
        ],
      }),
    );
    expect(answer.status).toBe(200);
    await drain(registry);

    const [row] = await inbound();
    expect(row).toMatchObject({
      data_class: "test",
      run_status: "succeeded",
      provider: GATEWAY,
      model: CHEAP,
    });
    // One call, on the lowest-rank authorized candidate; no model named in code.
    expect(provider.calls.map((call) => call.model)).toEqual([CHEAP]);
    const { rows: routes } = await admin.query<{
      model_pool: string;
      candidates: { model: string }[];
      provider_route: string | null;
      reported_cost_micros: string | null;
    }>(
      "select model_pool, candidates, provider_route, reported_cost_micros from ops.agent_run_routes where agent_run_id = $1",
      [row.agent_run_id],
    );
    expect(routes[0].model_pool).toBe("reception_low_cost");
    expect(routes[0].candidates.map((c) => c.model)).toEqual([CHEAP, STRONG]);
    expect(routes[0].provider_route).toBe("OpenAI");
    expect(Number(routes[0].reported_cost_micros)).toBe(191);

    // The three shadow decisions ran, each once; the message text reached the
    // business decision only (as for synthetic data), never lead intelligence.
    const { rows: kinds } = await admin.query<{
      decision_kind: string;
      status: string;
    }>(
      "select decision_kind, status from ops.structured_decisions where tenant_id = $1 order by decision_kind",
      [TENANT_A],
    );
    expect(kinds.map((k) => [k.decision_kind, k.status])).toEqual([
      ["business_route", "completed"],
      ["lead_intelligence", "completed"],
      ["model_route", "completed"],
    ]);
    expect(decisions.asked).toHaveLength(3);
    const lead = decisions.asked.find(
      (r) => "commercial_readiness" in r.questions,
    )!;
    expect(JSON.stringify(lead.state)).not.toMatch(/custa|conversa/);

    // Nothing is sent: accepting a review is a separate, human act.
    const { rows: outbound } = await admin.query<{ count: string }>(
      "select count(*)::text as count from ops.outbound_messages where tenant_id = $1",
      [TENANT_A],
    );
    expect(outbound[0].count).toBe("0");
  });

  it("refuses any other number's message as health data before any model or decision (Q8)", async () => {
    await buildClinic(owner, TENANT_A, TARGET, "test", [TEST_DEVICE]);
    const { provider, decisions, registry } = runtime();

    const answer = await deliver(
      gateway,
      metaPayload(TARGET, {
        messages: [
          {
            id: "wamid.GW0910",
            from: UNREGISTERED,
            body: "Mensagem de um numero nao registrado.",
          },
        ],
      }),
    );
    expect(answer.status).toBe(200);
    await drain(registry);

    const [row] = await inbound();
    expect(row.data_class).toBe("health");
    expect(row.run_status).not.toBe("succeeded");
    expect(row.error_code).toBe("data_not_authorized");
    expect(row.provider).toBeNull();
    expect(provider.calls).toHaveLength(0);
    expect(decisions.asked).toHaveLength(0);
    const { rows } = await admin.query<{ count: string }>(
      "select count(*)::text as count from ops.structured_decisions where tenant_id = $1 and status <> 'refused'",
      [TENANT_A],
    );
    expect(rows[0].count).toBe("0");
  });
});
