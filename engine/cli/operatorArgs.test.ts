// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseOperatorArgs } from "./operator.ts";
import {
  ACTS,
  COMPANY,
  LIMIT,
  LIMIT_RETIRE,
  LIMIT_SET,
  PRICE_RECORD,
  READS,
  TENANT,
  withoutFlag,
} from "./testSupport/operatorArgv.ts";

// What the operator tool accepts and refuses before it reads its environment or
// opens a database. Running the commands is operator.test.ts.

describe("parsing operator arguments", () => {
  it.each<[readonly string[], object]>([
    [["status"], { kind: "status" }],
    [["routes"], { kind: "routes" }],
    [["stops"], { kind: "stops", includeCleared: false }],
    [["stops", "--all"], { kind: "stops", includeCleared: true }],
    [["prices", "--all"], { kind: "prices", includeHistory: true }],
    [["limits"], { kind: "limits", includeHistory: false }],
    [["spend", "--tenant", TENANT], { kind: "spend", tenantId: TENANT }],
    [["indeterminate"], { kind: "indeterminate" }],
    [
      ["runs", "--limit", "20", "--status", "running", "--tenant", TENANT],
      { kind: "runs", tenantId: TENANT, status: "running", limit: 20 },
    ],
  ])("parses %j", (argv, expected) => {
    expect(parseOperatorArgs(argv)).toEqual(expected);
  });

  it("parses a price record, with an optional cached rate and yes or no for reasoning", () => {
    expect(parseOperatorArgs(PRICE_RECORD)).toEqual({
      kind: "price record",
      input: {
        provider: "openai",
        model: "gpt-test-2026-01-01",
        inputUsdPerMtok: "2.50",
        outputUsdPerMtok: "10",
        reasoningInOutput: true,
        effectiveFrom: "2026-09-17T00:00:00Z",
        expiresAt: "2026-12-17T00:00:00Z",
      },
      act: {
        source: "provider pricing page, read 2026-09-17",
        actor: "owner",
      },
    });
    const withCached = [
      ...PRICE_RECORD.map((token) => (token === "yes" ? "no" : token)),
      "--cached-input-usd-per-mtok",
      "1.25",
    ];
    expect(parseOperatorArgs(withCached)).toMatchObject({
      input: { reasoningInOutput: false, cachedInputUsdPerMtok: "1.25" },
    });
  });

  it("parses a limit set and a limit retire", () => {
    expect(parseOperatorArgs(LIMIT_SET)).toEqual({
      kind: "limit set",
      target: { scope: "tenant", tenantId: TENANT },
      value: { dailyUsd: "25.50", timezone: "America/Sao_Paulo" },
      act: { reason: "clinic launch budget", actor: "owner" },
    });
    expect(
      parseOperatorArgs([
        "limit",
        "set",
        "--scope",
        "company",
        "--company",
        COMPANY,
        "--tenant",
        TENANT,
        "--daily-usd",
        "5",
        "--timezone",
        "UTC",
        "--reason",
        "pilot",
        "--actor",
        "ops:on-call",
      ]),
    ).toMatchObject({
      target: { scope: "company", tenantId: TENANT, companyId: COMPANY },
    });
    expect(parseOperatorArgs(LIMIT_RETIRE)).toEqual({
      kind: "limit retire",
      limitId: LIMIT,
      act: { reason: "budget replaced", actor: "owner" },
    });
  });

  it.each<[string, readonly string[], string]>([
    ["no arguments", [], "no command given"],
    ["an unknown command", ["stats"], "unknown command"],
    ["a command in the wrong case", ["STATUS"], "unknown command"],
    ["a flag in place of a command", ["--all"], "unknown command"],
    ["price with no subcommand", ["price"], "price needs a subcommand: record"],
    [
      "an unknown price subcommand",
      ["price", "delete"],
      "price needs a subcommand",
    ],
    [
      "limit with no subcommand",
      ["limit"],
      "limit needs a subcommand: set or retire",
    ],
    [
      "a flag in place of a subcommand",
      ["limit", "--id", LIMIT],
      "limit needs a subcommand",
    ],
    [
      "a command and its subcommand in one argument",
      ["price record", ...PRICE_RECORD.slice(2)],
      "unknown command",
    ],
    [
      "a retire spelled as one argument",
      ["limit retire", ...LIMIT_RETIRE.slice(2)],
      "unknown command",
    ],
    ["a subcommand on a list", ["prices", "record"], "unexpected argument"],
    ["a positional argument", ["runs", "20"], "unexpected argument"],
    ["a short flag", ["stops", "-a"], "unexpected argument"],
    ["--force on a read", ["status", "--force"], 'unknown flag "--force"'],
    ["--force on an act", [...LIMIT_SET, "--force"], 'unknown flag "--force"'],
    [
      "--override on retire",
      [...LIMIT_RETIRE, "--override"],
      'unknown flag "--override"',
    ],
    ["--yes on a price", [...PRICE_RECORD, "--yes"], 'unknown flag "--yes"'],
    ["--help", ["status", "--help"], "unknown flag"],
    ["an inline flag value", ["runs", "--limit=20"], "unknown flag"],
    ["an inherited property name", ["stops", "--constructor"], "unknown flag"],
    ["a bare double dash", ["stops", "--"], "unknown flag"],
    [
      "a flag of another command",
      ["status", "--tenant", TENANT],
      "--tenant is not a flag of status",
    ],
    [
      "an act's flag on a read",
      ["runs", "--actor", "owner"],
      "--actor is not a flag of runs",
    ],
    [
      "a coordinate on retire",
      [...LIMIT_RETIRE, "--tenant", TENANT],
      "--tenant is not a flag of limit retire",
    ],
    [
      "a repeated switch",
      ["stops", "--all", "--all"],
      "--all is given more than once",
    ],
    [
      "a repeated amount",
      [...LIMIT_SET, "--daily-usd", "1"],
      "--daily-usd is given more than once",
    ],
    ["a flag with no value", ["runs", "--limit"], "--limit needs a value"],
    [
      "a flag followed by another flag",
      ["spend", "--tenant", "--all"],
      "--tenant needs a value",
    ],
    [
      "a price with no actor",
      withoutFlag(PRICE_RECORD, "actor"),
      "price record needs --actor",
    ],
    [
      "a price with no reasoning statement",
      withoutFlag(PRICE_RECORD, "reasoning-in-output"),
      "price record needs --reasoning-in-output",
    ],
    [
      "a limit with no time zone",
      withoutFlag(LIMIT_SET, "timezone"),
      "limit set needs --timezone",
    ],
    [
      "a retire with no id",
      ["limit", "retire", "--reason", "x", "--actor", "owner"],
      "limit retire needs --id",
    ],
    [
      "a reasoning answer that is not yes or no",
      PRICE_RECORD.map((t) => (t === "yes" ? "true" : t)),
      "--reasoning-in-output must be yes or no",
    ],
    [
      "an unknown run status",
      ["runs", "--status", "stuck"],
      "--status must be one of pending, running",
    ],
    [
      "a limit that is not a whole number",
      ["runs", "--limit", "ten"],
      "--limit must be a whole number",
    ],
    [
      "a negative limit",
      ["runs", "--limit", "-1"],
      "--limit must be a whole number",
    ],
    [
      "a limit with an exponent",
      ["runs", "--limit", "1e2"],
      "--limit must be a whole number",
    ],
    [
      "an unknown limit scope",
      LIMIT_SET.map((t) => (t === "tenant" ? "fleet" : t)),
      "--scope must be one of global, tenant, company",
    ],
  ])("refuses %s as a usage error", (_case, argv, fragment) => {
    const command = parseOperatorArgs(argv);

    expect(command.kind).toBe("usage_error");
    expect((command as { message: string }).message).toContain(fragment);
  });

  it("offers no force or override flag on any command", () => {
    for (const argv of [...READS, ...ACTS]) {
      for (const flag of ["--force", "--override", "--unsafe"]) {
        expect(parseOperatorArgs([...argv, flag])).toEqual({
          kind: "usage_error",
          message: `unknown flag ${JSON.stringify(flag)}`,
        });
      }
    }
  });

  it("does not modify its arguments and answers the same way twice", () => {
    const argv = Object.freeze([...LIMIT_SET]);

    expect(parseOperatorArgs(argv)).toEqual(parseOperatorArgs(argv));
    expect(argv).toEqual(LIMIT_SET);
  });
});
