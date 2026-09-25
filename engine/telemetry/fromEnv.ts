// The worker's observability, from its environment (Phase 2E.1).
//
// Absent configuration means the no-op: nothing recorded, no listener, no
// request. Every problem here (a bad variable, a port in use, an SDK that
// will not start) turns that part of observability OFF, logged with fixed
// text; none of them stops the worker or changes what it does. Observability
// is never a boot gate.
//
//   METRICS_ENABLED=true, METRICS_PORT   the Prometheus /metrics listener
//   OTEL_EXPORTER_OTLP_ENDPOINT          spans over OTLP/HTTP to a Collector
//
// The OpenTelemetry adapter is loaded only when the endpoint is set, so a
// worker without it never loads the SDK, let alone opens a connection.

import type { WorkerLogger } from "../worker/log.ts";
import {
  metricsConfigFromEnv,
  startMetricsListener,
  type MetricsConfig,
  type MetricsListener,
} from "./metricsServer.ts";
import { createPrometheusRegistry } from "./prometheusRegistry.ts";
import {
  combineTelemetry,
  NOOP_TELEMETRY,
  type TelemetryPort,
} from "./telemetryPort.ts";
import {
  createWorkerTelemetry,
  NOOP_WORKER_TELEMETRY,
  type WorkerTelemetry,
} from "./workerTelemetry.ts";

export interface WorkerObservability {
  readonly telemetry: WorkerTelemetry;
  /** Flushes spans and stops the listener, if any. Never throws. */
  close(): Promise<void>;
}

/** The OTLP tracer, as fromEnv needs it: a port and a bounded shutdown. */
export interface TracingHandle {
  readonly telemetry: TelemetryPort;
  shutdown(): Promise<void>;
}

export interface ObservabilitySeams {
  readonly listen?: (
    config: MetricsConfig,
    render: () => string,
  ) => Promise<MetricsListener>;
  /** Builds the OTLP tracer for a traces URL; tests replace it. */
  readonly startTracing?: (tracesUrl: string) => Promise<TracingHandle>;
}

const LOOPBACK = /^(127\.[0-9.]+|::1|localhost)$/;

const OFF: WorkerObservability = Object.freeze({
  telemetry: NOOP_WORKER_TELEMETRY,
  close: async () => {},
});

/**
 * The OTLP/HTTP traces URL from OTEL_EXPORTER_OTLP_ENDPOINT, as the
 * OpenTelemetry specification defines it (the base URL plus `/v1/traces`), or
 * null when the value is not an http(s) URL. No address is ever assumed.
 */
export function tracesUrlFromEndpoint(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const base = url.href.replace(/\/+$/, "");
  return `${base}/v1/traces`;
}

const defaultStartTracing = async (
  tracesUrl: string,
): Promise<TracingHandle> => {
  const { createOpenTelemetryTracing } = await import("./openTelemetry.ts");
  return createOpenTelemetryTracing({ tracesUrl });
};

async function startTracingFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  log: WorkerLogger,
  startTracing: (tracesUrl: string) => Promise<TracingHandle>,
): Promise<TracingHandle | null> {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return null;
  const tracesUrl = tracesUrlFromEndpoint(endpoint);
  if (tracesUrl === null) {
    log("telemetry.tracing_unavailable", {
      detail:
        "OTEL_EXPORTER_OTLP_ENDPOINT is not an http(s) URL without credentials; spans are not exported",
    });
    return null;
  }
  try {
    const tracing = await startTracing(tracesUrl);
    log("telemetry.tracing_enabled", {
      detail:
        "spans are exported over OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT",
    });
    return tracing;
  } catch {
    log("telemetry.tracing_unavailable", {
      detail:
        "the OpenTelemetry exporter could not start; spans are not exported",
    });
    return null;
  }
}

export async function startWorkerObservability(
  env: Readonly<Record<string, string | undefined>>,
  log: WorkerLogger,
  seams: ObservabilitySeams = {},
): Promise<WorkerObservability> {
  const listen = seams.listen ?? startMetricsListener;
  const tracing = await startTracingFromEnv(
    env,
    log,
    seams.startTracing ?? defaultStartTracing,
  );

  let listener: MetricsListener | null = null;
  let registry: ReturnType<typeof createPrometheusRegistry> | null = null;
  const config = metricsConfigFromEnv(env);
  if ("error" in config) {
    log("telemetry.disabled", { detail: config.error });
  } else if (config.enabled) {
    registry = createPrometheusRegistry();
    try {
      listener = await listen(config, registry.render);
      log("telemetry.metrics_listening", {
        detail: `metrics on port ${listener.port} (${
          LOOPBACK.test(listener.host) ? "loopback" : "not loopback"
        })`,
      });
    } catch {
      registry = null;
      log("telemetry.disabled", {
        detail:
          "the metrics listener could not start on METRICS_HOST and METRICS_PORT; metrics are off",
      });
    }
  }

  if (!registry && !tracing) return OFF;
  const port = combineTelemetry([
    registry ?? NOOP_TELEMETRY,
    tracing?.telemetry ?? NOOP_TELEMETRY,
  ]);
  return Object.freeze({
    // The queue depth is a metric: read it only when metrics are served.
    telemetry: createWorkerTelemetry(port, { readsQueueDepth: !!registry }),
    close: async () => {
      try {
        await listener?.close();
      } catch {
        // Stopping anyway.
      }
      await tracing?.shutdown();
    },
  });
}
