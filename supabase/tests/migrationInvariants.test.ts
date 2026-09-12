// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  InvariantError,
  analyze,
  checkDeclarativeViews,
  formatFinding,
  loadMigrationCorpus,
  validateDeclaration,
} from "../invariants/replay.mjs";

// THE GUARD AGAINST A SECURITY-REGRESSING MIGRATION (SI-12).
//
// `supabase db diff` generates migrations that regress security, and one has
// already shipped: it recreated contacts_summary and init_state WITHOUT
// security_invoker, because migra never emits view reloptions. A view without
// it executes as its OWNER, so RLS does not apply — and combined with an older
// `grant all … to anon` that produced an unauthenticated read of every contact
// record over plain HTTP (PHASE_0_5_REPORT §16.1). Run today, `db diff` still
// wants to do exactly that, plus reinstall pg_net.
//
// Runs in the `functions` vitest project: node environment, no Docker, no
// database, no network, no Supabase CLI, no new dependency — node:fs and
// node:crypto over files already in the repository. check.yml runs
// test:unit:functions on every push and deploy.yml's gate job runs it before
// any deploy, so it executes whether or not anyone starts Supabase.
//
// It deliberately does NOT restate the live assertions in
// supabase/tests/rls_tenant_isolation.sql. That suite proves the DATABASE is
// right, after a migration is applied. This proves the REPOSITORY cannot
// DESCRIBE an insecure end state, on the diff, before anyone applies anything.

const ROOT = process.cwd();
const INVARIANTS_DIR = join(ROOT, "supabase", "invariants");

const declaration = JSON.parse(
  readFileSync(join(INVARIANTS_DIR, "declaration.json"), "utf8"),
);
const seal = JSON.parse(readFileSync(join(INVARIANTS_DIR, "seal.json"), "utf8"))
  .migrations as Record<string, string>;
const corpus = loadMigrationCorpus(join(ROOT, "supabase", "migrations"));

/**
 * FROZEN CONSTANTS — the trust root, pinned HERE rather than in the data file.
 * declaration.json is what the guard believes; these literals are what a
 * reviewer agreed it may believe. Widening the declaration — lifting pg_net out
 * of `forbidden`, silencing a schema, moving the seal — therefore requires a
 * diff in a .test.ts file, a visibly more serious act than editing a JSON list.
 */
const FROZEN = {
  sealedThrough: "20260912090000",
  sealedFiles: 29,
  /** Measured: 680 top-level statements across those 29 files. A positive
   *  control that the scan happened — this repository has shipped three checks
   *  that silently no-opped and looked applied. */
  sealedStatements: 680,
  declaredViews: [
    "activity_log",
    "companies_summary",
    "contacts_summary",
    "init_state",
  ],
  forbiddenExtensions: [
    "pg_net",
    "dblink",
    "postgres_fdw",
    "file_fdw",
    "plpython3u",
    "plperlu",
    "plsh",
  ],
  /** Empty on purpose: one entry silences every view in a schema at once. */
  ignoredSchemas: [] as string[],
};

const run = (
  extra: Array<{ file: string; sql: string }> = [],
  repoRoot = ROOT,
) =>
  analyze({
    corpus: [
      ...corpus,
      ...extra.map(({ file, sql }) => ({
        file,
        sql,
        timestamp: /^(\d{14})/.exec(file)![1],
        sha256: createHash("sha256").update(sql, "utf8").digest("hex"),
      })),
    ],
    declaration,
    seal,
    repoRoot,
  });

/** One synthetic migration, dated after everything real so it is never sealed. */
const candidate = (name: string, sql: string) => [
  { file: `20270101000000_${name}.sql`, sql },
];

const slug = (name: string) => name.replace(/\W+/g, "_").toLowerCase();

const idsFor = (name: string, sql: string) => {
  try {
    return run(candidate(name, sql)).findings.map((f) => f.id);
  } catch (error) {
    if (error instanceof InvariantError) return [`threw:${error.message}`];
    throw error;
  }
};

const D = "$";
const Q = "'";

