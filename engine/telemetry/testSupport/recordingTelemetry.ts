// A TelemetryPort that records what reaches an adapter, for tests. It stands
// where an exporter would: whatever it holds is what would have been exported.

import type { SpanName } from "../catalog.ts";
import type {
  SpanStatus,
  TelemetryPort,
  TelemetrySpan,
} from "../telemetryPort.ts";

export interface RecordedSpan {
  readonly name: SpanName;
  readonly attributes: Record<string, unknown>;
  readonly parent: RecordedSpan | undefined;
  status: SpanStatus | undefined;
  ends: number;
}

export interface RecordedMetric {
  readonly type: "count" | "observe" | "setGauge";
  readonly metric: string;
  readonly value: number;
  readonly labels: Readonly<Record<string, unknown>> | undefined;
}

export interface RecordingTelemetry extends TelemetryPort {
  readonly spans: RecordedSpan[];
  readonly metrics: RecordedMetric[];
  /** Everything recorded, as one string, for sentinel searches. */
  dump(): string;
  /** The sum of a counter's increments with these exact label values. */
  counted(metric: string, labels?: Readonly<Record<string, string>>): number;
}

export function createRecordingTelemetry(): RecordingTelemetry {
  const spans: RecordedSpan[] = [];
  const metrics: RecordedMetric[] = [];
  const bySpan = new WeakMap<TelemetrySpan, RecordedSpan>();

  const recording: RecordingTelemetry = {
    spans,
    metrics,
    startSpan(name, attributes, parent) {
      const recorded: RecordedSpan = {
        name,
        attributes: { ...attributes },
        parent: parent ? bySpan.get(parent) : undefined,
        status: undefined,
        ends: 0,
      };
      spans.push(recorded);
      const span: TelemetrySpan = {
        setAttributes(more) {
          Object.assign(recorded.attributes, more);
        },
        end(status) {
          recorded.ends += 1;
          recorded.status = status;
        },
      };
      bySpan.set(span, recorded);
      return span;
    },
    count(metric, labels, by = 1) {
      metrics.push({ type: "count", metric, value: by, labels });
    },
    observe(metric, value, labels) {
      metrics.push({ type: "observe", metric, value, labels });
    },
    setGauge(metric, value, labels) {
      metrics.push({ type: "setGauge", metric, value, labels });
    },
    dump() {
      return JSON.stringify({
        spans: spans.map((span) => ({
          name: span.name,
          attributes: span.attributes,
          parent: span.parent?.name,
        })),
        metrics,
      });
    },
    counted(metric, labels = {}) {
      return metrics
        .filter(
          (entry) =>
            entry.type === "count" &&
            entry.metric === metric &&
            Object.entries(labels).every(
              ([key, value]) => entry.labels?.[key] === value,
            ),
        )
        .reduce((sum, entry) => sum + entry.value, 0);
    },
  };
  return recording;
}

/** A port whose every method throws: the failure-isolation double. */
export const THROWING_TELEMETRY: TelemetryPort = Object.freeze({
  startSpan() {
    throw new Error("telemetry exporter is down");
  },
  count() {
    throw new Error("telemetry exporter is down");
  },
  observe() {
    throw new Error("telemetry exporter is down");
  },
  setGauge() {
    throw new Error("telemetry exporter is down");
  },
});

/**
 * Content that must never reach telemetry, one per category the privacy
 * boundary names. Each is distinctive, so a search for it is not vacuous.
 */
export const TELEMETRY_SENTINELS = Object.freeze({
  messageBody: "SENTINEL-BODY Ola, preciso remarcar minha sessao de terapia",
  replyDraft: "SENTINEL-DRAFT Claro! Podemos remarcar para quinta",
  phone: "+5511987654321",
  email: "sentinel.patient@example.com",
  contactName: "SENTINEL Maria Sentinela da Silva",
  crmNote: "SENTINEL-NOTE paciente relatou ansiedade",
  prompt: "SENTINEL-PROMPT You are the lead triage agent",
  modelResponse: "SENTINEL-RESPONSE the lead wants a first session",
  providerOutput: "SENTINEL-PROVIDER upstream said: request input echoed",
  rawSql: "select * from public.contacts where email = 'x'",
  secret: "sk-SENTINELSECRET0123456789abcdef",
  token: "eyJhbGciOiJIUzI1NiJ9.SENTINEL.token",
} as const);
