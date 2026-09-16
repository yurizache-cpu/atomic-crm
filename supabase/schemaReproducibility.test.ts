// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Static reproducibility checks over the SQL itself — no database required, so
// they run in CI on every push even where Docker is unavailable.
//
// These exist because `supabase db reset` is red for a reason nothing caught:
// `seed.sql` inserts into `loss_reasons`, a table that lives only in the
// declarative schema and that NO migration creates. A clean database therefore
// cannot be rebuilt from the repository, which blocks every database guarantee
// the project wants to make. A test that reads the SQL is the cheapest guard
// against that whole class of drift.

const HERE = join(process.cwd(), "supabase");
const seed = readFileSync(join(HERE, "seed.sql"), "utf8");
const migrationsDir = join(HERE, "migrations");
const migrationFiles = readdirSync(migrationsDir).filter((f) =>
  f.endsWith(".sql"),
);
const migrationsSql = migrationFiles
  .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
  .join("\n");

/** Strip line and block comments so a table named only in prose does not count. */
const stripComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

/** Tables the seed writes into, unqualified and lowercased. */
const seededTables = [
  ...new Set(
    [...stripComments(seed).matchAll(/insert\s+into\s+([a-z_."]+)/gi)].map(
      (m) =>
        m[1]
          .replace(/"/g, "")
          .replace(/^public\./i, "")
          .toLowerCase(),
    ),
  ),
];

/**
 * Migrations spell identifiers both ways — `create table public.x` and
 * `create table "public"."x"` — so the schema qualifier has to tolerate
 * optional quotes on BOTH parts. Missing that produced a false positive on
 * `favicons_excluded_domains`, which does have a migration.
 */
const migrationCreates = (table: string) =>
  new RegExp(
    `create\\s+table\\s+(if\\s+not\\s+exists\\s+)?("?public"?\\s*\\.\\s*)?"?${table}"?\\b`,
    "i",
  ).test(stripComments(migrationsSql));

describe("migrations are self-sufficient", () => {
  it("finds migrations and a seed to check", () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
    expect(seededTables.length).toBeGreaterThan(0);
  });

  // RESOLVED 2026-09-11 (Phase 0.5B): the pending delta migration was
  // generated against a live database and now creates loss_reasons, so a
  // clean `supabase db reset` succeeds. This assertion was an `it.fails`
  // marker while the blocker existed; it turned red the moment the migration
  // landed, which is exactly what forced this rewrite instead of letting the
  // marker rot. Verified: two consecutive clean resets, 36s and 34s, exit 0.
  it("every table the seed writes to is created by a migration", () => {
    const missing = seededTables.filter((t) => !migrationCreates(t));
    expect(missing).toEqual([]);
  });
});

describe("declarative schema vs migrations", () => {
  const tablesDdl = readFileSync(
    join(HERE, "schemas", "01_tables.sql"),
    "utf8",
  );

  it("does not enumerate tenant vocabulary in CHECK constraints (ADR 0013)", () => {
    // The engine must stay domain-independent: a clinic's pipeline stage names
    // in DDL are what stop a second tenant being onboarded without a migration.
    const clinicVocabulary = [
      "initial_session_scheduled",
      "continuity_converted",
      "awaiting_lead",
      "follow_up_due",
    ];
    const ddl = stripComments(tablesDdl).toLowerCase();
    for (const word of clinicVocabulary) {
      expect(
        ddl,
        `"${word}" is tenant vocabulary and must not be in DDL`,
      ).not.toContain(word);
    }
  });

  it.each(migrationFiles.filter((file) => file >= "20260912120000"))(
    "engine migration %s names no particular tenant's business (CLAUDE.md rule 2)",
    (file) => {
      // The engine must run a clinic today and a 3D-printing business later.
      // Department names, company names and agent roles are seed data; a word
      // like these in executable engine DDL is the `deals` CHECK mistake again.
      const sql = stripComments(
        readFileSync(join(migrationsDir, file), "utf8"),
      ).toLowerCase();
      // Whole words only: PL/pgSQL's own `get diagnostics` must not read as a
      // clinical term — a guard that cries wolf on correct SQL gets deleted.
      expect(sql).not.toMatch(
        /\b(psycholog\w*|clinics?|clinical|patients?|therap(y|ies|ist|ists|eutic)|diagnos(is|es)|appointments?|reception)\b/,
      );
    },
  );

  it("keeps the storage lockdown out of the declarative schema's diffable surface", () => {
    // `07_storage.sql` is DML, which `db diff` cannot emit. Its enforcement has
    // to be a hand-written migration, or the documented state and the real
    // database silently diverge — which is exactly what happened once.
    const storage = readFileSync(
      join(HERE, "schemas", "07_storage.sql"),
      "utf8",
    );
    expect(storage).toMatch(/update\s+storage\.buckets/i);
    expect(migrationsSql).toMatch(/update\s+storage\.buckets/i);
  });

  it("ships an assertion with each hand-written security migration", () => {
    // A migration that silently no-ops is worse than no migration: it looks
    // applied. Both security migrations must raise if their end state is wrong.
    for (const name of [
      "close_attachments_bucket",
      "revoke_network_extension_privileges",
      "inbound_email_ledger",
      "ops_execution_core",
      "ops_worker_runtime",
      "company_domain_core",
      "agent_runtime",
    ]) {
      const file = migrationFiles.find((f) => f.includes(name));
      expect(file, `missing migration: ${name}`).toBeDefined();
      const sql = readFileSync(join(migrationsDir, file!), "utf8");
      expect(sql, `${name} must assert its end state`).toMatch(
        /raise\s+exception/i,
      );
    }
  });
});
