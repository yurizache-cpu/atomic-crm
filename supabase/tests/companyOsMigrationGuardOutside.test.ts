// @vitest-environment node
import { describe, expect, it } from "vitest";

import { formatFinding, validateDeclaration } from "../invariants/replay.mjs";
import {
  GRANT_CREATE,
  GRANT_ROLE,
  REVOKE_CREATE,
  REVOKE_ROLE,
  corpus,
  declaration,
  findingsOf,
  lifecycle,
} from "./companyOsMigrationGuardFixtures.ts";

// THE COMPANY OS SURFACE AND ITS OD-8a EXCEPTION, OUTSIDE THE ALLOWLIST (Phase
// 2C, brief §7.6, §16): the declaration that defines the allowlist cannot be
// mis-keyed into a no-op, and outside the exact allowlisted files every
// change to the surface is a finding, while ordinary statements pass.
//
// Split out of migrationInvariants.test.ts, which keeps the trust root
// (FROZEN.companyOsApi) this surface is pinned to. The probe declaration and
// the lifecycle statements live in companyOsMigrationGuardFixtures.ts; the
// cases inside the allowlist in companyOsMigrationGuard.test.ts. Runs in the
// `functions` vitest project: static file analysis, no database.

describe("declaration.json cannot be mis-keyed into a no-op", () => {
  const withSurface = (patch: Record<string, unknown>) => ({
    ...declaration,
    companyOsApi: { ...declaration.companyOsApi, ...patch },
  });

  it("rejects a missing or mis-keyed Company OS surface", () => {
    const { companyOsApi: _removed, ...rest } = declaration;
    expect(() => validateDeclaration(rest)).toThrow(
      /missing key "companyOsApi"/,
    );
    expect(() =>
      validateDeclaration(withSurface({ allowlistedMigration: [] })),
    ).toThrow(/unknown key/);
  });

  it("rejects a catalogue entry that is not a canonical company_os_api signature", () => {
    for (const bad of [
      "company_os_api.overview",
      "public.overview()",
      "company_os_api.get_agent(p_agent_id uuid)",
      "company_os_api.get_agent(pg_catalog.uuid)",
    ]) {
      expect(() =>
        validateDeclaration(withSurface({ catalogue: [bad] })),
      ).toThrow(/canonical/);
    }
    expect(() =>
      validateDeclaration(withSurface({ gates: ["ops.read_overview()"] })),
    ).toThrow(/canonical ops\.gate_/);
  });

  it("rejects an allowlist entry that is sealed or not a migration file name", () => {
    for (const bad of [
      "20240730075029_init_db.sql",
      "company_os_read_surface.sql",
      "20260922120000_company_os_read_surface",
    ]) {
      expect(() =>
        validateDeclaration(withSurface({ allowlistedMigrations: [bad] })),
      ).toThrow(/unsealed migration file name/);
    }
  });

  it("rejects transfers for a file that is not allowlisted, or of an uncatalogued function", () => {
    expect(() =>
      validateDeclaration(
        withSurface({
          transfers: {
            "20270101000000_other.sql": ["company_os_api.overview()"],
          },
        }),
      ),
    ).toThrow(/not allowlisted/);
    expect(() =>
      validateDeclaration(
        withSurface({
          transfers: {
            "20260922120000_company_os_read_surface.sql": [
              "company_os_api.trip_stop(text,uuid,text)",
            ],
          },
        }),
      ),
    ).toThrow(/catalogued signatures/);
  });
});

