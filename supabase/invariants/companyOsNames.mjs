// How the Company OS rules read a name on the operator surface (Phase 2C,
// ADR 0019): a routine reference in its one canonical form, and whether a
// statement names the schema, the capability role, a gate or a dynamic
// placeholder. Shared by every companyOs*.mjs rule module; companyOsApi.mjs
// re-exports DYNAMIC and normalizeRoutineRef.

import { readParens, splitAtDepth } from "./parse.mjs";

export const DYNAMIC = "x_dynamic";

const TYPE_ALIASES = new Map([
  ["int", "integer"],
  ["int4", "integer"],
  ["int8", "bigint"],
  ["bool", "boolean"],
  ["varchar", "character varying"],
  ["timestamptz", "timestamp with time zone"],
]);

/**
 * `schema.name(arg, …)` in one canonical form: lowercase, no `pg_catalog.`,
 * no argument names (the `p_` convention), modes or defaults, aliases folded,
 * no spaces. Anything that does not parse returns null (the caller fails
 * closed).
 */
export function normalizeRoutineRef(text) {
  const clean = text.trim().replace(/;$/, "").trim();
  const open = clean.indexOf("(");
  if (open === -1) return null;
  const name = clean.slice(0, open).trim().replace(/\s+/g, "");
  if (!/^[a-z0-9_$]+\.[a-z0-9_$]+$/.test(name)) return null;
  const group = readParens(clean, open);
  if (!group || clean.slice(group.end).trim().length) return null;
  const args = [];
  for (const raw of splitAtDepth(group.inner, ",")) {
    let arg = raw.replace(/\s+default\s+.*$/, "").replace(/\s*=\s*.*$/, "");
    arg = arg.replace(/^(in|out|inout|variadic)\s+/, "");
    const tokens = arg.split(/\s+/).filter(Boolean);
    if (tokens.length > 1 && /^p_[a-z0-9_]+$/.test(tokens[0])) tokens.shift();
    const type = tokens.join(" ").replace(/\bpg_catalog\./g, "");
    if (!type.length) return null;
    args.push(TYPE_ALIASES.get(type) ?? type);
  }
  return `${name}(${args.join(",")})`;
}

/** The text names the schema, the capability role or a dynamic name. */
export const mentionsSurface = (text, cfg) =>
  new RegExp(`\\b(${cfg.schema}|${cfg.role}|${DYNAMIC})\\b`).test(text);

/** The text names a gate (`ops.gate_…`). */
export const namesGate = (text) => /\bops\.gate_[a-z0-9_]+/.test(text);
