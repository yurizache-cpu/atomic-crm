// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ModelError } from "../models/errors.ts";
import type {
  StructuredDecisionGateway,
  StructuredDecisionRequest,
} from "../decision/structured/types.ts";
import type { StructuredDecisionSettlement } from "../worker/capabilities.ts";
import { SecurityError } from "../worker/failures.ts";
import type { LeasedJob } from "../worker/job.ts";
import {
  createStructuredDecisionEvaluateHandler,
  STRUCTURED_DECISION_EVALUATE_KIND,
} from "./structuredDecisionEvaluate.ts";

const DECISION_ID = "11111111-2222-4333-8444-555555555555";

const jobFor = (id: unknown = DECISION_ID): LeasedJob =>
  ({
    id: "99999999-2222-4333-8444-555555555555",
    tenant_id: "aaaaaaaa-2222-4333-8444-555555555555",
    kind: STRUCTURED_DECISION_EVALUATE_KIND,
    payload: { structured_decision_id: id },
    attempts: 1,
    max_attempts: 3,
  }) as unknown as LeasedJob;

const businessStart = (overrides: Record<string, unknown> = {}) => ({
  status: "running",
  decisionId: DECISION_ID,
  kind: "business_route",
  questionSet: "business_routing.v1",
  model: "typesafe/jev-1.13",
  acceptedBuilds: ["typesafe/jev-1.13-20260917"],
  input: {
    sourceClass: "synthetic",
    message: "Oi, queria saber valores. ana@example.com",
    departments: ["reception"],
    capabilities: ["lead_triage", "task_assessment"],
  },
  spec: {
    intent: {
      type: "choice",
      options: [
        "new_lead",
        "pricing_question",
        "scheduling",
        "rescheduling",
        "cancellation",
        "existing_client_admin",
        "payment_question",
        "follow_up",
        "unknown",
      ],
    },
    department: {
      type: "choice",
      options: ["reception", "human_review", "no_action"],
    },
    capability: {
      type: "choice",
      options: ["lead_triage", "task_assessment", "none"],
    },
    complexity: { type: "score", levels: 3 },
    human_review: { type: "noul" },
  },
  ...overrides,
});

const ANSWERS = {
  intent: { type: "choice", choice: "pricing_question", confidence: 0.8 },
  department: { type: "choice", choice: "reception" },
  capability: { type: "choice", choice: "lead_triage" },
  complexity: { type: "score", score: 0.3 },
  human_review: { type: "noul", noul: 0.1 },
};

const gatewayAnswering = (answers: unknown) => {
  const requests: StructuredDecisionRequest[] = [];
  const gateway: StructuredDecisionGateway = {
    name: "openrouter",
    decide: vi.fn(async (request: StructuredDecisionRequest) => {
      requests.push(request);
      return {
        gateway: "openrouter",
        model: "typesafe/jev-1.13-20260917",
        providerRoute: "TypeSafe",
        responseId: "gen-dec-1",
        answers,
        inputTokens: 400,
        outputTokens: 30,
        reportedCostMicros: 17,
        latencyMs: 380,
      };
    }),
  };
  return { gateway, requests };
};

const run = async (
  gateway: StructuredDecisionGateway,
  start: unknown,
  job: LeasedJob = jobFor(),
) => {
  const handler = createStructuredDecisionEvaluateHandler({ gateway });
  const startStructuredDecision = vi.fn(async () => start);
  const settlements: StructuredDecisionSettlement[] = [];
  const settleStructuredDecision = vi.fn(
    async (s: StructuredDecisionSettlement) => {
      settlements.push(s);
      return s.outcome;
    },
  );
  const prepared = await handler.prepare(
    job,
    { startStructuredDecision },
    {
      callBudgetMs: 10_000,
      remainingMs: () => 10_000,
    },
  );
  if (prepared.kind !== "call")
    return { prepared, settlements, startStructuredDecision };
  let outcome;
  try {
    outcome = {
      ok: true as const,
      value: await handler.call(prepared.state, {
        signal: new AbortController().signal,
        deadline: Date.now() + 10_000,
      }),
      durationMs: 5,
    };
  } catch (error) {
    outcome = { ok: false as const, error, durationMs: 5 };
  }
  const detail = await handler.settle(prepared.state, outcome, {
    settleStructuredDecision,
  });
  return { prepared, settlements, detail, startStructuredDecision };
};