describe("the Company OS surface and its OD-8a exception", () => {
  const NOT_ALLOWLISTED = {
    file: "20270101000001_ordinary.sql",
    decl: declaration,
  };
  const OUTSIDE_REJECTED: Array<[string, string, RegExp]> = [
    [
      "the complete lifecycle in a file not on the allowlist",
      lifecycle,
      /^company-os:/,
    ],
    [
      "the pinned membership pair alone",
      `${GRANT_ROLE}\n${REVOKE_ROLE}`,
      /^(unclassifiable:|company-os:membership-revoke:)/,
    ],
    [
      "the pinned CREATE pair alone",
      `${GRANT_CREATE}\n${REVOKE_CREATE}`,
      /^company-os:acl-outside-allowlist:/,
    ],
    ["a lone membership grant", GRANT_ROLE, /^unclassifiable:/],
    [
      "any other role membership involving a capability role",
      "grant ops_worker to ops_operator_api;",
      /^unclassifiable:/,
    ],
    [
      "any other role-membership REVOKE",
      "revoke authenticated from ops_gateway_login;",
      /^company-os:membership-revoke:/,
    ],
    [
      "an OWNER TO the role",
      "alter function company_os_api.overview() owner to ops_operator_api;",
      /^company-os:owner-to:/,
    ],
    [
      "an OWNER TO any role",
      "alter function public.f() owner to postgres;",
      /^company-os:owner-to:/,
    ],
    [
      "a replace of an exposed function",
      "create or replace function company_os_api.overview() returns pg_catalog.jsonb language sql stable security definer set search_path = '' as $$ select ops.gate_overview() $$;",
      /^company-os:/,
    ],
    [
      "a drop of an exposed function",
      "drop function company_os_api.overview();",
      /^company-os:drop-routine:/,
    ],
    [
      "an ALTER of an exposed function",
      "alter function company_os_api.overview() security invoker;",
      /^company-os:alter-routine:/,
    ],
    [
      "a revoke on an exposed function",
      "revoke execute on function company_os_api.overview() from authenticated;",
      /^company-os:acl-outside-allowlist:/,
    ],
    [
      "a grant on a gate",
      "grant execute on function ops.gate_overview() to authenticated;",
      /^company-os:acl-outside-allowlist:/,
    ],
    [
      "a replace of a gate",
      "create or replace function ops.gate_overview() returns pg_catalog.jsonb language sql as $$ select '{}'::pg_catalog.jsonb $$;",
      /^company-os:/,
    ],
    [
      "CREATE ROLE the role",
      "create role ops_operator_api nologin nosuperuser nocreatedb nocreaterole nobypassrls noinherit;",
      /^company-os:create-role:/,
    ],
  ];

  it.each(OUTSIDE_REJECTED)(
    "rejects outside the allowlist: %s",
    (name, sql, expected) => {
      const ids = findingsOf(sql, NOT_ALLOWLISTED).map((f) => f.id);
      expect(
        ids.some((id) => expected.test(id)),
        `${name}: expected a finding matching ${expected}, got ${JSON.stringify(ids)}`,
      ).toBe(true);
    },
  );

  it("rejects a renamed copy of the allowlisted S2 migration", () => {
    const [file] = declaration.companyOsApi.allowlistedMigrations;
    const s2 = corpus.find((m) => m.file === file)!;
    const ids = findingsOf(s2.sql, {
      file: "20270101000002_company_os_read_surface.sql",
      decl: declaration,
    }).map((f) => f.id);
    expect(
      ids.filter((id) => id.startsWith("company-os:")).length,
    ).toBeGreaterThan(0);
  });

  const ACCEPTED_ORDINARY: Array<[string, string]> = [
    [
      "a NOLOGIN role created in a DO body (how ops_worker and ops_gateway exist)",
      "do $x$ begin if not exists (select 1 from pg_roles where rolname = 'ops_benign') then create role ops_benign nologin; end if; end $x$;",
    ],
    [
      "an ordinary set_config",
      "select pg_catalog.set_config('app.x', '1', true);",
    ],
    [
      "a column named role",
      "update ops.tenant_memberships set role = role where false;",
    ],
    [
      "a REVOKE-form ADP with no IN SCHEMA, which only tightens",
      "alter default privileges revoke execute on functions from public;",
    ],
    [
      "an ordinary ADP in schema public",
      "alter default privileges in schema public revoke execute on functions from public;",
    ],
  ];

  it.each(ACCEPTED_ORDINARY)("accepts: %s", (name, sql) => {
    expect(
      findingsOf(sql, NOT_ALLOWLISTED).map(formatFinding).join("\n\n"),
      `${name} was blocked`,
    ).toBe("");
  });
});