describe("the guard actually ran", () => {
  it("finds the migrations and reads every one of them", () => {
    const { stats } = run();
    expect(stats.filesScanned).toBeGreaterThanOrEqual(FROZEN.sealedFiles);
    expect(stats.sealedFiles).toBe(FROZEN.sealedFiles);
    expect(stats.sealedStatements).toBe(FROZEN.sealedStatements);
  });

  it("refuses an empty corpus rather than passing vacuously", () => {
    expect(() =>
      analyze({ corpus: [], declaration, seal, repoRoot: ROOT }),
    ).toThrow(/empty corpus/);
    expect(() =>
      loadMigrationCorpus(mkdtempSync(join(tmpdir(), "no-migrations-"))),
    ).toThrow(/no \.sql files/);
  });

  it("keeps the trust root pinned in this file, not only in declaration.json", () => {
    expect(declaration.sealedThrough).toBe(FROZEN.sealedThrough);
    expect(Object.keys(seal)).toHaveLength(FROZEN.sealedFiles);
    expect(declaration.views.declared).toEqual(FROZEN.declaredViews);
    expect(declaration.views.ignoredSchemas).toEqual(FROZEN.ignoredSchemas);
    expect(declaration.extensions.forbidden).toEqual(
      FROZEN.forbiddenExtensions,
    );
    expect(declaration.extensions.allowed).not.toContain("pg_net");
  });

  it("asserts apply order rather than assuming it", () => {
    const timestamps = corpus.map((m) => m.timestamp);
    expect([...timestamps].sort()).toEqual(timestamps);
    expect(new Set(timestamps).size).toBe(timestamps.length);
  });
});

describe("the committed migration set is secure", () => {
  const result = run();

  it("has no findings", () => {
    expect(
      result.findings.map(formatFinding).join("\n\n"),
      "the committed migrations no longer satisfy the declared invariants",
    ).toBe("");
  });

  it("reproduces the end state measured against a live Postgres", () => {
    // PHASE_0_5_REPORT §16.1 (after two clean resets) and §16.7. If the static
    // model and the database ever disagree, one of them is wrong and this is
    // where it shows — an assertion a pure pattern-matcher cannot make.
    expect(result.endState.views).toEqual({
      "public.activity_log": true,
      "public.companies_summary": true,
      "public.contacts_summary": true,
      "public.init_state": true,
    });
    expect(result.endState.extensions).toEqual({
      citext: "extensions",
      http: "extensions",
      pgjwt: "extensions",
    });
  });

  it("resolves already-remediated history correctly", () => {
    // 20260911232039 flattens two views; 20260911235000 repairs both. The SET
    // is secure even though one file is not, and a per-file rule would
    // red-flag committed history forever.
    const delta = corpus.find((m) => m.file.includes("pending_delta"))!;
    expect(delta.sql).toMatch(
      /create or replace view "public"\."contacts_summary" as/,
    );
    expect(delta.sql).not.toMatch(/security_invoker/);
    const repair = corpus.find((m) => m.file.includes("close_anon_grants"))!;
    expect(repair.sql).toMatch(
      /alter view public\.contacts_summary set \(security_invoker = on\)/,
    );
    expect(result.endState.views["public.contacts_summary"]).toBe(true);
  });

  it("prints the standing exception list on every run, including green ones", () => {
    // A ledger nobody reads is a blanket. None today; if one is ever added it
    // appears in CI output without anyone grepping for it.
    expect(result.activeOverrides).toEqual([]);
    expect(declaration.overrides).toEqual([]);
    if (result.activeOverrides.length > 0) {
      console.warn(
        "STANDING SECURITY-INVARIANT OVERRIDES:\n" +
          result.activeOverrides
            .map(
              (o) =>
                `  ${o.invariantId}  ${o.adr}  ${o.migrationFile}:${o.line}  ${o.reason}`,
            )
            .join("\n"),
      );
    }
  });

  it("keeps the declarative schema correct too", () => {
    // The other side of the gap. NOT the primary guard: 03_views.sql was
    // correct throughout the incident, so a guard reading only it would have
    // been green while contacts_summary served every contact record to anon.
    const sql = readFileSync(
      join(ROOT, "supabase", "schemas", "03_views.sql"),
      "utf8",
    );
    expect(
      checkDeclarativeViews(sql, declaration).map(formatFinding).join("\n"),
    ).toBe("");
  });
});

