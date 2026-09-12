#!/usr/bin/env node
// Run the SQL test suites in supabase/tests/ against a LOCAL Supabase database.
//
// Deliberately fails closed. If no database can be reached, this exits non-zero
// rather than reporting success: the whole point of these suites is that the
// security properties are verified, and "could not check" is not "verified".
// Pass --allow-missing-db to downgrade that to a skip (used by nothing today;
// it exists so a caller has to opt in explicitly, in writing).
//
// Usage:
//   npm run test:db
//   SUPABASE_DB_CONTAINER=supabase_db_atomic-crm-e2e npm run test:db
//
// The container defaults to the isolated e2e stack, because the repository's
// default project_id collides with another working copy on this machine -- see
// docs/PHASE_0_5B_DATABASE_VERIFICATION.md section 3a. Resetting the wrong stack
// destroys the other project's database.

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const TESTS_DIR = resolve(process.cwd(), "supabase", "tests");
const CONTAINER =
  process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_atomic-crm-e2e";
const ALLOW_MISSING = process.argv.includes("--allow-missing-db");

/** Run a command, returning {ok, stdout, stderr} instead of throwing. */
const run = (cmd, args) => {
  try {
    return {
      ok: true,
      stdout: execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe" }),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? String(error),
    };
  }
};

const isContainerRunning = () => {
  const result = run("docker", [
    "ps",
    "--filter",
    `name=^/${CONTAINER}$`,
    "--format",
    "{{.Names}}",
  ]);
  return result.ok && result.stdout.trim() === CONTAINER;
};

if (!isContainerRunning()) {
  const message = [
    `No running database container named "${CONTAINER}".`,
    "",
    "Start the isolated stack first:",
    "  npx supabase start --workdir .supabase-e2e",
    "",
    "Or point this at another one:",
    "  SUPABASE_DB_CONTAINER=<name> npm run test:db",
  ].join("\n");

  if (ALLOW_MISSING) {
    process.stdout.write(`SKIPPED (--allow-missing-db): ${message}\n`);
    process.exit(0);
  }
  console.error(`FAILED: ${message}`);
  console.error(
    "\nThis is a failure, not a skip: a security suite that did not run has verified nothing.",
  );
  process.exit(1);
}

const suites = readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (suites.length === 0) {
  console.error(`FAILED: no .sql suites found in ${TESTS_DIR}`);
  process.exit(1);
}

let failed = 0;

for (const suite of suites) {
  const localPath = join(TESTS_DIR, suite);
  const remotePath = `/tmp/${suite}`;

  const copied = run("docker", ["cp", localPath, `${CONTAINER}:${remotePath}`]);
  if (!copied.ok) {
    console.error(`FAIL ${suite}: could not copy into the container`);
    console.error(copied.stderr.trim());
    failed += 1;
    continue;
  }

  const started = Date.now();
  const result = run("docker", [
    "exec",
    CONTAINER,
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-q",
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    remotePath,
  ]);
  const ms = Date.now() - started;

  if (result.ok) {
    process.stdout.write(`PASS ${suite} (${ms}ms)\n`);
  } else {
    failed += 1;
    const detail = `${result.stdout}\n${result.stderr}`
      .split("\n")
      .filter((line) => /error/i.test(line))
      .join("\n")
      .trim();
    console.error(`FAIL ${suite} (${ms}ms)`);
    console.error(detail || result.stderr.trim());
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${suites.length} database suite(s) failed.`);
  process.exit(1);
}

process.stdout.write(`\n${suites.length} database suite(s) passed.\n`);
