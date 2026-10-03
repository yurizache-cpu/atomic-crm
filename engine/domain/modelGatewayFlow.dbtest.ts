// ADR 0022, end to end through the REAL worker runtime and the real database,
// with only the network replaced: a gateway named "openrouter" (in process)
// and a scripted structured-decision gateway.
//
//   synthetic enquiry -> lead_triage run -> the database lists the run's
//   AUTHORIZED candidates -> the worker starts the lowest-rank one -> one call
//   -> the route and the gateway's report are recorded -> after settlement the
//   structured decisions (business route, lead intelligence, model-route
//   advice) are requested and run, each once, shadow only -> their cost counts
//   in the daily window -> the economics read sees it all.
//
// And the failure shapes the owner listed, each predictable: no authorized
// candidate, a disabled model, protected data, a stop, a gateway that fails.
// Synthetic data only.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import type {
  StructuredDecisionGateway,
  StructuredDecisionRequest,
} from "../decision/structured/types.ts";
import { ModelError } from "../models/errors.ts";
import { createFakeModelProvider } from "../models/fakeModelProvider.ts";
import {
  LEAD_TRIAGE_CAPABILITY,
  type LeadTriage,
} from "../models/leadTriage.ts";
import { createModelRouter } from "../models/router.ts";
import { createHandlerRegistry } from "../worker/registry.ts";
import {
  registerFixtureModel,
  removeFixtureModels,
  resetFixtures,
  TENANT_A,
} from "../worker/testSupport/dbFixture.ts";
import { requestAgentRun } from "./agentRuns.ts";
import type { DataClass } from "./dataClasses.ts";
import { clearExecutionStop, tripExecutionStop } from "./executionStops.ts";
import {
  assignTask,
  createAgent,
  createCompany,
  createDepartment,
  createTask,
} from "./companyOs.ts";
import {
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  openAgentRuntimeDatabases,
} from "./testSupport/agentRuntimeProbes.ts";

const SOURCE = "dbtest-gateway";
const GATEWAY = "openrouter";
const CHEAP = "dbtest/cheap";
const STRONG = "dbtest/strong";
const DECIDER = "dbtest/decider-1";
const MODELS = [CHEAP, STRONG, DECIDER].map((model) => ({
  gateway: GATEWAY,
  model,
}));

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

beforeAll(() => {
  ({ admin, owner, db } = openAgentRuntimeDatabases());
}, 60_000);

afterAll(async () => {
  await removeFixtureModels(admin, MODELS);
  await closeAgentRuntimeDatabases({ admin, owner, db });
});

const { runAgentJob } = agentRuntimeProbes(() => ({ admin, owner, db }));

const price = (model: string, input: number, output: number) =>
  admin.query(
    `select ops.record_model_price($1, $2, $3, $4, true, now() - interval '1 hour',
                                   now() + interval '1 day', 'dbtest gateway price', 'dbtest')`,
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

/** Answers each question set it is asked, exactly as asked. */
const decisionsGateway = (
  options: { readonly department?: string; readonly fail?: ModelError } = {},
) => {
  const asked: StructuredDecisionRequest[] = [];
  const gateway: StructuredDecisionGateway = {
    name: GATEWAY,
    decide: async (request) => {
      asked.push(request);
      if (options.fail) throw options.fail;
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(request.questions)) {
        if (question.type === "noul")
          answers[key] = { type: "noul", noul: 0.2 };
        if (question.type === "score")
          answers[key] = { type: "score", score: 0.4, confidence: 0.7 };
        if (question.type === "choice") {
          const options_ = Object.keys(question.criteria);
          const choice =
            key === "department" &&
            options.department &&
            options_.includes(options.department)
              ? options.department
              : options_[0];
          answers[key] = { type: "choice", choice, confidence: 0.6 };
        }
      }
      return {
        gateway: GATEWAY,
        model: request.model,
        providerRoute: "TypeSafe",
        responseId: "gen-dec-dbtest",
        answers,
        inputTokens: 300,
        outputTokens: 20,
        reportedCostMicros: 13,
        latencyMs: 400,
      };
    },
  };
  return { gateway, asked };
};

const runtime = (decisions = decisionsGateway()) => {
  const provider = createFakeModelProvider(
    { type: "respond", content: ADVICE },
    { name: GATEWAY },
  );
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
  return { provider, registry, decisions };
};

