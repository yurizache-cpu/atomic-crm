// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { formatWorkerDetail } from "../models/routeSummary.ts";
import {
  ADMIN_DATABASE_URL,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  READ_ONLY_TRANSACTION,
  runOperatorCli,
} from "./operator.ts";
import {
  ACTS,
  LIMIT,
  LIMIT_RETIRE,
  LIMIT_SET,
  PRICE_RECORD,
  READS,
  REVIEW,
  RUNS_WITH_OPTIONS,
  TENANT,
} from "./testSupport/operatorArgv.ts";

// The operator tool with no database: which transactions it opens, what it
// prints and what it never reads or prints. What it accepts and refuses is
// operatorArgs.test.ts; what each read returns is the database's, proven by the
// driver-backed tests.

const PRICE = "d0000000-0000-4000-8000-00000000000d";
const SINCE = "2026-09-17T00:00:00.000000Z";
const NOW = "2026-09-17T13:45:00.000000Z";

// Assembled, so no scanner mistakes these fixtures for real credentials.
const PASSWORD = ["sentinel", "pw", "5151"].join("-");
const CONNECTION = `postgresql://owner:${PASSWORD}@db.invalid:5432/postgres`;
const keyShaped = (suffix: string) =>
  ["sk", "proj", "not", "a", "real", "key", suffix].join("-");

const serverError = (code: string, message: string) =>
  Object.assign(new Error(message), { code, severity: "ERROR" });

/** What an idle runtime answers: empty lists, a window, no held jobs, and each act's id. */
const idle = (sql: string, params: readonly unknown[] = []): unknown[] => {
  if (sql.includes("left join ops.agent_runs r on r.started_at")) {
    return [{ since: SINCE, generated_at: NOW, status: null, count: 0 }];
  }
  if (sql.includes("ops.job_covering_stop")) return [{ scanned: 0, held: 0 }];
  if (sql.startsWith("select count(*)::int as count")) return [{ count: 0 }];
  if (sql.includes("ops.record_model_price")) return [{ result: PRICE }];
  if (sql.includes("ops.set_spend_limit")) return [{ result: LIMIT }];
  if (sql.includes("ops.retire_spend_limit")) return [{ result: true }];
  if (sql.includes("ops.record_review_decision")) {
    // The decision is params[2]: the subcommand chose it, and it reaches the
    // database as a bound value rather than as SQL.
    return [
      {
        result: {
          review_item_id: REVIEW,
          status: params[2],
          recorded: true,
        },
      },
    ];
  }
  return [];
};

interface HarnessOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly answer?: (sql: string, params: readonly unknown[]) => unknown[];
  readonly openError?: unknown;
  readonly commitError?: unknown;
}

/** The tool wired to a fake owner database that records everything it is asked. */
const harness = (options: HarnessOptions = {}) => {
  const state = {
    stdout: [] as string[],
    stderr: [] as string[],
    opened: [] as string[],
    queries: [] as { sql: string; params: readonly unknown[] }[],
    closed: 0,
  };
  const tx: TxClient = {
    async query<TRow>(sql: string, params: readonly unknown[] = []) {
      state.queries.push({ sql, params });
      const rows = (options.answer ?? idle)(sql, params);
      return { rows: rows as TRow[] };
    },
  };
  const db: WorkerDatabase = {
    async withTransaction<T>(fn: (client: TxClient) => Promise<T>): Promise<T> {
      const result = await fn(tx);
      if (options.commitError) throw options.commitError;
      return result;
    },
    async identity() {
      throw new Error(
        "the operator tool must not run the worker identity gate",
      );
    },
    async close() {
      state.closed += 1;
    },
  };
  const run = (argv: readonly string[]) =>
    runOperatorCli(argv, {
      env: options.env ?? { [ADMIN_DATABASE_URL]: CONNECTION },
      stdout: (line) => state.stdout.push(line),
      stderr: (line) => state.stderr.push(line),
      openDatabase: (connectionString) => {
        state.opened.push(connectionString);
        if (options.openError) throw options.openError;
        return db;
      },
    });
  const printed = () => [...state.stdout, ...state.stderr].join("\n");
  const parsed = (lines: readonly string[]) =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { state, run, printed, parsed };
};

