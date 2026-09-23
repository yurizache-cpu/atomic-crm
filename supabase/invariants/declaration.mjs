// Loading the corpus, and validating the declaration before any of it is
// trusted.
//
// Both exist for the same reason: this repository has shipped three checks that
// silently no-opped and looked applied (`make registry-gen` exiting 127 under
// `sh -e`, the `import.meta.url` main-guards on Windows, REVOKE EXECUTE on
// supabase_admin-owned functions). A mis-keyed declaration — say `extenstions`
// — would be the fourth, disabling a whole domain while every test stayed green.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { InvariantError } from "./sqlStatements.mjs";

export const MIGRATION_FILENAME = /^(\d{14})_[A-Za-z0-9_-]+\.sql$/;

/**
 * Read every migration in apply order, with the ordering property ASSERTED
 * rather than assumed: filename sort equals apply order only if every name
 * carries a 14-digit timestamp and those timestamps strictly increase.
 *
 * @param {string} dir
 * @returns {{file: string, sql: string, timestamp: string, sha256: string}[]}
 */
export function loadMigrationCorpus(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new InvariantError(
      `no .sql files in ${dir}. An empty corpus would make every assertion vacuously true — the exact "the check silently did nothing and looked applied" shape this repository has already shipped three times.`,
    );
  }
  let previous = "";
  return files.map((file) => {
    const m = MIGRATION_FILENAME.exec(file);
    if (!m) {
      throw new InvariantError(
        `${file}: migration filenames must be <14-digit timestamp>_<name>.sql. Without that, filename sort is not apply order and the replay models the wrong sequence.`,
      );
    }
    if (m[1] <= previous) {
      throw new InvariantError(
        `${file}: timestamp ${m[1]} does not strictly follow ${previous}. Filename sort is no longer apply order.`,
      );
    }
    previous = m[1];
    // Line endings are normalised before hashing AND before parsing.
    //
    // Without this the seal is not portable: git checks these files out with
    // CRLF on Windows and LF on Linux, so the same committed bytes hash
    // differently per platform. CI caught it on the first run — every sealed
    // file reported `seal:edited` on the Linux runner while the working tree on
    // Windows was untouched. A seal that fails everywhere except the machine
    // that wrote it is not an integrity check, it is a tripwire on one laptop.
    //
    // Normalising loses the ability to detect a change that ONLY alters line
    // endings. That is the right trade: line endings are not semantic in SQL,
    // and git rewrites them on checkout regardless of what anyone intended.
    const sql = readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n");
    return {
      file,
      sql,
      timestamp: m[1],
      sha256: createHash("sha256").update(sql, "utf8").digest("hex"),
    };
  });
}

const DECLARATION_SHAPE = {
  purpose: "string?",
  sealedThrough: "string",
  views: "object",
  extensions: "object",
  storage: "object",
  companyOsApi: "object",
  overrides: "array",
};
// The Company OS operator surface (Phase 2C, brief §7.6 and §15). Every value
// is ALSO pinned as a literal in migrationInvariants.test.ts: growing the
// catalogue or the OD-8a allowlist is a reviewed guard update, never an
// override (owner decision S0-E).
const COMPANY_OS_API_SHAPE = {
  schema: "string",
  role: "string",
  migrationIdentity: "string",
  catalogue: "array",
  gates: "array",
  allowlistedMigrations: "array",
  transfers: "object",
};
const VIEWS_SHAPE = {
  schema: "string",
  declared: "array",
  ignoredSchemas: "array",
  // Schemas whose views MUST carry security_invoker, and whose new tables
  // must enable RLS in the migration that creates them. Wider than
  // `schema`, which additionally governs the DECLARED-view cross-check
  // against supabase/schemas/03_views.sql and stays "public".
  enforcedSchemas: "array",
};
const EXTENSIONS_SHAPE = {
  allowed: "array",
  forbidden: "array",
  allowedSchemas: "array",
};
const STORAGE_SHAPE = { buckets: "array" };
const OVERRIDE_SHAPE = {
  invariantId: "string",
  adr: "string",
  migrationFile: "string",
  reason: "string",
};

