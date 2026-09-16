// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import {
  createRegistry,
  type CallOutcome,
  type ExternalCallContext,
} from "./handlerRegistry.ts";
import type { WorkerLogEvent, WorkerLogFields } from "./log.ts";
import { runWorker } from "./runWorker.ts";

interface ScriptedOptions {
  /** Outcome of each successive lease attempt: a kind, or null for empty. */
  queue?: (string | null)[];
  reaped?: number;
  /** Transaction numbers that should throw, simulating an outage. */
  failTransactions?: number[];
  /** What ops.settle_stale_agent_runs() reports. */
  staleSettled?: number;
  /** A statement fragment whose query throws inside an otherwise healthy transaction. */
  failStatement?: string;
}

const TENANT = "aaaaaaaa-0000-0000-0000-000000000001";

/**
 * A database that answers the whole runtime's SQL surface from a script.
 * Deliberately at the SQL level rather than mocking runOneJob: the loop's job is
 * to drive that function, and a test that mocks it proves nothing about the
 * order in which heartbeat, reaper and lease actually happen.
 */
const scriptedDb = (options: ScriptedOptions = {}) => {
  const sql: string[] = [];
  /** The transaction each entry of sql ran in. */
  const transactionOf: number[] = [];
  const queue = [...(options.queue ?? [])];
  let transaction = 0;
  let leaseIndex = 0;

  const db: WorkerDatabase = {
    async withTransaction(fn) {
      transaction += 1;
      const mine = transaction;
      if (options.failTransactions?.includes(transaction)) {
        throw Object.assign(new Error("terminating connection"), {
          code: "57P01",
        });
      }
      const tx: TxClient = {
        async query(statement) {
          sql.push(statement);
          transactionOf.push(mine);
          if (
            options.failStatement &&
            statement.includes(options.failStatement)
          ) {
            throw Object.assign(new Error("function raised an exception"), {
              code: "P0001",
            });
          }
          if (statement.includes("ops.lease_job")) {
            const kind = queue[leaseIndex++];
            if (!kind) return { rows: [] } as never;
            return {
              rows: [
                {
                  id: `job-${leaseIndex}`,
                  tenant_id: TENANT,
                  kind,
                  payload: {},
                  attempts: 1,
                  max_attempts: 3,
                },
              ],
            } as never;
          }
          if (statement.includes("ops.resume_lease")) {
            return {
              rows: [
                {
                  id: `job-${leaseIndex}`,
                  tenant_id: TENANT,
                  kind: queue[leaseIndex - 1] ?? "noop",
                  payload: {},
                  attempts: 1,
                  max_attempts: 3,
                  // pg returns a bigint as a string.
                  ...(statement.includes("lease_remaining_ms")
                    ? { lease_remaining_ms: "30000" }
                    : {}),
                },
              ],
            } as never;
          }
          if (statement.includes("ops.current_tenant_id")) {
            return { rows: [{ tenant_id: TENANT }] } as never;
          }
          if (statement.includes("ops.complete_job")) {
            return { rows: [{ ok: true }] } as never;
          }
          if (statement.includes("ops.settle_job_failure")) {
            return { rows: [{ result: "retry" }] } as never;
          }
          if (statement.includes("ops.reap_expired_leases")) {
            return { rows: [{ reaped: options.reaped ?? 0 }] } as never;
          }
          if (statement.includes("ops.settle_stale_agent_runs")) {
            return {
              rows: [{ settled: options.staleSettled ?? 0 }],
            } as never;
          }
          return { rows: [] } as never;
        },
      };
      return await fn(tx);
    },
    async identity() {
      throw new Error("not used");
    },
    async close() {},
  };

  return { db, sql, transactionOf };
};

const registry = createRegistry([
  { kind: "noop", capabilities: [], run: async () => "ok" },
]);

const noSleep = async () => {};

