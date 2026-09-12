// §5 — connection pooling must not carry a tenant from one job to the next.
//
// Phase 1A proved this at the SQL level, with psql. That does NOT prove it for
// the application driver: `pg` keeps sockets in a pool and hands the same
// backend to unrelated transactions, which is exactly the condition under which
// a leaked session setting becomes a cross-tenant read.
//
// Every assertion below runs through the real `pg` Pool and the real adapter,
// with `max: 1`, so connection reuse is CERTAIN rather than likely — and
// `pg_backend_pid()` is asserted to be identical, so the test cannot pass by
// accidentally getting a fresh connection.
//
// The adapter deliberately does not `RESET ALL` between checkouts. If it did,
// this suite would pass without the transaction-local guarantee holding at all.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { createRegistry } from "./handlerRegistry.ts";
import { runOneJob } from "./runOneJob.ts";
import {
  cleanupFixtures,
  adminPool,
  enqueue,
  provisionWorkerRole,
  resetFixtures,
  TENANT_A,
  TENANT_B,
  workerDatabase,
} from "./testSupport/dbFixture.ts";

const KIND = "dbtest.noop";
const registry = createRegistry([
  { kind: KIND, capabilities: [], run: async () => "ok" },
]);

let admin: Pool;
let db: WorkerDatabase;

beforeAll(async () => {
  provisionWorkerRole();
  admin = adminPool();
  await resetFixtures(admin);
  // ONE connection. Everything below therefore runs on the same backend.
  db = workerDatabase(1);
}, 60_000);

afterAll(async () => {
  await db?.close();
  await cleanupFixtures(admin);
  await admin?.end();
});

describe("the worker's identity is the constrained one", () => {
  it("is not a superuser, carries no BYPASSRLS, and can assume ops_worker", async () => {
    const identity = await db.identity();
    expect(identity.user).toBe("ops_worker_login");
    expect(identity.isSuperuser).toBe(false);
    expect(identity.bypassesRls).toBe(false);
    expect(identity.isOpsWorkerMember).toBe(true);
  });

  it("holds nothing at all until it assumes the role", async () => {
    // NOINHERIT is what makes `set local role ops_worker` load-bearing. Without
    // it, deleting that statement from the runtime would change nothing.
    await expect(
      db.withTransaction(async (tx) =>
        tx.query("select count(*) from ops.jobs"),
      ),
    ).rejects.toThrow(/permission denied for schema ops/i);
  });
});

