// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tracing } from "@opentelemetry/sdk-node";
import { afterEach, describe, expect, it } from "vitest";

import { createRegistry } from "../worker/handlerRegistry.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import { fakeDb, JOB } from "../worker/testSupport/fakeWorkerDatabase.ts";
import {
  createOpenTelemetryTracing,
  SHUTDOWN_TIMEOUT_MS,
} from "./openTelemetry.ts";
import { SPAN_ATTRIBUTE_RULES } from "./catalog.ts";
import { guardTelemetry } from "./telemetryPort.ts";
import { TELEMETRY_SENTINELS } from "./testSupport/recordingTelemetry.ts";
import { createWorkerTelemetry } from "./workerTelemetry.ts";

// The OpenTelemetry adapter (Phase 2E.1): what leaves the process over OTLP is
// the catalogue's spans and nothing else, the span tree is the runtime's, and
// a Collector that is down or hangs changes nothing the worker does.

const RUN = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const agentJob = { ...JOB, kind: "agent_run.execute" };
const SENTINELS = Object.values(TELEMETRY_SENTINELS);

/** A traced attempt through the facade, with content in every place it could leak from. */
const traceOneAttempt = async (
  telemetry: ReturnType<typeof createWorkerTelemetry>,
) => {
  const trace = telemetry.startJob(agentJob);
  await trace.phase("company_os.governance.check", async () => ({
    prompt: TELEMETRY_SENTINELS.prompt,
  }));
  await trace.providerCall("openai", async () => ({
    ok: false as const,
    error: Object.assign(new Error(TELEMETRY_SENTINELS.providerOutput), {
      name: "TimeoutError",
      body: TELEMETRY_SENTINELS.messageBody,
    }),
    durationMs: 1_500,
  }));
  await trace.phase("company_os.settlement", async () => "settled");
  trace.settled({ subject: "agent_run", status: "indeterminate", runId: RUN });
  trace.end({ outcome: "succeeded" });
};

describe("the OpenTelemetry adapter", () => {
  it("exports the runtime's span tree with allowlisted attributes only, and a resource that names the service and nothing else", async () => {
    const exporter = new tracing.InMemorySpanExporter();
    const otel = createOpenTelemetryTracing({
      tracesUrl: "http://127.0.0.1:1/v1/traces",
      exporter,
      immediate: true,
    });
    await traceOneAttempt(
      createWorkerTelemetry(guardTelemetry(otel.telemetry)),
    );
    // Read before shutdown: shutting the provider down resets this exporter.
    const spans = exporter.getFinishedSpans();
    await otel.shutdown();
    const byName = new Map(spans.map((span) => [span.name, span]));
    expect([...byName.keys()].sort()).toEqual([
      "company_os.governance.check",
      "company_os.job.execute",
      "company_os.provider.call",
      "company_os.settlement",
    ]);
    const root = byName.get("company_os.job.execute");
    for (const child of spans.filter((span) => span !== root)) {
      expect(child.spanContext().traceId).toBe(root?.spanContext().traceId);
      expect(child.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    }
    expect(root?.parentSpanContext).toBeUndefined();
    expect(root?.attributes).toEqual({
      "company_os.job.kind": "agent_run.execute",
      "company_os.job.attempt": 1,
      "company_os.tenant.id": agentJob.tenant_id,
      "company_os.job.id": agentJob.id,
      "company_os.agent_run.outcome": "indeterminate",
      "company_os.run.id": RUN,
      "company_os.job.outcome": "succeeded",
    });
    expect(byName.get("company_os.provider.call")?.attributes).toEqual({
      "company_os.operation": "agent_run.execute",
      "company_os.provider.kind": "openai",
      "company_os.call.outcome": "timeout",
    });
    expect(byName.get("company_os.provider.call")?.status.code).toBe(2);
    expect(root?.status.code).toBe(1);
    for (const span of spans) {
      for (const key of Object.keys(span.attributes)) {
        expect(Object.keys(SPAN_ATTRIBUTE_RULES)).toContain(key);
      }
      expect(span.events).toEqual([]);
      expect(span.resource.attributes).toEqual({
        "service.name": "company-os-worker",
      });
    }
    const exported = JSON.stringify(
      spans.map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
        links: span.links,
        status: span.status,
        resource: span.resource.attributes,
      })),
    );
    for (const sentinel of SENTINELS) {
      expect(exported).not.toContain(sentinel);
    }
  });
});

