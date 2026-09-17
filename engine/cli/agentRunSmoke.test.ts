// The smoke command's boundaries that need no database: what it refuses before
// it connects, and what it never prints. The run itself is driven by hand
// against a local stack (see the command's header); no CI job runs the command.

import { describe, expect, it } from "vitest";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  runAgentRunSmoke,
  SMOKE_SKIPPED,
  type AgentRunSmokeDependencies,
} from "./agentRunSmoke.ts";

const SECRET_PASSWORD = "dbtest-smoke-secret-pw";
const ADMIN = `postgresql://smoke_owner:${SECRET_PASSWORD}@db.smoke.invalid:6543/smoke_db`;
const WORKER = `postgresql://smoke_worker:${SECRET_PASSWORD}@db.smoke.invalid:6543/smoke_db`;
const LOCAL_ADMIN = `postgresql://smoke_owner:${SECRET_PASSWORD}@127.0.0.1:54342/smoke_db`;
const LOCAL_WORKER = `postgresql://smoke_worker:${SECRET_PASSWORD}@127.0.0.1:54342/smoke_db`;
const CONNECTION_PIECES = [
  SECRET_PASSWORD,
  "smoke_owner",
  "smoke_worker",
  "db.smoke.invalid",
  "smoke_db",
];

// Assembled, so no key-shaped literal sits in the source.
const fakeKey = (suffix: string) =>
  ["sk", "dbtest", "not", "a", "real", "key", suffix].join("-");

interface Harness {
  readonly deps: AgentRunSmokeDependencies;
  readonly out: string[];
  readonly err: string[];
  readonly opened: string[];
}

function harness(
  env: Record<string, string | undefined>,
  open?: () => WorkerDatabase,
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  return {
    out,
    err,
    opened,
    deps: {
      env,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      openDatabase: (connectionString) => {
        opened.push(connectionString);
        if (!open) throw new Error("no database may be opened in this case");
        return open();
      },
      now: () => new Date("2026-09-14T12:00:00.000Z"),
      sleep: async () => undefined,
    },
  };
}

/**
 * A database that refuses the login, with the message a real server sends: it
 * names the user. Counts how often it was closed.
 */
function refusingDatabase(): {
  readonly database: WorkerDatabase;
  readonly closed: () => number;
} {
  let closed = 0;
  const refusal = () =>
    Object.assign(
      new Error('password authentication failed for user "smoke_worker"'),
      { code: "28P01", severity: "FATAL" },
    );
  return {
    database: {
      withTransaction: () => Promise.reject(refusal()),
      identity: () => Promise.reject(refusal()),
      close: async () => {
        closed += 1;
      },
    },
    closed: () => closed,
  };
}

const parsed = (lines: readonly string[]) =>
  lines.map((line) => JSON.parse(line) as unknown);

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const RUN = "e0000000-0000-4000-8000-00000000000e";
const DEV_AGENT = {
  tenant_id: TENANT,
  company_id: "b0000000-0000-4000-8000-00000000000b",
  department_id: "c0000000-0000-4000-8000-00000000000c",
  agent_id: "d0000000-0000-4000-8000-00000000000d",
};
const LIVE_MODEL = "gpt-dbtest-1";

