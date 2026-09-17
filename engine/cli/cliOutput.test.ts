// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { CompanyOsError } from "../domain/errors.ts";
import {
  ADMIN_DATABASE_URL,
  EXIT_OK,
  EXIT_REFUSED,
  describeFailure,
  missingAdminUrlLine,
  readAdminDatabaseUrl,
  runOwnerTransaction,
  usageLine,
} from "./cliOutput.ts";

// The rules every owner CLI shares. Each tool's own tests prove them again
// through its command line; these pin the shared module on its own, so a tool
// that stops using it, or a change here, is caught in one place.

// Assembled, so no scanner mistakes this fixture for a real credential.
const PASSWORD = ["sentinel", "pw", "7373"].join("-");
const CONNECTION = `postgresql://owner:${PASSWORD}@db.invalid:5432/postgres`;

const serverError = (code: string, message: string) =>
  Object.assign(new Error(message), { code, severity: "ERROR" });

describe("describing a failure without leaking the connection string", () => {
  it("keeps a domain refusal's code and message", () => {
    expect(
      describeFailure(
        new CompanyOsError("not_found", "ops.retire_spend_limit: not found"),
        true,
      ),
    ).toEqual({
      error: "not_found",
      message: "ops.retire_spend_limit: not found",
    });
  });

  it("keeps a server error's message only once the transaction is open", () => {
    const error = serverError(
      "42501",
      "permission denied for function sentinelfn",
    );

    expect(describeFailure(error, true)).toEqual({
      error: "42501",
      message: "permission denied for function sentinelfn",
    });
    expect(describeFailure(error, false).message).not.toContain("sentinelfn");
  });

  it.each(["08006", "28P01", "3D000"])(
    "withholds the message of a %s connection-class error even inside the transaction",
    (code) => {
      const described = describeFailure(
        serverError(code, `failure for ${CONNECTION}`),
        true,
      );

      expect(described.error).toBe(code);
      expect(JSON.stringify(described)).not.toContain(PASSWORD);
    },
  );

  it("reports an error that did not come from the server by its code alone", () => {
    const described = describeFailure(
      Object.assign(new Error(`connect ECONNREFUSED ${CONNECTION}`), {
        code: "ECONNREFUSED",
      }),
      true,
    );

    expect(described.error).toBe("ECONNREFUSED");
    expect(JSON.stringify(described)).not.toContain("db.invalid");
  });

  it("replaces a code that is not a plain identifier", () => {
    expect(describeFailure({ code: CONNECTION }, true).error).toBe(
      "unexpected",
    );
    expect(describeFailure("a thrown string", true).error).toBe("unexpected");
  });
});

describe("reading the owner connection", () => {
  it("reads exactly one environment key, and nothing else", () => {
    const read: PropertyKey[] = [];
    const env = new Proxy<Record<string, string | undefined>>(
      { [ADMIN_DATABASE_URL]: CONNECTION, OPENAI_API_KEY: "unused" },
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
      },
    );

    expect(readAdminDatabaseUrl(env)).toBe(CONNECTION);
    expect(read).toEqual([ADMIN_DATABASE_URL]);
  });

  it("treats an empty value as absent, and names the variable, never a value", () => {
    expect(readAdminDatabaseUrl({ [ADMIN_DATABASE_URL]: "" })).toBeUndefined();
    expect(readAdminDatabaseUrl({})).toBeUndefined();
    expect(JSON.parse(missingAdminUrlLine())).toEqual({
      error: "usage",
      message: expect.stringContaining(ADMIN_DATABASE_URL),
    });
  });

  it("writes a usage error as one JSON object carrying the synopsis", () => {
    expect(
      JSON.parse(usageLine("no command given", "npm run ops -- <command>")),
    ).toEqual({
      error: "usage",
      message: "no command given",
      usage: "npm run ops -- <command>",
    });
  });
});

describe("running one owner transaction", () => {
  const database = (options: {
    commitError?: unknown;
    closeError?: unknown;
  }) => {
    const events: string[] = [];
    const tx: TxClient = {
      query: async () => ({ rows: [] }),
    };
    const db: WorkerDatabase = {
      async withTransaction<T>(fn: (client: TxClient) => Promise<T>) {
        events.push("begin");
        const result = await fn(tx);
        if (options.commitError) throw options.commitError;
        events.push("commit");
        return result;
      },
      identity: async () => {
        throw new Error("the owner tools never run the worker identity gate");
      },
      async close() {
        events.push("close");
        if (options.closeError) throw options.closeError;
      },
    };
    return { db, events };
  };

  it("prints each line only after the commit, one JSON object per line, and closes the pool", async () => {
    const { db, events } = database({});
    const stdout: string[] = [];

    const code = await runOwnerTransaction({
      connectionString: CONNECTION,
      openDatabase: () => db,
      streams: {
        stdout: (line) => {
          events.push("print");
          stdout.push(line);
        },
        stderr: () => undefined,
      },
      work: async () => [{ a: 1 }, { b: 2 }],
    });

    expect(code).toBe(EXIT_OK);
    expect(events).toEqual(["begin", "commit", "print", "print", "close"]);
    expect(stdout.map((line) => JSON.parse(line))).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
  });

  it("prints nothing and exits 1 when the commit fails", async () => {
    const { db, events } = database({
      commitError: serverError("40001", "could not serialize access"),
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runOwnerTransaction({
      connectionString: CONNECTION,
      openDatabase: () => db,
      streams: {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      work: async () => [{ a: 1 }],
    });

    expect(code).toBe(EXIT_REFUSED);
    expect(stdout).toEqual([]);
    expect(stderr.map((line) => JSON.parse(line))).toEqual([
      { error: "40001", message: "could not serialize access" },
    ]);
    expect(events).toContain("close");
  });

  it("reports an open that fails by its code alone, with no pool to close", async () => {
    const stderr: string[] = [];

    const code = await runOwnerTransaction({
      connectionString: CONNECTION,
      openDatabase: () => {
        throw serverError(
          "53300",
          'too many connections for role "postgres.sentinelref7373"',
        );
      },
      streams: { stdout: () => undefined, stderr: (line) => stderr.push(line) },
      work: async () => [],
    });

    expect(code).toBe(EXIT_REFUSED);
    expect(stderr).toHaveLength(1);
    expect(JSON.parse(stderr[0])).toMatchObject({ error: "53300" });
    expect(stderr[0]).not.toContain("sentinel");
  });

  it("warns about a pool that closes badly without changing a committed result", async () => {
    const { db } = database({
      closeError: Object.assign(new Error(`pool end ${CONNECTION}`), {
        code: "ECONNRESET",
      }),
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runOwnerTransaction({
      connectionString: CONNECTION,
      openDatabase: () => db,
      streams: {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      work: async () => [{ result: "set" }],
    });

    expect(code).toBe(EXIT_OK);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stderr[0])).toMatchObject({
      warning: expect.any(String),
      error: "ECONNRESET",
    });
    expect(stderr.join("\n")).not.toContain(PASSWORD);
  });
});
