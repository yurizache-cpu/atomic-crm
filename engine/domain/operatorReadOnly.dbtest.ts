// The operator CLI's read-only transaction (ADR 0017 §9) against a real
// Postgres: every read command runs `set transaction read only` first, so it
// cannot change anything, even through a function with a side effect.
//
// engine/cli/operator.test.ts sees that the statement is SENT, to a fake
// database. Only the real server shows that it is in force: the owner
// connection is wrapped so that, right after a command's first statement, a
// write through ops.record_model_price is attempted inside a savepoint. For
// every read command the server refuses it with SQLSTATE 25006 and the command
// still answers; for an act, the control, the same write goes through (and is
// rolled back to the savepoint), so the refusal is the transaction's and not
// the probe's.
//
// It lives in engine/domain because only there may a test import the CLIs and
// the database fixture together (eslint.config.js).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { TxClient } from "../db/types.ts";
import {
  adminPool,
  cleanupFixtures,
  resetFixtures,
  TENANT_A,
} from "../worker/testSupport/dbFixture.ts";
import {
  openOwnerDatabase,
  runOps,
  type OpenDatabase,
} from "./testSupport/ownerCli.ts";

const ACTOR = "dbtest-operator";

let admin: Pool;

beforeAll(() => {
  admin = adminPool();
});

afterAll(async () => {
  await cleanupFixtures(admin);
  await admin?.end();
});

beforeEach(async () => {
  await resetFixtures(admin);
});

async function tenantLimitMicros(): Promise<string[]> {
  const { rows } = await admin.query<{ micros: string }>(
    `select daily_limit_micros::text as micros from ops.spend_limits
      where scope = 'tenant' and tenant_id = $1 and ended_at is null`,
    [TENANT_A],
  );
  return rows.map((row) => row.micros);
}

const PROBE_MODEL = "dbtest-readonly-probe";
const PROBE_WRITE = `select ops.record_model_price('fake', '${PROBE_MODEL}', 1, 1, true,
  now(), now() + interval '1 day', 'dbtest read-only probe', 'dbtest-probe')`;

interface WriteProbe {
  firstStatement?: string;
  /** "written", or the SQLSTATE the write was refused with. */
  outcome?: string;
}

/** Tries the write inside a savepoint and always rolls it back, so the command goes on. */
async function attemptWrite(tx: TxClient): Promise<string> {
  await tx.query("savepoint dbtest_write_probe");
  try {
    await tx.query(PROBE_WRITE);
    return "written";
  } catch (error) {
    return String((error as { code?: unknown }).code ?? "no sqlstate");
  } finally {
    await tx.query("rollback to savepoint dbtest_write_probe");
  }
}

/** The owner connection, with a write attempted right after the command's first statement. */
function probingDatabase(probe: WriteProbe): OpenDatabase {
  return (connectionString) => {
    const inner = openOwnerDatabase(connectionString);
    return {
      identity: () => inner.identity(),
      close: () => inner.close(),
      withTransaction: (fn) =>
        inner.withTransaction((tx) => {
          let first = true;
          return fn({
            async query<TRow>(sql: string, params?: readonly unknown[]) {
              const result = await tx.query<TRow>(sql, params);
              if (first) {
                first = false;
                probe.firstStatement = sql;
                probe.outcome = await attemptWrite(tx);
              }
              return result;
            },
          });
        }),
    };
  };
}

async function probeRows(): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    "select count(*)::int as n from ops.model_prices where model = $1",
    [PROBE_MODEL],
  );
  return rows[0].n;
}

const READ_COMMANDS: readonly (readonly string[])[] = [
  ["status"],
  ["stops", "--all"],
  ["routes"],
  ["prices", "--all"],
  ["limits", "--all"],
  ["spend", "--tenant", TENANT_A],
  ["runs", "--tenant", TENANT_A],
  ["indeterminate"],
  ["membership", "list"],
];

describe("the operator's read-only transaction", () => {
  // What the CLI's unit tests cannot prove: that the REAL server refuses a
  // write in the transaction a read command runs in, even one through a
  // function with a side effect, and that the command still answers.
  for (const argv of READ_COMMANDS) {
    const shown = argv.map((arg) => (arg === TENANT_A ? "<tenant>" : arg));
    it(`refuses a write attempted after the first statement of \`${shown.join(" ")}\` with SQLSTATE 25006, and the command still prints its answer`, async () => {
      const probe: WriteProbe = {};

      const result = await runOps(argv, {
        openDatabase: probingDatabase(probe),
      });

      expect(result).toMatchObject({ code: 0, stderr: [] });
      expect(probe).toEqual({
        firstStatement: "set transaction read only",
        outcome: "25006",
      });
      expect(await probeRows()).toBe(0);
    }, 30_000);
  }

  // The control: the same probe in an act's transaction is written, so the
  // refusal above is the read-only transaction's, not the probe's.
  it("lets the same write through in an act's transaction, whose first statement is the act itself", async () => {
    const probe: WriteProbe = {};

    const result = await runOps(
      [
        ...["limit", "set", "--scope", "tenant", "--tenant", TENANT_A],
        ...["--daily-usd", "900", "--timezone", "UTC"],
        ...["--reason", "dbtest read-only control", "--actor", ACTOR],
      ],
      { openDatabase: probingDatabase(probe) },
    );

    expect(result).toMatchObject({ code: 0, stderr: [] });
    expect(probe.firstStatement).toMatch(/ops\.set_spend_limit/);
    expect(probe.outcome).toBe("written");
    expect(await probeRows()).toBe(0);
    expect(await tenantLimitMicros()).toEqual(["900000000"]);
  }, 30_000);
});
