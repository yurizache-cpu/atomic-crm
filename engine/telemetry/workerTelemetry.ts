// What the worker runtime records (Phase 2E.1), in the catalogue's terms.
//
// The runtime calls this facade at the points the ordering invariant already
// has (lease, prepare, call, settle, outcome). It never passes a job payload, a
// handler's state, a provider's answer or an error's text: only a job's kind,
// ids, attempt, outcome enums and durations. Everything goes through a guarded
// TelemetryPort, so nothing here can throw into the runtime, and nothing here
// waits.
//
//   company_os.job.execute                 one leased job, lease to outcome
//     company_os.governance.check          an external call's prepare (TX2a):
//                                          stop checks and spend reservation
//     company_os.provider.call             the one call, outside any transaction
//     company_os.settlement                the settle (TX2b) and spend settlement

import type { SpanName } from "./catalog.ts";
import {
  guardTelemetry,
  NOOP_TELEMETRY,
  type TelemetryPort,
  type TelemetrySpan,
} from "./telemetryPort.ts";
import type {
  CallOutcome,
  SettlementObservation,
} from "../worker/handlerRegistry.ts";

/** The job facts telemetry may read: identifiers, kind and attempt. */
export interface ObservedJob {
  readonly id: string;
  readonly tenant_id: string;
  readonly kind: string;
  readonly attempts: number;
}

/** The fields of an attempt's result telemetry may read. */
export interface ObservedResult {
  readonly outcome: string;
  readonly failureClass?: string;
}

export type CallClass = "ok" | "error" | "timeout" | "cancelled";

export interface JobTrace {
  /**
   * Runs `fn` inside a child span. What `fn` returns or throws is passed on
   * unchanged: telemetry observes the phase, it never alters it.
   */
  phase<T>(
    name: Extract<
      SpanName,
      "company_os.governance.check" | "company_os.settlement"
    >,
    fn: () => Promise<T>,
  ): Promise<T>;
  /** Runs the provider call inside a span and records its metrics. */
  providerCall<T>(
    providerKind: string | undefined,
    fn: () => Promise<CallOutcome<T>>,
  ): Promise<CallOutcome<T>>;
  /** A settlement that has COMMITTED. Never called for one that rolled back. */
  settled(observation: SettlementObservation | undefined): void;
  /** The attempt's outcome. Ends the job span; later calls are ignored. */
  end(result: ObservedResult): void;
}

export interface WorkerTelemetry {
  startJob(job: ObservedJob): JobTrace;
  /** Ready jobs across the deployment, from the reaper tick. */
  queueDepth(depth: number): void;
  /**
   * Whether the queue depth is worth a query: false when nothing records
   * metrics, so a worker without observability issues no extra read.
   */
  readonly readsQueueDepth: boolean;
}

/** Seconds, for a histogram, from a non-negative millisecond duration. */
const seconds = (ms: number): number =>
  Number.isFinite(ms) && ms >= 0 ? ms / 1000 : 0;

const errorName = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null
    ? (() => {
        const name = (error as { name?: unknown }).name;
        return typeof name === "string" ? name : undefined;
      })()
    : undefined;

/** A category a handler's own error reports, when it reports one. */
const errorCategory = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const nested = (error as { modelError?: unknown }).modelError;
  const source = typeof nested === "object" && nested !== null ? nested : error;
  const category = (source as { category?: unknown }).category;
  return typeof category === "string" ? category : undefined;
};

/**
 * How a call ended, from the error's class name and category enum only. A
 * message is never read: a provider's text can echo the input.
 */
export function classifyCall(outcome: CallOutcome<unknown>): CallClass {
  if (outcome.ok) return "ok";
  const error = outcome.error;
  if ((error as { deadlineReached?: unknown })?.deadlineReached === true) {
    return "timeout";
  }
  const name = errorName(error);
  const category = errorCategory(error);
  if (name === "TimeoutError" || category === "timeout") return "timeout";
  if (name === "AbortError" || category === "cancelled") return "cancelled";
  return "error";
}

const NOOP_TRACE: JobTrace = Object.freeze({
  phase: <T>(_name: string, fn: () => Promise<T>) => fn(),
  providerCall: <T>(
    _kind: string | undefined,
    fn: () => Promise<CallOutcome<T>>,
  ) => fn(),
  settled() {},
  end() {},
});

