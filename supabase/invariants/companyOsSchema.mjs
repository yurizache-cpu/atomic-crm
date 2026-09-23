// company_os_api as a schema (companyOsApi.mjs runs these sections, in its
// order): never on a search path, function-only (no relation, sequence, type
// or domain), created only in an allowlisted file and never with
// AUTHORIZATION, never altered or dropped. Each section returns true (it owns
// the statement), false (the existing rules) or null (not its statement: the
// next section).

import { stripSqlComments } from "./sqlStatements.mjs";
import { mentionsSurface } from "./companyOsNames.mjs";

/** The schema on a search path. */
export function searchPathSection({ m, statement, file, cfg, fail }) {
  if (!(/^set\b/.test(m) && /\bsearch_path\b/.test(m))) return null;
  const text = stripSqlComments(statement.raw ?? m, file);
  if (new RegExp(`\\b${cfg.schema}\\b`).test(text)) {
    fail(
      "search-path",
      `${cfg.schema} on a search_path: unqualified names would resolve into the exposed schema`,
    );
    return true;
  }
  return false;
}

/** ALTER SCHEMA: owned whatever it names; refused when it names the surface. */
export function alterSchemaSection({ m, cfg, fail }) {
  if (!/^alter\s+schema\b/.test(m)) return null;
  if (mentionsSurface(m, cfg)) {
    fail("alter-schema", `ALTER SCHEMA on ${cfg.schema}`);
  }
  return true;
}

/** Relations, sequences, types and domains in the exposed schema. */
export function nonFunctionObjectSection({ m, cfg, fail }) {
  if (
    /^(create|alter)\s+(table|(or\s+replace\s+)?(recursive\s+)?view|(or\s+replace\s+)?materialized\s+view|sequence|type|domain)\b/.test(
      m,
    ) &&
    (new RegExp(`\\b${cfg.schema}\\.`).test(m) ||
      new RegExp(`\\bset\\s+schema\\s+${cfg.schema}\\b`).test(m))
  ) {
    fail(
      "non-function-object",
      `${cfg.schema} is function-only: no table, view, sequence, type or domain`,
    );
    return true;
  }
  return null;
}

/** The schema itself: CREATE SCHEMA and DROP SCHEMA. */
export function schemaSection(surfaceStatement) {
  const { m, cfg, fail } = surfaceStatement;
  if (/^create\s+schema\b/.test(m)) return createSchema(surfaceStatement);
  if (/^drop\s+schema\b/.test(m) && mentionsSurface(m, cfg)) {
    fail("drop-schema", `DROP SCHEMA ${cfg.schema}`);
    return true;
  }
  return null;
}

/** CREATE SCHEMA: the surface only in the allowlist, never AUTHORIZATION. */
function createSchema({ m, cfg, allowlisted, fail }) {
  if (/\bauthorization\b/.test(m) && mentionsSurface(m, cfg)) {
    fail(
      "schema-authorization",
      `CREATE SCHEMA … AUTHORIZATION naming ${cfg.role} or a dynamic name`,
    );
    return true;
  }
  if (
    new RegExp(
      `^create\\s+schema\\s+(if\\s+not\\s+exists\\s+)?${cfg.schema}\\b`,
    ).test(m)
  ) {
    if (!allowlisted)
      fail(
        "create-schema",
        `CREATE SCHEMA ${cfg.schema} outside the exact OD-8a allowlist`,
      );
    if (/\bauthorization\b/.test(m))
      fail(
        "schema-authorization",
        `CREATE SCHEMA ${cfg.schema} … AUTHORIZATION`,
      );
    return true;
  }
  return false;
}
