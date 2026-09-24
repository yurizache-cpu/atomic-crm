import { describe, expect, it } from "vitest";

import { createPrometheusRegistry } from "./prometheusRegistry.ts";
import { guardTelemetry, NOOP_TELEMETRY } from "./telemetryPort.ts";
import {
  createRecordingTelemetry,
  TELEMETRY_SENTINELS,
  THROWING_TELEMETRY,
} from "./testSupport/recordingTelemetry.ts";
import {
  classifyCall,
  createWorkerTelemetry,
  NOOP_WORKER_TELEMETRY,
} from "./workerTelemetry.ts";

// What the worker records (Phase 2E.1): one job span with its phases, the
// external-call metrics, settlement counts and the worker gauges, through the
// guarded boundary, and nothing that could change what the runtime does.

const JOB = Object.freeze({
  id: "5d0e8c1a-2b3c-4d5e-8f60-718293a4b5c6",
  tenant_id: "0b8f3a3e-5c1a-4d2e-9f6b-2a7c1d9e4f10",
  kind: "agent_run.execute",
  attempts: 1,
});
const RUN = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

describe("the worker telemetry facade", () => {
  it("traces a job as job.execute with governance, call and settlement children", async () => {
    const recording = createRecordingTelemetry();
    const trace = createWorkerTelemetry(recording).startJob(JOB);

    await trace.phase("company_os.governance.check", async () => "prepared");
    await trace.providerCall("fake", async () => ({
      ok: true as const,
      value: { summary: TELEMETRY_SENTINELS.modelResponse },
      durationMs: 1200,
    }));
    await trace.phase("company_os.settlement", async () => "settled");
    trace.settled({ subject: "agent_run", status: "succeeded", runId: RUN });
    trace.end({ outcome: "succeeded" });

    const names = recording.spans.map((span) => [span.name, span.parent?.name]);
    expect(names).toEqual([
      ["company_os.job.execute", undefined],
      ["company_os.governance.check", "company_os.job.execute"],
      ["company_os.provider.call", "company_os.job.execute"],
      ["company_os.settlement", "company_os.job.execute"],
    ]);
    expect(recording.spans.every((span) => span.ends === 1)).toBe(true);
    expect(recording.spans[0].attributes).toEqual({
      "company_os.job.kind": "agent_run.execute",
      "company_os.job.attempt": 1,
      "company_os.tenant.id": JOB.tenant_id,
      "company_os.job.id": JOB.id,
      "company_os.agent_run.outcome": "succeeded",
      "company_os.run.id": RUN,
      "company_os.job.outcome": "succeeded",
    });
    expect(recording.spans[2].attributes).toEqual({
      "company_os.operation": "agent_run.execute",
      "company_os.provider.kind": "fake",
      "company_os.call.outcome": "ok",
    });
    // The provider's answer was in play and reached nothing.
    expect(recording.dump()).not.toContain("SENTINEL");

    expect(
      recording.counted("company_os_external_calls_total", {
        operation: "agent_run.execute",
        outcome: "ok",
      }),
    ).toBe(1);
    expect(
      recording.counted("company_os_agent_runs_total", {
        outcome: "succeeded",
      }),
    ).toBe(1);
    expect(
      recording.counted("company_os_jobs_total", {
        job_kind: "agent_run.execute",
        outcome: "succeeded",
      }),
    ).toBe(1);
    const observed = recording.metrics
      .filter((m) => m.type === "observe")
      .map((m) => [m.metric, m.value]);
    expect(observed).toContainEqual([
      "company_os_provider_duration_seconds",
      1.2,
    ]);
    expect(observed).toContainEqual([
      "company_os_agent_run_duration_seconds",
      1.2,
    ]);
  });

  it("counts a decision evaluation by outcome and policy version, never by id", () => {
    const recording = createRecordingTelemetry();
    const trace = createWorkerTelemetry(recording).startJob({
      ...JOB,
      kind: "decision.shadow_evaluate",
    });
    trace.settled({
      subject: "decision_evaluation",
      status: "invalid",
      policyVersion: "decision_shadow.v2",
    });
    trace.end({ outcome: "succeeded" });
    expect(
      recording.counted("company_os_decision_evaluations_total", {
        outcome: "invalid",
        policy_version: "decision_shadow.v2",
      }),
    ).toBe(1);
    expect(recording.counted("company_os_agent_runs_total")).toBe(0);
  });

  it("passes a phase's value and error through unchanged", async () => {
    const trace = createWorkerTelemetry(createRecordingTelemetry()).startJob(
      JOB,
    );
    const error = new Error("prepare rolled back");
    await expect(
      trace.phase("company_os.governance.check", async () => 42),
    ).resolves.toBe(42);
    await expect(
      trace.phase("company_os.settlement", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  it("ends a job span once and keeps the active-jobs gauge exact", () => {
    const recording = createRecordingTelemetry();
    const telemetry = createWorkerTelemetry(recording);
    const first = telemetry.startJob(JOB);
    const second = telemetry.startJob({ ...JOB, id: RUN });
    first.end({ outcome: "succeeded" });
    first.end({ outcome: "failed" });
    second.end({ outcome: "interrupted" });
    const gauge = recording.metrics
      .filter((m) => m.metric === "company_os_worker_active_jobs")
      .map((m) => m.value);
    expect(gauge).toEqual([0, 1, 2, 1, 0]);
    expect(recording.counted("company_os_jobs_total")).toBe(2);
    expect(recording.spans.map((span) => span.ends)).toEqual([1, 1]);
  });

  it("publishes the queue depth, and only a whole, non-negative one", () => {
    const recording = createRecordingTelemetry();
    const telemetry = createWorkerTelemetry(recording, {
      readsQueueDepth: true,
    });
    telemetry.queueDepth(12);
    telemetry.queueDepth(Number.NaN);
    telemetry.queueDepth(-1);
    expect(
      recording.metrics
        .filter((m) => m.metric === "company_os_worker_queue_depth")
        .map((m) => m.value),
    ).toEqual([12]);
    expect(telemetry.readsQueueDepth).toBe(true);
  });

  it("is the no-op, reading nothing extra, when the port records nothing", () => {
    expect(createWorkerTelemetry(NOOP_TELEMETRY)).toBe(NOOP_WORKER_TELEMETRY);
    expect(NOOP_WORKER_TELEMETRY.readsQueueDepth).toBe(false);
  });
});

describe("telemetry failure isolation", () => {
  it("a port that throws on every call changes no value, no error and no ordering", async () => {
    const trace = createWorkerTelemetry(THROWING_TELEMETRY, {
      readsQueueDepth: true,
    }).startJob(JOB);
    const outcome = {
      ok: false as const,
      error: new Error(TELEMETRY_SENTINELS.providerOutput),
      durationMs: 5,
    };
    const steps: string[] = [];
    await expect(
      trace.phase("company_os.governance.check", async () => {
        steps.push("prepare");
        return "call";
      }),
    ).resolves.toBe("call");
    await expect(
      trace.providerCall("openai", async () => {
        steps.push("call");
        return outcome;
      }),
    ).resolves.toBe(outcome);
    expect(() => {
      trace.settled({ subject: "agent_run", status: "indeterminate" });
      trace.end({ outcome: "succeeded" });
    }).not.toThrow();
    expect(steps).toEqual(["prepare", "call"]);
  });

  it("a guarded port drops undeclared spans and metrics and sanitises before the adapter sees anything", () => {
    const recording = createRecordingTelemetry();
    const guarded = guardTelemetry(recording);
    const loose = guarded as unknown as {
      startSpan(name: string, attributes?: object): { end(): void };
      count(metric: string, labels?: object): void;
    };
    loose.startSpan("company_os.patient.lookup", {}).end();
    loose.count("company_os_messages_total", {});
    const span = guarded.startSpan("company_os.provider.call", {
      "company_os.provider.kind": "openai",
      "gen_ai.prompt": TELEMETRY_SENTINELS.prompt,
    });
    span.setAttributes({ "exception.message": TELEMETRY_SENTINELS.secret });
    span.end("error");
    guarded.count("company_os_agent_runs_total", {
      outcome: TELEMETRY_SENTINELS.contactName,
    });
    expect(recording.spans.map((s) => s.name)).toEqual([
      "company_os.provider.call",
    ]);
    expect(recording.spans[0].attributes).toEqual({
      "company_os.provider.kind": "openai",
    });
    expect(recording.metrics).toEqual([
      {
        type: "count",
        metric: "company_os_agent_runs_total",
        value: 1,
        labels: { outcome: "other" },
      },
    ]);
    expect(recording.dump()).not.toContain("SENTINEL");
    expect(recording.dump()).not.toContain(TELEMETRY_SENTINELS.contactName);
  });

  it("the Prometheus exposition after a traced job carries no content and no identifier", async () => {
    const registry = createPrometheusRegistry();
    const trace = createWorkerTelemetry(registry).startJob(JOB);
    await trace.providerCall("openai", async () => ({
      ok: false as const,
      error: Object.assign(new Error(TELEMETRY_SENTINELS.prompt), {
        name: "TimeoutError",
      }),
      durationMs: 30_000,
    }));
    trace.settled({
      subject: "agent_run",
      status: "indeterminate",
      runId: RUN,
    });
    trace.end({ outcome: "succeeded", failureClass: "transient" });
    const text = registry.render();
    expect(text).toContain(
      'company_os_external_calls_total{operation="agent_run.execute",outcome="timeout"} 1',
    );
    for (const secret of [
      ...Object.values(TELEMETRY_SENTINELS),
      JOB.id,
      JOB.tenant_id,
      RUN,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("classifying how a call ended", () => {
  it("reads the error's class name and category enum, never its message", () => {
    const named = (name: string) =>
      Object.assign(new Error("timeout cancelled abort"), { name });
    expect(classifyCall({ ok: true, value: 1, durationMs: 1 })).toBe("ok");
    expect(
      classifyCall({ ok: false, error: named("TimeoutError"), durationMs: 1 }),
    ).toBe("timeout");
    expect(
      classifyCall({ ok: false, error: named("AbortError"), durationMs: 1 }),
    ).toBe("cancelled");
    expect(
      classifyCall({
        ok: false,
        error: { deadlineReached: true, modelError: { category: "cancelled" } },
        durationMs: 1,
      }),
    ).toBe("timeout");
    expect(
      classifyCall({
        ok: false,
        error: { modelError: { category: "cancelled" } },
        durationMs: 1,
      }),
    ).toBe("cancelled");
    // The message says "timeout"; the class says nothing: an error.
    expect(
      classifyCall({ ok: false, error: named("Error"), durationMs: 1 }),
    ).toBe("error");
  });

  it("counts an error whose properties throw as a plain error, and returns the outcome unchanged", async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("getter");
        },
      },
    );
    const recording = createRecordingTelemetry();
    const trace = createWorkerTelemetry(recording).startJob(JOB);
    const outcome = { ok: false as const, error: hostile, durationMs: 1 };
    await expect(trace.providerCall("fake", async () => outcome)).resolves.toBe(
      outcome,
    );
    expect(
      recording.counted("company_os_external_calls_total", {
        outcome: "error",
      }),
    ).toBe(1);
  });
});