describe("boot and shutdown", () => {
  it("heartbeats before it does anything else, and records its stop", async () => {
    const { db, sql } = scriptedDb({ queue: [null] });
    const events: WorkerLogEvent[] = [];
    await runWorker({
      workerId: "w1",
      db,
      registry,
      maxIterations: 1,
      sleep: noSleep,
      log: (event) => events.push(event),
    });
    expect(sql[1]).toContain("ops.worker_heartbeat");
    expect(sql.some((s) => s.includes("ops.worker_stopped"))).toBe(true);
    expect(events[0]).toBe("worker.started");
    expect(events.at(-1)).toBe("worker.stopped");
  });

  it("stops leasing once the signal aborts", async () => {
    const { db, sql } = scriptedDb({ queue: [null, null, null] });
    const controller = new AbortController();
    controller.abort();
    await runWorker({
      workerId: "w1",
      db,
      registry,
      signal: controller.signal,
      sleep: noSleep,
    });
    // Boot heartbeat and the shutdown record, and no lease attempt at all.
    expect(sql.some((s) => s.includes("ops.lease_job"))).toBe(false);
    expect(sql.some((s) => s.includes("ops.worker_stopped"))).toBe(true);
  });

  it("leases nothing when shutdown lands during the reaper or heartbeat step", async () => {
    // The loop condition is checked BEFORE maintenance runs. An abort that
    // arrives during it must still stop the lease: otherwise the lease commits,
    // and an external call's prepare commits a "running" record, for a call the
    // aborted signal cancels before it is issued.
    for (const trigger of ["lease.recovered", "worker.heartbeat"] as const) {
      let clock = 0;
      const controller = new AbortController();
      const prepare = vi.fn(async () => ({
        kind: "call" as const,
        state: null,
      }));
      const { db, sql } = scriptedDb({ queue: ["call.probe"], reaped: 1 });
      const external = createRegistry([
        {
          kind: "call.probe",
          shape: "external_call",
          prepareCapabilities: [],
          settleCapabilities: [],
          prepare,
          call: async () => "called",
          settle: async () => "settled",
        },
      ]);
      const stats = await runWorker({
        workerId: "w1",
        db,
        registry: external,
        signal: controller.signal,
        reapIntervalMs: 10,
        heartbeatIntervalMs: 10,
        sleep: noSleep,
        now: () => (clock += 100),
        log: (event) => {
          if (event === trigger) controller.abort();
        },
      });
      expect(sql.some((s) => s.includes("ops.lease_job"))).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      expect(stats.leased).toBe(0);
      expect(sql.some((s) => s.includes("ops.worker_stopped"))).toBe(true);
    }
  });

  it("finishes the job in flight before stopping", async () => {
    // Graceful shutdown means "stop taking new work", not "abandon this".
    const { db, sql } = scriptedDb({ queue: ["noop", "noop"] });
    const controller = new AbortController();
    let completed = 0;
    const registryThatAborts = createRegistry([
      {
        kind: "noop",
        capabilities: [],
        run: async () => {
          controller.abort();
          return "ok";
        },
      },
    ]);
    const stats = await runWorker({
      workerId: "w1",
      db,
      registry: registryThatAborts,
      signal: controller.signal,
      sleep: noSleep,
      log: (event) => {
        if (event === "job.attempt_completed") completed += 1;
      },
    });
    expect(completed).toBe(1);
    expect(stats.succeeded).toBe(1);
    expect(sql.some((s) => s.includes("ops.worker_stopped"))).toBe(true);
  });

  it("records its stop even when the loop threw", async () => {
    const { db, sql } = scriptedDb({ queue: [null] });
    await runWorker({
      workerId: "w1",
      db,
      registry,
      maxIterations: 1,
      sleep: noSleep,
    });
    expect(sql.filter((s) => s.includes("ops.worker_stopped"))).toHaveLength(1);
  });

  it("refuses a blank worker id", async () => {
    const { db } = scriptedDb();
    await expect(
      runWorker({ workerId: " ", db, registry, maxIterations: 1 }),
    ).rejects.toThrow(/worker id/i);
  });
});

