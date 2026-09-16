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
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/from ops\.jobs/);
    expect(h.out).toEqual([]);
  });
});
