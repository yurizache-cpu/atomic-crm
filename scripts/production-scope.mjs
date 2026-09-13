// Production scope: what a deployment may publish, and what it must not.
//
//   node scripts/production-scope.mjs   exit 0 in scope, 1 out of scope, 2 not checked
//
// Owner decisions of 2026-09-13, made executable. It checks exactly this.
//
// Edge functions (SI-03), in this file
//   - The function directories are PRODUCTION_FUNCTIONS (plus _shared), in the
//     one canonical supabase/functions tree, configured only at canonical paths,
//     with no module map or package manifest but each function's deno.json.
//   - From each entrypoint, every relative import stays inside that tree, every
//     module reached is on REVIEWED_FUNCTION_DEPENDENCIES in a file allowed to
//     load it, and no module name is computed.
//   - No function source names a known MCP server or SQL parser. A raw SQL call
//     receives a literal, an interpolation on REVIEWED_SQL_INTERPOLATIONS, or a
//     query Kysely compiled, and only merge_contacts reaches the shared
//     Postgres pool.
// Deploy commands (SI-03, SI-25), in scripts/production-scope-commands.mjs
//   - Only deploy.yml and the makefile deploy functions, only by name from
//     PRODUCTION_FUNCTIONS, and every function deploy or database push there
//     follows a blocking, unconditional scope check in the same job or target.
//   - No remote CLI command runs against another workdir or import map, and no
//     Management API deploy call is committed.
//   - No command carries --include-seed, and none resets a linked or
//     non-loopback database.
// The development seed (SI-25), in this file
//   - The seed paths stay the default, no remote project configures seeding,
//     and no tracked file names a seed SQL file outside SEED_REFERENCES.
//
// How it reads. Shell, YAML, TOML and JSON line by line, comments included.
// JavaScript and TypeScript through the TypeScript parser
// (scripts/source-facts.mjs), so no comment, string or nested bracket hides an
// import, a call or its arguments.
//
// Limits. It reads committed files, except prose (.md, .mdx), SELF (its two
// modules and its tests) and COMMAND_FIXTURES. It cannot see a person running
// the CLI by hand; a command or module name assembled where no literal shows
// it; SQL reaching the database through a method outside RAW_SQL_METHODS, or
// caller-chosen identifiers handed to a query builder; whether a reviewed
// interpolation's variable still holds what was reviewed; code outside
// supabase/functions that is not a deploy path; or what a hosted project
// already serves, which a named deploy never deletes.

import { pathToFileURL } from "node:url";
import { readTrackedFiles } from "./dev-signing-key.mjs";
import {
  commandViolations,
  scopeCheckViolations,
} from "./production-scope-commands.mjs";
import { methodCalls, moduleLoads, parseSource } from "./source-facts.mjs";

export { parseSupabaseCommands } from "./production-scope-commands.mjs";

/** The reviewed set of deployable edge functions. Adding one is a review event. */
export const PRODUCTION_FUNCTIONS = Object.freeze([
  "delete_note_attachments",
  "merge_contacts",
  "postmark",
  "update_password",
  "users",
]);

const FUNCTIONS_ROOT = "supabase/functions/";
const entrypointOf = (name) => `${FUNCTIONS_ROOT}${name}/index.ts`;
const importMapPathOf = (name) => `${FUNCTIONS_ROOT}${name}/deno.json`;

/**
 * External modules a deployed function may load, by identity (scheme and
 * package, no version), with the files allowed to load each. A new dependency,
 * or a new file loading one, is a review event
 * (.claude/rules/dependency-safety.md).
 */
export const REVIEWED_FUNCTION_DEPENDENCIES = Object.freeze({
  // The edge runtime's own types, in each entrypoint.
  "jsr:@supabase/functions-js": Object.freeze(
    PRODUCTION_FUNCTIONS.map(entrypointOf),
  ),
  "jsr:@supabase/supabase-js": Object.freeze([
    "supabase/functions/_shared/authentication.ts",
    "supabase/functions/_shared/getUserSale.ts",
    "supabase/functions/_shared/supabaseAdmin.ts",
  ]),
  "jsr:@panva/jose": Object.freeze([
    "supabase/functions/_shared/authentication.ts",
  ]),
  "npm:tldts": Object.freeze([
    "supabase/functions/postmark/extractMailContactData.ts",
  ]),
  "npm:base64-arraybuffer": Object.freeze([
    "supabase/functions/postmark/extractAndUploadAttachments.ts",
  ]),
  "https://esm.sh/kysely": Object.freeze([
    "supabase/functions/_shared/db.ts",
    "supabase/functions/merge_contacts/index.ts",
  ]),
  // The one direct Postgres driver, behind the one shared pool.
  "https://deno.land/x/postgres": Object.freeze([
    "supabase/functions/_shared/db.ts",
  ]),
});

