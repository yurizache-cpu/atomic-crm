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
    [...stripComments(seed).matchAll(/insert\s+into\s+([a-z_."]+)/gi)].map((m) =>
      m[1].replace(/"/g, "").replace(/^public\./i, "").toLowerCase(),
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

  // KNOWN BLOCKER, tracked in PHASE_0_5_REPORT.md: `loss_reasons` is created
  // only in supabase/schemas/01_tables.sql, and the declarative schema has
  // never been migrated. `it.fails` asserts the blocker still exists — so this
  // suite stays green while it does, and turns RED the moment the migration
  // lands, forcing this marker to be removed rather than silently forgotten.
  it.fails(
    "KNOWN BLOCKER: every table the seed writes to is created by a migration",
    () => {
      const missing = seededTables.filter((t) => !migrationCreates(t));
      expect(missing).toEqual([]);
    },
  );

  it("the only unmigrated seeded table is the one we know about", () => {
    // Pins the blast radius. If a SECOND table ever goes missing, this fails
    // immediately instead of hiding behind the known blocker above.
    const missing = seededTables.filter((t) => !migrationCreates(t));
    expect(missing).toEqual(["loss_reasons"]);
  });
});

describe("declarative schema vs migrations", () => {
  const tablesDdl = readFileSync(join(HERE, "schemas", "01_tables.sql"), "utf8");

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
      expect(ddl, `"${word}" is tenant vocabulary and must not be in DDL`).not.toContain(
        word,
      );
    }
  });

  it("keeps the storage lockdown out of the declarative schema's diffable surface", () => {
    // `07_storage.sql` is DML, which `db diff` cannot emit. Its enforcement has
    // to be a hand-written migration, or the documented state and the real
    // database silently diverge — which is exactly what happened once.
    const storage = readFileSync(join(HERE, "schemas", "07_storage.sql"), "utf8");
    expect(storage).toMatch(/update\s+storage\.buckets/i);
    expect(migrationsSql).toMatch(/update\s+storage\.buckets/i);
  });

  it("ships an assertion with each hand-written security migration", () => {
    // A migration that silently no-ops is worse than no migration: it looks
    // applied. Both security migrations must raise if their end state is wrong.
    for (const name of [
      "close_attachments_bucket",
      "revoke_network_extension_privileges",
    ]) {
      const file = migrationFiles.find((f) => f.includes(name));
      expect(file, `missing migration: ${name}`).toBeDefined();
      const sql = readFileSync(join(migrationsDir, file!), "utf8");
      expect(sql, `${name} must assert its end state`).toMatch(/raise\s+exception/i);
    }
  });
});
