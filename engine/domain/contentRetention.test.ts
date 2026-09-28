// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TxClient } from "../db/types.ts";
import {
  eraseTaskContent,
  listContentRetention,
  MAX_SWEEP_LIMIT,
  sweepContentRetention,
} from "./contentRetention.ts";
import { CompanyOsError } from "./errors.ts";

// The owner boundary over the retention ledger (Q8 D6/D7), without a
// database: what it refuses before asking, and what it refuses to believe of
// an answer. What the database does is engine/domain/contentRetention.dbtest.ts
// and supabase/tests/content_retention.sql.

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const TASK = "d1000000-0000-4000-8000-0000000000d1";

const database = (answer: unknown) => {
  const queries: { sql: string; params: readonly unknown[] }[] = [];
  const tx: TxClient = {
    async query<TRow>(sql: string, params: readonly unknown[] = []) {
      queries.push({ sql, params });
      return { rows: [{ result: answer }] as TRow[] };
    },
  };
  return { tx, queries };
};

describe("the owner's erasure", () => {
  it("asks the database once, with the tenant, the task and the actor bound", async () => {
    const { tx, queries } = database({ task_id: TASK, status: "redacted" });
    await expect(
      eraseTaskContent(tx, { tenantId: TENANT, taskId: TASK, actor: "owner" }),
    ).resolves.toEqual({ taskId: TASK, status: "redacted" });
    expect(queries).toEqual([
      {
        sql: "select ops.erase_task_content($1, $2, $3) as result",
        params: [TENANT, TASK, "owner"],
      },
    ]);
  });

  it("refuses a malformed tenant, task or actor before any query", async () => {
    for (const input of [
      { tenantId: "not-a-uuid", taskId: TASK, actor: "owner" },
      { tenantId: TENANT, taskId: "not-a-uuid", actor: "owner" },
      { tenantId: TENANT, taskId: TASK, actor: "Owner With Spaces" },
    ]) {
      const { tx, queries } = database(null);
      await expect(eraseTaskContent(tx, input)).rejects.toBeInstanceOf(
        CompanyOsError,
      );
      expect(queries).toEqual([]);
    }
  });

  it("does not report an erasure the database did not answer", async () => {
    const { tx } = database({ status: "deleted" });
    await expect(
      eraseTaskContent(tx, { tenantId: TENANT, taskId: TASK, actor: "owner" }),
    ).rejects.toThrow("ops.erase_task_content answered outside its contract");
  });
});

describe("the owner's sweep", () => {
  it("bounds every sweep, 100 by default", async () => {
    const { tx, queries } = database({ redacted: 2, in_progress: 0 });
    await expect(
      sweepContentRetention(tx, { actor: "owner" }),
    ).resolves.toEqual({ redacted: 2, inProgress: 0 });
    expect(queries[0]?.params).toEqual([100, "owner"]);
    for (const limit of [0, MAX_SWEEP_LIMIT + 1, 1.5]) {
      const refused = database(null);
      await expect(
        sweepContentRetention(refused.tx, { limit, actor: "owner" }),
      ).rejects.toBeInstanceOf(CompanyOsError);
      expect(refused.queries).toEqual([]);
    }
  });
});

describe("the ledger listing", () => {
  it("refuses a malformed tenant filter before any query", async () => {
    const { tx, queries } = database(null);
    await expect(
      listContentRetention(tx, { tenantId: "x" }),
    ).rejects.toBeInstanceOf(CompanyOsError);
    expect(queries).toEqual([]);
  });
});
