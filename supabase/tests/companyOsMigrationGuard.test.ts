// @vitest-environment node
import { describe, expect, it } from "vitest";

import { formatFinding } from "../invariants/replay.mjs";
import {
  GATE,
  GRANT_CREATE,
  GRANT_ROLE,
  IDENTITY,
  L3,
  REVOKE_CREATE,
  REVOKE_ROLE,
  TRANSFER,
  corpus,
  declaration,
  findingsOf,
  lifecycle,
  plus,
  reorder,
  swap,
} from "./companyOsMigrationGuardFixtures.ts";

// THE COMPANY OS SURFACE AND ITS OD-8a EXCEPTION, INSIDE THE ALLOWLIST (Phase
// 2C, brief §7.6, §16): the complete lifecycle in an allowlisted file, the
// committed S2 migration, and every way to break the lifecycle there. Every
// finding is non-overridable.
//
// Split out of migrationInvariants.test.ts, which keeps the trust root
// (FROZEN.companyOsApi) this surface is pinned to. The probe declaration and
// the lifecycle statements live in companyOsMigrationGuardFixtures.ts; the
// cases outside the allowlist, and the declaration that defines it, in
// companyOsMigrationGuardOutside.test.ts. Runs in the `functions` vitest
// project: static file analysis, no database.

