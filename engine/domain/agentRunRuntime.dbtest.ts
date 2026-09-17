// The agent runtime against a real Postgres: the real `pg` driver, the real
// constrained worker role, the real worker runtime and the real agent run
// handler, with a scripted model provider standing in for the vendor.
//
// supabase/tests/agent_runtime.sql attacks the database with psql, inside ONE
// rolled-back transaction, on leases it takes by hand. It cannot see what this
// file proves:
//
//   * that runOneJob's separately COMMITTED transactions around the model call
//     leave the database in the states the SQL cases assume, in that order;
//   * what a model call leaves behind when a REAL worker process is killed while
//     the call is in flight, or when a worker dies after the answer arrived;
//   * that a job retried after its settlement failed never calls again;
//   * the kill switch end to end, at request, at the lease and at start;
//   * that a forged job payload never reaches another tenant's run.
//
// Interruptions (a shared worker id, a stale claim, a lease that runs out, a
// graceful shutdown) are in agentRunInterruptions.dbtest.ts; the contracts the
// runtime shares with the database (failure categories, pooling, the state
// machines, where a test worker may point) are in agentRunContracts.dbtest.ts.
//
// Every case counts provider calls. "A run is started once" is proven only by a
// count that stays at one across a crash, a retry and a recovery.
//
// It lives in engine/domain because only there may a test import the domain
// services, the worker runtime and the database fixture together
// (eslint.config.js). All data is synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import { AGENT_RUN_EXECUTE_KIND } from "../handlers/agentRunExecute.ts";
import { fingerprintModelRequest } from "../models/fingerprint.ts";
import { TASK_ASSESSMENT_PROMPT_VERSION } from "../models/taskAssessment.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import { runWorker } from "../worker/runWorker.ts";
import {
  readJob,
  resetFixtures,
  TENANT_A,
  TENANT_B,
  WORKER_URL,
} from "../worker/testSupport/dbFixture.ts";
import { clearExecutionStop, tripExecutionStop } from "./executionStops.ts";
import { spawnAgentRunWorker } from "./testSupport/agentRunProcesses.ts";
import {
  AGENT_SENTINEL,
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  fakeRuntime,
  MODEL,
  openAgentRuntimeDatabases,
  TASK_SENTINEL,
  VALID,
  WORKER,
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
  countJobs,
  expireLease,
  readRun,
  readTaskRow,
  requestRun,
  runAgentJob,
  runEvents,
  sweepStaleRuns,
} = agentRuntimeProbes(() => ({ admin, owner, db }));

// ---------------------------------------------------------------------------
// 1. The first demonstration flow
// ---------------------------------------------------------------------------

