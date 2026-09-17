// The kill switch immediately BEFORE an external call (ADR 0017 §6), against a
// real Postgres through the real `pg` driver and the real worker runtime.
//
// For an agent run the pre-call check can never fire: its start has already
// read the stops under the same lock, and a stop it finds holds the run (the
// start answers `stopped` and the runtime defers the job, owner decision B). So
// the generic guarantee is driven here through a
// synthetic external_call handler, registered with the generic registry (its
// kind is classified nowhere, which createRegistry allows and the production
// registry would refuse). Its prepare asks for the call, its call and settle
// count themselves, and one variant's prepare makes a durable write first.
//
// supabase/tests/runtime_governance.sql calls ops.job_execution_stop and
// ops.defer_job by hand inside one rolled-back transaction. What it cannot see:
//
//   * a stop tripped after the lease COMMITTED, in the window runOneJob exposes
//     through onLeased, turning the attempt into `deferred` with no call and no
//     settle, the attempt restored, a 30 s delay and a `deferred` job event;
//   * the savepoint discarding what prepare wrote, while an undeferred prepare's
//     write is durable before its call starts;
//   * the deferred job run later, exactly once, on the same attempt number;
//   * a job whose company is unknown held by any company stop in its tenant;
//   * an agent run in the same window, held at start and deferred with nothing
//     written, then started and called exactly once after the stop is cleared.
//
// It lives in engine/domain because only there may a test import the domain
// services, the worker runtime and the database fixture together
// (eslint.config.js). All data is synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import {
  createRegistry,
  type CallOutcome,
  type ExternalCallHandlerDefinition,
  type HandlerRegistry,
} from "../worker/handlerRegistry.ts";
import type { LeasedJob } from "../worker/job.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import {
  clearLedger,
  countLedger,
  enqueue,
  resetFixtures,
  seedLedger,
  TENANT_A,
  TENANT_B,
} from "../worker/testSupport/dbFixture.ts";
import {
  jobEvents,
  makeJobDue,
  readJobLease,
} from "../worker/testSupport/jobLedger.ts";
import { createCompany } from "./companyOs.ts";
import {
  clearExecutionStop,
  tripExecutionStop,
  type ExecutionStopTarget,
} from "./executionStops.ts";
import {
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  fakeRuntime,
  openAgentRuntimeDatabases,
  VALID,
} from "./testSupport/agentRuntimeProbes.ts";
import { CLEAR, TRIP } from "./testSupport/agentRunSessions.ts";

const WORKER = "dbtest-external-deferral";
const SYNTHETIC_KIND = "dbtest.synthetic_call";
/** ops.defer_job's delay. */
const DEFER_SECONDS = 30;

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;

beforeAll(() => {
  ({ admin, owner, db } = openAgentRuntimeDatabases());
}, 60_000);

afterAll(() => closeAgentRuntimeDatabases({ admin, owner, db }));

beforeEach(async () => {
  await resetFixtures(admin);
  await clearLedger(admin);
});

const probes = agentRuntimeProbes(() => ({ admin, owner, db }));

const trip = (target: ExecutionStopTarget) =>
  owner.withTransaction((tx) => tripExecutionStop(tx, target, TRIP));

const clear = (stopId: string) =>
  owner.withTransaction((tx) => clearExecutionStop(tx, stopId, CLEAR));

/** What the synthetic handler saw. */
interface SyntheticProbe {
  prepares: number;
  calls: number;
  settles: number;
  readonly outcomes: CallOutcome<unknown>[];
  /** Rows prepare purged, per prepare (the purging variant only). */
  readonly purged: number[];
  /** The fixture's ledger rows the admin pool saw while each call ran. */
  readonly ledgerDuringCall: number[];
}

const newProbe = (): SyntheticProbe => ({
  prepares: 0,
  calls: 0,
  settles: 0,
  outcomes: [],
  purged: [],
  ledgerDuringCall: [],
});

type CallState = { readonly token: string };

/** Prepare writes nothing and asks for the call; call and settle count themselves. */
function inertHandler(
  probe: SyntheticProbe,
): ExternalCallHandlerDefinition<never, never, CallState, string> {
  return {
    kind: SYNTHETIC_KIND,
    shape: "external_call",
    prepareCapabilities: [],
    settleCapabilities: [],
    async prepare() {
      probe.prepares += 1;
      return { kind: "call", state: { token: "dbtest-call" } };
    },
    async call(state) {
      probe.calls += 1;
      return `called ${state.token}`;
    },
    async settle(_state, outcome) {
      probe.settles += 1;
      probe.outcomes.push(outcome);
      return `synthetic settled ok=${outcome.ok}`;
    },
  };
}

