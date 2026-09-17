// The idle-in-transaction bound on every worker transaction (ADR 0017 §4),
// against a real Postgres through the real `pg` driver and the real
// WorkerDatabase adapter.
//
// The global spend lock serialises every agent run start in the fleet, so a
// transaction that stalls while holding it would stall every tenant's
// admission. WorkerDatabase therefore sets idle_in_transaction_session_timeout
// on every transaction, and the server ends a session that sits idle past it.
// No SQL suite can show what that buys, because the case is a CLIENT that stops
// talking. This file proves, with a short bound:
//
//   * a transaction left idle holding the spend locks is ended by the server,
//     and an admission waiting on them proceeds within a bounded time;
//   * the stalled transaction's next statement rejects, the process survives
//     the session error the driver emits outside any query, and the pool hands
//     out a working connection afterwards;
//   * through the real worker runtime and the real agent run handler: a worker
//     that stalls after its start took the spend locks never commits that
//     start, never calls the provider, and its job is retried on a fresh
//     connection.
//
// It lives in engine/domain because only there may a test import the domain
// services, the worker runtime and the database fixture together
// (eslint.config.js). All data is synthetic office-operations text.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import { createRegistry } from "../worker/handlerRegistry.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import {
  ADMIN_URL,
  readJob,
  resetFixtures,
  TENANT_A,
  WORKER_URL,
} from "../worker/testSupport/dbFixture.ts";
import { createGatedModelProvider } from "../worker/testSupport/gatedModelProvider.ts";
import {
  readRunCost,
  UNSTARTED_COST,
  waitUntil,
} from "../worker/testSupport/spendProbes.ts";
import {
  openSession,
  waitUntilBlocked,
} from "../worker/testSupport/transactionSession.ts";
import { agentRunProbes, rejectionOf } from "./testSupport/agentRunSessions.ts";
import {
  agentRunHandler,
  VALID,
  withinMs,
} from "./testSupport/agentRuntimeProbes.ts";
import {
  buildGovernedOffice,
  closeGovernanceDatabases,
  governedRuntime,
  openGovernanceDatabases,
  requestRuns,
  type GovernedOffice,
} from "./testSupport/governanceRuntime.ts";

/** Short enough to wait out; long enough to see the waiter queue behind the stall. */
const IDLE_MS = 1_500;
/** How late the waiter may proceed after the bound, on a loaded machine. */
const PROCEED_WITHIN_MS = IDLE_MS + 10_000;

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;
let stderr: MockInstance<typeof process.stderr.write>;

beforeAll(() => {
  ({ admin, owner, db } = openGovernanceDatabases());
}, 60_000);

afterAll(() => closeGovernanceDatabases({ admin, owner, db }));

beforeEach(async () => {
  await resetFixtures(admin);
  stderr = vi.spyOn(process.stderr, "write");
});

afterEach(() => {
  stderr.mockRestore();
});

const { blockingPids, leaseHead } = agentRunProbes(() => ({
  admin,
  owner,
  worker: db,
}));

const ADMISSION_SQL =
  "select p_code, p_limit_id from ops.spend_admission($1, $2, 1, true)";

/** Every spend lock of the office's scopes, taken and released in its own owner transaction. */
const admitAsOwner = (office: GovernedOffice) =>
  owner.withTransaction(async (tx) => {
    const { rows } = await tx.query<{ p_code: string | null }>(ADMISSION_SQL, [
      office.tenantId,
      office.companyId,
    ]);
    return rows[0]?.p_code ?? null;
  });

/** Whether the adapter reported a session the server ended, as a diagnostic line. */
const reportedSessionEnd = (): boolean =>
  stderr.mock.calls.some(([chunk]) => {
    const line = String(chunk);
    return (
      line.includes('"event":"worker.pool.session_error"') &&
      /idle-in-transaction/i.test(line)
    );
  });

async function backendGone(pid: number): Promise<boolean> {
  const { rows } = await admin.query<{ n: number }>(
    "select count(*)::int as n from pg_stat_activity where pid = $1",
    [pid],
  );
  return rows[0].n === 0;
}

describe("a transaction left idle holding the spend locks", () => {
  // What no SQL suite can prove: a client that stops talking mid-transaction.
  // The owner's adapter is the worker's adapter, with a short bound.
  it("is ended by the server, lets the admission waiting on its lock proceed in bounded time, rejects its next statement, and leaves the process and the pool working", async () => {
    const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-idle");
    const stalledDb = createWorkerDatabase({
      connectionString: ADMIN_URL,
      max: 1,
      idleInTransactionTimeoutMs: IDLE_MS,
    });
    const stalled = openSession(stalledDb);
    const waiter = openSession(owner);
    try {
      const { rows } = await stalled.run((tx) =>
        tx.query<{ p_code: string | null }>(ADMISSION_SQL, [
          office.tenantId,
          office.companyId,
        ]),
      );
      const idleSince = Date.now();
      expect(rows[0].p_code).toBeNull();
      const stalledPid = await stalled.pid;
      const waiterPid = await waiter.pid;

      const admission = waiter.run((tx) =>
        tx.query<{ p_code: string | null }>(ADMISSION_SQL, [
          office.tenantId,
          office.companyId,
        ]),
      );
      await waitUntilBlocked(admin, waiterPid, admission, "advisory", IDLE_MS);
      expect(await blockingPids(waiterPid)).toEqual([stalledPid]);

      const admitted = await withinMs(
        admission,
        PROCEED_WITHIN_MS,
        "the admission waiting on the stalled transaction never proceeded",
      );
      expect(admitted.rows[0].p_code).toBeNull();
      // It proceeded because the bound ended the stalled session, not sooner.
      expect(Date.now() - idleSince).toBeGreaterThanOrEqual(IDLE_MS - 250);
      await waitUntil(
        () => backendGone(stalledPid),
        "the stalled backend is still in pg_stat_activity",
      );
      await waiter.end("commit");

      const next = await rejectionOf(stalled.run((tx) => tx.query("select 1")));
      expect(next).toBeInstanceOf(Error);
      await stalled.end("rollback");
      expect(reportedSessionEnd()).toBe(true);

      // The pool discarded the dead connection and hands out a working one,
      // still bounded, which can take the same locks again.
      const again = await stalledDb.withTransaction(async (tx) => {
        const { rows: setting } = await tx.query<{ bound: string }>(
          "select current_setting('idle_in_transaction_session_timeout') as bound",
        );
        const { rows: codes } = await tx.query<{ p_code: string | null }>(
          ADMISSION_SQL,
          [office.tenantId, office.companyId],
        );
        return { bound: setting[0].bound, code: codes[0].p_code };
      });
      expect(again).toEqual({ bound: `${IDLE_MS}ms`, code: null });
    } finally {
      await waiter.end("rollback");
      await stalled.end("rollback");
      await stalledDb.close();
    }
    expect(await admitAsOwner(office)).toBeNull();
  }, 60_000);
});