describe("declaration.json cannot be mis-keyed into a no-op", () => {
  it("rejects an unknown top-level key", () => {
    expect(() =>
      validateDeclaration({ ...declaration, extenstions: {} }),
    ).toThrow(/unknown key/);
  });

  it("rejects a missing domain", () => {
    const { extensions: _removed, ...rest } = declaration;
    expect(() => validateDeclaration(rest)).toThrow(/missing key "extensions"/);
  });

  it("rejects a domain of the wrong type", () => {
    expect(() =>
      validateDeclaration({
        ...declaration,
        views: { ...declaration.views, declared: "activity_log" },
      }),
    ).toThrow(/must be array/);
  });
});

describe("the seal is portable across platforms", () => {
  // CI caught this on its first run. The seal had been computed on Windows,
  // where git checks these files out with CRLF; on the Linux runner the same
  // committed bytes arrive with LF and every sealed file reported
  // `seal:edited`. A seal that only holds on the machine that wrote it is a
  // tripwire, not an integrity check.
  //
  // loadMigrationCorpus therefore normalises line endings before hashing. The
  // cost is that a change which ONLY alters line endings is invisible to the
  // seal — the right trade, since git rewrites them on checkout anyway.
  const write = (dir: string, name: string, body: string) =>
    writeFileSync(join(dir, name), body, "utf8");

  const hashOf = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "seal-eol-"));
    write(dir, "20240101000000_probe.sql", body);
    return loadMigrationCorpus(dir)[0].sha256;
  };

  const LF = "create table public.x (id int);\nselect 1;\n";
  const CRLF = LF.replace(/\n/g, "\r\n");

  it("hashes the same content identically whatever the checkout produced", () => {
    expect(hashOf(CRLF)).toBe(hashOf(LF));
  });

  it("still distinguishes genuinely different content", () => {
    // The normalisation must not flatten everything into one hash.
    expect(hashOf(LF)).not.toBe(hashOf(LF.replace("select 1", "select 2")));
  });

  it("parses the normalised text, so analysis matches the hash", () => {
    // If the hash were normalised but the parser saw raw CRLF, the two halves
    // of the guard would disagree about what they are looking at.
    const dir = mkdtempSync(join(tmpdir(), "seal-eol-parse-"));
    write(dir, "20240101000000_probe.sql", CRLF);
    expect(loadMigrationCorpus(dir)[0].sql).not.toContain(
      String.fromCharCode(13),
    );
  });
});

describe("the seal makes history immutable", () => {
  const idsOf = (input: Parameters<typeof analyze>[0]) =>
    analyze(input).findings.map((f) => f.id);

  it("fails when a sealed migration's bytes change", () => {
    const tampered = corpus.map((m) =>
      m.file.includes("drop_pg_net") ? { ...m, sha256: "0".repeat(64) } : m,
    );
    expect(
      idsOf({ corpus: tampered, declaration, seal, repoRoot: ROOT }),
    ).toContain("seal:edited");
  });

  it("fails when a sealed migration disappears", () => {
    expect(
      idsOf({
        corpus: corpus.filter((m) => !m.file.includes("drop_pg_net")),
        declaration,
        seal,
        repoRoot: ROOT,
      }),
    ).toContain("seal:deleted");
  });

  it("fails when a migration is back-dated under the seal to dodge the rules", () => {
    expect(
      idsOf({
        corpus: [
          {
            file: "20240101000000_backdated.sql",
            sql: "grant all on table public.contacts to anon;",
            timestamp: "20240101000000",
            sha256: "x",
          },
          ...corpus,
        ],
        declaration,
        seal,
        repoRoot: ROOT,
      }),
    ).toContain("seal:back-dated");
  });

  it("is CLOSED: a new migration cannot be sealed instead of classified", () => {
    expect(
      idsOf({
        corpus,
        declaration,
        seal: { ...seal, "20270101000000_new.sql": "0".repeat(64) },
        repoRoot: ROOT,
      }),
    ).toContain("seal:beyond-frozen-point");
  });

  it("still carries the assertions the hand-written security migrations make", () => {
    // Constraint D is enforced by the seal (editing these files changes their
    // hash) and by supabase/tests/securityInvariants.test.ts, which already
    // pins SI-01 / SI-02 / SI-11 markers against these same two files. This
    // deliberately does NOT start a third marker registry that could drift.
    for (const name of ["close_anon_grants_and_view_invoker", "drop_pg_net"]) {
      const migration = corpus.find((m) => m.file.includes(name));
      expect(migration, `missing migration: ${name}`).toBeDefined();
      expect(seal[migration!.file]).toBe(migration!.sha256);
      expect(migration!.sql).toMatch(/raise\s+exception/i);
    }
  });
});

