// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import {
  ADMIN_DATABASE_URL,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  parseExecutionStopArgs,
  runExecutionStopCli,
} from "./executionStop.ts";

// The owner's stop tool with no database: what it accepts, what it refuses, what
// it prints and how it exits. What a stop DOES is the database's, proven in
// supabase/tests/agent_runtime.sql.

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const COMPANY = "b0000000-0000-4000-8000-00000000000b";
const DEPARTMENT = "c0000000-0000-4000-8000-00000000000c";
const STOP = "e0000000-0000-4000-8000-00000000000e";

// Assembled, so no scanner mistakes this fixture for a real credential.
const PASSWORD = ["sentinel", "pw", "4242"].join("-");
const CONNECTION = `postgresql://owner:${PASSWORD}@db.invalid:5432/postgres`;

const TRIP_GLOBAL = [
  "trip",
  "--scope",
  "global",
  "--reason",
  "incident",
  "--actor",
  "owner",
];
const CLEAR = [
  "clear",
  "--id",
  STOP,
  "--reason",
  "resolved",
  "--actor",
  "owner",
];

const serverError = (code: string, message: string) =>
  Object.assign(new Error(message), { code, severity: "ERROR" });

/** A trip that returns STOP, and a read-back of the stop it names. */
const tripAnswering =
  (stop: { tripped_by: string; reason: string; recorded_now?: boolean }) =>
  (sql: string): unknown[] =>
    sql.includes("ops.trip_execution_stop")
      ? [{ result: STOP }]
      : [{ recorded_now: true, ...stop }];

interface HarnessOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly answer?: (sql: string, params: readonly unknown[]) => unknown[];
  readonly openError?: unknown;
  readonly commitError?: unknown;
  readonly closeError?: unknown;
}

