// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  agentRunStatusForCategory,
  MODEL_ERROR_CATEGORIES,
  type ModelErrorCategory,
} from "../models/errors.ts";
import {
  createFakeModelProvider,
  type FakeBehavior,
} from "../models/fakeModelProvider.ts";
import { fingerprintModelRequest } from "../models/fingerprint.ts";
import {
  createModelRouter,
  MODEL_ROUTE_POLICIES,
  type ModelRouter,
  type StructuredModelResult,
} from "../models/router.ts";
import {
  TASK_ASSESSMENT_PROMPT_VERSION,
  type TaskAssessment,
} from "../models/taskAssessment.ts";
import type { AgentRunResult } from "../models/capabilityContracts.ts";
import type { ModelProvider } from "../models/types.ts";
import type {
  AgentRunCompletion,
  AgentRunFailure,
  AgentRunStart,
} from "../worker/capabilities.ts";
import { settlementDetail } from "../worker/handlerRegistry.ts";
import {
  PermanentError,
  SecurityError,
  TransientError,
} from "../worker/failures.ts";
import type {
  CallOutcome,
  ExternalCallContext,
} from "../worker/handlerRegistry.ts";
import type { LeasedJob } from "../worker/job.ts";
import {
  createHandlerRegistry,
  REGISTERED_HANDLER_KINDS,
} from "../worker/registry.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import {
  AGENT_RUN_EXECUTE_KIND,
  createAgentRunExecuteHandler,
  MIN_CALL_BUDGET_MS,
  type AgentRunExecuteHandler,
} from "./agentRunExecute.ts";

// The runtime's database port, named through runOneJob's signature: code under
// engine/handlers, tests included, does not import engine/db.
type WorkerDatabase = Parameters<typeof runOneJob>[0];
type TxClient = Parameters<Parameters<WorkerDatabase["withTransaction"]>[0]>[0];

// The handler is driven phase by phase with fake capabilities and a REAL router
// over the fake provider, so every model behaviour below is the router's actual
// behaviour and every provider call is counted. The last group runs the same
// handler through the real runtime (runOneJob) over a scripted database, to
// prove the capability SQL, the transaction boundaries and the runtime's
// signal reach it as the phase-by-phase tests assume.
//
// What the driver-backed suite proves instead (engine/domain/agentRunRuntime.dbtest.ts,
// which lives in engine/domain because only there may a test import the domain,
// the worker runtime and the database together): what the database does with
// these calls, through real worker processes.

const RUN_ID = "0f2d5c8e-6b1a-4c3e-9d7f-1a2b3c4d5e6f";
const STOP_ID = "5a0e2c1d-7b3f-4e8a-9c6d-2f1e0d3c4b5a";
const OTHER_RUN_ID = "9b2e4f1a-3c5d-4e6f-8a7b-0c1d2e3f4a5b";
const TENANT_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER_TENANT_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const JOB_ID = "11111111-1111-1111-1111-111111111111";
const MODEL = "fake-model-1";

const VALID: TaskAssessment = {
  outcome: "completed",
  summary: "Order the usual supplies before Friday.",
  proposed_next_steps: ["Check the stock list.", "Place the order."],
};

const jobFor = (payload: unknown = { agent_run_id: RUN_ID }): LeasedJob => ({
  id: JOB_ID,
  tenant_id: TENANT_ID,
  kind: AGENT_RUN_EXECUTE_KIND,
  payload,
  attempts: 1,
  max_attempts: 5,
});

const AGENT = {
  name: "Office assistant",
  role: "operations",
  description: "Keeps the office stocked.",
};

const TASK = {
  type: "operations.supply_order",
  title: "Prepare next week's office supply order",
  description: "Paper, toner and coffee are running low.",
  priority: 100,
  due_at: "2026-09-21T12:00:00+00:00",
};

const startClaim = (overrides: Record<string, unknown> = {}) => ({
  action: "start",
  agent_run_id: RUN_ID,
  capability: "task_assessment",
  model_route: "standard",
  agent: AGENT,
  task: TASK,
  ...overrides,
});

const routerOver = (provider: ModelProvider): ModelRouter =>
  createModelRouter({
    routes: new Map([["standard", { provider: provider.name, model: MODEL }]]),
    providers: new Map([[provider.name, provider]]),
  });

interface CapabilityScript {
  readonly claim?: unknown;
  readonly start?: string;
  /** Thrown by startAgentRun instead of answering, as a raising start does. */
  readonly startError?: Error;
  readonly refuse?: string;
  readonly complete?: string;
  readonly fail?: string;
}

/** Fake capabilities that record the order they were used in. */
const fakeCapabilities = (script: CapabilityScript = {}) => {
  const used: string[] = [];
  const claimAgentRun = vi.fn(async () => {
    used.push("claimAgentRun");
    return "claim" in script ? script.claim : startClaim();
  });
  const startAgentRun = vi.fn(async (_start: AgentRunStart) => {
    used.push("startAgentRun");
    if (script.startError) throw script.startError;
    return script.start ?? "running";
  });
  const refuseAgentRun = vi.fn(async (_code: string) => {
    used.push("refuseAgentRun");
    return script.refuse ?? "failed";
  });
  const completeAgentRun = vi.fn(async (_completion: AgentRunCompletion) => {
    used.push("completeAgentRun");
    return script.complete ?? "succeeded";
  });
  const failAgentRun = vi.fn(async (failure: AgentRunFailure) => {
    used.push("failAgentRun");
    return (
      script.fail ??
      agentRunStatusForCategory(failure.category as ModelErrorCategory)
    );
  });
  return {
    used,
    claimAgentRun,
    startAgentRun,
    refuseAgentRun,
    completeAgentRun,
    failAgentRun,
    prepare: { claimAgentRun, startAgentRun, refuseAgentRun },
    settle: { completeAgentRun, failAgentRun },
  };
};

type FakeCapabilities = ReturnType<typeof fakeCapabilities>;