describe("running the operator tool", () => {
  it.each(READS.map((argv) => [argv.join(" "), argv] as const))(
    "runs the read-only command `%s` in a read-only transaction, with parameterised reads only",
    async (_label, argv) => {
      const { state, run } = harness();

      expect(await run(argv)).toBe(EXIT_OK);

      expect(state.queries[0]).toEqual({
        sql: READ_ONLY_TRANSACTION,
        params: [],
      });
      expect(READ_ONLY_TRANSACTION).toBe("set transaction read only");
      expect(state.queries.length).toBeGreaterThan(1);
      for (const { sql, params } of state.queries.slice(1)) {
        expect(sql.trimStart()).toMatch(/^select\b/);
        expect(sql).not.toMatch(/\b(insert|update|delete|truncate)\b/i);
        expect(sql).not.toContain(TENANT);
        expect(Array.isArray(params)).toBe(true);
      }
      expect(state.stderr).toEqual([]);
      expect(state.closed).toBe(1);
    },
  );

  it("sends a read command's options as parameters, never as SQL text", async () => {
    const { state, run } = harness();

    await run(READS[RUNS_WITH_OPTIONS]);

    expect(state.queries[1]?.params).toEqual([TENANT, "indeterminate", 20]);
  });

  it.each([
    ["price record", PRICE_RECORD, "ops.record_model_price"],
    ["limit set", LIMIT_SET, "ops.set_spend_limit"],
    ["limit retire", LIMIT_RETIRE, "ops.retire_spend_limit"],
  ])(
    "runs %s as one parameterised function call in a writable transaction",
    async (_name, argv, fn) => {
      const { state, run } = harness();

      expect(await run(argv)).toBe(EXIT_OK);

      expect(state.queries).toHaveLength(1);
      expect(state.queries[0]?.sql).toContain(fn);
      expect(state.queries[0]?.sql).toMatch(/\(\$1(, \$\d+(::bigint)?)*\)/);
      expect(state.queries[0]?.sql).not.toContain("owner");
      expect(
        state.queries.some(({ sql }) => sql === READ_ONLY_TRANSACTION),
      ).toBe(false);
    },
  );

  it("prints one line for each act, after it committed", async () => {
    const outputs: Record<string, unknown>[] = [];
    for (const argv of ACTS) {
      const { state, run, parsed } = harness();
      expect(await run(argv)).toBe(EXIT_OK);
      outputs.push(...parsed(state.stdout));
    }

    expect(outputs).toEqual([
      { result: "recorded", priceId: PRICE },
      { result: "set", limitId: LIMIT, scope: "tenant" },
      { result: "retired", limitId: LIMIT },
      { result: "recorded", reviewItemId: REVIEW, status: "accepted" },
      { result: "recorded", reviewItemId: REVIEW, status: "rejected" },
      { result: "recorded", reviewItemId: REVIEW, status: "needs_edit" },
    ]);
  });

  it("sends a limit's amount as exact micro-USD text, never a float", async () => {
    const { state, run } = harness();

    await run(LIMIT_SET);

    expect(state.queries[0]?.params).toEqual([
      "tenant",
      "25500000",
      "America/Sao_Paulo",
      "clinic launch budget",
      "owner",
      TENANT,
      null,
    ]);
  });

  it("reports a retire that changed nothing as already retired", async () => {
    const { state, run, parsed } = harness({
      answer: (sql) =>
        sql.includes("ops.retire_spend_limit") ? [{ result: false }] : [],
    });

    expect(await run(LIMIT_RETIRE)).toBe(EXIT_OK);
    expect(parsed(state.stdout)).toEqual([
      { result: "already_retired", limitId: LIMIT },
    ]);
  });

  it("reads only ADMIN_DATABASE_URL from its environment, never a provider key or a model routing variable", async () => {
    for (const argv of [["status"], ["routes"], PRICE_RECORD, ["stats"]]) {
      const read: PropertyKey[] = [];
      const env = new Proxy<Record<string, string | undefined>>(
        {
          [ADMIN_DATABASE_URL]: CONNECTION,
          OPENAI_API_KEY: keyShaped("0001"),
          AGENT_MODEL_PROVIDER: "openai",
          AGENT_MODEL_STANDARD: "gpt-test-2026-01-01",
          OPS_WORKER_DATABASE_URL: CONNECTION,
        },
        {
          get: (target, key) => {
            read.push(key);
            return Reflect.get(target, key);
          },
          has: (target, key) => {
            read.push(key);
            return Reflect.has(target, key);
          },
          ownKeys: (target) => {
            read.push("<enumerated>");
            return Reflect.ownKeys(target);
          },
          getOwnPropertyDescriptor: (target, key) => {
            read.push(key);
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        },
      );
      const { run, printed } = harness({ env });

      await run(argv);

      expect(read).toEqual(argv[0] === "stats" ? [] : [ADMIN_DATABASE_URL]);
      expect(printed()).not.toContain(keyShaped("0001"));
    }
  });

  it("names no provider or model routing variable in its source, and reads process.env only at its entry point", () => {
    const source = readFileSync(new URL("./operator.ts", import.meta.url), {
      encoding: "utf8",
    });

    expect(source).not.toMatch(/OPENAI|AGENT_MODEL|MODEL_PROVIDER/);
    expect(source).not.toMatch(/routingConfig|createModelRouter/);
    expect(source.match(/process\.env/g)).toEqual(["process.env"]);
  });

  it("exits 2 naming ADMIN_DATABASE_URL when it is absent, without opening a database", async () => {
    for (const env of [{}, { [ADMIN_DATABASE_URL]: "" }]) {
      const { state, run, parsed } = harness({ env });

      expect(await run(["status"])).toBe(EXIT_USAGE);
      expect(state.opened).toEqual([]);
      expect(parsed(state.stderr)).toEqual([
        expect.objectContaining({
          error: "usage",
          message: expect.stringContaining(ADMIN_DATABASE_URL),
        }),
      ]);
    }
  });

  it("exits 2 on a usage error before it opens a database, with the synopsis", async () => {
    const { state, run, parsed } = harness();

    expect(await run([...LIMIT_SET, "--force"])).toBe(EXIT_USAGE);
    expect(state.opened).toEqual([]);
    expect(state.stdout).toEqual([]);
    expect(parsed(state.stderr)).toEqual([
      expect.objectContaining({
        error: "usage",
        message: expect.stringContaining("--force"),
        usage: expect.stringContaining("npm run ops"),
      }),
    ]);
  });

  it("never prints the connection string when opening or reading fails", async () => {
    const opening = harness({
      openError: Object.assign(new TypeError(`Invalid URL ${CONNECTION}`), {
        code: "ERR_INVALID_URL",
        input: CONNECTION,
      }),
    });
    expect(await opening.run(["status"])).toBe(EXIT_REFUSED);
    expect(opening.parsed(opening.state.stderr)).toEqual([
      expect.objectContaining({ error: "ERR_INVALID_URL" }),
    ]);
    expect(opening.printed()).not.toContain(PASSWORD);

    const refusing = harness({
      openError: serverError(
        "28P01",
        'password authentication failed for user "postgres.sentinelref5151"',
      ),
    });
    expect(await refusing.run(PRICE_RECORD)).toBe(EXIT_REFUSED);
    expect(refusing.parsed(refusing.state.stderr)).toEqual([
      expect.objectContaining({ error: "28P01" }),
    ]);
    expect(refusing.printed()).not.toContain("sentinel");

    const reading = harness({
      answer: () => {
        throw Object.assign(new Error(`read ECONNRESET ${CONNECTION}`), {
          code: "ECONNRESET",
        });
      },
    });
    expect(await reading.run(["routes"])).toBe(EXIT_REFUSED);
    expect(reading.parsed(reading.state.stderr)).toEqual([
      expect.objectContaining({ error: "ECONNRESET" }),
    ]);
    expect(reading.printed()).not.toContain(PASSWORD);
    expect(reading.printed()).not.toContain("db.invalid");
  });

  it("exits 1 with the domain code when the domain refuses an act before any query", async () => {
    const { state, run, parsed } = harness();

    expect(
      await run(LIMIT_SET.map((t) => (t === "25.50" ? "25.1234567" : t))),
    ).toBe(EXIT_REFUSED);
    expect(state.queries).toEqual([]);
    expect(state.stdout).toEqual([]);
    expect(parsed(state.stderr)).toEqual([
      expect.objectContaining({ error: "invalid_argument" }),
    ]);
  });

  it("exits 1 with the domain code when the domain refuses a read's option", async () => {
    const { state, run, parsed } = harness();

    expect(await run(["runs", "--limit", "500"])).toBe(EXIT_REFUSED);
    expect(state.queries.map(({ sql }) => sql)).toEqual([
      READ_ONLY_TRANSACTION,
    ]);
    expect(parsed(state.stderr)).toEqual([
      expect.objectContaining({ error: "invalid_argument" }),
    ]);

    const tenant = harness();
    expect(await tenant.run(["spend", "--tenant", "dev"])).toBe(EXIT_REFUSED);
    expect(tenant.parsed(tenant.state.stderr)).toEqual([
      expect.objectContaining({ error: "malformed_identifier" }),
    ]);
  });

  it("exits 1 with the mapped code and the database's message when the database refuses an act", async () => {
    const { state, run, parsed } = harness({
      answer: () => {
        throw serverError(
          "OS409",
          "ops.record_model_price: a different price version is already recorded for that model from that moment",
        );
      },
    });

    expect(await run(PRICE_RECORD)).toBe(EXIT_REFUSED);
    expect(state.stdout).toEqual([]);
    expect(parsed(state.stderr)).toEqual([
      {
        error: "invalid_state",
        message:
          "ops.record_model_price: a different price version is already recorded for that model from that moment",
      },
    ]);
    expect(state.closed).toBe(1);
  });

  it("prints no result when an act does not commit", async () => {
    const { state, run, parsed } = harness({
      commitError: serverError("40001", "could not serialize access"),
    });

    expect(await run(LIMIT_SET)).toBe(EXIT_REFUSED);
    expect(state.stdout).toEqual([]);
    expect(parsed(state.stderr)).toEqual([
      expect.objectContaining({ error: "40001" }),
    ]);
  });

  it("prints exactly one status object, even for an idle runtime", async () => {
    const { state, run, parsed } = harness();

    expect(await run(["status"])).toBe(EXIT_OK);

    expect(parsed(state.stdout)).toEqual([
      {
        generatedAt: NOW,
        activeStops: [],
        runsStartedToday: { since: SINCE, byStatus: {} },
        heldJobs: { held: 0, scanned: 0, scanLimit: 10_000, complete: true },
        runsNeedingAttention: 0,
        spend: [],
        globalCeilingConfigured: false,
        tenantsWithoutBudget: [],
      },
    ]);
  });

  it("prints one line per listed row, and nothing for an empty list", async () => {
    const stop = (id: string) => ({
      id,
      scope: "tenant",
      tenant_id: TENANT,
      company_id: null,
      department_id: null,
      agent_id: null,
      job_kind: null,
      origin: "owner",
      reason: "incident",
      tripped_by: "owner",
      tripped_at: NOW,
      cleared_by: null,
      cleared_reason: null,
      cleared_at: null,
    });
    const listing = harness({
      answer: (sql) =>
        sql.includes("from ops.execution_stops s")
          ? [stop(LIMIT), stop(PRICE)]
          : [],
    });

    expect(await listing.run(["stops"])).toBe(EXIT_OK);
    expect(listing.parsed(listing.state.stdout)).toEqual([
      expect.objectContaining({ id: LIMIT, scope: "tenant", origin: "owner" }),
      expect.objectContaining({ id: PRICE }),
    ]);

    for (const argv of [
      ["prices"],
      ["limits"],
      ["spend"],
      ["runs"],
      ["indeterminate"],
      ["routes"],
    ]) {
      const empty = harness({ answer: () => [] });
      expect(await empty.run(argv)).toBe(EXIT_OK);
      expect(empty.state.stdout).toEqual([]);
      expect(empty.state.stderr).toEqual([]);
    }
  });

  it("prints each worker's published routes and never a key-like string", async () => {
    const { state, run, parsed } = harness({
      answer: (sql, params) => {
        if (sql.includes("from ops.worker_instances")) {
          return [
            {
              worker_id: "worker@host:1:abcd",
              last_seen_at: NOW,
              stopped_at: null,
              detail: formatWorkerDetail("running", [
                {
                  route: "standard",
                  provider: "openai",
                  model: "gpt-test-2026-01-01",
                  maxOutputTokens: 8000,
                  timeoutMs: 45_000,
                },
              ]),
            },
            {
              worker_id: "worker@host:2:efgh",
              last_seen_at: NOW,
              stopped_at: null,
              detail: formatWorkerDetail("running", [
                {
                  route: "economy",
                  provider: "openai",
                  model: keyShaped("0002"),
                  maxOutputTokens: 2000,
                  timeoutMs: 20_000,
                },
              ]),
            },
          ];
        }
        if (!sql.includes("ops.current_model_price")) return [];
        return (params[0] as string[]).map((_route, index) => ({
          ord: index + 1,
          price_id: PRICE,
          max_output_tokens: 8000,
          smallest_reservation_micros: "100480",
          largest_reservation_micros: "342345",
        }));
      },
    });

    expect(await run(["routes"])).toBe(EXIT_OK);

    expect(parsed(state.stdout)).toEqual([
      expect.objectContaining({
        workerId: "worker@host:1:abcd",
        detail: "published",
        routes: [
          expect.objectContaining({
            route: "standard",
            model: "gpt-test-2026-01-01",
            priced: true,
            largestReservationUsd: "0.342345",
          }),
        ],
      }),
      expect.objectContaining({ detail: "withheld", routes: null }),
    ]);
    expect(state.stdout.join("\n")).not.toMatch(/sk-/i);
  });
});
