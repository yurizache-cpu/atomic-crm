// The runtime against a real database: the first handler, the failure model,
// retry, crash recovery, idempotency, and the adversarial cases from §21.
//
// Everything here runs through the real `pg` adapter as the real constrained
// role. Nothing connects as postgres except the fixture helpers, which only
// build state and read results back.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { postmarkLedgerRetention } from "../handlers/postmarkLedgerRetention.ts";
import { createRegistry } from "./handlerRegistry.ts";
import { PermanentError, TransientError } from "./failures.ts";
import { runOneJob } from "./runOneJob.ts";
import {
  adminPool,
  clearLedger,
  countLedger,
  enqueue,
  provisionWorkerRole,
  readJob,
  resetFixtures,
  seedLedger,
  TENANT_A,
  TENANT_B,
  workerDatabase,
} from "./testSupport/dbFixture.ts";

const RETENTION = postmarkLedgerRetention.kind;
const WORKER = "dbtest-runtime";

let admin: Pool;
let db: WorkerDatabase;

const registry = createRegistry([postmarkLedgerRetention]);

beforeAll(async () => {
  provisionWorkerRole();
  admin = adminPool();
  db = workerDatabase(2);
}, 60_000);

afterAll(async () => {
  await db?.close();
  await clearLedger(admin);
  await admin?.end();
});

beforeEach(async () => {
  await resetFixtures(admin);
  await clearLedger(admin);
});

// ---------------------------------------------------------------------------
// The first handler
// ---------------------------------------------------------------------------