describe("a worker that stalls after its start took the spend locks", () => {
  // What no SQL suite can prove: the runtime's own prepare transaction left
  // idle after the real handler's start answered `running`. The handler is the
  // production one; the only seam pauses it after its prepare returns, which is
  // what a stalled worker process looks like to the database.
  it("never commits that start, never calls the provider, lets the waiting admission proceed, and retries the job on a fresh connection", async () => {
    const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-stall");
    const [runId] = await requestRuns(owner, office, ["stall-1"]);
    const jobId = (await readRunCost(admin, runId)).jobId as string;
    const provider = createGatedModelProvider({
      type: "respond",
      content: VALID,
    });
    provider.open();
    const handler = agentRunHandler(governedRuntime(provider).registry);
    let stalledAfterStart!: () => void;
    const prepared = new Promise<void>((resolve) => {
      stalledAfterStart = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = createRegistry([
      {
        ...handler,
        prepare: (async (job, capabilities, budget) => {
          const outcome = await handler.prepare(job, capabilities, budget);
          stalledAfterStart();
          await released;
          return outcome;
        }) as typeof handler.prepare,
      },
    ]);
    const stalledDb = createWorkerDatabase({
      connectionString: WORKER_URL,
      max: 1,
      idleInTransactionTimeoutMs: IDLE_MS,
    });
    try {
      const attempt = runOneJob(stalledDb, {
        workerId: "dbtest-stalled-worker",
        registry,
      });
      await withinMs(prepared, 15_000, "the prepare never reached its start");
      const idleSince = Date.now();

      const waiter = openSession(owner);
      try {
        const waiterPid = await waiter.pid;
        const admission = waiter.run((tx) =>
          tx.query<{ p_code: string | null }>(ADMISSION_SQL, [
            office.tenantId,
            office.companyId,
          ]),
        );
        await waitUntilBlocked(
          admin,
          waiterPid,
          admission,
          "advisory",
          IDLE_MS,
        );
        const [holder] = await blockingPids(waiterPid);
        const { rows } = await admin.query<{ usename: string }>(
          "select usename from pg_stat_activity where pid = $1",
          [holder],
        );
        expect(rows[0]?.usename).toBe("ops_worker_login");
        // The stalled start is uncommitted: nothing is running yet.
        expect((await readRunCost(admin, runId)).status).toBe("pending");

        const admitted = await withinMs(
          admission,
          PROCEED_WITHIN_MS,
          "the admission waiting on the stalled start never proceeded",
        );
        expect(admitted.rows[0].p_code).toBeNull();
        expect(Date.now() - idleSince).toBeGreaterThanOrEqual(IDLE_MS - 250);
        await waiter.end("commit");
      } finally {
        await waiter.end("rollback");
        release();
      }

      const result = await attempt;
      expect(result).toMatchObject({ outcome: "retry", jobId, attempt: 1 });
      expect(provider.started).toBe(0);
      expect(reportedSessionEnd()).toBe(true);
      expect(await readRunCost(admin, runId)).toMatchObject({
        ...UNSTARTED_COST,
        status: "pending",
        errorCode: null,
      });
      expect(await readJob(admin, jobId)).toMatchObject({
        status: "queued",
        attempts: 1,
        lease_owner: null,
      });
      const { rows: facts } = await admin.query<{ type: string }>(
        "select type from ops.events where subject_type = 'agent_run' and subject_id = $1 order by seq",
        [runId],
      );
      expect(facts.map((fact) => fact.type)).toEqual(["agent_run.requested"]);

      // The retry waits out its backoff; nothing re-leases the job at once.
      expect(await leaseHead("dbtest-after-stall")).toBeNull();
      // The same pool, one connection wide, still serves the worker.
      const bound = await stalledDb.withTransaction(async (tx) => {
        const { rows } = await tx.query<{ bound: string }>(
          "select current_setting('idle_in_transaction_session_timeout') as bound",
        );
        return rows[0].bound;
      });
      expect(bound).toBe(`${IDLE_MS}ms`);
    } finally {
      release();
      await stalledDb.close();
    }
  }, 60_000);
});
