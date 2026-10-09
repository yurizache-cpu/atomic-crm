// The owner's notification target commands (ADR 0026 §D): the number comes
// only from a file, reaches the database as a bound parameter and is printed
// nowhere; a usage message withholds any digits typed by mistake.

import { describe, expect, it } from "vitest";
import {
  FRONT_DESK_ACTS,
  parseFrontDeskArgs,
  runFrontDeskCli,
  withholdDigits,
} from "./frontDesk.ts";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const CHANNEL = "00000000-0000-4000-8000-0000000000c2";
const TARGET_ID = "00000000-0000-4000-8000-0000000000d3";
/** A synthetic number, as the owner's file holds it. */
const NUMBER = "5511900000977";

const RECORD = [
  "notify-target",
  "record",
  "--tenant",
  TENANT,
  "--channel",
  CHANNEL,
  "--number-file",
  "owner-number.txt",
  "--episode-template",
  "aviso_fila_conversa",
  "--digest-template",
  "aviso_fila_resumo",
  "--actor",
  "owner",
];

/** Runs one command against a scripted transaction; collects the SQL and the output. */
const run = async (
  argv: readonly string[],
  answer: (sql: string) => unknown[] = () => [],
) => {
  const asked: { sql: string; params: unknown[] }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const read: string[] = [];
  const tx = {
    async query(sql: string, params: unknown[] = []) {
      asked.push({ sql, params });
      return { rows: answer(sql) };
    },
  };
  const code = await runFrontDeskCli(argv, {
    env: { ADMIN_DATABASE_URL: "postgres://unit" },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    openDatabase: () =>
      ({
        withTransaction: async <T>(fn: (client: never) => Promise<T>) =>
          fn(tx as never),
        identity: async () => {
          throw new Error("unused");
        },
        close: async () => {},
      }) as never,
    readTextFile: (path) => {
      read.push(path);
      return `${NUMBER}\r\n`;
    },
  });
  return { code, asked, out, err, read };
};

describe("the owner's notification target", () => {
  it("is shown and listed read-only, and recorded or retired as the two new acts", () => {
    expect(
      FRONT_DESK_ACTS.filter((act) => act.startsWith("notify-target")),
    ).toEqual(["notify-target record", "notify-target retire"]);
    expect(FRONT_DESK_ACTS).not.toContain("notify-target show");
    expect(FRONT_DESK_ACTS).not.toContain("notifications");
    expect(
      parseFrontDeskArgs(["notify-target", "show", "--tenant", TENANT]).kind,
    ).toBe("notify-target show");
    expect(
      parseFrontDeskArgs(["notifications", "--tenant", TENANT, "--all"]).kind,
    ).toBe("notifications");
  });

  it("records only with every required flag, and never takes the number as a flag", () => {
    expect(parseFrontDeskArgs(RECORD).kind).toBe("notify-target record");
    for (const flag of [
      "--tenant",
      "--channel",
      "--number-file",
      "--episode-template",
      "--digest-template",
      "--actor",
    ]) {
      const at = RECORD.indexOf(flag);
      expect(
        parseFrontDeskArgs([...RECORD.slice(0, at), ...RECORD.slice(at + 2)])
          .kind,
      ).toBe("usage_error");
    }
    expect(parseFrontDeskArgs([...RECORD, "--number", NUMBER]).kind).toBe(
      "usage_error",
    );
  });

  it("withholds a number typed by mistake from the usage message", async () => {
    const { code, err, asked } = await run([...RECORD, "--number", NUMBER]);
    expect(code).toBe(2);
    expect(asked).toEqual([]);
    expect(err.join("\n")).not.toContain(NUMBER);
    expect(err.join("\n")).not.toContain(NUMBER.slice(2));
    expect(withholdDigits(`stray ${NUMBER} and 12345`)).toBe(
      "stray <digits withheld> and 12345",
    );
  });

  it("reads the number from its file, binds it, and prints only the target's id and whether it is a registered sender", async () => {
    const { code, asked, out, read } = await run(
      [...RECORD, "--quiet", "21:30-07:15", "--hourly-cap", "5"],
      (sql) =>
        sql.includes("record_owner_notification_target")
          ? [{ id: TARGET_ID }]
          : sql.includes("registered_test_sender")
            ? [{ registered: true }]
            : [],
    );
    expect(code).toBe(0);
    expect(read).toEqual(["owner-number.txt"]);
    const recorded = asked.find((q) =>
      q.sql.includes("ops.record_owner_notification_target"),
    );
    expect(recorded?.params).toEqual([
      TENANT,
      CHANNEL,
      NUMBER,
      "aviso_fila_conversa",
      "aviso_fila_resumo",
      "owner",
      "pt_BR",
      ["person_requested", "message_waiting"],
      "21:30",
      "07:15",
      "America/Sao_Paulo",
      5,
      30,
      "Contato",
    ]);
    expect(asked.map((q) => q.sql)).not.toContain("set transaction read only");
    expect(out.map((line) => JSON.parse(line))).toEqual([
      {
        result: "recorded",
        id: TARGET_ID,
        registeredTestSenderOnChannel: true,
      },
    ]);
    expect(out.join("\n")).not.toContain(NUMBER);
  });

  it("refuses malformed quiet hours before the database, echoing no value", async () => {
    const { code, asked, err } = await run([...RECORD, "--quiet", "22h-8h"]);
    expect(code).toBe(1);
    expect(
      asked.some((q) => q.sql.includes("record_owner_notification_target")),
    ).toBe(false);
    expect(err.join("\n")).not.toContain(NUMBER);
  });
});
