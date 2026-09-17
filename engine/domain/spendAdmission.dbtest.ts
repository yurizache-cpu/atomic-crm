// Spend admission under concurrency (ADR 0017 §3 and §4), against a real
// Postgres through the real `pg` driver, the real worker capabilities and the
// real worker runtime, with a scripted model provider whose calls a case holds
// in flight for as long as it needs.
//
// supabase/tests/runtime_governance.sql proves admission on ONE connection: it
// can show that a start takes the spend locks, and that a start which fits
// settled spend but not the calls in flight raises OS429. It cannot show what
// the locks BUY, because nothing else is running. This file proves what only a
// second session, or several worker loops, can show:
//
//   * two starts racing at a limit that fits exactly one reservation: the
//     second WAITS on the spend lock the first holds, then decides on what the
//     first committed, refuses with OS429 and records nothing;
//   * several real worker loops racing at a tenant budget: only the admissible
//     number of provider calls happens at once, the contended starts retry
//     without being charged, charged spend never exceeds the budget at any
//     moment it is sampled, and the waiting runs are admitted once the admitted
//     ones settle below their reservations.
//
// Refusals that need no second session are in spendRefusals.dbtest.ts. Every
// wait is read from pg_stat_activity while the waiting call is still unsettled.
// It lives in engine/domain because only there may a test import the domain
// services, the worker runtime and the database fixture together
// (eslint.config.js). All data is synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { FAKE_DEFAULT_USAGE } from "../models/fakeModelProvider.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import {
  readJob,
  resetFixtures,
  TENANT_A,
  type FixtureGovernance,
} from "../worker/testSupport/dbFixture.ts";
import { createGatedModelProvider } from "../worker/testSupport/gatedModelProvider.ts";
import {
  estimateFor,
  quietSpend,
  readRunCost,
  reservationFor,
  setDailyLimit,
  todaySpend,
  UNSTARTED_COST,
  waitUntil,
  type LimitScope,
} from "../worker/testSupport/spendProbes.ts";
import {
  openSession,
  waitUntilBlocked,
} from "../worker/testSupport/transactionSession.ts";
import {
  agentRunProbes,
  capabilities,
  HOLDER,
  opsRowsWritten,
  OTHER,
  rejectionOf,
  resume,
  START,
} from "./testSupport/agentRunSessions.ts";
import { VALID, withinMs } from "./testSupport/agentRuntimeProbes.ts";
import {
  buildGovernedOffice,
  closeGovernanceDatabases,
  governedRuntime,
  openGovernanceDatabases,
  PRICED_MODEL,
  requestRuns,
  sampleTenantSpend,
  startWorkers,
  type GovernedOffice,
} from "./testSupport/governanceRuntime.ts";

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;
let governance: FixtureGovernance;

beforeAll(() => {
  ({ admin, owner, db } = openGovernanceDatabases());
}, 60_000);

afterAll(() => closeGovernanceDatabases({ admin, owner, db }));

beforeEach(async () => {
  governance = await resetFixtures(admin);
});

const { blockingPids, leaseHead } = agentRunProbes(() => ({
  admin,
  owner,
  worker: db,
}));

const priceId = () => governance.priceIds[PRICED_MODEL];

/** One run requested and answered through the real runtime, so the day has settled spend. */
async function settleOneRun(office: GovernedOffice, key: string) {
  const [runId] = await requestRuns(owner, office, [key]);
  const provider = createGatedModelProvider({
    type: "respond",
    content: VALID,
  });
  provider.open();
  const { registry } = governedRuntime(provider);
  const result = await runOneJob(db, { workerId: "dbtest-settler", registry });
  expect(result.outcome).toBe("succeeded");
  const cost = await readRunCost(admin, runId);
  expect(cost.status).toBe("succeeded");
  expect(cost.charged).toBeGreaterThan(0n);
  return runId;
}

async function eventTypes(runId: string): Promise<string[]> {
  const { rows } = await admin.query<{ type: string }>(
    "select type from ops.events where subject_type = 'agent_run' and subject_id = $1 order by seq",
    [runId],
  );
  return rows.map((row) => row.type);
}

// ---------------------------------------------------------------------------
// Two sessions
// ---------------------------------------------------------------------------

