// The owner's execution stop CLI (ADR 0017 §5, §6) against a real Postgres: the
// job_kind scope, owner stops beside the spend ceiling's own, and the
// `stopped` / `already_stopped` answer across transactions.
//
// engine/cli/executionStop.test.ts sees only the SQL the tool sends, and
// supabase/tests/runtime_governance.sql (K1, K2) trips in one rolled-back
// transaction. What only the real database shows:
//
//   * a job_kind trip for every tenant, through the tool, holding both tenants'
//     queued agent runs at the real lease and refusing a new request, until the
//     tool clears it;
//   * the real ceiling sweep's global stop (system:spend_ceiling) and an owner's
//     global trip recorded as two rows, the owner told `stopped`, a repeat told
//     `already_stopped` naming who tripped it, and either stop holding work
//     alone once the other is cleared;
//   * a concurrent identical trip that waited on the kill-switch lock told
//     `already_stopped`, although its actor and reason match: the answer comes
//     from the row the database holds, not from the act.
//
// It lives in engine/domain because only there may a test import the domain
// services, the worker runtime, the CLIs and the database fixture together
// (eslint.config.js). All data is synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { AGENT_RUN_EXECUTE_KIND } from "../handlers/agentRunExecute.ts";
import { runWorker } from "../worker/runWorker.ts";
import {
  FIXTURE_GLOBAL_LIMIT_MICROS,
  readJob,
  resetFixtures,
  TENANT_A,
  TENANT_B,
} from "../worker/testSupport/dbFixture.ts";
import {
  activeSystemStops,
  setDailyLimit,
} from "../worker/testSupport/spendProbes.ts";
import {
  openSession,
  waitUntilBlocked,
} from "../worker/testSupport/transactionSession.ts";
import {
  clearExecutionStop,
  tripExecutionStopWithOutcome,
  type ExecutionStopTarget,
} from "./executionStops.ts";
import {
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  fakeRuntime,
  openAgentRuntimeDatabases,
  VALID,
} from "./testSupport/agentRuntimeProbes.ts";
import {
  connectionPieces,
  leaks,
  newTranscript,
  runStops,
  type CliTranscript,
} from "./testSupport/ownerCli.ts";

const WORKER = "dbtest-stop-outcome";
const ONCALL = "dbtest-oncall";

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

const probes = agentRuntimeProbes(() => ({ admin, owner, db }));

interface StopRecord {
  readonly scope: string;
  readonly tenant_id: string | null;
  readonly job_kind: string | null;
  readonly origin: string;
  readonly tripped_by: string;
  readonly reason: string;
  readonly active: boolean;
}

async function readStop(stopId: string): Promise<StopRecord> {
  const { rows } = await admin.query<StopRecord>(
    `select scope, tenant_id, job_kind, origin, tripped_by, reason,
            cleared_at is null as active
       from ops.execution_stops where id = $1`,
    [stopId],
  );
  if (!rows[0]) throw new Error("the stop under test does not exist");
  return rows[0];
}

/** `execution-stop -- trip`, expected to succeed; resolves to its one line. */
async function tripThroughTool(
  flags: readonly string[],
  transcript: CliTranscript,
): Promise<Record<string, unknown>> {
  const result = await runStops(["trip", ...flags], transcript);
  expect(result, result.stderr.join("\n")).toMatchObject({ code: 0 });
  expect(result.lines).toHaveLength(1);
  return result.lines[0];
}

async function clearThroughTool(
  stopId: string,
  transcript: CliTranscript,
): Promise<void> {
  const result = await runStops(
    ["clear", "--id", stopId, "--reason", "dbtest drill over"].concat([
      "--actor",
      ONCALL,
    ]),
    transcript,
  );
  expect(result.lines).toEqual([{ result: "cleared", stopId }]);
}

