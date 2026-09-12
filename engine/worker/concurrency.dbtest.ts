// §19 — real worker PROCESSES, not probes and not in-process instances.
//
// Phase 1A proved leasing under concurrency with simultaneous psql connections.
// That does not prove the runtime: `FOR UPDATE SKIP LOCKED` could be perfect and
// the worker could still double-execute, because execution happens in a SECOND
// transaction that Phase 1A's SQL probes never modelled.
//
// So this spawns actual `node` processes running the actual loop, lets them race
// over a shared queue, and asserts on what each one reports it EXECUTED — not on
// the end state of the table, which cannot tell a job that ran once from a job
// that ran twice and was settled once.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  cleanupFixtures,
  adminPool,
  enqueue,
  provisionWorkerRole,
  resetFixtures,
  TENANT_A,
  TENANT_B,
  WORKER_URL,
} from "./testSupport/dbFixture.ts";

const WORKER_SCRIPT = "engine/worker/testSupport/concurrencyWorker.ts";

interface WorkerReport {
  workerId: string;
  stats: { leased: number; succeeded: number; idlePolls: number };
  executed: { jobId: string; tenantId: string }[];
}

let admin: Pool;

beforeAll(async () => {
  provisionWorkerRole();
  admin = adminPool();
}, 60_000);

afterAll(async () => {
  await cleanupFixtures(admin);
  await admin?.end();
});

beforeEach(async () => {
  await resetFixtures(admin);
});

/** stdin is piped so the parent can ask for a graceful stop portably. */
type WorkerProcess = ChildProcessWithoutNullStreams;

interface SpawnedWorker {
  child: WorkerProcess;
  done: Promise<WorkerReport>;
}

function spawnWorker(
  workerId: string,
  env: Record<string, string> = {},
): SpawnedWorker {
  const child = spawn(process.execPath, [WORKER_SCRIPT], {
    env: {
      ...process.env,
      OPS_WORKER_DATABASE_URL: WORKER_URL,
      OPS_WORKER_ID: workerId,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as WorkerProcess;

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));

  const done = new Promise<WorkerReport>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${workerId} exited ${code}: ${stderr || stdout}`));
        return;
      }
      const line = stdout.trim().split("\n").filter(Boolean).at(-1);
      if (!line) {
        reject(new Error(`${workerId} printed no report. stderr: ${stderr}`));
        return;
      }
      resolve(JSON.parse(line) as WorkerReport);
    });
  });

  return { child, done };
}

/**
 * Asks a worker to stop the way an operator would.
 *
 * On POSIX that is SIGTERM, which is what `main.ts` wires in production. On
 * win32 `child.kill("SIGTERM")` is TerminateProcess — measured: the handler
 * never runs and the child exits with code null — so the equivalent stdin
 * channel is used instead. Both reach the same AbortSignal; only the signal
 * wiring itself goes unproven on Windows, and CI is Linux.
 */
const USES_REAL_SIGNAL = process.platform !== "win32";

function requestStop(worker: SpawnedWorker): void {
  if (USES_REAL_SIGNAL) {
    worker.child.kill("SIGTERM");
  } else {
    worker.child.stdin.write("stop" + String.fromCharCode(10));
  }
}

describe("two real worker processes over one queue", () => {
  it("never executes the same job twice, and runs different jobs in parallel", async () => {
    const jobIds: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      jobIds.push(
        await enqueue(
          admin,
          TENANT_A,
          "dbtest.slow",
          {},
          {
            idempotencyKey: `conc-${i}`,
          },
        ),
      );
    }

    const workers = [
      spawnWorker("dbtest-conc-1", { WORKER_RUN_MS: "6000" }),
      spawnWorker("dbtest-conc-2", { WORKER_RUN_MS: "6000" }),
    ];
    const reports = await Promise.all(workers.map((w) => w.done));

    const executed = reports.flatMap((r) => r.executed.map((e) => e.jobId));
    // The assertion that matters: every execution is of a DISTINCT job.
    expect(new Set(executed).size).toBe(executed.length);
    expect(executed.length).toBe(jobIds.length);
    expect([...executed].sort()).toEqual([...jobIds].sort());

    // Both processes did work, so the jobs really were spread rather than one
    // worker serialising them while the other blocked.
    expect(reports[0].executed.length).toBeGreaterThan(0);
    expect(reports[1].executed.length).toBeGreaterThan(0);

    const { rows } = await admin.query<{ status: string; n: string }>(
      "select status, count(*)::text as n from ops.jobs where tenant_id = $1 group by status",
      [TENANT_A],
    );
    expect(rows).toEqual([{ status: "succeeded", n: "8" }]);
  }, 120_000);

  it("keeps tenant boundaries intact while both tenants have work queued", async () => {
    const aJobs = new Set<string>();
    const bJobs = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      aJobs.add(
        await enqueue(
          admin,
          TENANT_A,
          "dbtest.quick",
          {},
          {
            idempotencyKey: `mix-a-${i}`,
          },
        ),
      );
      bJobs.add(
        await enqueue(
          admin,
          TENANT_B,
          "dbtest.quick",
          {},
          {
            idempotencyKey: `mix-b-${i}`,
          },
        ),
      );
    }

    const reports = await Promise.all(
      [
        spawnWorker("dbtest-mix-1", { WORKER_RUN_MS: "5000" }),
        spawnWorker("dbtest-mix-2", { WORKER_RUN_MS: "5000" }),
      ].map((w) => w.done),
    );

    const executed = reports.flatMap((r) => r.executed);
    expect(new Set(executed.map((e) => e.jobId)).size).toBe(8);

    // Every execution ran under the tenant the JOB belongs to. A mismatch here
    // would mean a worker carried one tenant's context into another's job.
    for (const run of executed) {
      const expected = aJobs.has(run.jobId) ? TENANT_A : TENANT_B;
      expect(run.tenantId).toBe(expected);
    }
  }, 120_000);

  it("does not let a slow job block unrelated jobs", async () => {
    // One long job and several short ones. If a slow job held the queue, the
    // short ones would not finish inside the window.
    await enqueue(
      admin,
      TENANT_A,
      "dbtest.slow",
      {},
      { idempotencyKey: "blocker" },
    );
    for (let i = 0; i < 5; i += 1) {
      await enqueue(
        admin,
        TENANT_A,
        "dbtest.quick",
        {},
        {
          idempotencyKey: `unblocked-${i}`,
        },
      );
    }

    const reports = await Promise.all(
      [
        spawnWorker("dbtest-block-1", {
          WORKER_RUN_MS: "5000",
          WORKER_HANDLER_DELAY_MS: "2500",
        }),
        spawnWorker("dbtest-block-2", {
          WORKER_RUN_MS: "5000",
          WORKER_HANDLER_DELAY_MS: "2500",
        }),
      ].map((w) => w.done),
    );

    const executed = reports.flatMap((r) => r.executed.map((e) => e.jobId));
    expect(new Set(executed).size).toBe(executed.length);

    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from ops.jobs
        where tenant_id = $1 and kind = 'dbtest.quick' and status = 'succeeded'`,
      [TENANT_A],
    );
    expect(Number(rows[0].n)).toBe(5);
  }, 120_000);
});

