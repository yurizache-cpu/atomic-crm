// The external_call flow: ONE call to a service outside the database, which
// must not be issued twice, between two committed transactions.
//
// runOneJob.ts leases the job (TX1) and hands an external_call kind here.
// Holding a transaction open across the call would pin a pooled connection for
// as long as the service takes, and would let a rollback erase the record of a
// call the service has already acted on. So TX2 is split in two:
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
//   AFTER only once TX2b has COMMITTED: the steps the handler declared to
//         follow its settlement (afterSettlement.ts), each in a transaction of
//         its own. The lease ended with TX2b, and with it every way back to the
//         settlement: a step that fails, waits, times out or is cancelled is
//         logged and left to its recovery, and never reaches TX3, so it cannot
//         schedule a retry. A prepare that settles made no call, and nothing
//         follows it.
//
// THE KILL SWITCH, immediately before the call (ADR 0017 §6). TX2a takes a
// savepoint before the handler's prepare. Only when prepare asks for the call,
// the runtime asks the database whether an execution stop covers the leased job,
// in the same transaction that would commit the handler's durable start:
//
//   * no stop: the savepoint is released and the call proceeds as above;
//   * a stop: TX2a rolls back to the savepoint, discarding the handler's
//     durable start, then `ops.defer_job()` returns the job to the queue without
//     consuming an attempt. TX2a commits that deferral and nothing is called;
//   * anything the runtime does not recognise: the whole of TX2a rolls back and
//     nothing is called. Fail closed.
//
// A prepare that settles commits as it is, with no stop check: a start-time
// refusal it recorded (naming its stop) must stay recorded. The check is
// runtime SQL, like completing a job, never a handler capability.
//
// A crash between TX2a and TX2b is recovered by the handler's OWN durable
// state, not by calling again. The lease expires, the reaper requeues or
// retires the job, and the next `prepare` finds its record still "running" and
// settles it as indeterminate. That part is the handler's contract; this
// module's part is that the "running" record was committed before the call
// was issued, and that nothing here ever issues the call a second time.

import type { TxClient } from "../db/types.ts";
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
import { runAfterSettlement } from "./afterSettlement.ts";
import {
  grantCapabilities,
  type CapabilityName,
  type Capabilities,
} from "./capabilities.ts";
import { PermanentError, SecurityError, TransientError } from "./failures.ts";
import {
  isExternalCallHandler,
  settlementDetail,
  type CallOutcome,
  type ExternalCallContext,
  type ExternalCallHandlerDefinition,
  type ObservedSettlement,
  type PrepareBudget,
} from "./handlerRegistry.ts";
import type { LeasedJob } from "./job.ts";

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

/**
 * The prepare transaction's resume, which also asks the DATABASE how long the
 * lease has left. It is a duration, measured on the database clock, so the
 * worker's own clock only has to be steady, never in agreement with Postgres.
 * `clock_timestamp()` rather than `now()`: `now()` is frozen at the start of
 * the transaction, which would overstate the time remaining.
 */
const RESUME_WITH_REMAINING_SQL =
  "select *, greatest(0, floor(extract(epoch from (lease_expires_at - clock_timestamp())) * 1000))::bigint as lease_remaining_ms from ops.resume_lease($1, $2)";

export interface ExternalCallOptions {
  readonly leaseSafetyMarginMs: number;
  /** Worker shutdown. It reaches the call's signal. */
  readonly signal: AbortSignal | undefined;
  /** The crash seam between the call and TX2b. Tests only. */
  readonly onCallFinished: ((job: LeasedJob) => Promise<void>) | undefined;
}

/** A prepare that asked for the call. Carried across the call, never across a crash. */
interface PreparedCall {
  readonly kind: "call";
  readonly handler: ExternalCallHandlerDefinition;
  readonly state: unknown;
  readonly deadline: number;
  /** Who is called, for telemetry only. */
  readonly providerKind: string | undefined;
}