/** Any provider, with a real router and the handler over it. */
const setupOver = <P extends ModelProvider>(
  provider: P,
  script: CapabilityScript = {},
  now?: () => number,
) => {
  const modelRouter = routerOver(provider);
  const handler = createAgentRunExecuteHandler({ modelRouter, now });
  return { provider, modelRouter, handler, caps: fakeCapabilities(script) };
};

/** The scripted fake provider, whose calls are counted. */
const setup = (
  behavior: FakeBehavior,
  script: CapabilityScript = {},
  now?: () => number,
) => setupOver(createFakeModelProvider(behavior), script, now);

const idleContext = (): ExternalCallContext => ({
  signal: new AbortController().signal,
  deadline: Date.now() + 60_000,
});

/**
 * prepare -> call -> settle, sequenced as runOneJob sequences them: a call that
 * throws becomes an outcome, and settle always sees one.
 */
const runCycle = async (
  handler: AgentRunExecuteHandler,
  caps: FakeCapabilities,
  options: {
    readonly job?: LeasedJob;
    readonly callBudgetMs?: number;
    readonly remainingMs?: () => number;
    readonly context?: () => ExternalCallContext;
  } = {},
) => {
  const callBudgetMs = options.callBudgetMs ?? 30_000;
  const prepared = await handler.prepare(
    options.job ?? jobFor(),
    caps.prepare,
    { callBudgetMs, remainingMs: options.remainingMs ?? (() => callBudgetMs) },
  );
  if (prepared.kind === "settled") {
    return { prepared, detail: prepared.detail, called: false };
  }
  if (prepared.kind === "held") {
    // A held prepare completes nothing, so there is no job detail.
    return { prepared, detail: "", called: false };
  }
  const context = (options.context ?? idleContext)();
  const startedAt = Date.now();
  let outcome: CallOutcome<StructuredModelResult<AgentRunResult>>;
  try {
    const value = await handler.call(prepared.state, context);
    outcome = { ok: true, value, durationMs: Date.now() - startedAt };
  } catch (error) {
    outcome = { ok: false, error, durationMs: Date.now() - startedAt };
  }
  const settled = await handler.settle(prepared.state, outcome, caps.settle);
  return {
    prepared,
    detail: settlementDetail(settled),
    settled,
    called: true,
    outcome,
  };
};

/** The one failure the handler recorded. */
const recordedFailure = (caps: FakeCapabilities): AgentRunFailure => {
  expect(caps.failAgentRun).toHaveBeenCalledTimes(1);
  expect(caps.completeAgentRun).not.toHaveBeenCalled();
  return caps.failAgentRun.mock.calls[0][0];
};

const rejectionOf = async (promise: Promise<unknown>): Promise<Error> => {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(Error);
  return outcome as Error;
};

describe("the handler declares its shape and is registered", () => {
  it("is an external_call handler that grants prepare and settle only their own capabilities", () => {
    const { handler } = setup({ type: "respond", content: VALID });
    expect(handler.kind).toBe("agent_run.execute");
    expect(handler.shape).toBe("external_call");
    expect([...handler.prepareCapabilities]).toEqual([
      "claimAgentRun",
      "startAgentRun",
      "refuseAgentRun",
    ]);
    expect([...handler.settleCapabilities]).toEqual([
      "completeAgentRun",
      "failAgentRun",
    ]);
    expect(Object.isFrozen(handler)).toBe(true);
  });

  it("opens the review only after its settlement, never inside it", () => {
    // The review is a step of its own that follows the committed settlement
    // (engine/worker/afterSettlement.ts), so failing to open it cannot undo a
    // paid answer. No settle capability opens one.
    const { handler } = setup({ type: "respond", content: VALID });
    expect([...(handler.afterSettlement ?? [])]).toEqual(["openRunReview"]);
    expect(Object.isFrozen(handler.afterSettlement)).toBe(true);
  });

  it("is in the worker registry, and the exported kind list is exactly the registry's", () => {
    const { modelRouter } = setup({ type: "respond", content: VALID });
    const registry = createHandlerRegistry({ modelRouter });
    expect(registry.get(AGENT_RUN_EXECUTE_KIND)?.shape).toBe("external_call");
    expect([...REGISTERED_HANDLER_KINDS]).toEqual([...registry.keys()]);
    expect(Object.isFrozen(REGISTERED_HANDLER_KINDS)).toBe(true);
  });
});

describe("the job payload is data, never the run", () => {
  it("refuses a payload that does not name the claimed run, before any other capability and any call", async () => {
    for (const payload of [
      { agent_run_id: OTHER_RUN_ID },
      { agent_run_id: RUN_ID.toUpperCase() },
      {},
      null,
      RUN_ID,
      [RUN_ID],
    ]) {
      const { provider, handler, caps } = setup({
        type: "respond",
        content: VALID,
      });
      const error = await rejectionOf(
        runCycle(handler, caps, { job: jobFor(payload) }),
      );
      expect(error).toBeInstanceOf(SecurityError);
      expect(error.message).toBe(
        "the job's agent_run_id does not name the run its lease is bound to",
      );
      expect(caps.used).toEqual(["claimAgentRun"]);
      expect(provider.calls).toHaveLength(0);
    }
  });

  it("gives other payload fields no meaning: a tenant_id beside the right run selects nothing", async () => {
    const { provider, handler, caps } = setup({
      type: "respond",
      content: VALID,
    });
    await runCycle(handler, caps, {
      job: jobFor({ agent_run_id: RUN_ID, tenant_id: OTHER_TENANT_ID }),
    });
    const sent = JSON.stringify([
      caps.startAgentRun.mock.calls,
      caps.completeAgentRun.mock.calls,
    ]);
    expect(sent).not.toContain(OTHER_TENANT_ID);
    expect(provider.calls).toHaveLength(1);
  });

  it("refuses the mismatch even when the claim is already settled", async () => {
    const { handler, caps } = setup(
      { type: "respond", content: VALID },
      {
        claim: {
          action: "settled",
          agent_run_id: RUN_ID,
          status: "succeeded",
        },
      },
    );
    await expect(
      runCycle(handler, caps, { job: jobFor({ agent_run_id: OTHER_RUN_ID }) }),
    ).rejects.toThrow(SecurityError);
  });
});

