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
//     left "running" — in its OWN transaction, so a failure there can never
//     undo or block lease recovery.
//
// Signals are NOT handled here. The caller owns the AbortSignal, so this
// function stays a plain async function that tests can drive.

import type { WorkerDatabase } from "../db/types.ts";
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

  await heartbeat("started");
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