describe("a job_kind stop tripped through the tool for every tenant", () => {
  // What the SQL suite cannot prove: the tool's trip and clear, and the real
  // lease holding both tenants' queued runs in between.
  it("holds both tenants' queued agent runs at the lease and refuses a new request, until the tool clears it", async () => {
    const officeA = await probes.buildOfficeTask(TENANT_A);
    const officeB = await probes.buildOfficeTask(TENANT_B);
    const runA = await probes.requestRun(officeA, "kind-stop-a");
    const runB = await probes.requestRun(officeB, "kind-stop-b");
    const jobs = [
      (await probes.readRun(runA)).job_id as string,
      (await probes.readRun(runB)).job_id as string,
    ];
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });
    const transcript = newTranscript();

    const tripped = await tripThroughTool(
      [
        ...["--scope", "job_kind", "--kind", AGENT_RUN_EXECUTE_KIND],
        ...["--reason", "dbtest kind drill", "--actor", ONCALL],
      ],
      transcript,
    );
    const stopId = String(tripped.stopId);

    expect(tripped).toEqual({
      result: "stopped",
      stopId: expect.any(String),
      trippedBy: ONCALL,
    });
    expect(await readStop(stopId)).toEqual({
      scope: "job_kind",
      tenant_id: null,
      job_kind: AGENT_RUN_EXECUTE_KIND,
      origin: "owner",
      tripped_by: ONCALL,
      reason: "dbtest kind drill",
      active: true,
    });
    expect(await probes.runAgentJob(registry)).toEqual({ outcome: "idle" });
    for (const jobId of jobs) {
      expect(await readJob(admin, jobId)).toMatchObject({
        status: "queued",
        attempts: 0,
      });
    }
    const refused = await probes.requestRun(officeB, "kind-stop-refused");
    expect(await probes.readRun(refused)).toMatchObject({
      status: "cancelled",
      error_code: "execution_stopped",
      stop_id: stopId,
      job_id: null,
    });
    const listed = await runStops(["list"], transcript);
    expect(listed.lines.find((row) => row.id === stopId)).toMatchObject({
      scope: "job_kind",
      tenantId: null,
      jobKind: AGENT_RUN_EXECUTE_KIND,
      origin: "owner",
    });

    await clearThroughTool(stopId, transcript);
    const first = await probes.runAgentJob(registry);
    const second = await probes.runAgentJob(registry);

    expect([first.jobId, second.jobId].sort()).toEqual([...jobs].sort());
    expect([first.outcome, second.outcome]).toEqual(["succeeded", "succeeded"]);
    expect(provider.calls).toHaveLength(2);
    expect(leaks(transcript, connectionPieces())).toEqual([]);
  }, 30_000);
});