type Prepared =
  | { readonly kind: "settled"; readonly detail: string }
  /** A stop covered the job: the deferral is committed and nothing is called. */
  | { readonly kind: "deferred"; readonly stopId: string }
  | PreparedCall;

/** Taken before prepare, so a covering stop can discard what prepare wrote. */
const PREPARE_SAVEPOINT = "external_call_prepare";

export const STOP_CHECK_SQL = "select ops.job_execution_stop() as stop_id";
export const DEFER_SQL = "select ops.defer_job() as stop_id";

/** How Postgres prints a uuid. Anything else is not an answer this runtime trusts. */
export const STOP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The one stop id, or null, a stop function answered with. Exactly one row,
 * holding `stop_id` as null or a lowercase uuid: any other answer means the
 * runtime cannot tell whether the job is held, and it does not guess.
 */
export async function readStopAnswer(
  tx: TxClient,
  sql: string,
  fn: string,
): Promise<string | null> {
  const { rows } = await tx.query<Record<string, unknown>>(sql);
  const row = rows.length === 1 ? rows[0] : undefined;
  const stopId =
    typeof row === "object" && row !== null && Object.hasOwn(row, "stop_id")
      ? row.stop_id
      : undefined;
  if (stopId === null) return null;
  if (typeof stopId === "string" && STOP_ID_PATTERN.test(stopId)) {
    return stopId;
  }
  throw new SecurityError(
    `${fn} answered something other than one stop id or none; nothing was called`,
  );
}

/**
 * The pre-call stop check, inside TX2a after prepare asked for the call.
 * Returns null when the call may proceed, or the stop that deferred the job.
 */
async function holdForExecutionStop(tx: TxClient): Promise<string | null> {
  const covering = await readStopAnswer(
    tx,
    STOP_CHECK_SQL,
    "ops.job_execution_stop",
  );
  if (covering === null) {
    await tx.query(`release savepoint ${PREPARE_SAVEPOINT}`);
    return null;
  }
  // Discard the handler's durable start: a deferred job made no call, and its
  // next attempt must find nothing that claims one was made.
  await tx.query(`rollback to savepoint ${PREPARE_SAVEPOINT}`);
  const deferredBy = await readStopAnswer(tx, DEFER_SQL, "ops.defer_job");
  if (deferredBy === null) {
    // The stop was cleared between the check and the deferral. Rolling the
    // whole prepare back and retrying through the failure path re-checks
    // every gate on a fresh attempt, instead of calling on a stale decision.
    throw new TransientError(
      "an execution stop covered the job but was cleared before it could be deferred; nothing was called",
    );
  }
  return deferredBy;
}

/**
 * Prepare's own gate found a covering stop (a `held` outcome) and recorded
 * nothing, so there is nothing to roll back. Deferring without leaving the
 * savepoint keeps the kill-switch lock that gate took: the stop cannot be
 * cleared in between, so the deferral finds it. If it does not, the two stop
 * readings disagree, and the whole prepare rolls back instead of guessing.
 */
async function deferHeldJob(tx: TxClient): Promise<string> {
  await tx.query(`release savepoint ${PREPARE_SAVEPOINT}`);
  const deferredBy = await readStopAnswer(tx, DEFER_SQL, "ops.defer_job");
  if (deferredBy === null) {
    throw new TransientError(
      "prepare found the job held by an execution stop, but no stop covered it when it was deferred; nothing was called",
    );
  }
  return deferredBy;
}

