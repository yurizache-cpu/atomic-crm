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
//
// THE external_call SHAPE splits TX2 in two, around ONE call to a service
// outside the database that must not be issued twice: TX2a (prepare, committed
// without completing the job), the call (no transaction), and TX2b (settle and
// complete). That flow lives in externalCall.ts, and the steps both shapes
// share (the trusted resume, completion, TX3) live in attempt.ts. This module
// keeps TX1, the choice of path, and TX2.

import {
  assumeWorkerRole,
  completeJob,
  failed,
  logAttemptStarted,
  RESUME_SQL,
  resolveRunnable,
  resumeTrustedLease,
  SHAPE_CHANGED,
  succeeded,
  type AttemptScope,
  type RunOneJobResult,
} from "./attempt.ts";
import { grantCapabilities } from "./capabilities.ts";
import {
  DEFAULT_LEASE_SAFETY_MARGIN_MS,
  DEFER_SQL,
  deferred,
  readStopAnswer,
  runExternalCall,
  STOP_CHECK_SQL,
} from "./externalCall.ts";
import { SecurityError, TransientError } from "./failures.ts";
import {
  isExternalCallHandler,
  resolveHandler,
  type HandlerRegistry,
} from "./handlerRegistry.ts";
import type { LeasedJob } from "./job.ts";
import { isGovernedJobKind } from "./jobKinds.ts";
import { silentLogger, type WorkerLogger } from "./log.ts";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import {
  NOOP_WORKER_TELEMETRY,
  type WorkerTelemetry,
} from "../telemetry/workerTelemetry.ts";

export type { JobOutcome, RunOneJobResult } from "./attempt.ts";
export {
  CALL_ABANDON_GRACE_MS,
  DEFAULT_LEASE_SAFETY_MARGIN_MS,
} from "./externalCall.ts";

export interface RunOneJobOptions {
  /** Identifies this worker to the lease. Must be stable for the process. */
  workerId: string;
  /** How long the lease is held. Longer than the slowest handler. */
  leaseSeconds?: number;
  registry: HandlerRegistry;
  log?: WorkerLogger;
  /** Injected only by tests that need to crash between transactions. */
  onLeased?: (job: LeasedJob) => Promise<void>;
  /**
   * Worker shutdown. It reaches an external call's signal, so a stopping worker
   * does not wait out a slow service. A transactional handler never sees it:
   * its work is one transaction, and that transaction finishes.
   */
  signal?: AbortSignal;
  /**
   * How long before the lease expires an external call is treated as timed
   * out. This is TX2b's room: a call that returns at the lease's last
   * millisecond has produced a result this worker can no longer record.
   */
  leaseSafetyMarginMs?: number;
  /**
   * Injected only by tests that need to crash between an external call and
   * TX2b. It runs outside every transaction and every failure path, so a throw
   * here behaves like the process dying: nothing settles.
   */
  onCallFinished?: (job: LeasedJob) => Promise<void>;
  /**
   * Phase 2E.1: what this attempt reports to telemetry. Observation only, and
   * the no-op default records nothing: no outcome below depends on it.
   */
  telemetry?: WorkerTelemetry;
}

const DEFAULT_LEASE_SECONDS = 60;

