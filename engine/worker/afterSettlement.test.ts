// @vitest-environment node
//
// The post-settlement runner's own promises, without a database. That a failed
// step leaves the settlement committed is proven against a real Postgres, lock
// waits and statement timeouts included (engine/domain/leadTriageSettlement.dbtest.ts).
import { describe, expect, it } from "vitest";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import {
  runAfterSettlement,
  type AfterSettlementStep,
} from "./afterSettlement.ts";
import type { LeasedJob } from "./job.ts";
import type { WorkerLogEvent, WorkerLogFields } from "./log.ts";

const JOB: LeasedJob = Object.freeze({
  id: "00000000-0000-4000-8000-00000000a001",
  tenant_id: "00000000-0000-4000-8000-00000000b001",
  kind: "agent_run.execute",
  payload: { agent_run_id: "00000000-0000-4000-8000-00000000c001" },
  attempts: 1,
  max_attempts: 3,
});

const WORKER = "unit-worker";

/** Text a database error could carry: a row it quoted. It must never be logged. */
const ROW_TEXT = "Oi, sentinel text a failed statement quoted";

interface Recorded {
  readonly transactions: string[][];
  readonly params: (readonly unknown[] | undefined)[];
}

/** A database that records each transaction's statements and fails as told. */
const recordingDatabase = (
  failWith?: unknown,
): { db: WorkerDatabase; recorded: Recorded } => {
  const recorded: Recorded = { transactions: [], params: [] };
  const db: WorkerDatabase = {
    async withTransaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
      const statements: string[] = [];
      recorded.transactions.push(statements);
      const tx: TxClient = {
        async query<TRow>(sql: string, params?: readonly unknown[]) {
          statements.push(sql);
          recorded.params.push(params);
          if (failWith !== undefined && sql.includes("ops.")) throw failWith;
          return { rows: [] as TRow[] };
        },
      };
      return fn(tx);
    },
    identity: () => Promise.reject(new Error("not used")),
    close: async () => {},
  };
  return { db, recorded };
};

const recordingLog = () => {
  const lines: { event: WorkerLogEvent; fields?: WorkerLogFields }[] = [];
  return {
    lines,
    log: (event: WorkerLogEvent, fields?: WorkerLogFields) => {
      lines.push({ event, fields });
    },
  };
};

describe("the steps that follow a committed settlement", () => {
  it("run as the worker, in a transaction of their own, naming only the worker and the job", async () => {
    const { db, recorded } = recordingDatabase();
    const { lines, log } = recordingLog();

    await runAfterSettlement({ db, workerId: WORKER, job: JOB, log }, [
      "openRunReview",
    ]);

    expect(recorded.transactions).toEqual([
      [
        "set local role ops_worker",
        "select ops.open_review_for_settled_job($1, $2)",
      ],
    ]);
    expect(recorded.params.at(-1)).toEqual([WORKER, JOB.id]);
    expect(lines).toEqual([]);
  });

  it("never throw, and report a failure by the step's name and SQLSTATE alone", async () => {
    const cancelled = Object.assign(new Error(ROW_TEXT), { code: "57014" });
    const { db } = recordingDatabase(cancelled);
    const { lines, log } = recordingLog();

    await expect(
      runAfterSettlement({ db, workerId: WORKER, job: JOB, log }, [
        "openRunReview",
      ]),
    ).resolves.toBeUndefined();

    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe("job.after_settlement_failed");
    expect(lines[0].fields).toMatchObject({
      workerId: WORKER,
      jobId: JOB.id,
      tenantId: JOB.tenant_id,
      detail: "openRunReview sqlstate=57014",
    });
    expect(JSON.stringify(lines)).not.toContain("sentinel");
  });

  it("report an error with no SQLSTATE as unknown, never by its message", async () => {
    const { db } = recordingDatabase(new Error(ROW_TEXT));
    const { lines, log } = recordingLog();

    await runAfterSettlement({ db, workerId: WORKER, job: JOB, log }, [
      "openRunReview",
    ]);

    expect(lines.map((line) => line.fields?.detail)).toEqual([
      "openRunReview sqlstate=unknown",
    ]);
    expect(JSON.stringify(lines)).not.toContain("sentinel");
  });

  it("run no SQL for a step outside the fixed list", async () => {
    const { db, recorded } = recordingDatabase();
    const { lines, log } = recordingLog();

    await runAfterSettlement({ db, workerId: WORKER, job: JOB, log }, [
      "constructor" as AfterSettlementStep,
    ]);

    expect(recorded.transactions).toEqual([]);
    expect(lines.map((line) => line.fields?.detail)).toEqual([
      "unknown step refused",
    ]);
  });
});
