import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { WorkerDatabase } from "../db/types.ts";
import {
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  fakeRuntime,
  openAgentRuntimeDatabases,
  VALID,
} from "../domain/testSupport/agentRuntimeProbes.ts";
import { resetFixtures } from "../worker/testSupport/dbFixture.ts";
import { createPrometheusRegistry } from "./prometheusRegistry.ts";
import {
  createRecordingTelemetry,
  THROWING_TELEMETRY,
} from "./testSupport/recordingTelemetry.ts";
import { createWorkerTelemetry } from "./workerTelemetry.ts";

// Phase 2E.1 against a real database and the real agent run handler: the
// counters telemetry records agree with what PostgreSQL recorded, a replay
// after a crash counts no second settlement and makes no second call, an
// exporter that throws changes no row, and nothing the run read (its task's
// title and description, which build the prompt) reaches telemetry.

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
  readRun,
  readTaskRow,
  requestRun,
  runAgentJob,
} = agentRuntimeProbes(() => ({ admin, owner, db }));

describe("telemetry over the real governed runtime", () => {
  it("counts exactly the settlement PostgreSQL recorded, and exports nothing the prompt was built from", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "telemetry-succeeded");
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });
    const recording = createRecordingTelemetry();

    const result = await runAgentJob(registry, {
      telemetry: createWorkerTelemetry(recording),
    });

    expect(result.outcome).toBe("succeeded");
    expect(provider.calls).toHaveLength(1);
    const run = await readRun(runId);
    expect(run.status).toBe("succeeded");
    expect(
      recording.counted("company_os_agent_runs_total", {
        outcome: run.status,
      }),
    ).toBe(1);
    expect(recording.counted("company_os_agent_runs_total")).toBe(1);
    expect(
      recording.counted("company_os_external_calls_total", { outcome: "ok" }),
    ).toBe(1);
    const job = recording.spans.find(
      (span) => span.name === "company_os.job.execute",
    );
    expect(job?.attributes).toMatchObject({
      "company_os.run.id": runId,
      "company_os.agent_run.outcome": "succeeded",
      "company_os.job.outcome": "succeeded",
    });

    const task = (await readTaskRow(office.taskId)) as {
      title: string;
      description: string | null;
    };
    const exported = recording.dump();
    expect(provider.calls[0].input).toContain(task.title);
    expect(exported).not.toContain(task.title);
    if (task.description) expect(exported).not.toContain(task.description);
    expect(exported).not.toContain(VALID.summary);
  }, 30_000);

  it("counts no second settlement and makes no second call when a crashed attempt's run is settled on replay", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "telemetry-replay");
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });
    const registryText = createPrometheusRegistry();
    const telemetry = createWorkerTelemetry(registryText);

    await expect(
      runAgentJob(registry, {
        telemetry,
        onCallFinished: async () => {
          throw new Error("process died after the answer arrived");
        },
      }),
    ).rejects.toThrow(/process died/);
    const started = await readRun(runId);
    expect(started.status).toBe("running");
    await expireLease(started.job_id as string);

    const retry = await runAgentJob(registry, { telemetry });

    expect(retry.outcome).toBe("succeeded");
    expect(provider.calls).toHaveLength(1);
    expect((await readRun(runId)).status).toBe("indeterminate");
    const text = registryText.render();
    // One call, one interrupted attempt, one attempt that settled the replay;
    // no settlement counted twice, and none counted for the replay.
    expect(text).toContain(
      'company_os_external_calls_total{operation="agent_run.execute",outcome="ok"} 1',
    );
    expect(text).toContain(
      'company_os_jobs_total{job_kind="agent_run.execute",outcome="interrupted"} 1',
    );
    expect(text).toContain(
      'company_os_jobs_total{job_kind="agent_run.execute",outcome="succeeded"} 1',
    );
    expect(text).not.toMatch(/^company_os_agent_runs_total\{/m);
    expect(text).toContain("company_os_worker_active_jobs 0");
    expect(text).not.toContain(runId);
  }, 30_000);

  it("leaves every row exactly as it would be when the exporter throws on every call", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "telemetry-throwing");
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });

    const result = await runAgentJob(registry, {
      telemetry: createWorkerTelemetry(THROWING_TELEMETRY),
    });

    expect(result.outcome).toBe("succeeded");
    expect(provider.calls).toHaveLength(1);
    expect(await readRun(runId)).toMatchObject({
      status: "succeeded",
      job_attempt: 1,
    });
    const { rows } = await admin.query<{ status: string; attempts: number }>(
      "select status, attempts from ops.jobs where id = $1",
      [(await readRun(runId)).job_id],
    );
    expect(rows[0]).toEqual({ status: "succeeded", attempts: 1 });
  }, 30_000);
});