describe("two starts racing at a spend limit", () => {
  // What the SQL suite cannot prove: a start that reads the day's totals while
  // another start's reservation is UNCOMMITTED. Only the spend lock stands
  // between it and a stale read that would admit both.
  it.each<LimitScope>(["tenant", "global"])(
    "admits only the first when the %s limit fits settled spend plus one reservation: the second waits on the spend lock, then raises OS429 and records nothing",
    async (scope) => {
      const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-race");
      await settleOneRun(office, "race-settled");
      const [first, second] = await requestRuns(owner, office, [
        "race-1",
        "race-2",
      ]);
      const reservation = await reservationFor(admin, first, priceId());
      expect(await reservationFor(admin, second, priceId())).toBe(reservation);
      const tenant = scope === "global" ? null : TENANT_A;
      const settled = await quietSpend(admin, scope, tenant);
      expect(settled).toBeGreaterThan(0n);
      const limit = settled + reservation;
      await setDailyLimit(admin, scope, limit, tenant);

      const firstJob = (await readRunCost(admin, first)).jobId as string;
      const secondJob = (await readRunCost(admin, second)).jobId as string;
      expect(await leaseHead(HOLDER)).toBe(firstJob);
      expect(await leaseHead(OTHER)).toBe(secondJob);
      const admitted = openSession(db);
      const contended = openSession(db);
      try {
        await admitted.run((tx) => resume(tx, HOLDER, firstJob));
        await admitted.run((tx) => capabilities(tx).claimAgentRun());
        expect(
          await admitted.run((tx) => capabilities(tx).startAgentRun(START)),
        ).toBe("running");

        await contended.run((tx) => resume(tx, OTHER, secondJob));
        expect(
          await contended.run((tx) => capabilities(tx).claimAgentRun()),
        ).toMatchObject({ action: "start", agent_run_id: second });
        const writtenBefore = await contended.run(opsRowsWritten);
        await contended.run((tx) => tx.query("savepoint start_attempt"));
        const contendedPid = await contended.pid;
        const status = contended.run((tx) =>
          capabilities(tx).startAgentRun(START),
        );
        await waitUntilBlocked(admin, contendedPid, status, "advisory");
        expect(await blockingPids(contendedPid)).toEqual([await admitted.pid]);

        await admitted.end("commit");
        const refused = await rejectionOf(status);
        expect(refused).toMatchObject({ code: "OS429" });
        await contended.run((tx) =>
          tx.query("rollback to savepoint start_attempt"),
        );
        expect(
          await contended.run(opsRowsWritten),
          "ops rows the contended start wrote before it refused",
        ).toBe(writtenBefore);
      } finally {
        await admitted.end("rollback");
        await contended.end("rollback");
      }

      expect(await readRunCost(admin, first)).toMatchObject({
        status: "running",
        reserved: reservation,
        charged: reservation,
      });
      expect(await readRunCost(admin, second)).toMatchObject({
        ...UNSTARTED_COST,
        status: "pending",
        errorCode: null,
        spendLimitId: null,
      });
      expect(await eventTypes(second)).toEqual(["agent_run.requested"]);
      const day = await todaySpend(admin, scope, tenant);
      expect(day).toEqual({ charged: limit, settled });
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// Real worker loops
// ---------------------------------------------------------------------------

const WORKERS = ["dbtest-spend-w1", "dbtest-spend-w2", "dbtest-spend-w3"];

async function jobsOf(runIds: readonly string[]) {
  const { rows } = await admin.query<{
    run_id: string;
    job_id: string;
    attempts: number;
    status: string;
    retries: number;
    contended_retries: number;
  }>(
    `select r.id as run_id, j.id as job_id, j.attempts, j.status,
            (select count(*)::int from ops.job_events e
              where e.job_id = j.id and e.event = 'retry') as retries,
            (select count(*)::int from ops.job_events e
              where e.job_id = j.id and e.event = 'retry'
                and e.detail like '[transient] OS429:%') as contended_retries
       from ops.agent_runs r join ops.jobs j on j.id = r.job_id
      where r.id = any($1::uuid[])`,
    [runIds],
  );
  return rows;
}

describe("worker loops racing at a tenant budget", () => {
  // What the SQL suite cannot prove: admission as the running system meets it.
  // Three real worker loops lease four runs at once, and the budget absorbs
  // two reservations (plus the two answers' estimates). The two admitted calls
  // are held in flight until both contended starts are recorded as retries.
  it("lets only the admissible number of calls happen at once, retries the contended starts uncharged, never lets charged spend exceed the budget, and admits the waiting runs once the admitted ones settle below their reservations", async () => {
    const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-loops");
    const runIds = await requestRuns(owner, office, [
      "loop-1",
      "loop-2",
      "loop-3",
      "loop-4",
    ]);
    const reservation = await reservationFor(admin, runIds[0], priceId());
    const estimate = (await estimateFor(
      admin,
      priceId(),
      FAKE_DEFAULT_USAGE,
    )) as bigint;
    expect(estimate).toBeGreaterThan(0n);
    expect(estimate).toBeLessThan(reservation);
    const settled = await quietSpend(admin, "tenant", TENANT_A);
    const budget = settled + 2n * reservation + 2n * estimate;
    // Two calls fit in flight, a third does not; two settled answers leave room
    // for the other two.
    expect(settled + 3n * reservation).toBeGreaterThan(budget);
    await setDailyLimit(admin, "tenant", budget, TENANT_A);
    const provider = createGatedModelProvider({
      type: "respond",
      content: VALID,
    });
    const { registry } = governedRuntime(provider);

    const sampler = sampleTenantSpend(admin, TENANT_A);
    const workers = startWorkers(db, registry, WORKERS);
    try {
      await withinMs(
        provider.callStarted(2),
        15_000,
        "two admitted calls never started",
      );
      await waitUntil(
        async () =>
          (await jobsOf(runIds)).filter((job) => job.contended_retries === 1)
            .length === 2,
        "both contended starts were not recorded as OS429 retries",
      );

      // Phase one, while the admitted calls are held in flight.
      expect(provider.started).toBe(2);
      const held = await Promise.all(
        runIds.map((runId) => readRunCost(admin, runId)),
      );
      const running = held.filter((cost) => cost.status === "running");
      const waiting = held.filter((cost) => cost.status === "pending");
      expect(running).toHaveLength(2);
      expect(waiting).toHaveLength(2);
      for (const cost of running) {
        expect(cost.charged).toBe(reservation);
      }
      for (const cost of waiting) {
        expect(cost).toMatchObject({ ...UNSTARTED_COST, errorCode: null });
        expect(await readJob(admin, cost.jobId as string)).toMatchObject({
          status: "queued",
          attempts: 1,
          last_error_class: "transient",
        });
      }
    } finally {
      provider.open();
    }

    try {
      await waitUntil(
        async () =>
          (
            await Promise.all(runIds.map((runId) => readRunCost(admin, runId)))
          ).every((cost) => cost.status === "succeeded"),
        "the waiting runs were not admitted and answered after the admitted ones settled",
        30_000,
      );
    } finally {
      const stats = await workers.stop();
      const samples = await sampler.stop();
      expect(stats.reduce((sum, s) => sum + s.retried, 0)).toBe(2);
      expect(stats.reduce((sum, s) => sum + s.failed, 0)).toBe(0);
      expect(samples.samples).toBeGreaterThan(10);
      expect(samples.maxCharged).toBeLessThanOrEqual(budget);
      expect(samples.maxRunning).toBeLessThanOrEqual(2);
    }

    // Phase two: each run called once, the contended ones on their second attempt.
    expect(provider.started).toBe(4);
    expect(provider.maxInFlight).toBe(2);
    const jobs = await jobsOf(runIds);
    expect(jobs.map((job) => job.status)).toEqual(Array(4).fill("succeeded"));
    expect(jobs.map((job) => job.attempts).sort()).toEqual([1, 1, 2, 2]);
    expect(jobs.map((job) => job.retries).sort()).toEqual([0, 0, 1, 1]);
    for (const runId of runIds) {
      const cost = await readRunCost(admin, runId);
      expect(cost).toMatchObject({
        status: "succeeded",
        reserved: reservation,
        estimated: estimate,
        charged: estimate,
        spendLimitId: null,
      });
      const job = jobs.find((row) => row.run_id === runId);
      expect(cost.jobAttempt).toBe(job?.attempts);
    }
    expect(await todaySpend(admin, "tenant", TENANT_A)).toEqual({
      charged: settled + 4n * estimate,
      settled: settled + 4n * estimate,
    });
  }, 60_000);
});
