// The owner's front-desk tool: syntax, the act list, and the read-only default.

import { describe, expect, it } from "vitest";
import {
  FRONT_DESK_ACTS,
  parseFrontDeskArgs,
  runFrontDeskCli,
  textFromFile,
} from "./frontDesk.ts";

const TENANT = "00000000-0000-4000-8000-0000000000a1";

describe("the front-desk tool", () => {
  it("changes state only through its five acts", () => {
    expect(FRONT_DESK_ACTS).toEqual([
      "config draft",
      "config publish",
      "takeover",
      "release",
      "reply",
    ]);
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

  it("reads a text file without its byte-order mark or Windows line ends", () => {
    expect(
      textFromFile(String.fromCharCode(0xfeff) + "Oi\r\nTudo bem?\r\n"),
    ).toBe("Oi\nTudo bem?");
  });
});
