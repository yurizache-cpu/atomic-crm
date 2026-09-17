#!/usr/bin/env node
// Upgrade replay: a database that already holds data must come through the
// migration chain with its meaning intact (Phase 1D.2).
//
// Every other database check starts from an EMPTY schema. A migration that
// mishandles existing rows is invisible to them, and three such defects shipped
// in 20260911232039_pending_delta.sql (docs/PHASE_1D2_REPORT.md). This runner:
//
//   1. resets the database to BASE_VERSION, the last migration before
//      pending_delta, without the development seed;
//   2. loads supabase/tests/upgrade/legacy_fixture.sql, the data of an upstream
//      instance that has not been upgraded yet;
//   3. applies every later migration with `supabase migration up`, the way a
//      deploy would, and REQUIRES the owner guard to halt it, because the
//      fixture holds active legacy administrators and no owner
//      (20260917180300). It then checks the halted state;
//   4. performs the act the halt asks a person for
//      (supabase/tests/upgrade/operator_bootstrap.sql);
//   5. resumes with `supabase migration up`, which must now finish;
//   6. applies the idempotent migrations a SECOND time, as a replay;
//   7. runs supabase/tests/upgrade/upgrade_assertions.sql.
//
// DESTRUCTIVE: step 1 wipes the target database. It therefore refuses to run
// unless the container is the one the workdir's config.toml names, and unless
// a copied workdir holds the same migrations as supabase/. A second working copy
// on the development machine shares this repository's project_id (CLAUDE.md).
// Fails closed: a check that could not run exits 1, never 0.
//
// Usage:
//   npm run test:db:upgrade                        # the isolated e2e stack
//   SUPABASE_DB_CONTAINER=supabase_db_atomic-crm-demo \
//     npm run test:db:upgrade -- --workdir .       # CI, one stack
//
// The workdir is a flag, never an environment variable: the Supabase CLI reads
// a workdir variable of its own, and the deploy guards refuse it in workflows.
//
// The database is left upgraded and holding the fixture. Reset it afterwards;
// CI does, in the next step.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The last migration before 20260911232039_pending_delta.sql. */
export const BASE_VERSION = "20260911130000";
export const FIRST_UPGRADE_MIGRATION = "20260911232039_pending_delta.sql";

/** The migration that must halt an upgrade holding legacy administrators. */
export const OWNER_GUARD_MIGRATION =
  "20260917180300_legacy_administrators_upgrade_guard.sql";

/** The guard's own words. A halt for any other reason is a failure. */
export const HALT_MARKER = "upgrade halted: active administrator(s)";

/**
 * Migrations that claim to be idempotent and are therefore applied twice. Named
 * one by one rather than "everything after X", so that a later migration is
 * never replayed without someone deciding that it can be.
 */
export const REPLAYED_MIGRATIONS = [
  "20260917180000_backfill_legacy_deal_pipeline_stage.sql",
  "20260917180100_backfill_legacy_lead_profiles.sql",
  OWNER_GUARD_MIGRATION,
];

export const UPGRADE_DIR = join("supabase", "tests", "upgrade");
export const FIXTURE = join(UPGRADE_DIR, "legacy_fixture.sql");
export const HALTED_ASSERTIONS = join(UPGRADE_DIR, "halted_assertions.sql");
export const OPERATOR_ACT = join(UPGRADE_DIR, "operator_bootstrap.sql");
export const ASSERTIONS = join(UPGRADE_DIR, "upgrade_assertions.sql");

/** `project_id = "x"` from a Supabase config.toml, or null. */
export const parseProjectId = (toml) =>
  /^\s*project_id\s*=\s*"([^"]+)"\s*$/m.exec(toml)?.[1] ?? null;

/** Line endings differ between a Windows and a Linux checkout. */
const normalise = (text) => text.replace(/\r\n/g, "\n");

