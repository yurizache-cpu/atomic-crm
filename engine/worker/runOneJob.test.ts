// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import type { Capabilities } from "./capabilities.ts";
import { PermanentError, SecurityError } from "./failures.ts";
import {
  createRegistry,
  type AnyHandlerDefinition,
  type CallOutcome,
  type ExternalCallContext,
  type ExternalCallHandlerDefinition,
  type HandlerDefinition,
} from "./handlerRegistry.ts";
import type { WorkerLogEvent, WorkerLogFields } from "./log.ts";
import type { LeasedJob } from "./job.ts";
import { runOneJob } from "./runOneJob.ts";

// These tests use a fake database rather than a real one. What they pin is the
// ORDER, the TRANSACTION BOUNDARIES and the REFUSALS — things a driver would not
// catch and that a SQL test cannot see, because by the time SQL arrives the
// ordering decision has already been made.
//
// The isolation itself is proven against a live Postgres in
// engine/worker/workerRuntime.dbtest.ts. This file proves the caller cannot
// arrange for that isolation to be bypassed.

const JOB: LeasedJob = {
  id: "11111111-1111-1111-1111-111111111111",
  tenant_id: "aaaaaaaa-0000-0000-0000-000000000001",
  kind: "probe",
  payload: { hello: "world" },
  attempts: 1,
  max_attempts: 5,
};

interface Recorded {
  tx: number;
  sql: string;
  params?: readonly unknown[];
}

interface FakeOptions {
  leased?: LeasedJob | null;
  /** Rows ops.resume_lease returns, per call. Missing entries mean "the job". */
  resume?: (LeasedJob | null)[];
  contextTenant?: string | null;
  completeReturns?: boolean;
  settleReturns?: string;
  /** Throw from withTransaction on the Nth transaction (1-based). */
  failTransaction?: number;
  /**
   * What the prepare transaction's resume reports as lease_remaining_ms. A
   * string by default, because that is how `pg` returns a bigint; `null`
   * omits the column.
   */
  leaseRemainingMs?: string | number | null;
}

const fakeDb = (options: FakeOptions = {}) => {
  const calls: Recorded[] = [];
  /** Transactions that reached COMMIT, in order. */
  const committed: number[] = [];
  const rolledBack: number[] = [];
  let transaction = 0;
  let resumeCall = 0;

  const leased = options.leased === undefined ? JOB : options.leased;
  const contextTenant =
    options.contextTenant === undefined
      ? (leased?.tenant_id ?? null)
      : options.contextTenant;

  const db: WorkerDatabase = {
    async withTransaction(fn) {
      transaction += 1;
      const mine = transaction;
      if (options.failTransaction === mine) {
        rolledBack.push(mine);
        throw Object.assign(new Error("connection terminated"), {
          code: "08006",
        });
      }
      const tx: TxClient = {
        async query(sql, params) {
          calls.push({ tx: mine, sql, params });
          if (sql.includes("ops.lease_job")) {
            return { rows: leased ? [leased] : [] } as never;
          }
          if (sql.includes("ops.resume_lease")) {
            const configured = options.resume?.[resumeCall];
            resumeCall += 1;
            const row = configured === undefined ? leased : configured;
            if (!row) return { rows: [] } as never;
            const reportsRemaining =
              sql.includes("lease_remaining_ms") &&
              options.leaseRemainingMs !== null;
            return {
              rows: [
                reportsRemaining
                  ? {
                      ...row,
                      lease_remaining_ms: options.leaseRemainingMs ?? "30000",
                    }
                  : row,
              ],
            } as never;
          }
          if (sql.includes("ops.current_tenant_id")) {
            return { rows: [{ tenant_id: contextTenant }] } as never;
          }
          if (sql.includes("ops.complete_job")) {
            return {
              rows: [{ ok: options.completeReturns ?? true }],
            } as never;
          }
          if (sql.includes("ops.settle_job_failure")) {
            return {
              rows: [{ result: options.settleReturns ?? "retry" }],
            } as never;
          }
          return { rows: [] } as never;
        },
      };
      try {
        const result = await fn(tx);
        committed.push(mine);
        return result;
      } catch (error) {
        rolledBack.push(mine);
        throw error;
      }
    },
    async identity() {
      throw new Error("not used");
    },
    async close() {},
  };

  return {
    db,
    calls,
    committed,
    rolledBack,
    sqlIn: (n: number) => calls.filter((c) => c.tx === n).map((c) => c.sql),
  };
};

const handlerFor = (
  run: HandlerDefinition["run"],
  kind = "probe",
): AnyHandlerDefinition => ({ kind, capabilities: [], run });

const registryWith = (run: HandlerDefinition["run"], kind = "probe") =>
  createRegistry([handlerFor(run, kind)]);

const okRegistry = () => registryWith(async () => "done");

