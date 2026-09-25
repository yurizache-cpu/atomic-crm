// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import {
  parseSchedulingArgs,
  runSchedulingCli,
  SCHEDULING_ACTS,
} from "./scheduling.ts";

// The scheduling tool (Phase 3A): what it accepts, what it refuses before any
// connection opens, and that a read cannot change anything. The services it
// calls are proven against the database in engine/domain/
// followUpEngine.dbtest.ts and bookingFoundation.dbtest.ts.

const TENANT = "00000000-0000-4000-8000-00000000000a";
const ID = "00000000-0000-4000-8000-00000000000b";
const ADMIN = "postgres://postgres:SENTINEL-DB-PW@127.0.0.1:54342/postgres";

/** A database that records every statement and answers each with `rows`. */
function recordingDatabase(rows: readonly Record<string, unknown>[] = []) {
  const statements: string[] = [];
  const tx: TxClient = {
    async query(sql: string) {
      statements.push(sql);
      return { rows } as never;
    },
  };
  const database = {
    async withTransaction<T>(work: (client: TxClient) => Promise<T>) {
      return work(tx);
    },
    async identity() {
      throw new Error("unused");
    },
    async close() {},
  } as unknown as WorkerDatabase;
  return { database, statements };
}

const runWith = async (
  argv: readonly string[],
  env: Record<string, string | undefined>,
  rows: readonly Record<string, unknown>[] = [],
) => {
  const out: string[] = [];
  const err: string[] = [];
  const { database, statements } = recordingDatabase(rows);
  let opened = 0;
  const code = await runSchedulingCli(argv, {
    env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    openDatabase: () => {
      opened += 1;
      return database;
    },
  });
  return { code, out, err, statements, opened };
};

describe("the scheduling tool's acts are an explicit allowlist", () => {
  it("changes state only by completing or cancelling a follow-up and by creating, rescheduling or cancelling a booking", () => {
    expect([...SCHEDULING_ACTS]).toEqual([
      "followup complete",
      "followup cancel",
      "booking create",
      "booking reschedule",
      "booking cancel",
    ]);
  });

  it("has no command that sends, marks a follow-up due, configures, clears a stop or deletes", () => {
    for (const argv of [
      ["followup", "due"],
      ["followup", "send"],
      ["followup", "reopen"],
      ["booking", "delete"],
      ["booking", "sync"],
      ["calendar", "connect"],
      ["stop", "clear"],
      ["send"],
    ]) {
      expect(parseSchedulingArgs(argv).kind).toBe("usage_error");
    }
  });

  it("refuses a local time without its offset rather than guessing a zone", () => {
    const argv = (start: string) => [
      "booking",
      "reschedule",
      "--tenant",
      TENANT,
      "--id",
      ID,
      "--start",
      start,
      "--key",
      "k",
      "--actor",
      "owner",
    ];
    expect(parseSchedulingArgs(argv("2030-03-04T10:00:00")).kind).toBe(
      "usage_error",
    );
    expect(parseSchedulingArgs(argv("2030-03-04 10:00")).kind).toBe(
      "usage_error",
    );
    expect(parseSchedulingArgs(argv("2030-03-04T10:00:00-03:00")).kind).toBe(
      "booking reschedule",
    );
    expect(parseSchedulingArgs(argv("2030-03-04T13:00:00Z")).kind).toBe(
      "booking reschedule",
    );
  });

  it("requires every flag an act needs and refuses a flag another command takes", () => {
    expect(
      parseSchedulingArgs([
        "followup",
        "cancel",
        "--tenant",
        TENANT,
        "--id",
        ID,
      ]).kind,
    ).toBe("usage_error");
    expect(
      parseSchedulingArgs(["followups", "--reason", "lead_replied"]).kind,
    ).toBe("usage_error");
    expect(parseSchedulingArgs(["followups", "--status", "sent"]).kind).toBe(
      "usage_error",
    );
  });
});

describe("running the scheduling tool", () => {
  it("runs a read inside a read-only transaction, before any other statement", async () => {
    const { code, statements } = await runWith(["followups"], {
      ADMIN_DATABASE_URL: ADMIN,
    });
    expect(code).toBe(0);
    expect(statements[0]).toBe("set transaction read only");
    expect(statements[1]).toMatch(/from ops\.follow_ups/);
  });

  it("runs an act as one service call, printing its answer and never the actor or a key", async () => {
    const { code, out, statements } = await runWith(
      [
        "booking",
        "cancel",
        "--tenant",
        TENANT,
        "--id",
        ID,
        "--reason",
        "patient_request",
        "--actor",
        "SENTINEL-ACTOR",
      ],
      { ADMIN_DATABASE_URL: ADMIN },
      [{ result: "cancelled" }],
    );
    expect(code).toBe(0);
    expect(statements).toEqual([
      "select ops.cancel_booking($1, $2, $3, $4, $5) as result",
    ]);
    expect(out).toEqual([
      JSON.stringify({ result: "cancelled", bookingId: ID }),
    ]);
    expect(out.join("\n")).not.toContain("SENTINEL");
  });

  it("opens no connection on a usage error or without ADMIN_DATABASE_URL, and reads no other variable", async () => {
    const usage = await runWith(["booking", "delete"], {
      ADMIN_DATABASE_URL: ADMIN,
    });
    expect(usage.code).toBe(2);
    expect(usage.opened).toBe(0);

    const missing = await runWith(["followups"], {
      OPS_WORKER_DATABASE_URL: "postgres://elsewhere",
    });
    expect(missing.code).toBe(2);
    expect(missing.opened).toBe(0);
    expect(missing.err.join("\n")).not.toContain("elsewhere");
  });
});