describe("OTLP/HTTP on the wire", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((done) =>
      server ? server.close(() => done()) : done(),
    );
    server = undefined;
  });

  const collector = async (
    onRequest: (request: IncomingMessage, body: string) => boolean,
  ): Promise<string> => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (onRequest(request, Buffer.concat(chunks).toString("utf8"))) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
        }
      });
    });
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    return `http://127.0.0.1:${(server?.address() as AddressInfo).port}/v1/traces`;
  };

  it("sends the batched spans as OTLP JSON to the traces URL, and nothing but the catalogue's content", async () => {
    const received: { path?: string; type?: string; body: string }[] = [];
    const tracesUrl = await collector((request, body) => {
      received.push({
        path: request.url,
        type: request.headers["content-type"],
        body,
      });
      return true;
    });
    const otel = createOpenTelemetryTracing({ tracesUrl });
    await traceOneAttempt(
      createWorkerTelemetry(guardTelemetry(otel.telemetry)),
    );
    await otel.shutdown();

    expect(received.length).toBeGreaterThan(0);
    expect(received[0].path).toBe("/v1/traces");
    expect(received[0].type).toMatch(/application\/json/);
    const body = received.map((request) => request.body).join("\n");
    expect(body).toContain("company_os.job.execute");
    expect(body).toContain("company_os.provider.call");
    expect(body).toContain('"service.name"');
    for (const sentinel of SENTINELS) {
      expect(body).not.toContain(sentinel);
    }
    expect(body).not.toMatch(/process\.|host\.name|os\.type|user\./);
  });

  it("changes nothing the worker does when the Collector is down, and stops within its bound", async () => {
    const baseline = fakeDb({
      leased: agentJob,
      resume: [agentJob, agentJob, agentJob],
    });
    const traced = fakeDb({
      leased: agentJob,
      resume: [agentJob, agentJob, agentJob],
    });
    const handler = {
      kind: "agent_run.execute",
      shape: "external_call" as const,
      prepareCapabilities: [],
      settleCapabilities: [],
      async prepare() {
        return { kind: "call" as const, state: {}, providerKind: "fake" };
      },
      async call() {
        return "answered";
      },
      async settle() {
        return {
          detail: "settled",
          observation: {
            subject: "agent_run" as const,
            status: "succeeded",
            runId: RUN,
          },
        };
      },
    };
    let calls = 0;
    const counting = {
      ...handler,
      async call() {
        calls += 1;
        return "answered";
      },
    };
    // Nothing listens on port 1: every export fails.
    const otel = createOpenTelemetryTracing({
      tracesUrl: "http://127.0.0.1:1/v1/traces",
      immediate: true,
    });

    const plain = await runOneJob(baseline.db, {
      workerId: "w1",
      registry: createRegistry([handler]),
    });
    const withTracing = await runOneJob(traced.db, {
      workerId: "w1",
      registry: createRegistry([counting]),
      telemetry: createWorkerTelemetry(otel.telemetry),
    });
    const startedAt = Date.now();
    await otel.shutdown();

    expect({ ...withTracing, durationMs: 0 }).toEqual({
      ...plain,
      durationMs: 0,
    });
    expect(traced.calls.map((c) => c.sql)).toEqual(
      baseline.calls.map((c) => c.sql),
    );
    expect(traced.committed).toEqual(baseline.committed);
    expect(calls).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(SHUTDOWN_TIMEOUT_MS + 1_000);
  });

  it("stops within its bound even when the Collector accepts and never answers", async () => {
    const tracesUrl = await collector(() => false);
    const otel = createOpenTelemetryTracing({ tracesUrl });
    await traceOneAttempt(
      createWorkerTelemetry(guardTelemetry(otel.telemetry)),
    );
    const startedAt = Date.now();
    await otel.shutdown();
    expect(Date.now() - startedAt).toBeLessThan(SHUTDOWN_TIMEOUT_MS + 1_000);
  }, 15_000);
});