describe("the least-privileged identity is assumed in every transaction", () => {
  it("sets the worker role first, in each one", async () => {
    const { db, calls } = fakeDb();
    await runOneJob(db, { workerId: "w1", registry: okRegistry() });
    const firstOfEach = new Map<number, string>();
    for (const call of calls) {
      if (!firstOfEach.has(call.tx)) firstOfEach.set(call.tx, call.sql);
    }
    expect([...firstOfEach.values()]).toEqual([
      "set local role ops_worker",
      "set local role ops_worker",
    ]);
  });

  it("refuses a blank worker id and touches nothing", async () => {
    const { db, calls } = fakeDb();
    await expect(
      runOneJob(db, { workerId: "  ", registry: okRegistry() }),
    ).rejects.toThrow(/worker id/i);
    expect(calls).toHaveLength(0);
  });
});

describe("the lease is committed before the handler runs", () => {
  it("leases in its own transaction and executes in a second", async () => {
    const { db, committed, sqlIn } = fakeDb();
    await runOneJob(db, { workerId: "w1", registry: okRegistry() });

    // TX1 leases and nothing else touches the job.
    expect(sqlIn(1).some((s) => s.includes("ops.lease_job"))).toBe(true);
    expect(sqlIn(1).some((s) => s.includes("ops.complete_job"))).toBe(false);
    // TX1 committed BEFORE TX2 ran. This is what makes `attempts` survive a
    // crash, and therefore what makes max_attempts and the reaper mean anything.
    expect(committed[0]).toBe(1);
    expect(sqlIn(2).some((s) => s.includes("ops.resume_lease"))).toBe(true);
  });

  it("exposes the window between the two transactions", async () => {
    // The crash seam. A real worker dying here must leave a committed, stale
    // lease — proven against a live database in workerRuntime.dbtest.ts.
    const { db, committed } = fakeDb();
    const onLeased = vi.fn(async () => {});
    await runOneJob(db, {
      workerId: "w1",
      registry: okRegistry(),
      onLeased,
    });
    expect(onLeased).toHaveBeenCalledWith(
      expect.objectContaining({ id: JOB.id }),
    );
    expect(committed).toContain(1);
  });
});

describe("the tenant comes from the lease, never from the payload", () => {
  it("re-reads the tenant from the database before the handler runs", async () => {
    const { db, calls } = fakeDb();
    const order: string[] = [];
    await runOneJob(db, {
      workerId: "w1",
      registry: registryWith(async () => {
        order.push("handler");
        return "ok";
      }),
    });
    const tx2 = calls.filter((c) => c.tx === 2).map((c) => c.sql);
    const resumeAt = tx2.findIndex((s) => s.includes("ops.resume_lease"));
    const contextAt = tx2.findIndex((s) => s.includes("ops.current_tenant_id"));
    const completeAt = tx2.findIndex((s) => s.includes("ops.complete_job"));
    expect(resumeAt).toBeGreaterThanOrEqual(0);
    expect(contextAt).toBeGreaterThan(resumeAt);
    expect(completeAt).toBeGreaterThan(contextAt);
    expect(order).toEqual(["handler"]);
  });

  it("refuses to run the handler when the session tenant disagrees", async () => {
    const handler = vi.fn(async () => "ok");
    const { db } = fakeDb({
      contextTenant: "bbbbbbbb-0000-0000-0000-000000000002",
      settleReturns: "failed",
    });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: registryWith(handler),
    });
    expect(handler).not.toHaveBeenCalled();
    expect(result.outcome).toBe("failed");
    expect(result.failureClass).toBe("security");
    expect(result.detail).toMatch(/tenant context mismatch/);
  });

  it("refuses when no tenant context was installed at all", async () => {
    const handler = vi.fn(async () => "ok");
    const { db } = fakeDb({ contextTenant: null, settleReturns: "failed" });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: registryWith(handler),
    });
    expect(handler).not.toHaveBeenCalled();
    expect(result.failureClass).toBe("security");
  });

  it("refuses when the resumed row names a different tenant than the lease", async () => {
    // The shape that matters: TX1 leased tenant A's job, but TX2 resumed
    // something belonging to someone else. Running the handler here would
    // execute A's work against another tenant's rows.
    const handler = vi.fn(async () => "ok");
    const other = { ...JOB, tenant_id: "bbbbbbbb-0000-0000-0000-000000000002" };
    const { db } = fakeDb({
      resume: [other],
      contextTenant: other.tenant_id,
      settleReturns: "failed",
    });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: registryWith(handler),
    });
    expect(handler).not.toHaveBeenCalled();
    expect(result.failureClass).toBe("security");
  });

  it("refuses to execute at all when the lease cannot be resumed", async () => {
    // Between TX1 and TX2 the lease can be reaped, expire, or be taken. If it
    // is, another worker may already hold this job, so doing the work now would
    // double-apply it. Mutation-found: nothing exercised this path, and with
    // the guard removed the failure surfaced as an unrelated TypeError
    // classified `unknown` rather than as a refusal.
    const handler = vi.fn(async () => "ok");
    const { db } = fakeDb({ resume: [null, JOB], settleReturns: "retry" });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: registryWith(handler),
    });
    expect(handler).not.toHaveBeenCalled();
    expect(result.failureClass).toBe("security");
    expect(result.detail).toMatch(/lease could not be resumed/);
  });

  it("hands the handler the job and its capabilities, and no tenant argument", async () => {
    const seen: unknown[] = [];
    const { db } = fakeDb();
    await runOneJob(db, {
      workerId: "w1",
      registry: registryWith(async (...args) => {
        seen.push(...args);
        return "ok";
      }),
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ id: JOB.id, kind: "probe" });
    // Second argument is the capability bag: declared none, so it is empty.
    expect(Object.keys(seen[1] as object)).toEqual([]);
  });

  it("does not pass the payload anywhere near the tenant decision", async () => {
    // A payload that names another tenant changes nothing: it is never read by
    // the runtime, only handed to the handler as data.
    const hostile = {
      ...JOB,
      payload: { tenant_id: "bbbbbbbb-0000-0000-0000-000000000002" },
    };
    const { db, calls } = fakeDb({ leased: hostile, resume: [hostile] });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: okRegistry(),
    });
    expect(result.outcome).toBe("succeeded");
    expect(result.tenantId).toBe(JOB.tenant_id);
    const params = JSON.stringify(calls.map((c) => c.params));
    expect(params).not.toContain("bbbbbbbb-0000-0000-0000-000000000002");
  });
});

