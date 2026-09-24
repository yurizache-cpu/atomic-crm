// The telemetry boundary (Phase 2E.1). Application and worker code depend on
// this port, never on an exporter or a vendor SDK.
//
// Every implementation obeys three rules, and guardTelemetry() (below) makes
// all three hold even for one that does not, because it is the ONE boundary
// every caller goes through before any adapter sees anything:
//
//   1. It never throws into the caller. A telemetry failure is not a job
//      failure, not a retry and not a refusal.
//   2. It never waits. Recording is synchronous and in memory; an exporter
//      works in the background, and a slow or absent collector costs nothing
//      the caller can observe.
//   3. It emits only what catalog.ts allows. Names outside the catalogue are
//      ignored; attributes and labels pass through its sanitisers.
//
// The default is NOOP_TELEMETRY: with no observability configured, nothing is
// recorded, no socket is opened and no request leaves the process.

import {
  isMetricName,
  isSpanName,
  sanitizeMetricLabels,
  sanitizeSpanAttributes,
  type MetricName,
  type SpanAttributes,
  type SpanName,
} from "./catalog.ts";

export type SpanStatus = "ok" | "error";

export interface TelemetrySpan {
  setAttributes(attributes: Readonly<Record<string, unknown>>): void;
  /** Ends the span once; later calls are ignored. */
  end(status?: SpanStatus): void;
}

export interface TelemetryPort {
  /** A span, optionally the child of another span from the same port. */
  startSpan(
    name: SpanName,
    attributes?: Readonly<Record<string, unknown>>,
    parent?: TelemetrySpan,
  ): TelemetrySpan;
  /** Adds `by` (default 1) to a counter. */
  count(
    metric: MetricName,
    labels?: Readonly<Record<string, unknown>>,
    by?: number,
  ): void;
  /** Records one observation into a histogram (a duration in seconds). */
  observe(
    metric: MetricName,
    value: number,
    labels?: Readonly<Record<string, unknown>>,
  ): void;
  /** Sets a gauge. */
  setGauge(
    metric: MetricName,
    value: number,
    labels?: Readonly<Record<string, unknown>>,
  ): void;
}

export type { SpanAttributes };

const NOOP_SPAN: TelemetrySpan = Object.freeze({
  setAttributes() {},
  end() {},
});

/** Records nothing, opens nothing, sends nothing. The safe default. */
export const NOOP_TELEMETRY: TelemetryPort = Object.freeze({
  startSpan: () => NOOP_SPAN,
  count() {},
  observe() {},
  setGauge() {},
});

/**
 * The boundary between the Company OS and any telemetry adapter:
 *   * sanitisation: a span or metric the catalogue does not declare is
 *     dropped, span attributes keep only allowlisted keys with values their
 *     rule accepts, and metric labels are exactly the metric's declared labels
 *     (a rejected value becomes "other"). An adapter never sees anything else.
 *   * failure isolation: every call into `port` is contained, so a broken
 *     exporter, a bug in an adapter or a throwing test double degrades to
 *     "nothing recorded" and never reaches the Company OS work that called it.
 */
export function guardTelemetry(port: TelemetryPort): TelemetryPort {
  const contain = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // Deliberately silent: reporting a telemetry failure through telemetry
      // is a loop, and through the worker log is a flood. The exporter's own
      // absence is visible where it matters: in the missing data.
    }
  };
  const guardSpan = (span: TelemetrySpan | undefined): TelemetrySpan => {
    if (!span) return NOOP_SPAN;
    return Object.freeze({
      setAttributes: (attributes: Readonly<Record<string, unknown>>) =>
        contain(() => span.setAttributes(sanitizeSpanAttributes(attributes))),
      end: (status?: SpanStatus) => contain(() => span.end(status)),
    });
  };
  // The unwrapped span each guarded span stands for, so a child can name its
  // parent to the adapter that created it.
  const inner = new WeakMap<TelemetrySpan, TelemetrySpan>();
  const guarded: TelemetryPort = {
    startSpan(name, attributes, parent) {
      if (!isSpanName(name)) return NOOP_SPAN;
      let created: TelemetrySpan | undefined;
      contain(() => {
        created = port.startSpan(
          name,
          sanitizeSpanAttributes(attributes),
          parent ? inner.get(parent) : undefined,
        );
      });
      const guarded = guardSpan(created);
      if (created) inner.set(guarded, created);
      return guarded;
    },
    count: (metric, labels, by) =>
      contain(() => {
        if (isMetricName(metric)) {
          port.count(metric, sanitizeMetricLabels(metric, labels), by);
        }
      }),
    observe: (metric, value, labels) =>
      contain(() => {
        if (isMetricName(metric)) {
          port.observe(metric, value, sanitizeMetricLabels(metric, labels));
        }
      }),
    setGauge: (metric, value, labels) =>
      contain(() => {
        if (isMetricName(metric)) {
          port.setGauge(metric, value, sanitizeMetricLabels(metric, labels));
        }
      }),
  };
  return Object.freeze(guarded);
}