describe("the claim is parsed against the migration's two shapes, never trusted", () => {
  it("fails permanently with a fixed message, and does nothing else, when the claim has any other shape", async () => {
    const malformed: readonly unknown[] = [
      undefined,
      null,
      "start",
      {},
      startClaim({ extra: true }),
      startClaim({ agent_run_id: "not-a-uuid" }),
      startClaim({ agent_run_id: RUN_ID.toUpperCase() }),
      startClaim({ task: { ...TASK, priority: "high" } }),
      startClaim({ task: { ...TASK, priority: 1.5 } }),
      startClaim({ agent: { ...AGENT, tenant_id: OTHER_TENANT_ID } }),
      startClaim({ task: { ...TASK, title: null } }),
      { action: "settled", agent_run_id: RUN_ID, status: "running" },
      { action: "settled", agent_run_id: RUN_ID, status: "failed", x: 1 },
      { action: "execute", agent_run_id: RUN_ID },
    ];
    for (const claim of malformed) {
      const { provider, handler, caps } = setup(
        { type: "respond", content: VALID },
        { claim },
      );
      const error = await rejectionOf(runCycle(handler, caps));
      expect(error).toBeInstanceOf(PermanentError);
      expect(error.message).toBe(
        "ops.claim_agent_run returned a shape this handler does not accept; nothing was started",
      );
      expect(caps.used).toEqual(["claimAgentRun"]);
      expect(provider.calls).toHaveLength(0);
    }
  });

  it("accepts every null the schema allows: no agent description, no task description, no due date", async () => {
    // ops.agents.description, ops.tasks.description and ops.tasks.due_at are
    // nullable, and a task with neither a description nor a due date is the
    // common case. A claim schema that refused a null would fail every such run
    // permanently, and no fixture above carries one.
    const { provider, handler, caps } = setup(
      { type: "respond", content: VALID },
      {
        claim: startClaim({
          agent: { ...AGENT, description: null },
          task: { ...TASK, description: null, due_at: null },
        }),
      },
    );
    await runCycle(handler, caps);
    expect(caps.used).toEqual([
      "claimAgentRun",
      "startAgentRun",
      "completeAgentRun",
    ]);
    expect(provider.calls).toHaveLength(1);
    // The nulls reach the prompt as nulls, not as text or as missing keys.
    const input = provider.calls[0].input;
    const document = JSON.parse(input.slice(input.indexOf("\n") + 1));
    expect(document.agent.description).toBeNull();
    expect(document.task).toMatchObject({ description: null, due_at: null });
  });
});

describe("a run that is already settled is never called", () => {
  it("completes the job with the run's status and calls nothing", async () => {
    for (const status of [
      "succeeded",
      "failed",
      "indeterminate",
      "cancelled",
    ]) {
      const { provider, handler, caps } = setup(
        { type: "respond", content: VALID },
        { claim: { action: "settled", agent_run_id: RUN_ID, status } },
      );
      const { detail, called } = await runCycle(handler, caps);
      expect(called).toBe(false);
      expect(detail).toBe(`agent_run=${RUN_ID} status=${status}`);
      expect(caps.used).toEqual(["claimAgentRun"]);
      expect(provider.calls).toHaveLength(0);
    }
  });
});

describe("a run this worker cannot attempt is refused, not called", () => {
  it("refuses a capability the handler does not support", async () => {
    const { provider, handler, caps } = setup(
      { type: "respond", content: VALID },
      { claim: startClaim({ capability: "invoice_drafting" }) },
    );
    const { detail, called } = await runCycle(handler, caps);
    expect(called).toBe(false);
    expect(caps.refuseAgentRun).toHaveBeenCalledWith("capability_unsupported");
    expect(detail).toBe(
      `agent_run=${RUN_ID} status=failed code=capability_unsupported`,
    );
    expect(caps.used).toEqual(["claimAgentRun", "refuseAgentRun"]);
    expect(provider.calls).toHaveLength(0);
  });

  it("refuses a route the router does not resolve: unconfigured, unknown, or a prototype key", async () => {
    for (const model_route of ["reasoning", "premium", "", "__proto__"]) {
      const { provider, handler, caps } = setup(
        { type: "respond", content: VALID },
        { claim: startClaim({ model_route }) },
      );
      const { detail } = await runCycle(handler, caps);
      expect(caps.refuseAgentRun).toHaveBeenCalledWith("route_unavailable");
      expect(detail).toBe(
        `agent_run=${RUN_ID} status=failed code=route_unavailable`,
      );
      expect(caps.startAgentRun).not.toHaveBeenCalled();
      expect(provider.calls).toHaveLength(0);
    }
  });
});

describe("a lease too short to bound a call starts nothing", () => {
  it("fails transiently before start when the call budget is under the minimum", async () => {
    const { provider, handler, caps } = setup({
      type: "respond",
      content: VALID,
    });
    const error = await rejectionOf(
      runCycle(handler, caps, { callBudgetMs: MIN_CALL_BUDGET_MS - 1 }),
    );
    expect(error).toBeInstanceOf(TransientError);
    expect(error.message).toBe("lease too short to start a model call");
    // Nothing durable: the run stays pending for the retry.
    expect(caps.used).toEqual(["claimAgentRun"]);
    expect(provider.calls).toHaveLength(0);
  });

  it("rolls back a start that left too little of the lease, before any call", async () => {
    // ops.start_agent_run can wait on locks after the first check passed, so the
    // time left is asked again once it answers running.
    const { provider, handler, caps } = setup({
      type: "respond",
      content: VALID,
    });
    const error = await rejectionOf(
      runCycle(handler, caps, {
        remainingMs: () =>
          caps.used.includes("startAgentRun") ? MIN_CALL_BUDGET_MS - 1 : 30_000,
      }),
    );
    expect(error).toBeInstanceOf(TransientError);
    expect(error.message).toBe(
      "lease ran too short while the run was started; nothing was called",
    );
    expect(caps.used).toEqual(["claimAgentRun", "startAgentRun"]);
    expect(provider.calls).toHaveLength(0);
  });

  it("starts when the budget is exactly the minimum", async () => {
    const { provider, handler, caps } = setup({
      type: "respond",
      content: VALID,
    });
    await runCycle(handler, caps, { callBudgetMs: MIN_CALL_BUDGET_MS });
    expect(caps.startAgentRun).toHaveBeenCalledTimes(1);
    expect(provider.calls).toHaveLength(1);
  });
});