describe("unknown kinds fail closed and permanently", () => {
  it("records the job rather than dropping it", async () => {
    const { db, calls } = fakeDb({ settleReturns: "failed" });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: createRegistry([]),
      // fakeDb's settle answer says terminal; the class is what matters here.
    });
    expect(result.outcome).toBe("failed");
    expect(result.failureClass).toBe("permanent");
    expect(result.detail).toMatch(/no handler registered/);
    const settle = calls.find((c) => c.sql.includes("ops.settle_job_failure"));
    expect(settle?.params?.[1]).toBe("permanent");
  });

  it("never reaches complete_job", async () => {
    const { db, calls } = fakeDb({ settleReturns: "failed" });
    await runOneJob(db, { workerId: "w1", registry: createRegistry([]) });
    expect(calls.some((c) => c.sql.includes("ops.complete_job"))).toBe(false);
  });
});

describe("settlement", () => {
  it("completes a job whose handler returned, recording its detail", async () => {
    const { db, calls } = fakeDb();
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: registryWith(async () => "purged=3"),
    });
    expect(result.outcome).toBe("succeeded");
    expect(result.detail).toBe("purged=3");
    const complete = calls.find((c) => c.sql.includes("ops.complete_job"));
    expect(complete?.params).toEqual([JOB.id, "purged=3"]);
  });

  it("rolls the handler's work back when the lease expired mid-flight", async () => {
    // complete_job returning false means the lease is gone, so the job may
    // already be running elsewhere. Committing here would double-apply it.
    const { db, rolledBack } = fakeDb({
      completeReturns: false,
      settleReturns: "retry",
    });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: okRegistry(),
    });
    expect(rolledBack).toContain(2);
    expect(result.outcome).toBe("retry");
    expect(result.failureClass).toBe("security");
  });

  it("records a failure in a SEPARATE transaction from the rolled-back work", async () => {
    const { db, calls, rolledBack, committed } = fakeDb({
      settleReturns: "retry",
    });
    await runOneJob(db, {
      workerId: "w1",
      registry: registryWith(async () => {
        throw new Error("handler exploded");
      }),
    });
    // TX2 rolled back (the handler's partial writes are gone) and TX3 committed
    // the failure record. One transaction cannot do both.
    expect(rolledBack).toContain(2);
    expect(committed).toContain(3);
    const settle = calls.find((c) => c.sql.includes("ops.settle_job_failure"));
    expect(settle?.tx).toBe(3);
  });

  it("reports retry when the database says the job has attempts left", async () => {
    const { db } = fakeDb({ settleReturns: "retry" });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: registryWith(async () => {
        throw new Error("still broken");
      }),
    });
    expect(result.outcome).toBe("retry");
    expect(result.failureClass).toBe("unknown");
  });

  it("reports a terminal failure when the database says so", async () => {
    // The worker does NOT decide this. `attempts` lives in the database and the
    // worker cannot write it, so the retry/terminal decision is not the
    // worker's to make.
    const { db } = fakeDb({ settleReturns: "failed" });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: registryWith(async () => {
        throw new PermanentError("payload will never be valid");
      }),
    });
    expect(result.outcome).toBe("failed");
    expect(result.failureClass).toBe("permanent");
  });

  it("classifies a security refusal as security and does not retry-classify it", async () => {
    const { db, calls } = fakeDb({ settleReturns: "failed" });
    await runOneJob(db, {
      workerId: "w1",
      registry: registryWith(async () => {
        throw new SecurityError("capability refused");
      }),
    });
    const settle = calls.find((c) => c.sql.includes("ops.settle_job_failure"));
    expect(settle?.params?.[1]).toBe("security");
  });

  it("survives a settlement transaction that itself fails", async () => {
    // If TX3 cannot be written, nothing is lost: the lease expires and the
    // reaper settles the job. The worker must not loop trying.
    const { db } = fakeDb({ failTransaction: 3 });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: registryWith(async () => {
        throw new Error("boom");
      }),
    });
    expect(result.outcome).toBe("failed");
  });

  it("reports a refusal when the lease is gone before the failure is recorded", async () => {
    const { db } = fakeDb({
      resume: [JOB, null],
      settleReturns: "retry",
    });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: registryWith(async () => {
        throw new Error("boom");
      }),
    });
    expect(result.outcome).toBe("failed");
  });
});