describe("recovery does not wait for business traffic", () => {
  it("reaps on its own clock even when the queue is empty", async () => {
    // The Phase 1A gap this closes: recovery happened only inside
    // ops.lease_job, so it was a side effect of new work arriving.
    let clock = 0;
    const { db, sql } = scriptedDb({ queue: [null, null], reaped: 2 });
    const stats = await runWorker({
      workerId: "w1",
      db,
      registry,
      maxIterations: 2,
      reapIntervalMs: 10,
      sleep: noSleep,
      now: () => (clock += 100),
    });
    expect(sql.some((s) => s.includes("ops.reap_expired_leases"))).toBe(true);
    expect(stats.leaseRecoveries).toBeGreaterThan(0);
    expect(stats.idlePolls).toBe(2);
  });

  it("does not reap on every iteration", async () => {
    const { db, sql } = scriptedDb({ queue: [null, null, null] });
    await runWorker({
      workerId: "w1",
      db,
      registry,
      maxIterations: 3,
      reapIntervalMs: 1_000_000,
      sleep: noSleep,
      now: () => 0,
    });
    expect(
      sql.filter((s) => s.includes("ops.reap_expired_leases")),
    ).toHaveLength(0);
  });

  it("heartbeats on its own clock", async () => {
    let clock = 0;
    const { db, sql } = scriptedDb({ queue: [null, null] });
    await runWorker({
      workerId: "w1",
      db,
      registry,
      maxIterations: 2,
      heartbeatIntervalMs: 10,
      sleep: noSleep,
      now: () => (clock += 100),
    });
    // Boot heartbeat plus at least one on the clock.
    expect(
      sql.filter((s) => s.includes("ops.worker_heartbeat")).length,
    ).toBeGreaterThan(1);
  });
});