/**
 * Interpolated SQL a raw call may receive, by exact source text. Each entry is
 * a review event. merge_contacts sets the verified caller's id for RLS on its
 * session; ADR 0002's 2026-09-13 addendum records it for parameterisation.
 */
export const REVIEWED_SQL_INTERPOLATIONS = Object.freeze([
  Object.freeze({
    file: "supabase/functions/merge_contacts/index.ts",
    source: "`SELECT set_config('request.jwt.claim.sub', '${userId}', true)`",
  }),
]);

const SHARED_DIRECTORY = "_shared";
const POSTGRES_POOL = "supabase/functions/_shared/db.ts";
const POSTGRES_POOL_CONSUMERS = new Set([
  "supabase/functions/merge_contacts/index.ts",
]);
/** The pool's one driver call runs what Kysely compiled, never a string. */
const POOL_DRIVER_TEXT = "compiledQuery.sql";
// prettier-ignore
const RAW_SQL_METHODS = new Set([
  "raw", "unsafe", "query", "queryObject", "queryArray", "executeQuery",
]);
/** Raw methods specific enough that holding one without calling it is refused. */
// prettier-ignore
const RAW_SQL_REFERENCES = new Set([
  "raw", "unsafe", "queryObject", "queryArray", "executeQuery",
]);
const MANIFEST =
  /(?:^|\/)(?:import_map\.json|deno\.jsonc?|package(?:-lock)?\.json|\.npmrc)$/i;

/** Files that quote refused commands as test data, reviewed by path. */
const COMMAND_FIXTURES = new Set(["scripts/test/dev-signing-key.test.mjs"]);
const SELF = new Set([
  "scripts/production-scope.mjs",
  "scripts/production-scope-commands.mjs",
  "scripts/test/production-scope.test.mjs",
  "scripts/test/production-scope-functions.test.mjs",
]);