describe("an empty queue is not an error", () => {
  it("reports idle and opens no second transaction", async () => {
    const { db, calls } = fakeDb({ leased: null });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: okRegistry(),
    });
    expect(result.outcome).toBe("idle");
    expect(calls.every((c) => c.tx === 1)).toBe(true);
    expect(calls.some((c) => c.sql.includes("ops.resume_lease"))).toBe(false);
  });
});

// --- The external_call shape -------------------------------------------------
//
// The fake numbers transactions the way the runtime opens them: 1 lease,
// 2 prepare (TX2a), 3 settle (TX2b), 4 failure (TX3) when there is one.

type ExternalOverrides = Partial<
  Omit<ExternalCallHandlerDefinition, "kind" | "shape">
>;

const externalHandler = (
  overrides: ExternalOverrides = {},
): ExternalCallHandlerDefinition => ({
  kind: "probe",
  shape: "external_call",
  prepareCapabilities: [],
  settleCapabilities: [],
  async prepare() {
    return { kind: "call", state: { step: "prepared" } };
  },
  async call() {
    return "called";
  },
  async settle(_state, outcome) {
    return outcome.ok ? "settled=ok" : "settled=error";
  },
  ...overrides,
});

const externalRegistry = (overrides: ExternalOverrides = {}) =>
  createRegistry([externalHandler(overrides)]);

/** Waits for the signal and rejects with its reason, as a well-behaved client does. */
const callUntilAborted = (context: ExternalCallContext) =>
  new Promise<never>((_, reject) => {
    context.signal.addEventListener(
      "abort",
      () => reject(context.signal.reason),
      { once: true },
    );
  });

const failedOutcome = (outcome: CallOutcome<unknown> | undefined) => {
  if (!outcome || outcome.ok) {
    throw new Error("expected settle to receive a failed call");
  }
  return outcome;
};

describe("an external call runs between two committed transactions, never inside one", () => {
  it("commits prepare without completing the job, calls with no transaction open, then settles and completes", async () => {
    const fake = fakeDb();
    const atCall: { committed: number[]; lastTx: number | undefined }[] = [];
    const result = await runOneJob(fake.db, {
      workerId: "w1",
      registry: externalRegistry({
        async call() {
          atCall.push({
            committed: [...fake.committed],
            lastTx: fake.calls.at(-1)?.tx,
          });
          return "called";
        },
      }),
    });

    expect(result).toMatchObject({
      outcome: "succeeded",
      detail: "settled=ok",
    });
    expect(fake.committed).toEqual([1, 2, 3]);
    // TX2a committed prepare's writes and did NOT complete the job: a crash
    // during the call must find the job still leased, not done.
    expect(fake.sqlIn(2).some((s) => s.includes("ops.complete_job"))).toBe(
      false,
    );
    // The call ran after that commit, and before TX2b issued a statement.
    expect(atCall).toEqual([{ committed: [1, 2], lastTx: 2 }]);
    // TX2b re-establishes the role, the lease and the tenant before completing.
    const tx3 = fake.sqlIn(3);
    const resumeAt = tx3.findIndex((s) => s.includes("ops.resume_lease"));
    const contextAt = tx3.findIndex((s) => s.includes("ops.current_tenant_id"));
    const completeAt = tx3.findIndex((s) => s.includes("ops.complete_job"));
    expect(tx3[0]).toBe("set local role ops_worker");
    expect(resumeAt).toBeGreaterThan(0);
    expect(contextAt).toBeGreaterThan(resumeAt);
    expect(completeAt).toBeGreaterThan(contextAt);
    const complete = fake.calls.find((c) => c.sql.includes("ops.complete_job"));
    expect(complete).toMatchObject({ tx: 3, params: [JOB.id, "settled=ok"] });
  });

  it("completes the job inside the prepare transaction when prepare settles, and never calls", async () => {
    const call = vi.fn(async () => "called");
    const settle = vi.fn(async () => "settled");
    const { db, calls, committed } = fakeDb();
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: externalRegistry({
        prepare: async () => ({ kind: "settled", detail: "nothing_to_call" }),
        call,
        settle,
      }),
    });
    expect(result).toMatchObject({
      outcome: "succeeded",
      detail: "nothing_to_call",
    });
    expect(committed).toEqual([1, 2]);
    expect(calls.every((c) => c.tx <= 2)).toBe(true);
    const complete = calls.find((c) => c.sql.includes("ops.complete_job"));
    expect(complete).toMatchObject({
      tx: 2,
      params: [JOB.id, "nothing_to_call"],
    });
    expect(call).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
});