// The mutation corpus. Proof the guard is not blind: every entry is a real
// regression, several verbatim from this repository's history or from what
// `supabase db diff` emits today. A guard never shown rejecting a bad input is
// indistinguishable from one that silently passes everything.

const REJECTED: Array<[string, string, RegExp]> = [
  // --- Phase 1A: the engine worker is scrutinised, never exempted. ----------
  // ops_worker deliberately does NOT go in BYPASS_ROLES: it is the one role
  // whose least privilege matters most. It reads and calls three lease-checking
  // functions, so any write verb is a finding — a worker that could write
  // ops.jobs directly could extend its own lease or settle another tenant's job.
  [
    "a write verb granted to the engine worker",
    "grant update on ops.jobs to ops_worker;",
    /^grant:ops_worker:ops\.jobs:update$/,
  ],
  [
    "INSERT granted to the engine worker",
    "grant insert on ops.jobs to ops_worker;",
    /^grant:ops_worker:ops\.jobs:insert$/,
  ],
  [
    "GRANT ALL to the engine worker",
    "grant all on ops.jobs to ops_worker;",
    /^grant:ops_worker:ops\.jobs:all$/,
  ],
  [
    "a schema-wide grant to the engine worker",
    "grant select on all tables in schema ops to ops_worker;",
    /^grant:ops_worker:all tables in schema ops$/,
  ],
  [
    "today's db diff output",
    [
      `create extension if not exists "pg_net" with schema "extensions" version ${Q}0.19.5${Q};`,
      `create or replace view "public"."activity_log" as SELECT 1 AS id;`,
      `create or replace view "public"."companies_summary" as SELECT 1 AS id;`,
      `create or replace view "public"."init_state" as SELECT 1 AS is_initialized;`,
    ].join("\n"),
    /^extension:pg_net$/,
  ],
  [
    "the exact defect that shipped",
    `create or replace view "public"."contacts_summary" as  SELECT co.id, co.first_name FROM public.contacts co;`,
    /^view-security-invoker:public\.contacts_summary$/,
  ],
  [
    "a with-clause that is not the right one",
    "create or replace view public.contacts_summary with (check_option = local) as select 1 as id;",
    /^view-security-invoker:public\.contacts_summary$/,
  ],
  [
    "security_invoker = false (not the word 'off')",
    "alter view public.contacts_summary set (security_invoker = false);",
    /^view-security-invoker:public\.contacts_summary$/,
  ],
  [
    "security_invoker = off",
    "alter view public.contacts_summary set (security_invoker = off);",
    /^view-security-invoker:public\.contacts_summary$/,
  ],
  [
    "ALTER TABLE setting a view's reloption off",
    "alter table public.contacts_summary set (security_invoker = off);",
    /^view-security-invoker:public\.contacts_summary$/,
  ],
  [
    "RESET of the reloption",
    "alter view public.contacts_summary reset (security_invoker);",
    /^view-security-invoker:public\.contacts_summary$/,
  ],
  [
    "an unreadable boolean spelling is not guessed",
    "alter view public.contacts_summary set (security_invoker = maybe);",
    /^view-security-invoker:public\.contacts_summary$/,
  ],
  [
    "a materialized view over an RLS-protected table",
    "create materialized view public.contacts_rollup as select count(*) from public.contacts;",
    /^materialized-view:public\.contacts_rollup$/,
  ],
  [
    "grant to anon",
    "grant select on table public.contacts to anon;",
    /^grant:anon:public\.contacts$/,
  ],
  [
    "grant to PUBLIC",
    "grant select on table public.contacts to public;",
    /^grant:public:public\.contacts$/,
  ],
  [
    "grant all to authenticated (silently includes TRUNCATE)",
    "grant all on table public.contacts to authenticated;",
    /^grant:authenticated:public\.contacts:all$/,
  ],
  [
    "grant truncate to authenticated",
    "grant select, truncate on table public.contacts to authenticated;",
    /^grant:authenticated:public\.contacts:truncate$/,
  ],
  [
    "grant on all tables in schema",
    "grant select on all tables in schema public to authenticated;",
    /^grant:authenticated:all tables in schema public$/,
  ],
  [
    "grant to a role nobody declared",
    "grant select on table public.contacts to reporting_bot;",
    /^grant:reporting_bot:public\.contacts$/,
  ],
  [
    "alter default privileges granting to anon",
    "alter default privileges in schema public grant all on tables to anon;",
    /^default-privileges:anon$/,
  ],
  [
    "disabling row level security",
    "alter table public.contacts disable row level security;",
    /^rls-disable:public\.contacts$/,
  ],
  [
    "un-forcing row level security",
    "alter table public.contacts no force row level security;",
    /^rls-disable:public\.contacts$/,
  ],
  [
    "a new table with no RLS",
    [
      "create table public.patient_notes (id bigint primary key, body text);",
      "grant select on table public.patient_notes to authenticated;",
    ].join("\n"),
    /^rls-missing:public\.patient_notes$/,
  ],
  [
    "re-opening the attachments bucket",
    `update storage.buckets set public = true where id = ${Q}attachments${Q};`,
    /^storage-bucket-public$/,
  ],
  [
    "creating a public bucket",
    `insert into storage.buckets (id, name, public) values (${Q}leaks${Q}, ${Q}leaks${Q}, true);`,
    /^storage-bucket-public$/,
  ],
  [
    "pg_net installed inside a DO block",
    `do ${D}${D} begin create extension if not exists pg_net; end ${D}${D};`,
    /^extension:pg_net$/,
  ],
  [
    // The fail-open all three reviews found in the design this is built from:
    // crediting a state claim because the block merely CONTAINS a raise.
    "a DO block whose raise exception is decorative",
    `do ${D}${D} begin if false then raise exception ${Q}unreachable${Q}; end if; create extension if not exists pg_net; end ${D}${D};`,
    /^extension:pg_net$/,
  ],
  [
    "a DO block EXECUTEing a flattening view",
    `do ${D}${D} begin execute ${Q}create or replace view public.contacts_summary as select * from public.contacts${Q}; raise exception ${Q}decorative${Q}; end ${D}${D};`,
    /^view-security-invoker:public\.contacts_summary$/,
  ],
  [
    "dropping pg_net in a DO block with no catalogue proof",
    `do ${D}${D} begin drop extension pg_net; end ${D}${D};`,
    /^uncredited-drop:extension:pg_net$/,
  ],
  [
    "dynamic SQL the guard cannot resolve",
    `do ${D}${D} declare v_sql text := ${Q}x${Q}; begin execute v_sql; end ${D}${D};`,
    /^dynamic-sql:/,
  ],
  [
    "a column-level grant is not assumed safe",
    "grant select (first_name) on table public.contacts to authenticated;",
    /^unclassifiable:/,
  ],
  [
    "WITH GRANT OPTION is not assumed safe",
    "grant select on table public.contacts to authenticated with grant option;",
    /^unclassifiable:/,
  ],
  [
    "a new view in public nobody declared",
    "create view public.secret_rollup with (security_invoker = on) as select 1 as id;",
    /^end-state-view-undeclared:public\.secret_rollup$/,
  ],
  [
    "silently deleting a declared view",
    "drop view public.contacts_summary;",
    /^end-state-view-missing:public\.contacts_summary$/,
  ],
  [
    "a view in another schema is not silently ignored",
    "create view private.shadow as select * from public.contacts;",
    /^view-foreign-schema:private\.shadow$/,
  ],
  [
    "an extension nobody approved",
    "create extension if not exists pg_trgm with schema extensions;",
    /^extension:pg_trgm$/,
  ],
  [
    "an approved extension installed into a reachable schema",
    "create extension if not exists citext with schema public;",
    /^extension-schema:citext:public$/,
  ],
  [
    "dblink, the same hazard class as pg_net",
    "create extension if not exists dblink with schema extensions;",
    /^extension:dblink$/,
  ],
  [
    "a flattening repaired in the WRONG view",
    [
      `create or replace view "public"."contacts_summary" as select 1 as id;`,
      "alter view public.init_state set (security_invoker = on);",
    ].join("\n"),
    /^view-security-invoker:public\.contacts_summary$/,
  ],
];

