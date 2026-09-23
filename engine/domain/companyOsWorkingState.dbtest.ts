// Truthful working state (SI-57 as proposed, brief §10 and §16 "Working
// state"), against a real Postgres through the real `pg` driver, over REAL
// leases taken and settled by the worker's own functions.
//
// The Company OS operator surface reads an agent's state from facts at read
// time, on two axes: availability (inactive, stopped, available) and activity
// (working, stale, held, queued, idle). supabase/tests/company_os_api.sql can
// only plant rows by hand inside one rolled-back transaction. What it cannot
// show is what this file proves, each case read through the member's own gates
// (testSupport/companyOsMember.ts), never through an owner shortcut:
//
//   * "working" appears only while a running run holds a lease that the lease
//     function committed and that has not run out, and it names that run;
//   * a run whose real lease ran out is stale attention, never working, and
//     so is a run whose job a LATER attempt has leased again: that live lease
//     is not the run's;
//   * a run whose job a tenant stop deferred (the runtime's own deferral) is
//     held, and the agent is stopped with that stop as evidence;
//   * a pending run under no covering stop is queued, beside a neighbour's
//     stop that covers other work only;
//   * an agent whose runs have settled is idle;
//   * an inactive agent, department or company is inactive, naming the unit,
//     and inactive wins over stopped;
//   * working and stopped are reported together when a stop trips while a
//     call is in flight.
//
// Every evidence id every answer carries is then checked against the database
// (evidenceFaults): each is the agent's own run, in the state its list claims.
//
// It lives in engine/domain because only there may a test import the domain
// services, the worker runtime and the database fixture together
// (eslint.config.js). All data is synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import type { LeasedJob } from "../worker/job.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import { resetFixtures, TENANT_A } from "../worker/testSupport/dbFixture.ts";
import {
  createAgent,
  createCompany,
  createDepartment,
  setAgentStatus,
  setCompanyStatus,
  setDepartmentStatus,
} from "./companyOs.ts";
import {
  tripExecutionStop,
  type ExecutionStopTarget,
} from "./executionStops.ts";
import {
  agentRunProbes,
  agentTarget,
  closeAgentRunDatabases,
  HOLDER,
  openAgentRunDatabases,
  SHORT_LEASE_SECONDS,
  SOURCE,
  TRIP,
  type Office,
} from "./testSupport/agentRunSessions.ts";
import { fakeRuntime, VALID } from "./testSupport/agentRuntimeProbes.ts";
import {
  agentIn,
  evidenceFaults,
  readAsMember,
  type AgentList,
} from "./testSupport/companyOsMember.ts";

let admin: Pool;
let owner: WorkerDatabase;
let worker: WorkerDatabase;

beforeAll(() => {
  ({ admin, owner, worker } = openAgentRunDatabases());
}, 60_000);

afterAll(() => closeAgentRunDatabases({ admin, owner, worker }));

beforeEach(async () => {
  await resetFixtures(admin);
});

const {
  buildOffice,
  leaseAsOther,
  leaseHead,
  prepare,
  readRun,
  reap,
  requestRun,
  waitUntilLeaseEnded,
} = agentRunProbes(() => ({ admin, owner, worker }));

/**
 * Every stop here is tripped under an email-shaped actor label, which the
 * stored column accepts and no projection may return (brief §9).
 */
const TRIP_ACT = Object.freeze({
  reason: TRIP.reason,
  actor: "dbtest-cos-tripper@example.test",
});

const trip = (target: ExecutionStopTarget) =>
  owner.withTransaction((tx) => tripExecutionStop(tx, target, TRIP_ACT));

interface Overview {
  readonly agents: Record<string, number>;
  readonly runs: {
    readonly workingNow: number;
    readonly needingAttention: number;
  };
  readonly stops: { readonly tenantScopedActive: number };
}

/** list_agents and overview, read together by one signed-in member. */
async function readState(
  extra: (read: ReadExtra) => Promise<unknown> = async () => null,
) {
  return readAsMember(owner, TENANT_A, async (member) => {
    const agents = (await member.read<AgentList>("list_agents")).value;
    const overview = (await member.read<Overview>("overview")).value;
    const more = await extra((fn, args) =>
      member.read(fn, args).then((output) => output.value),
    );
    return { agents, overview, more };
  });
}

type ReadExtra = (
  fn: "get_run" | "list_runs" | "list_stops",
  args: Readonly<Record<string, unknown>>,
) => Promise<Record<string, unknown>>;

/** A run requested on the office's task, its job leased by HOLDER and started. */
async function runningRun(
  key: string,
  leaseSeconds = 60,
): Promise<{ office: Office; runId: string; jobId: string }> {
  const office = await buildOffice();
  const runId = await requestRun(office, key);
  const jobId = (await readRun(runId)).job_id as string;
  expect(await leaseHead(HOLDER, leaseSeconds)).toBe(jobId);
  expect(await prepare(HOLDER, jobId)).toBe("running");
  return { office, runId, jobId };
}