describe("a failed call is an outcome to settle, never a failure to retry", () => {
  it("hands the error to settle and completes the job without recording a failure", async () => {
    const failure = new Error("provider unavailable");
    const outcomes: CallOutcome<unknown>[] = [];
    const { db, calls } = fakeDb({ settleReturns: "retry" });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: externalRegistry({
        call: async () => {
          throw failure;
        },
        settle: async (_state, outcome) => {
          outcomes.push(outcome);
          return "settled=error";
        },
      }),
    });
    expect(result).toMatchObject({
      outcome: "succeeded",
      detail: "settled=error",
    });
    expect(outcomes).toHaveLength(1);
    expect(failedOutcome(outcomes[0]).error).toBe(failure);
    // settle_job_failure is what can schedule a retry, and a retry of this job
    // would issue the call a second time.
    expect(calls.some((c) => c.sql.includes("ops.settle_job_failure"))).toBe(
      false,
    );
    expect(calls.find((c) => c.sql.includes("ops.complete_job"))?.tx).toBe(3);
  });

  it("records a settle that throws in its own failure transaction, and does not call again", async () => {
    const call = vi.fn(async () => "called");
    const { db, calls, rolledBack } = fakeDb({ settleReturns: "retry" });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: externalRegistry({
        call,
        settle: async () => {
          throw new Error("settle exploded");
        },
      }),
    });
    expect(rolledBack).toContain(3);
    expect(
      calls.find((c) => c.sql.includes("ops.settle_job_failure"))?.tx,
    ).toBe(4);
    expect(call).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: "retry", failureClass: "unknown" });
  });
});

describe("nothing is called unless prepare committed under a live lease that agrees on the tenant", () => {
  it("records a failure and never calls when prepare throws", async () => {
    const call = vi.fn(async () => "called");
    const settle = vi.fn(async () => "settled");
    const { db, calls, rolledBack } = fakeDb({ settleReturns: "retry" });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: externalRegistry({
        prepare: async () => {
          throw new Error("prepare exploded");
        },
        call,
        settle,
      }),
    });
    expect(rolledBack).toContain(2);
    expect(
      calls.find((c) => c.sql.includes("ops.settle_job_failure"))?.tx,
    ).toBe(3);
    expect(call).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(result.outcome).toBe("retry");
  });

  it("never prepares or calls when the lease cannot be resumed", async () => {
    const prepare = vi.fn(async () => ({ kind: "call" as const, state: {} }));
    const call = vi.fn(async () => "called");
    const { db } = fakeDb({ resume: [null, null], settleReturns: "failed" });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: externalRegistry({ prepare, call }),
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(result.failureClass).toBe("security");
    expect(result.detail).toMatch(/lease could not be resumed/);
  });

  it("never prepares or calls when the session tenant disagrees", async () => {
    const prepare = vi.fn(async () => ({ kind: "call" as const, state: {} }));
    const { db } = fakeDb({
      contextTenant: "bbbbbbbb-0000-0000-0000-000000000002",
      settleReturns: "failed",
    });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: externalRegistry({ prepare }),
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(result.failureClass).toBe("security");
    expect(result.detail).toMatch(/tenant context mismatch/);
  });

  it("fails permanently, before prepare, when the lease reports no remaining duration", async () => {
    // A call that cannot be bounded by the lease is not issued at all.
    const prepare = vi.fn(async () => ({ kind: "call" as const, state: {} }));
    const { db } = fakeDb({ leaseRemainingMs: null, settleReturns: "failed" });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: externalRegistry({ prepare }),
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(result.failureClass).toBe("permanent");
  });

  it("refuses a negative lease safety margin before touching the database", async () => {
    const { db, calls } = fakeDb();
    await expect(
      runOneJob(db, {
        workerId: "w1",
        registry: externalRegistry(),
        leaseSafetyMarginMs: -1,
      }),
    ).rejects.toThrow(/safety margin/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a fractional lease safety margin before touching the database", async () => {
    // Its deadline would become a fractional timer delay, which throws only
    // once prepare has committed, where nothing is left to settle the job.
    const { db, calls } = fakeDb();
    await expect(
      runOneJob(db, {
        workerId: "w1",
        registry: externalRegistry(),
        leaseSafetyMarginMs: 2_500.5,
      }),
    ).rejects.toThrow(/safety margin/);
    expect(calls).toHaveLength(0);
  });

  it("fails permanently, before prepare, when the lease reports a fractional remaining duration", async () => {
    const prepare = vi.fn(async () => ({ kind: "call" as const, state: {} }));
    const { db, committed } = fakeDb({
      leaseRemainingMs: "30000.5",
      settleReturns: "failed",
    });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: externalRegistry({ prepare }),
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(committed).not.toContain(2);
    expect(result.failureClass).toBe("permanent");
  });

  it("rolls prepare back and fails permanently when prepare returns neither settled nor call", async () => {
    // Committing here would leave a "running" record for a call nobody issues.
    const call = vi.fn(async () => "called");
    const { db, calls, committed, rolledBack } = fakeDb({
      settleReturns: "failed",
    });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: externalRegistry({
        prepare: async () => ({ kind: "later" }) as never,
        call,
      }),
    });
    expect(rolledBack).toContain(2);
    expect(committed).not.toContain(2);
    expect(call).not.toHaveBeenCalled();
    expect(result.failureClass).toBe("permanent");
    expect(
      calls.find((c) => c.sql.includes("ops.settle_job_failure"))?.tx,
    ).toBe(3);
  });

  it("rolls prepare back when the job it settled can no longer be completed under the lease", async () => {
    const call = vi.fn(async () => "called");
    const { db, rolledBack } = fakeDb({
      completeReturns: false,
      settleReturns: "failed",
    });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: externalRegistry({
        prepare: async () => ({ kind: "settled", detail: "nothing_to_call" }),
        call,
      }),
    });
    expect(rolledBack).toContain(2);
    expect(call).not.toHaveBeenCalled();
    expect(result.failureClass).toBe("security");
    expect(result.detail).toMatch(
      /lease expired before the job could be completed/,
    );
  });
});