interface Statement {
  readonly transaction: number;
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * One scripted database for both pools: an idle queue, the dev agent, the owner's
 * active limits as given, and a run that is already finished with `run`, so the
 * worker never leases. Records every statement with the transaction it ran in.
 */
function scriptedDatabase(options: {
  readonly hasCeiling: boolean;
  readonly hasBudget: boolean;
  readonly run: { readonly status: string; readonly errorCode: string | null };
}): { readonly database: WorkerDatabase; readonly statements: Statement[] } {
  const statements: Statement[] = [];
  let transactions = 0;
  const answer = (sql: string): unknown[] => {
    if (sql.includes("from ops.jobs where status in")) return [{ n: 0 }];
    if (sql.includes("where t.slug = 'dev'")) return [DEV_AGENT];
    if (sql.includes("as has_ceiling")) {
      return [
        { has_ceiling: options.hasCeiling, has_budget: options.hasBudget },
      ];
    }
    if (sql.includes("ops.record_model_price")) {
      return [{ result: "f0000000-0000-4000-8000-00000000000f" }];
    }
    if (sql.includes("ops.set_spend_limit")) {
      return [{ result: "90000000-0000-4000-8000-000000000009" }];
    }
    if (sql.includes("ops.create_task")) {
      return [{ result: "80000000-0000-4000-8000-000000000008" }];
    }
    if (sql.includes("ops.request_agent_run")) return [{ result: RUN }];
    if (sql.includes("select status from ops.agent_runs")) {
      return [{ status: options.run.status }];
    }
    if (sql.includes("r.error_code, r.job_id")) {
      return [
        {
          status: options.run.status,
          error_category: options.run.errorCode === null ? null : "refused",
          error_code: options.run.errorCode,
          job_id: null,
          event_types: ["agent_run.requested"],
        },
      ];
    }
    return [{ result: null }];
  };
  const database: WorkerDatabase = {
    withTransaction: async (fn) => {
      transactions += 1;
      const transaction = transactions;
      return fn({
        query: async <TRow>(sql: string, params: readonly unknown[] = []) => {
          statements.push({ transaction, sql, params });
          return { rows: answer(sql) as TRow[] };
        },
      });
    },
    identity: async () => ({
      user: "ops_worker_login",
      isSuperuser: false,
      bypassesRls: false,
      isOpsWorkerMember: true,
    }),
    close: async () => undefined,
  };
  return { database, statements };
}

const GOVERNANCE_ACTS = /ops\.record_model_price|ops\.set_spend_limit/;
const LOCAL_ENV = {
  ADMIN_DATABASE_URL: LOCAL_ADMIN,
  OPS_WORKER_DATABASE_URL: LOCAL_WORKER,
};
const liveEnv = () => ({
  AGENT_MODEL_PROVIDER: "openai",
  OPENAI_API_KEY: fakeKey("0003"),
  AGENT_MODEL_STANDARD: LIVE_MODEL,
  ...LOCAL_ENV,
});

describe("the agent runtime smoke command", () => {
  it("prints skipped and opens no database when --live finds no configured provider", async () => {
    const h = harness({
      ADMIN_DATABASE_URL: ADMIN,
      OPS_WORKER_DATABASE_URL: WORKER,
      AGENT_MODEL_PROVIDER: "",
    });

    expect(await runAgentRunSmoke(["--live"], h.deps)).toBe(EXIT_OK);

    expect(parsed(h.out)).toEqual([{ skipped: SMOKE_SKIPPED }]);
    expect(h.err).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  it.each([[["--force"]], [["--live", "--live"]], [["live"]]])(
    "refuses %j as a usage error before opening anything",
    async (argv) => {
      const h = harness({
        ADMIN_DATABASE_URL: ADMIN,
        OPS_WORKER_DATABASE_URL: WORKER,
      });

      expect(await runAgentRunSmoke(argv, h.deps)).toBe(EXIT_USAGE);

      expect(parsed(h.err)).toEqual([
        expect.objectContaining({ error: "usage" }),
      ]);
      expect(h.opened).toEqual([]);
    },
  );

  it("names a missing connection variable and prints no environment value", async () => {
    const h = harness({ ADMIN_DATABASE_URL: ADMIN });

    expect(await runAgentRunSmoke([], h.deps)).toBe(EXIT_USAGE);

    const text = h.err.join("\n");
    expect(text).toContain("OPS_WORKER_DATABASE_URL");
    for (const piece of CONNECTION_PIECES) expect(text).not.toContain(piece);
    expect(h.out).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  it.each([
    [
      "an owner database that is not on this machine",
      ADMIN,
      LOCAL_WORKER,
      "database_not_local",
      "ADMIN_DATABASE_URL",
    ],
    [
      "a worker database that is not on this machine",
      LOCAL_ADMIN,
      WORKER,
      "database_not_local",
      "OPS_WORKER_DATABASE_URL",
    ],
    [
      "a loopback worker connection string whose host parameter redirects it",
      LOCAL_ADMIN,
      `${LOCAL_WORKER}?host=db.smoke.invalid`,
      "database_not_local",
      "OPS_WORKER_DATABASE_URL",
    ],
    [
      "a loopback worker connection string whose port parameter moves it to another local database",
      LOCAL_ADMIN,
      `${LOCAL_WORKER}?port=54322`,
      "database_not_local",
      "OPS_WORKER_DATABASE_URL",
    ],
    [
      "an owner connection string with a leading space, which node-postgres sends to another host",
      ` ${LOCAL_ADMIN}`,
      LOCAL_WORKER,
      "database_not_local",
      "ADMIN_DATABASE_URL",
    ],
    [
      "a worker on another local port, such as the other working copy's stack",
      LOCAL_ADMIN,
      LOCAL_WORKER.replace(":54342/", ":54322/"),
      "databases_differ",
      "OPS_WORKER_DATABASE_URL",
    ],
    [
      "a worker on another local database",
      LOCAL_ADMIN,
      LOCAL_WORKER.replace("/smoke_db", "/smoke_other_db"),
      "databases_differ",
      "OPS_WORKER_DATABASE_URL",
    ],
  ])(
    "refuses %s in the default fake-provider mode, as a usage error, before opening anything",
    async (_label, admin, worker, error, variable) => {
      const h = harness({
        ADMIN_DATABASE_URL: admin,
        OPS_WORKER_DATABASE_URL: worker,
      });

      expect(await runAgentRunSmoke([], h.deps)).toBe(EXIT_USAGE);

      expect(parsed(h.err)).toEqual([
        expect.objectContaining({ error, message: expect.any(String) }),
      ]);
      const text = h.err.join("\n");
      expect(text).toContain(variable);
      for (const piece of [
        ...CONNECTION_PIECES,
        "54342",
        "54322",
        "smoke_other_db",
      ]) {
        expect(text).not.toContain(piece);
      }
      expect(h.out).toEqual([]);
      expect(h.opened).toEqual([]);
    },
  );

  it("keeps --live outside the local-database rule: a configured provider opens both pools on a database elsewhere", async () => {
    const refusing = refusingDatabase();
    const key = fakeKey("0002");
    const h = harness(
      {
        AGENT_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: key,
        AGENT_MODEL_STANDARD: "gpt-dbtest-1",
        ADMIN_DATABASE_URL: ADMIN,
        OPS_WORKER_DATABASE_URL: WORKER,
      },
      () => refusing.database,
    );

    expect(await runAgentRunSmoke(["--live"], h.deps)).toBe(EXIT_FAILED);

    expect(h.opened).toEqual([ADMIN, WORKER]);
    expect(parsed(h.err)).toEqual([{ error: "28P01", stage: "identity" }]);
    expect(h.err.join("\n")).not.toContain(key);
    expect(refusing.closed()).toBe(2);
  });

  it("reports a live routing misconfiguration by the variable's name, never its value", async () => {
    const key = fakeKey("0001");
    const h = harness({
      AGENT_MODEL_PROVIDER: "openai",
      OPENAI_API_KEY: key,
      AGENT_MODEL_STANDARD: key,
      ADMIN_DATABASE_URL: ADMIN,
      OPS_WORKER_DATABASE_URL: WORKER,
    });

    expect(await runAgentRunSmoke(["--live"], h.deps)).toBe(EXIT_FAILED);

    const text = h.err.join("\n");
    expect(text).toContain("AGENT_MODEL_STANDARD");
    expect(text).not.toContain(key);
    expect(h.opened).toEqual([]);
  });

  it("reports a database failure by SQLSTATE and stage alone, and closes both pools", async () => {
    const refusing = refusingDatabase();
    const h = harness(
      {
        ADMIN_DATABASE_URL: LOCAL_ADMIN,
        OPS_WORKER_DATABASE_URL: LOCAL_WORKER,
      },
      () => refusing.database,
    );

    expect(await runAgentRunSmoke([], h.deps)).toBe(EXIT_FAILED);

    expect(parsed(h.err)).toEqual([{ error: "28P01", stage: "identity" }]);
    const text = h.err.join("\n");
    for (const piece of CONNECTION_PIECES) expect(text).not.toContain(piece);
    expect(h.out).toEqual([]);
    expect(refusing.closed()).toBe(2);
  });

  it("refuses to run on a busy queue before it creates or requests anything", async () => {
    const statements: string[] = [];
    const tx: TxClient = {
      query: async <TRow>(sql: string) => {
        statements.push(sql);
        return { rows: [{ n: 1 }] as TRow[] };
      },
    };
    const database: WorkerDatabase = {
      withTransaction: (fn) => fn(tx),
      identity: async () => ({
        user: "ops_worker_login",
        isSuperuser: false,
        bypassesRls: false,
        isOpsWorkerMember: true,
      }),
      close: async () => undefined,
    };
    const h = harness(
      {
        ADMIN_DATABASE_URL: LOCAL_ADMIN,
        OPS_WORKER_DATABASE_URL: LOCAL_WORKER,
      },
      () => database,
    );

    expect(await runAgentRunSmoke([], h.deps)).toBe(EXIT_FAILED);

    expect(parsed(h.err)).toEqual([
      {
        error: "queue_not_empty",
        stage: "request",
        message: expect.any(String),
      },
    ]);
    // The governance transaction and the request transaction each look at the
    // queue, find it busy, and write nothing.
    expect(statements).toHaveLength(2);
    for (const sql of statements) expect(sql).toMatch(/from ops\.jobs/);
    expect(h.out).toEqual([]);
  });
});

describe("the smoke command's governance configuration", () => {
  it("makes the local database able to start the run in a transaction of its own, committed before the transaction that requests the run, in the default mode", async () => {
    const scripted = scriptedDatabase({
      hasCeiling: false,
      hasBudget: false,
      run: { status: "succeeded", errorCode: null },
    });
    const h = harness(LOCAL_ENV, () => scripted.database);

    expect(await runAgentRunSmoke([], h.deps)).toBe(EXIT_OK);

    const orderIn = (transaction: number) =>
      scripted.statements
        .filter((statement) => statement.transaction === transaction)
        .map(
          ({ sql }) =>
            /ops\.(record_model_price|set_spend_limit|create_task|assign_task|request_agent_run)|has_ceiling/.exec(
              sql,
            )?.[0],
        )
        .filter(Boolean);
    // Setting a limit takes a spend lock, and a request takes the kill-switch
    // lock, which ADR 0017 §4 orders first: they never share a transaction.
    expect(orderIn(1)).toEqual([
      "ops.record_model_price",
      "has_ceiling",
      "ops.set_spend_limit",
      "ops.set_spend_limit",
    ]);
    expect(orderIn(2)).toEqual([
      "ops.create_task",
      "ops.assign_task",
      "ops.request_agent_run",
    ]);
    const request = scripted.statements.filter(
      ({ transaction }) => transaction === 1,
    );
    const acts = request.filter(({ sql }) => GOVERNANCE_ACTS.test(sql));
    expect(acts.map(({ params }) => params)).toEqual([
      [
        "fake",
        "fake-model-1",
        "0.01",
        "0.01",
        true,
        "2026-09-14T00:00:00.000Z",
        "2026-10-14T00:00:00.000Z",
        "agent-runtime smoke: synthetic price for the fake provider",
        "agent-runtime-smoke",
        null,
      ],
      [
        "global",
        "1000000",
        "UTC",
        "agent-runtime smoke: local development ceiling",
        "agent-runtime-smoke",
        null,
        null,
      ],
      [
        "tenant",
        "1000000",
        "UTC",
        "agent-runtime smoke: local development budget",
        "agent-runtime-smoke",
        TENANT,
        null,
      ],
    ]);
    expect(
      request.find(({ sql }) => sql.includes("has_ceiling"))?.params,
    ).toEqual([TENANT]);
    expect(h.err).toEqual([]);
  });

  it.each([
    ["an owner's active ceiling and budget", true, true, []],
    ["an owner's active ceiling", true, false, ["tenant"]],
    ["an owner's active budget", false, true, ["global"]],
  ])(
    "never overrides %s, and sets only the limit that is missing",
    async (_case, hasCeiling, hasBudget, expectedScopes) => {
      const scripted = scriptedDatabase({
        hasCeiling,
        hasBudget,
        run: { status: "succeeded", errorCode: null },
      });
      const h = harness(LOCAL_ENV, () => scripted.database);

      expect(await runAgentRunSmoke([], h.deps)).toBe(EXIT_OK);

      const limits = scripted.statements.filter(({ sql }) =>
        sql.includes("ops.set_spend_limit"),
      );
      expect(limits.map(({ params }) => params[0])).toEqual(expectedScopes);
      expect(
        scripted.statements.filter(({ sql }) =>
          sql.includes("ops.record_model_price"),
        ),
      ).toHaveLength(1);
    },
  );

  it("does not configure anything when the queue is busy", async () => {
    const statements: string[] = [];
    const database: WorkerDatabase = {
      withTransaction: (fn) =>
        fn({
          query: async <TRow>(sql: string) => {
            statements.push(sql);
            return { rows: [{ n: 3 }] as TRow[] };
          },
        }),
      identity: async () => ({
        user: "ops_worker_login",
        isSuperuser: false,
        bypassesRls: false,
        isOpsWorkerMember: true,
      }),
      close: async () => undefined,
    };
    const h = harness(LOCAL_ENV, () => database);

    expect(await runAgentRunSmoke([], h.deps)).toBe(EXIT_FAILED);

    expect(statements.some((sql) => GOVERNANCE_ACTS.test(sql))).toBe(false);
  });

  it("configures no price and no limit in live mode", async () => {
    const scripted = scriptedDatabase({
      hasCeiling: false,
      hasBudget: false,
      run: { status: "succeeded", errorCode: null },
    });
    const h = harness(liveEnv(), () => scripted.database);

    expect(await runAgentRunSmoke(["--live"], h.deps)).toBe(EXIT_OK);

    expect(
      scripted.statements.filter(
        ({ sql }) => GOVERNANCE_ACTS.test(sql) || sql.includes("has_ceiling"),
      ),
    ).toEqual([]);
    expect(
      scripted.statements.some(({ sql }) =>
        sql.includes("ops.request_agent_run"),
      ),
    ).toBe(true);
    expect(h.err).toEqual([]);
  });

  it.each([
    ["price_unavailable", "npm run ops -- price record"],
    ["spend_ceiling_unconfigured", "npm run ops -- limit set"],
    ["budget_unconfigured", "npm run ops -- limit set"],
  ])(
    "hints at the npm run ops act when a live run is refused as %s, naming no value",
    async (errorCode, act) => {
      const scripted = scriptedDatabase({
        hasCeiling: false,
        hasBudget: false,
        run: { status: "cancelled", errorCode },
      });
      const env = liveEnv();
      const h = harness(env, () => scripted.database);

      expect(await runAgentRunSmoke(["--live"], h.deps)).toBe(EXIT_FAILED);

      expect(parsed(h.out)).toEqual([
        expect.objectContaining({ status: "cancelled", errorCode }),
      ]);
      expect(parsed(h.err)).toEqual([{ hint: expect.stringContaining(act) }]);
      const text = h.err.join("\n");
      expect(text).toContain(errorCode);
      for (const value of [
        env.OPENAI_API_KEY,
        LIVE_MODEL,
        TENANT,
        ...CONNECTION_PIECES,
      ]) {
        expect(text).not.toContain(value);
      }
    },
  );

  it.each([
    ["a live run refused for another reason", ["--live"], "execution_stopped"],
    ["a default-mode run", [], "price_unavailable"],
  ])("prints no governance hint for %s", async (_case, argv, errorCode) => {
    const scripted = scriptedDatabase({
      hasCeiling: true,
      hasBudget: true,
      run: { status: "cancelled", errorCode },
    });
    const h = harness(
      argv.length > 0 ? liveEnv() : LOCAL_ENV,
      () => scripted.database,
    );

    expect(await runAgentRunSmoke(argv, h.deps)).toBe(EXIT_FAILED);

    expect(h.err).toEqual([]);
  });
});