/** TX2a, the call and TX2b, for a job TX1 leased as an external_call kind. */
export async function runExternalCall(
  scope: AttemptScope,
  { leaseSafetyMarginMs, signal, onCallFinished }: ExternalCallOptions,
): Promise<RunOneJobResult> {
  // --- TX2a: resume, prepare, commit without completing. -------------------
  let prepared: PreparedCall;
  try {
    const outcome = await scope.trace.phase("company_os.governance.check", () =>
      prepareExternalCall(scope, leaseSafetyMarginMs),
    );
    if (outcome.kind === "settled") return succeeded(scope, outcome.detail);
    if (outcome.kind === "deferred") return deferred(scope, outcome.stopId);
    prepared = outcome;
  } catch (error) {
    return failed(scope, error);
  }

  // --- CALL: no transaction. It cannot throw; a failed call is an outcome. --
  const callOutcome = await scope.trace.providerCall(
    prepared.providerKind,
    () => performCall(scope, prepared, signal),
  );

  // The crash seam for the window a paid call makes dangerous. Deliberately
  // outside every try: a throw here must look like the process dying, which
  // settles nothing and issues nothing again.
  if (onCallFinished) await onCallFinished(scope.job);

  // --- TX2b: resume, settle, complete. -------------------------------------
  let settled: string | ObservedSettlement;
  try {
    settled = await scope.trace.phase("company_os.settlement", () =>
      settleExternalCall(scope, prepared, callOutcome),
    );
  } catch (error) {
    return failed(scope, error);
  }
  // Committed: only now does telemetry count what the settlement recorded.
  if (typeof settled !== "string") scope.trace.settled(settled.observation);

  // --- AFTER: the settlement is committed; nothing below can undo it. ------
  await runAfterSettlement(scope, prepared.handler.afterSettlement ?? []);
  return succeeded(scope, settlementDetail(settled));
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

    await tx.query(`savepoint ${PREPARE_SAVEPOINT}`);
    const outcome = await withScopedCapabilities(
      tx,
      handler.prepareCapabilities,
      (capabilities) => handler.prepare(trusted, capabilities, budget),
    );

    if (outcome?.kind === "settled") {
      // No stop check: what prepare settled is committed as it is.
      await tx.query(`release savepoint ${PREPARE_SAVEPOINT}`);
      await completeJob(tx, trusted.id, outcome.detail);
      return { kind: "settled", detail: outcome.detail };
    }
    if (outcome?.kind === "held") {
      return { kind: "deferred", stopId: await deferHeldJob(tx) };
    }
    if (outcome?.kind !== "call") {
      // Rolled back with everything prepare wrote, so nothing claims a call
      // was made. Retrying the same code returns the same malformed value.
      throw new PermanentError(
        `handler "${handler.kind}" prepare returned neither "settled", "held" nor "call"`,
      );
    }

    const stopId = await holdForExecutionStop(tx);
    if (stopId !== null) return { kind: "deferred", stopId };
    return {
      kind: "call",
      handler,
      state: outcome.state,
      deadline,
      providerKind: outcome.providerKind,
    };
  });
}

/**
 * The attempt's result once TX2a committed a deferral. Not a failure: no
 * attempt was consumed, nothing was called, and TX3 must not run, because the
 * lease this worker held is already released.
 */
export function deferred(
  { workerId, job, log, startedAt }: AttemptScope,
  stopId: string,
): RunOneJobResult {
  const durationMs = Date.now() - startedAt;
  const detail = `held by execution stop ${stopId}`;
  log("job.deferred", {
    workerId,
    jobId: job.id,
    tenantId: job.tenant_id,
    kind: job.kind,
    attempt: job.attempts,
    durationMs,
    detail,
  });
  return {
    outcome: "deferred",
    jobId: job.id,
    tenantId: job.tenant_id,
    kind: job.kind,
    attempt: job.attempts,
    durationMs,
    detail,
  };
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
): Promise<string | ObservedSettlement> {
  return scope.db.withTransaction(async (tx) => {
    await assumeWorkerRole(tx);
    const trusted = await resumeTrustedLease<LeasedJob>(tx, scope, RESUME_SQL);

    const { handler, state } = prepared;
    const settled = await withScopedCapabilities(
      tx,
      handler.settleCapabilities,
      (capabilities) => handler.settle(state, outcome, capabilities),
    );

    await completeJob(tx, trusted.id, settlementDetail(settled));
    return settled;
  });
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
