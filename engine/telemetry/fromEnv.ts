// The worker's observability, from its environment (Phase 2E.1).
//
// Absent configuration means the no-op: nothing recorded, no listener, no
// request. Every problem here, a bad variable or a port in use, turns
// observability OFF and is logged with fixed text; none of them stops the
// worker or changes what it does. Observability is never a boot gate.
//
// OTLP TRACE EXPORT IS NOT IN THIS BUILD. The OpenTelemetry SDK packages were
// authorised for Phase 2E but not installed (docs/PHASE_2E_REPORT.md §3), so
// OTEL_EXPORTER_OTLP_ENDPOINT is reported as unavailable rather than silently
// ignored. The spans are instrumented against TelemetryPort already; exporting
// them is an adapter behind this function, and nothing else changes.

import type { WorkerLogger } from "../worker/log.ts";
import {
  metricsConfigFromEnv,
  startMetricsListener,
  type MetricsConfig,
  type MetricsListener,
} from "./metricsServer.ts";
import { createPrometheusRegistry } from "./prometheusRegistry.ts";
import {
  createWorkerTelemetry,
  NOOP_WORKER_TELEMETRY,
  type WorkerTelemetry,
} from "./workerTelemetry.ts";

export interface WorkerObservability {
  readonly telemetry: WorkerTelemetry;
  /** Stops the listener, if any. Never throws. */
  close(): Promise<void>;
}

const LOOPBACK = /^(127\.[0-9.]+|::1|localhost)$/;

const OFF: WorkerObservability = Object.freeze({
  telemetry: NOOP_WORKER_TELEMETRY,
  close: async () => {},
});

export async function startWorkerObservability(
  env: Readonly<Record<string, string | undefined>>,
  log: WorkerLogger,
  listen: (
    config: MetricsConfig,
    render: () => string,
  ) => Promise<MetricsListener> = startMetricsListener,
): Promise<WorkerObservability> {
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) {
    log("telemetry.tracing_unavailable", {
      detail:
        "OTEL_EXPORTER_OTLP_ENDPOINT is set, but this build has no OpenTelemetry SDK: spans are not exported",
    });
  }

  const config = metricsConfigFromEnv(env);
  if ("error" in config) {
    log("telemetry.disabled", { detail: config.error });
    return OFF;
  }
  if (!config.enabled) return OFF;

  const registry = createPrometheusRegistry();
  let listener: MetricsListener;
  try {
    listener = await listen(config, registry.render);
  } catch {
    log("telemetry.disabled", {
      detail:
        "the metrics listener could not start on METRICS_HOST and METRICS_PORT; metrics are off",
    });
    return OFF;
  }
  log("telemetry.metrics_listening", {
    detail: `metrics on port ${listener.port} (${
      LOOPBACK.test(listener.host) ? "loopback" : "not loopback"
    })`,
  });
  return Object.freeze({
    telemetry: createWorkerTelemetry(registry, { readsQueueDepth: true }),
    close: async () => {
      try {
        await listener.close();
      } catch {
        // Stopping anyway.
      }
    },
  });
}