/** As inertHandler, but prepare first purges the ledger: a durable write before the call. */
function purgingHandler(
  probe: SyntheticProbe,
): ExternalCallHandlerDefinition<
  "purgeInboundEmailLedger",
  never,
  CallState,
  string
> {
  const inert = inertHandler(probe);
  return {
    ...inert,
    prepareCapabilities: ["purgeInboundEmailLedger"],
    async prepare(job, capabilities, budget) {
      probe.purged.push(
        await capabilities.purgeInboundEmailLedger({ retentionDays: 90 }),
      );
      return inert.prepare(job, {}, budget);
    },
    async call(state, context) {
      probe.ledgerDuringCall.push(await countLedger(admin));
      return inert.call(state, context);
    },
  };
}

/** One pass of the runtime, tripping `target` after the lease committed. */
async function runTrippingAfterLease(
  registry: HandlerRegistry,
  jobId: string,
  target: ExecutionStopTarget,
) {
  let stopId: string | undefined;
  const result = await runOneJob(db, {
    workerId: WORKER,
    registry,
    onLeased: async (job: LeasedJob) => {
      expect(job.id).toBe(jobId);
      stopId = await trip(target);
    },
  });
  if (stopId === undefined) throw new Error("onLeased never ran");
  return { result, stopId };
}

/** Asserts the deferral ops.defer_job records, and nothing more. */
async function expectDeferred(jobId: string, stopId: string) {
  const lease = await readJobLease(admin, jobId);
  expect(lease).toMatchObject({
    status: "queued",
    attempts: 0,
    leaseOwner: null,
    leasedAt: null,
    leaseExpiresAt: null,
    delaySeconds: DEFER_SECONDS,
  });
  expect(lease.dueInSeconds).toBeGreaterThan(DEFER_SECONDS - 10);
  expect(lease.dueInSeconds).toBeLessThanOrEqual(DEFER_SECONDS);
  expect(await jobEvents(admin, jobId)).toEqual([
    {
      event: "enqueued",
      workerId: null,
      attempt: null,
      detail: SYNTHETIC_KIND,
    },
    { event: "leased", workerId: WORKER, attempt: 1, detail: SYNTHETIC_KIND },
    {
      event: "deferred",
      workerId: WORKER,
      attempt: 1,
      detail: `held by execution stop ${stopId}`,
    },
  ]);
}

async function officeCompany(tenantId: string, slug: string): Promise<string> {
  return owner.withTransaction((tx) =>
    createCompany(
      tx,
      { tenantId, source: "dbtest-external-deferral" },
      { slug, name: "Office" },
    ),
  );
}