const THROWN: Array<[string, string, RegExp]> = [
  [
    "an unknown verb (realtime, deliberately closed)",
    "create publication supabase_realtime for all tables;",
    /UNCLASSIFIED STATEMENT/,
  ],
  [
    "an unterminated dollar-quoted body",
    `create function public.f() returns int language sql as ${D}body${D} select 1;`,
    /unterminated dollar-quoted string/,
  ],
  [
    "an unterminated string literal",
    `insert into public.tags (name) values (${Q}oops;`,
    /unterminated string literal/,
  ],
  [
    "an unterminated quoted identifier",
    `grant select on table "public"."contacts to authenticated;`,
    /unterminated quoted identifier/,
  ],
  [
    "an unterminated block comment",
    "/* still going\ngrant select on table public.contacts to anon;",
    /unterminated block comment/,
  ],
  [
    "a statement with no terminating semicolon",
    "grant select on table public.contacts to authenticated",
    /text after the last semicolon/,
  ],
];

const ACCEPTED: Array<[string, string]> = [
  // --- Phase 1A ---
  [
    "SELECT granted to the engine worker",
    "grant select on ops.jobs to ops_worker;",
  ],
  [
    "EXECUTE granted to the engine worker",
    "grant execute on function ops.current_tenant_id() to ops_worker;",
  ],
  [
    // The word `execute` also appears INSIDE string literals, where it is not a
    // statement. This exact assertion was reported as unresolvable dynamic SQL
    // and blocked a correct migration until the scanner learned to skip
    // literals — a false positive is a defect, not caution.
    "an assertion that mentions EXECUTE inside a string literal",
    `do $$
     begin
       if has_function_privilege('ops_worker', 'ops.enqueue_job(uuid)', 'EXECUTE') then
         raise exception 'ops_worker can execute ops.enqueue_job';
       end if;
     end
     $$;`,
  ],
  [
    // `alter view … set` changes only the reloption, so the query text stays
    // byte-identical to pg_dump form and the next `db diff` sees no phantom
    // change. This is what 20260911235000 did; a guard that refused it would be
    // deleted the first time `db diff` re-emitted a view.
    "the repository's own documented repair pattern",
    [
      `create or replace view "public"."contacts_summary" as  SELECT co.id FROM public.contacts co;`,
      "alter view public.contacts_summary set (security_invoker = on);",
    ].join("\n"),
  ],
  [
    "a view declaring the option inline",
    "create or replace view public.contacts_summary with (security_invoker = on) as select co.id from public.contacts co;",
  ],
  [
    "no spaces around the equals sign",
    "create or replace view public.contacts_summary with (security_invoker=on) as select 1 as id;",
  ],
  [
    "a column list before the with-clause",
    [
      "drop view public.contacts_summary;",
      "create view public.contacts_summary (id) with (security_invoker = on) as select 1;",
    ].join("\n"),
  ],
  [
    "uppercase, as 20260320120000 actually spells it",
    "CREATE OR REPLACE VIEW public.contacts_summary WITH (security_invoker = on) AS SELECT 1 AS id;",
  ],
  [
    // The friction test: the shape of almost every real migration must cost the
    // author nothing — no second artifact, no ledger entry.
    "an ordinary feature migration: new table, RLS, policy, enumerated grants",
    [
      "create table public.patient_notes (id bigint primary key, body text);",
      "alter table public.patient_notes enable row level security;",
      "create policy note_select on public.patient_notes for select to authenticated using (public.is_admin());",
      "grant select, insert, update, delete on table public.patient_notes to authenticated;",
      "grant usage on sequence public.patient_notes_id_seq to authenticated;",
    ].join("\n"),
  ],
  [
    "revokes, which only ever tighten",
    [
      "revoke all on table public.contacts from anon;",
      "revoke usage on schema extensions from public;",
    ].join("\n"),
  ],
  [
    "hazard words inside a string literal are not statements",
    `do ${D}${D} begin if true then raise notice ${Q}pg_net is gone and there is no grant to anon here${Q}; end if; end ${D}${D};`,
  ],
  [
    // Stated rather than hidden: service_role and postgres carry BYPASSRLS on
    // Supabase already (PHASE_0_5_REPORT §16.7, accepted risk).
    "grants to roles that already bypass RLS",
    "grant all on table public.contacts to service_role;",
  ],
  [
    "closing a storage bucket",
    `update storage.buckets set public = false where id = ${Q}attachments${Q};`,
  ],
  [
    "dropping and recreating a view properly",
    [
      "drop view if exists public.contacts_summary;",
      "create view public.contacts_summary with (security_invoker = on) as select 1 as id;",
    ].join("\n"),
  ],
  [
    // Real, at 20260115150819_snake_case_renaming.sql:2. Misreading it reports
    // both "undeclared view" and "declared view no longer exists".
    "ALTER VIEW … RENAME COLUMN is not a RENAME TO",
    `alter view "public"."companies_summary" rename column "stateAbbr" TO "state_abbr";`,
  ],
  [
    "a DO-block drop that proves itself over the catalogue",
    [
      `do ${D}${D} begin drop extension if exists dblink; end ${D}${D};`,
      `do ${D}${D} begin if exists (select 1 from pg_extension where extname = ${Q}dblink${Q}) then raise exception ${Q}dblink survived${Q}; end if; end ${D}${D};`,
    ].join("\n"),
  ],
  [
    "ordinary index / policy / function / set churn",
    [
      "create index if not exists contacts_last_name_idx on public.contacts (last_name);",
      `create or replace function public.f() returns int language sql as ${D}fn${D} select 1 ${D}fn${D};`,
      "drop policy if exists old_policy on public.contacts;",
      "set check_function_bodies = off;",
    ].join("\n"),
  ],
];

