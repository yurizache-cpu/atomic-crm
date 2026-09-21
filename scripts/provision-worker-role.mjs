#!/usr/bin/env node
// Creates the worker's LOGIN role. This is a DEPLOYMENT step, not a migration.
//
// WHY IT IS NOT A MIGRATION. A login role needs a password. A password in a
// migration is a secret in git, and this repository already carries one tracked
// private key it should not (CLAUDE.md, "Do not commit secrets"). So
// `20260912120000_ops_execution_core.sql` creates `ops_worker` as NOLOGIN with
// no credential, and this script creates the role that can actually connect.
//
// THE SHAPE, and why each part matters:
//
//   ops_worker_login   LOGIN, NOINHERIT, member of ops_worker
//
//   * NOINHERIT is the important one. With INHERIT the login role would carry
//     ops_worker's privileges implicitly, and `set local role ops_worker` in
//     the runtime would become decorative — removing it would change nothing
//     and nobody would notice. With NOINHERIT the login role starts with
//     NOTHING, so that statement is load-bearing and deleting it fails loudly
//     instead of silently widening anything.
//   * No BYPASSRLS, no SUPERUSER, no CREATEROLE, no CREATEDB — asserted below
//     rather than assumed, for the login role AND for ops_worker itself.
//
// THE PASSWORD NEVER TOUCHES argv. It is interpolated into the SQL text and
// delivered on stdin, because anything passed as `psql -v` is visible to `ps`
// on a shared host. psql variables would not have worked anyway: `:'var'` is
// NOT substituted inside a dollar-quoted block.
//
// SUPABASE HOSTING. A hosted project gives you the `postgres` role, which is
// `rolcreaterole = true`, so `create role ... login` works over a normal
// connection — no dashboard step, no support ticket. The real constraint is the
// connection string: the pooler in transaction mode does not support
// session-level state, which this runtime never uses (everything is `set
// local`), so pooler or direct 5432 are both fine. What is NOT fine is reusing
// the project's `postgres` / `service_role` credentials — `assertWorkerIdentity`
// refuses to boot on those.
//
// Usage:
//   ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
//   OPS_WORKER_PASSWORD=... node scripts/provision-worker-role.mjs
//
//   SUPABASE_DB_CONTAINER=supabase_db_atomic-crm-e2e \
//   OPS_WORKER_PASSWORD=... node scripts/provision-worker-role.mjs

import { execFileSync } from "node:child_process";

export const LOGIN_ROLE = "ops_worker_login";
export const WORKER_ROLE = "ops_worker";

/** SQL literal quoting. Doubling the quote is the whole rule. */
export function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Builds the provisioning SQL.
 *
 * Role names go through `format(... %I ...)` rather than being interpolated
 * directly — a bare `grant <role> to current_user` SEGFAULTS Postgres 15.8
 * (observed: signal 11 and crash recovery), so identifier interpolation here is
 * not stylistic.
 */
export function provisionSql(
  password,
  loginRole = LOGIN_ROLE,
  workerRole = WORKER_ROLE,
  createdBy = "20260912120000_ops_execution_core.sql",
) {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("provisionSql requires a password");
  }
  return `
do $provision$
declare
  v_login    text := ${quoteLiteral(loginRole)};
  v_worker   text := ${quoteLiteral(workerRole)};
  v_password text := ${quoteLiteral(password)};
  v_r        record;
begin
  if not exists (select 1 from pg_roles where rolname = v_worker) then
    raise exception
      'role % does not exist. Apply the migrations first: it is created by ${createdBy}.', v_worker;
  end if;

  select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
    into v_r from pg_roles where rolname = v_worker;
  if v_r.rolsuper or v_r.rolbypassrls or v_r.rolcreaterole or v_r.rolcreatedb then
    raise exception
      'role % carries a blanket capability (super=% bypassrls=% createrole=% createdb=%); refusing to hand out a login for it',
      v_worker, v_r.rolsuper, v_r.rolbypassrls, v_r.rolcreaterole, v_r.rolcreatedb;
  end if;

  if exists (select 1 from pg_roles where rolname = v_login) then
    -- MEASURED: naming SUPERUSER or BYPASSRLS in an ALTER requires the caller to
    -- BE a superuser ("Only roles with the SUPERUSER attribute may alter roles
    -- with the SUPERUSER attribute"), and the postgres role on Supabase is
    -- rolsuper = false. So the rotation path sets only what it may set, and the
    -- verification block below REFUSES a pre-existing role that carries either
    -- attribute rather than silently trying to strip it.
    execute format(
      'alter role %I with login noinherit nocreatedb nocreaterole password %L',
      v_login, v_password);
  else
    execute format(
      'create role %I with login noinherit nosuperuser nocreatedb nocreaterole nobypassrls password %L',
      v_login, v_password);
  end if;

  execute format('grant %I to %I', v_worker, v_login);

  -- The login role gets NOTHING directly. Every privilege it uses is reached by
  -- assuming ops_worker for the duration of one transaction.
  execute format('revoke all on schema ops from %I', v_login);
  execute format('revoke all on all tables in schema ops from %I', v_login);
  execute format('revoke all on all functions in schema ops from %I', v_login);
end
$provision$;

-- Assert the end state, the way every security migration in this repository does.
do $verify$
declare
  v_login text := ${quoteLiteral(loginRole)};
  v_r     record;
begin
  select rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
    into v_r from pg_roles where rolname = v_login;
  if v_r is null then raise exception 'login role % was not created', v_login; end if;
  if not v_r.rolcanlogin then raise exception 'login role % cannot log in', v_login; end if;
  if v_r.rolinherit then
    raise exception
      'login role % is INHERIT; "set local role" in the runtime would then be decorative and its removal undetectable', v_login;
  end if;
  if v_r.rolsuper then raise exception 'login role % is SUPERUSER', v_login; end if;
  if v_r.rolbypassrls then raise exception 'login role % has BYPASSRLS', v_login; end if;
  if v_r.rolcreaterole then raise exception 'login role % has CREATEROLE', v_login; end if;
  if v_r.rolcreatedb then raise exception 'login role % has CREATEDB', v_login; end if;
  if not pg_has_role(v_login, ${quoteLiteral(workerRole)}, 'member') then
    raise exception 'login role % is not a member of %', v_login, ${quoteLiteral(workerRole)};
  end if;
end
$verify$;
`;
}

function main() {
  const password = process.env.OPS_WORKER_PASSWORD;
  if (!password) {
    console.error(
      "OPS_WORKER_PASSWORD is required. Generate one, store it in your secret manager, and never commit it.",
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

  const sql = provisionSql(password);
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

  // stderr, so piping stdout somewhere never carries this.
  console.error(
    `provisioned ${LOGIN_ROLE}: LOGIN, NOINHERIT, member of ${WORKER_ROLE}, no BYPASSRLS`,
  );
}

const isEntryPoint = async () => {
  if (!process.argv[1]) return false;
  const { pathToFileURL } = await import("node:url");
  return import.meta.url === pathToFileURL(process.argv[1]).href;
};

if (await isEntryPoint()) main();
