import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSupabaseCommands } from "../production-scope-commands.mjs";
import {
  MEASURED_SUPABASE_CLI,
  SUPABASE_CLI_PACKAGE,
  pinnedSupabaseArgs,
  pinnedSupabaseCommand,
} from "../supabase-cli.mjs";

// Every database-gate and deploy path runs exactly the Supabase CLI the Phase
// 2C ownership mechanics were measured on. On 2026-09-25, Check #72 ran a bare
// `npx supabase`, got 2.118.0 minutes after its release, and was stopped by
// scripts/run-db-tests.mjs. These tests prove no unpinned invocation is left,
// and that the scan itself sees the spellings that were there before.

const ROOT = process.cwd();
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const PINNED = `npx --yes ${SUPABASE_CLI_PACKAGE}`;

/** Lines that execute something: comments are prose, not commands. */
const codeLines = (text, commentPrefixes) =>
  text
    .split(/\r?\n/)
    .map((line, at) => ({ line, at: at + 1 }))
    .filter(({ line }) => {
      const trimmed = line.trim();
      return !commentPrefixes.some((prefix) => trimmed.startsWith(prefix));
    });

/** An npx call of the CLI that is not the measured package. */
const UNPINNED_NPX = new RegExp(
  String.raw`\bnpx\s+(?:(?:--yes|-y)\s+)?supabase(?!@${MEASURED_SUPABASE_CLI.replaceAll(".", String.raw`\.`)}(?![\w.]))`,
);
/** An argument list that starts with the CLI's bare name: npx then runs whatever release is latest. */
const NPX_BARE_ARGUMENT = /\[\s*["'`]supabase["'`]\s*,/;
/** The CLI binary spawned by name: whatever version happens to be installed. */
const SPAWNED_BINARY =
  /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*["'`]supabase["'`]/;
/** A CLI call in a workflow `run`: the prefix, the CLI token and a subcommand. */
const WORKFLOW_CLI_CALL =
  /(?:^|[\s;&|(])((?:npx\s+(?:(?:--yes|-y)\s+)?)?)(supabase(?:@\S+)?)\s+[a-z]/g;

/** JavaScript that runs the CLI without the pinned helpers. */
const scriptViolations = (path, text) =>
  codeLines(text, ["//", "*", "/*"]).flatMap(({ line, at }) =>
    UNPINNED_NPX.test(line) ||
    NPX_BARE_ARGUMENT.test(line) ||
    SPAWNED_BINARY.test(line)
      ? [`${path}:${at}`]
      : [],
  );

/**
 * A workflow CLI call that is neither the pinned npx package nor, where the
 * workflow installs it pinned, the setup-cli binary.
 */
const workflowViolations = (path, text, { binaryAllowed }) =>
  codeLines(text, ["#", "name:", "- name:"]).flatMap(({ line, at }) =>
    [...line.matchAll(WORKFLOW_CLI_CALL)].flatMap(([, prefix, cli]) => {
      const call = `${prefix}${cli}`;
      const pinned = call === PINNED;
      const binary = binaryAllowed && prefix === "" && cli === "supabase";
      return pinned || binary ? [] : [`${path}:${at} ${call}`];
    }),
  );

/** The version supabase/setup-cli installs in a workflow, one per step. */
const setupCliVersions = (text) =>
  [
    ...text.matchAll(
      /uses:\s*supabase\/setup-cli@v1[^\S\n]*\r?\n\s+with:[^\S\n]*\r?\n\s+version:\s*([^\s#]+)/g,
    ),
  ].map((m) => m[1]);
const setupCliSteps = (text) =>
  (text.match(/uses:\s*supabase\/setup-cli@/g) ?? []).length;

/** The gate suites run by `npm run test:db`, and the helpers they import. */
const suiteFiles = () => {
  const top = readdirSync(join(ROOT, "supabase/tests"))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => `supabase/tests/${f}`);
  const probe = readdirSync(join(ROOT, "supabase/tests/companyOsProbe"))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => `supabase/tests/companyOsProbe/${f}`);
  return [...top, ...probe];
};

const WORKFLOWS = readdirSync(join(ROOT, ".github/workflows"))
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => `.github/workflows/${f}`);

describe("the measured Supabase CLI", () => {
  it("stays 2.117.0 until the S0.4 ownership mechanics are re-measured", () => {
    expect(MEASURED_SUPABASE_CLI).toBe("2.117.0");
    expect(SUPABASE_CLI_PACKAGE).toBe("supabase@2.117.0");
  });

  it("builds npx calls that name the exact package, never the latest release", () => {
    expect(pinnedSupabaseArgs(["--version"])).toEqual([
      "--yes",
      "supabase@2.117.0",
      "--version",
    ]);
    expect(pinnedSupabaseCommand(["status", "-o", "json"])).toBe(
      "npx --yes supabase@2.117.0 status -o json",
    );
  });
});

describe("no database-gate or deploy path runs an unpinned Supabase CLI", () => {
  it("database.yml calls only the measured package", () => {
    const text = read(".github/workflows/database.yml");
    expect(
      workflowViolations(".github/workflows/database.yml", text, {
        binaryAllowed: false,
      }),
    ).toEqual([]);
    const calls = codeLines(text, ["#"]).filter(({ line }) =>
      line.includes(PINNED),
    );
    expect(calls.map(({ line }) => line.trim())).toEqual([
      "run: npx --yes supabase@2.117.0 start",
      "run: npx --yes supabase@2.117.0 db reset --local --no-seed",
      "run: npx --yes supabase@2.117.0 db reset --local",
    ]);
  });

  it("deploy.yml installs the measured CLI with setup-cli and runs only that binary", () => {
    const path = ".github/workflows/deploy.yml";
    const text = read(path);
    expect(setupCliSteps(text)).toBe(1);
    expect(setupCliVersions(text)).toEqual([MEASURED_SUPABASE_CLI]);
    expect(
      codeLines(text, ["#"]).filter(({ line }) =>
        /\bnpx\b.*\bsupabase\b/.test(line),
      ),
    ).toEqual([]);
    expect(workflowViolations(path, text, { binaryAllowed: true })).toEqual([]);
    // Every CLI command runs after the install, as the bare binary: the link,
    // the push, the five secrets and the function deploy.
    const install = codeLines(text, ["#"]).find(({ line }) =>
      line.includes("uses: supabase/setup-cli@v1"),
    ).at;
    const commands = codeLines(text, ["#", "name:", "- name:"]).flatMap(
      ({ line, at }) =>
        parseSupabaseCommands(line).map((cmd) => ({
          at,
          command: cmd.command,
        })),
    );
    expect(commands.map((c) => c.command)).toEqual([
      "link",
      "db push",
      "secrets set",
      "secrets set",
      "secrets set",
      "secrets set",
      "secrets set",
      "functions deploy",
    ]);
    expect(commands.every(({ at }) => at > install)).toBe(true);
  });

  it("every other workflow calls only the measured package, or a setup-cli binary pinned to it", () => {
    for (const path of WORKFLOWS) {
      const text = read(path);
      const versions = setupCliVersions(text);
      expect(versions.length, path).toBe(setupCliSteps(text));
      expect(
        versions.every((version) => version === MEASURED_SUPABASE_CLI),
        path,
      ).toBe(true);
      expect(
        workflowViolations(path, text, { binaryAllowed: versions.length > 0 }),
      ).toEqual([]);
    }
  });

  it("the runner scripts and every suite test:db runs go through the pinned helpers", () => {
    const files = [
      "scripts/run-db-tests.mjs",
      "scripts/run-db-upgrade-test.mjs",
      ...suiteFiles(),
    ];
    expect(files).toContain("supabase/tests/opsDataApiExposure.mjs");
    expect(files).toContain("supabase/tests/companyOsProbe/common.mjs");
    expect(files.flatMap((path) => scriptViolations(path, read(path)))).toEqual(
      [],
    );
    for (const path of [
      "scripts/run-db-tests.mjs",
      "scripts/run-db-upgrade-test.mjs",
      "supabase/tests/opsDataApiExposure.mjs",
      "supabase/tests/companyOsProbe/common.mjs",
    ]) {
      expect(read(path), path).toMatch(/supabase-cli\.mjs"/);
    }
  });
});

describe("the scan sees the spellings it exists to refuse", () => {
  it("flags each call this fix replaced, and a drifted version", () => {
    // Arrange: the lines as they were before the pin, and near misses.
    const scripts = [
      'cli = execFileSync("npx", ["supabase", "--version"], {',
      'const result = spawnSync("npx", ["supabase", ...args], {',
      'const command = `npx supabase status -o env${WORKDIR ? ` --workdir ${WORKDIR}` : ""}`;',
      'execSync("npx --yes supabase@2.118.0 db reset --local");',
      'execSync("npx -y supabase@2.117.01 start");',
      'spawnSync("supabase", ["db", "reset", "--local"]);',
      '  args: ["supabase", ...args],',
    ];
    const paths = [
      'const UPGRADE_DIR = join("supabase", "tests", "upgrade");',
      'const TESTS_DIR = resolve(process.cwd(), "supabase", "tests");',
    ];
    const workflows = [
      "              run: npx supabase start",
      "              run: npx --yes supabase@2.118.0 db reset --local",
      "              run: npx supabase@latest db reset --local --no-seed",
      "              run: supabase start",
    ];

    // Act
    const flaggedScripts = scripts.flatMap((line) =>
      scriptViolations("x.mjs", line),
    );
    const flaggedWorkflows = workflows.flatMap((line) =>
      workflowViolations("w.yml", line, { binaryAllowed: false }),
    );

    // Assert: every one is refused; the pinned spellings are not.
    expect(flaggedScripts).toHaveLength(scripts.length);
    expect(flaggedWorkflows).toHaveLength(workflows.length);
    expect(paths.flatMap((line) => scriptViolations("x.mjs", line))).toEqual(
      [],
    );
    expect(
      workflowViolations(
        "w.yml",
        "            - name: 📡 Push supabase migrations",
        {
          binaryAllowed: false,
        },
      ),
    ).toEqual([]);
    expect(scriptViolations("x.mjs", `execSync("${PINNED} start");`)).toEqual(
      [],
    );
    expect(
      workflowViolations("w.yml", `              run: ${PINNED} start`, {
        binaryAllowed: false,
      }),
    ).toEqual([]);
  });

  it("flags npx in a deploy workflow and a setup-cli step left unpinned", () => {
    expect(
      workflowViolations("d.yml", "              run: npx supabase status", {
        binaryAllowed: true,
      }),
    ).toEqual(["d.yml:1 npx supabase"]);
    const unpinned =
      "            - name: Setup\n              uses: supabase/setup-cli@v1\n";
    expect(setupCliSteps(unpinned)).toBe(1);
    expect(setupCliVersions(unpinned)).toEqual([]);
    const latest = `${unpinned}              with:\n                  version: latest\n`;
    expect(setupCliVersions(latest)).toEqual(["latest"]);
  });
});