/** The CLI wired to a fake owner database that records everything it is asked. */
const harness = (options: HarnessOptions = {}) => {
  const state = {
    stdout: [] as string[],
    stderr: [] as string[],
    opened: [] as string[],
    queries: [] as { sql: string; params: readonly unknown[] }[],
    identityChecks: 0,
    closed: 0,
  };
  const tx: TxClient = {
    async query<TRow>(sql: string, params: readonly unknown[] = []) {
      state.queries.push({ sql, params });
      const rows = options.answer ? options.answer(sql, params) : [];
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
      state.identityChecks += 1;
      throw new Error("the owner tool must not run the worker identity gate");
    },
    async close() {
      state.closed += 1;
      if (options.closeError) throw options.closeError;
    },
  };
  const run = (argv: readonly string[]) =>
    runExecutionStopCli(argv, {
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

describe("parsing execution stop arguments", () => {
  it("parses list, including cleared stops only with --all", () => {
    expect(parseExecutionStopArgs(["list"])).toEqual({
      kind: "list",
      includeCleared: false,
    });
    expect(parseExecutionStopArgs(["list", "--all"])).toEqual({
      kind: "list",
      includeCleared: true,
    });
  });

  it("parses a trip with the coordinates its flags name, in any order", () => {
    const expected = {
      kind: "trip",
      target: {
        scope: "department",
        tenantId: TENANT,
        companyId: COMPANY,
        departmentId: DEPARTMENT,
      },
      act: { reason: "incident 42: runaway retries", actor: "owner" },
    };

    expect(
      parseExecutionStopArgs([
        "trip",
        "--scope",
        "department",
        "--tenant",
        TENANT,
        "--company",
        COMPANY,
        "--department",
        DEPARTMENT,
        "--reason",
        "incident 42: runaway retries",
        "--actor",
        "owner",
      ]),
    ).toEqual(expected);
    expect(
      parseExecutionStopArgs([
        "trip",
        "--actor",
        "owner",
        "--department",
        DEPARTMENT,
        "--reason",
        "incident 42: runaway retries",
        "--company",
        COMPANY,
        "--tenant",
        TENANT,
        "--scope",
        "department",
      ]),
    ).toEqual(expected);
  });

  it("parses a job_kind trip with its kind and an optional tenant", () => {
    expect(
      parseExecutionStopArgs([
        "trip",
        "--scope",
        "job_kind",
        "--kind",
        "agent_run.execute",
        "--tenant",
        TENANT,
        "--reason",
        "provider incident",
        "--actor",
        "owner",
      ]),
    ).toEqual({
      kind: "trip",
      target: {
        scope: "job_kind",
        tenantId: TENANT,
        jobKind: "agent_run.execute",
      },
      act: { reason: "provider incident", actor: "owner" },
    });
  });

  it("parses a clear", () => {
    expect(parseExecutionStopArgs(CLEAR)).toEqual({
      kind: "clear",
      stopId: STOP,
      act: { reason: "resolved", actor: "owner" },
    });
  });

  it("leaves whether a target fits its scope to the domain", () => {
    expect(
      parseExecutionStopArgs([
        "trip",
        "--scope",
        "tenant",
        "--reason",
        "incident",
        "--actor",
        "owner",
      ]),
    ).toMatchObject({ kind: "trip", target: { scope: "tenant" } });
  });

  it.each<[string, readonly string[], string]>([
    ["no arguments", [], "no command given"],
    ["an unknown command", ["stop"], "unknown command"],
    ["a command in the wrong case", ["LIST"], "unknown command"],
    ["a flag in place of a command", ["--scope", "global"], "unknown command"],
    ["a positional argument", ["list", "everything"], "unexpected argument"],
    ["a short flag", ["list", "-a"], "unexpected argument"],
    ["--force on trip", [...TRIP_GLOBAL, "--force"], 'unknown flag "--force"'],
    [
      "--force with a value",
      [...TRIP_GLOBAL, "--force", "true"],
      'unknown flag "--force"',
    ],
    [
      "--override on clear",
      [...CLEAR, "--override"],
      'unknown flag "--override"',
    ],
    ["--force on list", ["list", "--force"], 'unknown flag "--force"'],
    ["--help", ["list", "--help"], "unknown flag"],
    [
      "an inline flag value",
      ["trip", "--scope=global", "--reason", "incident", "--actor", "owner"],
      "unknown flag",
    ],
    ["an inherited property name", ["list", "--constructor"], "unknown flag"],
    ["a prototype key", ["list", "--__proto__"], "unknown flag"],
    ["a bare double dash", ["list", "--"], "unknown flag"],
    [
      "a trip flag on list",
      ["list", "--scope", "global"],
      "--scope is not a flag of list",
    ],
    [
      "a clear flag on trip",
      [...TRIP_GLOBAL, "--id", STOP],
      "--id is not a flag of trip",
    ],
    [
      "a coordinate on clear",
      [...CLEAR, "--tenant", TENANT],
      "--tenant is not a flag of clear",
    ],
    ["--all on trip", [...TRIP_GLOBAL, "--all"], "--all is not a flag of trip"],
    [
      "a kind on clear",
      [...CLEAR, "--kind", "agent_run.execute"],
      "--kind is not a flag of clear",
    ],
    [
      "a kind on list",
      ["list", "--kind", "agent_run.execute"],
      "--kind is not a flag of list",
    ],
    [
      "a repeated kind",
      [
        ...TRIP_GLOBAL,
        "--kind",
        "agent_run.execute",
        "--kind",
        "agent_run.execute",
      ],
      "--kind is given more than once",
    ],
    [
      "a kind with no value",
      [...TRIP_GLOBAL, "--kind"],
      "--kind needs a value",
    ],
    [
      "a repeated switch",
      ["list", "--all", "--all"],
      "--all is given more than once",
    ],
    [
      "a repeated scope",
      [...TRIP_GLOBAL, "--scope", "tenant"],
      "--scope is given more than once",
    ],
    [
      "a repeated reason",
      [...CLEAR, "--reason", "again"],
      "--reason is given more than once",
    ],
    [
      "a flag with no value at the end",
      ["trip", "--reason", "incident", "--actor", "owner", "--scope"],
      "--scope needs a value",
    ],
    [
      "a flag followed by another flag",
      ["trip", "--scope", "global", "--reason", "--actor", "owner"],
      "--reason needs a value",
    ],
    [
      "a trip with no scope",
      ["trip", "--reason", "incident", "--actor", "owner"],
      "trip needs --scope",
    ],
    [
      "a trip with no reason",
      ["trip", "--scope", "global", "--actor", "owner"],
      "trip needs --reason",
    ],
    [
      "a trip with no actor",
      ["trip", "--scope", "global", "--reason", "incident"],
      "trip needs --actor",
    ],
    [
      "a clear with no id",
      ["clear", "--reason", "resolved", "--actor", "owner"],
      "clear needs --id",
    ],
    [
      "an unknown scope",
      ["trip", "--scope", "fleet", "--reason", "incident", "--actor", "owner"],
      "--scope must be one of global, tenant, company, department, agent, job_kind",
    ],
  ])("refuses %s as a usage error", (_case, argv, fragment) => {
    const command = parseExecutionStopArgs(argv);

    expect(command.kind).toBe("usage_error");
    expect((command as { message: string }).message).toContain(fragment);
  });

  it("does not modify its arguments and answers the same way twice", () => {
    const argv = Object.freeze([...TRIP_GLOBAL]);

    expect(parseExecutionStopArgs(argv)).toEqual(parseExecutionStopArgs(argv));
    expect(argv).toEqual(TRIP_GLOBAL);
  });
});

describe("running the execution stop tool", () => {
  it("exits 2 naming ADMIN_DATABASE_URL when it is absent, without opening a database", async () => {
    for (const env of [{}, { [ADMIN_DATABASE_URL]: "" }]) {
      const { state, run, parsed } = harness({ env });

      expect(await run(["list"])).toBe(EXIT_USAGE);
      expect(state.opened).toEqual([]);
      expect(state.stdout).toEqual([]);
      expect(parsed(state.stderr)).toEqual([
        expect.objectContaining({
          error: "usage",
          message: expect.stringContaining("ADMIN_DATABASE_URL"),
        }),
      ]);
    }
  });

  it("exits 2 on a usage error before it opens a database, and prints the refused flag", async () => {
    const { state, run, parsed, printed } = harness();

    expect(await run([...TRIP_GLOBAL, "--force"])).toBe(EXIT_USAGE);
    expect(state.opened).toEqual([]);
    expect(state.stdout).toEqual([]);
    expect(parsed(state.stderr)).toEqual([
      expect.objectContaining({
        error: "usage",
        message: expect.stringContaining("--force"),
        usage: expect.stringContaining("npm run execution-stop"),
      }),
    ]);
    expect(printed()).not.toContain(PASSWORD);
  });

  it("trips a stop in one owner transaction and prints one JSON line", async () => {
    const { state, run, parsed } = harness({
      answer: tripAnswering({ tripped_by: "owner", reason: "incident" }),
    });

    expect(await run(TRIP_GLOBAL)).toBe(EXIT_OK);
    expect(state.opened).toEqual([CONNECTION]);
    expect(state.queries).toHaveLength(2);
    expect(state.queries[0]?.sql).toContain("ops.trip_execution_stop");
    expect(state.queries[1]?.sql).toMatch(/from ops\.execution_stops s\b/);
    expect(state.queries[1]?.params).toEqual([STOP]);
    expect(parsed(state.stdout)).toEqual([
      { result: "stopped", stopId: STOP, trippedBy: "owner" },
    ]);
    expect(state.stderr).toEqual([]);
    expect(state.identityChecks).toBe(0);
    expect(state.closed).toBe(1);
  });

  it("reports a trip an existing stop absorbed as already_stopped, naming who tripped it", async () => {
    const { state, run, parsed } = harness({
      answer: tripAnswering({
        tripped_by: "ops:on-call",
        reason: "incident 41",
        recorded_now: false,
      }),
    });

    expect(await run(TRIP_GLOBAL)).toBe(EXIT_OK);
    expect(parsed(state.stdout)).toEqual([
      { result: "already_stopped", stopId: STOP, trippedBy: "ops:on-call" },
    ]);
  });

  it("trips a stop on one external job kind for every tenant, sending the kind last", async () => {
    const { state, run, parsed } = harness({
      answer: tripAnswering({ tripped_by: "owner", reason: "incident" }),
    });

    expect(
      await run([
        "trip",
        "--scope",
        "job_kind",
        "--kind",
        "agent_run.execute",
        "--reason",
        "incident",
        "--actor",
        "owner",
      ]),
    ).toBe(EXIT_OK);
    expect(state.queries[0]?.params).toEqual([
      "job_kind",
      "incident",
      "owner",
      null,
      null,
      null,
      null,
      "agent_run.execute",
    ]);
    expect(parsed(state.stdout)).toEqual([
      expect.objectContaining({ result: "stopped" }),
    ]);
  });

  it("refuses a human act that claims the system: actor prefix before any query", async () => {
    const { state, run, parsed } = harness();

    expect(
      await run([
        "trip",
        "--scope",
        "global",
        "--reason",
        "incident",
        "--actor",
        "system:spend_ceiling",
      ]),
    ).toBe(EXIT_REFUSED);
    expect(state.queries).toEqual([]);
    expect(state.stdout).toEqual([]);
    expect(parsed(state.stderr)).toEqual([
      expect.objectContaining({ error: "invalid_argument" }),
    ]);
  });

  it("prints one JSON line per listed stop, with its kind and origin, and reads cleared stops only with --all", async () => {
    const record = (id: string) => ({
      id,
      scope: "global",
      tenant_id: null,
      company_id: null,
      department_id: null,
      agent_id: null,
      job_kind: null,
      origin: "owner",
      reason: "incident",
      tripped_by: "owner",
      tripped_at: "2026-09-14T10:00:00+00:00",
      cleared_by: null,
      cleared_reason: null,
      cleared_at: null,
    });
    const other = "f0000000-0000-4000-8000-00000000000f";
    const { state, run, parsed } = harness({
      answer: () => [record(STOP), record(other)],
    });

    expect(await run(["list", "--all"])).toBe(EXIT_OK);
    expect(state.queries[0]?.params).toEqual([true, 200]);
    expect(parsed(state.stdout)).toEqual([
      expect.objectContaining({
        id: STOP,
        scope: "global",
        jobKind: null,
        origin: "owner",
        trippedBy: "owner",
      }),
      expect.objectContaining({ id: other }),
    ]);
  });

  it("prints nothing and exits 0 when no stop is listed", async () => {
    const { state, run } = harness({ answer: () => [] });

    expect(await run(["list"])).toBe(EXIT_OK);
    expect(state.stdout).toEqual([]);
    expect(state.stderr).toEqual([]);
  });

  it("reports a clear that changed nothing as already cleared", async () => {
    const { state, run, parsed } = harness({
      answer: () => [{ result: false }],
    });

    expect(await run(CLEAR)).toBe(EXIT_OK);
    expect(parsed(state.stdout)).toEqual([
      { result: "already_cleared", stopId: STOP },
    ]);
  });

  it("exits 1 with the domain code and the database's message when the database refuses", async () => {
    const { state, run, parsed } = harness({
      answer: () => {
        throw serverError("OS404", "ops.clear_execution_stop: stop not found");
      },
    });

    expect(await run(CLEAR)).toBe(EXIT_REFUSED);
    expect(state.stdout).toEqual([]);
    expect(parsed(state.stderr)).toEqual([
      {
        error: "not_found",
        message: "ops.clear_execution_stop: stop not found",
      },
    ]);
    expect(state.closed).toBe(1);
  });

  it("exits 1 with the domain code when the domain refuses a target before any query", async () => {
    const { state, run, parsed } = harness();

    expect(
      await run([
        "trip",
        "--scope",
        "tenant",
        "--reason",
        "incident",
        "--actor",
        "owner",
      ]),
    ).toBe(EXIT_REFUSED);
    expect(state.queries).toEqual([]);
    expect(parsed(state.stderr)).toEqual([
      expect.objectContaining({ error: "missing_tenant_scope" }),
    ]);
  });

  it("exits 1 with the SQLSTATE of a server error the domain does not own", async () => {
    const { state, run, parsed } = harness({
      answer: () => {
        throw serverError(
          "42501",
          "permission denied for function trip_execution_stop",
        );
      },
    });

    expect(await run(TRIP_GLOBAL)).toBe(EXIT_REFUSED);
    expect(parsed(state.stderr)).toEqual([
      {
        error: "42501",
        message: "permission denied for function trip_execution_stop",
      },
    ]);
  });

  it("never prints the connection string, even when a driver error carries it", async () => {
    const urlError = Object.assign(new TypeError(`Invalid URL ${CONNECTION}`), {
      code: "ERR_INVALID_URL",
      input: CONNECTION,
    });
    const socketError = Object.assign(
      new Error(`connect ECONNREFUSED for ${CONNECTION}`),
      { code: "ECONNREFUSED" },
    );

    const opening = harness({ openError: urlError });
    expect(await opening.run(["list"])).toBe(EXIT_REFUSED);
    expect(opening.parsed(opening.state.stderr)).toEqual([
      expect.objectContaining({ error: "ERR_INVALID_URL" }),
    ]);
    expect(opening.printed()).not.toContain(PASSWORD);

    const querying = harness({
      answer: () => {
        throw socketError;
      },
    });
    expect(await querying.run(TRIP_GLOBAL)).toBe(EXIT_REFUSED);
    expect(querying.parsed(querying.state.stderr)).toEqual([
      expect.objectContaining({ error: "ECONNREFUSED" }),
    ]);
    expect(querying.printed()).not.toContain(PASSWORD);
    expect(querying.printed()).not.toContain("db.invalid");
  });

  it.each([
    [
      "28P01",
      'password authentication failed for user "postgres.sentinelref4242"',
    ],
    [
      "28000",
      'no pg_hba.conf entry for host "10.0.0.7", user "owner", database "sentineldb4242", SSL off',
    ],
    ["3D000", 'database "sentineldb4242" does not exist'],
    ["08P01", "invalid startup packet for sentineldb4242"],
  ])(
    "reports a %s connection refusal by SQLSTATE only, since its message names parts of the connection string",
    async (sqlstate, message) => {
      const { state, run, parsed, printed } = harness({
        openError: serverError(sqlstate, message),
      });

      expect(await run(["list"])).toBe(EXIT_REFUSED);
      expect(parsed(state.stderr)).toEqual([
        expect.objectContaining({ error: sqlstate }),
      ]);
      expect(printed()).not.toContain("sentinel");
      expect(printed()).not.toContain("10.0.0.7");
    },
  );

  it.each([
    ["53300", 'too many connections for role "postgres.sentinelref4242"'],
    [
      "55000",
      'database "sentineldb4242" is not currently accepting connections',
    ],
    ["42501", 'permission denied for database "sentineldb4242"'],
  ])(
    "reports a %s refusal raised before the transaction opened by SQLSTATE only, whatever its class",
    async (sqlstate, message) => {
      const { state, run, parsed, printed } = harness({
        openError: serverError(sqlstate, message),
      });

      expect(await run(["list"])).toBe(EXIT_REFUSED);
      expect(parsed(state.stderr)).toEqual([
        expect.objectContaining({ error: sqlstate }),
      ]);
      expect(printed()).not.toContain("sentinel");
    },
  );

  it("prints no result when the transaction does not commit", async () => {
    const { state, run, parsed } = harness({
      answer: tripAnswering({ tripped_by: "owner", reason: "incident" }),
      commitError: serverError("40001", "could not serialize access"),
    });

    expect(await run(TRIP_GLOBAL)).toBe(EXIT_REFUSED);
    expect(state.stdout).toEqual([]);
    expect(parsed(state.stderr)).toEqual([
      expect.objectContaining({ error: "40001" }),
    ]);
  });

  it("reports a pool that closes badly without changing an act that already committed", async () => {
    const { state, run, parsed } = harness({
      answer: () => [{ result: true }],
      closeError: Object.assign(new Error(`pool end ${CONNECTION}`), {
        code: "ECONNRESET",
      }),
    });

    expect(await run(CLEAR)).toBe(EXIT_OK);
    expect(parsed(state.stdout)).toEqual([{ result: "cleared", stopId: STOP }]);
    expect(parsed(state.stderr)).toEqual([
      expect.objectContaining({
        warning: expect.any(String),
        error: "ECONNRESET",
      }),
    ]);
    expect(state.stderr.join("\n")).not.toContain(PASSWORD);
  });
});
