// Agent runs interrupted around the model call, against a real Postgres through
// the real `pg` driver, the real worker runtime and the real agent run handler,
// with a scripted model provider standing in for the vendor.
//
// supabase/tests/agent_runtime.sql takes every lease by hand on ONE connection.
// This file proves what needs a real worker process or the real runtime's
// deadlines:
//
//   * a second process sharing the worker id of a call in flight can neither
//     claim nor restart that run, and the crash that follows is recovered
//     without a second call;
//   * a retried attempt holding a stale claim is settled at start and never
//     calls again;
//   * a lease that runs out during the call records the run at the
//     lease-derived deadline, or leaves it to the sweep;
//   * a graceful shutdown aborts the call in flight and records it.
//
// Every case counts provider calls. It lives in engine/domain because only
// there may a test import the domain services, the worker runtime and the
// database fixture together (eslint.config.js). All data is synthetic
// office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { createFakeModelProvider } from "../models/fakeModelProvider.ts";
import { MODEL_ROUTE_POLICIES } from "../models/router.ts";
import { TASK_ASSESSMENT_PROMPT_VERSION } from "../models/taskAssessment.ts";
import type { ModelProvider, ModelRequest } from "../models/types.ts";
import { grantCapabilities } from "../worker/capabilities.ts";
import { runWorker } from "../worker/runWorker.ts";
import { readJob, resetFixtures } from "../worker/testSupport/dbFixture.ts";
import {
  modelCallsStarted,
  requestStop,
  spawnAgentRunWorker,
} from "./testSupport/agentRunProcesses.ts";
import {
  agentRunHandler,
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  fakeRuntime,
  MODEL,
  openAgentRuntimeDatabases,
  registryServing,
  rejectionOf,
  reusingFirstClaim,
  SHARED_LEASE_BUDGET,
  VALID,
  withinMs,
} from "./testSupport/agentRuntimeProbes.ts";

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

const {
  buildOfficeTask,
  expireLease,
  onSharedLease,
  readRun,
  requestRun,
  runAgentJob,
  runEvents,
  sweepStaleRuns,
} = agentRuntimeProbes(() => ({ admin, owner, db }));

// ---------------------------------------------------------------------------
// 2 and 3. Crashes around the call
// ---------------------------------------------------------------------------

describe("a second process that shares the worker id of a call in flight", () => {
  // What the SQL suite cannot prove (L4 claims twice on ONE connection, with no
  // call anywhere): a REAL process has committed `running` and its call is on
  // the wire under a live lease, and a second process configured with the same
  // worker id resumes that lease (AR-03). The real handler's claim must refuse
  // rather than settle the run from under the call; a start made without a claim
  // must answer `already_running`, never `running`; and the crash that follows
  // is still recovered without a second call.
  it("refuses to claim or restart a run whose own attempt's call is still in flight, and the crash that follows is recovered without a second call", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "shared-worker-id");
    const jobId = (await readRun(runId)).job_id as string;
    const workerId = "dbtest-agent-shared-id";
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });
    const handler = agentRunHandler(registry);
    const first = spawnAgentRunWorker(workerId, "hang");
    try {
      await first.modelCallStarted;
      const inFlight = await readRun(runId);
      expect(inFlight).toMatchObject({ status: "running", job_attempt: 1 });

      const claim = await rejectionOf(
        onSharedLease(workerId, jobId, (tx, job) =>
          handler.prepare(
            job,
            grantCapabilities(tx, handler.prepareCapabilities),
            SHARED_LEASE_BUDGET,
          ),
        ),
      );
      expect(claim).toMatchObject({ code: "42501" });
      expect((claim as Error).message).toMatch(/never claimed twice/);

      const start = await onSharedLease(workerId, jobId, (tx) =>
        grantCapabilities(tx, ["startAgentRun"]).startAgentRun({
          provider: "fake",
          model: MODEL,
          promptVersion: TASK_ASSESSMENT_PROMPT_VERSION,
          inputFingerprint: inFlight.input_fingerprint as string,
          maxOutputTokens: MODEL_ROUTE_POLICIES.standard.maxOutputTokens,
        }),
      );
      expect(start).toBe("already_running");

      expect(await readRun(runId)).toEqual(inFlight);
      expect(provider.calls).toHaveLength(0);
    } finally {
      first.child.kill("SIGKILL");
    }
    expect(modelCallsStarted((await first.closed).stdout)).toBe(1);

    await expireLease(jobId);
    const recovered = await runAgentJob(registry);

    expect(provider.calls).toHaveLength(0);
    expect(recovered).toMatchObject({
      outcome: "succeeded",
      jobId,
      attempt: 2,
      detail: `agent_run=${runId} status=indeterminate`,
    });
    expect(await readRun(runId)).toMatchObject({
      status: "indeterminate",
      error_category: "interrupted",
      error_code: "execution_interrupted",
      job_attempt: 1,
      result: null,
    });
  }, 60_000);
});