describe("the Company OS surface and its OD-8a exception", () => {
  it("accepts the complete, correctly ordered seven-step lifecycle in an allowlisted file", () => {
    expect(findingsOf(lifecycle).map(formatFinding).join("\n\n")).toBe("");
  });

  it("allowlists exactly the committed S2 and S7.1 migrations, each carrying its whole lifecycle itself", () => {
    const { allowlistedMigrations, transfers, catalogue } =
      declaration.companyOsApi;
    expect(allowlistedMigrations).toEqual([
      "20260922120000_company_os_read_surface.sql",
      "20260923120000_company_os_review_decision.sql",
    ]);
    // The declaration's catalogue is pinned to the frozen trust root
    // (FROZEN.companyOsApi) by migrationInvariants.test.ts; together the two
    // files transfer every catalogued function, once.
    expect(Object.values(transfers).flat().sort()).toEqual(
      [...catalogue].sort(),
    );
    for (const file of allowlistedMigrations) {
      const migration = corpus.find((m) => m.file === file)!;
      expect(migration, `${file} is not in the corpus`).toBeDefined();
      const transferred = migration.sql.match(
        /^alter function company_os_api\.\S+\(.*\) owner to ops_operator_api;$/gm,
      );
      expect(transferred).toHaveLength(transfers[file].length);
      expect(migration.sql).toMatch(/^grant ops_operator_api to postgres;$/m);
      expect(migration.sql).toMatch(
        /^revoke ops_operator_api from postgres;$/m,
      );
      expect(migration.sql).not.toMatch(
        /\bcurrent_user\s*;|to\s+current_user\b/,
      );
      // No trip exists before S8 (SI-58).
      expect(migration.sql).not.toMatch(
        /function\s+(company_os_api|ops)\.(gate_)?trip_stop\b/,
      );
    }
    // The read surface holds no act; the one act is the S7.1 file's.
    const [s2, s71] = allowlistedMigrations.map(
      (file) => corpus.find((m) => m.file === file)!.sql,
    );
    expect(s2).not.toMatch(
      /function\s+(company_os_api|ops)\.(gate_)?decide_review\b/,
    );
    expect(s71).toMatch(
      /^create function company_os_api\.decide_review\(p_review_id pg_catalog\.uuid, p_decision pg_catalog\.text\)/m,
    );
  });

  const ALLOWLISTED_REJECTED: Array<[string, string, RegExp]> = [
    // B: the membership pair.
    [
      "current_user as the grantee",
      swap(GRANT_ROLE, "grant ops_operator_api to current_user;"),
      /^unclassifiable:/,
    ],
    [
      "session_user as the grantee",
      swap(GRANT_ROLE, "grant ops_operator_api to session_user;"),
      /^unclassifiable:/,
    ],
    [
      "another grantee",
      swap(GRANT_ROLE, "grant ops_operator_api to supabase_admin;"),
      /^unclassifiable:/,
    ],
    [
      "a second grantee",
      swap(GRANT_ROLE, "grant ops_operator_api to postgres, supabase_admin;"),
      /^unclassifiable:/,
    ],
    [
      "WITH ADMIN",
      swap(GRANT_ROLE, "grant ops_operator_api to postgres with admin option;"),
      /^unclassifiable:/,
    ],
    [
      "WITH INHERIT",
      swap(GRANT_ROLE, "grant ops_operator_api to postgres with inherit true;"),
      /^unclassifiable:/,
    ],
    [
      "GRANTED BY",
      swap(
        GRANT_ROLE,
        "grant ops_operator_api to postgres granted by supabase_admin;",
      ),
      /^unclassifiable:/,
    ],
    [
      "a lone membership grant",
      swap(REVOKE_ROLE, ""),
      /^company-os:membership-unrevoked:/,
    ],
    [
      "the membership revoke before the transfer",
      reorder([
        IDENTITY,
        ...GATE,
        ...L3,
        GRANT_ROLE,
        GRANT_CREATE,
        REVOKE_ROLE,
        TRANSFER,
        REVOKE_CREATE,
      ]),
      /^company-os:revoke-before-transfer:/,
    ],
    [
      "the identity assertion after the grant",
      reorder([
        ...GATE,
        ...L3,
        GRANT_ROLE,
        IDENTITY,
        GRANT_CREATE,
        TRANSFER,
        REVOKE_CREATE,
        REVOKE_ROLE,
      ]),
      /^company-os:identity-assertion-late:/,
    ],
    [
      "no identity assertion",
      reorder([
        ...GATE,
        ...L3,
        GRANT_ROLE,
        GRANT_CREATE,
        TRANSFER,
        REVOKE_CREATE,
        REVOKE_ROLE,
      ]),
      /^company-os:identity-assertion-missing:/,
    ],
    [
      "an identity assertion of another role",
      swap(
        "'postgres' or session_user <> 'postgres'",
        "'supabase_admin' or session_user <> 'supabase_admin'",
      ),
      /^company-os:identity-literal:/,
    ],
    // C: the CREATE pair, nested inside the membership pair.
    [
      "the CREATE grant outside the membership window",
      reorder([
        IDENTITY,
        ...GATE,
        ...L3,
        GRANT_CREATE,
        GRANT_ROLE,
        TRANSFER,
        REVOKE_CREATE,
        REVOKE_ROLE,
      ]),
      /^company-os:create-grant-window:/,
    ],
    [
      "the CREATE grant never revoked",
      swap(REVOKE_CREATE, ""),
      /^company-os:create-unrevoked:/,
    ],
    [
      "the CREATE revoke after the membership revoke",
      reorder([
        IDENTITY,
        ...GATE,
        ...L3,
        GRANT_ROLE,
        GRANT_CREATE,
        TRANSFER,
        REVOKE_ROLE,
        REVOKE_CREATE,
      ]),
      /^company-os:create-not-nested:/,
    ],
    [
      "CREATE on ops to the role",
      plus("grant create on schema ops to ops_operator_api;"),
      /^company-os:schema-privilege:/,
    ],
    [
      "CREATE on public to the role",
      plus("grant create on schema public to ops_operator_api;"),
      /^company-os:schema-privilege:/,
    ],
    [
      "the pairs with no ownership transfer",
      swap(TRANSFER, ""),
      /^company-os:pair-without-transfer:/,
    ],
    // D: ownership.
    [
      "a transfer to another role",
      swap(
        TRANSFER,
        "alter function company_os_api.probe_ping() owner to supabase_admin;",
      ),
      /^company-os:owner-to:/,
    ],
    [
      "a transfer to the migration identity",
      swap(
        TRANSFER,
        "alter function company_os_api.probe_ping() owner to postgres;",
      ),
      /^company-os:owner-to:/,
    ],
    [
      "a transfer of a gate",
      plus("alter function ops.gate_probe_ping() owner to ops_operator_api;"),
      /^company-os:owner-to:/,
    ],
    [
      "a transfer before the ACL is set",
      reorder([
        IDENTITY,
        ...GATE,
        L3[0],
        GRANT_ROLE,
        GRANT_CREATE,
        TRANSFER,
        REVOKE_CREATE,
        REVOKE_ROLE,
        L3[1],
        L3[2],
      ]),
      /^company-os:transfer-before-acl:/,
    ],
    [
      "the same transfer twice",
      swap(TRANSFER, `${TRANSFER}\n${TRANSFER}`),
      /^company-os:transfer-twice:/,
    ],
    [
      "a transfer of a function this file did not create",
      plus(
        "alter function company_os_api.overview() owner to ops_operator_api;",
      ),
      /^company-os:(owner-to|transfer-)/,
    ],
    [
      "an ACL change after the transfer",
      plus("grant execute on function company_os_api.probe_ping() to anon;"),
      /^company-os:acl-after-transfer:/,
    ],
    [
      "a replace of a function the role already owns",
      plus(
        "create or replace function company_os_api.overview() returns pg_catalog.jsonb language sql stable security definer set search_path = '' as $$ select ops.gate_overview() $$;",
      ),
      /^company-os:replace-function:/,
    ],
    [
      "a drop of a function the role already owns",
      plus("drop function company_os_api.overview();"),
      /^company-os:drop-routine:/,
    ],
    [
      "a drop and recreate by the schema owner",
      plus(
        "drop function company_os_api.overview();\ncreate function company_os_api.overview() returns pg_catalog.jsonb language sql stable security definer set search_path = '' as $$ select ops.gate_overview() $$;",
      ),
      /^company-os:drop-routine:/,
    ],
    [
      "CREATE SCHEMA … AUTHORIZATION the role",
      plus("create schema x authorization ops_operator_api;"),
      /^company-os:schema-authorization:/,
    ],
    [
      "ALTER TYPE … OWNER TO the role",
      plus("alter type ops.some_type owner to ops_operator_api;"),
      /^company-os:owner-to:/,
    ],
    [
      "ALTER SEQUENCE … OWNER TO the role",
      plus("alter sequence ops.some_seq owner to ops_operator_api;"),
      /^company-os:owner-to:/,
    ],
    [
      "ALTER TABLE … OWNER TO the role",
      plus("alter table ops.tasks owner to ops_operator_api;"),
      /^company-os:owner-to:/,
    ],
    [
      "ALTER VIEW … OWNER TO the role",
      plus("alter view public.contacts_summary owner to ops_operator_api;"),
      /^company-os:owner-to:/,
    ],
    [
      "ALTER DOMAIN … OWNER TO the role",
      plus("alter domain ops.d owner to ops_operator_api;"),
      /^company-os:owner-to:/,
    ],
    [
      "ALTER SCHEMA … OWNER TO the role",
      plus("alter schema company_os_api owner to ops_operator_api;"),
      /^company-os:owner-to:/,
    ],
    [
      "ALTER ROUTINE … OWNER TO any role",
      plus("alter routine public.f() owner to postgres;"),
      /^company-os:owner-to:/,
    ],
    [
      "ALTER PROCEDURE … OWNER TO any role",
      plus("alter procedure public.p() owner to postgres;"),
      /^company-os:owner-to:/,
    ],
    [
      "REASSIGN OWNED",
      plus("reassign owned by ops_operator_api to postgres;"),
      /^company-os:reassign-owned:/,
    ],
    [
      "SET ROLE",
      plus("set role ops_operator_api;"),
      /^company-os:role-switch:/,
    ],
    [
      "SET LOCAL ROLE",
      plus("set local role postgres;"),
      /^company-os:role-switch:/,
    ],
    ["RESET ROLE", plus("reset role;"), /^company-os:role-switch:/],
    [
      "SET SESSION AUTHORIZATION",
      plus("set session authorization ops_operator_api;"),
      /^company-os:role-switch:/,
    ],
    [
      "set_config('role', …) in a SELECT",
      plus("select pg_catalog.set_config('role', 'ops_operator_api', false);"),
      /^company-os:role-switch-call:/,
    ],
    [
      "ALTER ROLE the role",
      plus("alter role ops_operator_api login;"),
      /^company-os:alter-role:/,
    ],
    [
      "DROP ROLE the role",
      plus("drop role ops_operator_api;"),
      /^company-os:drop-role:/,
    ],
    [
      "CREATE ROLE with a login",
      plus("create role ops_extra login;"),
      /^company-os:create-role-attributes:/,
    ],
    // The surface's own shape.
    [
      "an uncatalogued function in the schema",
      plus(
        "create function company_os_api.probe_extra() returns int language sql as $$ select 1 $$;",
      ),
      /^company-os:uncatalogued:/,
    ],
    [
      "an exposed function that is SECURITY INVOKER",
      swap(
        "stable security definer set search_path = '' as $$ select ops.gate_probe_ping()",
        "stable security invoker set search_path = '' as $$ select ops.gate_probe_ping()",
      ),
      /^company-os:function-not-definer:/,
    ],
    [
      "an exposed function with a search path",
      swap(
        "security definer set search_path = '' as $$ select ops.gate_probe_ping()",
        "security definer set search_path = public as $$ select ops.gate_probe_ping()",
      ),
      /^company-os:function-config:/,
    ],
    [
      "an exposed function that calls something other than its gate",
      swap(
        "$$ select ops.gate_probe_ping() $$",
        "$$ select ops.read_overview() $$",
      ),
      /^company-os:function-body:/,
    ],
    [
      "EXECUTE to anon on an exposed function",
      swap(
        L3[2],
        "grant execute on function company_os_api.probe_ping() to authenticated, anon;",
      ),
      /^company-os:acl-exposed:/,
    ],
    [
      "EXECUTE to authenticated on a gate",
      swap(
        GATE[2],
        "grant execute on function ops.gate_probe_ping() to ops_operator_api, authenticated;",
      ),
      /^company-os:acl-gate:/,
    ],
    [
      "a non-gate ops function to the role",
      plus(
        "grant execute on function ops.read_overview(uuid) to ops_operator_api;",
      ),
      /^company-os:acl-non-surface:/,
    ],
    [
      "a table privilege to the role",
      plus("grant select on ops.tasks to ops_operator_api;"),
      /^company-os:acl-object:/,
    ],
    [
      "a schema-wide grant on the schema",
      plus("grant execute on all functions in schema company_os_api to anon;"),
      /^company-os:acl-schema-wide:/,
    ],
    [
      "USAGE on the schema to anon",
      plus("grant usage on schema company_os_api to anon;"),
      /^company-os:schema-privilege:/,
    ],
    [
      "a table in the schema",
      plus("create table company_os_api.t (id int);"),
      /^company-os:non-function-object:/,
    ],
    [
      "a view in the schema",
      plus(
        "create view company_os_api.v with (security_invoker = on) as select 1;",
      ),
      /^company-os:non-function-object:/,
    ],
    [
      "a type in the schema",
      plus("create type company_os_api.e as enum ('a');"),
      /^company-os:non-function-object:/,
    ],
    [
      "a table moved into the schema",
      plus("alter table ops.tasks set schema company_os_api;"),
      /^company-os:non-function-object:/,
    ],
    [
      "a function moved into the schema",
      plus("alter function public.f() set schema company_os_api;"),
      /^company-os:alter-routine:/,
    ],
    [
      "a procedure in the schema",
      plus(
        "create procedure company_os_api.p() language sql as $$ select 1 $$;",
      ),
      /^company-os:create-procedure:/,
    ],
    [
      "the schema on a search path",
      plus("set search_path = company_os_api, public;"),
      /^company-os:search-path:/,
    ],
    [
      "the schema dropped",
      plus("drop schema company_os_api cascade;"),
      /^company-os:drop-schema:/,
    ],
    // ALTER DEFAULT PRIVILEGES (S0 finding A).
    [
      "a GRANT-form ADP with no IN SCHEMA (the case the old guard missed)",
      plus(
        "alter default privileges grant execute on functions to ops_gateway_login;",
      ),
      /^company-os:default-privileges-global:/,
    ],
    [
      "an ADP IN SCHEMA ops (also missed before)",
      plus(
        "alter default privileges in schema ops grant execute on functions to ops_operator_api;",
      ),
      /^company-os:default-privileges-surface:/,
    ],
    [
      "an ADP naming the schema",
      plus(
        "alter default privileges in schema company_os_api grant execute on functions to anon;",
      ),
      /^company-os:default-privileges-surface:/,
    ],
    [
      "an ADP FOR ROLE naming the role",
      plus(
        "alter default privileges for role postgres in schema public grant select on tables to ops_operator_api;",
      ),
      /^company-os:default-privileges-surface:/,
    ],
    // Every rule applies inside a DO body and a resolved EXECUTE string.
    [
      "the membership grant inside a DO body",
      plus("do $x$ begin grant ops_operator_api to postgres; end $x$;"),
      /^unclassifiable:/,
    ],
    [
      "a membership revoke inside a DO body",
      plus("do $x$ begin revoke ops_operator_api from authenticated; end $x$;"),
      /^company-os:membership-revoke:/,
    ],
    [
      "the CREATE revoke inside a DO body",
      plus(
        "do $x$ begin revoke create on schema company_os_api from ops_operator_api; end $x$;",
      ),
      /^company-os:acl-outside-allowlist:/,
    ],
    [
      "an OWNER TO inside a DO body",
      plus(
        "do $x$ begin alter function company_os_api.overview() owner to postgres; end $x$;",
      ),
      /^company-os:owner-to:/,
    ],
    [
      "SET ROLE inside a DO body",
      plus("do $x$ begin set role ops_operator_api; end $x$;"),
      /^company-os:role-switch:/,
    ],
    [
      "SET LOCAL ROLE after THEN inside a DO body",
      plus(
        "do $x$ begin if true then set local role postgres; end if; end $x$;",
      ),
      /^company-os:role-switch:/,
    ],
    [
      "set_config('role', …) inside a DO body",
      plus(
        "do $x$ begin perform set_config('role', 'ops_operator_api', true); end $x$;",
      ),
      /^company-os:role-switch-call:/,
    ],
    [
      "ALTER ROLE inside a DO body",
      plus("do $x$ begin alter role ops_operator_api login; end $x$;"),
      /^company-os:alter-role:/,
    ],
    [
      "CREATE USER inside a DO body",
      plus("do $x$ begin create user evil; end $x$;"),
      /^company-os:role-alias:/,
    ],
    [
      "CREATE ROLE … IN ROLE inside a DO body",
      plus(
        "do $x$ begin create role evil nologin in role ops_operator_api; end $x$;",
      ),
      /^company-os:create-role-attributes:/,
    ],
    [
      "a function created in the schema inside a DO body",
      plus(
        "do $x$ begin create function company_os_api.z() returns int language sql as $b$ select 1 $b$; end $x$;",
      ),
      /^company-os:create-function:/,
    ],
    [
      "a drop inside a DO body",
      plus("do $x$ begin drop function company_os_api.overview(); end $x$;"),
      /^company-os:drop-routine:/,
    ],
    [
      "an ADP inside a DO body",
      plus(
        "do $x$ begin alter default privileges grant execute on functions to anon; end $x$;",
      ),
      /^company-os:default-privileges-global:/,
    ],
    [
      "the membership grant in a resolved EXECUTE",
      plus(
        "do $x$ begin execute 'grant ops_operator_api to postgres'; end $x$;",
      ),
      /^unclassifiable:/,
    ],
    [
      "an OWNER TO a %I placeholder in EXECUTE format",
      plus(
        "do $x$ begin execute format('alter function company_os_api.overview() owner to %I', 'postgres'); end $x$;",
      ),
      /^company-os:owner-to:/,
    ],
    [
      "an EXECUTE grant to a %I placeholder",
      plus(
        "do $x$ begin execute format('grant execute on function company_os_api.overview() to %I', 'anon'); end $x$;",
      ),
      /^company-os:acl-dynamic:/,
    ],
    [
      "a positional %1$I placeholder",
      plus(
        "do $x$ begin execute format('grant %1$I to postgres', 'ops_operator_api'); end $x$;",
      ),
      /^unclassifiable:/,
    ],
    [
      "an EXECUTE argument built with ||",
      plus(
        "do $x$ begin execute 'grant ops_operator_api to ' || 'postgres'; end $x$;",
      ),
      /^dynamic-sql:/,
    ],
    [
      "a format string built with ||",
      plus(
        "do $x$ begin execute format('grant ' || 'ops_operator_api to postgres'); end $x$;",
      ),
      /^dynamic-sql:/,
    ],
  ];

  it.each(ALLOWLISTED_REJECTED)(
    "rejects in an allowlisted file: %s",
    (name, sql, expected) => {
      const found = findingsOf(sql);
      const ids = found.map((f) => f.id);
      expect(
        ids.some((id) => expected.test(id)),
        `${name}: expected a finding matching ${expected}, got ${JSON.stringify(ids)}`,
      ).toBe(true);
      // Nothing on the surface can be excused by a SECURITY-INVARIANT-OVERRIDE.
      for (const f of found.filter((f) => expected.test(f.id))) {
        expect(f.overridable, `${f.id} is overridable`).toBe(false);
      }
    },
  );
});