/**
 * The base must be the migration immediately before pending_delta. If someone
 * inserts a migration between them, the fixture no longer describes the schema
 * it is loaded into, so refuse instead of measuring something else.
 */
export const checkBaseVersion = (migrationFiles) => {
  const sorted = [...migrationFiles].sort();
  const upgradeAt = sorted.indexOf(FIRST_UPGRADE_MIGRATION);
  if (upgradeAt < 1) {
    return `${FIRST_UPGRADE_MIGRATION} is missing or has no predecessor`;
  }
  const base = sorted[upgradeAt - 1];
  if (!base.startsWith(`${BASE_VERSION}_`)) {
    return `the migration before ${FIRST_UPGRADE_MIGRATION} is ${base}, not ${BASE_VERSION}_*`;
  }
  return null;
};

/**
 * Names of migrations that differ between two directories: missing on either
 * side, or with different content. `.supabase-e2e` holds COPIES, and a reset
 * against stale copies silently measures the old schema.
 */
export const differingMigrations = (sourceDir, copyDir) => {
  const list = (dir) =>
    existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sql")) : [];
  const source = list(sourceDir);
  const copy = list(copyDir);
  const names = [...new Set([...source, ...copy])].sort();
  return names.filter(
    (name) =>
      !source.includes(name) ||
      !copy.includes(name) ||
      normalise(readFileSync(join(sourceDir, name), "utf8")) !==
        normalise(readFileSync(join(copyDir, name), "utf8")),
  );
};

/**
 * Everything that must hold before the destructive reset. Returns a list of
 * reasons to refuse; empty means go.
 */
export const preflight = ({ repoRoot, workdir, container }) => {
  const problems = [];
  const workdirSupabase = resolve(repoRoot, workdir, "supabase");
  const configPath = join(workdirSupabase, "config.toml");
  if (!existsSync(configPath)) {
    return [`no Supabase config at ${configPath}`];
  }
  const projectId = parseProjectId(readFileSync(configPath, "utf8"));
  if (!projectId) {
    return [`no project_id in ${configPath}`];
  }
  const expected = `supabase_db_${projectId}`;
  if (container !== expected) {
    problems.push(
      `container ${container} is not the database of ${configPath} (project_id ${projectId}, container ${expected}); refusing to reset it`,
    );
  }

  const sourceMigrations = join(repoRoot, "supabase", "migrations");
  const baseProblem = checkBaseVersion(
    readdirSync(sourceMigrations).filter((f) => f.endsWith(".sql")),
  );
  if (baseProblem) problems.push(baseProblem);

  for (const name of REPLAYED_MIGRATIONS) {
    if (!existsSync(join(sourceMigrations, name))) {
      problems.push(`replayed migration ${name} does not exist`);
    }
  }
  for (const file of [FIXTURE, HALTED_ASSERTIONS, OPERATOR_ACT, ASSERTIONS]) {
    if (!existsSync(join(repoRoot, file))) problems.push(`missing ${file}`);
  }

  if (resolve(workdirSupabase) !== resolve(repoRoot, "supabase")) {
    const stale = differingMigrations(
      sourceMigrations,
      join(workdirSupabase, "migrations"),
    );
    if (stale.length > 0) {
      problems.push(
        `${workdir}/supabase/migrations differs from supabase/migrations (${stale.join(", ")}); copy them across first`,
      );
    }
  }
  return problems;
};

/**
 * `--workdir <dir>`, or the isolated e2e stack when no argument is given.
 * Anything else is null, so a mistyped argument never silently selects a
 * database to reset.
 */
export const parseWorkdir = (argv) => {
  if (argv.length === 0) return ".supabase-e2e";
  if (argv.length === 2 && argv[0] === "--workdir" && argv[1].trim() !== "") {
    return argv[1];
  }
  return null;
};

/**
 * Whether a `supabase migration up` result is the owner guard's halt and
 * nothing else. No halt at all, or a halt for another reason, is not it.
 */
