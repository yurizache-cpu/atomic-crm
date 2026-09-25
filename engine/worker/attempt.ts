// What every step of one job attempt shares, whichever handler shape runs it.
//
// runOneJob.ts owns the lease (TX1) and the transactional path (TX2);
// externalCall.ts owns the prepare / call / settle path (TX2a, CALL, TX2b). Both
// resume the lease through `resumeTrustedLease`, complete a job through
// `completeJob`, and end an attempt through `succeeded` or `failed`, which runs
// TX3. Keeping those here means the two paths cannot drift on the checks that
// make tenancy safe: the tenant is re-read from the database and compared with
// the leased row, in every transaction that lets handler code run.

import type { TxClient, WorkerDatabase } from "../db/types.ts";
import {
  classifyError,
  describeError,
  PermanentError,
  SecurityError,
  type FailureClass,
} from "./failures.ts";
import {
  resolveHandler,
  type AnyHandlerDefinition,
  type HandlerRegistry,
} from "./handlerRegistry.ts";
import type { LeasedJob } from "./job.ts";
import type { WorkerLogger } from "./log.ts";
import type { JobTrace } from "../telemetry/workerTelemetry.ts";

export type JobOutcome =
  /** The queue had nothing available. */
  | "idle"
  /** The handler ran and the job is settled. */
  | "succeeded"
  /** The handler failed and the job is queued again for another attempt. */
  | "retry"
  /** The handler failed terminally, or the job is unrunnable. */
  | "failed"
  /**
   * An execution stop covers the job. It is queued again without consuming an
   * attempt, and nothing was called.
   */
  | "deferred";

export interface RunOneJobResult {
  outcome: JobOutcome;
  jobId?: string;
  tenantId?: string;
  kind?: string;
  attempt?: number;
  failureClass?: FailureClass;
  detail?: string;
  durationMs?: number;
}

export const RESUME_SQL = "select * from ops.resume_lease($1, $2)";

/**
 * Assumes the least-privileged identity for the rest of the transaction.
 *
 * The worker connects as a LOGIN role that is merely a MEMBER of `ops_worker`,
 * exactly as PostgREST reaches `authenticated`. This statement is what actually
 * puts RLS in force; without it the transaction runs with whatever the login
 * role carries.
 */
export const assumeWorkerRole = (tx: TxClient) =>
  tx.query("set local role ops_worker");

/** What every step of one attempt shares. The tenant in `job` is asserted against, never installed. */
export interface AttemptScope {
  readonly db: WorkerDatabase;
  readonly workerId: string;
  readonly registry: HandlerRegistry;
  readonly log: WorkerLogger;
  /** The row TX1 leased. */
  readonly job: LeasedJob;
  readonly startedAt: number;
  /**
   * This attempt's telemetry (Phase 2E.1). It observes; nothing reads it back,
   * and it never throws into the attempt.
   */
  readonly trace: JobTrace;
}

export const SHAPE_CHANGED =
  "the resumed job resolves to a different handler shape than the job that was leased";

/**
 * Resumes the lease inside `tx` and proves the session's tenant agrees with
 * it. Every transaction that lets handler code run passes through here first.
 */
export async function resumeTrustedLease<TRow extends LeasedJob>(
  tx: TxClient,
  { workerId, job }: AttemptScope,
  sql: string,
): Promise<TRow> {
  const resumed = await tx.query<TRow>(sql, [workerId, job.id]);
  const trusted = resumed.rows[0];
  if (!trusted?.id) {
    // The lease is gone: expired, reaped, or never ours. Another worker may
    // already hold this job, so doing the work now would double-apply it.
    throw new SecurityError(
      "lease could not be resumed; it is expired or not held by this worker",
    );
  }

  // The tenant is READ BACK from the database rather than trusted from the
  // row we hold. They must agree. If `ops.resume_lease` ever stops
  // installing the context — or something clears it — this is the line that
  // notices, and it notices BEFORE the handler runs.
  const context = await tx.query<{ tenant_id: string | null }>(
    "select ops.current_tenant_id() as tenant_id",
  );
  const activeTenant = context.rows[0]?.tenant_id ?? null;
  if (activeTenant !== trusted.tenant_id || activeTenant !== job.tenant_id) {
    throw new SecurityError(
      `tenant context mismatch: lease says ${trusted.tenant_id}, session says ${activeTenant ?? "none"}`,
    );
  }
  return trusted;
}

export function resolveRunnable(
  registry: HandlerRegistry,
  kind: string,
): AnyHandlerDefinition {
  const handler = resolveHandler(registry, kind);
  if (!handler) {
    // Unrunnable, and no amount of retrying registers a handler.
    throw new PermanentError(`no handler registered for kind "${kind}"`);
  }
  return handler;
}