describe("decision.structured_evaluate", () => {
  it("asks the decision model the database named, once, and stores the typed answers with usage", async () => {
    const { gateway, requests } = gatewayAnswering(ANSWERS);
    const { settlements, startStructuredDecision } = await run(
      gateway,
      businessStart(),
    );
    expect(startStructuredDecision).toHaveBeenCalledWith("openrouter");
    expect(gateway.decide).toHaveBeenCalledTimes(1);
    expect(requests[0].model).toBe("typesafe/jev-1.13");
    expect(requests[0].acceptedResponseModels).toEqual([
      "typesafe/jev-1.13-20260917",
    ]);
    expect(String(requests[0].state.message)).not.toContain("ana@example.com");
    expect(settlements[0]).toMatchObject({
      outcome: "completed",
      servedModel: "typesafe/jev-1.13-20260917",
      inputTokens: 400,
      outputTokens: 30,
      reportedCostMicros: 17,
      providerRoute: "TypeSafe",
      errorCode: null,
    });
  });

  it("asks nobody when the questions it would build do not match the recorded spec", async () => {
    const { gateway } = gatewayAnswering(ANSWERS);
    const start = businessStart({
      spec: {
        ...businessStart().spec,
        department: { type: "choice", options: ["finance"] },
      },
    });
    const { settlements } = await run(gateway, start);
    expect(gateway.decide).not.toHaveBeenCalled();
    expect(settlements[0]).toMatchObject({
      outcome: "failed",
      errorCode: "question_spec_mismatch",
    });
  });

  it("stores unusable answers as invalid, never coerced", async () => {
    const { gateway } = gatewayAnswering({
      ...ANSWERS,
      department: { type: "choice", choice: "finance" },
    });
    const { settlements } = await run(gateway, businessStart());
    expect(settlements[0]).toMatchObject({
      outcome: "invalid",
      answers: null,
      errorCode: "answers_rejected",
    });
  });

  it.each([
    [
      new ModelError("configuration", { code: "insufficient_credits" }),
      "failed",
      "insufficient_credits",
    ],
    [
      new ModelError("transport", { code: "network" }),
      "indeterminate",
      "network",
    ],
    [
      new ModelError("provider_5xx", { code: "http_503" }),
      "indeterminate",
      "http_503",
    ],
  ])(
    "settles a gateway failure by its category (%s)",
    async (error, outcome, code) => {
      const gateway: StructuredDecisionGateway = {
        name: "openrouter",
        decide: vi.fn(async () => {
          throw error;
        }),
      };
      const { settlements } = await run(gateway, businessStart());
      expect(settlements[0]).toMatchObject({
        outcome,
        errorCode: code,
        answers: null,
      });
    },
  );

  it("holds under a stop and settles a refusal without asking", async () => {
    const { gateway } = gatewayAnswering(ANSWERS);
    expect(
      (await run(gateway, { status: "stopped", decisionId: DECISION_ID }))
        .prepared.kind,
    ).toBe("held");
    const refused = await run(gateway, {
      status: "refused",
      decisionId: DECISION_ID,
      refusalCode: "data_not_authorized",
    });
    expect(refused.prepared.kind).toBe("settled");
    expect(gateway.decide).not.toHaveBeenCalled();
  });

  it("refuses a job whose lease names another decision", async () => {
    const { gateway } = gatewayAnswering(ANSWERS);
    await expect(
      run(
        gateway,
        businessStart({ decisionId: "00000000-2222-4333-8444-555555555555" }),
      ),
    ).rejects.toBeInstanceOf(SecurityError);
  });
});
