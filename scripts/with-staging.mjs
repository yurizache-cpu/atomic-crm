#!/usr/bin/env node
// Runs one command with the connection of ONE constrained staging role, built
// from a local secrets file outside the repository (docs/COST_FIRST_STAGING.md).
//
//   node scripts/with-staging.mjs --as worker -- npm run staging:fake-worker
//   node scripts/with-staging.mjs --as gateway -- npm run whatsapp:gateway
//   node scripts/with-staging.mjs --as worker --pass OPENAI_API_KEY -- npm run worker
//
// The file (default %USERPROFILE%\.atomic-crm\staging.env, or STAGING_ENV_FILE)
// holds KEY=value lines: STAGING_PROJECT_REF, STAGING_POOLER_HOST,
// STAGING_ROOT_CA (the pinned Supabase root certificate) and the role's
// password (OPS_WORKER_PASSWORD or OPS_GATEWAY_PASSWORD). The child gets
// DEPLOYMENT_ENVIRONMENT=staging and exactly one database URL, verified TLS
// through the session pooler; every other database URL is removed from its
// environment, so an owner credential can never ride along. `--pass KEY` copies
// one more named key from the file into the child alone (a model key, say),
// never a database URL or a password. Nothing here prints a secret.
//
// Exit: the child's status; 2 when it could not run.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ROLES = Object.freeze({
  worker: {
    login: "ops_worker_login",
    password: "OPS_WORKER_PASSWORD",
    url: "OPS_WORKER_DATABASE_URL",
  },
  gateway: {
    login: "ops_gateway_login",
    password: "OPS_GATEWAY_PASSWORD",
    url: "OPS_GATEWAY_DATABASE_URL",
  },
});

// Never copied by --pass: connection strings and every password in the file.
const NEVER_PASSED = /(_DATABASE_URL|^DATABASE_URL|^SUPABASE_DB_URL|PASSWORD)$/;

const DATABASE_URLS = [
  "ADMIN_DATABASE_URL",
  "DATABASE_URL",
  "OPS_WORKER_DATABASE_URL",
  "OPS_GATEWAY_DATABASE_URL",
  "SUPABASE_DB_URL",
];

/** KEY=value lines; blank lines and # comments ignored. */
export function parseEnvFile(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/**
 * The child's environment for one role, or a thrown Error naming the missing
 * key (never a value).
 */
export function stagingEnvironment(role, file, parentEnv, pass = []) {
  const spec = ROLES[role];
  if (spec === undefined) {
    throw new Error(`--as must be one of: ${Object.keys(ROLES).join(", ")}`);
  }
  for (const key of [
    "STAGING_PROJECT_REF",
    "STAGING_POOLER_HOST",
    "STAGING_ROOT_CA",
    spec.password,
  ]) {
    if (!file[key]) throw new Error(`${key} is missing from the staging file`);
  }
  if (!/^[a-z0-9]{20}$/.test(file.STAGING_PROJECT_REF)) {
    throw new Error("STAGING_PROJECT_REF is not a Supabase project ref");
  }
  if (!/^[a-z0-9.-]+\.pooler\.supabase\.com$/.test(file.STAGING_POOLER_HOST)) {
    throw new Error("STAGING_POOLER_HOST is not a Supabase pooler host");
  }
  const env = { ...parentEnv };
  for (const name of DATABASE_URLS) delete env[name];
  const user = `${spec.login}.${file.STAGING_PROJECT_REF}`;
  env[spec.url] =
    `postgresql://${user}:${encodeURIComponent(file[spec.password])}` +
    `@${file.STAGING_POOLER_HOST}:5432/postgres` +
    `?sslmode=verify-full&sslrootcert=${encodeURIComponent(file.STAGING_ROOT_CA)}`;
  env.DEPLOYMENT_ENVIRONMENT = "staging";
  for (const key of pass) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || NEVER_PASSED.test(key)) {
      throw new Error(
        `--pass refuses ${key}: only a named key that is not a database URL or a password`,
      );
    }
    if (!file[key]) throw new Error(`${key} is missing from the staging file`);
    env[key] = file[key];
  }
  return env;
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const args = process.argv.slice(2);
  const separator = args.indexOf("--");
  const asIndex = args.indexOf("--as");
  if (separator === -1 || asIndex === -1 || separator === args.length - 1) {
    console.error(
      "usage: node scripts/with-staging.mjs --as worker|gateway [--pass KEY]... -- <command...>",
    );
    process.exit(2);
  }
  const path =
    process.env.STAGING_ENV_FILE ??
    join(
      process.env.USERPROFILE ?? process.env.HOME ?? "",
      ".atomic-crm",
      "staging.env",
    );
  if (!existsSync(path)) {
    console.error(`no staging file at ${path}`);
    process.exit(2);
  }
  let env;
  try {
    env = stagingEnvironment(
      args[asIndex + 1],
      parseEnvFile(readFileSync(path, "utf8")),
      process.env,
      args
        .slice(0, separator)
        .flatMap((arg, index, all) =>
          arg === "--pass" ? [all[index + 1]] : [],
        ),
    );
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const [command, ...rest] = args.slice(separator + 1);
  const result = spawnSync(command, rest, {
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  process.exit(result.status ?? 2);
}