describe("a security-regressing migration is REJECTED", () => {
  it.each(REJECTED)("rejects: %s", (name, sql, expected) => {
    const ids = idsFor(slug(name), sql);
    expect(ids, `${name} was accepted`).not.toHaveLength(0);
    expect(
      ids.some((id) => expected.test(id)),
      `${name}: expected a finding matching ${expected}, got ${JSON.stringify(ids)}`,
    ).toBe(true);
  });

  it.each(THROWN)("refuses to read: %s", (name, sql, expected) => {
    expect(() => run(candidate(slug(name), sql))).toThrow(expected);
  });
});

describe("a legitimate migration is ACCEPTED", () => {
  it.each(ACCEPTED)("accepts: %s", (name, sql) => {
    expect(
      run(candidate(slug(name), sql))
        .findings.map(formatFinding)
        .join("\n\n"),
      `${name} was blocked`,
    ).toBe("");
  });
});

// The escape hatch matters as much as the check: a guard with no legitimate
// override gets deleted the first time someone needs the thing it blocks.

describe("the escape hatch", () => {
  const FILE = "20270101000000_owner_executed_rollup.sql";
  const MARKERS = [
    "-- SECURITY-INVARIANT-OVERRIDE: view-security-invoker:public.rollup ADR-0099 aggregate-only, granted to no role",
    "-- SECURITY-INVARIANT-OVERRIDE: end-state-view:public.rollup ADR-0099 aggregate-only, granted to no role",
  ];
  const VIEW =
    "create view public.rollup as select count(*) as n from public.contacts;";
  const LEDGER = [
    {
      invariantId: "view-security-invoker:public.rollup",
      adr: "ADR-0099",
      migrationFile: FILE,
      reason: "aggregate-only reporting view, granted to no role",
    },
    {
      invariantId: "end-state-view:public.rollup",
      adr: "ADR-0099",
      migrationFile: FILE,
      reason: "aggregate-only reporting view, granted to no role",
    },
  ];

  const fakeRepo = (
    opts: { accepted?: boolean; namesMigration?: boolean } = {},
  ) => {
    const root = mkdtempSync(join(tmpdir(), "invariant-adr-"));
    mkdirSync(join(root, "docs", "adr"), { recursive: true });
    writeFileSync(
      join(root, "docs", "adr", "0099-owner-executed-rollup.md"),
      [
        "# 0099. An owner-executed reporting view",
        "",
        `**Status:** **${opts.accepted === false ? "Proposed" : "Accepted"}** · **Date:** 2026-09-11`,
        "",
        `Applies to \`${opts.namesMigration === false ? "unrelated.sql" : FILE}\`.`,
      ].join("\n"),
    );
    return root;
  };

  const attempt = (sql: string, overrides: typeof LEDGER, repoRoot: string) =>
    analyze({
      corpus: [
        ...corpus,
        {
          file: FILE,
          sql,
          timestamp: "20270101000000",
          sha256: createHash("sha256").update(sql, "utf8").digest("hex"),
        },
      ],
      declaration: {
        ...declaration,
        views: {
          ...declaration.views,
          declared: [...declaration.views.declared, "rollup"],
        },
        overrides,
      },
      seal,
      repoRoot,
    });

  const idsOf = (...args: Parameters<typeof attempt>) =>
    attempt(...args).findings.map((f) => f.id);

  it("lets an approved, documented, ledgered exception through", () => {
    const result = attempt([...MARKERS, VIEW].join("\n"), LEDGER, fakeRepo());
    expect(result.findings.map(formatFinding).join("\n")).toBe("");
    expect(result.activeOverrides).toHaveLength(2);
  });

  it("blocks the same statement with no marker", () => {
    expect(idsOf(VIEW, [], fakeRepo())).toContain(
      "view-security-invoker:public.rollup",
    );
  });

  it("blocks a marker with no ledger entry", () => {
    expect(idsOf([...MARKERS, VIEW].join("\n"), [], fakeRepo())).toContain(
      "override:unledgered:view-security-invoker:public.rollup",
    );
  });

  it("blocks a ledger entry with no marker, so the ledger self-prunes", () => {
    expect(idsOf(VIEW, LEDGER, fakeRepo())).toContain(
      "override:stale-ledger:view-security-invoker:public.rollup",
    );
  });

  it("blocks a Proposed ADR", () => {
    expect(
      idsOf(
        [...MARKERS, VIEW].join("\n"),
        LEDGER,
        fakeRepo({ accepted: false }),
      ),
    ).toContain(
      "override:adr-not-accepted:view-security-invoker:public.rollup",
    );
  });

  it("blocks an ADR that does not name this migration", () => {
    expect(
      idsOf(
        [...MARKERS, VIEW].join("\n"),
        LEDGER,
        fakeRepo({ namesMigration: false }),
      ),
    ).toContain(
      "override:adr-does-not-name-migration:view-security-invoker:public.rollup",
    );
  });

  it("blocks an ADR number that does not exist", () => {
    expect(
      idsOf(
        [...MARKERS, VIEW].join("\n").replace(/ADR-0099/g, "ADR-4242"),
        LEDGER.map((o) => ({ ...o, adr: "ADR-4242" })),
        fakeRepo(),
      ),
    ).toContain("override:no-adr:view-security-invoker:public.rollup");
  });

  it("blocks a malformed marker rather than ignoring it", () => {
    const ids = idsOf(
      `-- SECURITY-INVARIANT-OVERRIDE: just because\n${VIEW}`,
      [],
      fakeRepo(),
    );
    expect(ids.some((id) => id.startsWith("override:malformed"))).toBe(true);
  });

  it("refuses a marker that is not adjacent to the statement it excuses", () => {
    const sql = [MARKERS[0], ...Array(12).fill("-- filler"), VIEW].join("\n");
    expect(idsOf(sql, LEDGER, fakeRepo())).toContain(
      "override:dead:view-security-invoker:public.rollup",
    );
  });

  it("cannot override a statement the guard could not read", () => {
    // An override is scoped to an object; a statement with no reliable object
    // has nothing to scope to, so unparseable findings are non-overridable.
    const ids = idsOf(
      [
        `-- SECURITY-INVARIANT-OVERRIDE: unclassifiable:${FILE}:2 ADR-0099 reason`,
        "grant select (first_name) on table public.contacts to authenticated;",
      ].join("\n"),
      LEDGER,
      fakeRepo(),
    );
    expect(ids.some((id) => id.startsWith("unclassifiable:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("override:dead:"))).toBe(true);
  });

  it("uses a token that appears nowhere in the committed migrations", () => {
    // Impossible to trip by accident: migra emits no comments and prettier's
    // glob excludes .sql, so the token is unique in the tree.
    const hits = corpus.filter((m) =>
      m.sql.includes("SECURITY-INVARIANT-OVERRIDE"),
    );
    expect(hits.map((m) => m.file)).toEqual([]);
  });
});