describe("an agent run through the real worker runtime", () => {
  // What the SQL suite cannot prove: that the handler, the router and three
  // committed runtime transactions together store exactly the facts of the
  // call the PROVIDER received (the stored fingerprint is recomputed from the
  // request the fake actually got), that tenant text reaches the model and
  // nowhere else the database keeps, that the job ledger's detail is metadata
  // only, and that the whole flow leaves the task row byte-identical.
  it("assesses an assigned task with one provider call, stores the facts of that call, and never touches the task", async () => {
    const office = await buildOfficeTask();
    const taskBefore = await readTaskRow(office.taskId);
    const runId = await requestRun(office, "supply-order-1");
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });

    const result = await runAgentJob(registry);

    expect(result.outcome).toBe("succeeded");
    expect(provider.calls).toHaveLength(1);
    const run = await readRun(runId);
    expect(run).toMatchObject({
      status: "succeeded",
      provider: "fake",
      model: MODEL,
      response_model: MODEL,
      prompt_version: TASK_ASSESSMENT_PROMPT_VERSION,
      job_attempt: 1,
      finish_reason: "completed",
      provider_request_id: "fake-req-1",
      provider_response_id: "fake-resp-1",
      input_tokens: 120,
      output_tokens: 60,
      total_tokens: 180,
      cached_input_tokens: 0,
      reasoning_tokens: 0,
      error_category: null,
      error_code: null,
      stop_id: null,
    });
    expect(run.latency_ms).toBeGreaterThanOrEqual(0);
    expect(run.result).toEqual(VALID);
    expect(Object.keys(run.result as object).sort()).toEqual([
      "outcome",
      "proposed_next_steps",
      "summary",
    ]);

    // The fingerprint names the request the provider actually received.
    const sent = provider.calls[0];
    expect(run.input_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(run.input_fingerprint).toBe(
      fingerprintModelRequest(sent, "fake", TASK_ASSESSMENT_PROMPT_VERSION),
    );

    // Tenant text reached the model; no identifier did.
    const sentText = JSON.stringify(sent);
    expect(sentText).toContain(TASK_SENTINEL);
    expect(sentText).toContain(AGENT_SENTINEL);
    const jobId = run.job_id as string;
    for (const id of [
      office.tenantId,
      office.companyId,
      office.departmentId,
      office.agentId,
      office.taskId,
      runId,
      jobId,
    ]) {
      expect(sentText).not.toContain(id);
    }

    // Nothing the database keeps about the run holds the tenant text, and the
    // job ledger holds no model answer either.
    const { rows: runText } = await admin.query<{ text: string }>(
      "select row_to_json(r)::text as text from ops.agent_runs r where r.id = $1",
      [runId],
    );
    const { rows: ledgerText } = await admin.query<{ text: string }>(
      `select e.payload::text as text from ops.events e
        where e.subject_type = 'agent_run' and e.subject_id = $1
       union all
       select row_to_json(j)::text from ops.jobs j where j.id = $2
       union all
       select coalesce(je.detail, '') from ops.job_events je where je.job_id = $2`,
      [runId, jobId],
    );
    expect(runText).toHaveLength(1);
    expect(ledgerText.length).toBeGreaterThanOrEqual(6);
    for (const { text } of [...runText, ...ledgerText]) {
      expect(text).not.toContain(TASK_SENTINEL);
      expect(text).not.toContain(AGENT_SENTINEL);
    }
    for (const { text } of ledgerText) {
      expect(text).not.toContain(VALID.summary);
    }
    const { rows: succeeded } = await admin.query<{ detail: string }>(
      "select detail from ops.job_events where job_id = $1 and event = 'succeeded'",
      [jobId],
    );
    expect(succeeded).toEqual([
      {
        detail: `agent_run=${runId} status=succeeded route=standard provider=fake model=${MODEL} input_tokens=120 output_tokens=60 category=-`,
      },
    ]);

    // Exactly three facts, one correlation, each caused by the one before.
    const events = await runEvents(runId);
    expect(events.map((e) => e.type)).toEqual([
      "agent_run.requested",
      "agent_run.started",
      "agent_run.succeeded",
    ]);
    expect(new Set(events.map((e) => e.correlation_id))).toEqual(
      new Set([run.correlation_id]),
    );
    expect(events.map((e) => e.causation_id)).toEqual([
      null,
      events[0].id,
      events[1].id,
    ]);

    expect(await readTaskRow(office.taskId)).toEqual(taskBefore);
    expect((await readJob(admin, jobId)).status).toBe("succeeded");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2 and 3. Crashes around the call
// ---------------------------------------------------------------------------

/**
 * Requests a run, lets a spawned worker process start its model call, and
 * SIGKILLs the process while the call is in flight. Then expires the lease, so
 * recovery is driven by the database's clock rather than by waiting it out.
 */
async function killWorkerDuringCall(workerId: string) {
  const office = await buildOfficeTask();
  const runId = await requestRun(office, `crash-${workerId}`);
  const worker = spawnAgentRunWorker(workerId, "hang");
  try {
    await worker.modelCallStarted;
  } finally {
    worker.child.kill("SIGKILL");
    await worker.closed;
  }

  // The start was committed BEFORE the call left the process.
  const run = await readRun(runId);
  expect(run).toMatchObject({ status: "running", job_attempt: 1 });
  expect(run.started_at).not.toBeNull();
  const jobId = run.job_id as string;
  expect(await readJob(admin, jobId)).toMatchObject({
    status: "leased",
    attempts: 1,
    lease_owner: workerId,
  });

  await expireLease(jobId);
  return { runId, jobId };
}

describe("a worker process killed while its model call is in flight", () => {
  // What the SQL suite cannot prove: that a real process, killed with no
  // shutdown hook while the provider call is on the wire, has already
  // committed `running` (the prepare transaction is durable before the call),
  // and that the stale-run sweep followed by a real worker loop settles the
  // run without issuing the call again.
  it("is recovered by the stale-run sweep as indeterminate, and the next worker never calls the provider", async () => {
    const { runId, jobId } = await killWorkerDuringCall(
      "dbtest-agent-crash-sweep",
    );

    expect(await sweepStaleRuns()).toBe(1);
    const swept = await readRun(runId);
    expect(swept).toMatchObject({
      status: "indeterminate",
      error_category: "interrupted",
      error_code: "execution_interrupted",
      result: null,
    });

    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });
    const stats = await runWorker({
      workerId: "dbtest-agent-recoverer",
      db,
      registry,
      maxIterations: 2,
      pollIntervalMs: 10,
      reapIntervalMs: 0,
      heartbeatIntervalMs: 60_000,
    });

    expect(provider.calls).toHaveLength(0);
    expect(stats).toMatchObject({ leased: 1, succeeded: 1 });
    expect(await readRun(runId)).toEqual(swept);
    expect(await readJob(admin, jobId)).toMatchObject({
      status: "succeeded",
      attempts: 2,
    });
  }, 60_000);

  // What the SQL suite cannot prove: the same crash with NO sweep in between,
  // so what stands between a job retry and a second paid call is the next
  // attempt's own claim and start on a real re-lease (lease_job reaps the
  // expired lease and hands the job straight back as attempt 2).
  it("is settled indeterminate by the job's next attempt when no sweep ran, and the provider is never called", async () => {
    const { runId, jobId } = await killWorkerDuringCall(
      "dbtest-agent-crash-claim",
    );
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });

    const result = await runAgentJob(registry);

    expect(result).toMatchObject({
      outcome: "succeeded",
      jobId,
      attempt: 2,
      detail: `agent_run=${runId} status=indeterminate`,
    });
    expect(provider.calls).toHaveLength(0);
    expect(await readRun(runId)).toMatchObject({
      status: "indeterminate",
      error_category: "interrupted",
      error_code: "execution_interrupted",
      job_attempt: 1,
      result: null,
    });
    expect((await readJob(admin, jobId)).status).toBe("succeeded");
  }, 60_000);
});