describe("postmark.ledger_retention", () => {
  it("removes resolved rows past the window and leaves unresolved ones", async () => {
    await seedLedger(admin, [
      { ageDays: 200, status: "ingested", messageId: "dbtest-old-ingested" },
      {
        ageDays: 200,
        status: "failed_permanent",
        messageId: "dbtest-old-perm",
      },
      // Unresolved rows are the reason the ledger exists. Age must not reach them.
      {
        ageDays: 200,
        status: "failed_transient",
        messageId: "dbtest-old-transient",
      },
      { ageDays: 200, status: "pending", messageId: "dbtest-old-pending" },
      // Inside the window.
      { ageDays: 10, status: "ingested", messageId: "dbtest-new-ingested" },
    ]);
    expect(await countLedger(admin)).toBe(5);

    const jobId = await enqueue(admin, TENANT_A, RETENTION, {});
    const result = await runOneJob(db, { workerId: WORKER, registry });

    expect(result.outcome).toBe("succeeded");
    expect(result.detail).toBe("purged=2 retention_days=90 limit=5000");
    expect(await countLedger(admin)).toBe(3);

    const { rows } = await admin.query<{ message_id: string }>(
      "select message_id from public.inbound_emails where message_id like 'dbtest-%' order by message_id",
    );
    expect(rows.map((r) => r.message_id)).toEqual([
      "dbtest-new-ingested",
      "dbtest-old-pending",
      "dbtest-old-transient",
    ]);

    const job = await readJob(admin, jobId);
    expect(job.status).toBe("succeeded");
    // The detail is on the lifecycle trail, not only in a log line.
    const events = await admin.query<{ detail: string }>(
      "select detail from ops.job_events where job_id = $1 and event = 'succeeded'",
      [jobId],
    );
    expect(events.rows[0].detail).toContain("purged=2");
  }, 30_000);

  it("is idempotent: a second run purges nothing", async () => {
    await seedLedger(admin, [
      { ageDays: 200, status: "ingested", messageId: "dbtest-a" },
      { ageDays: 200, status: "ingested", messageId: "dbtest-b" },
    ]);

    await enqueue(admin, TENANT_A, RETENTION, {}, { idempotencyKey: "run-1" });
    const first = await runOneJob(db, { workerId: WORKER, registry });
    expect(first.detail).toContain("purged=2");

    await enqueue(admin, TENANT_A, RETENTION, {}, { idempotencyKey: "run-2" });
    const second = await runOneJob(db, { workerId: WORKER, registry });
    expect(second.outcome).toBe("succeeded");
    expect(second.detail).toContain("purged=0");
    expect(await countLedger(admin)).toBe(0);
  }, 30_000);

  it("deduplicates the same logical run through the idempotency key", async () => {
    // "the same underlying external identity twice" — enqueueing the same daily
    // retention run twice must not produce two jobs.
    const first = await enqueue(
      admin,
      TENANT_A,
      RETENTION,
      {},
      {
        idempotencyKey: "retention-2026-09-12",
      },
    );
    const second = await enqueue(
      admin,
      TENANT_A,
      RETENTION,
      {},
      {
        idempotencyKey: "retention-2026-09-12",
      },
    );
    expect(second).toBe(first);

    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from ops.jobs where tenant_id = $1",
      [TENANT_A],
    );
    expect(rows[0].n).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// §21 — adversarial cases. All must fail closed.
// ---------------------------------------------------------------------------

describe("the payload cannot choose a tenant", () => {
  it("ignores a tenant id in the payload entirely", async () => {
    await seedLedger(admin, [
      { ageDays: 200, status: "ingested", messageId: "dbtest-x" },
    ]);
    // Tenant B's job, carrying tenant A's id in its payload. B may not touch
    // public.*, and the payload must not change that.
    await enqueue(admin, TENANT_B, RETENTION, { tenant_id: TENANT_A });
    const result = await runOneJob(db, { workerId: WORKER, registry });

    expect(result.tenantId).toBe(TENANT_B);
    expect(result.outcome).not.toBe("succeeded");
    expect(result.failureClass).toBe("security");
    expect(result.detail).toMatch(/does not own this deployment CRM/);
    // Nothing was deleted.
    expect(await countLedger(admin)).toBe(1);
  }, 30_000);

  it("floors a retention window the payload tried to shorten", async () => {
    // The layered defence: the handler passes 1 through deliberately, and the
    // DATABASE refuses to purge anything younger than 30 days.
    await seedLedger(admin, [
      { ageDays: 5, status: "ingested", messageId: "dbtest-recent" },
      { ageDays: 45, status: "ingested", messageId: "dbtest-older" },
    ]);
    await enqueue(admin, TENANT_A, RETENTION, { retention_days: 1 });
    const result = await runOneJob(db, { workerId: WORKER, registry });

    expect(result.outcome).toBe("succeeded");
    expect(result.detail).toBe("purged=1 retention_days=1 limit=5000");
    const { rows } = await admin.query<{ message_id: string }>(
      "select message_id from public.inbound_emails where message_id like 'dbtest-%'",
    );
    expect(rows.map((r) => r.message_id)).toEqual(["dbtest-recent"]);
  }, 30_000);

  it("rejects a malformed payload permanently, without retrying", async () => {
    const jobId = await enqueue(admin, TENANT_A, RETENTION, {
      retention_days: -1,
    });
    const result = await runOneJob(db, { workerId: WORKER, registry });

    expect(result.outcome).toBe("failed");
    expect(result.failureClass).toBe("permanent");
    const job = await readJob(admin, jobId);
    expect(job.status).toBe("failed");
    expect(job.last_error_class).toBe("permanent");
    // Terminal on the FIRST attempt, though max_attempts is 5.
    expect(job.attempts).toBe(1);
    expect(job.max_attempts).toBe(5);
  }, 30_000);
});

describe("unknown job types fail closed", () => {
  it("records a permanent failure instead of running anything", async () => {
    const jobId = await enqueue(admin, TENANT_A, "attacker.arbitrary_code");
    const result = await runOneJob(db, { workerId: WORKER, registry });
    expect(result.outcome).toBe("failed");
    expect(result.failureClass).toBe("permanent");
    const job = await readJob(admin, jobId);
    expect(job.status).toBe("failed");
    expect(job.last_error).toMatch(/no handler registered/);
  }, 30_000);

  it("does the same for a kind that names an object prototype member", async () => {
    const jobId = await enqueue(admin, TENANT_A, "toString");
    const result = await runOneJob(db, { workerId: WORKER, registry });
    expect(result.outcome).toBe("failed");
    expect((await readJob(admin, jobId)).last_error).toMatch(/no handler/);
  }, 30_000);
});

describe("leases cannot be forged, stolen or outlived", () => {
  it("refuses to resume another worker's lease", async () => {
    await enqueue(admin, TENANT_A, RETENTION);
    // Worker one takes it.
    await db.withTransaction(async (tx) => {
      await tx.query("set local role ops_worker");
      await tx.query("select * from ops.lease_job($1, $2)", [
        "worker-one",
        300,
      ]);
    });

    const stolen = await db.withTransaction(async (tx) => {
      await tx.query("set local role ops_worker");
      const { rows } = await admin.query<{ id: string }>(
        "select id from ops.jobs where tenant_id = $1",
        [TENANT_A],
      );
      const { rows: resumed } = await tx.query<{ id: string | null }>(
        "select id from ops.resume_lease($1, $2)",
        ["worker-two", rows[0].id],
      );
      const tenant = await tx.query<{ t: string | null }>(
        "select ops.current_tenant_id()::text as t",
      );
      return { id: resumed[0]?.id ?? null, tenant: tenant.rows[0].t };
    });

    expect(stolen.id).toBeNull();
    expect(stolen.tenant).toBeNull();
  }, 30_000);

  it("refuses a forged job id", async () => {
    const forged = await db.withTransaction(async (tx) => {
      await tx.query("set local role ops_worker");
      const { rows } = await tx.query<{ id: string | null }>(
        "select id from ops.resume_lease($1, $2)",
        [WORKER, "00000000-0000-4000-8000-000000000000"],
      );
      return rows[0]?.id ?? null;
    });
    expect(forged).toBeNull();
  }, 30_000);

  it("refuses an expired lease, and the capability with it", async () => {
    await seedLedger(admin, [
      { ageDays: 200, status: "ingested", messageId: "dbtest-expire" },
    ]);
    const jobId = await enqueue(admin, TENANT_A, RETENTION);

    const outcome = await db
      .withTransaction(async (tx) => {
        await tx.query("set local role ops_worker");
        await tx.query("select * from ops.lease_job($1, $2)", [WORKER, 60]);
        // Expire it out from under the transaction.
        await admin.query(
          "update ops.jobs set lease_expires_at = now() - interval '1 second' where id = $1",
          [jobId],
        );
        try {
          await tx.query("select ops.purge_inbound_email_ledger(90, 100)");
          return "ALLOWED";
        } catch (error) {
          return (error as { code?: string }).code ?? "error";
        }
      })
      .catch((error) => (error as { code?: string }).code ?? "error");

    expect(outcome).toBe("42501");
    expect(await countLedger(admin)).toBe(1);
  }, 30_000);

  it("refuses the capability with no lease at all", async () => {
    const outcome = await db
      .withTransaction(async (tx) => {
        await tx.query("set local role ops_worker");
        await tx.query("select ops.purge_inbound_email_ledger(90, 100)");
        return "ALLOWED";
      })
      .catch((error) => (error as { code?: string }).code ?? "error");
    expect(outcome).toBe("42501");
  }, 30_000);

  it("cannot settle a job it does not hold", async () => {
    const jobId = await enqueue(admin, TENANT_A, RETENTION);
    await db.withTransaction(async (tx) => {
      await tx.query("set local role ops_worker");
      await tx.query("select * from ops.lease_job($1, $2)", ["owner", 300]);
    });

    const refused = await db.withTransaction(async (tx) => {
      await tx.query("set local role ops_worker");
      await tx.query("select set_config('app.worker_id', 'thief', true)");
      const complete = await tx.query<{ ok: boolean }>(
        "select ops.complete_job($1) as ok",
        [jobId],
      );
      const settle = await tx.query<{ r: string }>(
        "select ops.settle_job_failure($1, 'permanent', 'nope') as r",
        [jobId],
      );
      return { complete: complete.rows[0].ok, settle: settle.rows[0].r };
    });

    expect(refused.complete).toBe(false);
    expect(refused.settle).toBe("refused");
    expect((await readJob(admin, jobId)).status).toBe("leased");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// §18 — crash behaviour, and §10 — retry policy
// ---------------------------------------------------------------------------

describe("a worker that dies leaves recoverable state", () => {
  it("leaves a committed, stale lease when it dies right after leasing", async () => {
    // This is the property the single-transaction Phase 1A shape did NOT have:
    // there, the lease rolled back and `attempts` returned to 0.
    const jobId = await enqueue(admin, TENANT_A, RETENTION);

    await expect(
      runOneJob(db, {
        workerId: WORKER,
        registry,
        onLeased: async () => {
          throw new Error("process died");
        },
      }),
    ).rejects.toThrow(/process died/);

    const job = await readJob(admin, jobId);
    expect(job.status).toBe("leased");
    expect(job.attempts).toBe(1);
    expect(job.lease_owner).toBe(WORKER);
  }, 30_000);

  it("recovers that lease once it expires, without any new work arriving", async () => {
    const jobId = await enqueue(admin, TENANT_A, RETENTION);
    await expect(
      runOneJob(db, {
        workerId: WORKER,
        registry,
        leaseSeconds: 1,
        onLeased: async () => {
          throw new Error("process died");
        },
      }),
    ).rejects.toThrow();

    await admin.query(
      "update ops.jobs set lease_expires_at = now() - interval '1 second' where id = $1",
      [jobId],
    );

    const reaped = await db.withTransaction(async (tx) => {
      await tx.query("set local role ops_worker");
      const { rows } = await tx.query<{ n: number }>(
        "select ops.reap_expired_leases() as n",
      );
      return Number(rows[0].n);
    });

    expect(reaped).toBe(1);
    const job = await readJob(admin, jobId);
    expect(job.status).toBe("queued");
    // The attempt is NOT forgiven. This is what bounds a poison pill.
    expect(job.attempts).toBe(1);
    expect(job.last_error).toMatch(/lease expired/);
  }, 30_000);

  it("bounds a job that crashes the worker every time", async () => {
    const jobId = await enqueue(
      admin,
      TENANT_A,
      RETENTION,
      {},
      {
        maxAttempts: 3,
      },
    );

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(
        runOneJob(db, {
          workerId: WORKER,
          registry,
          onLeased: async () => {
            throw new Error("process died");
          },
        }),
      ).rejects.toThrow();
      await admin.query(
        "update ops.jobs set lease_expires_at = now() - interval '1 second' where id = $1",
        [jobId],
      );
      await db.withTransaction(async (tx) => {
        await tx.query("set local role ops_worker");
        await tx.query("select ops.reap_expired_leases()");
      });
    }

    const job = await readJob(admin, jobId);
    expect(job.attempts).toBe(3);
    expect(job.status).toBe("failed");
  }, 60_000);

  it("rolls the handler's writes back when the transaction dies mid-flight", async () => {
    await seedLedger(admin, [
      { ageDays: 200, status: "ingested", messageId: "dbtest-rollback" },
    ]);
    const jobId = await enqueue(admin, TENANT_A, RETENTION);

    const crashRegistry = createRegistry([
      {
        kind: RETENTION,
        capabilities: ["purgeInboundEmailLedger"],
        run: async (_job, capabilities) => {
          await capabilities.purgeInboundEmailLedger({ retentionDays: 90 });
          // The side effect has happened inside the transaction; now die.
          throw new TransientError("died after the side effect");
        },
      },
    ]);

    const result = await runOneJob(db, {
      workerId: WORKER,
      registry: crashRegistry,
    });

    expect(result.outcome).toBe("retry");
    // The delete was rolled back with the rest of the transaction.
    expect(await countLedger(admin)).toBe(1);
    const job = await readJob(admin, jobId);
    expect(job.status).toBe("queued");
    expect(job.last_error_class).toBe("transient");
  }, 30_000);
});

describe("retry is bounded and backs off", () => {
  it("schedules the next attempt further out each time", async () => {
    const jobId = await enqueue(
      admin,
      TENANT_A,
      RETENTION,
      {},
      {
        maxAttempts: 4,
      },
    );
    const failing = createRegistry([
      {
        kind: RETENTION,
        capabilities: [],
        run: async () => {
          throw new TransientError("dependency down");
        },
      },
    ]);

    const delays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // Make it available again so the next lease can pick it up.
      await admin.query(
        "update ops.jobs set available_at = now() where id = $1",
        [jobId],
      );
      const result = await runOneJob(db, {
        workerId: WORKER,
        registry: failing,
      });
      expect(result.outcome).toBe("retry");
      const { rows } = await admin.query<{ secs: string }>(
        "select extract(epoch from (available_at - now()))::text as secs from ops.jobs where id = $1",
        [jobId],
      );
      delays.push(Number(rows[0].secs));
    }

    expect(delays[0]).toBeLessThan(delays[1]);
    expect(delays[1]).toBeLessThan(delays[2]);
    // Bounded: the ladder is capped at an hour.
    expect(delays[2]).toBeLessThanOrEqual(3600);
  }, 60_000);

  it("stops retrying at max_attempts and keeps the job visible", async () => {
    const jobId = await enqueue(
      admin,
      TENANT_A,
      RETENTION,
      {},
      {
        maxAttempts: 2,
      },
    );
    const failing = createRegistry([
      {
        kind: RETENTION,
        capabilities: [],
        run: async () => {
          throw new TransientError("still down");
        },
      },
    ]);

    await admin.query(
      "update ops.jobs set available_at = now() where id = $1",
      [jobId],
    );
    expect(
      (await runOneJob(db, { workerId: WORKER, registry: failing })).outcome,
    ).toBe("retry");
    await admin.query(
      "update ops.jobs set available_at = now() where id = $1",
      [jobId],
    );
    expect(
      (await runOneJob(db, { workerId: WORKER, registry: failing })).outcome,
    ).toBe("failed");

    const job = await readJob(admin, jobId);
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(2);
    // Never silently deleted: everything a human needs is still on the row.
    expect(job.last_error).toContain("still down");
    expect(job.last_error_class).toBe("transient");

    const events = await admin.query<{ event: string }>(
      "select event from ops.job_events where job_id = $1 order by id",
      [jobId],
    );
    expect(events.rows.map((r) => r.event)).toEqual([
      "enqueued",
      "leased",
      "retry",
      "leased",
      "failed",
    ]);
  }, 60_000);

  it("does not retry a permanent failure even with attempts remaining", async () => {
    const jobId = await enqueue(
      admin,
      TENANT_A,
      RETENTION,
      {},
      {
        maxAttempts: 9,
      },
    );
    const failing = createRegistry([
      {
        kind: RETENTION,
        capabilities: [],
        run: async () => {
          throw new PermanentError("this will never work");
        },
      },
    ]);
    const result = await runOneJob(db, { workerId: WORKER, registry: failing });
    expect(result.outcome).toBe("failed");
    const job = await readJob(admin, jobId);
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// §16 — metrics
// ---------------------------------------------------------------------------

describe("queue metrics", () => {
  it("are scoped to the reading tenant, not the whole fleet", async () => {
    await enqueue(admin, TENANT_A, RETENTION, {}, { idempotencyKey: "m-a" });
    await enqueue(admin, TENANT_B, RETENTION, {}, { idempotencyKey: "m-b" });

    const rows = await db.withTransaction(async (tx) => {
      await tx.query("set local role ops_worker");
      await tx.query("select * from ops.lease_job($1, $2)", [WORKER, 300]);
      const { rows } = await tx.query<{ tenant_id: string; running: string }>(
        "select tenant_id::text, running::text from ops.queue_metrics",
      );
      return rows;
    });

    // security_invoker means RLS applies: exactly the leased tenant's row.
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(TENANT_A);
    expect(rows[0].running).toBe("1");
  }, 30_000);
});