const buildLead = (dataClass: DataClass, body: string) =>
  owner.withTransaction(async (tx) => {
    const ctx = { tenantId: TENANT_A, source: SOURCE };
    const companyId = await createCompany(tx, ctx, {
      slug: "dbtest-gw-clinic",
      name: "Clinic",
    });
    const departmentId = await createDepartment(tx, ctx, {
      companyId,
      slug: "reception",
      name: "Reception",
    });
    const agentId = await createAgent(tx, ctx, {
      companyId,
      departmentId,
      slug: "receptionist",
      name: "Receptionist",
      role: "Receptionist",
    });
    const taskId = await createTask(tx, ctx, {
      companyId,
      type: LEAD_TRIAGE_CAPABILITY,
      title: "Lead triage",
      description: body,
      dataClass,
    });
    await assignTask(tx, ctx, taskId, agentId);
    return { companyId, departmentId, agentId, taskId };
  });

const request = (lead: { taskId: string; agentId: string }, key: string) =>
  owner.withTransaction((tx) =>
    requestAgentRun(
      tx,
      { tenantId: TENANT_A, source: SOURCE },
      {
        taskId: lead.taskId,
        agentId: lead.agentId,
        capability: LEAD_TRIAGE_CAPABILITY,
        idempotencyKey: key,
      },
    ),
  );

const readRun = async (runId: string) =>
  (
    await admin.query<{
      status: string;
      error_code: string | null;
      provider: string | null;
      model: string | null;
      charged_cost_micros: string | null;
    }>(
      "select status, error_code, provider, model, charged_cost_micros from ops.agent_runs where id = $1",
      [runId],
    )
  ).rows[0];

const readRoute = async (runId: string) =>
  (
    await admin.query<{
      model_pool: string;
      gateway: string;
      model: string;
      candidates: { model: string }[];
      provider_route: string | null;
    }>(
      "select model_pool, gateway, model, candidates, provider_route from ops.agent_run_routes where agent_run_id = $1",
      [runId],
    )
  ).rows[0];

const readDecisions = async () =>
  (
    await admin.query<{
      decision_kind: string;
      status: string;
      refusal_code: string | null;
      error_code: string | null;
      answers: Record<string, { choice?: string }> | null;
      deterministic_route: Record<string, string> | null;
      charged_cost_micros: string | null;
      model: string | null;
    }>(
      `select decision_kind, status, refusal_code, error_code, answers, deterministic_route,
              charged_cost_micros, model
         from ops.structured_decisions where tenant_id = $1 order by decision_kind`,
      [TENANT_A],
    )
  ).rows;

/** Runs the queue until nothing is left (bounded). */
const drain = async (
  registry: ReturnType<typeof runtime>["registry"],
  limit = 8,
) => {
  for (let i = 0; i < limit; i += 1) {
    const result = await runAgentJob(registry);
    if (result.outcome === "idle") return;
  }
};

describe("case A: a new synthetic lead goes to reception, on the cheapest authorized model", () => {
  it("routes, executes once, records the route and the gateway report, then runs three shadow decisions", async () => {
    const { provider, registry, decisions } = runtime();
    const lead = await buildLead(
      "synthetic",
      "Oi, vi seu site e queria saber como funcionam os atendimentos e valores.",
    );
    const runId = await request(lead, "dbtest-gw-a");
    await drain(registry);

    const run = await readRun(runId);
    expect(run).toMatchObject({
      status: "succeeded",
      provider: GATEWAY,
      model: CHEAP,
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].model).toBe(CHEAP);

    const route = await readRoute(runId);
    expect(route.model_pool).toBe("reception_low_cost");
    expect(route.candidates.map((c) => c.model)).toEqual([CHEAP, STRONG]);

    const rows = await readDecisions();
    expect(rows.map((r) => [r.decision_kind, r.status])).toEqual([
      ["business_route", "completed"],
      ["lead_intelligence", "completed"],
      ["model_route", "completed"],
    ]);
    const business = rows.find((r) => r.decision_kind === "business_route")!;
    expect(business.deterministic_route).toMatchObject({
      department: "reception",
      capability: "lead_triage",
    });
    expect(business.model).toBe(DECIDER);
    // Three questions sets asked, each once, and the lead state carries no message.
    expect(decisions.asked).toHaveLength(3);
    const lead_ = decisions.asked.find(
      (r) => "commercial_readiness" in r.questions,
    )!;
    expect(JSON.stringify(lead_.state)).not.toMatch(
      /atendimentos|valores|site/,
    );
    // The decision costs count in the daily spend window.
    const { rows: spend } = await admin.query<{ p_charged: string }>(
      "select p_charged from ops.spend_window_total('tenant', $1, null, now() - interval '1 day')",
      [TENANT_A],
    );
    const decisionCost = rows.reduce(
      (sum, r) => sum + Number(r.charged_cost_micros ?? 0),
      0,
    );
    expect(Number(spend[0].p_charged)).toBe(
      Number(run.charged_cost_micros) + decisionCost,
    );

    // The economics read sees the run on its model and the routing counterfactual.
    const { rows: econ } = await admin.query<{ e: Record<string, unknown> }>(
      "select ops.model_economics($1, now() - interval '1 day') as e",
      [TENANT_A],
    );
    expect(econ[0].e).toMatchObject({ runs: 1, decisions: { count: 3 } });
    expect(
      (econ[0].e.routingEconomics as { routedRuns: number }).routedRuns,
    ).toBe(1);
  });
});

