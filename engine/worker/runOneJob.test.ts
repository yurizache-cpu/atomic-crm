// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { runOneJob, type LeasedJob, type TxClient } from "./runOneJob";

// These tests use a fake TxClient rather than a database. What they pin is the
// ORDER and the REFUSALS — the things a driver would not catch and that a
// database test cannot see, because by the time SQL arrives the ordering
// decision has already been made.
//
// The isolation itself is proven against a live Postgres in
// supabase/tests/ops_execution_core.sql. This file proves the caller cannot
// arrange for that isolation to be bypassed.

interface Recorded {
  sql: string;
  params?: readonly unknown[];
}

const job: LeasedJob = {
  id: "11111111-1111-1111-1111-111111111111",
  tenant_id: "aaaaaaaa-0000-0000-0000-000000000001",
  kind: "probe",
  payload: { hello: "world" },
  attempts: 1,
  max_attempts: 5,
};

/** A TxClient that answers lease/context queries and records every statement. */
const fakeTx = (
  opts: {
    leased?: LeasedJob | null;
    contextTenant?: string | null;
  } = {},
) => {
  const calls: Recorded[] = [];
  const leased = opts.leased === undefined ? job : opts.leased;
  const contextTenant =
    opts.contextTenant === undefined
      ? (leased?.tenant_id ?? null)
      : opts.contextTenant;

  const tx: TxClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("ops.lease_job")) {
        return { rows: leased ? [leased] : [] } as never;
      }
      if (sql.includes("ops.current_tenant_id")) {
        return { rows: [{ tenant_id: contextTenant }] } as never;
      }
      return { rows: [] } as never;
    },
  };
  return { tx, calls };
};

const sqlOf = (calls: Recorded[]) => calls.map((c) => c.sql);

describe("runOneJob drops to the least-privileged identity first", () => {
  it("sets the worker role before anything else", async () => {
    const { tx, calls } = fakeTx();
    await runOneJob(tx, {
      workerId: "w1",
      handlers: { probe: async () => {} },
    });
    expect(calls[0].sql).toBe("set local role ops_worker");
  });

  it("refuses a blank worker id", async () => {
    const { tx, calls } = fakeTx();
    await expect(
      runOneJob(tx, { workerId: "  ", handlers: {} }),
    ).rejects.toThrow(/worker id/i);
    // Nothing was attempted: a lease with no owner cannot be bound to a tenant.
    expect(calls).toHaveLength(0);
  });
});

describe("the tenant comes from the lease, never from the payload", () => {
  it("reads the tenant back from the database and compares it to the lease", async () => {
    const { tx, calls } = fakeTx();
    await runOneJob(tx, {
      workerId: "w1",
      handlers: { probe: async () => {} },
    });
    const order = sqlOf(calls);
    expect(order[1]).toContain("ops.lease_job");
    expect(order[2]).toContain("ops.current_tenant_id");
    // The check happens BEFORE the handler can run.
    expect(
      order.findIndex((s) => s.includes("ops.current_tenant_id")),
    ).toBeLessThan(order.findIndex((s) => s.includes("ops.complete_job")));
  });

  it("refuses to run the handler when the session tenant disagrees with the lease", async () => {
    // The shape that matters: lease_job handed back tenant A, but the session
    // is scoped to something else. Running the handler here would execute A's
    // work against another tenant's rows.
    const handler = vi.fn(async () => {});
    const { tx } = fakeTx({
      contextTenant: "bbbbbbbb-0000-0000-0000-000000000002",
    });
    const result = await runOneJob(tx, {
      workerId: "w1",
      handlers: { probe: handler },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/tenant context mismatch/);
  });

  it("refuses when no tenant context was installed at all", async () => {
    const handler = vi.fn(async () => {});
    const { tx } = fakeTx({ contextTenant: null });
    const result = await runOneJob(tx, {
      workerId: "w1",
      handlers: { probe: handler },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(result.outcome).toBe("failed");
  });

  it("hands the handler the job and the same transaction, and no tenant argument", async () => {
    // The handler must not be able to pass a tenant anywhere: the tenant is
    // ambient, enforced by RLS. If it ever became a parameter, forgetting it
    // would silently widen access.
    const seen: unknown[] = [];
    const { tx } = fakeTx();
    await runOneJob(tx, {
      workerId: "w1",
      handlers: {
        probe: async (...args) => {
          seen.push(...args);
        },
      },
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ id: job.id, kind: "probe" });
    expect(seen[1]).toBe(tx);
  });
});

describe("settlement", () => {
  it("completes a job whose handler returned", async () => {
    const { tx, calls } = fakeTx();
    const result = await runOneJob(tx, {
      workerId: "w1",
      handlers: { probe: async () => {} },
    });
    expect(result.outcome).toBe("succeeded");
    expect(sqlOf(calls).some((s) => s.includes("ops.complete_job"))).toBe(true);
    expect(sqlOf(calls).some((s) => s.includes("ops.fail_job"))).toBe(false);
  });

  it("fails a job whose handler threw, and never completes it", async () => {
    const { tx, calls } = fakeTx();
    const result = await runOneJob(tx, {
      workerId: "w1",
      handlers: {
        probe: async () => {
          throw new Error("handler exploded");
        },
      },
    });
    expect(result.outcome).toBe("retry"); // attempts 1 of 5
    expect(result.error).toBe("handler exploded");
    expect(sqlOf(calls).some((s) => s.includes("ops.fail_job"))).toBe(true);
    expect(sqlOf(calls).some((s) => s.includes("ops.complete_job"))).toBe(
      false,
    );
  });

  it("reports a final failure once the attempts are spent", async () => {
    const { tx } = fakeTx({ leased: { ...job, attempts: 5, max_attempts: 5 } });
    const result = await runOneJob(tx, {
      workerId: "w1",
      handlers: {
        probe: async () => {
          throw new Error("still broken");
        },
      },
    });
    expect(result.outcome).toBe("failed");
  });

  it("records a job with no handler instead of dropping it", async () => {
    // Silently leaving it leased would strand it until the lease expired, and
    // silently completing it would lose the work with no trace. Neither is
    // acceptable; this is the same lesson as the Postmark ingestion.
    const { tx, calls } = fakeTx();
    const result = await runOneJob(tx, { workerId: "w1", handlers: {} });
    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/no handler/);
    const failCall = calls.find((c) => c.sql.includes("ops.fail_job"));
    expect(String(failCall?.params?.[1])).toMatch(/no handler registered/);
  });
});

describe("an empty queue is not an error", () => {
  it("reports idle and touches nothing else", async () => {
    const { tx, calls } = fakeTx({ leased: null });
    const result = await runOneJob(tx, { workerId: "w1", handlers: {} });
    expect(result.outcome).toBe("idle");
    expect(sqlOf(calls).some((s) => s.includes("ops.complete_job"))).toBe(
      false,
    );
    expect(sqlOf(calls).some((s) => s.includes("ops.fail_job"))).toBe(false);
  });
});