describe("an external_call job whose stop is tripped after its lease committed", () => {
  const stopsInItsTenant: readonly {
    readonly name: string;
    readonly target: () => Promise<ExecutionStopTarget>;
  }[] = [
    {
      name: "a tenant stop",
      target: async () => ({ scope: "tenant", tenantId: TENANT_A }),
    },
    {
      name: "a company stop in its tenant, the job's company being unknown",
      target: async () => ({
        scope: "company",
        tenantId: TENANT_A,
        companyId: await officeCompany(TENANT_A, "dbtest-deferral-office"),
      }),
    },
  ];

  // What the SQL suite cannot prove: the runtime's pre-call check on a real
  // lease, in the window after TX1 committed and before TX2a.
  for (const { name, target } of stopsInItsTenant) {
    it(`is deferred under ${name}: prepared, never called or settled, its attempt restored, due again in 30 s, with a deferred job event naming the stop`, async () => {
      const stopTarget = await target();
      const jobId = await enqueue(admin, TENANT_A, SYNTHETIC_KIND);
      const probe = newProbe();
      const registry = createRegistry([inertHandler(probe)]);

      const { result, stopId } = await runTrippingAfterLease(
        registry,
        jobId,
        stopTarget,
      );

      expect(result).toMatchObject({
        outcome: "deferred",
        jobId,
        tenantId: TENANT_A,
        kind: SYNTHETIC_KIND,
        attempt: 1,
        detail: `held by execution stop ${stopId}`,
      });
      expect(probe).toMatchObject({ prepares: 1, calls: 0, settles: 0 });
      await expectDeferred(jobId, stopId);

      await makeJobDue(admin, jobId);
      const stillHeld = await runOneJob(db, { workerId: WORKER, registry });

      expect(stillHeld).toEqual({ outcome: "idle" });
      expect(probe).toMatchObject({ prepares: 1, calls: 0, settles: 0 });
      expect((await readJobLease(admin, jobId)).attempts).toBe(0);
    }, 30_000);
  }

  // What the SQL suite cannot prove: the deferred job's later life on the real
  // runtime. The delay is honoured, and once due it runs once, on attempt 1
  // again, because the deferral discarded the attempt it had spent.
  it("waits out its delay after the stop is cleared, then is prepared, called exactly once and settled on attempt 1 again", async () => {
    const jobId = await enqueue(admin, TENANT_A, SYNTHETIC_KIND);
    const probe = newProbe();
    const registry = createRegistry([inertHandler(probe)]);
    const { stopId } = await runTrippingAfterLease(registry, jobId, {
      scope: "tenant",
      tenantId: TENANT_A,
    });
    await clear(stopId);

    const notDue = await runOneJob(db, { workerId: WORKER, registry });

    expect(notDue).toEqual({ outcome: "idle" });
    await expectDeferred(jobId, stopId);

    await makeJobDue(admin, jobId);
    const released = await runOneJob(db, { workerId: WORKER, registry });

    expect(released).toMatchObject({
      outcome: "succeeded",
      jobId,
      attempt: 1,
      detail: "synthetic settled ok=true",
    });
    expect(probe).toMatchObject({ prepares: 2, calls: 1, settles: 1 });
    expect(probe.outcomes).toEqual([
      { ok: true, value: "called dbtest-call", durationMs: expect.any(Number) },
    ]);
    expect(await readJobLease(admin, jobId)).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
    expect((await jobEvents(admin, jobId)).map((e) => e.event)).toEqual([
      "enqueued",
      "leased",
      "deferred",
      "leased",
      "succeeded",
    ]);
  }, 30_000);

  // What the SQL suite cannot prove: that the runtime rolls back to the
  // savepoint it took before prepare, so a deferred attempt leaves nothing that
  // claims a call was made, while an undeferred prepare commits its write
  // before the call leaves the process.
  it("discards what prepare wrote when the stop defers it, and commits that write before the call once no stop covers the job", async () => {
    await seedLedger(admin, [
      { ageDays: 200, status: "ingested", messageId: "dbtest-defer-old" },
      { ageDays: 10, status: "ingested", messageId: "dbtest-defer-new" },
    ]);
    const jobId = await enqueue(admin, TENANT_A, SYNTHETIC_KIND);
    const probe = newProbe();
    const registry = createRegistry([purgingHandler(probe)]);

    const { result, stopId } = await runTrippingAfterLease(registry, jobId, {
      scope: "tenant",
      tenantId: TENANT_A,
    });

    expect(result.outcome).toBe("deferred");
    expect(probe.purged).toEqual([1]);
    expect(await countLedger(admin)).toBe(2);
    expect(probe.calls).toBe(0);

    await clear(stopId);
    await makeJobDue(admin, jobId);
    const released = await runOneJob(db, { workerId: WORKER, registry });

    expect(released).toMatchObject({ outcome: "succeeded", attempt: 1 });
    expect(probe.purged).toEqual([1, 1]);
    expect(probe.ledgerDuringCall).toEqual([1]);
    expect(probe).toMatchObject({ calls: 1, settles: 1 });
    expect(await countLedger(admin)).toBe(1);
  }, 30_000);
});

