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

// A local stack is administrative infrastructure: Kong's /pg/ route and Studio's
// query route run arbitrary SQL as postgres with no key, and Postgres takes the
// default password. The suites below prove nothing about who ELSE can reach it,
// so say it here and again after the summary. Not fatal: the fix is a Docker
// Desktop setting this script cannot apply (CLAUDE.md, "Local Supabase must
// stay on loopback"). A CI runner has no LAN peers, so CI skips it, and says so.
const exposureWarning = (() => {
  if (process.env.GITHUB_ACTIONS === "true" || process.env.CI === "true") {
    process.stdout.write("Local exposure check skipped on a CI runner.\n");
    return null;
  }
  if (!CONTAINER.startsWith("supabase_db_")) {
    process.stdout.write(
      `Local exposure check skipped: ${CONTAINER} is not a Supabase CLI container. Run \`npm run check:local-exposure\`.\n`,
    );
    return null;
  }
  const exposure = run(process.execPath, [
    resolve(process.cwd(), "scripts", "local-exposure.mjs"),
    "--project",
    CONTAINER.slice("supabase_db_".length),
  ]);
  // Exit 0 alone is not trusted: an entry point whose main guard stopped
  // matching also exits 0, silently.
  if (exposure.ok && /^OK: /m.test(exposure.stdout)) {
    process.stdout.write(exposure.stdout);
    return null;
  }
  console.error(
    [
      "",
      "WARNING: this Supabase stack is reachable from other devices, or that could not be verified.",
      `${exposure.stdout}${exposure.stderr}`.trimEnd() ||
        "The exposure check printed nothing.",
      "See `npm run check:local-exposure` and CLAUDE.md before trusting this machine's network.",
      "",
    ].join("\n"),
  );
  return "WARNING: this Supabase stack is reachable from other devices, or that could not be verified (details above).";
})();

// The Phase 2C ownership mechanics -- a temporary role membership, a temporary
// CREATE and a catalogue-bound ownership transfer inside one allowlisted
// migration (docs/PHASE_2C_REPORT.md §3.2) -- were measured on exactly these
// versions: the CLI decides how a migration is applied (as whom, one
// transaction per file) and the server decides what those statements may do.
// Any other version fails here instead of passing on mechanics nobody measured;
// re-measure them before bumping either constant.
const MEASURED_SUPABASE_CLI = "2.117.0";
const MEASURED_POSTGRES_MAJOR = 15;

const versionMismatches = (() => {
  const found = [];
  // On Windows npx is a .cmd shim, which needs a shell; the arguments are
  // constants.
  let cli;
  try {
    cli = execFileSync("npx", ["supabase", "--version"], {
      encoding: "utf8",
      stdio: "pipe",
      shell: process.platform === "win32",
    }).trim();
  } catch (error) {
    cli = `unreadable (${error.message.split("\n")[0]})`;
  }
  if (cli !== MEASURED_SUPABASE_CLI) {
    found.push(`the Supabase CLI reports ${cli}, not ${MEASURED_SUPABASE_CLI}`);
  }
  const server = run("docker", [
    "exec",
    CONTAINER,
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-At",
    "-c",
    "show server_version_num",
  ]);
  const major = Math.floor(Number(server.stdout.trim()) / 10000);
  if (!server.ok || major !== MEASURED_POSTGRES_MAJOR) {
    found.push(
      `the database reports PostgreSQL major version ${server.ok ? major : "unreadable"}, not ${MEASURED_POSTGRES_MAJOR}`,
    );
  }
  return found;
})();

if (versionMismatches.length > 0) {
  console.error(
    [
      "FAILED: this stack is not the one the Phase 2C ownership mechanics were measured on:",
      ...versionMismatches.map((m) => `  - ${m}`),
      "",
      `They were measured on Supabase CLI ${MEASURED_SUPABASE_CLI} and PostgreSQL ${MEASURED_POSTGRES_MAJOR}`,
      "(spike S0.4, docs/PHASE_2C_REPORT.md §3.2). The remedy, in this order:",
      "  1. Re-measure the S0.4 ownership mechanics on the new version: the identity",
      "     every migration is applied as (current_user and session_user) and one",
      "     transaction per migration file; that the ownership transfer to",
      "     ops_operator_api needs both the temporary membership and the temporary",
      "     CREATE on company_os_api; that the ACL set before the transfer survives it;",
      "     that a failed migration rolls all of it back; and what the schema owner can",
      "     still do to a transferred function once the window is closed.",
      "  2. Only if they are unchanged, update the pinned constants",
      "     MEASURED_SUPABASE_CLI and MEASURED_POSTGRES_MAJOR in scripts/run-db-tests.mjs",
      "     (and docs/PHASE_2C_REPORT.md §3.2).",
      "In CI, .github/workflows/database.yml runs an unpinned `npx supabase`, so the",
      "first stable CLI release after the pinned one fails here with no repository",
      "change; pinning the CLI there is an owner decision.",
      "This is a failure, not a skip.",
    ].join("\n"),
  );
  process.exit(1);
}

const suites = readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

// Some properties cannot be expressed in a .sql file at all. Concurrent leasing
// needs two simultaneous connections, and one psql connection runs one
// transaction at a time -- a single-connection test would only prove that
// SKIP LOCKED parses. Those suites are Node scripts that open their own
// connections; they are run the same way and their exit code is the verdict.
const scriptSuites = readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith(".mjs"))
  .sort();

if (suites.length + scriptSuites.length === 0) {
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

for (const suite of scriptSuites) {
  const started = Date.now();
  const result = run(process.execPath, [join(TESTS_DIR, suite)]);
  const ms = Date.now() - started;

  if (result.ok) {
    process.stdout.write(`PASS ${suite} (${ms}ms)\n`);
    if (result.stdout.trim()) process.stdout.write(result.stdout);
  } else {
    failed += 1;
    console.error(`FAIL ${suite} (${ms}ms)`);
    console.error(`${result.stdout}${result.stderr}`.trim());
  }
}

const total = suites.length + scriptSuites.length;

if (failed > 0) {
  console.error(`\n${failed} of ${total} database suite(s) failed.`);
  if (exposureWarning) console.error(exposureWarning);
  process.exit(1);
}

process.stdout.write(`\n${total} database suite(s) passed.\n`);
// Repeated last, so `npm run test:db | tail` cannot hide it on a green run.
if (exposureWarning) console.error(exposureWarning);
