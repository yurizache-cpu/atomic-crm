// Shared fixtures for the production-scope tests: a minimal tree that is in
// scope, a reader for real files, and a mutation helper that first proves the
// unmutated real file is in scope, so every attack runs against what ships.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import {
  PRODUCTION_FUNCTIONS,
  checkProductionScope,
} from "../production-scope.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** A tracked file's content, with LF line endings. */
export const read = (path) =>
  readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");

/** Every reviewed function, as a bare entrypoint. */
export const TREE = PRODUCTION_FUNCTIONS.map((name) => ({
  path: `supabase/functions/${name}/index.ts`,
  content:
    'import "jsr:@supabase/functions-js/edge-runtime.d.ts";\nDeno.serve(() => new Response(null));\n',
}));

const withTree = (files) => {
  const replaced = new Set(files.map((f) => f.path));
  return [...TREE.filter((f) => !replaced.has(f.path)), ...files];
};

/** `rule file:line` for each violation the files add to TREE. */
export const found = (...files) =>
  checkProductionScope(withTree(files)).map(
    (v) => `${v.rule} ${v.file}${v.line ? `:${v.line}` : ""}`,
  );

/** The distinct rules the files add to TREE. */
export const rulesOf = (...files) => [
  ...new Set(checkProductionScope(withTree(files)).map((v) => v.rule)),
];

/** Mutates a real file, after proving the unmutated file is in scope. */
export const mutate = (path, from, to) => {
  const real = read(path);
  expect(found({ path, content: real })).toEqual([]);
  expect(real).toContain(from);
  return { path, content: real.replace(from, to) };
};

export const CONFIG = "supabase/config.toml";
export const USERS = "supabase/functions/users/index.ts";
export const MERGE = "supabase/functions/merge_contacts/index.ts";
export const POOL = "supabase/functions/_shared/db.ts";
