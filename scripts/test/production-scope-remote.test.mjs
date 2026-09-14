import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRODUCTION_FUNCTIONS } from "../production-scope.mjs";
import {
  checkRemoteFunctions,
  compareDeployedFunctions,
  functionListArgs,
  parseFunctionList,
  remoteTargetOf,
  reportRemoteFunctions,
} from "../production-scope-remote.mjs";

// The hosted check asks the target project which functions it serves (SI-03).
// Every stdout fixture below has the shape Supabase CLI 2.117.0 prints for its
// JSON function list (a pretty-printed array, or `null` for no functions). A
// CLI upgrade that changes the shape is a review event; until then the check
// fails closed. Nothing here reaches a hosted project: the CLI is stubbed.

const SCRIPT = fileURLToPath(
  new URL("../production-scope.mjs", import.meta.url),
);
const REF = "abcdefghijklmnopqrst";

const listed = (...entries) =>
  `${JSON.stringify(
    entries.map(([slug, status = "ACTIVE"]) => ({
      created_at: 1757000000000,
      id: `id-${slug}`,
      name: slug,
      slug,
      status,
      updated_at: 1757000000000,
      verify_jwt: false,
      version: 1,
    })),
    null,
    2,
  )}\n`;
const cliPrinting = (stdout) => () => ({ status: 0, signal: null, stdout });
const check = (runCli) =>
  checkRemoteFunctions(REF, { allowed: PRODUCTION_FUNCTIONS, runCli });

describe("hosted functions: reading the CLI's list", () => {
  it("reads an empty list, a null list and a listed function", () => {
    expect(parseFunctionList("[]\n")).toEqual({ ok: true, functions: [] });
    expect(parseFunctionList("null\n")).toEqual({ ok: true, functions: [] });
    expect(parseFunctionList(listed(["users"], ["mcp", "REMOVED"]))).toEqual({
      ok: true,
      functions: [
        { slug: "users", status: "ACTIVE" },
        { slug: "mcp", status: "REMOVED" },
      ],
    });
  });

  it("refuses anything that is not a readable list, without quoting it", () => {
    for (const stdout of [
      "",
      "<html>maintenance: secret-token</html>",
      "Fetching functions...\n[]",
      '{"functions":[],"message":""}',
      '["users"]',
      "[null]",
      '[{"slug":"","status":"ACTIVE"}]',
      '[{"status":"ACTIVE"}]',
      '[{"slug":7,"status":"ACTIVE"}]',
      '[{"slug":"../x","status":"ACTIVE"}]',
      '[{"slug":"a b","status":"ACTIVE"}]',
      '[{"slug":"users"}]',
      '[{"slug":"users","status":"active; rm"}]',
      listed(["users"], ["users"]),
    ]) {
      const parsed = parseFunctionList(stdout);
      expect(parsed.ok, stdout).toBe(false);
      expect(parsed.detail).not.toContain("secret-token");
    }
  });
});

describe("hosted functions: comparing with PRODUCTION_FUNCTIONS", () => {
  const compare = (...entries) =>
    compareDeployedFunctions(
      parseFunctionList(listed(...entries)).functions,
      PRODUCTION_FUNCTIONS,
    );

  it("passes a project serving reviewed functions, or none yet", () => {
    expect(compare()).toMatchObject({
      status: "pass",
      missing: [...PRODUCTION_FUNCTIONS].sort(),
    });
    expect(compare(...PRODUCTION_FUNCTIONS.map((f) => [f]))).toMatchObject({
      status: "pass",
      deployed: [...PRODUCTION_FUNCTIONS].sort(),
      missing: [],
    });
  });

  it("fails a project still serving the removed MCP function, or any other", () => {
    expect(compare(["users"], ["mcp"])).toMatchObject({
      status: "fail",
      unexpected: ["mcp"],
    });
    expect(compare(["Users"], ["mcp", "THROTTLED"])).toMatchObject({
      status: "fail",
      unexpected: ["Users", "mcp"],
    });
  });

  it("does not count a function the project lists as removed, and says so", () => {
    expect(compare(["users"], ["mcp", "REMOVED"])).toMatchObject({
      status: "pass",
      removed: ["mcp"],
    });
  });
});

