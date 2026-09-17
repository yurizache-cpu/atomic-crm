// Two ceiling sweeps racing on an exhausted ceiling (ADR 0017 §5), against a real
// Postgres through the real `pg` driver, as the real worker role.
//
// Several workers run ops.enforce_spend_ceiling() on their own reaper ticks. Two
// of them can both read "no system stop yet" before either commits; the trip then
// serialises them on the kill-switch lock, and the second trip finds the first
// one's stop. What must hold, and what one connection cannot show:
//
//   * the database records exactly one system stop;
//   * only the sweep whose own transaction recorded it answers with its id, so a
//     fleet logs one "tripped", not one per worker.
//
// It lives in engine/domain beside the other governance proofs, which share its
// database helpers (eslint.config.js keeps them out of engine/worker).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { resetFixtures } from "../worker/testSupport/dbFixture.ts";
import {
  activeSystemStops,
  setDailyLimit,
} from "../worker/testSupport/spendProbes.ts";
import {
  openSession,
  waitUntilBlocked,
} from "../worker/testSupport/transactionSession.ts";
import {
  closeGovernanceDatabases,
  openGovernanceDatabases,
} from "./testSupport/governanceRuntime.ts";

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;

beforeAll(() => {
  ({ admin, owner, db } = openGovernanceDatabases());
}, 60_000);

afterAll(() => closeGovernanceDatabases({ admin, owner, db }));

beforeEach(async () => {
  await resetFixtures(admin);
});

async function sweep(tx: TxClient): Promise<string | null> {
  const { rows } = await tx.query<{ stop_id: string | null }>(
    "select ops.enforce_spend_ceiling() as stop_id",
  );
  return rows[0]?.stop_id ?? null;
}

const asWorker = (tx: TxClient) => tx.query("set local role ops_worker");

describe("two ceiling sweeps racing on an exhausted ceiling", () => {
  it("record one system stop, and only the sweep whose own transaction recorded it answers with its id", async () => {
    // Arrange: a ceiling of zero is exhausted by today's settled spend of zero.
    await setDailyLimit(admin, "global", 0n);
    expect(await activeSystemStops(admin)).toEqual([]);
    const first = openSession(db);
    const second = openSession(db);
    try {
      await first.run(asWorker);
      await second.run(asWorker);

      // Act: the first sweep trips and holds the kill-switch lock until it
      // commits; the second has already read "no system stop" and waits to trip.
      const firstAnswer = await first.run(sweep);
      const secondAnswer = second.run(sweep);
      await waitUntilBlocked(admin, await second.pid, secondAnswer, "advisory");
      await first.end("commit");
      const secondResult = await secondAnswer;
      await second.end("commit");

      // Assert
      const stops = await activeSystemStops(admin);
      expect(stops).toHaveLength(1);
      expect(stops[0].trippedBy).toBe("system:spend_ceiling");
      expect(firstAnswer).toBe(stops[0].id);
      expect(secondResult).toBeNull();
    } finally {
      await first.end("rollback");
      await second.end("rollback");
    }
  });
});
