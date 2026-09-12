// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { PermanentError, SecurityError } from "./failures.ts";
import {
  createRegistry,
  type AnyHandlerDefinition,
} from "./handlerRegistry.ts";
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
            return { rows: row ? [row] : [] } as never;
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
  run: AnyHandlerDefinition["run"],
  kind = "probe",
): AnyHandlerDefinition => ({ kind, capabilities: [], run });

const registryWith = (run: AnyHandlerDefinition["run"], kind = "probe") =>
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