export const isGuardHalt = ({ status, output }) =>
  Number.isInteger(status) && status !== 0 && output.includes(HALT_MARKER);

const fail = (message) => {
  console.error(`FAILED: ${message}`);
  console.error(
    "\nThis is a failure, not a skip: an upgrade replay that did not run has verified nothing.",
  );
  process.exit(1);
};

const isContainerRunning = (container) => {
  try {
    const out = execFileSync(
      "docker",
      ["ps", "--filter", `name=^/${container}$`, "--format", "{{.Names}}"],
      { encoding: "utf8", stdio: "pipe" },
    );
    return out.trim() === container;
  } catch {
    return false;
  }
};

/**
 * The Supabase CLI through npx. On Windows npx is a .cmd, which needs a shell;
 * every argument here is a constant or the workdir, never outside input.
 */
const runSupabase = (args) => {
  const result = spawnSync("npx", ["supabase", ...args], {
    encoding: "utf8",
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
};

const supabase = (args) => {
  const { status, output } = runSupabase(args);
  if (status !== 0) {
    fail(`CLI step "${args.join(" ")}" exited ${status}\n${output}`.trimEnd());
  }
};

/** Feed SQL to psql on stdin: Git Bash rewrites container paths given to -f. */
const psql = (container, label, sql) => {
  try {
    execFileSync(
      "docker",
      [
        "exec",
        "-i",
        container,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { input: sql, encoding: "utf8", stdio: "pipe" },
    );
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    const detail = output
      .split("\n")
      .filter((line) => /error|exception|context/i.test(line))
      .join("\n")
      .trim();
    fail(`${label}\n${detail || output.trim()}`);
  }
};

const main = () => {
  const repoRoot = process.cwd();
  const workdir = parseWorkdir(process.argv.slice(2));
  if (workdir === null) {
    fail("usage: run-db-upgrade-test.mjs [--workdir <dir>]");
  }
  const container =
    process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_atomic-crm-e2e";

  const problems = preflight({ repoRoot, workdir, container });
  if (problems.length > 0) fail(problems.join("\n"));
  if (!isContainerRunning(container)) {
    fail(
      `no running database container named "${container}". Start the stack: npx supabase start --workdir ${workdir}`,
    );
  }

  const read = (file) => readFileSync(join(repoRoot, file), "utf8");
  const step = (text) => process.stdout.write(`${text}\n`);
  const migrationUp = ["migration", "up", "--workdir", workdir, "--local"];

  step(`1/7 reset ${container} to ${BASE_VERSION} (no seed)`);
  supabase([
    "db",
    "reset",
    "--workdir",
    workdir,
    "--local",
    "--no-seed",
    "--version",
    BASE_VERSION,
  ]);

  step("2/7 load the legacy fixture");
  psql(container, "legacy fixture failed", read(FIXTURE));

  step("3/7 upgrade: supabase migration up, which the owner guard must halt");
  const halted = runSupabase(migrationUp);
  if (!isGuardHalt(halted)) {
    fail(
      `the upgrade did not stop at the owner guard (exit ${halted.status})\n${halted.output}`.trimEnd(),
    );
  }
  psql(container, "the halted state is wrong", read(HALTED_ASSERTIONS));

  step("4/7 the person's act: bootstrap the chosen owner");
  psql(container, "the owner bootstrap failed", read(OPERATOR_ACT));

  step("5/7 resume: supabase migration up");
  supabase(migrationUp);

  step(`6/7 replay ${REPLAYED_MIGRATIONS.length} idempotent migration(s)`);
  for (const name of REPLAYED_MIGRATIONS) {
    psql(
      container,
      `replaying ${name} failed`,
      read(join("supabase", "migrations", name)),
    );
  }

  step("7/7 upgrade assertions");
  psql(container, "upgrade assertions failed", read(ASSERTIONS));

  step("\nPASS upgrade replay: legacy data kept its meaning.");
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
