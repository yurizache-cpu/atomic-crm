// The worker's one unit of work.
//
// THE ORDERING INVARIANT, which this module exists to make hard to get wrong,
// because getting it wrong is how tenancy leaks:
//
//     trusted leased row -> tenant established server-side -> execute -> settle
//
// and never
//
//     payload -> tenant
//
// THREE TRANSACTIONS, and each boundary is load-bearing:
//
//   TX1  lease, and COMMIT it.
//        Phase 1A leased and executed in one transaction. Measured consequence:
//        a worker that dies mid-job rolls the lease back too, so `attempts`
//        never rises and a job that crashes the worker is re-leased forever.
//        Committing the lease is what makes `max_attempts` and the reaper mean
//        anything.
//
//   TX2  resume the lease, run the handler, settle SUCCESS.
//        The handler's writes and the job's completion share one transaction,
//        so "did the work but did not record it" stays impossible. The tenant
//        is re-read from the database here by `ops.resume_lease` — it is NOT
//        carried over from TX1 in application memory, because a tenant that
//        travels through the worker is a tenant the worker could change.
//
//   TX3  settle FAILURE, only if TX2 threw.
//        It must be a separate transaction: TX2 has to roll back to discard the
//        handler's partial writes, and a rolled-back transaction cannot also
//        record why. If TX3 itself fails, nothing is lost — the lease expires
//        and the reaper retires or requeues the job.

import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { grantCapabilities } from "./capabilities.ts";
import { classifyError, describeError, type FailureClass } from "./failures.ts";
import { resolveHandler, type HandlerRegistry } from "./handlerRegistry.ts";
import type { LeasedJob } from "./job.ts";
import { silentLogger, type WorkerLogger } from "./log.ts";
import { PermanentError, SecurityError } from "./failures.ts";

export type JobOutcome =
  /** The queue had nothing available. */
  | "idle"
  /** The handler ran and the job is settled. */
  | "succeeded"
  /** The handler failed and the job is queued again for another attempt. */
  | "retry"
  /** The handler failed terminally, or the job is unrunnable. */
  | "failed";

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

export interface RunOneJobOptions {
  /** Identifies this worker to the lease. Must be stable for the process. */
  workerId: string;
  /** How long the lease is held. Longer than the slowest handler. */
  leaseSeconds?: number;
  registry: HandlerRegistry;
  log?: WorkerLogger;
  /** Injected only by tests that need to crash between transactions. */
  onLeased?: (job: LeasedJob) => Promise<void>;
}

const DEFAULT_LEASE_SECONDS = 60;

/**
 * Assumes the least-privileged identity for the rest of the transaction.
 *
 * The worker connects as a LOGIN role that is merely a MEMBER of `ops_worker`,
 * exactly as PostgREST reaches `authenticated`. This statement is what actually
 * puts RLS in force; without it the transaction runs with whatever the login
 * role carries.
 */
const assumeWorkerRole = (tx: TxClient) =>
  tx.query("set local role ops_worker");

export async function runOneJob(
  db: WorkerDatabase,
  {
    workerId,
    leaseSeconds = DEFAULT_LEASE_SECONDS,
    registry,
    log = silentLogger,
    onLeased,
  }: RunOneJobOptions,
): Promise<RunOneJobResult> {
  if (!workerId.trim()) {
    throw new Error(
      "runOneJob requires a worker id: it is what binds the lease to this process, and ops.current_tenant_id() resolves the tenant through it.",
    );
  }

  // --- TX1: lease, and commit it. -----------------------------------------
  const job = await db.withTransaction(async (tx) => {
    await assumeWorkerRole(tx);
    const leased = await tx.query<LeasedJob>(
      "select * from ops.lease_job($1, $2)",
      [workerId, leaseSeconds],
    );
    const row = leased.rows[0];
    return row?.id ? row : null;
  });

  if (!job) {
    log("worker.idle", { workerId });
    return { outcome: "idle" };
  }

  log("job.leased", {
    workerId,
    jobId: job.id,
    tenantId: job.tenant_id,
    kind: job.kind,
    attempt: job.attempts,
    maxAttempts: job.max_attempts,
  });

  // A seam for the crash tests, and for nothing else. It runs between the
  // committed lease and the execution transaction — the exact window in which a
  // real worker dying must leave a recoverable stale lease.
  if (onLeased) await onLeased(job);

  const startedAt = Date.now();

  // --- TX2: resume, execute, settle success. -------------------------------
  try {
    const detail = await db.withTransaction(async (tx) => {
      await assumeWorkerRole(tx);

      const resumed = await tx.query<LeasedJob>(
        "select * from ops.resume_lease($1, $2)",
        [workerId, job.id],
      );
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
      if (
        activeTenant !== trusted.tenant_id ||
        activeTenant !== job.tenant_id
      ) {
        throw new SecurityError(
          `tenant context mismatch: lease says ${trusted.tenant_id}, session says ${activeTenant ?? "none"}`,
        );
      }

      const handler = resolveHandler(registry, trusted.kind);
      if (!handler) {
        // Unrunnable, and no amount of retrying registers a handler.
        throw new PermanentError(
          `no handler registered for kind "${trusted.kind}"`,
        );
      }
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

      const capabilities = grantCapabilities(tx, handler.capabilities);
      const handlerDetail = await handler.run(trusted, capabilities);

      const settled = await tx.query<{ ok: boolean }>(
        "select ops.complete_job($1, $2) as ok",
        [trusted.id, handlerDetail ?? null],
      );
      if (settled.rows[0]?.ok !== true) {
        // The lease expired while the handler ran. Throwing here rolls the
        // handler's writes back, which is the only safe answer: the job may
        // already be running somewhere else.
        throw new SecurityError(
          "the lease expired before the job could be completed; the work was rolled back",
        );
      }
      return handlerDetail ?? undefined;
    });

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
  } catch (error) {
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

    // --- TX3: record the failure. TX2's writes are already discarded. ------
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