describe("the settle transaction trusts nothing the call could have changed", () => {
  it("never settles when the lease was lost during the call", async () => {
    const call = vi.fn(async () => "called");
    const settle = vi.fn(async () => "settled");
    const { db } = fakeDb({
      resume: [JOB, null, null],
      settleReturns: "failed",
    });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: externalRegistry({ call, settle }),
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
    expect(result.failureClass).toBe("security");
    expect(result.detail).toMatch(/lease could not be resumed/);
  });

  it("never settles when the resumed lease names another tenant after the call", async () => {
    const settle = vi.fn(async () => "settled");
    const other = { ...JOB, tenant_id: "bbbbbbbb-0000-0000-0000-000000000002" };
    const { db } = fakeDb({ resume: [JOB, other], settleReturns: "failed" });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: externalRegistry({ settle }),
    });
    expect(settle).not.toHaveBeenCalled();
    expect(result.failureClass).toBe("security");
    expect(result.detail).toMatch(/tenant context mismatch/);
  });

  it("rolls settle back when the job can no longer be completed under the lease", async () => {
    const call = vi.fn(async () => "called");
    const { db, committed, rolledBack } = fakeDb({
      completeReturns: false,
      settleReturns: "failed",
    });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: externalRegistry({ call }),
    });
    expect(committed).toEqual([1, 2, 4]);
    expect(rolledBack).toContain(3);
    expect(call).toHaveBeenCalledTimes(1);
    expect(result.failureClass).toBe("security");
    expect(result.detail).toMatch(
      /lease expired before the job could be completed/,
    );
  });
});