export function logAttemptStarted(
  { workerId, log }: AttemptScope,
  trusted: LeasedJob,
): void {
  log("job.handler_selected", {
    workerId,
    jobId: trusted.id,
    kind: trusted.kind,
  });
  log("job.attempt_started", {
    workerId,
    jobId: trusted.id,
    tenantId: trusted.tenant_id,
    kind: trusted.kind,
    attempt: trusted.attempts,
  });
}

export async function completeJob(
  tx: TxClient,
  jobId: string,
  detail: string | null,
): Promise<void> {
  const settled = await tx.query<{ ok: boolean }>(
    "select ops.complete_job($1, $2) as ok",
    [jobId, detail],
  );
  if (settled.rows[0]?.ok !== true) {
    // The lease expired while the handler ran. Throwing here rolls the
    // handler's writes back, which is the only safe answer: the job may
    // already be running somewhere else.
    throw new SecurityError(
      "the lease expired before the job could be completed; the work was rolled back",
    );
  }
}

export function succeeded(
  { workerId, job, log, startedAt }: AttemptScope,
  detail: string | undefined,
): RunOneJobResult {
  const durationMs = Date.now() - startedAt;
  log("job.attempt_completed", {
    workerId,
    jobId: job.id,
    tenantId: job.tenant_id,
    kind: job.kind,
    attempt: job.attempts,
    durationMs,
    detail: detail ?? undefined,
  });
  return {
    outcome: "succeeded",
    jobId: job.id,
    tenantId: job.tenant_id,
    kind: job.kind,
    attempt: job.attempts,
    durationMs,
    detail: detail ?? undefined,
  };
}

/** Classifies the error and runs TX3. TX2's (or TX2a's, or TX2b's) writes are already discarded. */
export async function failed(
  { db, workerId, job, log, startedAt }: AttemptScope,
  error: unknown,
): Promise<RunOneJobResult> {
  const failureClass = classifyError(error);
  const detail = describeError(error);
  const durationMs = Date.now() - startedAt;

  log("job.attempt_failed", {
    workerId,
    jobId: job.id,
    tenantId: job.tenant_id,
    kind: job.kind,
    attempt: job.attempts,
    durationMs,
    failureClass,
    detail,
  });

  // --- TX3: record the failure. ------------------------------------------
  const settlement = await settleFailure(db, {
    workerId,
    jobId: job.id,
    failureClass,
    detail,
    log,
  });

  const outcome: JobOutcome = settlement === "retry" ? "retry" : "failed";
  log(outcome === "retry" ? "job.retry_scheduled" : "job.terminal_failure", {
    workerId,
    jobId: job.id,
    tenantId: job.tenant_id,
    kind: job.kind,
    attempt: job.attempts,
    failureClass,
    detail,
  });
  return {
    outcome,
    jobId: job.id,
    tenantId: job.tenant_id,
    kind: job.kind,
    attempt: job.attempts,
    failureClass,
    detail,
    durationMs,
  };
}

/**
 * Records a failure in its own transaction.
 *
 * Returns what the database decided: 'retry', 'failed', or 'refused' when the
 * lease was already gone. A failure to record is NOT escalated — the lease
 * expires and the reaper settles the job, which is strictly safer than leaving
 * the worker in a loop trying to write a row it cannot write.
 */
async function settleFailure(
  db: WorkerDatabase,
  {
    workerId,
    jobId,
    failureClass,
    detail,
    log,
  }: {
    workerId: string;
    jobId: string;
    failureClass: FailureClass;
    detail: string;
    log: WorkerLogger;
  },
): Promise<"retry" | "failed" | "refused"> {
  try {
    return await db.withTransaction(async (tx) => {
      await assumeWorkerRole(tx);
      const resumed = await tx.query<{ id: string | null }>(
        "select id from ops.resume_lease($1, $2)",
        [workerId, jobId],
      );
      if (!resumed.rows[0]?.id) {
        log("job.settlement_refused", {
          workerId,
          jobId,
          detail: "lease gone before the failure could be recorded",
        });
        return "refused";
      }
      const settled = await tx.query<{ result: string }>(
        "select ops.settle_job_failure($1, $2, $3) as result",
        [jobId, failureClass, detail],
      );
      const result = settled.rows[0]?.result;
      return result === "retry" || result === "failed" ? result : "refused";
    });
  } catch (error) {
    log("job.settlement_refused", {
      workerId,
      jobId,
      detail: describeError(error),
    });
    return "refused";
  }
}
