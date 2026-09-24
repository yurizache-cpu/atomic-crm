import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { startWorkerObservability } from "./fromEnv.ts";
import { metricsConfigFromEnv, startMetricsListener } from "./metricsServer.ts";
import { createPrometheusRegistry } from "./prometheusRegistry.ts";
import type { WorkerLogEvent, WorkerLogFields } from "../worker/log.ts";
import { NOOP_WORKER_TELEMETRY } from "./workerTelemetry.ts";

// The metrics listener (Phase 2E.1): off by default, loopback by default, GET
// /metrics only, and never a reason for the worker to stop or change.

const captureLog = () => {
  const lines: { event: WorkerLogEvent; fields?: WorkerLogFields }[] = [];
  const log = (event: WorkerLogEvent, fields?: WorkerLogFields) => {
    lines.push({ event, fields });
  };
  return { lines, log };
};

describe("the metrics configuration", () => {
  it("is off unless METRICS_ENABLED is exactly true", () => {
    expect(metricsConfigFromEnv({})).toEqual({ enabled: false });
    expect(metricsConfigFromEnv({ METRICS_ENABLED: "false" })).toEqual({
      enabled: false,
    });
    expect(metricsConfigFromEnv({ METRICS_PORT: "9464" })).toEqual({
      enabled: false,
    });
    expect(
      metricsConfigFromEnv({ METRICS_ENABLED: "yes", METRICS_PORT: "9464" }),
    ).toMatchObject({ enabled: false, error: expect.any(String) });
  });

  it("binds loopback unless told otherwise, and needs an explicit port", () => {
    expect(
      metricsConfigFromEnv({ METRICS_ENABLED: "true", METRICS_PORT: "9464" }),
    ).toEqual({ enabled: true, host: "127.0.0.1", port: 9464 });
    expect(metricsConfigFromEnv({ METRICS_ENABLED: "true" })).toMatchObject({
      enabled: false,
      error: expect.stringContaining("METRICS_PORT"),
    });
  });

  it("refuses a bad value, and names the variable but never echoes the value", () => {
    const secret = "sk-SENTINEL/secret value";
    for (const env of [
      { METRICS_ENABLED: "true", METRICS_PORT: secret },
      { METRICS_ENABLED: "true", METRICS_PORT: "70000" },
      { METRICS_ENABLED: "true", METRICS_PORT: "9464", METRICS_HOST: secret },
    ]) {
      const result = metricsConfigFromEnv(env);
      expect(result.enabled).toBe(false);
      expect(JSON.stringify(result)).not.toContain("SENTINEL");
      expect(JSON.stringify(result)).not.toContain("70000");
    }
  });
});

describe("the metrics listener", () => {
  it("serves GET /metrics on loopback as Prometheus text, and nothing else", async () => {
    const registry = createPrometheusRegistry();
    registry.setGauge("company_os_worker_queue_depth", 4);
    const listener = await startMetricsListener(
      { host: "127.0.0.1", port: 0 },
      registry.render,
    );
    try {
      expect(listener.host).toBe("127.0.0.1");
      const base = `http://127.0.0.1:${listener.port}`;
      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get("content-type")).toBe(
        "text/plain; version=0.0.4; charset=utf-8",
      );
      expect(await metrics.text()).toContain("company_os_worker_queue_depth 4");
      expect((await fetch(`${base}/`)).status).toBe(404);
      expect((await fetch(`${base}/metrics/../admin`)).status).toBe(404);
      expect((await fetch(`${base}/debug`)).status).toBe(404);
      const post = await fetch(`${base}/metrics`, {
        method: "POST",
        body: "company_os_jobs_total 999",
      });
      expect(post.status).toBe(405);
      expect(await (await fetch(`${base}/metrics`)).text()).not.toContain(
        "999",
      );
    } finally {
      await listener.close();
    }
  });

  it("rejects, rather than crashing, when its port is taken", async () => {
    const holder = createServer();
    await new Promise<void>((done) => holder.listen(0, "127.0.0.1", done));
    const { port } = holder.address() as AddressInfo;
    try {
      await expect(
        startMetricsListener({ host: "127.0.0.1", port }, () => ""),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((done) => holder.close(() => done()));
    }
  });
});

describe("the worker's observability from its environment", () => {
  it("is the no-op, opening nothing, when nothing is configured", async () => {
    const { lines, log } = captureLog();
    let listened = false;
    const observability = await startWorkerObservability({}, log, async () => {
      listened = true;
      throw new Error("unreachable");
    });
    expect(observability.telemetry).toBe(NOOP_WORKER_TELEMETRY);
    expect(listened).toBe(false);
    expect(lines).toEqual([]);
    await observability.close();
  });

  it("turns metrics off, with fixed text, when the listener cannot start", async () => {
    const { lines, log } = captureLog();
    const observability = await startWorkerObservability(
      { METRICS_ENABLED: "true", METRICS_PORT: "9464" },
      log,
      async () => {
        throw new Error("EADDRINUSE sk-SENTINEL");
      },
    );
    expect(observability.telemetry).toBe(NOOP_WORKER_TELEMETRY);
    expect(lines.map((line) => line.event)).toEqual(["telemetry.disabled"]);
    expect(JSON.stringify(lines)).not.toContain("SENTINEL");
  });

  it("says OTLP export is unavailable in this build instead of ignoring the variable", async () => {
    const { lines, log } = captureLog();
    const observability = await startWorkerObservability(
      { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.internal:4318" },
      log,
    );
    expect(observability.telemetry).toBe(NOOP_WORKER_TELEMETRY);
    expect(lines.map((line) => line.event)).toEqual([
      "telemetry.tracing_unavailable",
    ]);
    expect(JSON.stringify(lines)).not.toContain("collector.internal");
  });

  it("listens, reports the port and whether it is loopback, and serves the worker's metrics", async () => {
    const { lines, log } = captureLog();
    const observability = await startWorkerObservability(
      { METRICS_ENABLED: "true", METRICS_PORT: "9464" },
      log,
      (config, render) => startMetricsListener({ ...config, port: 0 }, render),
    );
    try {
      expect(observability.telemetry.readsQueueDepth).toBe(true);
      observability.telemetry.queueDepth(2);
      const detail = lines.find(
        (line) => line.event === "telemetry.metrics_listening",
      )?.fields?.detail;
      expect(detail).toMatch(/^metrics on port [0-9]+ \(loopback\)$/);
      const port = Number(detail?.match(/port ([0-9]+)/)?.[1]);
      const text = await (
        await fetch(`http://127.0.0.1:${port}/metrics`)
      ).text();
      expect(text).toContain("company_os_worker_queue_depth 2");
    } finally {
      await observability.close();
    }
  });
});