describe("tenant context does not survive the transaction that set it", () => {
  it("leaves no context behind on a reused connection, and it IS reused", async () => {
    const pids: number[] = [];
    const readPid = async () =>
      db.withTransaction(async (tx) => {
        const { rows } = await tx.query<{ pid: number }>(
          "select pg_backend_pid() as pid",
        );
        pids.push(Number(rows[0].pid));
      });

    await readPid();
    await enqueue(admin, TENANT_A, KIND);
    const first = await runOneJob(db, { workerId: "dbtest-pool", registry });
    expect(first.outcome).toBe("succeeded");
    expect(first.tenantId).toBe(TENANT_A);
    await readPid();

    // The whole point: same backend, before and after a completed job.
    expect(new Set(pids).size).toBe(1);

    // Now, on that same connection, with no lease claimed.
    const after = await db.withTransaction(async (tx) => {
      await tx.query("set local role ops_worker");
      const context = await tx.query<{
        job: string | null;
        worker: string | null;
        tenant: string | null;
      }>(
        `select nullif(current_setting('app.job_id', true), '')    as job,
                nullif(current_setting('app.worker_id', true), '') as worker,
                ops.current_tenant_id()::text                      as tenant`,
      );
      const jobs = await tx.query<{ n: string }>(
        "select count(*)::text as n from ops.jobs",
      );
      const tenants = await tx.query<{ n: string }>(
        "select count(*)::text as n from ops.tenants",
      );
      return {
        ...context.rows[0],
        jobs: jobs.rows[0].n,
        tenants: tenants.rows[0].n,
      };
    });

    expect(after.job).toBeNull();
    expect(after.worker).toBeNull();
    expect(after.tenant).toBeNull();
    // Fail closed: no context means NO rows, not all rows.
    expect(after.jobs).toBe("0");
    expect(after.tenants).toBe("0");
  }, 30_000);

  it("scopes consecutive jobs for different tenants to their own tenant", async () => {
    await resetFixtures(admin);
    const seen: { tenant: string; visible: string[] }[] = [];

    const registryThatLooks = createRegistry([
      {
        kind: KIND,
        capabilities: [],
        run: async (job) => {
          // A handler has no capability to read ops.jobs, so this uses the
          // outcome of the runtime instead; the visibility assertion below is
          // made from a transaction of its own.
          seen.push({ tenant: job.tenant_id, visible: [] });
          return "ok";
        },
      },
    ]);

    const jobA = await enqueue(
      admin,
      TENANT_A,
      KIND,
      {},
      { idempotencyKey: "pool-a" },
    );
    const a = await runOneJob(db, {
      workerId: "dbtest-pool",
      registry: registryThatLooks,
    });
    expect(a.outcome).toBe("succeeded");
    expect(a.jobId).toBe(jobA);
    expect(a.tenantId).toBe(TENANT_A);

    const jobB = await enqueue(
      admin,
      TENANT_B,
      KIND,
      {},
      { idempotencyKey: "pool-b" },
    );
    const b = await runOneJob(db, {
      workerId: "dbtest-pool",
      registry: registryThatLooks,
    });
    expect(b.outcome).toBe("succeeded");
    expect(b.jobId).toBe(jobB);
    expect(b.tenantId).toBe(TENANT_B);

    expect(seen.map((s) => s.tenant)).toEqual([TENANT_A, TENANT_B]);
  }, 30_000);

  it("shows a leased transaction exactly one tenant's rows", async () => {
    await resetFixtures(admin);
    await enqueue(
      admin,
      TENANT_B,
      "dbtest.other",
      {},
      { idempotencyKey: "vis-b" },
    );
    await enqueue(admin, TENANT_A, KIND, {}, { idempotencyKey: "vis-a" });

    // Lease whatever the queue hands over and, inside that same scoped
    // transaction, count what the worker can see. Both tenants have a queued
    // job; exactly one of them must be visible, and it must be the leased one.
    //
    // The leased tenant is READ BACK rather than assumed. An earlier version
    // asserted tenant A and failed against B — `ops.lease_job` orders by
    // priority, then available_at, then created_at, and B's job was enqueued
    // first. That failure was the test's assumption, not the isolation: the
    // transaction did see exactly one tenant. Pinning the queue's ordering here
    // would test the scheduler, which is a different property and has its own
    // suite.
    const leased = await db.withTransaction(async (tx) => {
      await tx.query("set local role ops_worker");
      const job = await tx.query<{ tenant_id: string }>(
        "select tenant_id::text from ops.lease_job($1, $2)",
        ["dbtest-pool", 60],
      );
      const { rows } = await tx.query<{ tenant_id: string; n: string }>(
        "select tenant_id::text, count(*)::text as n from ops.jobs group by tenant_id",
      );
      return { tenant: job.rows[0].tenant_id, visible: rows };
    });

    expect([TENANT_A, TENANT_B]).toContain(leased.tenant);
    expect(leased.visible).toHaveLength(1);
    expect(leased.visible[0].tenant_id).toBe(leased.tenant);
    expect(leased.visible[0].n).toBe("1");
  }, 30_000);
});

describe("the worker cannot reach the CRM directly", () => {
  it("is refused on public tables even while holding a live lease", async () => {
    // The capability is a SECURITY DEFINER function precisely so that the role
    // itself holds nothing here. A worker that could read public.contacts would
    // make the narrow capability pointless.
    await resetFixtures(admin);
    await enqueue(admin, TENANT_A, KIND, {}, { idempotencyKey: "direct" });

    const refusals = await db
      .withTransaction(async (tx) => {
        await tx.query("set local role ops_worker");
        await tx.query("select * from ops.lease_job($1, $2)", [
          "dbtest-pool",
          60,
        ]);
        const results: string[] = [];
        for (const statement of [
          "select count(*) from public.inbound_emails",
          "select count(*) from public.contacts",
          "delete from public.inbound_emails",
        ]) {
          try {
            await tx.query(statement);
            results.push("ALLOWED");
          } catch (error) {
            results.push((error as { code?: string }).code ?? "error");
          }
        }
        return results;
      })
      .catch((error) => {
        // A refusal aborts the transaction, so the loop above may not finish;
        // either way the assertion is that nothing was allowed.
        return [(error as { code?: string }).code ?? "error"];
      });

    expect(refusals).not.toContain("ALLOWED");
    expect(refusals[0]).toBe("42501");
  }, 30_000);
});
