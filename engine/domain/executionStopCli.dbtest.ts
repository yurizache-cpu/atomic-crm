// The owner's execution stop CLI and the stop list, against a real Postgres.
//
// The CLI's unit tests see only the parameters it sends, and the SQL suite
// never runs the tool. This file runs `engine/cli/executionStop.ts` as a real
// PROCESS on its own connection against the real functions, with runs requested
// through the domain between its commands, and proves that none of its output
// carries the connection string it was given. It lives in engine/domain
// because only there may a test import the domain services and the database
// fixture together (eslint.config.js). All data is synthetic
// office-operations text.

import { spawn } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { ADMIN_URL, resetFixtures } from "../worker/testSupport/dbFixture.ts";
import {
  clearExecutionStop,
  listExecutionStops,
  tripExecutionStop,
} from "./executionStops.ts";
import {
  agentRunProbes,
  CLEAR,
  closeAgentRunDatabases,
  openAgentRunDatabases,
  TRIP,
} from "./testSupport/agentRunSessions.ts";

const STOP_CLI = "engine/cli/executionStop.ts";
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

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

const { buildOffice, readRun, requestRun } = agentRunProbes(() => ({
  admin,
  owner,
  worker,
}));

// ---------------------------------------------------------------------------
// The owner's stop CLI and the stop list
// ---------------------------------------------------------------------------

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runStopCli(
  args: readonly string[],
  connectionString: string = ADMIN_URL,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STOP_CLI, ...args], {
      env: { ...process.env, ADMIN_DATABASE_URL: connectionString },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** The tool's JSON lines; anything else on the stream (a Node warning) is ignored. */
const jsonLines = (text: string): Record<string, unknown>[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** The parts of a connection string that must never appear in the tool's output. */
function connectionPieces(connectionString: string): string[] {
  const url = new URL(connectionString);
  return [
    connectionString,
    "postgresql://",
    url.password,
    `${url.hostname}:${url.port}`,
  ].filter(Boolean);
}

describe("the owner's execution stop CLI, as a real process", () => {
  // What neither the SQL suite nor the CLI's unit tests can prove: the owner
  // tool as a separate PROCESS on its own connection against the real
  // functions, with a run requested through the domain between its commands,
  // and none of its output carrying the connection string it was given.
  it("trips a scoped stop, lists it, refuses a covered run, clears it, lists it as history, and never prints the connection string", async () => {
    const office = await buildOffice();
    const outputs: CliResult[] = [];
    const cli = async (args: readonly string[]) => {
      const result = await runStopCli(args);
      outputs.push(result);
      expect(result.code, `${args[0]}: ${result.stderr}`).toBe(0);
      return jsonLines(result.stdout);
    };

    const [tripped] = await cli([
      "trip",
      "--scope",
      "tenant",
      "--tenant",
      office.tenantId,
      "--reason",
      "dbtest cli drill",
      "--actor",
      "dbtest",
    ]);
    expect(tripped).toMatchObject({ result: "stopped" });
    const stopId = String(tripped.stopId);

    expect((await cli(["list"])).find((s) => s.id === stopId)).toMatchObject({
      scope: "tenant",
      tenantId: office.tenantId,
      reason: "dbtest cli drill",
      trippedBy: "dbtest",
      trippedAt: expect.stringMatching(ISO_UTC),
      clearedAt: null,
    });

    const refused = await requestRun(office, "cli-refused");
    expect(await readRun(refused)).toMatchObject({
      status: "cancelled",
      error_code: "execution_stopped",
      stop_id: stopId,
      job_id: null,
    });

    expect(
      await cli([
        "clear",
        "--id",
        stopId,
        "--reason",
        "dbtest cli drill over",
        "--actor",
        "dbtest",
      ]),
    ).toEqual([{ result: "cleared", stopId }]);

    expect((await cli(["list"])).map((s) => s.id)).not.toContain(stopId);
    expect(
      (await cli(["list", "--all"])).find((s) => s.id === stopId),
    ).toMatchObject({
      clearedBy: "dbtest",
      clearedReason: "dbtest cli drill over",
      clearedAt: expect.stringMatching(ISO_UTC),
    });

    const allowed = await readRun(await requestRun(office, "cli-allowed"));
    expect(allowed).toMatchObject({ status: "pending", stop_id: null });
    expect(allowed.job_id).not.toBeNull();

    expect(outputs).toHaveLength(5);
    for (const { stdout, stderr } of outputs) {
      for (const piece of connectionPieces(ADMIN_URL)) {
        expect(stdout).not.toContain(piece);
        expect(stderr).not.toContain(piece);
      }
    }
  }, 60_000);

  // What the CLI's unit tests cannot prove: the REAL server's refusal of a
  // connection, whose message names the user, reported by its SQLSTATE alone.
  it("reports a connection the database refuses by its SQLSTATE alone, naming no part of the connection string", async () => {
    const url = new URL(ADMIN_URL);
    url.password = "dbtest-not-the-password";

    const result = await runStopCli(["list"], url.toString());

    expect(result.code).toBe(1);
    expect(jsonLines(result.stdout)).toEqual([]);
    expect(jsonLines(result.stderr)).toEqual([
      { error: "28P01", message: expect.any(String) },
    ]);
    for (const piece of [...connectionPieces(url.toString()), url.username]) {
      expect(result.stderr).not.toContain(piece);
    }
  }, 30_000);
});

describe("listing execution stops", () => {
  // What the domain's unit tests cannot prove: the list's filter against real
  // rows. They see only the parameters it sends, not which rows those select.
  it("lists only active stops by default, and every stop newest first with includeCleared", async () => {
    const office = await buildOffice();
    const tenantStop = await owner.withTransaction((tx) =>
      tripExecutionStop(
        tx,
        { scope: "tenant", tenantId: office.tenantId },
        TRIP,
      ),
    );
    const companyStop = await owner.withTransaction((tx) =>
      tripExecutionStop(
        tx,
        {
          scope: "company",
          tenantId: office.tenantId,
          companyId: office.companyId,
        },
        TRIP,
      ),
    );
    expect(
      await owner.withTransaction((tx) =>
        clearExecutionStop(tx, tenantStop, CLEAR),
      ),
    ).toBe(true);

    const active = await owner.withTransaction((tx) => listExecutionStops(tx));
    const all = await owner.withTransaction((tx) =>
      listExecutionStops(tx, { includeCleared: true }),
    );

    const ours = (rows: readonly { id: string }[]) =>
      rows
        .map((row) => row.id)
        .filter((id) => id === tenantStop || id === companyStop);
    expect(ours(active)).toEqual([companyStop]);
    expect(active.every((row) => row.clearedAt === null)).toBe(true);
    expect(ours(all)).toEqual([companyStop, tenantStop]);
    expect(all.find((row) => row.id === tenantStop)).toMatchObject({
      clearedBy: "dbtest",
      clearedReason: CLEAR.reason,
      clearedAt: expect.stringMatching(ISO_UTC),
    });
  });
});
