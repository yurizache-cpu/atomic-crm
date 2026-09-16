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
// outside the database that must not be issued twice. Holding a transaction
// open across that call would pin a pooled connection for as long as the
// service takes, and would let a rollback erase the record of a call the
// service has already acted on. So:
//
//   TX2a  resume, run `prepare`, and COMMIT WITHOUT completing the job.
//         Prepare's writes ("this run is now running") must be durable BEFORE
//         the call leaves the process. Otherwise a crash during the call leaves
//         no trace that a call was made, and the retry issues it again. A
//         prepare with nothing to call returns "settled", and the job completes
//         inside TX2a exactly as a transactional one completes inside TX2.
//
//   CALL  no transaction, no capabilities, nothing that reaches SQL. The
//         capabilities prepare was granted stop working when prepare returns,
//         so one smuggled into `state` is refused instead of running on a
//         connection the pool has already handed back. The call is bounded by
//         a deadline taken from the DATABASE's view of the lease (its remaining
//         time, minus a safety margin that leaves TX2b room to settle) and it
//         is aborted on shutdown. A call that throws is an OUTCOME handed to
//         `settle`, never a failure routed to TX3: TX3 may schedule a retry,
//         and a job retry of a paid call is the call issued twice, silently.
//
//   TX2b  resume again, run `settle`, complete the job.
//         The tenant is re-read and re-checked; nothing from TX2a is trusted
//         except the handler's own `state`. If TX2b throws, TX3 records the
//         failure exactly as it does for a transactional handler.
//
// A crash between TX2a and TX2b is recovered by the handler's OWN durable
// state, not by calling again. The lease expires, the reaper requeues or
// retires the job, and the next `prepare` finds its record still "running" and
// settles it as indeterminate. That part is the handler's contract; this
// module's part is that the "running" record was committed before the call
// was issued, and that nothing here ever issues the call a second time.

import type { TxClient, WorkerDatabase } from "../db/types.ts";
import {
  grantCapabilities,
  type CapabilityName,
  type Capabilities,
} from "./capabilities.ts";
import { classifyError, describeError, type FailureClass } from "./failures.ts";
import {
  isExternalCallHandler,
  resolveHandler,
  type AnyHandlerDefinition,
  type CallOutcome,
  type ExternalCallContext,
  type ExternalCallHandlerDefinition,
  type HandlerRegistry,
  type PrepareBudget,
} from "./handlerRegistry.ts";
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
export const DEFAULT_LEASE_SAFETY_MARGIN_MS = 10_000;

/**
 * How long a call is still awaited after its signal aborts.
 *
 * A well-behaved call rejects within milliseconds of an abort, with its OWN
 * error, which carries more than the abort reason does (usage, request ids), so
 * the runtime does not race it to the finish. A call that ignores its signal is
 * abandoned after this grace, and its late settlement is swallowed: otherwise
 * one such handler wedges the worker loop, and with it every tenant's queue.
 */
export const CALL_ABANDON_GRACE_MS = 1_000;

/**
 * The longest delay a Node timer honours. `ops.lease_job` puts no ceiling on a
 * lease, and past this Node silently fires the timer after 1 ms (so the call
 * is aborted before it starts), and past 2^32 - 1 AbortSignal.timeout throws
 * outside every failure path, after prepare has committed. Clamping only ever
 * aborts EARLIER than the lease-derived deadline, never later.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const RESUME_SQL = "select * from ops.resume_lease($1, $2)";

/**
 * The prepare transaction's resume, which also asks the DATABASE how long the
 * lease has left. It is a duration, measured on the database clock, so the
 * worker's own clock only has to be steady, never in agreement with Postgres.
 * `clock_timestamp()` rather than `now()`: `now()` is frozen at the start of
 * the transaction, which would overstate the time remaining.
 */
const RESUME_WITH_REMAINING_SQL =
  "select *, greatest(0, floor(extract(epoch from (lease_expires_at - clock_timestamp())) * 1000))::bigint as lease_remaining_ms from ops.resume_lease($1, $2)";

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

/** What every step of one attempt shares. The tenant in `job` is asserted against, never installed. */
interface AttemptScope {
  readonly db: WorkerDatabase;
  readonly workerId: string;
  readonly registry: HandlerRegistry;
  readonly log: WorkerLogger;
  /** The row TX1 leased. */
  readonly job: LeasedJob;
  readonly startedAt: number;
}

/** A prepare that asked for the call. Carried across the call, never across a crash. */
interface PreparedCall {
  readonly kind: "call";
  readonly handler: ExternalCallHandlerDefinition;
  readonly state: unknown;
  readonly deadline: number;
}