describe("an external_call job no stop covers", () => {
  // What the SQL suite cannot prove: the undeferred path of the same handler on
  // the real runtime, with a neighbour's stop active beside it.
  it("is prepared, called exactly once and settled, and a stop on another tenant changes nothing", async () => {
    const jobId = await enqueue(admin, TENANT_A, SYNTHETIC_KIND);
    const probe = newProbe();
    const registry = createRegistry([inertHandler(probe)]);
    await trip({ scope: "tenant", tenantId: TENANT_B });

    const result = await runOneJob(db, { workerId: WORKER, registry });

    expect(result).toMatchObject({
      outcome: "succeeded",
      jobId,
      attempt: 1,
      detail: "synthetic settled ok=true",
    });
    expect(probe).toMatchObject({ prepares: 1, calls: 1, settles: 1 });
    expect(await readJobLease(admin, jobId)).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
    expect((await jobEvents(admin, jobId)).map((e) => e.event)).toEqual([
      "enqueued",
      "leased",
      "succeeded",
    ]);
  }, 30_000);

  // What the SQL suite cannot prove: the lease filter's fail-closed reading of
  // an unknown coordinate, on the real queue. The synthetic job knows only its
  // tenant and kind, so a company stop anywhere in that tenant holds it, and one
  // in another tenant does not.
  it("is held at the lease by a company stop in its own tenant, whose company it does not know, and not by one in another tenant", async () => {
    const jobId = await enqueue(admin, TENANT_A, SYNTHETIC_KIND);
    const probe = newProbe();
    const registry = createRegistry([inertHandler(probe)]);
    const ownStop = await trip({
      scope: "company",
      tenantId: TENANT_A,
      companyId: await officeCompany(TENANT_A, "dbtest-unknown-a"),
    });
    await trip({
      scope: "company",
      tenantId: TENANT_B,
      companyId: await officeCompany(TENANT_B, "dbtest-unknown-b"),
    });

    const held = await runOneJob(db, { workerId: WORKER, registry });

    expect(held).toEqual({ outcome: "idle" });
    expect(probe.prepares).toBe(0);
    expect((await jobEvents(admin, jobId)).map((e) => e.event)).toEqual([
      "enqueued",
    ]);

    await clear(ownStop);
    const released = await runOneJob(db, { workerId: WORKER, registry });

    expect(released).toMatchObject({ outcome: "succeeded", jobId });
    expect(probe).toMatchObject({ prepares: 1, calls: 1, settles: 1 });
  }, 30_000);
});

describe("an agent run whose stop is tripped after its lease committed", () => {
  // What the SQL suite cannot prove: that the real agent run handler turns the
  // start's `stopped` into a held prepare, and the runtime defers the job in
  // the same transaction (owner decision B): the run stays pending with nothing
  // recorded, the attempt is given back, the job is held while the stop is
  // active, and once the stop is cleared the SAME run starts and calls the
  // provider exactly once.
  it("is held at start by the tenant stop and deferred with its attempt given back, never cancelled, and the same run calls the provider once after the clear", async () => {
    const office = await probes.buildOfficeTask(TENANT_A);
    const runId = await probes.requestRun(office, "deferral-agent-run");
    const jobId = (await probes.readRun(runId)).job_id as string;
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });

    const { result, stopId } = await runTrippingAfterLease(registry, jobId, {
      scope: "tenant",
      tenantId: TENANT_A,
    });

    expect(result).toMatchObject({
      outcome: "deferred",
      jobId,
      attempt: 1,
      detail: `held by execution stop ${stopId}`,
    });
    expect(await probes.readRun(runId)).toMatchObject({
      status: "pending",
      error_category: null,
      error_code: null,
      stop_id: null,
      provider: null,
      job_attempt: null,
      started_at: null,
      price_id: null,
      charged_cost_micros: null,
    });
    expect(await readJobLease(admin, jobId)).toMatchObject({
      status: "queued",
      attempts: 0,
    });
    const deferredEvents = await jobEvents(admin, jobId);
    expect(deferredEvents.map((e) => e.event)).toEqual([
      "enqueued",
      "leased",
      "deferred",
    ]);
    expect(deferredEvents[2]?.detail).toBe(`held by execution stop ${stopId}`);
    expect(provider.calls).toHaveLength(0);

    // Due again while the stop is active: held at the lease, nothing spent.
    await makeJobDue(admin, jobId);
    expect(await runOneJob(db, { workerId: WORKER, registry })).toEqual({
      outcome: "idle",
    });
    expect(await readJobLease(admin, jobId)).toMatchObject({
      status: "queued",
      attempts: 0,
    });
    expect((await probes.readRun(runId)).status).toBe("pending");

    await clear(stopId);
    const after = await runOneJob(db, { workerId: WORKER, registry });

    expect(after).toMatchObject({ outcome: "succeeded", jobId, attempt: 1 });
    expect(await probes.readRun(runId)).toMatchObject({
      status: "succeeded",
      stop_id: null,
      job_attempt: 1,
    });
    expect(provider.calls).toHaveLength(1);
    expect((await jobEvents(admin, jobId)).map((e) => e.event)).toEqual([
      "enqueued",
      "leased",
      "deferred",
      "leased",
      "succeeded",
    ]);
  }, 30_000);
});
