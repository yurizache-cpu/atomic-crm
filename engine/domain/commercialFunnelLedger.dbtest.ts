// The deal stage-transition ledger under concurrency (Phase 3B.1), through
// real connections.
//
// What PostgreSQL guarantees, and all this claims: an UPDATE of a deal takes
// the row lock, so concurrent stage changes of ONE deal are serialised. The
// ledger's trigger runs inside each write, after the lock, so the deal's
// observations form one chain: each row's previous stage is the stage the
// last committed write left, and the chain ends at the deal's current stage.
// Nothing is claimed about the order of observations of DIFFERENT deals.
// The single-connection rules (one row per change, none for the same stage,
// rollback, append-only, the browser) are in supabase/tests/commercial_funnel.sql.

import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN_URL,
  adminPool,
  assertTargetDatabase,
} from "../worker/testSupport/dbFixture.ts";

let admin: Pool;
// The racing transactions get a pool of their own. adminPool() holds two
// connections, and a test that holds both while asking it for a third waits
// forever (the trap dbFixture.ts describes); a bounded wait fails instead.
let racers: Pool;
const created: number[] = [];

beforeAll(async () => {
  admin = adminPool();
  await assertTargetDatabase(admin);
  racers = new Pool({
    connectionString: ADMIN_URL,
    max: 10,
    statement_timeout: 15_000,
    connectionTimeoutMillis: 10_000,
  });
});

afterEach(async () => {
  // Deleting a deal cascades its observations.
  await admin.query("delete from public.deals where id = any ($1::bigint[])", [
    created.splice(0),
  ]);
});

afterAll(async () => {
  await racers?.end();
  await admin?.end();
});

async function newDeal(stage: string): Promise<number> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into public.deals (name, stage, pipeline_stage)
     values ('dbtest ledger deal', $1, $1) returning id`,
    [stage],
  );
  const id = Number(rows[0].id);
  created.push(id);
  return id;
}

interface Observation {
  readonly from: string | null;
  readonly to: string;
  readonly at: Date;
}

async function ledgerOf(deal: number): Promise<Observation[]> {
  const { rows } = await admin.query<{
    from_stage: string | null;
    to_stage: string;
    changed_at: Date;
  }>(
    `select from_stage, to_stage, changed_at from public.deal_stage_transitions
      where deal_id = $1 order by id`,
    [deal],
  );
  return rows.map((r) => ({
    from: r.from_stage,
    to: r.to_stage,
    at: r.changed_at,
  }));
}

async function currentStage(deal: number): Promise<string> {
  const { rows } = await admin.query<{ pipeline_stage: string }>(
    "select pipeline_stage from public.deals where id = $1",
    [deal],
  );
  return rows[0].pipeline_stage;
}

/** Waits until `pid` is blocked on a lock, or fails the test. */
async function waitUntilBlocked(pid: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await admin.query<{ wait_event_type: string | null }>(
      "select wait_event_type from pg_stat_activity where pid = $1",
      [pid],
    );
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`backend ${pid} never waited on the deal's row lock`);
}

/** The chain rule: each observation starts where the previous one ended. */
function expectOneChain(ledger: readonly Observation[], finalStage: string) {
  expect(ledger[0].from).toBeNull();
  for (let i = 1; i < ledger.length; i++) {
    expect(ledger[i].from).toBe(ledger[i - 1].to);
    expect(ledger[i].at.getTime()).toBeGreaterThanOrEqual(
      ledger[i - 1].at.getTime(),
    );
  }
  expect(ledger.at(-1)?.to).toBe(finalStage);
}

describe("concurrent stage changes of one deal are serialised, and the ledger chains", () => {
  it("makes the second change wait for the first, then records A -> B -> C in order", async () => {
    // Arrange
    const deal = await newDeal("a");
    const first: PoolClient = await racers.connect();
    const second: PoolClient = await racers.connect();
    try {
      const {
        rows: [{ pid }],
      } = await second.query<{ pid: number }>("select pg_backend_pid() as pid");

      // Act: the first holds the row; the second must wait for it.
      await first.query("begin");
      await first.query(
        "update public.deals set pipeline_stage = 'b' where id = $1",
        [deal],
      );
      await second.query("begin");
      const pending = second.query(
        "update public.deals set pipeline_stage = 'c' where id = $1",
        [deal],
      );
      await waitUntilBlocked(pid);
      await first.query("commit");
      await pending;
      await second.query("commit");
    } finally {
      first.release();
      second.release();
    }

    // Assert
    const ledger = await ledgerOf(deal);
    expect(ledger.map((o) => `${o.from ?? "()"}>${o.to}`)).toEqual([
      "()>a",
      "a>b",
      "b>c",
    ]);
    expectOneChain(ledger, await currentStage(deal));
  });

  it("keeps one coherent chain when eight connections change one deal at once", async () => {
    // Arrange
    const deal = await newDeal("s0");

    // Act: eight transactions, each to a stage of its own, all at once.
    await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const client = await racers.connect();
        try {
          await client.query("begin");
          await client.query(
            "update public.deals set pipeline_stage = $2 where id = $1",
            [deal, `s${i + 1}`],
          );
          await client.query("commit");
        } finally {
          client.release();
        }
      }),
    );

    // Assert: the entry and exactly eight changes, one chain, ending at the
    // stage the deal holds now.
    const ledger = await ledgerOf(deal);
    expect(ledger).toHaveLength(9);
    expect(new Set(ledger.slice(1).map((o) => o.to)).size).toBe(8);
    expectOneChain(ledger, await currentStage(deal));
  });

  it("records nothing for a change that is rolled back while another waits on it", async () => {
    // Arrange
    const deal = await newDeal("a");
    const first = await racers.connect();
    const second = await racers.connect();
    try {
      const {
        rows: [{ pid }],
      } = await second.query<{ pid: number }>("select pg_backend_pid() as pid");

      // Act: the first changes and rolls back; the waiting second then
      // changes the stage it actually finds.
      await first.query("begin");
      await first.query(
        "update public.deals set pipeline_stage = 'b' where id = $1",
        [deal],
      );
      await second.query("begin");
      const pending = second.query(
        "update public.deals set pipeline_stage = 'c' where id = $1",
        [deal],
      );
      await waitUntilBlocked(pid);
      await first.query("rollback");
      await pending;
      await second.query("commit");
    } finally {
      first.release();
      second.release();
    }

    // Assert: no trace of b; c follows a directly.
    const ledger = await ledgerOf(deal);
    expect(ledger.map((o) => `${o.from ?? "()"}>${o.to}`)).toEqual([
      "()>a",
      "a>c",
    ]);
    expectOneChain(ledger, await currentStage(deal));
  });
});
