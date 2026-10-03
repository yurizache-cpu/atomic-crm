// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MODEL_ACTS, parseModelsArgs, runModelsCli } from "./models.ts";

describe("npm run models", () => {
  it("has exactly the reviewed acts; everything else is a read", () => {
    expect([...MODEL_ACTS]).toEqual([
      "record",
      "enable",
      "disable",
      "pool add",
      "pool remove",
      "profile record",
      "outcome record",
    ]);
  });

  it("parses a model record with every class", () => {
    const parsed = parseModelsArgs([
      "record",
      "--gateway",
      "openrouter",
      "--model",
      "openai/gpt-6-luna",
      "--family",
      "openai",
      "--structured",
      "yes",
      "--reasoning",
      "yes",
      "--tools",
      "no",
      "--context",
      "long",
      "--latency",
      "fast",
      "--cost",
      "low",
      "--source",
      "openrouter catalog 2026-10-02",
      "--actor",
      "owner:yuri",
      "--accepted-builds",
      "openai/gpt-6-luna-20260922",
    ]);
    expect(parsed.kind).toBe("record");
  });

  it.each([
    [["record", "--gateway", "openrouter"], /needs --model/],
    [["enable"], /needs --gateway/],
    [
      [
        "profile",
        "record",
        "--tenant",
        "t",
        "--agent",
        "a",
        "--objective",
        "o",
        "--capabilities",
        "lead_triage",
        "--data-classes",
        "synthetic",
        "--ceiling-usd",
        "1.2.3",
        "--timezone",
        "UTC",
        "--actor",
        "x",
      ],
      /US dollars/,
    ],
    [["economics", "--tenant", "t", "--since", "yesterday"], /offset/],
    [
      [
        "pool",
        "add",
        "--pool",
        "p",
        "--gateway",
        "g",
        "--model",
        "m",
        "--rank",
        "0",
        "--actor",
        "x",
      ],
      /rank/,
    ],
    [["drop", "everything"], /unknown command/],
  ])("refuses %j before any connection", async (argv, message) => {
    const parsed = parseModelsArgs(argv as string[]);
    expect(parsed.kind).toBe("usage_error");
    if (parsed.kind === "usage_error") expect(parsed.message).toMatch(message);
  });

  it("needs only ADMIN_DATABASE_URL and opens nothing on a usage error", async () => {
    const err: string[] = [];
    let opened = false;
    const code = await runModelsCli(["list"], {
      env: {},
      stdout: () => {},
      stderr: (line) => err.push(line),
      openDatabase: () => {
        opened = true;
        throw new Error("never");
      },
    });
    expect(code).toBe(2);
    expect(opened).toBe(false);
    expect(err.join("\n")).toMatch(/ADMIN_DATABASE_URL/);
  });
});
