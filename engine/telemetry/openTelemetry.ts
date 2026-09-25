// The OpenTelemetry adapter behind TelemetryPort (Phase 2E.1): spans only,
// exported over OTLP/HTTP to the Collector, the single swappable egress.
// Metrics stay on the worker's own Prometheus endpoint (prometheusRegistry.ts).
//
// This is the ONLY module that imports OpenTelemetry. The runtime reaches it
// through guardTelemetry, so what arrives here is already the catalogue's:
// declared span names, allowlisted attributes, closed-set values (SI-60).
//
// WHAT IT DOES NOT DO, on purpose:
//   * no resource detection: the only resource attribute is service.name, so
//     no host name, process id, command line, user or environment variable is
//     ever exported;
//   * no auto-instrumentation, no global registration, no context manager:
//     a span's parent is passed explicitly, and nothing patches http, pg or
//     any module the worker loads;
//   * no business effect: spans are batched and exported in the background.
//     A slow, failing or absent Collector drops spans (the SDK's own error
//     handler, silent by default) and never reaches a job, a retry, a
//     settlement, spend, a review, a decision or a send (SI-61).

import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resources, tracing } from "@opentelemetry/sdk-node";

import {
  NOOP_TELEMETRY,
  type TelemetryPort,
  type TelemetrySpan,
} from "./telemetryPort.ts";

export const SERVICE_NAME = "company-os-worker";
/** Bounded so an unreachable Collector costs memory we chose, never more. */
const MAX_QUEUE_SIZE = 2_048;
const EXPORT_TIMEOUT_MS = 5_000;
/** How long a stopping worker waits to flush spans before it gives up. */
export const SHUTDOWN_TIMEOUT_MS = 3_000;

export interface OpenTelemetryTracing {
  readonly telemetry: TelemetryPort;
  /** Flushes and stops within SHUTDOWN_TIMEOUT_MS. Never throws. */
  shutdown(): Promise<void>;
}

export function createOpenTelemetryTracing(options: {
  readonly tracesUrl: string;
  /** Tests only: an exporter to capture spans in memory. */
  readonly exporter?: tracing.SpanExporter;
  /** Tests only: export each span as it ends instead of in batches. */
  readonly immediate?: boolean;
}): OpenTelemetryTracing {
  const exporter =
    options.exporter ??
    new OTLPTraceExporter({
      url: options.tracesUrl,
      timeoutMillis: EXPORT_TIMEOUT_MS,
    });
  const processor = options.immediate
    ? new tracing.SimpleSpanProcessor(exporter)
    : new tracing.BatchSpanProcessor(exporter, {
        maxQueueSize: MAX_QUEUE_SIZE,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      });
  const provider = new tracing.BasicTracerProvider({
    resource: resources.resourceFromAttributes({
      "service.name": SERVICE_NAME,
    }),
    spanProcessors: [processor],
  });
  const tracer = provider.getTracer("company-os");
  const spans = new WeakMap<TelemetrySpan, Span>();

  const telemetry: TelemetryPort = {
    startSpan(name, attributes, parent) {
      const parentSpan = parent ? spans.get(parent) : undefined;
      const span = tracer.startSpan(
        name,
        {
          kind: SpanKind.INTERNAL,
          attributes: attributes as Record<string, string | number | boolean>,
        },
        parentSpan ? trace.setSpan(ROOT_CONTEXT, parentSpan) : ROOT_CONTEXT,
      );
      let ended = false;
      const handle: TelemetrySpan = {
        setAttributes(more) {
          if (!ended) {
            span.setAttributes(
              more as Record<string, string | number | boolean>,
            );
          }
        },
        end(status) {
          if (ended) return;
          ended = true;
          span.setStatus({
            code: status === "error" ? SpanStatusCode.ERROR : SpanStatusCode.OK,
          });
          span.end();
        },
      };
      spans.set(handle, span);
      return handle;
    },
    // Metrics are the Prometheus registry's; this adapter exports spans only.
    count: NOOP_TELEMETRY.count,
    observe: NOOP_TELEMETRY.observe,
    setGauge: NOOP_TELEMETRY.setGauge,
  };

  return Object.freeze({
    telemetry: Object.freeze(telemetry),
    async shutdown() {
      try {
        await Promise.race([
          provider.shutdown(),
          new Promise((done) => setTimeout(done, SHUTDOWN_TIMEOUT_MS).unref()),
        ]);
      } catch {
        // Stopping anyway: unexported spans are telemetry, not work.
      }
    },
  });
}