describe("only the token `running` means call", () => {
  it("holds a run whose start found an execution stop, without calling or settling it", async () => {
    const { provider, handler, caps } = setup(
      { type: "respond", content: VALID },
      { start: "stopped" },
    );
    const { prepared, called } = await runCycle(handler, caps);
    expect(prepared).toEqual({ kind: "held" });
    expect(called).toBe(false);
    expect(caps.used).toEqual(["claimAgentRun", "startAgentRun"]);
    expect(provider.calls).toHaveLength(0);
  });

  it("never reads a look-alike of `stopped` as held", async () => {
    for (const token of [
      "Stopped",
      " stopped",
      "stopped\n",
      "execution_stopped",
    ]) {
      const { provider, handler, caps } = setup(
        { type: "respond", content: VALID },
        { start: token },
      );
      const { prepared, called } = await runCycle(handler, caps);
      expect(prepared.kind).toBe("settled");
      expect(called).toBe(false);
      expect(provider.calls).toHaveLength(0);
    }
  });

  it("settles without calling on every other token start returns", async () => {
    for (const [token, shown] of [
      ["cancelled", "cancelled"],
      ["already_running", "already_running"],
      ["indeterminate", "indeterminate"],
      ["succeeded", "succeeded"],
      ["failed", "failed"],
      ["pending", "pending"],
      ["not_running", "not_running"],
      ["Running", "unrecognized"],
      [" running", "unrecognized"],
      ["running\n", "unrecognized"],
      ["", "unrecognized"],
    ] as const) {
      const { provider, handler, caps } = setup(
        { type: "respond", content: VALID },
        { start: token },
      );
      const { detail, called } = await runCycle(handler, caps);
      expect(called).toBe(false);
      expect(detail).toBe(`agent_run=${RUN_ID} status=${shown}`);
      expect(caps.used).toEqual(["claimAgentRun", "startAgentRun"]);
      expect(provider.calls).toHaveLength(0);
    }
  });
});

