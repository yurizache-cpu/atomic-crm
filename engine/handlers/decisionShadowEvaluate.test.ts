import { describe, expect, it, vi } from "vitest";

import {
  DecisionProviderUnavailableError,
  type DecisionPort,
} from "../decision/decisionPort.ts";
import {
  FAKE_DECISION_PROVIDER,
  createFakeDecisionProvider,
} from "../decision/fakeDecisionProvider.ts";
import type {
  ShadowDecisionProvider,
  ShadowDecisionSettlement,
} from "../worker/capabilities.ts";
import { PermanentError, SecurityError } from "../worker/failures.ts";
import type { LeasedJob } from "../worker/job.ts";
import {
  DECISION_SHADOW_EVALUATE_KIND,
  createDecisionShadowEvaluateHandler,
} from "./decisionShadowEvaluate.ts";

// The shadow decision handler (Phase 2D.1) over stub capabilities: what it
// asks the database to start, what it hands the provider, and what it settles
// for every kind of answer. It never decides a review: it holds only the two
// shadow decision capabilities and declares no post-settlement step.

const EVALUATION = "00000000-0000-4000-8000-00000000d001";
const FINGERPRINT = `sha256:${"c".repeat(64)}`;
const INPUT = {
  version: "decision_input.v1",
  subject: "lead_triage.review",
  sourceClass: "synthetic",
  contactPolicy: "contactable",
  triage: {
    outcome: "triaged",
    intent: "book_appointment",
    priority: "normal",
    flags: [],
    needsHumanReview: true,
  },
};

const job = (
  payload: unknown = { decision_evaluation_id: EVALUATION },
): LeasedJob => ({
  id: "00000000-0000-4000-8000-00000000j001",
  tenant_id: "00000000-0000-4000-8000-00000000t001",
  kind: DECISION_SHADOW_EVALUATE_KIND,
  payload,
  attempts: 1,
  max_attempts: 3,
});

const budget = { callBudgetMs: 30_000, remainingMs: () => 30_000 };
const context = {
  signal: new AbortController().signal,
  deadline: Date.now() + 30_000,
};

const running = (overrides: Record<string, unknown> = {}) => ({
  status: "running",
  evaluationId: EVALUATION,
  inputFingerprint: FINGERPRINT,
  input: INPUT,
  vectorVersion: "decision_vector.v2",
  ...overrides,
});

function scripted(start: unknown, settleStatus = "completed") {
  const started: ShadowDecisionProvider[] = [];
  const settled: ShadowDecisionSettlement[] = [];
  return {
    started,
    settled,
    prepare: {
      startShadowDecision: vi.fn(async (provider: ShadowDecisionProvider) => {
        started.push(provider);
        return start;
      }),
    },
    settle: {
      settleShadowDecision: vi.fn(
        async (settlement: ShadowDecisionSettlement) => {
          settled.push(settlement);
          return settleStatus;
        },
      ),
    },
  };
}

/** prepare, call and settle, as the external-call runtime runs them. */
async function runOnce(
  port: DecisionPort,
  start: unknown,
  settleStatus?: string,
) {
  const handler = createDecisionShadowEvaluateHandler({ decisionPort: port });
  const caps = scripted(start, settleStatus);
  const prepared = await handler.prepare(job(), caps.prepare, budget);
  if (prepared.kind !== "call") return { prepared, caps };
  let outcome;
  try {
    outcome = {
      ok: true as const,
      value: await handler.call(prepared.state, context),
      durationMs: 1,
    };
  } catch (error) {
    outcome = { ok: false as const, error, durationMs: 1 };
  }
  const detail = await handler.settle(prepared.state, outcome, caps.settle);
  return { prepared, caps, detail };
}

const fake = createFakeDecisionProvider({
  now: () => new Date("2026-09-24T12:00:00.000Z"),
});
const answering = (value: unknown): DecisionPort => ({
  identity: FAKE_DECISION_PROVIDER,
  evaluate: async () => value,
});