describe("graceful shutdown", () => {
  it("finishes the job in flight, records the stop, and leaves nothing leased", async () => {
    await enqueue(
      admin,
      TENANT_A,
      "dbtest.slow",
      {},
      {
        idempotencyKey: "graceful",
      },
    );

    const worker = spawnWorker("dbtest-graceful", {
      WORKER_RUN_MS: "30000",
      WORKER_HANDLER_DELAY_MS: "1200",
    });

    // Let it lease and start the handler, then ask it to stop mid-job.
    await new Promise((resolve) => setTimeout(resolve, 900));
    requestStop(worker);
    const report = await worker.done;

    // It did not abandon the work.
    expect(report.executed).toHaveLength(1);
    expect(report.stats.succeeded).toBe(1);

    const { rows } = await admin.query<{ status: string }>(
      "select status from ops.jobs where tenant_id = $1",
      [TENANT_A],
    );
    expect(rows.map((r) => r.status)).toEqual(["succeeded"]);

    const instances = await admin.query<{ stopped: boolean }>(
      "select stopped_at is not null as stopped from ops.worker_instances where worker_id = $1",
      ["dbtest-graceful"],
    );
    expect(instances.rows[0]?.stopped).toBe(true);
  }, 120_000);

  it("leaves a recoverable lease when the process is killed outright", async () => {
    // SIGKILL is the crash case: no shutdown hook runs, the socket dies, and the
    // committed lease is what makes the job findable again.
    await enqueue(
      admin,
      TENANT_A,
      "dbtest.slow",
      {},
      { idempotencyKey: "killed" },
    );

    const worker = spawnWorker("dbtest-killed", {
      WORKER_RUN_MS: "30000",
      WORKER_HANDLER_DELAY_MS: "5000",
    });
    // This process is killed on purpose, so `done` WILL reject. Observing it
    // here is what stops Vitest reporting an unhandled rejection that would
    // then be attributed to whichever test happened to be running.
    const killed = worker.done.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    worker.child.kill("SIGKILL");
    await new Promise((resolve) => worker.child.once("close", resolve));
    await killed;

    const { rows } = await admin.query<{
      status: string;
      attempts: number;
      lease_owner: string | null;
    }>(
      "select status, attempts, lease_owner from ops.jobs where tenant_id = $1",
      [TENANT_A],
    );
    expect(rows[0].status).toBe("leased");
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].lease_owner).toBe("dbtest-killed");

    // Expire it, then let a fresh worker recover it on its reaper tick alone —
    // no new work is enqueued, so nothing but the clock drives this.
    await admin.query(
      "update ops.jobs set lease_expires_at = now() - interval '1 second' where tenant_id = $1",
      [TENANT_A],
    );
    const recovered = await spawnWorker("dbtest-recoverer", {
      WORKER_RUN_MS: "4000",
    }).done;

    expect(recovered.executed).toHaveLength(1);
    const after = await admin.query<{ status: string; attempts: number }>(
      "select status, attempts from ops.jobs where tenant_id = $1",
      [TENANT_A],
    );
    expect(after.rows[0].status).toBe("succeeded");
    // The crashed attempt was counted, not forgiven.
    expect(after.rows[0].attempts).toBe(2);
  }, 120_000);
});