describe("a worker that dies after the provider answered", () => {
  // What the SQL suite cannot prove: the window between a PAID answer and the
  // settle transaction, on the real runtime. The answer is lost rather than
  // bought twice: the run stays running, the sweep settles it indeterminate,
  // and the job's next attempt does not call again.
  it("never calls again for a run whose answer arrived but was never settled", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "answered-then-died");
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });

    await expect(
      runAgentJob(registry, {
        onCallFinished: async () => {
          throw new Error("process died after the answer arrived");
        },
      }),
    ).rejects.toThrow(/process died/);

    expect(provider.calls).toHaveLength(1);
    const run = await readRun(runId);
    expect(run).toMatchObject({ status: "running", result: null });
    const jobId = run.job_id as string;
    expect((await readJob(admin, jobId)).status).toBe("leased");

    await expireLease(jobId);
    expect(await sweepStaleRuns()).toBe(1);
    expect(await readRun(runId)).toMatchObject({
      status: "indeterminate",
      error_category: "interrupted",
      result: null,
    });

    const again = await runAgentJob(registry);
    expect(again).toMatchObject({ outcome: "succeeded", attempt: 2 });
    expect(provider.calls).toHaveLength(1);
    expect((await readRun(runId)).status).toBe("indeterminate");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 7. No blind retry
// ---------------------------------------------------------------------------

