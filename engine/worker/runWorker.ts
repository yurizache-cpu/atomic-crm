// The worker loop. Boot, poll, execute, shut down.
//
// This is deliberately a loop and a timer, not a framework. There is no broker,
// no scheduler service, no leader election and no coordination between workers:
// `FOR UPDATE SKIP LOCKED` in `ops.lease_job` is the whole concurrency
// mechanism, and it is enough at this scale.
//
// Two things happen here that do NOT depend on jobs arriving:
//
//   * the heartbeat, so a job leased to a process that has gone away is
//     diagnosable rather than merely stale;
//   * the reaper tick, so expired leases are recovered on a clock. Phase 1A
//     recovered them only inside `ops.lease_job`, which meant recovery was a
//     side effect of new work arriving. The tick runs whether or not anything
//     is queued. After reaping, the same tick settles agent runs a dead worker
//     left "running", then enforces the global daily spend ceiling (ADR 0017
//     §5) — each in its OWN transaction, so a failure there can never undo or
//     block lease recovery.
//
// Signals are NOT handled here. The caller owns the AbortSignal, so this
// function stays a plain async function that tests can drive.

import type { WorkerDatabase } from "../db/types.ts";
import { STOP_ID_PATTERN } from "./externalCall.ts";
import { describeError } from "./failures.ts";
import type { HandlerRegistry } from "./handlerRegistry.ts";
import { silentLogger, type WorkerLogger } from "./log.ts";
import { runOneJob, type RunOneJobResult } from "./runOneJob.ts";

export interface RunWorkerOptions {
  workerId: string;
  db: WorkerDatabase;
  registry: HandlerRegistry;
  /** Wait between polls when the queue was empty. */
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  reapIntervalMs?: number;
  leaseSeconds?: number;
  log?: WorkerLogger;
  /**
   * Aborting stops the loop after the job in flight finishes. An external call
   * in flight is aborted, and its handler settles that outcome.
   */
  signal?: AbortSignal;
  /** Stop after this many loop iterations. Tests only; undefined means forever. */
  maxIterations?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * The detail of the boot heartbeat, which ops.worker_instances keeps until a
   * later heartbeat names another. main.ts puts the route summary here, so an
   * operator can read what this worker routes to without its environment. It
   * never holds a key or a connection string.
   */
  startDetail?: string;
}

export interface WorkerStats {
  leased: number;
  succeeded: number;
  retried: number;
  failed: number;
  idlePolls: number;
  pollFailures: number;
  leaseRecoveries: number;
  /** Agent runs left "running" by a worker that died mid-call, settled by the reaper tick. */
  staleRunsSettled: number;
  /** Leased jobs an execution stop sent back to the queue before their call. */
  deferred: number;
}

const DEFAULTS = {
  pollIntervalMs: 1_000,
  heartbeatIntervalMs: 15_000,
  reapIntervalMs: 30_000,
  leaseSeconds: 60,
};