function checkShape(object, shape, where) {
  for (const [key, type] of Object.entries(shape)) {
    const optional = type.endsWith("?");
    const want = optional ? type.slice(0, -1) : type;
    if (!(key in object)) {
      if (optional) continue;
      throw new InvariantError(
        `${where}: missing key "${key}". A missing domain key would silently disable a whole class of check.`,
      );
    }
    const value = object[key];
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (actual !== want) {
      throw new InvariantError(
        `${where}: "${key}" must be ${want}, got ${actual}`,
      );
    }
  }
  for (const key of Object.keys(object)) {
    if (!(key in shape)) {
      throw new InvariantError(
        `${where}: unknown key "${key}". A typo like "extenstions" must not quietly turn a domain off.`,
      );
    }
  }
}

/** Validate `declaration.json` structurally. Throws; never warns. */
export function validateDeclaration(declaration) {
  checkShape(declaration, DECLARATION_SHAPE, "declaration.json");
  checkShape(declaration.views, VIEWS_SHAPE, "declaration.json#views");
  checkShape(
    declaration.extensions,
    EXTENSIONS_SHAPE,
    "declaration.json#extensions",
  );
  checkShape(declaration.storage, STORAGE_SHAPE, "declaration.json#storage");
  checkCompanyOsApi(declaration);
  for (const entry of declaration.overrides) {
    checkShape(entry, OVERRIDE_SHAPE, "declaration.json#overrides[]");
  }
  return declaration;
}

function checkCompanyOsApi(declaration) {
  const where = "declaration.json#companyOsApi";
  const cfg = declaration.companyOsApi;
  checkShape(cfg, COMPANY_OS_API_SHAPE, where);
  const refuse = (message) => {
    throw new InvariantError(`${where}: ${message}`);
  };
  const identifier = /^[a-z_][a-z0-9_]*$/;
  for (const key of ["schema", "role", "migrationIdentity"]) {
    if (!identifier.test(cfg[key]))
      refuse(`"${key}" is not a plain identifier`);
  }
  // The canonical form companyOsApi.mjs compares against: no argument names,
  // no pg_catalog prefix, aliases folded, no spaces.
  const canonical = /^[a-z0-9_]+\.[a-z0-9_]+\((([a-z ]+)(,[a-z ]+)*)?\)$/;
  for (const ref of cfg.catalogue) {
    if (
      typeof ref !== "string" ||
      !canonical.test(ref) ||
      !ref.startsWith(`${cfg.schema}.`)
    ) {
      refuse(
        `catalogue entry ${JSON.stringify(ref)} is not a canonical ${cfg.schema} signature`,
      );
    }
  }
  for (const ref of cfg.gates) {
    if (
      typeof ref !== "string" ||
      !canonical.test(ref) ||
      !ref.startsWith("ops.gate_")
    ) {
      refuse(
        `gate entry ${JSON.stringify(ref)} is not a canonical ops.gate_ signature`,
      );
    }
  }
  for (const file of cfg.allowlistedMigrations) {
    const m = typeof file === "string" ? MIGRATION_FILENAME.exec(file) : null;
    if (!m || m[1] <= declaration.sealedThrough) {
      refuse(
        `allowlisted migration ${JSON.stringify(file)} is not an unsealed migration file name`,
      );
    }
  }
  for (const [file, refs] of Object.entries(cfg.transfers)) {
    if (!cfg.allowlistedMigrations.includes(file)) {
      refuse(
        `transfers name ${JSON.stringify(file)}, which is not allowlisted`,
      );
    }
    if (
      !Array.isArray(refs) ||
      refs.some((ref) => !cfg.catalogue.includes(ref))
    ) {
      refuse(`transfers of ${file} must be a list of catalogued signatures`);
    }
  }
}
