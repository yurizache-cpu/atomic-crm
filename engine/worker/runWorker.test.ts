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
import { createRecordingTelemetry } from "../telemetry/testSupport/recordingTelemetry.ts";
import { createWorkerTelemetry } from "../telemetry/workerTelemetry.ts";

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
  /** What ops.job_execution_stop() and ops.defer_job() answer. Default: no stop. */
  stopId?: string | null;
  /** What ops.enforce_spend_ceiling() answers. Default: no stop tripped. */
  ceilingStop?: unknown;
  /** What ops.worker_queue_depth() answers, as pg returns a bigint. */
  queueDepth?: number;
}

const TENANT = "aaaaaaaa-0000-0000-0000-000000000001";
const STOP_ID = "5e0c1d2a-7b3f-4c8d-9e1f-2a3b4c5d6e7f";

/**
 * A database that answers the whole runtime's SQL surface from a script.
 * Deliberately at the SQL level rather than mocking runOneJob: the loop's job is
 * to drive that function, and a test that mocks it proves nothing about the
 * order in which heartbeat, reaper and lease actually happen.
 */
const scriptedDb = (options: ScriptedOptions = {}) => {
  const sql: string[] = [];
  /** The parameters each entry of sql was sent with. */
  const paramsOf: (readonly unknown[] | undefined)[] = [];
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
        async query(statement, params) {
          sql.push(statement);
          paramsOf.push(params);
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
          if (
            statement.includes("ops.job_execution_stop") ||
            statement.includes("ops.defer_job")
          ) {
            return { rows: [{ stop_id: options.stopId ?? null }] } as never;
          }
          if (statement.includes("ops.worker_queue_depth")) {
            return {
              rows: [{ depth: String(options.queueDepth ?? 0) }],
            } as never;
          }
          if (statement.includes("ops.enforce_spend_ceiling")) {
            return {
              rows: [{ stop_id: options.ceilingStop ?? null }],
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

  return { db, sql, paramsOf, transactionOf };
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

describe("the global spend ceiling is enforced on the reaper's clock, apart from lease recovery", () => {
  it("runs the ceiling check after the stale-run sweep, in its own transaction, as ops_worker", async () => {
    let clock = 0;
    const { db, sql, transactionOf } = scriptedDb({ queue: [null, null] });
    await runWorker({
      workerId: "w1",
      db,
      registry,
      maxIterations: 2,
      reapIntervalMs: 10,
      sleep: noSleep,
      now: () => (clock += 100),
    });
    const staleAt = sql.findIndex((s) =>
      s.includes("ops.settle_stale_agent_runs"),
    );
    const ceilingAt = sql.findIndex((s) =>
      s.includes("ops.enforce_spend_ceiling"),
    );
    expect(ceilingAt).toBeGreaterThan(staleAt);
    expect(sql[ceilingAt]).toBe(
      "select ops.enforce_spend_ceiling() as stop_id",
    );
    expect(transactionOf[ceilingAt]).toBe(transactionOf[staleAt] + 1);
    expect(sql[ceilingAt - 1]).toBe("set local role ops_worker");
    expect(transactionOf[ceilingAt - 1]).toBe(transactionOf[ceilingAt]);
    // Once per tick, and alone in its transaction with the role switch.
    expect(
      sql.filter((s) => s.includes("ops.enforce_spend_ceiling")),
    ).toHaveLength(2);
    expect(
      transactionOf.filter((tx) => tx === transactionOf[ceilingAt]),
    ).toHaveLength(2);
  });

  it("does not check the ceiling between reaper ticks", async () => {
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
    expect(sql.some((s) => s.includes("ops.enforce_spend_ceiling"))).toBe(
      false,
    );
  });

  it("logs a tripped ceiling with the stop it tripped, and nothing while the ceiling holds", async () => {
    const cases: readonly (readonly [string | null, readonly unknown[]])[] = [
      [STOP_ID, [{ workerId: "w1", detail: STOP_ID }]],
      [null, []],
    ];
    for (const [ceilingStop, expected] of cases) {
      let clock = 0;
      const { db } = scriptedDb({ queue: [null], ceilingStop });
      const tripped: (WorkerLogFields | undefined)[] = [];
      await runWorker({
        workerId: "w1",
        db,
        registry,
        maxIterations: 1,
        reapIntervalMs: 10,
        sleep: noSleep,
        now: () => (clock += 100),
        log: (event, fields) => {
          if (event === "spend_ceiling.tripped") tripped.push(fields);
        },
      });
      expect(tripped).toEqual(expected);
    }
  });

  it("keeps recovering leases and polling when the ceiling check fails, and counts no poll failure", async () => {
    let clock = 0;
    const { db, sql } = scriptedDb({
      queue: [null, null],
      reaped: 1,
      failStatement: "ops.enforce_spend_ceiling",
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
    expect(
      sql.filter((s) => s.includes("ops.reap_expired_leases")),
    ).toHaveLength(2);
    expect(stats).toMatchObject({
      leaseRecoveries: 2,
      idlePolls: 2,
      pollFailures: 0,
    });
    expect(failures).toHaveLength(2);
    for (const fields of failures) {
      expect(fields?.detail).toMatch(/^spend ceiling enforcement failed: /);
      expect(fields?.count).toBeUndefined();
    }
  });

  it("reports a ceiling answer that is not a stop id as a failure, without echoing it", async () => {
    for (const ceilingStop of [
      { leaked: "sentinel-ceiling-7731" },
      "sentinel-ceiling-7731",
      `${STOP_ID.toUpperCase()} sentinel-ceiling-7731`,
      42,
    ]) {
      let clock = 0;
      const { db } = scriptedDb({ queue: [null], ceilingStop });
      const lines: { event: WorkerLogEvent; fields?: WorkerLogFields }[] = [];
      await runWorker({
        workerId: "w1",
        db,
        registry,
        maxIterations: 1,
        reapIntervalMs: 10,
        sleep: noSleep,
        now: () => (clock += 100),
        log: (event, fields) => lines.push({ event, fields }),
      });
      expect(lines.map((line) => line.event)).not.toContain(
        "spend_ceiling.tripped",
      );
      const failure = lines.find((line) => line.event === "worker.poll_failed");
      expect(failure?.fields?.detail).toMatch(
        /^spend ceiling enforcement failed: /,
      );
      expect(JSON.stringify(lines)).not.toContain("sentinel-ceiling-7731");
      expect(JSON.stringify(lines)).not.toContain('"detail":42');
    }
  });
});

describe("a job an execution stop deferred is counted, and the loop does not wait on it", () => {
  it("counts a deferral as leased and deferred, calls nothing, and sleeps only for the empty queue", async () => {
    const call = vi.fn(async () => "called");
    const slept: number[] = [];
    const { db } = scriptedDb({
      queue: ["call.probe", "call.probe", null],
      stopId: STOP_ID,
    });
    const external = createRegistry([
      {
        kind: "call.probe",
        shape: "external_call",
        prepareCapabilities: [],
        settleCapabilities: [],
        prepare: async () => ({ kind: "call", state: null }),
        call,
        settle: async () => "settled",
      },
    ]);
    const deferredLines: (WorkerLogFields | undefined)[] = [];
    const stats = await runWorker({
      workerId: "w1",
      db,
      registry: external,
      maxIterations: 3,
      pollIntervalMs: 7,
      sleep: async (ms) => {
        slept.push(ms);
      },
      log: (event, fields) => {
        if (event === "job.deferred") deferredLines.push(fields);
      },
    });
    expect(call).not.toHaveBeenCalled();
    expect(stats).toMatchObject({
      leased: 2,
      deferred: 2,
      succeeded: 0,
      retried: 0,
      failed: 0,
      idlePolls: 1,
      pollFailures: 0,
    });
    expect(slept).toEqual([7]);
    expect(deferredLines).toHaveLength(2);
    for (const fields of deferredLines) {
      expect(fields?.detail).toBe(`held by execution stop ${STOP_ID}`);
    }
  });
});

describe("the boot heartbeat carries the detail the worker was started with", () => {
  const bootDetail = async (startDetail?: string) => {
    const { db, sql, paramsOf } = scriptedDb({ queue: [null] });
    await runWorker({
      workerId: "w1",
      db,
      registry,
      maxIterations: 1,
      sleep: noSleep,
      ...(startDetail === undefined ? {} : { startDetail }),
    });
    return paramsOf[sql.findIndex((s) => s.includes("ops.worker_heartbeat"))];
  };

  it("writes the given start detail into the first heartbeat", async () => {
    const detail =
      '{"version":"worker.detail.v1","state":"started","routes":[]}';
    expect(await bootDetail(detail)).toEqual(["w1", detail]);
  });

  it("writes started when no start detail is given", async () => {
    expect(await bootDetail()).toEqual(["w1", "started"]);
  });

  it("sends later heartbeats without a detail, so the database keeps the boot one", async () => {
    let clock = 0;
    const { db, sql, paramsOf } = scriptedDb({ queue: [null, null] });
    await runWorker({
      workerId: "w1",
      db,
      registry,
      maxIterations: 2,
      heartbeatIntervalMs: 10,
      sleep: noSleep,
      now: () => (clock += 100),
      startDetail: "booted",
    });
    const beats = sql
      .map((statement, index) => ({ statement, params: paramsOf[index] }))
      .filter(({ statement }) => statement.includes("ops.worker_heartbeat"))
      .map(({ params }) => params);
    expect(beats[0]).toEqual(["w1", "booted"]);
    expect(beats.length).toBeGreaterThan(1);
    for (const params of beats.slice(1)) expect(params).toEqual(["w1", null]);
  });
});

describe("telemetry observes the loop and never steers it (Phase 2E.1)", () => {
  const tick = () => {
    let clock = 0;
    return () => (clock += 100);
  };

  it("reads no queue depth, and issues no extra statement, without telemetry", async () => {
    const { db, sql } = scriptedDb({ queue: [null, null] });
    await runWorker({
      workerId: "w1",
      db,
      registry,
      maxIterations: 2,
      reapIntervalMs: 10,
      sleep: noSleep,
      now: tick(),
    });
    expect(sql.some((s) => s.includes("ops.worker_queue_depth"))).toBe(false);
  });

  it("reads the queue depth in its own transaction on the reaper tick, and publishes it with the stale settlements", async () => {
    const recording = createRecordingTelemetry();
    const { db, sql, transactionOf } = scriptedDb({
      queue: ["noop", null],
      staleSettled: 2,
      queueDepth: 5,
    });
    const stats = await runWorker({
      workerId: "w1",
      db,
      registry,
      maxIterations: 2,
      reapIntervalMs: 10,
      sleep: noSleep,
      now: tick(),
      telemetry: createWorkerTelemetry(recording, { readsQueueDepth: true }),
    });
    const depthAt = sql.findIndex((s) => s.includes("ops.worker_queue_depth"));
    const ceilingAt = sql.findIndex((s) =>
      s.includes("ops.enforce_spend_ceiling"),
    );
    expect(depthAt).toBeGreaterThan(ceilingAt);
    expect(transactionOf[depthAt]).toBe(transactionOf[ceilingAt] + 1);
    expect(sql[depthAt - 1]).toBe("set local role ops_worker");
    expect(
      recording.metrics
        .filter((m) => m.metric === "company_os_worker_queue_depth")
        .map((m) => m.value),
    ).toEqual([5, 5]);
    expect(
      recording.counted("company_os_agent_runs_total", {
        outcome: "indeterminate",
      }),
    ).toBe(4);
    expect(
      recording.counted("company_os_jobs_total", {
        job_kind: "other",
        outcome: "succeeded",
      }),
    ).toBe(1);
    expect(stats.succeeded).toBe(1);
  });

  it("keeps leasing and running work when the queue depth cannot be read", async () => {
    const events: WorkerLogEvent[] = [];
    const { db } = scriptedDb({
      queue: ["noop", "noop"],
      failStatement: "ops.worker_queue_depth",
    });
    const stats = await runWorker({
      workerId: "w1",
      db,
      registry,
      maxIterations: 2,
      reapIntervalMs: 10,
      sleep: noSleep,
      now: tick(),
      log: (event) => events.push(event),
      telemetry: createWorkerTelemetry(createRecordingTelemetry(), {
        readsQueueDepth: true,
      }),
    });
    expect(stats.succeeded).toBe(2);
    expect(stats.pollFailures).toBe(0);
    expect(events.filter((e) => e === "worker.poll_failed")).toHaveLength(2);
  });
});