/** Backoff after a failed poll, so a database outage is not a hot loop. */
const POLL_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function runWorker(
  options: RunWorkerOptions,
): Promise<WorkerStats> {
  const {
    workerId,
    db,
    registry,
    pollIntervalMs = DEFAULTS.pollIntervalMs,
    heartbeatIntervalMs = DEFAULTS.heartbeatIntervalMs,
    reapIntervalMs = DEFAULTS.reapIntervalMs,
    leaseSeconds = DEFAULTS.leaseSeconds,
    log = silentLogger,
    signal,
    maxIterations,
    now = () => Date.now(),
    sleep = defaultSleep,
    startDetail = "started",
  } = options;

  if (!workerId.trim()) {
    throw new Error("runWorker requires a stable worker id");
  }

  const stats: WorkerStats = {
    leased: 0,
    succeeded: 0,
    retried: 0,
    failed: 0,
    idlePolls: 0,
    pollFailures: 0,
    leaseRecoveries: 0,
    staleRunsSettled: 0,
    deferred: 0,
  };

  const heartbeat = async (detail?: string) => {
    await db.withTransaction(async (tx) => {
      await tx.query("set local role ops_worker");
      await tx.query("select ops.worker_heartbeat($1, $2)", [
        workerId,
        detail ?? null,
      ]);
    });
  };

  const reap = async () => {
    const reaped = await db.withTransaction(async (tx) => {
      await tx.query("set local role ops_worker");
      const { rows } = await tx.query<{ reaped: number }>(
        "select ops.reap_expired_leases() as reaped",
      );
      return Number(rows[0]?.reaped ?? 0);
    });
    if (reaped > 0) {
      stats.leaseRecoveries += reaped;
      log("lease.recovered", { workerId, count: reaped });
    }
  };

  // A separate transaction, and a failure that is contained, both on purpose.
  // Lease recovery is what keeps every tenant's queue moving; this settlement
  // only closes out runs whose worker died between its call and its settle. If
  // it shared the reap transaction, one broken run would roll recovery back;
  // if it threw into the loop, it would count as a poll failure and back the
  // whole worker off. It is logged, and tried again on the next tick.
  const settleStaleAgentRuns = async () => {
    try {
      const settled = await db.withTransaction(async (tx) => {
        await tx.query("set local role ops_worker");
        const { rows } = await tx.query<{ settled: number | string }>(
          "select ops.settle_stale_agent_runs() as settled",
        );
        return Number(rows[0]?.settled ?? 0);
      });
      if (settled > 0) {
        stats.staleRunsSettled += settled;
        log("agent_run.stale_settled", { workerId, count: settled });
      }
    } catch (error) {
      log("worker.poll_failed", {
        workerId,
        detail: `stale agent run settlement failed: ${describeError(error)}`,
      });
    }
  };

  // Contained like the stale-run settlement, for the same reason. The ceiling
  // only ever subtracts capability (it trips a global stop, it never clears
  // one), and a start already refuses any run the ceiling cannot absorb, so a
  // tick that fails costs a later trip, not an overspend.
  const enforceSpendCeiling = async () => {
    try {
      const stopId = await db.withTransaction(async (tx) => {
        await tx.query("set local role ops_worker");
        const { rows } = await tx.query<{ stop_id?: unknown }>(
          "select ops.enforce_spend_ceiling() as stop_id",
        );
        return rows[0]?.stop_id ?? null;
      });
      if (stopId === null) return;
      if (typeof stopId === "string" && STOP_ID_PATTERN.test(stopId)) {
        log("spend_ceiling.tripped", { workerId, detail: stopId });
        return;
      }
      // Not a value to echo: say only that the answer was not a stop id.
      log("worker.poll_failed", {
        workerId,
        detail:
          "spend ceiling enforcement failed: ops.enforce_spend_ceiling answered something other than a stop id",
      });
    } catch (error) {
      log("worker.poll_failed", {
        workerId,
        detail: `spend ceiling enforcement failed: ${describeError(error)}`,
      });
    }
  };

  await heartbeat(startDetail);
  log("worker.started", { workerId });

  let lastHeartbeat = now();
  let lastReap = now();
  let consecutivePollFailures = 0;
  let iterations = 0;

  try {
    while (!signal?.aborted) {
      if (maxIterations !== undefined && iterations >= maxIterations) break;
      iterations += 1;

      let result: RunOneJobResult | undefined;
      try {
        if (now() - lastReap >= reapIntervalMs) {
          await reap();
          await settleStaleAgentRuns();
          await enforceSpendCeiling();
          lastReap = now();
        }
        if (now() - lastHeartbeat >= heartbeatIntervalMs) {
          await heartbeat();
          log("worker.heartbeat", { workerId });
          lastHeartbeat = now();
        }

        // Shutdown may have landed while the maintenance above ran. Leasing now
        // would commit a lease, and an external call's prepare would commit a
        // "running" record, for a call the aborted signal then cancels before it
        // is ever issued. The loop condition cannot see this: it ran first.
        if (signal?.aborted) break;

        result = await runOneJob(db, {
          workerId,
          leaseSeconds,
          registry,
          log,
          // Reaches an external call, so shutdown does not wait out a slow
          // service. A transactional job in flight still finishes.
          signal,
        });
        consecutivePollFailures = 0;
      } catch (error) {
        // The database is unreachable, or something below threw in a way
        // runOneJob does not convert into an outcome. Neither is a reason to
        // exit: the process stays up and backs off.
        stats.pollFailures += 1;
        consecutivePollFailures += 1;
        log("worker.poll_failed", {
          workerId,
          detail: describeError(error),
          count: consecutivePollFailures,
        });
        const backoff =
          POLL_BACKOFF_MS[
            Math.min(consecutivePollFailures - 1, POLL_BACKOFF_MS.length - 1)
          ];
        await sleep(backoff, signal);
        continue;
      }

      switch (result.outcome) {
        case "idle":
          stats.idlePolls += 1;
          // Nothing queued. Wait before asking again, and wake early on abort.
          await sleep(pollIntervalMs, signal);
          break;
        case "succeeded":
          stats.leased += 1;
          stats.succeeded += 1;
          break;
        case "retry":
          stats.leased += 1;
          stats.retried += 1;
          break;
        case "failed":
          stats.leased += 1;
          stats.failed += 1;
          break;
        case "deferred":
          // Queued again, not ready for a while: the next poll finds other
          // work or an empty queue, and an empty queue is what sleeps.
          stats.leased += 1;
          stats.deferred += 1;
          break;
      }
    }
  } finally {
    log("worker.stopping", { workerId });
    // Best effort. A worker that cannot record its own stop is still stopping,
    // and its leases expire on their own.
    try {
      await db.withTransaction(async (tx) => {
        await tx.query("set local role ops_worker");
        await tx.query("select ops.worker_stopped($1)", [workerId]);
      });
    } catch (error) {
      log("worker.poll_failed", {
        workerId,
        detail: `could not record shutdown: ${describeError(error)}`,
      });
    }
    log("worker.stopped", { workerId });
  }

  return stats;
}
