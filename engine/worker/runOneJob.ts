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
  runExternalCall,
} from "./externalCall.ts";
import { SecurityError } from "./failures.ts";
import {
  isExternalCallHandler,
  resolveHandler,
  type HandlerRegistry,
} from "./handlerRegistry.ts";
import type { LeasedJob } from "./job.ts";
import { silentLogger, type WorkerLogger } from "./log.ts";
import type { WorkerDatabase } from "../db/types.ts";

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
  };

  // The leased row's kind picks WHICH transaction sequence runs, and nothing
  // more. Each sequence resolves the handler again from the row it resumes,
  // after the tenant check, exactly as TX2 always has. An unknown kind takes
  // the transactional path, which is where it has always failed closed.
  const leasedHandler = resolveHandler(registry, job.kind);
  if (leasedHandler && isExternalCallHandler(leasedHandler)) {
    return runExternalCall(scope, {
      leaseSafetyMarginMs,
      signal,
      onCallFinished,
    });
  }

  // --- TX2: resume, execute, settle success. -------------------------------
  try {
    return succeeded(scope, await executeTransactional(scope));
  } catch (error) {
    return failed(scope, error);
  }
}

/** TX2 for a transactional handler. Unchanged in what it runs and in what order. */
async function executeTransactional(
  scope: AttemptScope,
): Promise<string | undefined> {
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

    const capabilities = grantCapabilities(tx, handler.capabilities);
    const handlerDetail = await handler.run(trusted, capabilities);

    await completeJob(tx, trusted.id, handlerDetail ?? null);
    return handlerDetail ?? undefined;
  });
}