export const NOOP_WORKER_TELEMETRY: WorkerTelemetry = Object.freeze({
  startJob: () => NOOP_TRACE,
  queueDepth() {},
  readsQueueDepth: false,
});

export function createWorkerTelemetry(
  port: TelemetryPort,
  options: { readonly readsQueueDepth?: boolean } = {},
): WorkerTelemetry {
  if (port === NOOP_TELEMETRY) return NOOP_WORKER_TELEMETRY;
  const telemetry = guardTelemetry(port);
  let activeJobs = 0;
  const publishActive = () =>
    telemetry.setGauge("company_os_worker_active_jobs", activeJobs);
  publishActive();

  const startJob = (job: ObservedJob): JobTrace => {
    const startedAt = Date.now();
    activeJobs += 1;
    publishActive();
    const root: TelemetrySpan = telemetry.startSpan("company_os.job.execute", {
      "company_os.job.kind": job.kind,
      "company_os.job.attempt": job.attempts,
      "company_os.tenant.id": job.tenant_id,
      "company_os.job.id": job.id,
    });
    let ended = false;

    const trace: JobTrace = {
      async phase<T>(
        name: "company_os.governance.check" | "company_os.settlement",
        fn: () => Promise<T>,
      ): Promise<T> {
        const span = telemetry.startSpan(
          name,
          { "company_os.job.kind": job.kind },
          root,
        );
        try {
          const value = await fn();
          span.end("ok");
          return value;
        } catch (error) {
          span.end("error");
          throw error;
        }
      },

      async providerCall<T>(
        providerKind: string | undefined,
        fn: () => Promise<CallOutcome<T>>,
      ): Promise<CallOutcome<T>> {
        const span = telemetry.startSpan(
          "company_os.provider.call",
          {
            "company_os.operation": job.kind,
            "company_os.provider.kind": providerKind,
          },
          root,
        );
        let outcome: CallOutcome<T>;
        try {
          outcome = await fn();
        } catch (error) {
          span.end("error");
          throw error;
        }
        // Reading an error can run a getter; a getter that throws is "error".
        let callClass: CallClass = "error";
        try {
          callClass = classifyCall(outcome);
        } catch {
          // Contained: the call's outcome goes back unchanged below.
        }
        span.setAttributes({ "company_os.call.outcome": callClass });
        span.end(callClass === "ok" ? "ok" : "error");
        telemetry.count("company_os_external_calls_total", {
          operation: job.kind,
          outcome: callClass,
        });
        telemetry.observe(
          "company_os_provider_duration_seconds",
          seconds(outcome.durationMs),
          { provider_kind: providerKind, operation: job.kind },
        );
        if (job.kind === "agent_run.execute") {
          telemetry.observe(
            "company_os_agent_run_duration_seconds",
            seconds(outcome.durationMs),
          );
        }
        return outcome;
      },

      settled(observation) {
        if (!observation) return;
        if (observation.subject === "agent_run") {
          root.setAttributes({
            "company_os.agent_run.outcome": observation.status,
            "company_os.run.id": observation.runId,
          });
          telemetry.count("company_os_agent_runs_total", {
            outcome: observation.status,
          });
          return;
        }
        root.setAttributes({
          "company_os.decision.outcome": observation.status,
          "company_os.policy.version": observation.policyVersion,
        });
        telemetry.count("company_os_decision_evaluations_total", {
          outcome: observation.status,
          policy_version: observation.policyVersion,
        });
      },

      end(result) {
        if (ended) return;
        ended = true;
        activeJobs = Math.max(0, activeJobs - 1);
        publishActive();
        telemetry.count("company_os_jobs_total", {
          job_kind: job.kind,
          outcome: result.outcome,
        });
        telemetry.observe(
          "company_os_job_duration_seconds",
          seconds(Date.now() - startedAt),
          { job_kind: job.kind },
        );
        root.setAttributes({
          "company_os.job.outcome": result.outcome,
          "company_os.failure.class": result.failureClass,
        });
        root.end(
          result.outcome === "succeeded" || result.outcome === "deferred"
            ? "ok"
            : "error",
        );
      },
    };
    return Object.freeze(trace);
  };

  return Object.freeze({
    startJob,
    queueDepth(depth: number) {
      if (Number.isSafeInteger(depth) && depth >= 0) {
        telemetry.setGauge("company_os_worker_queue_depth", depth);
      }
    },
    readsQueueDepth: options.readsQueueDepth === true,
  });
}