describe("case B: a demand outside reception is recorded as Jev would route it, without changing execution", () => {
  it("records human_review as Jev's department while the deterministic route stays reception", async () => {
    const { registry } = runtime(
      decisionsGateway({ department: "human_review" }),
    );
    const lead = await buildLead(
      "synthetic",
      "Preciso cancelar e quero reembolso de uma cobrança.",
    );
    await request(lead, "dbtest-gw-b");
    await drain(registry);
    const business = (await readDecisions()).find(
      (r) => r.decision_kind === "business_route",
    )!;
    expect(business.status).toBe("completed");
    expect(business.answers?.department?.choice).toBe("human_review");
    expect(business.deterministic_route?.department).toBe("reception");
  });
});

describe("failures are predictable", () => {
  it("refuses the run when no authorized candidate exists (every pool model disabled), calling nothing", async () => {
    await admin.query(
      `update ops.model_registry set enabled = false, changed_by = 'dbtest', change_reason = 'dbtest'
        where gateway = $1 and model = any($2)`,
      [GATEWAY, [CHEAP, STRONG]],
    );
    const { provider, registry } = runtime();
    const lead = await buildLead("synthetic", "Oi, quanto custa?");
    const runId = await request(lead, "dbtest-gw-none");
    await drain(registry);
    expect(await readRun(runId)).toMatchObject({
      status: "failed",
      error_code: "gateway_candidate_unavailable",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("refuses health data before any request reaches a job, and no decision reaches Jev", async () => {
    const { provider, registry, decisions } = runtime();
    const lead = await buildLead(
      "health",
      "Texto sintético tratado como saúde.",
    );
    const runId = await request(lead, "dbtest-gw-health");
    await drain(registry);
    expect(await readRun(runId)).toMatchObject({
      status: "cancelled",
      error_code: "data_not_authorized",
    });
    expect(provider.calls).toHaveLength(0);
    expect(decisions.asked).toHaveLength(0);
  });

  it("holds every decision job under a kill switch, and runs it once cleared", async () => {
    const { registry, decisions } = runtime();
    const lead = await buildLead("synthetic", "Oi, quero agendar.");
    await request(lead, "dbtest-gw-stop");
    await runAgentJob(registry); // the run, then the decisions are queued
    const stopId = await owner.withTransaction((tx) =>
      tripExecutionStop(
        tx,
        { scope: "tenant", tenantId: TENANT_A },
        { reason: "dbtest gateway stop", actor: "dbtest" },
      ),
    );
    await drain(registry);
    expect(decisions.asked).toHaveLength(0);
    await owner.withTransaction((tx) =>
      clearExecutionStop(tx, stopId, {
        reason: "dbtest cleanup",
        actor: "dbtest",
      }),
    );
    await drain(registry);
    expect(decisions.asked.length).toBeGreaterThan(0);
  });

  it("settles a decision gateway that refuses for credits as failed, and one that times out as indeterminate", async () => {
    for (const [error, status] of [
      [
        new ModelError("configuration", { code: "insufficient_credits" }),
        "failed",
      ],
      [new ModelError("timeout", { code: "deadline" }), "indeterminate"],
    ] as const) {
      await resetFixtures(admin);
      await price(CHEAP, 0.1, 0.5);
      await price(STRONG, 2, 10);
      await price(DECIDER, 0.042, 0);
      const { registry } = runtime(decisionsGateway({ fail: error }));
      const lead = await buildLead("synthetic", "Oi.");
      await request(lead, `dbtest-gw-fail-${status}`);
      await drain(registry);
      const rows = await readDecisions();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.status === status)).toBe(true);
    }
  });
});
