#!/usr/bin/env node
// Verifies what can be READ from a hosted Supabase project against the
// production contract. Read-only: it changes nothing and creates nothing.
//
//   node scripts/verify-hosted-supabase.mjs --url https://<project>.supabase.co \
//        [--publishable-key <key>] [--database] [--json] [--local-self-test]
//
// From outside (the public auth settings, with the publishable key, which
// VITE_SB_PUBLISHABLE_KEY supplies by default):
//   - self-registration is closed (accounts are made by an owner);
//   - email addresses are not auto-confirmed (advisory).
// With --database (ADMIN_DATABASE_URL, the owner credential, read-only session):
//   - ops.operator_assurance_exemption holds no row (no session below multi-
//     factor assurance is accepted);
//   - the applied migrations are exactly the repository's;
//   - none of the development seed's marks is present (SI-25).
//
// What this command CANNOT see is printed every time, never assumed: whether
// TOTP is enabled, the allowed redirect URLs, and where the service-role and
// secret keys live. Those are account actions (docs/PRODUCTION_HOSTING_GATE_B_REPORT.md).
//
// --local-self-test allows a local project and database, to exercise this
// command against the local stack; it is never a production sign-off.
// Exit 0 pass, 1 a blocking finding, 2 it could not check.

import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import {
  auditHostedSupabase,
  auditServiceEnvironment,
} from "./production-contract-env.mjs";
import { isNonPublicHost } from "./production-contract-host.mjs";
import { parseFlags, report } from "./production-contract-report.mjs";

const NOT_VERIFIED = [
  "TOTP multi-factor authentication is enabled in the project's auth settings (enrol a synthetic user on staging to prove it)",
  "the site URL and the allowed redirect URLs name only the production origin",
  "the service-role and secret keys exist only in server-side secrets (the build scan covers the browser artifact)",
  "the database password and the owner credential are held by the owner alone",
];

const repositoryMigrations = () =>
  readdirSync(
    fileURLToPath(new URL("../supabase/migrations/", import.meta.url)),
  )
    .filter((file) => file.endsWith(".sql"))
    .map((file) => file.split("_")[0]);

/** The facts a hosted database gives, read in one read-only session. */
export async function readHostedDatabase(connectionString) {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();
  try {
    await client.query("begin transaction read only");
    const one = async (sql) => Number((await client.query(sql)).rows[0].n);
    const exemptionRows = await one(
      "select count(*)::int as n from ops.operator_assurance_exemption",
    );
    const seedMarks = await one(
      "select count(*)::int as n from ops.tenants where slug = 'dev' and name = 'Development tenant'",
    );
    const applied = await client.query(
      "select version from supabase_migrations.schema_migrations",
    );
    await client.query("rollback");
    return {
      exemptionRows,
      seedMarks,
      appliedMigrations: applied.rows.map((row) => row.version),
      repositoryMigrations: repositoryMigrations(),
    };
  } finally {
    await client.end();
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  let flags;
  try {
    flags = parseFlags(process.argv.slice(2), ["url", "publishable-key"]);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const url = flags.url ?? process.env.VITE_SUPABASE_URL;
  const key = flags["publishable-key"] ?? process.env.VITE_SB_PUBLISHABLE_KEY;
  if (url === undefined) {
    console.error(
      "usage: verify-hosted-supabase --url <project url> [--database]",
    );
    process.exit(2);
  }
  const allowLocal = flags["local-self-test"] === true;
  const findings = [];
  if (!allowLocal && isNonPublicHost(new URL(url).hostname)) {
    findings.push({
      rule: "public-host-required",
      severity: "blocking",
      detail:
        "the project URL is a local or private host, not a hosted project",
    });
  }

  let authSettings = null;
  try {
    const response = await fetch(new URL("/auth/v1/settings", url), {
      headers: key === undefined ? {} : { apikey: key },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) authSettings = await response.json();
    else
      findings.push({
        rule: "auth-settings-unreadable",
        severity: "blocking",
        detail: `the public auth settings answered ${response.status}`,
      });
  } catch (error) {
    console.error(
      `could not read the project: ${error.name}. A check that cannot look is not a pass.`,
    );
    process.exit(2);
  }

  let database = null;
  if (flags.database === true) {
    const connection = process.env.ADMIN_DATABASE_URL;
    if (connection === undefined) {
      console.error(
        "--database needs ADMIN_DATABASE_URL (the owner credential)",
      );
      process.exit(2);
    }
    if (!allowLocal) {
      findings.push(
        ...auditServiceEnvironment({ ADMIN_DATABASE_URL: connection }),
      );
    }
    try {
      database = await readHostedDatabase(connection);
    } catch (error) {
      console.error(
        `could not read the database: ${error.code ?? error.name}. A check that cannot look is not a pass.`,
      );
      process.exit(2);
    }
  }

  findings.push(...auditHostedSupabase({ authSettings, database }));
  if (allowLocal) {
    console.error(
      "SELF-TEST ONLY: a local project is never a production sign-off.\n",
    );
  }
  process.exit(
    report(`hosted Supabase ${new URL(url).host}`, findings, {
      json: flags.json === true,
      notVerified: NOT_VERIFIED,
    }),
  );
}