describe("the call is given nothing that reaches the database", () => {
  it("receives the prepared state and a frozen context of a signal and a deadline, and nothing else", async () => {
    const received: unknown[][] = [];
    const { db } = fakeDb();
    await runOneJob(db, {
      workerId: "w1",
      registry: externalRegistry({
        call: async (...args: unknown[]) => {
          received.push(args);
          return "called";
        },
      }),
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(2);
    const [state, context] = received[0];
    expect(state).toEqual({ step: "prepared" });
    expect(Object.keys(context as object).sort()).toEqual([
      "deadline",
      "signal",
    ]);
    expect(Object.isFrozen(context)).toBe(true);
    expect((context as ExternalCallContext).signal).toBeInstanceOf(AbortSignal);
    expect(typeof (context as ExternalCallContext).deadline).toBe("number");
  });

  it("revokes prepare's capabilities when prepare returns, so one smuggled into state runs no SQL", async () => {
    type Smuggled = {
      readonly smuggled: Pick<Capabilities, "purgeInboundEmailLedger">;
    };
    const outcomes: CallOutcome<unknown>[] = [];
    const { db, calls } = fakeDb();
    await runOneJob(db, {
      workerId: "w1",
      registry: externalRegistry({
        prepareCapabilities: ["purgeInboundEmailLedger"],
        prepare: async (_job, capabilities) => ({
          kind: "call",
          state: { smuggled: capabilities },
        }),
        call: async (state) =>
          (state as Smuggled).smuggled.purgeInboundEmailLedger(),
        settle: async (_state, outcome) => {
          outcomes.push(outcome);
          return "settled";
        },
      }),
    });
    const { error } = failedOutcome(outcomes[0]);
    expect(error).toBeInstanceOf(SecurityError);
    expect(String(error)).toMatch(/after its transaction ended/);
    expect(
      calls.some((c) => c.sql.includes("purge_inbound_email_ledger")),
    ).toBe(false);
  });

  it("grants prepare only its own capabilities, and settle only its own", async () => {
    const seen: { phase: string; names: string[] }[] = [];
    const record = (phase: string, capabilities: object) =>
      seen.push({ phase, names: Object.keys(capabilities) });
    for (const [prepareCapabilities, settleCapabilities] of [
      [["purgeInboundEmailLedger"], []],
      [[], ["purgeInboundEmailLedger"]],
    ] as const) {
      const { db } = fakeDb();
      await runOneJob(db, {
        workerId: "w1",
        registry: externalRegistry({
          prepareCapabilities,
          settleCapabilities,
          prepare: async (_job, capabilities) => {
            record("prepare", capabilities);
            return { kind: "call", state: null };
          },
          settle: async (_state, _outcome, capabilities) => {
            record("settle", capabilities);
            return "settled";
          },
        }),
      });
    }
    expect(seen).toEqual([
      { phase: "prepare", names: ["purgeInboundEmailLedger"] },
      { phase: "settle", names: [] },
      { phase: "prepare", names: [] },
      { phase: "settle", names: ["purgeInboundEmailLedger"] },
    ]);
  });
});

describe("the call is bounded by the lease it runs under, and by shutdown", () => {
  it("sets the deadline to the lease's remaining time minus the safety margin", async () => {
    let deadline = Number.NaN;
    let budget = Number.NaN;
    const { db } = fakeDb({ leaseRemainingMs: "45000" });
    const before = Date.now();
    await runOneJob(db, {
      workerId: "w1",
      leaseSafetyMarginMs: 5_000,
      registry: externalRegistry({
        prepare: async (_job, _capabilities, given) => {
          budget = given.callBudgetMs;
          return { kind: "call", state: null };
        },
        call: async (_state, context) => {
          deadline = context.deadline;
          return "called";
        },
      }),
    });
    const after = Date.now();
    expect(deadline).toBeGreaterThanOrEqual(before + 40_000);
    expect(deadline).toBeLessThanOrEqual(after + 40_000);
    expect(budget).toBeLessThanOrEqual(40_000);
    expect(budget).toBeGreaterThanOrEqual(40_000 - (after - before));
  });

  it("holds back ten seconds of the lease by default", async () => {
    let deadline = Number.NaN;
    const { db } = fakeDb({ leaseRemainingMs: 30_000 });
    const before = Date.now();
    await runOneJob(db, {
      workerId: "w1",
      registry: externalRegistry({
        call: async (_state, context) => {
          deadline = context.deadline;
          return "called";
        },
      }),
    });
    const after = Date.now();
    expect(deadline).toBeGreaterThanOrEqual(before + 20_000);
    expect(deadline).toBeLessThanOrEqual(after + 20_000);
  });

  it("gives prepare a zero budget, never a negative one, when the lease is shorter than the margin", async () => {
    let budget = Number.NaN;
    const { db } = fakeDb({ leaseRemainingMs: "3000" });
    await runOneJob(db, {
      workerId: "w1",
      registry: externalRegistry({
        prepare: async (_job, _capabilities, given) => {
          budget = given.callBudgetMs;
          return { kind: "settled", detail: "no_budget" };
        },
      }),
    });
    expect(budget).toBe(0);
  });

  it("gives prepare a remaining time that is measured when asked, not when prepare began", async () => {
    let snapshot = Number.NaN;
    let atStart = Number.NaN;
    let later = Number.NaN;
    const { db } = fakeDb({ leaseRemainingMs: "45000" });
    await runOneJob(db, {
      workerId: "w1",
      leaseSafetyMarginMs: 5_000,
      registry: externalRegistry({
        prepare: async (_job, _capabilities, given) => {
          snapshot = given.callBudgetMs;
          atStart = given.remainingMs();
          await new Promise((resolve) => setTimeout(resolve, 40));
          later = given.remainingMs();
          return { kind: "settled", detail: "measured" };
        },
      }),
    });
    expect(atStart).toBeLessThanOrEqual(snapshot);
    expect(later).toBeLessThan(atStart);
    expect(later).toBeGreaterThan(0);
  });

  it("starts no call when the deadline passed before the call could start, and settles a timeout", async () => {
    // A 0 ms AbortSignal.timeout fires only on a later tick, after a request
    // could already be on the wire, so a deadline in the past must not reach call.
    const call = vi.fn(async () => "called");
    const outcomes: CallOutcome<unknown>[] = [];
    const { db } = fakeDb({ leaseRemainingMs: "3000" });
    const result = await runOneJob(db, {
      workerId: "w1",
      registry: externalRegistry({
        call,
        settle: async (_state, outcome) => {
          outcomes.push(outcome);
          return "settled=late";
        },
      }),
    });
    expect(call).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "succeeded",
      detail: "settled=late",
    });
    expect((failedOutcome(outcomes[0]).error as DOMException).name).toBe(
      "TimeoutError",
    );
  });

  it("does not abort a call at once when the lease outlasts the longest timer Node honours", async () => {
    // ops.lease_job puts no ceiling on a lease. At 40 days the delay overflows
    // a 32-bit timer, which Node fires after 1 ms; at 60 days
    // AbortSignal.timeout throws after prepare has committed.
    const DAY_MS = 86_400_000;
    for (const days of [40, 60]) {
      const outcomes: CallOutcome<unknown>[] = [];
      const { db } = fakeDb({ leaseRemainingMs: String(days * DAY_MS) });
      const result = await runOneJob(db, {
        workerId: "w1",
        registry: externalRegistry({
          call: async (_state, context) => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return context.signal.aborted;
          },
          settle: async (_state, outcome) => {
            outcomes.push(outcome);
            return "settled";
          },
        }),
      });
      expect(result.outcome).toBe("succeeded");
      expect(outcomes).toEqual([
        { ok: true, value: false, durationMs: expect.any(Number) },
      ]);
    }
  });

  it("aborts the call when the worker shuts down", async () => {
    const controller = new AbortController();
    const outcomes: CallOutcome<unknown>[] = [];
    const { db } = fakeDb();
    const result = await runOneJob(db, {
      workerId: "w1",
      signal: controller.signal,
      registry: externalRegistry({
        call: (_state, context) => {
          setTimeout(() => controller.abort(), 5);
          return callUntilAborted(context);
        },
        settle: async (_state, outcome) => {
          outcomes.push(outcome);
          return "settled=cancelled";
        },
      }),
    });
    expect(result.outcome).toBe("succeeded");
    expect((failedOutcome(outcomes[0]).error as DOMException).name).toBe(
      "AbortError",
    );
  });

  it("aborts a call that outlives its deadline", async () => {
    const outcomes: CallOutcome<unknown>[] = [];
    const { db } = fakeDb({ leaseRemainingMs: "60" });
    await runOneJob(db, {
      workerId: "w1",
      leaseSafetyMarginMs: 10,
      registry: externalRegistry({
        call: (_state, context) => callUntilAborted(context),
        settle: async (_state, outcome) => {
          outcomes.push(outcome);
          return "settled=timeout";
        },
      }),
    });
    expect((failedOutcome(outcomes[0]).error as DOMException).name).toBe(
      "TimeoutError",
    );
  });

  it("abandons a call that ignores its abort, and still settles", async () => {
    // Without this, one handler that ignores its signal wedges the loop, and
    // every job behind it waits on a call nobody will ever record.
    const outcomes: CallOutcome<unknown>[] = [];
    const { db, calls } = fakeDb({ leaseRemainingMs: "30" });
    const result = await runOneJob(db, {
      workerId: "w1",
      leaseSafetyMarginMs: 10,
      registry: externalRegistry({
        call: () => new Promise<never>(() => {}),
        settle: async (_state, outcome) => {
          outcomes.push(outcome);
          return "settled=abandoned";
        },
      }),
    });
    expect(result).toMatchObject({
      outcome: "succeeded",
      detail: "settled=abandoned",
    });
    expect((failedOutcome(outcomes[0]).error as DOMException).name).toBe(
      "TimeoutError",
    );
    expect(calls.find((c) => c.sql.includes("ops.complete_job"))?.tx).toBe(3);
  });
});