describe("the decision.shadow_evaluate handler", () => {
  it("is an external call holding only the two shadow decision capabilities, with no step after it", () => {
    const handler = createDecisionShadowEvaluateHandler({ decisionPort: fake });

    expect(handler.shape).toBe("external_call");
    expect([...handler.prepareCapabilities]).toEqual(["startShadowDecision"]);
    expect([...handler.settleCapabilities]).toEqual(["settleShadowDecision"]);
    expect(handler.afterSettlement).toBeUndefined();
  });

  it("starts with the provider's identity, asks it the allowlisted input, and stores the valid vector", async () => {
    const evaluate = vi.fn(fake.evaluate);
    const { caps, detail } = await runOnce({ ...fake, evaluate }, running());

    expect(caps.started).toEqual([FAKE_DECISION_PROVIDER]);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0][0]).toEqual({
      input: INPUT,
      inputFingerprint: FINGERPRINT,
    });
    expect(caps.settled).toEqual([
      expect.objectContaining({
        outcome: "completed",
        errorCode: null,
        vector: expect.objectContaining({
          recommendation: "accept",
          confidence: 0.82,
        }),
      }),
    ]);
    expect(detail).toBe(`decision_evaluation=${EVALUATION} status=completed`);
  });

  it("holds the job under a stop, and settles anything but running without asking the provider", async () => {
    const evaluate = vi.fn();
    const port = { identity: FAKE_DECISION_PROVIDER, evaluate };

    const held = await runOnce(port, {
      status: "stopped",
      evaluationId: EVALUATION,
    });
    expect(held.prepared).toEqual({ kind: "held" });
    for (const status of ["indeterminate", "refused", "completed", "failed"]) {
      const { prepared } = await runOnce(port, {
        status,
        evaluationId: EVALUATION,
      });
      expect(prepared).toEqual({
        kind: "settled",
        detail: `decision_evaluation=${EVALUATION} status=${status}`,
      });
    }
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("refuses a job whose lease is bound to another evaluation, or to none", async () => {
    await expect(
      runOnce(
        fake,
        running({ evaluationId: "00000000-0000-4000-8000-00000000d002" }),
      ),
    ).rejects.toBeInstanceOf(SecurityError);
    await expect(runOnce(fake, { status: "missing" })).rejects.toBeInstanceOf(
      SecurityError,
    );
    const handler = createDecisionShadowEvaluateHandler({ decisionPort: fake });
    await expect(
      handler.prepare(job({}), scripted(running()).prepare, budget),
    ).rejects.toBeInstanceOf(PermanentError);
  });

  it.each([
    ["an unknown recommendation", { recommendation: "approve" }],
    ["confidence above 1", { confidence: 1.5 }],
    ["prose reasoning", { reasoning: "the lead seems fine" }],
    [
      "another provider's name",
      { provider: { kind: "jev", id: "jev", version: "1" } },
    ],
    [
      "another input's fingerprint",
      { inputFingerprint: `sha256:${"d".repeat(64)}` },
    ],
  ])(
    "stores an answer with %s as invalid, never as a recommendation",
    async (_label, change) => {
      const valid = await fake.evaluate(
        { input: INPUT as never, inputFingerprint: FINGERPRINT },
        { signal: context.signal },
      );
      const { caps } = await runOnce(
        answering({ ...(valid as object), ...change }),
        running(),
        "invalid",
      );

      expect(caps.settled).toEqual([
        { outcome: "invalid", vector: null, errorCode: "vector_rejected" },
      ]);
    },
  );

  it("settles a provider that was never reached as failed, and any other failure as indeterminate", async () => {
    const unreachable: DecisionPort = {
      identity: FAKE_DECISION_PROVIDER,
      evaluate: async () => {
        throw new DecisionProviderUnavailableError("jev_contract_not_approved");
      },
    };
    const exploding: DecisionPort = {
      identity: FAKE_DECISION_PROVIDER,
      evaluate: async () => {
        throw new Error("socket hang up");
      },
    };

    const failed = await runOnce(unreachable, running(), "failed");
    const unknown = await runOnce(exploding, running(), "indeterminate");

    expect(failed.caps.settled).toEqual([
      {
        outcome: "failed",
        vector: null,
        errorCode: "jev_contract_not_approved",
      },
    ]);
    expect(unknown.caps.settled).toEqual([
      { outcome: "indeterminate", vector: null, errorCode: "provider_error" },
    ]);
  });

  it("asks nothing when the database's input fails this worker's schema", async () => {
    const evaluate = vi.fn();
    const { caps } = await runOnce(
      { identity: FAKE_DECISION_PROVIDER, evaluate },
      running({ input: { ...INPUT, body: "raw message" } }),
      "failed",
    );

    expect(evaluate).not.toHaveBeenCalled();
    expect(caps.settled).toEqual([
      { outcome: "failed", vector: null, errorCode: "input_rejected" },
    ]);
  });

  it.each([
    ["the retired v1", "decision_vector.v1"],
    ["an unknown", "decision_vector.v3"],
    ["no", undefined],
  ])(
    "asks nothing when the policy wants %s vector version",
    async (_label, vectorVersion) => {
      const evaluate = vi.fn();
      const { caps } = await runOnce(
        { identity: FAKE_DECISION_PROVIDER, evaluate },
        running({ vectorVersion }),
        "failed",
      );

      expect(evaluate).not.toHaveBeenCalled();
      expect(caps.settled).toEqual([
        {
          outcome: "failed",
          vector: null,
          errorCode: "vector_version_unsupported",
        },
      ]);
    },
  );

  it("refuses a settlement the database says is not this attempt's", async () => {
    await expect(
      runOnce(fake, running(), "not_running"),
    ).rejects.toBeInstanceOf(PermanentError);
  });
});
