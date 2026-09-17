// The kill switch's pre-call check against a trip IN FLIGHT (ADR 0017 §6),
// against a real Postgres through the real `pg` driver, the real worker runtime
// and a synthetic external_call handler, with TWO sessions at once.
//
// externalCallDeferral.dbtest.ts trips its stop before the prepare transaction
// begins, so the check finds it whether or not it waited for anything.
// supabase/tests/runtime_governance.sql (W6) sees only that the check HOLDS the
// kill-switch lock once it returns. What neither shows is the ORDER: the check
// must wait for a trip that is still uncommitted and then read the stops again.
// A check that read without waiting, or read in the statement that waited,
// would decide on the switch as it was before the trip committed, release the
// handler's durable start and make the call the trip exists to prevent.
//
// The synthetic handler's prepare waits at a gate the test opens, so the trip
// is taken while the prepare transaction is open and before the check runs.
// Every wait is read from pg_stat_activity while the attempt is still
// unsettled. It lives in engine/domain because only there may a test import the
// domain services, the worker runtime and the database fixture together
// (eslint.config.js). All data is synthetic.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import {
  createRegistry,
  type ExternalCallHandlerDefinition,
} from "../worker/handlerRegistry.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import {
  enqueue,
  resetFixtures,
  TENANT_A,
} from "../worker/testSupport/dbFixture.ts";
import { jobEvents, readJobLease } from "../worker/testSupport/jobLedger.ts";
import { waitUntil } from "../worker/testSupport/spendProbes.ts";
import {
  openSession,
  waitUntilBlocked,
} from "../worker/testSupport/transactionSession.ts";
import { clearExecutionStop, tripExecutionStop } from "./executionStops.ts";
import {
  closeAgentRuntimeDatabases,
  openAgentRuntimeDatabases,
  withinMs,
} from "./testSupport/agentRuntimeProbes.ts";
import { CLEAR, TRIP } from "./testSupport/agentRunSessions.ts";

const WORKER = "dbtest-pre-call-check";
const SYNTHETIC_KIND = "dbtest.synthetic_gated_call";

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;

beforeAll(() => {
  ({ admin, owner, db } = openAgentRuntimeDatabases());
}, 60_000);

afterAll(() => closeAgentRuntimeDatabases({ admin, owner, db }));

beforeEach(async () => {
  await resetFixtures(admin);
});

interface GatedHandler {
  readonly handler: ExternalCallHandlerDefinition<never, never, null, string>;
  /** Resolves once prepare is running inside the open prepare transaction. */
  readonly preparing: Promise<void>;
  /** Lets prepare ask for the call. */
  readonly release: () => void;
  readonly counts: { calls: number; settles: number };
}

/** Prepare writes nothing, waits at the gate, then asks for the call. */
function gatedHandler(): GatedHandler {
  let preparingNow!: () => void;
  const preparing = new Promise<void>((resolve) => {
    preparingNow = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const counts = { calls: 0, settles: 0 };
  return {
    preparing,
    release,
    counts,
    handler: {
      kind: SYNTHETIC_KIND,
      shape: "external_call",
      prepareCapabilities: [],
      settleCapabilities: [],
      async prepare() {
        preparingNow();
        await gate;
        return { kind: "call", state: null };
      },
      async call() {
        counts.calls += 1;
        return "called";
      },
      async settle(_state, outcome) {
        counts.settles += 1;
        return `synthetic settled ok=${outcome.ok}`;
      },
    },
  };
}

/** The one worker backend with a transaction open: the attempt's prepare transaction. */
async function preparingBackend(): Promise<number> {
  let pids: number[] = [];
  await waitUntil(async () => {
    const { rows } = await admin.query<{ pid: number }>(
      `select pid from pg_stat_activity
        where usename = 'ops_worker_login' and xact_start is not null`,
    );
    pids = rows.map((row) => row.pid);
    return pids.length === 1;
  }, "the prepare transaction was not seen as the one open worker transaction");
  return pids[0];
}

describe("the pre-call stop check beside a trip in flight", () => {
  it("waits for the trip to commit, then defers the job it covers: nothing is called or settled, and the attempt is restored", async () => {
    const jobId = await enqueue(admin, TENANT_A, SYNTHETIC_KIND);
    const gated = gatedHandler();
    const attempt = runOneJob(db, {
      workerId: WORKER,
      registry: createRegistry([gated.handler]),
    });
    attempt.catch(() => undefined);
    const tripping = openSession(owner);
    let stopId: string | undefined;
    try {
      await withinMs(gated.preparing, 15_000, "prepare never started");
      const checkPid = await preparingBackend();
      stopId = await tripping.run((tx) =>
        tripExecutionStop(tx, { scope: "tenant", tenantId: TENANT_A }, TRIP),
      );

      gated.release();
      await waitUntilBlocked(admin, checkPid, attempt, "advisory");
      const { rows } = await admin.query<{ pids: number[] }>(
        "select pg_blocking_pids($1) as pids",
        [checkPid],
      );
      expect(rows[0].pids).toEqual([await tripping.pid]);

      await tripping.end("commit");
      expect(await attempt).toMatchObject({
        outcome: "deferred",
        jobId,
        attempt: 1,
        detail: `held by execution stop ${stopId}`,
      });
    } finally {
      gated.release();
      await tripping.end("rollback");
      await attempt;
    }

    expect(gated.counts).toEqual({ calls: 0, settles: 0 });
    expect(await readJobLease(admin, jobId)).toMatchObject({
      status: "queued",
      attempts: 0,
      leaseOwner: null,
    });
    expect((await jobEvents(admin, jobId)).map((e) => e.event)).toEqual([
      "enqueued",
      "leased",
      "deferred",
    ]);
    const tripped = stopId;
    if (tripped === undefined) throw new Error("the trip never answered");
    await owner.withTransaction((tx) => clearExecutionStop(tx, tripped, CLEAR));
  }, 30_000);
});