describe("hosted functions: asking the CLI", () => {
  it("runs exactly the listing, with no workdir or profile of its own", () => {
    const calls = [];
    const result = check((args, options) => {
      calls.push({ args, options });
      return { status: 0, signal: null, stdout: listed(["users"]) };
    });
    expect(result.status).toBe("pass");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(functionListArgs(REF));
    expect(calls[0].args.join(" ")).toBe(
      `supabase functions list --project-ref ${REF} -o json`,
    );
    expect(calls[0].options.timeoutMs).toBeGreaterThan(0);
  });

  it("fails on an unexpected function and passes on reviewed ones", () => {
    expect(check(cliPrinting(listed(["users"], ["mcp"])))).toMatchObject({
      status: "fail",
      unexpected: ["mcp"],
    });
    expect(check(cliPrinting("null\n")).status).toBe("pass");
  });

  it("fails closed whenever it cannot get a readable answer", () => {
    for (const run of [
      { error: { code: "ENOENT" } },
      { error: { code: "ETIMEDOUT" }, signal: "SIGTERM" },
      { status: null, signal: "SIGKILL", stdout: "" },
      { status: 1, signal: null, stdout: "" },
      { status: 0, signal: null, stdout: "not json" },
    ]) {
      expect(check(() => run).status, JSON.stringify(run)).toBe("unverified");
    }
    expect(
      check(() => {
        throw new TypeError("spawn failed");
      }).status,
    ).toBe("unverified");
  });

  it("never runs the CLI for a ref that is not a project ref", () => {
    let ran = false;
    for (const ref of ["", "not-a-ref", "abcdefghijklmnopqrs1", "a;b"]) {
      const result = checkRemoteFunctions(ref, {
        allowed: PRODUCTION_FUNCTIONS,
        runCli: () => {
          ran = true;
          return { status: 0, stdout: "[]" };
        },
      });
      expect(result.status).toBe("unverified");
    }
    expect(ran).toBe(false);
  });
});

describe("hosted functions: choosing the project", () => {
  const env = {};
  it("takes an explicit ref, or the linked one", () => {
    expect(remoteTargetOf(["--project-ref", REF], { env })).toEqual({
      ref: REF,
    });
    expect(remoteTargetOf(["--linked"], { env, linkedRef: () => REF })).toEqual(
      { ref: REF },
    );
    expect(
      remoteTargetOf(["--project-ref", REF], {
        env: { SUPABASE_PROJECT_ID: REF },
      }),
    ).toEqual({ ref: REF });
  });

  it("refuses arguments it cannot read, and a CLI pointed elsewhere", () => {
    for (const [args, options] of [
      [[], { env }],
      [["--project-ref"], { env }],
      [["--project-ref", REF, "extra"], { env }],
      [["--project-ref", "not-a-ref"], { env }],
      [["--linked", REF], { env }],
      [["--linked"], { env, linkedRef: () => null }],
      [
        ["--project-ref", REF],
        { env: { SUPABASE_PROJECT_ID: "zyxwvutsrqponmlkjihg" } },
      ],
      [
        ["--linked"],
        {
          env: { SUPABASE_PROJECT_ID: "zyxwvutsrqponmlkjihg" },
          linkedRef: () => REF,
        },
      ],
      [["--project-ref", REF], { env: { SUPABASE_WORKDIR: "staging" } }],
    ]) {
      expect(remoteTargetOf(args, options).error, args.join(" ")).toBeTruthy();
    }
  });
});

describe("hosted functions: what it prints", () => {
  it("names unexpected functions, deletes nothing, and exits 1", () => {
    const report = reportRemoteFunctions({
      status: "fail",
      unexpected: ["mcp"],
    });
    expect(report).toMatchObject({ exitCode: 1, stream: "stderr" });
    expect(report.text).toContain("outside PRODUCTION_FUNCTIONS: mcp");
    expect(report.text).toContain("deletes nothing");
  });

  it("exits 0 on a pass and 2 when nothing was verified", () => {
    expect(
      reportRemoteFunctions({
        status: "pass",
        deployed: ["users"],
        missing: [],
        removed: ["mcp"],
      }),
    ).toMatchObject({ exitCode: 0, stream: "stdout" });
    const unverified = reportRemoteFunctions({
      status: "unverified",
      detail: "the Supabase CLI exited 1",
    });
    expect(unverified.exitCode).toBe(2);
    expect(unverified.text).toContain("Nothing was verified. Refusing.");
  });

  it("refuses bad arguments from the command line before asking anything", () => {
    for (const args of [
      ["--project-ref"],
      ["--project-ref", "not-a-ref"],
      ["--bogus"],
    ]) {
      const result = spawnSync(process.execPath, [SCRIPT, ...args], {
        encoding: "utf8",
        timeout: 60000,
      });
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stderr).toContain("Nothing was verified. Refusing.");
    }
  });
});