export async function runOneJob(
  db: WorkerDatabase,
  {
    workerId,
    leaseSeconds = DEFAULT_LEASE_SECONDS,
    registry,
    log = silentLogger,
    onLeased,
    signal,
    leaseSafetyMarginMs = DEFAULT_LEASE_SAFETY_MARGIN_MS,
    onCallFinished,
    telemetry = NOOP_WORKER_TELEMETRY,
  }: RunOneJobOptions,
): Promise<RunOneJobResult> {
  if (!workerId.trim()) {
    throw new Error(
      "runOneJob requires a worker id: it is what binds the lease to this process, and ops.current_tenant_id() resolves the tenant through it.",
    );
  }
  // A whole number of milliseconds, not merely a finite one: the deadline built
  // from it becomes a timer delay, and a fractional delay throws in
  // AbortSignal.timeout AFTER prepare has committed, where nothing settles.
  if (!Number.isSafeInteger(leaseSafetyMarginMs) || leaseSafetyMarginMs < 0) {
    throw new Error(
      "runOneJob requires a non-negative, whole-millisecond lease safety margin: a negative one would let an external call outlive the lease that bounds it.",
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

  const scope: AttemptScope = {
    db,
    workerId,
    registry,
    log,
    job,
    startedAt: Date.now(),
    trace: telemetry.startJob(job),
  };

  // Telemetry sees the outcome after it is decided and never changes it. An
  // attempt that throws out of here (the crash seams, a process losing its
  // job) ends its trace as interrupted: its lease expires and the reaper
  // recovers the job, which is not an outcome this attempt recorded.
  let result: RunOneJobResult;
  try {
    result = await executeAttempt(scope, {
      leaseSafetyMarginMs,
      signal,
      onCallFinished,
    });
  } catch (error) {
    scope.trace.end({ outcome: "interrupted" });
    throw error;
  }
  scope.trace.end(result);
  return result;
}

/** Picks the attempt's transaction sequence and runs it to an outcome. */
async function executeAttempt(
  scope: AttemptScope,
  options: Parameters<typeof runExternalCall>[1],
): Promise<RunOneJobResult> {
  // The leased row's kind picks WHICH transaction sequence runs, and nothing
  // more. Each sequence resolves the handler again from the row it resumes,
  // after the tenant check, exactly as TX2 always has. An unknown kind takes
  // the transactional path, which is where it has always failed closed.
  const leasedHandler = resolveHandler(scope.registry, scope.job.kind);
  if (leasedHandler && isExternalCallHandler(leasedHandler)) {
    return runExternalCall(scope, options);
  }

  // --- TX2: resume, execute, settle success. -------------------------------
  try {
    const outcome = await executeTransactional(scope);
    return outcome.kind === "deferred"
      ? deferred(scope, outcome.stopId)
      : succeeded(scope, outcome.detail);
  } catch (error) {
    return failed(scope, error);
  }
}

/** What TX2 committed: the handler's work and the job's completion, or a deferral. */
type TransactionalOutcome =
  | { readonly kind: "done"; readonly detail: string | undefined }
  | { readonly kind: "deferred"; readonly stopId: string };

/**
 * The kill switch for a GOVERNED kind (jobKinds.ts), inside TX2 before its
 * handler runs. `ops.job_execution_stop()` takes the kill-switch lock shared
 * and this transaction keeps it, so a trip that returns after this check
 * waits for TX2 to commit, and one that returned before it is seen here. A
 * covering stop defers the job exactly as it defers an external call: back to
 * the queue, its attempt given back, nothing run. Runtime SQL, like completing
 * a job, never a handler capability.
 */
async function holdGovernedJob(tx: TxClient): Promise<string | null> {
  const covering = await readStopAnswer(
    tx,
    STOP_CHECK_SQL,
    "ops.job_execution_stop",
  );
  if (covering === null) return null;
  const deferredBy = await readStopAnswer(tx, DEFER_SQL, "ops.defer_job");
  if (deferredBy === null) {
    // The two readings disagree under one lock: roll TX2 back and let the
    // failure path retry the job on a fresh attempt, rather than guess.
    throw new TransientError(
      "an execution stop covered the job but not when it was deferred; nothing ran",
    );
  }
  return deferredBy;
}

/**
 * TX2 for a transactional handler. Unchanged in what it runs and in what
 * order, except that a governed kind first asks the kill switch.
 */
async function executeTransactional(
  scope: AttemptScope,
): Promise<TransactionalOutcome> {
  return scope.db.withTransaction(async (tx) => {
    await assumeWorkerRole(tx);
    const trusted = await resumeTrustedLease<LeasedJob>(tx, scope, RESUME_SQL);

    const handler = resolveRunnable(scope.registry, trusted.kind);
    if (isExternalCallHandler(handler)) {
      // Unreachable while a job's kind is fixed: TX1 leased this kind as
      // transactional. If the resumed row disagrees, the row changed under a
      // lease we hold, and running an external call inside TX2 is the one
      // thing that shape exists to prevent.
      throw new SecurityError(SHAPE_CHANGED);
    }
    logAttemptStarted(scope, trusted);

    if (isGovernedJobKind(trusted.kind)) {
      const stopId = await holdGovernedJob(tx);
      if (stopId !== null) return { kind: "deferred", stopId };
    }

    const capabilities = grantCapabilities(tx, handler.capabilities);
    const handlerDetail = await handler.run(trusted, capabilities);

    await completeJob(tx, trusted.id, handlerDetail ?? null);
    return { kind: "done", detail: handlerDetail ?? undefined };
  });
}