type Prepared =
  | { readonly kind: "settled"; readonly detail: string }
  | PreparedCall;

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
  if (!leasedHandler || !isExternalCallHandler(leasedHandler)) {
    // --- TX2: resume, execute, settle success. -----------------------------
    try {
      return succeeded(scope, await executeTransactional(scope));
    } catch (error) {
      return failed(scope, error);
    }
  }

  // --- TX2a: resume, prepare, commit without completing. -------------------
  let prepared: PreparedCall;
  try {
    const outcome = await prepareExternalCall(scope, leaseSafetyMarginMs);
    if (outcome.kind === "settled") return succeeded(scope, outcome.detail);
    prepared = outcome;
  } catch (error) {
    return failed(scope, error);
  }

  // --- CALL: no transaction. It cannot throw; a failed call is an outcome. --
  const callOutcome = await performCall(scope, prepared, signal);

  // The crash seam for the window a paid call makes dangerous. Deliberately
  // outside every try: a throw here must look like the process dying, which
  // settles nothing and issues nothing again.
  if (onCallFinished) await onCallFinished(job);

  // --- TX2b: resume, settle, complete. -------------------------------------
  try {
    return succeeded(
      scope,
      await settleExternalCall(scope, prepared, callOutcome),
    );
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

/**
 * TX2a. Commits prepare's writes, and completes the job only when prepare
 * settled it. Everything that throws here rolls prepare back, before any call.
 */
async function prepareExternalCall(
  scope: AttemptScope,
  leaseSafetyMarginMs: number,
): Promise<Prepared> {
  return scope.db.withTransaction(async (tx) => {
    await assumeWorkerRole(tx);
    const { lease_remaining_ms: remainingRaw, ...trusted } =
      await resumeTrustedLease<LeasedJob & { lease_remaining_ms?: unknown }>(
        tx,
        scope,
        RESUME_WITH_REMAINING_SQL,
      );

    const handler = resolveRunnable(scope.registry, trusted.kind);
    if (!isExternalCallHandler(handler)) {
      throw new SecurityError(SHAPE_CHANGED);
    }

    // `pg` returns bigint as a string, so a string is expected; anything that
    // is not a whole, non-negative number of milliseconds means the call
    // cannot be bounded by the lease, and an unbounded paid call is not
    // issued. Whole, because the deadline becomes a timer delay and a
    // fractional one throws only once prepare has committed.
    const remainingMs =
      typeof remainingRaw === "number" || typeof remainingRaw === "string"
        ? Number(remainingRaw)
        : Number.NaN;
    if (
      (typeof remainingRaw === "string" && !remainingRaw.trim()) ||
      !Number.isSafeInteger(remainingMs) ||
      remainingMs < 0
    ) {
      throw new PermanentError(
        "the resumed lease reports no remaining duration, so an external call cannot be bounded by it",
      );
    }
    logAttemptStarted(scope, trusted);

    const deadline = Date.now() + remainingMs - leaseSafetyMarginMs;
    // Never negative: a handler passes this to a timer, and a negative delay
    // is a TypeError in AbortSignal.timeout rather than "no time left".
    const budget: PrepareBudget = Object.freeze({
      callBudgetMs: Math.max(0, deadline - Date.now()),
      remainingMs: () => Math.max(0, deadline - Date.now()),
    });

    const outcome = await withScopedCapabilities(
      tx,
      handler.prepareCapabilities,
      (capabilities) => handler.prepare(trusted, capabilities, budget),
    );

    if (outcome?.kind === "settled") {
      await completeJob(tx, trusted.id, outcome.detail);
      return { kind: "settled", detail: outcome.detail };
    }
    if (outcome?.kind !== "call") {
      // Rolled back with everything prepare wrote, so nothing claims a call
      // was made. Retrying the same code returns the same malformed value.
      throw new PermanentError(
        `handler "${handler.kind}" prepare returned neither "settled" nor "call"`,
      );
    }
    return { kind: "call", handler, state: outcome.state, deadline };
  });
}

/**
 * The call itself. Never throws: whatever the handler's call does becomes a
 * CallOutcome, because a thrown call routed to TX3 could be retried, and a
 * retried call is issued twice.
 */
async function performCall(
  { workerId, job, log }: AttemptScope,
  prepared: PreparedCall,
  shutdown: AbortSignal | undefined,
): Promise<CallOutcome<unknown>> {
  if (prepared.deadline <= Date.now()) {
    // The deadline passed before the call could start: prepare committed late.
    // A 0 ms timer fires only on a later tick, after a request could already be
    // on the wire, so no call is started at all. The handler settles a timeout
    // for a call that was never sent.
    const late: CallOutcome<unknown> = {
      ok: false,
      error: new DOMException(
        "the lease-derived deadline passed before the call started",
        "TimeoutError",
      ),
      durationMs: 0,
    };
    log("job.external_call_finished", {
      workerId,
      jobId: job.id,
      tenantId: job.tenant_id,
      kind: job.kind,
      attempt: job.attempts,
      durationMs: 0,
      detail: "error",
    });
    return late;
  }

  log("job.external_call_started", {
    workerId,
    jobId: job.id,
    tenantId: job.tenant_id,
    kind: job.kind,
    attempt: job.attempts,
  });

  const deadlineSignal = AbortSignal.timeout(
    Math.min(MAX_TIMER_DELAY_MS, Math.max(0, prepared.deadline - Date.now())),
  );
  const signal = shutdown
    ? AbortSignal.any([shutdown, deadlineSignal])
    : deadlineSignal;
  // Two keys, frozen. No transaction, no client, no capability: the call has
  // nothing to reach the database through, by construction.
  const context: ExternalCallContext = Object.freeze({
    signal,
    deadline: prepared.deadline,
  });

  const callStartedAt = Date.now();
  const pending = (async () =>
    prepared.handler.call(prepared.state, context))();
  // A call abandoned below may still settle later. Its result has already
  // been decided, so the late settlement is swallowed, not reported unhandled.
  pending.catch(() => {});
  const abandon = abandonAfterAbort(signal);

  let outcome: CallOutcome<unknown>;
  try {
    const value = await Promise.race([pending, abandon.promise]);
    outcome = { ok: true, value, durationMs: Date.now() - callStartedAt };
  } catch (error) {
    outcome = { ok: false, error, durationMs: Date.now() - callStartedAt };
  } finally {
    abandon.dispose();
  }

  log("job.external_call_finished", {
    workerId,
    jobId: job.id,
    tenantId: job.tenant_id,
    kind: job.kind,
    attempt: job.attempts,
    durationMs: outcome.durationMs,
    // Never the error's text: it is a provider's, and it can echo the input.
    detail: outcome.ok ? "ok" : "error",
  });
  return outcome;
}

/** TX2b. The only place an external call's outcome becomes a completed job. */
async function settleExternalCall(
  scope: AttemptScope,
  prepared: PreparedCall,
  outcome: CallOutcome<unknown>,
): Promise<string> {
  return scope.db.withTransaction(async (tx) => {
    await assumeWorkerRole(tx);
    const trusted = await resumeTrustedLease<LeasedJob>(tx, scope, RESUME_SQL);

    const { handler, state } = prepared;
    const detail = await withScopedCapabilities(
      tx,
      handler.settleCapabilities,
      (capabilities) => handler.settle(state, outcome, capabilities),
    );

    await completeJob(tx, trusted.id, detail);
    return detail;
  });
}

const SHAPE_CHANGED =
  "the resumed job resolves to a different handler shape than the job that was leased";

/**
 * Resumes the lease inside `tx` and proves the session's tenant agrees with
 * it. Every transaction that lets handler code run passes through here first.
 */
async function resumeTrustedLease<TRow extends LeasedJob>(
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

function resolveRunnable(
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

function logAttemptStarted(
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

async function completeJob(
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

/**
 * Grants capabilities that stop working when `phase` returns.
 *
 * `grantCapabilities` closes over the transaction's client, and in the
 * external_call shape handler code keeps running after that transaction ends.
 * A capability carried into `state` would then run SQL on a connection the
 * pool has already released — outside the lease's tenant context, or inside
 * someone else's transaction. Revoking it turns that into a refusal.
 */
async function withScopedCapabilities<K extends CapabilityName, T>(
  tx: TxClient,
  granted: readonly K[],
  phase: (capabilities: Pick<Capabilities, K>) => Promise<T>,
): Promise<T> {
  let open = true;
  const scoped: TxClient = {
    query<TRow>(sql: string, params?: readonly unknown[]) {
      if (!open) {
        return Promise.reject(
          new SecurityError(
            "a capability was used after its transaction ended; capabilities do not outlive the transaction that granted them",
          ),
        );
      }
      return tx.query<TRow>(sql, params);
    },
  };
  try {
    return await phase(grantCapabilities(scoped, granted));
  } finally {
    open = false;
  }
}

/**
 * A promise that rejects with the signal's reason CALL_ABANDON_GRACE_MS after
 * the signal aborts, and never otherwise. `dispose` releases the listener and
 * the timer once the race is decided.
 */
function abandonAfterAbort(signal: AbortSignal): {
  promise: Promise<never>;
  dispose: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => {
      timer = setTimeout(() => reject(signal.reason), CALL_ABANDON_GRACE_MS);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    dispose() {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    },
  };
}

function succeeded(
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
async function failed(
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