describe("a retried attempt that reaches start with a stale claim", () => {
  // What the SQL suite cannot prove (N3 calls a later attempt's start by hand):
  // that the database's START, on its own, keeps a second paid call from leaving
  // the real runtime. This handler reuses its first claim, so the job's next
  // attempt reaches ops.start_agent_run still believing the run is pending. The
  // start must settle the crashed attempt's run; a start that answered `running`
  // for a run already running would send the call again.
  it("settles a crashed attempt's run at the next attempt's start even when that attempt reuses a stale claim, and never calls the provider again", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "stale-claim");
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });
    const stale = reusingFirstClaim(registry);

    await expect(
      runAgentJob(stale, {
        onCallFinished: async () => {
          throw new Error("process died after the answer arrived");
        },
      }),
    ).rejects.toThrow(/process died/);
    const started = await readRun(runId);
    expect(started).toMatchObject({ status: "running", job_attempt: 1 });
    expect(provider.calls).toHaveLength(1);
    const jobId = started.job_id as string;
    await expireLease(jobId);

    const retry = await runAgentJob(stale);

    expect(provider.calls).toHaveLength(1);
    expect(retry).toMatchObject({
      outcome: "succeeded",
      jobId,
      attempt: 2,
      detail: `agent_run=${runId} status=indeterminate`,
    });
    expect(await readRun(runId)).toMatchObject({
      status: "indeterminate",
      error_category: "interrupted",
      error_code: "execution_interrupted",
      job_attempt: 1,
      input_fingerprint: started.input_fingerprint,
      result: null,
    });
    expect((await runEvents(runId)).map((e) => e.type)).toEqual([
      "agent_run.requested",
      "agent_run.started",
      "agent_run.indeterminate",
    ]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4. The lease runs out during the call
// ---------------------------------------------------------------------------

describe("a lease that runs out while the model call is in flight", () => {
  // What the SQL suite cannot prove: that the deadline runOneJob derives from
  // the DATABASE's view of the lease actually aborts a slow provider, and that
  // the handler records that abort as a timeout rather than a cancellation or,
  // worse, waits for the answer and records success.
  it("records the run as indeterminate timeout at the lease-derived deadline, with one provider call", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "slow-provider");
    const { provider, registry } = fakeRuntime({
      type: "delay",
      ms: 60_000,
      then: { type: "respond", content: VALID },
    });

    // 8 s lease - 2 s margin: the call gets about 6 s, above the 5 s minimum.
    const result = await runAgentJob(registry, {
      leaseSeconds: 8,
      leaseSafetyMarginMs: 2_000,
    });

    expect(result.outcome).toBe("succeeded");
    expect(result.detail).toMatch(/status=indeterminate .*category=timeout$/);
    expect(provider.calls).toHaveLength(1);
    expect(await readRun(runId)).toMatchObject({
      status: "indeterminate",
      error_category: "timeout",
      error_code: "deadline",
      result: null,
    });
  }, 60_000);

  // What the SQL suite cannot prove: with no margin, the deadline IS the lease
  // expiry, so the settle transaction finds the lease gone. The runtime must
  // then record nothing about the run (it is not this attempt's any more), and
  // the sweep, not a retry, settles it.
  it("leaves the run to the sweep when the lease is already gone at settlement, and it never reads succeeded", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "slow-provider-no-margin");
    const { provider, registry } = fakeRuntime({
      type: "delay",
      ms: 60_000,
      then: { type: "respond", content: VALID },
    });

    let leaseGoneAtSettlement: boolean | undefined;
    const result = await runAgentJob(registry, {
      leaseSeconds: 7,
      leaseSafetyMarginMs: 0,
      onCallFinished: async (job) => {
        const { rows } = await admin.query<{ gone: boolean }>(
          "select lease_expires_at <= clock_timestamp() as gone from ops.jobs where id = $1",
          [job.id],
        );
        leaseGoneAtSettlement = rows[0]?.gone;
      },
    });

    expect(leaseGoneAtSettlement).toBe(true);
    expect(result).toMatchObject({
      outcome: "failed",
      failureClass: "security",
    });
    expect(provider.calls).toHaveLength(1);
    expect((await readRun(runId)).status).toBe("running");

    expect(await sweepStaleRuns()).toBe(1);
    expect(await readRun(runId)).toMatchObject({
      status: "indeterminate",
      error_category: "interrupted",
      result: null,
    });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 11. Graceful shutdown
// ---------------------------------------------------------------------------

describe("graceful shutdown during a model call", () => {
  // What the SQL suite cannot prove: that the worker loop's shutdown signal
  // reaches the provider call in flight, and that the aborted call is RECORDED
  // (indeterminate, cancelled) with its job settled before the loop stops,
  // instead of being left running for the sweep.
  //
  // The run alone cannot show the first half: the runtime abandons a call that
  // ignores its signal after a short grace and records the same outcome. So the
  // provider keeps the signal it was handed and whether its own call ended, and
  // both are asserted.
  it("aborts the in-flight call, records the run indeterminate cancelled, settles its job and stops the loop", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "shutdown");
    const fake = createFakeModelProvider({ type: "hang" });
    let providerSignal: AbortSignal | undefined;
    let providerCallEnded = false;
    const provider: ModelProvider = Object.freeze({
      name: fake.name,
      execute(request: ModelRequest, signal: AbortSignal) {
        providerSignal = signal;
        return fake.execute(request, signal).finally(() => {
          providerCallEnded = true;
        });
      },
    });
    const registry = registryServing(provider);
    const controller = new AbortController();
    const workerId = "dbtest-agent-shutdown";

    const stopped = runWorker({
      workerId,
      db,
      registry,
      signal: controller.signal,
      pollIntervalMs: 25,
      heartbeatIntervalMs: 60_000,
      reapIntervalMs: 60_000,
      leaseSeconds: 60,
    });
    await Promise.race([
      fake.callStarted(),
      stopped.then(() => {
        throw new Error("the worker stopped before its model call started");
      }),
    ]);
    controller.abort();
    const stats = await withinMs(
      stopped,
      10_000,
      "the worker loop did not stop within 10 s of shutdown",
    );

    // Shutdown reached the provider's own signal, and the call ended on it:
    // it was not abandoned by the runtime's grace timer.
    expect(providerSignal?.aborted).toBe(true);
    expect(providerCallEnded).toBe(true);
    expect(stats).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
    expect(fake.calls).toHaveLength(1);
    const run = await readRun(runId);
    expect(run).toMatchObject({
      status: "indeterminate",
      error_category: "cancelled",
      error_code: "aborted",
      result: null,
    });
    expect((await readJob(admin, run.job_id as string)).status).toBe(
      "succeeded",
    );
    const { rows } = await admin.query<{ stopped: boolean }>(
      "select stopped_at is not null as stopped from ops.worker_instances where worker_id = $1",
      [workerId],
    );
    expect(rows).toEqual([{ stopped: true }]);
  }, 30_000);

  // What the in-process case above cannot prove: a real worker PROCESS asked to
  // stop from outside while its call is on the wire (SIGTERM on POSIX, as
  // main.ts wires it; stdin on win32). The process's own stop wiring must reach
  // the call, and the run is recorded and the job settled before it exits 0, so
  // nothing is left running for the sweep.
  it("stops a real worker process mid-call when asked, recording the run indeterminate cancelled and settling its job before it exits", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "process-stop");
    const jobId = (await readRun(runId)).job_id as string;
    const workerId = "dbtest-agent-process-stop";
    const worker = spawnAgentRunWorker(workerId, "hang");

    const exit = await (async () => {
      try {
        await worker.modelCallStarted;
        requestStop(worker.child);
        return await withinMs(
          worker.closed,
          15_000,
          `${workerId} did not exit within 15 s of being asked to stop`,
        );
      } finally {
        worker.child.kill("SIGKILL");
      }
    })();

    expect(exit.code, exit.stderr).toBe(0);
    expect(modelCallsStarted(exit.stdout)).toBe(1);
    const report = JSON.parse(exit.stdout.trim().split("\n").at(-1) ?? "");
    expect(report).toMatchObject({
      workerId,
      calls: 1,
      stats: { leased: 1, succeeded: 1, retried: 0, failed: 0 },
    });
    expect(await readRun(runId)).toMatchObject({
      status: "indeterminate",
      error_category: "cancelled",
      error_code: "aborted",
      job_attempt: 1,
      result: null,
    });
    expect(await readJob(admin, jobId)).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
    expect(await sweepStaleRuns()).toBe(0);
  }, 60_000);
});
