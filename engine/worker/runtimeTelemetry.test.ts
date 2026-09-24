// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  createRecordingTelemetry,
  TELEMETRY_SENTINELS,
  THROWING_TELEMETRY,
} from "../telemetry/testSupport/recordingTelemetry.ts";
import { createWorkerTelemetry } from "../telemetry/workerTelemetry.ts";
import {
  createRegistry,
  type ExternalCallHandlerDefinition,
} from "./handlerRegistry.ts";
import { runOneJob } from "./runOneJob.ts";
import { fakeDb, JOB } from "./testSupport/fakeWorkerDatabase.ts";

// Phase 2E.1: telemetry observes the governed runtime and changes nothing in
// it. The same job runs to the same outcome, through the same statements in
// the same transactions, whether telemetry records, records nothing, or
// throws on every call; and a settlement is counted only once it committed.

const RUN = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const handler = (
  overrides: Partial<ExternalCallHandlerDefinition> = {},
): ExternalCallHandlerDefinition => ({
  kind: "agent_run.execute",
  shape: "external_call",
  prepareCapabilities: [],
  settleCapabilities: [],
  async prepare() {
    return {
      kind: "call",
      state: { prompt: TELEMETRY_SENTINELS.prompt },
      providerKind: "fake",
    };
  },
  async call() {
    return { answer: TELEMETRY_SENTINELS.modelResponse };
  },
  async settle(_state, outcome) {
    return {
      detail: outcome.ok ? "settled=ok" : "settled=error",
      observation: {
        subject: "agent_run",
        status: outcome.ok ? "succeeded" : "indeterminate",
        runId: RUN,
      },
    };
  },
  ...overrides,
});

const agentJob = { ...JOB, kind: "agent_run.execute" };

const run = async (
  telemetry: Parameters<typeof runOneJob>[1]["telemetry"],
  overrides: Partial<ExternalCallHandlerDefinition> = {},
  db = fakeDb({ leased: agentJob, resume: [agentJob, agentJob, agentJob] }),
) => {
  const result = await runOneJob(db.db, {
    workerId: "w1",
    registry: createRegistry([handler(overrides)]),
    telemetry,
  });
  return {
    result,
    statements: db.calls.map((c) => `${c.tx}:${c.sql}`),
    committed: db.committed,
  };
};

describe("telemetry does not change the governed runtime", () => {
  it("runs the same statements, in the same transactions, to the same outcome with no, recording or throwing telemetry", async () => {
    const baseline = await run(undefined);
    const recorded = await run(
      createWorkerTelemetry(createRecordingTelemetry()),
    );
    const throwing = await run(createWorkerTelemetry(THROWING_TELEMETRY));

    expect(baseline.result).toMatchObject({
      outcome: "succeeded",
      detail: "settled=ok",
    });
    for (const other of [recorded, throwing]) {
      expect({ ...other.result, durationMs: 0 }).toEqual({
        ...baseline.result,
        durationMs: 0,
      });
      expect(other.statements).toEqual(baseline.statements);
      expect(other.committed).toEqual(baseline.committed);
    }
  });

  it("makes exactly one provider call per attempt, whatever telemetry does: it never retries", async () => {
    for (const telemetry of [
      undefined,
      createWorkerTelemetry(THROWING_TELEMETRY),
    ]) {
      let calls = 0;
      const { result } = await run(telemetry, {
        async call() {
          calls += 1;
          throw Object.assign(new Error(TELEMETRY_SENTINELS.providerOutput), {
            name: "TimeoutError",
          });
        },
      });
      expect(calls).toBe(1);
      expect(result).toMatchObject({
        outcome: "succeeded",
        detail: "settled=error",
      });
    }
  });

  it("records the job, its three phases and the call, and counts the committed settlement once", async () => {
    const recording = createRecordingTelemetry();
    await run(createWorkerTelemetry(recording));

    expect(recording.spans.map((s) => s.name)).toEqual([
      "company_os.job.execute",
      "company_os.governance.check",
      "company_os.provider.call",
      "company_os.settlement",
    ]);
    expect(
      recording.counted("company_os_agent_runs_total", {
        outcome: "succeeded",
      }),
    ).toBe(1);
    expect(
      recording.counted("company_os_external_calls_total", {
        operation: "agent_run.execute",
        outcome: "ok",
      }),
    ).toBe(1);
    expect(
      recording.counted("company_os_jobs_total", {
        job_kind: "agent_run.execute",
        outcome: "succeeded",
      }),
    ).toBe(1);
    // The prompt, the provider's answer and the payload were in play.
    expect(recording.dump()).not.toContain("SENTINEL");
    expect(recording.dump()).not.toContain("hello");
  });

  it("counts no settlement when the settle transaction rolls back, and still reports the attempt", async () => {
    const recording = createRecordingTelemetry();
    const { result } = await run(
      createWorkerTelemetry(recording),
      {},
      fakeDb({
        leased: agentJob,
        resume: [agentJob, agentJob, agentJob],
        completeReturns: false,
        settleReturns: "failed",
      }),
    );
    expect(result.outcome).toBe("failed");
    expect(recording.counted("company_os_agent_runs_total")).toBe(0);
    expect(
      recording.counted("company_os_jobs_total", {
        job_kind: "agent_run.execute",
        outcome: "failed",
      }),
    ).toBe(1);
    expect(
      recording.spans.find((s) => s.name === "company_os.settlement")?.status,
    ).toBe("error");
  });

  it("counts nothing for a later attempt that finds the run already settled: a replay is not a settlement", async () => {
    const recording = createRecordingTelemetry();
    const { result } = await run(createWorkerTelemetry(recording), {
      async prepare() {
        return { kind: "settled", detail: `agent_run=${RUN} status=succeeded` };
      },
    });
    expect(result.outcome).toBe("succeeded");
    expect(recording.counted("company_os_agent_runs_total")).toBe(0);
    expect(recording.counted("company_os_external_calls_total")).toBe(0);
    expect(recording.spans.map((s) => s.name)).toEqual([
      "company_os.job.execute",
      "company_os.governance.check",
    ]);
  });

  it("ends the job as interrupted, and the active gauge back at zero, when the attempt is lost mid-flight", async () => {
    const recording = createRecordingTelemetry();
    const db = fakeDb({ leased: agentJob, resume: [agentJob, agentJob] });
    await expect(
      runOneJob(db.db, {
        workerId: "w1",
        registry: createRegistry([handler()]),
        telemetry: createWorkerTelemetry(recording),
        onCallFinished: async () => {
          throw new Error("process died");
        },
      }),
    ).rejects.toThrow("process died");
    expect(
      recording.counted("company_os_jobs_total", { outcome: "interrupted" }),
    ).toBe(1);
    expect(recording.counted("company_os_agent_runs_total")).toBe(0);
    const gauge = recording.metrics
      .filter((m) => m.metric === "company_os_worker_active_jobs")
      .map((m) => m.value);
    expect(gauge.at(-1)).toBe(0);
  });
});