/** The only tracked lines that may name a seed file: local and CI tooling. */
const SEED_REFERENCES = Object.freeze([
  {
    file: "makefile",
    line: /^\tcp supabase\/seed\.sql \.supabase-e2e\/supabase\/seed\.sql$/,
  },
  {
    file: ".claude/scripts/e2e-smoke.sh",
    line: /^for f in seed\.sql signing[_]keys\.json; do$/,
  },
  {
    file: "supabase/schemaReproducibility.test.ts",
    line: /^\/\/ `seed\.sql` inserts into `loss_reasons`, a table that lives only in the$/,
  },
  {
    file: "supabase/schemaReproducibility.test.ts",
    line: /^const seed = readFileSync\(join\(HERE, "seed\.sql"\), "utf8"\);$/,
  },
]);
const SEED_FILE = /\bseed[^\s"'`;|&<>()\\]*\.sql\b/i;
const DEFAULT_SEED_PATHS = Object.freeze(["./seed.sql"]);

const PROSE = /\.mdx?$/i;
const CODE = /\.(?:m|c)?[jt]sx?$/i;
const MCP_OR_SQL_PARSER =
  /@modelcontextprotocol|%40modelcontextprotocol|\bMcpServer\b|\bmcp-lite\b|@hono\/mcp|pgsql-ast-parser|node-sql-parser/i;
const MCP_CONSUMER =
  /functions\/v1\/mcp\b|functions\.invoke\(\s*["'`]mcp["'`]/i;

// ---------------------------------------------------------------------------
// Edge functions
// ---------------------------------------------------------------------------

const DOT_SEGMENT = /(?:^|\/)\.{1,2}(?:\/|$)|%2e/i;

/** The identity of an external module specifier, or null when it has none this rule trusts. */
export function moduleIdentity(specifier) {
  const s = String(specifier).trim();
  if (DOT_SEGMENT.test(s.replace(/^[a-z]+:(?:\/\/[^/]*)?/i, ""))) return null;
  const node = s.match(/^node:([A-Za-z_]+)/);
  if (node) return `node:${node[1]}`;
  const pkg = s.match(/^(npm|jsr):(@[^/@]+\/[^/@]+|[^/@]+)/);
  if (pkg) return `${pkg[1]}:${pkg[2]}`;
  const url = s.match(/^(https?:\/\/[^/?#]+)([^?#]*)(\?[^#]*)?/i);
  if (!url) return null;
  // esm.sh can swap what a URL loads through its query.
  if (url[3] && /[?&](?:alias|deps|external)=/i.test(url[3])) return null;
  const kept = [];
  for (const segment of url[2].split("/").filter(Boolean)) {
    const at = segment.indexOf("@", 1);
    if (at !== -1) {
      kept.push(segment.slice(0, at));
      break;
    }
    kept.push(segment);
  }
  return `${url[1].toLowerCase()}/${kept.join("/")}`;
}

function resolveRelative(from, specifier, byPath) {
  const parts = from.split("/");
  parts.pop();
  for (const segment of specifier.split("/")) {
    if (segment === "..") {
      if (parts.length === 0) return { path: specifier, found: false };
      parts.pop();
    } else if (segment !== "." && segment !== "") parts.push(segment);
  }
  const base = parts.join("/");
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}/index.ts`,
  ]) {
    if (byPath.has(candidate)) return { path: candidate, found: true };
  }
  return { path: base, found: false };
}

function functionTreeViolations(files) {
  const violations = [];
  const trees = new Set();
  const directories = new Set();
  const reviewedMaps = new Set(PRODUCTION_FUNCTIONS.map(importMapPathOf));
  for (const { path } of files) {
    const at = path.search(/(?:^|\/)supabase\/functions\//);
    if (at === -1) continue;
    if (!path.startsWith(FUNCTIONS_ROOT)) {
      trees.add(
        path.slice(
          0,
          path.indexOf("supabase/functions/") + "supabase/functions".length,
        ),
      );
      continue;
    }
    if (MANIFEST.test(path) && !reviewedMaps.has(path)) {
      violations.push({
        rule: "function-import-map-unreadable",
        file: path,
        detail:
          "a module map or package manifest this rule does not read, so what it resolves cannot be reviewed. Only a reviewed function's own deno.json is read",
      });
    }
    const rest = path.slice(FUNCTIONS_ROOT.length);
    const slash = rest.indexOf("/");
    if (slash > 0) directories.add(rest.slice(0, slash));
  }
  for (const tree of trees) {
    violations.push({
      rule: "functions-tree-outside-canonical",
      file: tree,
      detail:
        "a second supabase/functions tree. A CLI run against another workdir deploys whatever it holds, so the only functions tree is the canonical one",
    });
  }
  for (const directory of directories) {
    if (
      directory !== SHARED_DIRECTORY &&
      !PRODUCTION_FUNCTIONS.includes(directory)
    ) {
      violations.push({
        rule: "function-not-allowlisted",
        file: `${FUNCTIONS_ROOT}${directory}`,
        detail:
          "an edge function outside PRODUCTION_FUNCTIONS. Every function under supabase/functions is deployable; adding one is a review event, and a generic SQL endpoint is not a candidate (ADR 0011)",
      });
    }
  }
  for (const name of PRODUCTION_FUNCTIONS) {
    if (!files.some((f) => f.path === entrypointOf(name))) {
      violations.push({
        rule: "allowlisted-function-missing",
        file: entrypointOf(name),
        detail:
          "PRODUCTION_FUNCTIONS names a function with no entrypoint, so the allowlist no longer describes what exists",
      });
    }
  }
  return violations;
}

/** A function's import map: exact bare keys in an `imports` object, and nothing else. */
function importMapOf(name, byPath, add) {
  const mapFile = importMapPathOf(name);
  if (!byPath.has(mapFile)) return {};
  const unreadable = (detail) =>
    add("function-import-map-unreadable", mapFile, undefined, detail);
  let parsed;
  try {
    parsed = JSON.parse(byPath.get(mapFile));
  } catch {
    unreadable(
      "an import map this rule cannot parse, so the modules it resolves cannot be reviewed",
    );
    return {};
  }
  const unread = Object.keys(parsed ?? {}).filter((key) => key !== "imports");
  if (unread.length > 0) {
    unreadable(
      `sets ${unread.join(", ")}, which this rule does not read, so what they resolve cannot be reviewed`,
    );
  }
  const imports = parsed?.imports ?? {};
  const pathKeys = Object.keys(imports).filter((key) =>
    /^(?:\.|\/)|\/$/.test(key),
  );
  if (pathKeys.length > 0) {
    unreadable(
      `maps ${pathKeys.join(", ")}, a path or prefix key this rule does not resolve`,
    );
  }
  return imports;
}

function relativeImportViolations({ path, specifier, line, target, add }) {
  if (!target.path.startsWith(FUNCTIONS_ROOT)) {
    add(
      "function-imports-outside-functions",
      path,
      line,
      `imports "${specifier}", outside supabase/functions: the deployed bundle would carry code no function rule inspects`,
    );
    return false;
  }
  if (!target.found) {
    add(
      "function-import-unresolved",
      path,
      line,
      `imports "${specifier}", which resolves to no tracked file`,
    );
    return false;
  }
  if (target.path === POSTGRES_POOL && !POSTGRES_POOL_CONSUMERS.has(path)) {
    add(
      "postgres-pool-consumer",
      path,
      line,
      "reaches the shared Postgres pool, whose session logs in as a BYPASSRLS role. Only merge_contacts is reviewed to use it",
    );
  }
  return true;
}

/** Walks each reviewed function's imports from its entrypoint. */
function bundleViolations(byPath) {
  const violations = [];
  const add = (rule, file, line, detail) =>
    violations.push({ rule, file, line, detail });

  for (const name of PRODUCTION_FUNCTIONS) {
    const entry = entrypointOf(name);
    if (!byPath.has(entry)) continue;
    const importMap = importMapOf(name, byPath, add);
    const queue = [entry];
    const reached = new Set(queue);
    while (queue.length > 0) {
      const path = queue.shift();
      const { imports, computed } = moduleLoads(
        parseSource(path, byPath.get(path)),
      );
      for (const line of computed) {
        add(
          "function-dynamic-import",
          path,
          line,
          "loads a module whose name is computed, or makes a loader, which no review can follow",
        );
      }
      for (const { specifier, line } of imports) {
        if (/^\.\.?\//.test(specifier)) {
          const target = resolveRelative(path, specifier, byPath);
          const walkable = relativeImportViolations({
            path,
            specifier,
            line,
            target,
            add,
          });
          if (walkable && !reached.has(target.path)) {
            reached.add(target.path);
            queue.push(target.path);
          }
          continue;
        }
        if (/^(?:\/|file:|[A-Za-z]:[\\/])/i.test(specifier)) {
          add(
            "function-imports-outside-functions",
            path,
            line,
            `imports "${specifier}" by absolute path`,
          );
          continue;
        }
        const identity = moduleIdentity(importMap[specifier] ?? specifier);
        const allowed = identity && REVIEWED_FUNCTION_DEPENDENCIES[identity];
        if (!allowed || !allowed.includes(path)) {
          add(
            "function-dependency-unreviewed",
            path,
            line,
            `loads "${specifier}" (${identity ?? "no trusted identity"}), which REVIEWED_FUNCTION_DEPENDENCIES does not allow in this file`,
          );
        }
      }
    }
  }
  return violations;
}

const isPoolDriverCall = (path, { method, argument }) =>
  path === POSTGRES_POOL &&
  (method === "queryObject" || method === "queryArray") &&
  argument.kind === "object" &&
  argument.properties.get("text") === POOL_DRIVER_TEXT &&
  !argument.properties.has("...");

function isReviewedSqlArgument(path, { method, argument }) {
  switch (argument.kind) {
    case "none":
    case "literal":
      return true;
    case "call":
      // executeQuery takes a compiled query; the raw call that built one is
      // checked on its own.
      return (
        method === "executeQuery" &&
        (argument.callee === "CompiledQuery.raw" ||
          argument.calleeMember === "compile")
      );
    case "template":
      return REVIEWED_SQL_INTERPOLATIONS.some(
        (entry) => entry.file === path && entry.source === argument.text,
      );
    default:
      return false;
  }
}

function functionSourceViolations(path, content) {
  if (!path.startsWith(FUNCTIONS_ROOT)) return [];
  const violations = [];
  content.split(/\r?\n/).forEach((text, i) => {
    if (MCP_OR_SQL_PARSER.test(text)) {
      violations.push({
        rule: "generic-sql-endpoint",
        file: path,
        line: i + 1,
        detail:
          "names a known MCP server or SQL parser. Agents get explicit, allowlisted operations, never SQL (ADR 0011)",
      });
    }
  });
  if (!CODE.test(path)) return violations;
  let driverCalls = 0;
  const calls = methodCalls(parseSource(path, content), RAW_SQL_METHODS, {
    references: RAW_SQL_REFERENCES,
  });
  for (const call of calls) {
    if (isPoolDriverCall(path, call) && driverCalls++ === 0) continue;
    if (isReviewedSqlArgument(path, call)) continue;
    violations.push({
      rule: "raw-sql-non-literal",
      file: path,
      line: call.line,
      detail:
        call.argument.kind === "reference"
          ? `holds \`${call.method}\` without calling it, so what it will be handed cannot be read`
          : `hands \`.${call.method}()\` something other than a literal SQL string, a reviewed interpolation or a compiled query, which is how caller-supplied SQL reaches the database`,
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Configuration and references
// ---------------------------------------------------------------------------

const TOML_HEADER = /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/;
const TOML_KEY =
  /^\s*((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=\s*(.*)$/;
const tomlPath = (spec) =>
  [...spec.matchAll(/[A-Za-z0-9_-]+|"[^"]*"|'[^']*'/g)].map((m) =>
    m[0].replace(/^["']|["']$/g, ""),
  );
const tomlStrings = (value) =>
  [...value.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
const withoutComment = (text) => text.replace(/\s#[^"']*$/, "");
const CANONICAL_FUNCTION_PATHS = {
  entrypoint: (name) => `functions/${name}/index.ts`,
  import_map: (name) => `functions/${name}/deno.json`,
};

function tableViolation(section) {
  const at = section.indexOf("functions");
  if (at === -1) return null;
  const name = section[at + 1];
  if (at > 0) {
    return `configures functions under [${section.join(".")}], which this rule does not read`;
  }
  if (name === undefined) {
    return "configures functions by inline keys this rule does not read";
  }
  return PRODUCTION_FUNCTIONS.includes(name)
    ? null
    : `configures function "${name}", which is not in PRODUCTION_FUNCTIONS`;
}

function functionPathViolation(full, section, value) {
  const at = full.indexOf("functions");
  const name = full[at + 1];
  if (
    at + 1 >= section.length &&
    (at > 0 || !PRODUCTION_FUNCTIONS.includes(name))
  ) {
    return {
      rule: "function-config-not-allowlisted",
      detail: `configures ${full.slice(0, at + 2).join(".")} by a key this rule does not accept`,
    };
  }
  const leaf = full[at + 2];
  if (
    full.length !== at + 3 ||
    !["entrypoint", "import_map", "static_files"].includes(leaf)
  ) {
    return null;
  }
  const values = tomlStrings(value).map((v) => v.replace(/^\.\//, ""));
  const canonical = CANONICAL_FUNCTION_PATHS[leaf]?.(name);
  const home = `functions/${name}/`;
  const outside = canonical
    ? values.length !== 1 || values[0] !== canonical
    : values.length === 0 ||
      values.some((v) => v.includes("..") || !v.startsWith(home));
  if (!outside) return null;
  return {
    rule: "function-config-path-not-canonical",
    detail: canonical
      ? `sets function "${name}" ${leaf} to something other than ./${canonical}, the path every function rule reads`
      : `points function "${name}" at files outside ${home}`,
  };
}

/** The seed rule for one key: a violation detail, null when in scope, undefined when not a seed key. */
function seedViolation(full, value) {
  const key = full.join(".");
  if (full[0] === "remotes" && /\.db\.seed(?:\.|$)/.test(key)) {
    return "configures seeding for a remote project, which the development seed must never reach";
  }
  let paths;
  if (/(?:^|\.)db\.seed\.sql_paths$/.test(key)) paths = tomlStrings(value);
  else if (/(?:^|\.)db\.seed$/.test(key) && /^\s*\{/.test(value)) {
    const inline = value.match(/sql_paths\s*=\s*(\[[^\]]*\])/);
    if (!inline) return null;
    paths = tomlStrings(inline[1]);
  } else return undefined;
  const isDefault =
    paths.length === DEFAULT_SEED_PATHS.length &&
    paths.every((p, k) => p === DEFAULT_SEED_PATHS[k]);
  return isDefault
    ? null
    : "changes the seed files a reset applies, which no reference rule can then follow";
}

function configViolations(path, content) {
  const violations = [];
  const add = (rule, line, detail) =>
    violations.push({ rule, file: path, line, detail });
  const lines = content.split(/\r?\n/);
  let section = [];
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    const header = lines[i].match(TOML_HEADER);
    if (header) {
      section = tomlPath(header[1]);
      const detail = tableViolation(section);
      if (detail) add("function-config-not-allowlisted", line, detail);
      const seed = seedViolation(section, "");
      if (seed && section[0] === "remotes") {
        add("seed-file-reference", line, seed);
      }
      continue;
    }
    const key = lines[i].match(TOML_KEY);
    if (!key) continue;
    let value = withoutComment(key[2]);
    // A multi-line array continues to its closing bracket.
    while (
      /^\s*\[/.test(value) &&
      !value.includes("]") &&
      i + 1 < lines.length
    ) {
      value += ` ${withoutComment(lines[++i])}`;
    }
    const full = [...section, ...tomlPath(key[1])];
    const seed = seedViolation(full, value);
    if (seed !== undefined) {
      if (seed) add("seed-file-reference", line, seed);
      continue;
    }
    if (!full.includes("functions")) continue;
    const found = functionPathViolation(full, section, value);
    if (found) add(found.rule, line, found.detail);
  }
  return violations;
}

function referenceViolations(path, content, { fixture }) {
  const violations = [];
  content.split(/\r?\n/).forEach((text, i) => {
    if (MCP_CONSUMER.test(text)) {
      violations.push({
        rule: "mcp-consumer",
        file: path,
        line: i + 1,
        detail:
          "points at the removed MCP SQL endpoint. No UI, worker or agent may depend on it",
      });
    }
    if (
      !fixture &&
      SEED_FILE.test(text) &&
      !SEED_REFERENCES.some((ref) => ref.file === path && ref.line.test(text))
    ) {
      violations.push({
        rule: "seed-file-reference",
        file: path,
        line: i + 1,
        detail:
          "names a seed SQL file outside the reviewed local uses (SEED_REFERENCES). A path that can read it can push it somewhere remote",
      });
    }
  });
  return violations;
}

/**
 * @param {Array<{path: string, content: string}>} files  tracked files, POSIX paths
 */
export function checkProductionScope(files) {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const violations = [
    ...functionTreeViolations(files),
    ...bundleViolations(byPath),
  ];
  for (const { path, content } of files) {
    if (SELF.has(path) || PROSE.test(path)) continue;
    const fixture = COMMAND_FIXTURES.has(path);
    violations.push(...functionSourceViolations(path, content));
    if (/\.toml$/i.test(path)) {
      violations.push(...configViolations(path, content));
    }
    violations.push(...referenceViolations(path, content, { fixture }));
    if (!fixture) {
      violations.push(
        ...commandViolations(path, content, {
          functions: PRODUCTION_FUNCTIONS,
        }),
        ...scopeCheckViolations(path, content),
      );
    }
  }
  const seen = new Set();
  return violations.filter((v) => {
    const key = `${v.rule} ${v.file}:${v.line ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const isEntryPoint = () =>
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint()) {
  let violations;
  try {
    violations = checkProductionScope(readTrackedFiles());
  } catch (error) {
    console.error(`production scope could not be checked: ${error.message}`);
    process.exit(2);
  }
  for (const v of violations) {
    console.error(
      `[${v.rule}] ${v.file}${v.line ? `:${v.line}` : ""}: ${v.detail}`,
    );
  }
  if (violations.length > 0) {
    console.error(
      `\n${violations.length} way(s) a deployment could leave production scope (SI-03, SI-25).`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `OK: production scope holds: ${PRODUCTION_FUNCTIONS.length} reviewed functions, reviewed dependencies only, no generic SQL endpoint, no development seed on a remote path\n`,
  );
}