describe("an owner's global trip while the spend ceiling's global stop is active", () => {
  // What the SQL suite cannot prove: the REAL sweep, run by a real worker loop,
  // beside the tool's trips, and each stop holding work on its own.
  it("is recorded as its own stop and printed stopped, a repeat prints already_stopped naming who tripped it, and each stop holds work alone while the other is cleared", async () => {
    const office = await probes.buildOfficeTask(TENANT_A);
    const runId = await probes.requestRun(office, "ceiling-and-owner");
    const jobId = (await probes.readRun(runId)).job_id as string;
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });
    const transcript = newTranscript();
    await setDailyLimit(admin, "global", 0n);
    await runWorker({
      workerId: WORKER,
      db,
      registry,
      maxIterations: 1,
      reapIntervalMs: 0,
      pollIntervalMs: 10,
    });
    const [systemStop] = await activeSystemStops(admin);
    expect(systemStop).toMatchObject({ trippedBy: "system:spend_ceiling" });
    await setDailyLimit(admin, "global", BigInt(FIXTURE_GLOBAL_LIMIT_MICROS));

    const ownerFlags = ["--scope", "global", "--actor", ONCALL];
    const tripped = await tripThroughTool(
      [...ownerFlags, "--reason", "dbtest incident"],
      transcript,
    );
    const repeated = await tripThroughTool(
      [...ownerFlags, "--reason", "dbtest incident"],
      transcript,
    );
    const byAnother = await tripThroughTool(
      ["--scope", "global", "--reason", "dbtest second look"].concat([
        "--actor",
        "dbtest-second-owner",
      ]),
      transcript,
    );
    const ownerStop = String(tripped.stopId);

    expect(tripped).toEqual({
      result: "stopped",
      stopId: expect.any(String),
      trippedBy: ONCALL,
    });
    expect(ownerStop).not.toBe(systemStop.id);
    expect(repeated).toEqual({
      result: "already_stopped",
      stopId: ownerStop,
      trippedBy: ONCALL,
    });
    expect(byAnother).toEqual(repeated);
    expect(await readStop(ownerStop)).toMatchObject({
      origin: "owner",
      reason: "dbtest incident",
      active: true,
    });
    expect(await readStop(systemStop.id)).toMatchObject({
      origin: "system",
      active: true,
    });
    expect(provider.calls).toHaveLength(0);

    const expectHeld = async () => {
      expect(await probes.runAgentJob(registry)).toEqual({ outcome: "idle" });
      expect(await readJob(admin, jobId)).toMatchObject({
        status: "queued",
        attempts: 0,
      });
    };

    // The system stop alone still holds the job.
    await clearThroughTool(ownerStop, transcript);
    await expectHeld();
    const trippedAgain = await tripThroughTool(
      [...ownerFlags, "--reason", "dbtest incident again"],
      transcript,
    );
    expect(trippedAgain).toEqual({
      result: "stopped",
      stopId: expect.any(String),
      trippedBy: ONCALL,
    });
    expect(trippedAgain.stopId).not.toBe(ownerStop);

    // And the new owner stop alone holds it once the system stop is cleared.
    await owner.withTransaction((tx) =>
      clearExecutionStop(tx, systemStop.id, {
        reason: "dbtest ceiling raised",
        actor: ONCALL,
      }),
    );
    await expectHeld();

    await clearThroughTool(String(trippedAgain.stopId), transcript);
    expect(await probes.runAgentJob(registry)).toMatchObject({
      outcome: "succeeded",
      jobId,
    });
    expect(provider.calls).toHaveLength(1);
    expect(await activeSystemStops(admin)).toEqual([]);
    expect(leaks(transcript, connectionPieces())).toEqual([]);
  }, 30_000);
});

describe("two owners tripping the same target at once", () => {
  // What the SQL suite cannot prove: the outcome read across two transactions.
  // The second trip waits on the kill-switch lock the first holds; once the
  // first commits it finds that stop, and is told so although its actor and
  // reason are the same.
  it("tells the one that waited already_stopped with the first actor, and both answers name the one stop the database holds", async () => {
    const target: ExecutionStopTarget = {
      scope: "tenant",
      tenantId: TENANT_A,
    };
    const act = { reason: "dbtest simultaneous drill", actor: ONCALL };
    const first = openSession(owner);
    let second: ReturnType<typeof openSession> | undefined;
    try {
      const firstOutcome = await first.run((tx) =>
        tripExecutionStopWithOutcome(tx, target, act),
      );
      second = openSession(owner);
      const secondOutcome = second.run((tx) =>
        tripExecutionStopWithOutcome(tx, target, act),
      );
      secondOutcome.catch(() => undefined);
      await waitUntilBlocked(
        admin,
        await second.pid,
        secondOutcome,
        "advisory",
      );
      await first.end("commit");
      const waited = await secondOutcome;
      await second.end("commit");

      expect(firstOutcome).toEqual({
        stopId: expect.any(String),
        outcome: "stopped",
        trippedBy: ONCALL,
      });
      expect(waited).toEqual({
        stopId: firstOutcome.stopId,
        outcome: "already_stopped",
        trippedBy: ONCALL,
      });
      const { rows } = await admin.query<{ id: string; tripped_by: string }>(
        `select id, tripped_by from ops.execution_stops
          where scope = 'tenant' and tenant_id = $1 and cleared_at is null`,
        [TENANT_A],
      );
      expect(rows).toEqual([{ id: firstOutcome.stopId, tripped_by: ONCALL }]);
    } finally {
      await first.end("rollback");
      await second?.end("rollback");
    }
  }, 30_000);
});
