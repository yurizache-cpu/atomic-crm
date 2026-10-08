// The owner's front-desk tool: syntax, the act list, and the read-only default.

import { describe, expect, it } from "vitest";
import { MAX_LISTED_EXCEPTIONS } from "../domain/exceptionQueue.ts";
import {
  FRONT_DESK_ACTS,
  parseFrontDeskArgs,
  runFrontDeskCli,
  textFromFile,
} from "./frontDesk.ts";

const TENANT = "00000000-0000-4000-8000-0000000000a1";

describe("the front-desk tool", () => {
  it("changes state only through its seven acts", () => {
    expect(FRONT_DESK_ACTS).toEqual([
      "config draft",
      "config publish",
      "takeover",
      "release",
      "reply",
      "exception resolve",
      "exceptions sync",
    ]);
  });

  it("lists exceptions read-only, open by default and all with --all", () => {
    const open = parseFrontDeskArgs(["exceptions", "--tenant", TENANT]);
    expect(open).toMatchObject({ kind: "exceptions" });
    expect(open.kind !== "usage_error" && open.switches.has("all")).toBe(false);
    const all = parseFrontDeskArgs(["exceptions", "--tenant", TENANT, "--all"]);
    expect(all.kind !== "usage_error" && all.switches.has("all")).toBe(true);
    expect(FRONT_DESK_ACTS).not.toContain("exceptions");
    expect(
      parseFrontDeskArgs(["exceptions", "--tenant", TENANT, "--all", "x"]).kind,
    ).toBe("usage_error");
  });

  it("resolves an exception only with its tenant, id, resolution, the count it saw and actor", () => {
    const full = [
      "exception",
      "resolve",
      "--tenant",
      TENANT,
      "--id",
      TENANT,
      "--resolution",
      "dismissed",
      "--occurrences",
      "2",
      "--actor",
      "owner",
    ];
    expect(parseFrontDeskArgs(full).kind).toBe("exception resolve");
    for (const flag of [
      "--tenant",
      "--id",
      "--resolution",
      "--occurrences",
      "--actor",
    ]) {
      const index = full.indexOf(flag);
      const without = [...full.slice(0, index), ...full.slice(index + 2)];
      expect(parseFrontDeskArgs(without).kind).toBe("usage_error");
    }
    expect(
      parseFrontDeskArgs(["exceptions", "sync", "--tenant", TENANT]).kind,
    ).toBe("exceptions sync");
  });

  it("parses a two-word command and its flags", () => {
    const parsed = parseFrontDeskArgs(["config", "list", "--tenant", TENANT]);
    expect(parsed.kind).toBe("config list");
  });

  it("refuses an unknown command, a missing flag and a flag of another command", () => {
    expect(parseFrontDeskArgs(["config", "delete"]).kind).toBe("usage_error");
    expect(parseFrontDeskArgs(["takeover", "--tenant", TENANT]).kind).toBe(
      "usage_error",
    );
    expect(
      parseFrontDeskArgs([
        "screenings",
        "--tenant",
        TENANT,
        "--kind",
        "knowledge",
      ]).kind,
    ).toBe("usage_error");
  });

  it("has no command that sends, deletes or sets an autonomous mode", () => {
    for (const verb of ["send", "delete", "autonomous", "enable"]) {
      expect(parseFrontDeskArgs([verb, "--tenant", TENANT]).kind).toBe(
        "usage_error",
      );
    }
  });

  it("needs ADMIN_DATABASE_URL and opens nothing without it", async () => {
    const lines: string[] = [];
    let opened = false;
    const code = await runFrontDeskCli(["screenings", "--tenant", TENANT], {
      env: {},
      stdout: () => undefined,
      stderr: (line) => lines.push(line),
      openDatabase: () => {
        opened = true;
        throw new Error("not reached");
      },
      readTextFile: () => "",
    });
    expect(code).toBe(2);
    expect(opened).toBe(false);
  });

  it("carries --all, and the exception's id, resolution, count and actor, to the database in their places", async () => {
    const EXCEPTION = "00000000-0000-4000-8000-0000000000e1";
    const run = async (argv: readonly string[]) => {
      const asked: { sql: string; params: unknown[] }[] = [];
      const tx = {
        async query(sql: string, params: unknown[] = []) {
          asked.push({ sql, params });
          return sql.includes("ops.resolve_exception")
            ? { rows: [{ answer: { state: "dismissed" } }] }
            : { rows: [] };
        },
      };
      const code = await runFrontDeskCli(argv, {
        env: { ADMIN_DATABASE_URL: "postgres://unit" },
        stdout: () => undefined,
        stderr: () => undefined,
        openDatabase: () =>
          ({
            withTransaction: async <T>(fn: (client: never) => Promise<T>) =>
              fn(tx as never),
            identity: async () => {
              throw new Error("unused");
            },
            close: async () => {},
          }) as never,
        readTextFile: () => "",
      });
      return { code, asked };
    };

    const open = await run(["exceptions", "--tenant", TENANT]);
    const all = await run(["exceptions", "--tenant", TENANT, "--all"]);
    for (const [answer, everything] of [
      [open, false],
      [all, true],
    ] as const) {
      expect(answer.code).toBe(0);
      expect(answer.asked[0].sql).toBe("set transaction read only");
      expect(answer.asked[1].params.slice(0, 2)).toEqual([TENANT, everything]);
    }

    const resolved = await run([
      "exception",
      "resolve",
      "--tenant",
      TENANT,
      "--id",
      EXCEPTION,
      "--resolution",
      "dismissed",
      "--occurrences",
      "3",
      "--actor",
      "owner",
    ]);
    expect(resolved.code).toBe(0);
    expect(resolved.asked.map((q) => q.sql)).not.toContain(
      "set transaction read only",
    );
    expect(resolved.asked[0].params).toEqual([
      TENANT,
      EXCEPTION,
      "dismissed",
      "owner",
      3,
    ]);
  });

  it("ends a capped exception listing with a truncated line", async () => {
    const row = (i: number) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      kind: "message_waiting",
      priority: "normal",
      subject_kind: "conversation",
      conversation_id: TENANT,
      outbound_message_id: null,
      task_id: TENANT,
      detail: null,
      raised_at: "2026-10-07T00:00:00.000000Z",
      raised_by: "front-desk",
      occurrences: 1,
      last_raised_at: "2026-10-07T00:00:00.000000Z",
      last_task_id: TENANT,
      resolved_at: null,
      resolved_by: null,
      resolution: null,
    });
    const lines: string[] = [];
    const tx = {
      async query(sql: string, params: unknown[] = []) {
        if (sql === "set transaction read only") return { rows: [] };
        const limit = params[2] as number;
        return { rows: Array.from({ length: limit }, (_, i) => row(i)) };
      },
    };
    const code = await runFrontDeskCli(["exceptions", "--tenant", TENANT], {
      env: { ADMIN_DATABASE_URL: "postgres://unit" },
      stdout: (line) => lines.push(line),
      stderr: () => undefined,
      openDatabase: () =>
        ({
          withTransaction: async <T>(fn: (client: never) => Promise<T>) =>
            fn(tx as never),
          identity: async () => {
            throw new Error("unused");
          },
          close: async () => {},
        }) as never,
      readTextFile: () => "",
    });
    expect(code).toBe(0);
    expect(lines).toHaveLength(MAX_LISTED_EXCEPTIONS + 1);
    expect(JSON.parse(lines.at(-1) as string)).toEqual({
      truncated: true,
      shown: MAX_LISTED_EXCEPTIONS,
    });
  });

  it("reads a text file without its byte-order mark or Windows line ends", () => {
    expect(
      textFromFile(String.fromCharCode(0xfeff) + "Oi\r\nTudo bem?\r\n"),
    ).toBe("Oi\nTudo bem?");
  });
});