describe("a database outage is not a reason to exit", () => {
  it("backs off and keeps running", async () => {
    const slept: number[] = [];
    const { db } = scriptedDb({
      queue: [null, null, null],
      // Transaction 1 is the boot heartbeat; 2 and 3 are the first two polls.
      failTransactions: [2, 3],
    });
    const stats = await runWorker({
      workerId: "w1",
      db,
      registry,
      maxIterations: 3,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(stats.pollFailures).toBe(2);
    // Backoff grows rather than hot-looping.
    expect(slept[0]).toBeLessThan(slept[1]);
  });

  it("resets the backoff after a good poll", async () => {
    const slept: number[] = [];
    const { db } = scriptedDb({
      queue: [null, null, null, null],
      failTransactions: [2, 4],
    });
    await runWorker({
      workerId: "w1",
      db,
      registry,
      maxIterations: 4,
      pollIntervalMs: 7,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    // Two failures separated by a success must both back off from the start of
    // the ladder, not climb it.
    const backoffs = slept.filter((ms) => ms !== 7);
    expect(backoffs[0]).toBe(backoffs[1]);
  });
});

describe("statistics", () => {
  it("counts what happened", async () => {
    const { db } = scriptedDb({ queue: ["noop", null, "noop"] });
    const stats = await runWorker({
      workerId: "w1",
      db,
      registry,
      maxIterations: 3,
      sleep: noSleep,
    });
    expect(stats).toMatchObject({
      leased: 2,
      succeeded: 2,
      retried: 0,
      failed: 0,
      idlePolls: 1,
      pollFailures: 0,
    });
  });

  it("sleeps only when the queue was empty", async () => {
    const sleep = vi.fn(async () => {});
    const { db } = scriptedDb({ queue: ["noop", "noop"] });
    await runWorker({
      workerId: "w1",
      db,
      registry,
      maxIterations: 2,
      sleep,
    });
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("stale agent runs are settled on the reaper's clock, apart from lease recovery", () => {
  it("settles them in their own transaction right after the reap, and logs the count", async () => {
    let clock = 0;
    const { db, sql, transactionOf } = scriptedDb({
      queue: [null, null],
      reaped: 1,
      staleSettled: 2,
    });
    const settledLines: (WorkerLogFields | undefined)[] = [];
    const stats = await runWorker({
      workerId: "w1",
      db,
      registry,
      maxIterations: 2,
      reapIntervalMs: 10,
      sleep: noSleep,
      now: () => (clock += 100),
      log: (event, fields) => {
        if (event === "agent_run.stale_settled") settledLines.push(fields);
      },
    });
    const reapAt = sql.findIndex((s) => s.includes("ops.reap_expired_leases"));
    const staleAt = sql.findIndex((s) =>
      s.includes("ops.settle_stale_agent_runs"),
    );
    expect(reapAt).toBeGreaterThanOrEqual(0);
    expect(staleAt).toBeGreaterThan(reapAt);
    // Its own transaction, which assumes the worker role like every other.
    expect(transactionOf[staleAt]).toBe(transactionOf[reapAt] + 1);
    expect(sql[staleAt - 1]).toBe("set local role ops_worker");
    expect(transactionOf[staleAt - 1]).toBe(transactionOf[staleAt]);
    const ticks = sql.filter((s) =>
      s.includes("ops.settle_stale_agent_runs"),
    ).length;
    expect(ticks).toBe(2);
    expect(stats.staleRunsSettled).toBe(4);
    expect(settledLines).toEqual([
      { workerId: "w1", count: 2 },
      { workerId: "w1", count: 2 },
    ]);
  });

  it("logs nothing when no run was stale", async () => {
    let clock = 0;
    const { db, sql } = scriptedDb({ queue: [null], staleSettled: 0 });
    const events: WorkerLogEvent[] = [];
    const stats = await runWorker({
      workerId: "w1",
      db,
      registry,
      maxIterations: 1,
      reapIntervalMs: 10,
      sleep: noSleep,
      now: () => (clock += 100),
      log: (event) => events.push(event),
    });
    expect(sql.some((s) => s.includes("ops.settle_stale_agent_runs"))).toBe(
      true,
    );
    expect(events).not.toContain("agent_run.stale_settled");
    expect(stats.staleRunsSettled).toBe(0);
  });

  it("keeps recovering leases and polling when the settlement fails, and counts no poll failure", async () => {
    let clock = 0;
    const { db, sql } = scriptedDb({
      queue: [null, null],
      reaped: 1,
      failStatement: "ops.settle_stale_agent_runs",
    });
    const failures: (WorkerLogFields | undefined)[] = [];
    const stats = await runWorker({
      workerId: "w1",
      db,
      registry,
      maxIterations: 2,
      reapIntervalMs: 10,
      sleep: noSleep,
      now: () => (clock += 100),
      log: (event, fields) => {
        if (event === "worker.poll_failed") failures.push(fields);
      },
    });
    // Both ticks still reaped, and both polls still ran.
    expect(
      sql.filter((s) => s.includes("ops.reap_expired_leases")),
    ).toHaveLength(2);
    expect(stats).toMatchObject({
      leaseRecoveries: 2,
      idlePolls: 2,
      pollFailures: 0,
      staleRunsSettled: 0,
    });
    expect(failures).toHaveLength(2);
    for (const fields of failures) {
      expect(fields?.detail).toMatch(/^stale agent run settlement failed: /);
      expect(fields?.count).toBeUndefined();
    }
  });
});

describe("shutdown reaches an external call in flight", () => {
  it("aborts the call, lets its handler settle the outcome, and stops leasing", async () => {
    const controller = new AbortController();
    const outcomes: CallOutcome<unknown>[] = [];
    const { db, sql } = scriptedDb({ queue: ["call.probe", "call.probe"] });
    const external = createRegistry([
      {
        kind: "call.probe",
        shape: "external_call",
        prepareCapabilities: [],
        settleCapabilities: [],
        prepare: async () => ({ kind: "call", state: null }),
        call: (_state: unknown, context: ExternalCallContext) =>
          new Promise<never>((_, reject) => {
            context.signal.addEventListener(
              "abort",
              () => reject(context.signal.reason),
              { once: true },
            );
            setTimeout(() => controller.abort(), 5);
          }),
        settle: async (_state, outcome) => {
          outcomes.push(outcome);
          return "settled=cancelled";
        },
      },
    ]);
    const stats = await runWorker({
      workerId: "w1",
      db,
      registry: external,
      signal: controller.signal,
      sleep: noSleep,
    });
    expect(outcomes).toHaveLength(1);
    const [outcome] = outcomes;
    expect(outcome.ok ? "ok" : (outcome.error as DOMException).name).toBe(
      "AbortError",
    );
    expect(stats).toMatchObject({ leased: 1, succeeded: 1 });
    expect(sql.filter((s) => s.includes("ops.lease_job"))).toHaveLength(1);
  });
});