const NO_EVIDENCE = Object.freeze({
  workingRunIds: [],
  heldRunIds: [],
  queuedRunIds: [],
  staleRunIds: [],
  attentionRunIds: [],
  stop: null,
  inactiveUnit: null,
});

describe("an agent's working state, read as a signed-in member over real leases", () => {
  // What the SQL suite cannot prove: "working" on a lease the lease function
  // really committed, read back through the member's gate, with the run it
  // names in exactly that state.
  it("reports an agent working only while its running run holds a live lease, and names that run", async () => {
    const { office, runId } = await runningRun("cos-working");

    const { agents, overview, more } = await readState((read) =>
      read("get_run", { p_run_id: runId }),
    );

    expect(agentIn(agents, office.agentId)).toMatchObject({
      availability: "available",
      activity: "working",
      attentionCount: 0,
      evidence: { ...NO_EVIDENCE, workingRunIds: [runId] },
    });
    expect(agentIn(agents, office.otherAgentId)).toMatchObject({
      availability: "available",
      activity: "idle",
      evidence: NO_EVIDENCE,
    });
    expect(overview.agents).toMatchObject({
      total: 2,
      working: 1,
      stale: 0,
      held: 0,
      queued: 0,
      stopped: 0,
      inactive: 0,
    });
    expect(overview.runs).toMatchObject({ workingNow: 1, needingAttention: 0 });
    expect(more).toMatchObject({
      id: runId,
      status: "running",
      attention: null,
      job: { status: "leased", attempts: 1, leaseLive: true },
      coveringStop: null,
    });
    expect(
      (more as { jobSteps: { step: string }[] }).jobSteps.map((s) => s.step),
    ).toEqual(["job_leased"]);
    expect(await evidenceFaults(admin, TENANT_A, agents.items)).toEqual([]);
    // Positive control: the checker catches a summary that lies about the run.
    const lying = {
      ...agentIn(agents, office.agentId),
      evidence: { ...NO_EVIDENCE, queuedRunIds: [runId] },
    };
    expect(await evidenceFaults(admin, TENANT_A, [lying])).toEqual([
      expect.stringContaining(`queuedRunIds names ${runId}, which is not`),
    ]);
  }, 30_000);

  // What the SQL suite cannot prove: a lease that really ran out on the
  // database clock. The run is still `running` in the table, and the surface
  // must not call that work.
  it("reports a running run whose lease ran out as stale attention, never as working", async () => {
    const { office, runId, jobId } = await runningRun(
      "cos-stale",
      SHORT_LEASE_SECONDS,
    );
    await waitUntilLeaseEnded(jobId);

    const { agents, overview, more } = await readState(async (read) => ({
      run: await read("get_run", { p_run_id: runId }),
      attention: await read("list_runs", { p_attention_only: true }),
    }));

    expect(agentIn(agents, office.agentId)).toMatchObject({
      availability: "available",
      activity: "stale",
      attentionCount: 1,
      evidence: {
        ...NO_EVIDENCE,
        staleRunIds: [runId],
        attentionRunIds: [runId],
      },
    });
    expect(overview.agents).toMatchObject({ working: 0, stale: 1 });
    expect(overview.runs).toMatchObject({ workingNow: 0, needingAttention: 1 });
    expect(more).toMatchObject({
      run: {
        status: "running",
        attention: "running_without_live_lease",
        job: { status: "leased", leaseLive: false },
      },
      attention: { items: [{ id: runId }], nextCursor: null },
    });
    expect(await evidenceFaults(admin, TENANT_A, agents.items)).toEqual([]);
  }, 30_000);

  // What the SQL suite cannot prove: a live lease that belongs to a LATER
  // attempt. The reaper hands the job back and another worker leases it again,
  // so the job holds a live lease while the run still says `running` for the
  // attempt that lost its own. That lease is not the run's (brief §10: the
  // attempt must match), so the run is stale attention, never working.
  it("reports a running run as stale when the live lease on its job belongs to a later attempt", async () => {
    const { office, runId, jobId } = await runningRun(
      "cos-later-attempt",
      SHORT_LEASE_SECONDS,
    );
    await waitUntilLeaseEnded(jobId);
    expect(await reap()).toBe(1);
    expect(await leaseAsOther()).toBe(jobId);
    expect(await readRun(runId)).toMatchObject({
      status: "running",
      job_attempt: 1,
    });

    const { agents, overview, more } = await readState(async (read) => ({
      run: await read("get_run", { p_run_id: runId }),
      attention: await read("list_runs", { p_attention_only: true }),
    }));

    expect(agentIn(agents, office.agentId)).toMatchObject({
      availability: "available",
      activity: "stale",
      attentionCount: 1,
      evidence: {
        ...NO_EVIDENCE,
        staleRunIds: [runId],
        attentionRunIds: [runId],
      },
    });
    expect(overview.agents).toMatchObject({ working: 0, stale: 1 });
    expect(overview.runs).toMatchObject({ workingNow: 0, needingAttention: 1 });
    expect(more).toMatchObject({
      run: {
        status: "running",
        jobAttempt: 1,
        attention: "running_without_live_lease",
        // The job's own lease is live; it is attempt 2's, not the run's.
        job: { status: "leased", attempts: 2, leaseLive: true },
      },
      attention: { items: [{ id: runId }], nextCursor: null },
    });
    expect(await evidenceFaults(admin, TENANT_A, agents.items)).toEqual([]);
  }, 30_000);

  // What the SQL suite cannot prove: the runtime's own deferral. The stop
  // trips after the lease committed, the start finds it, and the job goes back
  // to the queue with its attempt given back (owner decision B).
  it("reports a run whose job a tenant stop deferred as held, the agent stopped, and that stop as evidence", async () => {
    const office = await buildOffice();
    const runId = await requestRun(office, "cos-held");
    const jobId = (await readRun(runId)).job_id as string;
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });
    let stopId: string | undefined;

    const result = await runOneJob(worker, {
      workerId: HOLDER,
      registry,
      onLeased: async (job: LeasedJob) => {
        expect(job.id).toBe(jobId);
        stopId = await trip({ scope: "tenant", tenantId: TENANT_A });
      },
    });

    expect(result).toMatchObject({ outcome: "deferred", jobId });
    expect(provider.calls).toHaveLength(0);
    const stop = { id: stopId, scope: "tenant", origin: "owner" };
    const { agents, overview, more } = await readState(async (read) => ({
      run: await read("get_run", { p_run_id: runId }),
      stops: await read("list_stops", {}),
    }));

    expect(agentIn(agents, office.agentId)).toMatchObject({
      availability: "stopped",
      activity: "held",
      evidence: { ...NO_EVIDENCE, heldRunIds: [runId], stop },
    });
    expect(agentIn(agents, office.otherAgentId)).toMatchObject({
      availability: "stopped",
      activity: "idle",
      evidence: { ...NO_EVIDENCE, stop },
    });
    expect(overview.agents).toMatchObject({
      total: 2,
      held: 1,
      queued: 0,
      working: 0,
      stopped: 2,
    });
    expect(overview.stops.tenantScopedActive).toBe(1);
    const { run, stops } = more as {
      run: { jobSteps: { step: string }[] };
      stops: { items: Record<string, unknown>[] };
    };
    expect(run).toMatchObject({
      status: "pending",
      job: { status: "queued", attempts: 0, leaseLive: false },
      coveringStop: stop,
    });
    expect(run.jobSteps.map((s) => s.step)).toEqual([
      "job_leased",
      "job_deferred",
    ]);
    expect(stops.items).toEqual([
      expect.objectContaining({
        id: stopId,
        scope: "tenant",
        origin: "owner",
        target: null,
        reason: TRIP.reason,
        clearedAt: null,
      }),
    ]);
    // The stored actor label never leaves (brief §9).
    expect(Object.keys(stops.items[0])).not.toContain("trippedBy");
    expect(JSON.stringify({ agents, overview, more })).not.toContain(
      TRIP_ACT.actor,
    );
    expect(await evidenceFaults(admin, TENANT_A, agents.items)).toEqual([]);
  }, 30_000);

  // What the SQL suite cannot prove: a committed queue, a committed stop on a
  // neighbour, and the coverage predicate the lease itself uses deciding
  // "queued" rather than "held".
  it("reports a pending run under no covering stop as queued, beside a neighbour's stop that covers other work only", async () => {
    const office = await buildOffice();
    const runId = await requestRun(office, "cos-queued");
    const neighbourStop = await trip({
      scope: "agent",
      tenantId: TENANT_A,
      companyId: office.companyId,
      agentId: office.otherAgentId,
    });

    const { agents, overview } = await readState();

    expect(agentIn(agents, office.agentId)).toMatchObject({
      availability: "available",
      activity: "queued",
      evidence: { ...NO_EVIDENCE, queuedRunIds: [runId] },
    });
    expect(agentIn(agents, office.otherAgentId)).toMatchObject({
      availability: "stopped",
      activity: "idle",
      evidence: {
        ...NO_EVIDENCE,
        stop: { id: neighbourStop, scope: "agent", origin: "owner" },
      },
    });
    expect(overview.agents).toMatchObject({ queued: 1, held: 0, stopped: 1 });
    expect(await evidenceFaults(admin, TENANT_A, agents.items)).toEqual([]);
  }, 30_000);

  // What the SQL suite cannot prove: a run the real runtime settled leaves its
  // agent idle, with no evidence and the last run's time.
  it("reports an agent whose only run has settled as idle, with that run's time", async () => {
    const office = await buildOffice();
    const runId = await requestRun(office, "cos-idle");
    const { registry } = fakeRuntime({ type: "respond", content: VALID });
    expect(
      (await runOneJob(worker, { workerId: HOLDER, registry })).outcome,
    ).toBe("succeeded");
    expect((await readRun(runId)).status).toBe("succeeded");

    const { agents, overview } = await readState();

    const agent = agentIn(agents, office.agentId);
    expect(agent).toMatchObject({
      availability: "available",
      activity: "idle",
      attentionCount: 0,
      evidence: NO_EVIDENCE,
    });
    expect(agent.lastRunAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    );
    expect(overview.agents).toMatchObject({ working: 0, queued: 0, held: 0 });
    expect(await evidenceFaults(admin, TENANT_A, agents.items)).toEqual([]);
  }, 30_000);

  // What the SQL suite cannot prove: the organisation's committed status
  // changes, made through the owner services, reaching the member's view; and
  // inactive winning over a stop that also covers the agent.
  it("reports an inactive agent, department or company as inactive, naming the unit, ahead of a stop", async () => {
    const office = await buildOffice();
    const ctx = { tenantId: TENANT_A, source: SOURCE };
    const units = await owner.withTransaction(async (tx) => {
      const facilities = await createDepartment(tx, ctx, {
        companyId: office.companyId,
        slug: "facilities",
        name: "Facilities",
      });
      const facilitiesAgent = await createAgent(tx, ctx, {
        companyId: office.companyId,
        departmentId: facilities,
        slug: "facilities-assistant",
        name: "Facilities assistant",
        role: "Facilities assistant",
      });
      const annex = await createCompany(tx, ctx, {
        slug: "dbtest-cos-annex",
        name: "Annex",
      });
      const reception = await createDepartment(tx, ctx, {
        companyId: annex,
        slug: "reception",
        name: "Reception",
      });
      const annexAgent = await createAgent(tx, ctx, {
        companyId: annex,
        departmentId: reception,
        slug: "reception-assistant",
        name: "Reception assistant",
        role: "Reception assistant",
      });
      await setAgentStatus(tx, ctx, office.otherAgentId, "inactive");
      await setDepartmentStatus(tx, ctx, facilities, "inactive");
      await setCompanyStatus(tx, ctx, annex, "inactive");
      return { facilitiesAgent, annex, annexAgent };
    });
    await trip({
      scope: "company",
      tenantId: TENANT_A,
      companyId: units.annex,
    });

    const { agents, overview } = await readState();

    expect(agentIn(agents, office.agentId)).toMatchObject({
      availability: "available",
      evidence: { inactiveUnit: null },
    });
    for (const [agentId, unit] of [
      [office.otherAgentId, "agent"],
      [units.facilitiesAgent, "department"],
      [units.annexAgent, "company"],
    ] as const) {
      expect(agentIn(agents, agentId), unit).toMatchObject({
        availability: "inactive",
        activity: "idle",
        evidence: { inactiveUnit: unit },
      });
    }
    expect(overview.agents).toMatchObject({
      total: 4,
      inactive: 3,
      stopped: 0,
    });
    expect(await evidenceFaults(admin, TENANT_A, agents.items)).toEqual([]);
  }, 30_000);

  // What the SQL suite cannot prove: a stop tripped while a real call is in
  // flight. The call may finish (ADR 0017), so one enum would have to lie; the
  // two axes report both, each with its evidence.
  it("reports working and stopped together when an agent stop trips while its run holds a live lease", async () => {
    const { office, runId } = await runningRun("cos-working-stopped");
    const stopId = await trip(agentTarget(office));

    const { agents, overview, more } = await readState((read) =>
      read("get_run", { p_run_id: runId }),
    );

    const stop = { id: stopId, scope: "agent", origin: "owner" };
    expect(agentIn(agents, office.agentId)).toMatchObject({
      availability: "stopped",
      activity: "working",
      evidence: { ...NO_EVIDENCE, workingRunIds: [runId], stop },
    });
    expect(agentIn(agents, office.otherAgentId)).toMatchObject({
      availability: "available",
      activity: "idle",
    });
    expect(overview.agents).toMatchObject({ working: 1, stopped: 1 });
    expect(more).toMatchObject({
      status: "running",
      job: { status: "leased", leaseLive: true },
      coveringStop: stop,
    });
    expect(await evidenceFaults(admin, TENANT_A, agents.items)).toEqual([]);
  }, 30_000);
});