describe("the window between the call and settle is a crash seam, and only that", () => {
  it("runs onCallFinished after the call and before the settle transaction opens", async () => {
    const order: string[] = [];
    const fake = fakeDb();
    const onCallFinished = vi.fn(async () => {
      order.push(`seam committed=${fake.committed.join(",")}`);
    });
    await runOneJob(fake.db, {
      workerId: "w1",
      onCallFinished,
      registry: externalRegistry({
        call: async () => {
          order.push("call");
          return "called";
        },
        settle: async () => {
          order.push("settle");
          return "settled";
        },
      }),
    });
    expect(order).toEqual(["call", "seam committed=1,2", "settle"]);
    expect(onCallFinished).toHaveBeenCalledWith(
      expect.objectContaining({ id: JOB.id }),
    );
  });

  it("settles nothing and records no failure when the process dies there", async () => {
    // The state the handler's own durable record has to recover from: prepare
    // committed, the call was issued, and neither settle nor TX3 ever ran.
    const settle = vi.fn(async () => "settled");
    const { db, calls, committed } = fakeDb();
    await expect(
      runOneJob(db, {
        workerId: "w1",
        onCallFinished: async () => {
          throw new Error("process killed");
        },
        registry: externalRegistry({ settle }),
      }),
    ).rejects.toThrow(/process killed/);
    expect(settle).not.toHaveBeenCalled();
    expect(committed).toEqual([1, 2]);
    expect(calls.some((c) => c.tx > 2)).toBe(false);
  });
});

describe("the call is logged without its error", () => {
  it("logs the call's start and finish, and the finish says only that it failed", async () => {
    const lines: { event: WorkerLogEvent; fields?: WorkerLogFields }[] = [];
    const { db } = fakeDb();
    await runOneJob(db, {
      workerId: "w1",
      log: (event, fields) => lines.push({ event, fields }),
      registry: externalRegistry({
        call: async () => {
          throw new Error("upstream echoed: sentinel-prompt-text");
        },
      }),
    });
    const events = lines.map((line) => line.event);
    const startedAt = events.indexOf("job.external_call_started");
    const finishedAt = events.indexOf("job.external_call_finished");
    expect(startedAt).toBeGreaterThan(events.indexOf("job.attempt_started"));
    expect(finishedAt).toBeGreaterThan(startedAt);
    expect(lines[finishedAt].fields?.detail).toBe("error");
    expect(JSON.stringify(lines)).not.toContain("sentinel-prompt-text");
  });
});
