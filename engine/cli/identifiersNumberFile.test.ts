// `npm run ops -- identifiers erase --number-file` (ADR 0026 §D): the number
// to erase read from a file, so it stays out of the shell's history, exactly
// one of the two ways named, and the number printed nowhere.

import { describe, expect, it } from "vitest";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { parseOperatorArgs, runOperatorCli } from "./operator.ts";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
/** A synthetic number, as the owner's file holds it. */
const NUMBER = "5511900000858";
const BOM = String.fromCharCode(0xfeff);

const run = async (argv: readonly string[], file = `${BOM}${NUMBER}\r\n`) => {
  const queries: { sql: string; params: readonly unknown[] }[] = [];
  const out: string[] = [];
  const read: string[] = [];
  const tx: TxClient = {
    async query<TRow>(sql: string, params: readonly unknown[] = []) {
      queries.push({ sql, params });
      return { rows: [{ count: 2 }] as TRow[] };
    },
  };
  const db: WorkerDatabase = {
    withTransaction: async <T>(fn: (client: TxClient) => Promise<T>) => fn(tx),
    identity: async () => {
      throw new Error("unused");
    },
    close: async () => {},
  };
  const code = await runOperatorCli(argv, {
    env: { ADMIN_DATABASE_URL: "postgres://unit" },
    stdout: (line) => out.push(line),
    stderr: (line) => out.push(line),
    openDatabase: () => db,
    readTextFile: (path) => {
      read.push(path);
      return file;
    },
  });
  return { code, queries, out, read };
};

const ERASE = ["identifiers", "erase", "--tenant", TENANT, "--actor", "owner"];

describe("erasing a number named by a file", () => {
  it("reads the whole file, trimmed, binds it, and prints only the count", async () => {
    const { code, queries, out, read } = await run([
      ...ERASE,
      "--number-file",
      "number.txt",
    ]);
    expect(code).toBe(0);
    expect(read).toEqual(["number.txt"]);
    expect(queries.at(-1)?.params).toEqual([TENANT, NUMBER, "owner"]);
    expect(out.map((line) => JSON.parse(line))).toEqual([
      { result: "erased", conversationsErased: 2 },
    ]);
    expect(out.join("\n")).not.toContain(NUMBER);
  });

  it("refuses a file holding two numbers, erasing nothing, rather than dropping one", async () => {
    const { code, queries, out } = await run(
      [...ERASE, "--number-file", "number.txt"],
      `${NUMBER}\n551100000858\n`,
    );
    expect(code).toBe(1);
    expect(queries.some((q) => q.sql.includes("erase_contact_by_number"))).toBe(
      false,
    );
    expect(out.join("\n")).not.toContain(NUMBER);
  });

  it("withholds a number typed where a flag was expected", async () => {
    const { code, out, queries } = await run([...ERASE, NUMBER]);
    expect(code).toBe(2);
    expect(queries).toEqual([]);
    expect(out.join("\n")).not.toContain(NUMBER);
    expect(out.join("\n")).toContain("<digits withheld>");
  });

  it("takes exactly one of --number and --number-file", () => {
    expect(parseOperatorArgs(ERASE).kind).toBe("usage_error");
    expect(
      parseOperatorArgs([
        ...ERASE,
        "--number",
        NUMBER,
        "--number-file",
        "number.txt",
      ]).kind,
    ).toBe("usage_error");
    expect(parseOperatorArgs([...ERASE, "--number", NUMBER]).kind).toBe(
      "identifiers erase",
    );
  });

  it("refuses an unreadable file before opening the database, echoing nothing of it", async () => {
    const queries: unknown[] = [];
    const out: string[] = [];
    const code = await runOperatorCli(
      [...ERASE, "--number-file", "missing.txt"],
      {
        env: { ADMIN_DATABASE_URL: "postgres://unit" },
        stdout: (line) => out.push(line),
        stderr: (line) => out.push(line),
        openDatabase: () => {
          queries.push("opened");
          throw new Error("not reached");
        },
        readTextFile: () => {
          throw new Error(`ENOENT ${NUMBER}`);
        },
      },
    );
    expect(code).toBe(2);
    expect(queries).toEqual([]);
    expect(out.join("\n")).not.toContain(NUMBER);
  });
});
