#!/usr/bin/env node
// Creates the WhatsApp webhook gateway's LOGIN role (Phase 2B). A DEPLOYMENT
// step, not a migration, for the reason provision-worker-role.mjs gives: a
// login needs a password, and a password in a migration is a secret in git.
//
//   ops_gateway_login   LOGIN, NOINHERIT, member of ops_gateway
//
// 20260918150000_whatsapp_transport.sql creates ops_gateway as NOLOGIN with no
// credential. It holds no table privilege anywhere and may execute exactly
// ops.receive_whatsapp_message and ops.receive_whatsapp_status. NOINHERIT makes
// the gateway's `set local role ops_gateway` load-bearing, exactly as for the
// worker, and the same SQL (provisionSql) asserts the end state.
//
// Usage:
//   SUPABASE_DB_CONTAINER=supabase_db_atomic-crm-e2e \
//   OPS_GATEWAY_PASSWORD=... node scripts/provision-gateway-role.mjs
//
//   ADMIN_DATABASE_URL=... OPS_GATEWAY_PASSWORD=... node scripts/provision-gateway-role.mjs

import { execFileSync } from "node:child_process";
import { provisionSql } from "./provision-worker-role.mjs";

export const GATEWAY_LOGIN_ROLE = "ops_gateway_login";
export const GATEWAY_ROLE = "ops_gateway";

function main() {
  const password = process.env.OPS_GATEWAY_PASSWORD;
  if (!password) {
    console.error(
      "OPS_GATEWAY_PASSWORD is required. Generate one, store it in your secret manager, and never commit it.",
    );
    process.exit(1);
  }
  const container = process.env.SUPABASE_DB_CONTAINER;
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!container && !adminUrl) {
    console.error(
      "Set ADMIN_DATABASE_URL (an admin connection string) or SUPABASE_DB_CONTAINER (a local docker container name).",
    );
    process.exit(1);
  }

  const sql = provisionSql(
    password,
    GATEWAY_LOGIN_ROLE,
    GATEWAY_ROLE,
    "20260918150000_whatsapp_transport.sql",
  );
  const psqlArgs = ["-v", "ON_ERROR_STOP=1", "-q", "-f", "-"];
  if (container) {
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
        ...psqlArgs,
      ],
      { input: sql, stdio: ["pipe", "inherit", "inherit"] },
    );
  } else {
    execFileSync("psql", [adminUrl, ...psqlArgs], {
      input: sql,
      stdio: ["pipe", "inherit", "inherit"],
    });
  }
  console.error(
    `provisioned ${GATEWAY_LOGIN_ROLE}: LOGIN, NOINHERIT, member of ${GATEWAY_ROLE}, no BYPASSRLS`,
  );
}

const isEntryPoint = async () => {
  if (!process.argv[1]) return false;
  const { pathToFileURL } = await import("node:url");
  return import.meta.url === pathToFileURL(process.argv[1]).href;
};

if (await isEntryPoint()) main();