describe("a job retried after its settlement failed", () => {
  // What the SQL suite cannot prove: the runtime's own failure path after a
  // PAID call. The settle transaction is refused (the lease ran out between the
  // answer and the settlement), the failure path cannot record it either, and
  // the job comes back as a second attempt that must not buy the answer again.
  it("does not call the provider again when settlement was refused because the lease ran out", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "settle-refused");
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });

    const first = await runAgentJob(registry, {
      onCallFinished: async (job) => {
        await expireLease(job.id);
      },
    });

    expect(first).toMatchObject({
      outcome: "failed",
      failureClass: "security",
    });
    expect(first.detail).toMatch(/lease could not be resumed/);
    expect((await readRun(runId)).status).toBe("running");

    const retry = await runAgentJob(registry);

    expect(retry).toMatchObject({ outcome: "succeeded", attempt: 2 });
    expect(provider.calls).toHaveLength(1);
    expect(await readRun(runId)).toMatchObject({
      status: "indeterminate",
      error_category: "interrupted",
      result: null,
    });
  }, 30_000);

  // What the SQL suite cannot prove: a TRANSIENT settle failure while the lease
  // is still live, which the runtime records as a scheduled retry of the job
  // (settle_job_failure -> 'retry'). That retry is exactly where a naive worker
  // would issue the call again.
  it("does not call the provider again when settlement failed transiently and the runtime scheduled the job's retry", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "settle-transient");
    const jobId = (await readRun(runId)).job_id as string;
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });
    // A short statement timeout, so a settle blocked on the run's row lock
    // fails as 57014 (transient) in seconds.
    const shortStatements = createWorkerDatabase({
      connectionString: WORKER_URL,
      max: 2,
      statementTimeoutMs: 2_000,
    });
    const locker = await admin.connect();
    try {
      const first = await runOneJob(shortStatements, {
        workerId: WORKER,
        registry,
        onCallFinished: async () => {
          await locker.query("begin");
          await locker.query(
            "select 1 from ops.agent_runs where id = $1 for update",
            [runId],
          );
        },
      });
      await locker.query("rollback");

      expect(first).toMatchObject({
        outcome: "retry",
        failureClass: "transient",
      });
      expect(first.detail).toMatch(/^57014/);
      expect((await readRun(runId)).status).toBe("running");
      expect(await readJob(admin, jobId)).toMatchObject({
        status: "queued",
        attempts: 1,
        last_error_class: "transient",
      });

      await admin.query(
        "update ops.jobs set available_at = now() where id = $1",
        [jobId],
      );
      const retry = await runOneJob(shortStatements, {
        workerId: WORKER,
        registry,
      });

      expect(retry).toMatchObject({ outcome: "succeeded", attempt: 2 });
      expect(provider.calls).toHaveLength(1);
      expect(await readRun(runId)).toMatchObject({
        status: "indeterminate",
        error_category: "interrupted",
        result: null,
      });
    } finally {
      await locker.query("rollback").catch(() => undefined);
      locker.release();
      await shortStatements.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 8. The kill switch
// ---------------------------------------------------------------------------

describe("the kill switch, end to end", () => {
  // What the SQL suite cannot prove: the switch through the owner services and
  // the real worker, with a provider that would answer. A global stop refuses
  // the REQUEST (a recorded, cancelled run and no job). An agent stop tripped
  // before the job is leased HOLDS it at the lease (ADR 0017 §6): the job stays
  // queued, no attempt is spent, and the run stays pending. An agent stop
  // tripped after the lease committed, and before the prepare, HOLDS the run at
  // START (owner decision B): nothing is recorded, the job is deferred with its
  // attempt given back, and the same run starts once the stop is cleared. The
  // provider count is what shows no call slipped through.
  it("refuses a run at request under a global stop and holds it at the lease and at start under an agent stop, with no provider call, and runs that same run once cleared", async () => {
    const office = await buildOfficeTask();
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });
    const trip = { reason: "dbtest kill switch drill", actor: "dbtest" };
    const clear = { reason: "dbtest drill over", actor: "dbtest" };
    const agentTarget = {
      scope: "agent",
      tenantId: office.tenantId,
      companyId: office.companyId,
      agentId: office.agentId,
    } as const;

    const globalStop = await owner.withTransaction((tx) =>
      tripExecutionStop(tx, { scope: "global" }, trip),
    );
    const refusedAtRequest = await requestRun(office, "stop-global");
    expect(await readRun(refusedAtRequest)).toMatchObject({
      status: "cancelled",
      error_category: "refused",
      error_code: "execution_stopped",
      stop_id: globalStop,
      job_id: null,
    });
    expect(await countJobs(office.tenantId)).toBe(0);
    expect((await runAgentJob(registry)).outcome).toBe("idle");
    await owner.withTransaction((tx) =>
      clearExecutionStop(tx, globalStop, clear),
    );

    const heldRun = await requestRun(office, "stop-agent");
    const pending = await readRun(heldRun);
    expect(pending.status).toBe("pending");
    const jobId = pending.job_id as string;

    const heldStop = await owner.withTransaction((tx) =>
      tripExecutionStop(tx, agentTarget, trip),
    );
    expect((await runAgentJob(registry)).outcome).toBe("idle");
    expect(await readJob(admin, jobId)).toMatchObject({
      status: "queued",
      attempts: 0,
      lease_owner: null,
    });
    expect((await readRun(heldRun)).status).toBe("pending");
    await owner.withTransaction((tx) =>
      clearExecutionStop(tx, heldStop, clear),
    );

    let agentStop: string | undefined;
    expect(
      await runAgentJob(registry, {
        onLeased: async (job) => {
          expect(job.id).toBe(jobId);
          agentStop = await owner.withTransaction((tx) =>
            tripExecutionStop(tx, agentTarget, trip),
          );
        },
      }),
    ).toMatchObject({
      outcome: "deferred",
      jobId,
      attempt: 1,
      detail: `held by execution stop ${agentStop}`,
    });
    expect(agentStop).toBeDefined();
    expect(await readRun(heldRun)).toMatchObject({
      status: "pending",
      error_code: null,
      stop_id: null,
      provider: null,
      job_attempt: null,
    });
    expect(await readJob(admin, jobId)).toMatchObject({
      status: "queued",
      attempts: 0,
      lease_owner: null,
    });
    await owner.withTransaction((tx) =>
      clearExecutionStop(tx, agentStop as string, clear),
    );
    expect(provider.calls).toHaveLength(0);

    // Once the deferral's delay has passed, the same run starts and calls once.
    await admin.query(
      "update ops.jobs set available_at = now() where id = $1 and status = 'queued'",
      [jobId],
    );
    expect(await runAgentJob(registry)).toMatchObject({
      outcome: "succeeded",
      jobId,
      attempt: 1,
    });
    expect(await readRun(heldRun)).toMatchObject({
      status: "succeeded",
      job_attempt: 1,
      stop_id: null,
    });
    expect(provider.calls).toHaveLength(1);
    expect(await countJobs(office.tenantId)).toBe(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 9. Payload forgery
// ---------------------------------------------------------------------------

describe("a job payload that names another tenant's run", () => {
  // What the SQL suite cannot prove: that the WORKER, handed a forged job at
  // the head of the real queue, fails it as a security refusal and reaches
  // neither the named run nor the provider.
  it("fails a forged agent_run.execute job as a security refusal and leaves the other tenant's run untouched", async () => {
    const officeB = await buildOfficeTask(TENANT_B);
    const runB = await requestRun(officeB, "tenant-b-run");
    const runBBefore = await readRun(runB);
    const eventsBefore = await runEvents(runB);
    const { rows } = await admin.query<{ id: string }>(
      "select ops.enqueue_job($1, $2, $3::jsonb, -2147483648, now(), 5, null) as id",
      [
        TENANT_A,
        AGENT_RUN_EXECUTE_KIND,
        JSON.stringify({ agent_run_id: runB }),
      ],
    );
    const forged = rows[0].id;
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });

    const result = await runAgentJob(registry);

    expect(result).toMatchObject({
      jobId: forged,
      tenantId: TENANT_A,
      outcome: "failed",
      failureClass: "security",
    });
    expect(result.detail).toMatch(/no agent run is bound to the leased job/);
    expect(provider.calls).toHaveLength(0);
    expect(await readRun(runB)).toEqual(runBBefore);
    expect(await runEvents(runB)).toEqual(eventsBefore);
    expect(await readJob(admin, runBBefore.job_id as string)).toMatchObject({
      status: "queued",
      attempts: 0,
    });
  }, 30_000);

  // What neither the SQL suite nor the handler's unit tests can prove: the
  // handler's own payload check on a REAL claim. The job is the one bound to
  // tenant A's run, so the database hands over A's run; its payload, rewritten
  // by the owner, names tenant B's. The attempt must be refused before the run
  // is started.
  it("refuses a run's own job whose payload was rewritten to another tenant's run, before anything is started", async () => {
    const officeA = await buildOfficeTask(TENANT_A);
    const officeB = await buildOfficeTask(TENANT_B);
    const runA = await requestRun(officeA, "tenant-a-run");
    const runB = await requestRun(officeB, "tenant-b-run");
    const runBBefore = await readRun(runB);
    const jobA = (await readRun(runA)).job_id as string;
    await admin.query(
      `update ops.jobs
          set payload = jsonb_build_object('agent_run_id', $2::uuid),
              priority = -2147483648
        where id = $1`,
      [jobA, runB],
    );
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });

    const result = await runAgentJob(registry);

    expect(result).toMatchObject({
      jobId: jobA,
      tenantId: TENANT_A,
      outcome: "failed",
      failureClass: "security",
    });
    expect(result.detail).toMatch(
      /does not name the run its lease is bound to/,
    );
    expect(provider.calls).toHaveLength(0);
    expect(await readRun(runA)).toMatchObject({
      status: "pending",
      provider: null,
      job_attempt: null,
    });
    expect((await runEvents(runA)).map((e) => e.type)).toEqual([
      "agent_run.requested",
    ]);
    expect(await readRun(runB)).toEqual(runBBefore);
  }, 30_000);
});
