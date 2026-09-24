import { describe, expect, it } from "vitest";

import { createPrometheusRegistry } from "./prometheusRegistry.ts";
import { guardTelemetry } from "./telemetryPort.ts";
import { TELEMETRY_SENTINELS } from "./testSupport/recordingTelemetry.ts";

// The worker's Prometheus exposition (Phase 2E.1): valid text format 0.0.4,
// correct counters, histograms and gauges, and series bounded by the catalogue.

const TENANT = "0b8f3a3e-5c1a-4d2e-9f6b-2a7c1d9e4f10";

// One sample line: a metric name, optional labels with quoted values, and a
// number (a Go ParseFloat value, as Prometheus reads it).
const SAMPLE =
  /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\["\\n])*"(,[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\["\\n])*")*\})? (-?[0-9]+(\.[0-9]+)?(e[-+]?[0-9]+)?|\+Inf|-Inf|NaN)$/;
const COMMENT = /^# (HELP|TYPE) [a-zA-Z_:][a-zA-Z0-9_:]* .+$/;

/** Every line is a HELP, a TYPE or a sample, and the text ends in a newline. */
const expectValidExposition = (text: string) => {
  expect(text.endsWith("\n")).toBe(true);
  for (const line of text.trimEnd().split("\n")) {
    expect(COMMENT.test(line) || SAMPLE.test(line), line).toBe(true);
  }
};

const sample = (text: string, prefix: string): number | undefined => {
  const line = text.split("\n").find((l) => l.startsWith(`${prefix} `));
  return line === undefined ? undefined : Number(line.split(" ").pop());
};

describe("the Prometheus registry", () => {
  it("renders every declared metric with HELP and TYPE, as valid exposition text, before anything is recorded", () => {
    const text = createPrometheusRegistry().render();
    expectValidExposition(text);
    expect(text).toContain("# TYPE company_os_jobs_total counter");
    expect(text).toContain(
      "# TYPE company_os_provider_duration_seconds histogram",
    );
    expect(text).toContain("# TYPE company_os_worker_queue_depth gauge");
  });

  it("counts job outcomes by kind and outcome", () => {
    const registry = createPrometheusRegistry();
    registry.count("company_os_jobs_total", {
      job_kind: "agent_run.execute",
      outcome: "succeeded",
    });
    registry.count("company_os_jobs_total", {
      job_kind: "agent_run.execute",
      outcome: "succeeded",
    });
    registry.count("company_os_jobs_total", {
      job_kind: "decision.shadow_evaluate",
      outcome: "failed",
    });
    const text = registry.render();
    expectValidExposition(text);
    expect(
      sample(
        text,
        'company_os_jobs_total{job_kind="agent_run.execute",outcome="succeeded"}',
      ),
    ).toBe(2);
    expect(
      sample(
        text,
        'company_os_jobs_total{job_kind="decision.shadow_evaluate",outcome="failed"}',
      ),
    ).toBe(1);
  });

  it("renders a histogram's cumulative buckets, sum and count", () => {
    const registry = createPrometheusRegistry();
    for (const seconds of [0.02, 0.3, 4, 500]) {
      registry.observe("company_os_provider_duration_seconds", seconds, {
        provider_kind: "fake",
        operation: "agent_run.execute",
      });
    }
    const text = registry.render();
    expectValidExposition(text);
    const labels = 'operation="agent_run.execute",provider_kind="fake"';
    const bucket = (le: string) =>
      sample(
        text,
        `company_os_provider_duration_seconds_bucket{${labels},le="${le}"}`,
      );
    expect(bucket("0.01")).toBe(0);
    expect(bucket("0.05")).toBe(1);
    expect(bucket("0.5")).toBe(2);
    expect(bucket("5")).toBe(3);
    expect(bucket("120")).toBe(3);
    expect(bucket("+Inf")).toBe(4);
    expect(
      sample(text, `company_os_provider_duration_seconds_count{${labels}}`),
    ).toBe(4);
    expect(
      sample(text, `company_os_provider_duration_seconds_sum{${labels}}`),
    ).toBeCloseTo(504.32);
  });

  it("sets gauges, and never lets a counter go down or take a non-finite step", () => {
    const registry = createPrometheusRegistry();
    registry.setGauge("company_os_worker_active_jobs", 1);
    registry.setGauge("company_os_worker_active_jobs", 0);
    registry.setGauge("company_os_worker_queue_depth", 7);
    registry.count("company_os_agent_runs_total", { outcome: "succeeded" }, 3);
    registry.count("company_os_agent_runs_total", { outcome: "succeeded" }, -1);
    registry.count(
      "company_os_agent_runs_total",
      { outcome: "succeeded" },
      Number.NaN,
    );
    registry.observe("company_os_agent_run_duration_seconds", -2);
    const text = registry.render();
    expect(sample(text, "company_os_worker_active_jobs")).toBe(0);
    expect(sample(text, "company_os_worker_queue_depth")).toBe(7);
    expect(
      sample(text, 'company_os_agent_runs_total{outcome="succeeded"}'),
    ).toBe(3);
    expect(text).not.toContain("company_os_agent_run_duration_seconds_count");
  });

  it("keeps the series bounded: sentinels, ids and unknown values all fold into one 'other' series", () => {
    const registry = createPrometheusRegistry();
    const hostile = [
      ...Object.values(TELEMETRY_SENTINELS),
      TENANT,
      "a\nb",
      'x"}',
    ];
    for (const value of hostile) {
      registry.count("company_os_external_calls_total", {
        operation: value,
        outcome: value,
        tenant_id: TENANT,
      });
    }
    const text = registry.render();
    expectValidExposition(text);
    const series = text
      .split("\n")
      .filter((line) => line.startsWith("company_os_external_calls_total{"));
    expect(series).toEqual([
      `company_os_external_calls_total{operation="other",outcome="other"} ${hostile.length}`,
    ]);
    for (const value of Object.values(TELEMETRY_SENTINELS)) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toContain(TENANT);
    expect(text).not.toMatch(/tenant/);
  });

  it("ignores a metric the catalogue does not declare, or a call of the wrong type", () => {
    const registry = createPrometheusRegistry();
    const loose = registry as unknown as {
      count(metric: string, labels?: object): void;
      setGauge(metric: string, value: number): void;
    };
    loose.count("company_os_patient_messages_total", {});
    loose.setGauge("company_os_jobs_total", 5);
    const text = registry.render();
    expect(text).not.toContain("patient");
    expect(text).not.toMatch(/^company_os_jobs_total/m);
  });

  it("serves exactly what reached it through the guarded boundary", () => {
    const registry = createPrometheusRegistry();
    guardTelemetry(registry).count("company_os_jobs_total", {
      job_kind: "postmark.ledger_retention",
      outcome: "succeeded",
      detail: TELEMETRY_SENTINELS.crmNote,
    });
    const text = registry.render();
    expect(
      sample(
        text,
        'company_os_jobs_total{job_kind="postmark.ledger_retention",outcome="succeeded"}',
      ),
    ).toBe(1);
    expect(text).not.toContain("SENTINEL");
  });
});
