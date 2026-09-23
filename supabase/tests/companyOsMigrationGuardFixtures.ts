// Shared fixtures of the Company OS migration-guard suites,
// companyOsMigrationGuard.test.ts (inside the allowlist) and
// companyOsMigrationGuardOutside.test.ts (outside it, and the declaration that
// defines it). Not a test file: it registers no test of its own.
//
// THE COMPANY OS SURFACE AND ITS OD-8a EXCEPTION (Phase 2C, brief §7.6, §16).
//
// The exception is attached to EXACT migration file names. To prove the
// lifecycle rules without writing a second real migration, these cases patch
// the declaration with one probe file on the allowlist and one probe function
// in the catalogue, exactly as a reviewed guard update for S8 would. Every
// finding below is non-overridable.
//
// The corpus, the declaration and the seal are loaded exactly as
// migrationInvariants.test.ts loads them; that file also keeps the trust root
// (FROZEN.companyOsApi) the declaration is pinned to.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import {
  InvariantError,
  analyze,
  loadMigrationCorpus,
} from "../invariants/replay.mjs";

const ROOT = process.cwd();
const INVARIANTS_DIR = join(ROOT, "supabase", "invariants");

export const declaration = JSON.parse(
  readFileSync(join(INVARIANTS_DIR, "declaration.json"), "utf8"),
);
const seal = JSON.parse(readFileSync(join(INVARIANTS_DIR, "seal.json"), "utf8"))
  .migrations as Record<string, string>;
export const corpus = loadMigrationCorpus(join(ROOT, "supabase", "migrations"));

const PROBE = "20270101000000_od8a_probe.sql";
const PROBE_FN = "company_os_api.probe_ping()";
const probeDeclaration = {
  ...declaration,
  companyOsApi: {
    ...declaration.companyOsApi,
    catalogue: [...declaration.companyOsApi.catalogue, PROBE_FN],
    gates: [...declaration.companyOsApi.gates, "ops.gate_probe_ping()"],
    allowlistedMigrations: [
      ...declaration.companyOsApi.allowlistedMigrations,
      PROBE,
    ],
    transfers: { ...declaration.companyOsApi.transfers, [PROBE]: [PROBE_FN] },
  },
};

export const findingsOf = (
  sql: string,
  { file = PROBE, decl = probeDeclaration } = {},
) => {
  try {
    return analyze({
      corpus: [
        ...corpus,
        {
          file,
          sql,
          timestamp: file.slice(0, 14),
          sha256: createHash("sha256").update(sql, "utf8").digest("hex"),
        },
      ],
      declaration: decl,
      seal,
      repoRoot: ROOT,
    }).findings;
  } catch (error) {
    if (error instanceof InvariantError)
      return [{ id: `threw:${error.message}`, overridable: false }];
    throw error;
  }
};

export const IDENTITY = `do $id$ begin if current_user <> 'postgres' or session_user <> 'postgres' then raise exception 'wrong migration identity'; end if; end $id$;`;
export const GATE = [
  `create function ops.gate_probe_ping() returns pg_catalog.jsonb language plpgsql stable security definer set search_path = '' as $g$ begin return '{}'::pg_catalog.jsonb; end $g$;`,
  "revoke all on function ops.gate_probe_ping() from public, anon, authenticated, service_role;",
  "grant execute on function ops.gate_probe_ping() to ops_operator_api;",
];
export const L3 = [
  `create function company_os_api.probe_ping() returns pg_catalog.jsonb language sql stable security definer set search_path = '' as $$ select ops.gate_probe_ping() $$;`,
  "revoke all on function company_os_api.probe_ping() from public, anon, authenticated, service_role;",
  "grant execute on function company_os_api.probe_ping() to authenticated;",
];
export const [GRANT_ROLE, GRANT_CREATE, TRANSFER, REVOKE_CREATE, REVOKE_ROLE] =
  [
    "grant ops_operator_api to postgres;",
    "grant create on schema company_os_api to ops_operator_api;",
    "alter function company_os_api.probe_ping() owner to ops_operator_api;",
    "revoke create on schema company_os_api from ops_operator_api;",
    "revoke ops_operator_api from postgres;",
  ];
const LIFECYCLE = [
  IDENTITY,
  ...GATE,
  ...L3,
  GRANT_ROLE,
  GRANT_CREATE,
  TRANSFER,
  REVOKE_CREATE,
  REVOKE_ROLE,
];
export const lifecycle = LIFECYCLE.join("\n");
export const swap = (from: string, to: string) => {
  expect(lifecycle).toContain(from);
  return lifecycle.replace(from, () => to);
};
export const reorder = (statements: string[]) => statements.join("\n");
export const plus = (sql: string) => `${lifecycle}\n${sql}`;