describe("the stored fingerprint is of the request the provider actually receives", () => {
  it("starts the run with the provider, model, prompt version and the fingerprint of the sent request", async () => {
    const { provider, handler, caps } = setup({
      type: "respond",
      content: VALID,
    });
    await runCycle(handler, caps);
    expect(provider.calls).toHaveLength(1);
    const [start] = caps.startAgentRun.mock.calls[0];
    expect(start).toEqual({
      provider: "fake",
      model: MODEL,
      promptVersion: TASK_ASSESSMENT_PROMPT_VERSION,
      inputFingerprint: fingerprintModelRequest(
        provider.calls[0],
        "fake",
        TASK_ASSESSMENT_PROMPT_VERSION,
      ),
      maxOutputTokens: MODEL_ROUTE_POLICIES.standard.maxOutputTokens,
    });
    expect(start.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports to the start the same output ceiling the request carries, which is the route's", async () => {
    const { provider, handler, caps } = setup({
      type: "respond",
      content: VALID,
    });
    await runCycle(handler, caps);
    const [start] = caps.startAgentRun.mock.calls[0];
    expect(start.maxOutputTokens).toBe(provider.calls[0].maxOutputTokens);
    expect(start.maxOutputTokens).toBe(
      MODEL_ROUTE_POLICIES.standard.maxOutputTokens,
    );
  });
});

/** What ops.start_agent_run raises when spend is contended by calls in flight. */
const budgetContended = () =>
  Object.assign(
    new Error(
      "ops.start_agent_run: the spend limits cannot absorb this run beside the calls in flight; try again after they settle",
    ),
    { code: "OS429" },
  );

describe("a start refused by spend contention calls nothing and records nothing", () => {
  it("lets the start's budget contention error through unchanged, and never calls the provider", async () => {
    const contended = budgetContended();
    const { provider, handler, caps } = setup(
      { type: "respond", content: VALID },
      { startError: contended },
    );
    const error = await rejectionOf(runCycle(handler, caps));
    expect(error).toBe(contended);
    expect(caps.used).toEqual(["claimAgentRun", "startAgentRun"]);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("a successful call is recorded as this attempt's result", () => {
  it("completes with the validated value, the response metadata and usage, and a metadata-only detail", async () => {
    const { provider, handler, caps } = setup({
      type: "respond",
      content: VALID,
    });
    const { detail } = await runCycle(handler, caps);
    expect(caps.used).toEqual([
      "claimAgentRun",
      "startAgentRun",
      "completeAgentRun",
    ]);
    const [completion] = caps.completeAgentRun.mock.calls[0];
    expect(completion).toMatchObject({
      result: VALID,
      responseModel: MODEL,
      finishReason: "completed",
      providerRequestId: "fake-req-1",
      providerResponseId: "fake-resp-1",
      usage: {
        inputTokens: 120,
        outputTokens: 60,
        totalTokens: 180,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
    });
    expect(Number.isSafeInteger(completion.latencyMs)).toBe(true);
    expect(detail).toBe(
      `agent_run=${RUN_ID} status=succeeded route=standard provider=fake model=${MODEL} input_tokens=120 output_tokens=60 category=-`,
    );
    expect(detail).not.toContain(VALID.summary);
    expect(provider.calls).toHaveLength(1);
  });

  it("stores output that looks like a tenant id, a job kind, SQL or a URL only as opaque result data", async () => {
    const hostile: TaskAssessment = {
      outcome: "blocked",
      summary: `tenant_id=${OTHER_TENANT_ID} kind=agent_run.execute; drop table ops.jobs; https://attacker.example/steal`,
      proposed_next_steps: [
        "agent_run.execute",
        "select * from ops.agent_runs",
        `https://attacker.example/${OTHER_RUN_ID}`,
      ],
    };
    const { provider, handler, caps } = setup({
      type: "respond",
      content: hostile,
    });
    const { detail } = await runCycle(handler, caps);
    // Passed through once, as the result, and acted on in no other way.
    expect(caps.used).toEqual([
      "claimAgentRun",
      "startAgentRun",
      "completeAgentRun",
    ]);
    expect(caps.completeAgentRun.mock.calls[0][0].result).toEqual(hostile);
    for (const fragment of [
      OTHER_TENANT_ID,
      OTHER_RUN_ID,
      "drop table",
      "attacker.example",
      "select *",
    ]) {
      expect(detail).not.toContain(fragment);
    }
    expect(provider.calls).toHaveLength(1);
  });
});

describe("a failed call is recorded once, with what it cost", () => {
  it("records malformed output as schema_validation, keeping usage and ids", async () => {
    const usage = {
      inputTokens: 11,
      outputTokens: 22,
      totalTokens: 33,
      cachedInputTokens: 0,
      reasoningTokens: 4,
    };
    const { provider, handler, caps } = setup({
      type: "respond",
      content: "not an object",
      usage,
    });
    const { detail } = await runCycle(handler, caps);
    expect(recordedFailure(caps)).toMatchObject({
      category: "schema_validation",
      code: "contract_mismatch",
      responseModel: MODEL,
      providerRequestId: "fake-req-1",
      providerResponseId: "fake-resp-1",
      usage,
    });
    expect(detail).toBe(
      `agent_run=${RUN_ID} status=failed route=standard provider=fake model=${MODEL} input_tokens=11 output_tokens=22 category=schema_validation`,
    );
    expect(provider.calls).toHaveLength(1);
  });

  it("records each provider failure category as that category, and the status the database returns", async () => {
    for (const category of MODEL_ERROR_CATEGORIES) {
      const { provider, handler, caps } = setup({
        type: "fail",
        category,
        code: "probe_code",
      });
      const { detail } = await runCycle(handler, caps);
      expect(recordedFailure(caps)).toMatchObject({
        category,
        code: "probe_code",
      });
      expect(detail).toContain(
        `status=${agentRunStatusForCategory(category)} `,
      );
      expect(detail).toMatch(new RegExp(`category=${category}$`));
      expect(provider.calls).toHaveLength(1);
    }
  });

  it("falls back to the call's measured duration when the error carries no latency", async () => {
    const { handler, caps } = setup({ type: "fail", category: "transport" });
    const { outcome } = await runCycle(handler, caps);
    expect(recordedFailure(caps).latencyMs).toBe(outcome?.durationMs);
  });
});

describe("a provider server error is an ambiguous ending, never a known failure", () => {
  it("records a provider server error as indeterminate, with what the call cost", async () => {
    const { provider, handler, caps } = setup({
      type: "fail",
      category: "provider_5xx",
      code: "http_503",
    });
    const { detail } = await runCycle(handler, caps);
    expect(recordedFailure(caps)).toMatchObject({
      category: "provider_5xx",
      code: "http_503",
    });
    expect(detail).toContain("status=indeterminate");
    expect(detail).toContain("category=provider_5xx");
    expect(provider.calls).toHaveLength(1);
  });
});

describe("the lease deadline and shutdown are recorded as different endings", () => {
  it("records an abort by the lease deadline as timeout, with code deadline", async () => {
    // The context runOneJob builds: shutdown combined with a deadline timer.
    const { provider, handler, caps } = setup({ type: "hang" });
    const shutdown = new AbortController();
    const { detail } = await runCycle(handler, caps, {
      context: () => ({
        signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(25)]),
        deadline: Date.now() + 25,
      }),
    });
    expect(recordedFailure(caps)).toMatchObject({
      category: "timeout",
      code: "deadline",
    });
    expect(detail).toContain("status=indeterminate");
    expect(detail).toMatch(/category=timeout$/);
    expect(provider.calls).toHaveLength(1);
  });

  it("records an abort by shutdown as cancelled", async () => {
    const { provider, handler, caps } = setup({ type: "hang" });
    const shutdown = new AbortController();
    void provider.callStarted().then(() => shutdown.abort());
    await runCycle(handler, caps, {
      context: () => ({
        signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(60_000)]),
        deadline: Date.now() + 60_000,
      }),
    });
    expect(recordedFailure(caps)).toMatchObject({
      category: "cancelled",
      code: "aborted",
    });
    expect(provider.calls).toHaveLength(1);
  });

  it("keeps a shutdown abort cancelled even when the deadline has also passed", async () => {
    // Shutdown won the race: its reason is on the signal.
    const { provider, handler, caps } = setup({ type: "hang" });
    const shutdown = new AbortController();
    void provider.callStarted().then(() => shutdown.abort());
    await runCycle(handler, caps, {
      context: () => ({ signal: shutdown.signal, deadline: Date.now() - 1 }),
    });
    expect(recordedFailure(caps).category).toBe("cancelled");
  });

  it("treats a cancellation past the deadline, before its timer fired, as the deadline", async () => {
    const context = (): ExternalCallContext => ({
      signal: new AbortController().signal,
      deadline: 1_000,
    });
    const late = setup(
      { type: "fail", category: "cancelled", code: "aborted" },
      {},
      () => 1_000,
    );
    await runCycle(late.handler, late.caps, { context });
    expect(recordedFailure(late.caps)).toMatchObject({
      category: "timeout",
      code: "deadline",
    });

    const early = setup(
      { type: "fail", category: "cancelled", code: "aborted" },
      {},
      () => 999,
    );
    await runCycle(early.handler, early.caps, { context });
    expect(recordedFailure(early.caps)).toMatchObject({
      category: "cancelled",
      code: "aborted",
    });
  });

  it("never turns a failure other than cancellation into a timeout", async () => {
    const { handler, caps } = setup(
      { type: "fail", category: "transport" },
      {},
      () => Number.MAX_SAFE_INTEGER,
    );
    await runCycle(handler, caps);
    expect(recordedFailure(caps).category).toBe("transport");
  });

  it("classifies a call the runtime abandoned by the signal reason it rejected with", async () => {
    // runOneJob rejects an abandoned call with the signal's reason itself.
    for (const [error, category, code] of [
      [new DOMException("deadline", "TimeoutError"), "timeout", "deadline"],
      [new DOMException("shutdown", "AbortError"), "cancelled", "aborted"],
      [new Error("anything else"), "unknown", null],
    ] as const) {
      const { handler, caps } = setup({ type: "respond", content: VALID });
      const prepared = await handler.prepare(jobFor(), caps.prepare, {
        callBudgetMs: 30_000,
        remainingMs: () => 30_000,
      });
      if (prepared.kind !== "call") throw new Error("expected a call");
      await handler.settle(
        prepared.state,
        { ok: false, error, durationMs: 1_000 },
        caps.settle,
      );
      expect(recordedFailure(caps)).toMatchObject({
        category,
        code,
        latencyMs: 1_000,
      });
    }
  });
});

describe("a run the database no longer gives this attempt is not settled by it", () => {
  it("refuses to record a result when complete answers not_running", async () => {
    const { handler, caps } = setup(
      { type: "respond", content: VALID },
      { complete: "not_running" },
    );
    const error = await rejectionOf(runCycle(handler, caps));
    expect(error).toBeInstanceOf(SecurityError);
    expect(error.message).toBe(
      "the agent run was settled by someone else while its call ran",
    );
  });

  it("refuses to record a failure when fail answers not_running", async () => {
    const { handler, caps } = setup(
      { type: "fail", category: "transport" },
      { fail: "not_running" },
    );
    await expect(runCycle(handler, caps)).rejects.toThrow(SecurityError);
  });

  it("refuses a settlement status the capability cannot have recorded, rather than completing the job on it", async () => {
    const unrecognised =
      "the database answered a settlement status this handler does not recognise";
    for (const token of [
      "running",
      "cancelled",
      "indeterminate",
      "pending",
      "Succeeded",
      "",
    ]) {
      const { handler, caps } = setup(
        { type: "respond", content: VALID },
        { complete: token },
      );
      const error = await rejectionOf(runCycle(handler, caps));
      expect(error).toBeInstanceOf(SecurityError);
      expect(error.message).toBe(unrecognised);
    }
    for (const token of [
      "running",
      "cancelled",
      "succeeded",
      "pending",
      "Failed",
      "",
    ]) {
      const { handler, caps } = setup(
        { type: "fail", category: "transport" },
        { fail: token },
      );
      const error = await rejectionOf(runCycle(handler, caps));
      expect(error).toBeInstanceOf(SecurityError);
      expect(error.message).toBe(unrecognised);
    }
  });

  it("accepts every status the database records for its own settlement", async () => {
    for (const token of ["succeeded", "failed"]) {
      const { handler, caps } = setup(
        { type: "respond", content: VALID },
        { complete: token },
      );
      const { detail } = await runCycle(handler, caps);
      expect(detail).toContain(`status=${token}`);
    }
    for (const token of ["failed", "indeterminate"]) {
      const { handler, caps } = setup(
        { type: "fail", category: "transport" },
        { fail: token },
      );
      const { detail } = await runCycle(handler, caps);
      expect(detail).toContain(`status=${token}`);
    }
  });
});

describe("the provider is called at most once per cycle", () => {
  it("issues exactly one call whatever the provider does, and never retries", async () => {
    const behaviors: readonly FakeBehavior[] = [
      { type: "respond", content: VALID },
      { type: "respond", content: [] },
      { type: "delay", ms: 5, then: { type: "respond", content: VALID } },
      { type: "fail", category: "transport" },
      { type: "fail", category: "rate_limit" },
      { type: "fail", category: "provider_5xx" },
      { type: "fail", category: "unknown" },
    ];
    for (const behavior of behaviors) {
      const { provider, handler, caps } = setup(behavior);
      await runCycle(handler, caps);
      expect(provider.calls).toHaveLength(1);
      expect(
        caps.completeAgentRun.mock.calls.length +
          caps.failAgentRun.mock.calls.length,
      ).toBe(1);
    }
  });
});

describe("no task text, prompt, model output or provider text reaches a detail or an error", () => {
  const SENTINELS = [
    "SENTINEL-TITLE-5521",
    "SENTINEL-DESCRIPTION-8810",
    "SENTINEL-AGENT-3307",
    "SENTINEL-OUTPUT-6604",
  ];
  const sentinelClaim = startClaim({
    agent: { ...AGENT, description: `Knows ${SENTINELS[2]}.` },
    task: {
      ...TASK,
      title: `Order supplies ${SENTINELS[0]}`,
      description: `Details ${SENTINELS[1]}.`,
    },
  });
  const expectClean = (texts: readonly string[]) => {
    const joined = texts.join("\n");
    for (const sentinel of SENTINELS) expect(joined).not.toContain(sentinel);
  };

  it("keeps them out of the success detail, while the prompt does carry the task", async () => {
    const { provider, handler, caps } = setup(
      {
        type: "respond",
        content: { ...VALID, summary: `Done ${SENTINELS[3]}.` },
      },
      { claim: sentinelClaim },
    );
    const { detail } = await runCycle(handler, caps);
    // Not vacuous: the sentinels were in play.
    expect(provider.calls[0].input).toContain(SENTINELS[0]);
    expectClean([detail]);
  });

  it("keeps them out of a failure's detail and recorded fields, including a provider error that echoes the prompt", async () => {
    const echoing: ModelProvider = {
      name: "fake",
      execute: (request) =>
        Promise.reject(new Error(`upstream said: ${request.input}`)),
    };
    const malformed = createFakeModelProvider({
      type: "respond",
      content: { outcome: SENTINELS[3] },
    });
    for (const provider of [echoing, malformed]) {
      const { handler, caps } = setupOver(provider, { claim: sentinelClaim });
      const { detail } = await runCycle(handler, caps);
      expectClean([detail, JSON.stringify(recordedFailure(caps))]);
    }
  });

  it("keeps them out of every error the handler raises", async () => {
    const messages: string[] = [];
    const cases: readonly {
      readonly script: CapabilityScript;
      readonly options?: Parameters<typeof runCycle>[2];
    }[] = [
      { script: { claim: sentinelClaim }, options: { job: jobFor({}) } },
      { script: { claim: { ...sentinelClaim, extra: SENTINELS[0] } } },
      {
        script: { claim: sentinelClaim },
        options: { callBudgetMs: 0 },
      },
      { script: { claim: sentinelClaim, complete: "not_running" } },
    ];
    for (const { script, options } of cases) {
      const { handler, caps } = setup(
        { type: "respond", content: { ...VALID, summary: SENTINELS[3] } },
        script,
      );
      messages.push(
        (await rejectionOf(runCycle(handler, caps, options))).message,
      );
    }
    expect(messages).toHaveLength(4);
    expectClean(messages);
  });
});

// --- Through the real runtime ------------------------------------------------

/** A database that answers the runtime's and the agent run capabilities' SQL. */
const scriptedDb = (
  script: {
    readonly payload?: unknown;
    readonly complete?: string;
    /** Thrown by ops.start_agent_run instead of answering. */
    readonly startError?: Error;
    /** What ops.start_agent_run answers; running by default. */
    readonly start?: string;
    /** What ops.defer_job answers. */
    readonly defer?: string | null;
    /** What ops.settle_job_failure answers. */
    readonly settle?: string;
  } = {},
) => {
  const calls: { tx: number; sql: string; params?: readonly unknown[] }[] = [];
  const rolledBack: number[] = [];
  const job = jobFor(script.payload ?? { agent_run_id: RUN_ID });
  let transaction = 0;
  const row = (value: object) => ({ rows: [value] }) as never;

  const db: WorkerDatabase = {
    async withTransaction(fn) {
      transaction += 1;
      const mine = transaction;
      const tx: TxClient = {
        async query(sql, params) {
          calls.push({ tx: mine, sql, params });
          if (sql.includes("ops.lease_job")) return row(job);
          if (sql.includes("ops.resume_lease")) {
            return row(
              sql.includes("lease_remaining_ms")
                ? { ...job, lease_remaining_ms: "60000" }
                : job,
            );
          }
          if (sql.includes("ops.current_tenant_id")) {
            return row({ tenant_id: TENANT_ID });
          }
          if (sql.includes("ops.claim_agent_run")) {
            return row({ claim: startClaim() });
          }
          if (sql.includes("ops.start_agent_run")) {
            if (script.startError) throw script.startError;
            return row({ status: script.start ?? "running" });
          }
          if (sql.includes("ops.job_execution_stop")) {
            return row({ stop_id: null });
          }
          if (sql.includes("ops.defer_job")) {
            return row({ stop_id: script.defer ?? null });
          }
          if (sql.includes("ops.complete_agent_run")) {
            return row({ status: script.complete ?? "succeeded" });
          }
          if (sql.includes("ops.fail_agent_run")) {
            return row({
              status: agentRunStatusForCategory(
                params?.[0] as ModelErrorCategory,
              ),
            });
          }
          if (sql.includes("ops.complete_job")) return row({ ok: true });
          if (sql.includes("ops.settle_job_failure")) {
            return row({ result: script.settle ?? "failed" });
          }
          return { rows: [] } as never;
        },
      };
      try {
        return await fn(tx);
      } catch (error) {
        rolledBack.push(mine);
        throw error;
      }
    },
    async identity() {
      throw new Error("not used");
    },
    async close() {},
  };
  const statements = (fragment: string) =>
    calls.filter((call) => call.sql.includes(fragment));
  return { db, calls, statements, rolledBack };
};

describe("through the real runtime", () => {
  it("starts in the prepare transaction, completes in the settle transaction, and persists the fingerprint of the sent request", async () => {
    const provider = createFakeModelProvider({
      type: "respond",
      content: VALID,
    });
    const { db, statements } = scriptedDb();
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: createHandlerRegistry({ modelRouter: routerOver(provider) }),
    });

    expect(result).toMatchObject({ outcome: "succeeded" });
    expect(result.detail).toMatch(
      new RegExp(`^agent_run=${RUN_ID} status=succeeded `),
    );
    const [start] = statements("ops.start_agent_run");
    const [complete] = statements("ops.complete_agent_run");
    expect(start.tx).toBe(2);
    expect(complete.tx).toBe(3);
    expect(statements("ops.complete_job").map((call) => call.tx)).toEqual([3]);
    expect(JSON.parse(String(complete.params?.[0]))).toEqual(VALID);
    // The persisted input_fingerprint parameter IS the fingerprint of what the
    // provider received.
    expect(provider.calls).toHaveLength(1);
    expect(start.params?.[3]).toBe(
      fingerprintModelRequest(
        provider.calls[0],
        "fake",
        TASK_ASSESSMENT_PROMPT_VERSION,
      ),
    );
    // The output ceiling, last, is the route's, and the one the provider got.
    expect(start.params).toHaveLength(5);
    expect(start.params?.[4]).toBe(
      MODEL_ROUTE_POLICIES.standard.maxOutputTokens,
    );
    expect(start.params?.[4]).toBe(provider.calls[0].maxOutputTokens);
  });

  it("settles a start refused by spend contention as a retryable failure, with the prepare rolled back and no call", async () => {
    const provider = createFakeModelProvider({
      type: "respond",
      content: VALID,
    });
    const { db, statements, rolledBack } = scriptedDb({
      startError: budgetContended(),
      settle: "retry",
    });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: createHandlerRegistry({ modelRouter: routerOver(provider) }),
    });
    expect(result.outcome).toBe("retry");
    expect(result.detail).toMatch(/^OS429: /);
    expect(provider.calls).toHaveLength(0);
    expect(rolledBack).toEqual([2]);
    // Never asked the stop check or completed the job: the start raised first.
    expect(statements("ops.job_execution_stop")).toHaveLength(0);
    expect(statements("ops.complete_job")).toHaveLength(0);
    const [settle] = statements("ops.settle_job_failure");
    expect(settle.tx).toBe(3);
    // Recorded as understood and retryable: ops.settle_job_failure retries a
    // transient failure while attempts remain.
    expect(result.failureClass).toBe("transient");
    expect(settle.params?.[1]).toBe("transient");
  });

  it("defers the job of a run its start found stopped, in the prepare transaction and without leaving the start's savepoint, and calls nothing", async () => {
    const provider = createFakeModelProvider({
      type: "respond",
      content: VALID,
    });
    const { db, calls, statements, rolledBack } = scriptedDb({
      start: "stopped",
      defer: STOP_ID,
    });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: createHandlerRegistry({ modelRouter: routerOver(provider) }),
    });

    expect(result).toMatchObject({
      outcome: "deferred",
      detail: `held by execution stop ${STOP_ID}`,
    });
    expect(provider.calls).toHaveLength(0);
    expect(rolledBack).toEqual([]);
    const tx2 = calls.filter((call) => call.tx === 2).map((call) => call.sql);
    const start = tx2.findIndex((sql) => sql.includes("ops.start_agent_run"));
    const release = tx2.findIndex((sql) => sql.startsWith("release savepoint"));
    const defer = tx2.findIndex((sql) => sql.includes("ops.defer_job"));
    // The start's kill-switch lock is still held when the job is deferred.
    expect(start).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(start);
    expect(defer).toBeGreaterThan(release);
    expect(tx2.some((sql) => sql.startsWith("rollback to savepoint"))).toBe(
      false,
    );
    // Neither the pre-call check, nor a completion, nor a failure settlement.
    expect(statements("ops.job_execution_stop")).toHaveLength(0);
    expect(statements("ops.complete_job")).toHaveLength(0);
    expect(statements("ops.complete_agent_run")).toHaveLength(0);
    expect(statements("ops.fail_agent_run")).toHaveLength(0);
    expect(statements("ops.settle_job_failure")).toHaveLength(0);
    expect(calls.some((call) => call.tx === 3)).toBe(false);
  });

  it("rolls the prepare back and retries when the start found a stop but the deferral finds none, and calls nothing", async () => {
    const provider = createFakeModelProvider({
      type: "respond",
      content: VALID,
    });
    const { db, statements, rolledBack } = scriptedDb({
      start: "stopped",
      defer: null,
      settle: "retry",
    });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: createHandlerRegistry({ modelRouter: routerOver(provider) }),
    });

    expect(result.outcome).toBe("retry");
    expect(result.failureClass).toBe("transient");
    expect(provider.calls).toHaveLength(0);
    expect(rolledBack).toEqual([2]);
    expect(statements("ops.complete_job")).toHaveLength(0);
    expect(statements("ops.settle_job_failure").map((call) => call.tx)).toEqual(
      [3],
    );
  });

  it("records a shutdown during the call as cancelled, and completes the job", async () => {
    const provider = createFakeModelProvider({ type: "hang" });
    const { db, statements } = scriptedDb();
    const controller = new AbortController();
    const pending = runOneJob(db, {
      workerId: "w1",
      signal: controller.signal,
      registry: createHandlerRegistry({ modelRouter: routerOver(provider) }),
    });
    await provider.callStarted();
    controller.abort();
    const result = await pending;

    expect(result.outcome).toBe("succeeded");
    const [fail] = statements("ops.fail_agent_run");
    expect(fail.tx).toBe(3);
    expect(fail.params?.slice(0, 2)).toEqual(["cancelled", "aborted"]);
    expect(statements("ops.settle_job_failure")).toHaveLength(0);
    expect(provider.calls).toHaveLength(1);
  });

  it("fails the attempt as a security refusal when the run was settled by someone else during the call", async () => {
    const provider = createFakeModelProvider({
      type: "respond",
      content: VALID,
    });
    const { db, statements } = scriptedDb({ complete: "not_running" });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: createHandlerRegistry({ modelRouter: routerOver(provider) }),
    });
    expect(result).toMatchObject({ failureClass: "security" });
    expect(statements("ops.settle_job_failure").map((call) => call.tx)).toEqual(
      [4],
    );
    expect(provider.calls).toHaveLength(1);
  });

  it("refuses a forged payload before starting anything or calling", async () => {
    const provider = createFakeModelProvider({
      type: "respond",
      content: VALID,
    });
    const { db, statements } = scriptedDb({
      payload: { agent_run_id: OTHER_RUN_ID },
    });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: createHandlerRegistry({ modelRouter: routerOver(provider) }),
    });
    expect(result).toMatchObject({ failureClass: "security" });
    expect(statements("ops.start_agent_run")).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("the handler reaches the outside world only through its capabilities and the router", () => {
  it("never logs, never reads the environment, and imports no domain, database layer, driver or Node built-in", () => {
    // eslint.config.js refuses the domain, engine/db and the driver under
    // engine/handlers, statically and at run time. Logging, the environment and
    // Node built-ins have no lint rule, so they are held here.
    const source = readFileSync(
      new URL("./agentRunExecute.ts", import.meta.url),
      "utf8",
    );
    const code = source.replace(/^\s*\/\/.*$/gm, "");
    const specifiers = [
      ...code.matchAll(/(?:\bfrom|\bimport)\s*"([^"]+)"/g),
    ].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/(^|\/)(domain|db)(\/|$)/);
      expect(specifier).not.toMatch(/^(pg|pg-.+|node:.+)$/);
    }
    expect(code).not.toMatch(
      /process\.env|console\.|\bimport\s*\(|require\s*\(/,
    );
    expect(code).not.toMatch(/createLogger|WorkerLogger/);
  });
});
