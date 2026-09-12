// Statement shapes, read off the MASKED text from sqlStatements.mjs.
//
// Every parser returns one of three things:
//   - null                     not this shape
//   - { unclassifiable: true } IS this shape but does not match it, which the
//                              caller turns into a FINDING
//   - a parsed descriptor
//
// The middle case is the discipline: a `grant` that does not decompose, a view
// whose reloptions cannot be read, an unrecognised boolean spelling — none are
// assumed safe.

/** Roles that already hold a full RLS bypass, so a grant to them changes
 *  nothing. Stated rather than left implicit: `service_role` and `postgres`
 *  both carry BYPASSRLS on Supabase and the edge functions run as
 *  `service_role` (PHASE_0_5_REPORT §16.7, ACCEPTED RISK). */
export const BYPASS_ROLES = new Set([
  "postgres",
  "service_role",
  "supabase_admin",
  "supabase_auth_admin",
  "supabase_storage_admin",
  "supabase_functions_admin",
  "supabase_read_only_user",
  "dashboard_user",
  "authenticator",
  "pgbouncer",
]);

/** Privileges `authenticated` may hold. TRUNCATE is absent deliberately: RLS
 *  does not gate it, so a TRUNCATE grant empties an RLS-protected table —
 *  measured, `truncate public.lead_profiles` as anon took it from 2 rows to 0
 *  with every SELECT policy in force. TRIGGER attaches code to a table you do
 *  not own; REFERENCES probes rows through a foreign key; `all` includes all
 *  three, which is why it must be enumerated. */
export const AUTHENTICATED_PRIVILEGES = new Set([
  "select",
  "insert",
  "update",
  "delete",
  "usage",
  "execute",
]);

/** PostgreSQL's boolean reloption spellings. Anything else is UNKNOWN, which
 *  fails: `= no` must not read as "probably off", and `= false` must not slip
 *  past a rule that only knows the word `off`. */
const TRUE_WORDS = new Set(["on", "true", "t", "yes", "y", "1"]);
const FALSE_WORDS = new Set(["off", "false", "f", "no", "n", "0"]);

export const UNKNOWN = "unknown";
export const MATVIEW = "materialized";

// --- text helpers ----------------------------------------------------------

/** Index of `needle` at parenthesis depth 0, or -1. */
export function indexAtDepth(text, needle, from = 0) {
  let depth = 0;
  for (let i = from; i <= text.length - needle.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && text.startsWith(needle, i)) return i;
  }
  return -1;
}

/** Split on `sep` at depth 0, trimmed, empties dropped. */
export function splitAtDepth(text, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && text.startsWith(sep, i)) {
      parts.push(text.slice(start, i));
      i += sep.length - 1;
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Consume a balanced group at `text[pos] === "("`. Null if it never closes. */
export function readParens(text, pos) {
  if (text[pos] !== "(") return null;
  let depth = 0;
  for (let i = pos; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return { inner: text.slice(pos + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Qualify a possibly-unqualified relation name. Migrations spell these both
 *  ways (`create view init_state` and `create view "public"."init_state"`), and
 *  an unqualified name resolves to `public` under the migration search_path. */
export function qualify(name) {
  const clean = name.replace(/;$/, "").trim();
  if (!clean.length) return null;
  const parts = clean.split(".");
  if (parts.length === 1) return { schema: "public", name: parts[0] };
  if (parts.length === 2) return { schema: parts[0], name: parts[1] };
  return null;
}

export const relKey = (rel) => `${rel.schema}.${rel.name}`;

export function readName(text, pos) {
  const m = /^[a-z0-9_$.]+/.exec(text.slice(pos));
  return m ? { raw: m[0], end: pos + m[0].length } : null;
}

export function skipWs(text, pos) {
  while (pos < text.length && /\s/.test(text[pos])) pos++;
  return pos;
}

/** `security_invoker` from a reloptions body: true / false / UNKNOWN, or null
 *  when the option is not mentioned at all. */
export function invokerFromReloptions(inner) {
  for (const opt of splitAtDepth(inner, ",")) {
    const eq = opt.indexOf("=");
    const key = (eq === -1 ? opt : opt.slice(0, eq)).trim();
    if (key !== "security_invoker") continue;
    if (eq === -1) return true; // a bare reloption name means true
    const value = opt
      .slice(eq + 1)
      .trim()
      .replace(/^'|'$/g, "");
    if (TRUE_WORDS.has(value)) return true;
    if (FALSE_WORDS.has(value)) return false;
    return UNKNOWN;
  }
  return null;
}

// --- statement shapes ------------------------------------------------------

const CREATE_VIEW_RE =
  /^create\s+(or\s+replace\s+)?(recursive\s+)?(materialized\s+)?view\s+(if\s+not\s+exists\s+)?/;

/** `create [or replace] [recursive] [materialized] view <name> [(cols)]
 *  [with (opts)] as …` */
export function parseCreateView(masked) {
  const m = CREATE_VIEW_RE.exec(masked);
  if (!m) return null;
  const materialized = Boolean(m[3]);
  let pos = m[0].length;
  const nameToken = readName(masked, pos);
  if (!nameToken) return { unclassifiable: true };
  const rel = qualify(nameToken.raw);
  if (!rel) return { unclassifiable: true };
  pos = skipWs(masked, nameToken.end);

  let invoker = null;
  let sawColumnList = false;
  for (;;) {
    if (pos >= masked.length) return { unclassifiable: true, rel };
    if (masked[pos] === "(" && !sawColumnList) {
      const group = readParens(masked, pos);
      if (!group) return { unclassifiable: true, rel };
      sawColumnList = true;
      pos = skipWs(masked, group.end);
      continue;
    }
    if (/^with\b/.test(masked.slice(pos))) {
      pos = skipWs(masked, pos + 4);
      const group = readParens(masked, pos);
      if (!group) return { unclassifiable: true, rel };
      invoker = invokerFromReloptions(group.inner);
      pos = skipWs(masked, group.end);
      continue;
    }
    if (/^as\b/.test(masked.slice(pos))) break;
    return { unclassifiable: true, rel };
  }

  return {
    kind: "create-view",
    rel,
    materialized,
    // No with-clause, or one silent on security_invoker, both mean the view
    // executes as its OWNER. That ABSENCE is the defect that shipped, and it is
    // why a blocklist of dangerous patterns could never catch it: there is no
    // dangerous token to match.
    invoker: invoker === null ? false : invoker,
  };
}

const ALTER_REL_RE =
  /^alter\s+(materialized\s+view|view|table)\s+(if\s+exists\s+)?(only\s+)?/;

/** `alter view|table|materialized view <name> <action>` */
export function parseAlterRelation(masked) {
  const m = ALTER_REL_RE.exec(masked);
  if (!m) return null;
  const isTable = m[1] === "table";
  const nameToken = readName(masked, m[0].length);
  if (!nameToken) return { unclassifiable: true, isTable };
  const rel = qualify(nameToken.raw);
  if (!rel) return { unclassifiable: true, isTable };
  const rest = masked.slice(skipWs(masked, nameToken.end));

  if (
    /^(disable\s+row\s+level\s+security|no\s+force\s+row\s+level\s+security)\b/.test(
      rest,
    )
  ) {
    return { kind: "rls-weakened", rel, isTable };
  }
  if (/^(enable|force)\s+row\s+level\s+security\b/.test(rest)) {
    return { kind: "rls-enabled", rel, isTable };
  }
  if (/^rename\s+to\b/.test(rest)) {
    // `rename to` ONLY. `alter view … rename column` is real, at
    // 20260115150819_snake_case_renaming.sql:2, and misreading it as a relation
    // rename reports both "undeclared view" and "declared view no longer
    // exists" for the same object.
    const target = readName(rest, skipWs(rest, "rename to".length));
    const to = target ? qualify(target.raw) : null;
    if (!to) return { unclassifiable: true, rel, isTable };
    return {
      kind: "rename",
      rel,
      to: { schema: rel.schema, name: to.name },
      isTable,
    };
  }
  if (/^set\b/.test(rest)) {
    const open = rest.indexOf("(");
    if (open !== -1) {
      const group = readParens(rest, open);
      if (group) {
        const invoker = invokerFromReloptions(group.inner);
        if (invoker !== null) {
          return { kind: "set-invoker", rel, invoker, isTable };
        }
      }
    }
    return { kind: "ignored", rel, isTable };
  }
  if (/^reset\b/.test(rest)) {
    const open = rest.indexOf("(");
    if (open !== -1) {
      const group = readParens(rest, open);
      if (group && /\bsecurity_invoker\b/.test(group.inner)) {
        // RESET drops the option, so the view falls back to owner execution.
        return { kind: "set-invoker", rel, invoker: false, isTable };
      }
    }
    return { kind: "ignored", rel, isTable };
  }
  // `rename column`, `owner to`, `add column`, constraints. OWNERSHIP is not
  // modelled: a view that is security_invoker but whose owner changes, or a
  // table owner (who bypasses RLS unless FORCE ROW LEVEL SECURITY is set), is
  // outside this model. Stated as a known gap, not silently assumed away.
  return { kind: "ignored", rel, isTable };
}

/** `drop [materialized] view [if exists] a, b [cascade]` */
export function parseDropView(masked) {
  const m = /^drop\s+(materialized\s+)?view\s+(if\s+exists\s+)?/.exec(masked);
  if (!m) return null;
  const list = masked
    .slice(m[0].length)
    .replace(/\s+(cascade|restrict)\s*$/, "")
    .trim();
  const rels = splitAtDepth(list, ",").map(qualify);
  if (!rels.length || rels.some((r) => r === null)) {
    return { unclassifiable: true };
  }
  return { kind: "drop-view", rels };
}

/** `create extension [if not exists] <name> [with] [schema <s>] …` */
export function parseCreateExtension(masked) {
  const m = /^create\s+extension\s+(if\s+not\s+exists\s+)?/.exec(masked);
  if (!m) return null;
  const nameToken = readName(masked, m[0].length);
  if (!nameToken) return { unclassifiable: true };
  const schemaMatch = /\bschema\s+([a-z0-9_$]+)/.exec(
    masked.slice(nameToken.end),
  );
  return {
    kind: "create-extension",
    name: nameToken.raw,
    // No explicit schema means the first schema on the search_path, which for a
    // migration is `public`. Reachability is a property of the SCHEMA, not the
    // name: `extensions` is owned by postgres and can be closed with REVOKE
    // USAGE, which is why `http` could be contained and `pg_net` could not.
    schema: schemaMatch ? schemaMatch[1] : "public",
  };
}

/** `drop extension [if exists] a, b [cascade]` */
export function parseDropExtension(masked) {
  const m = /^drop\s+extension\s+(if\s+exists\s+)?/.exec(masked);
  if (!m) return null;
  const list = masked
    .slice(m[0].length)
    .replace(/\s+(cascade|restrict)\s*$/, "")
    .trim();
  const names = splitAtDepth(list, ",").map((n) => n.replace(/;$/, "").trim());
  if (!names.length) return { unclassifiable: true };
  return { kind: "drop-extension", names };
}

const OBJECT_TYPE_PREFIX =
  /^(table|sequence|function|routine|procedure|schema|database|domain|type|language|tablespace|large\s+object|foreign\s+data\s+wrapper|foreign\s+server)\s+(?!all\b)/;

/**
 * `grant <privs> on <object> to <roles> [with grant option]`
 *
 * Anything that does not decompose into exactly those three parts is
 * unclassifiable — column-level grants and WITH GRANT OPTION included.
 */
export function parseGrant(masked) {
  if (!/^grant\b/.test(masked)) return null;
  if (/\bwith\s+grant\s+option\b/.test(masked)) {
    return { unclassifiable: true, reason: "WITH GRANT OPTION" };
  }
  const onAt = indexAtDepth(masked, " on ", "grant".length);
  if (onAt === -1) {
    return { unclassifiable: true, reason: "no ON clause (role membership?)" };
  }
  const toAt = indexAtDepth(masked, " to ", onAt + 4);
  if (toAt === -1) return { unclassifiable: true, reason: "no TO clause" };

  const privText = masked.slice("grant".length, onAt).trim();
  const objectText = masked.slice(onAt + 4, toAt).trim();
  const roleText = masked
    .slice(toAt + 4)
    .replace(/;$/, "")
    .trim();

  if (privText.includes("(")) {
    return { unclassifiable: true, reason: "column-level grant" };
  }
  const privileges = splitAtDepth(privText, ",").map((p) =>
    p.replace(/\s+privileges$/, "").trim(),
  );
  const roles = splitAtDepth(roleText, ",").map((r) =>
    r.replace(/^group\s+/, "").trim(),
  );
  if (!privileges.length || !roles.length || !objectText.length) {
    return {
      unclassifiable: true,
      reason: "empty privilege, object or role list",
    };
  }
  // `on table public.x` and `on public.x` name the same object; folding the
  // optional object-type keyword keeps an override id stable whichever spelling
  // was used. `on all tables in schema x` is left intact.
  return {
    kind: "grant",
    privileges,
    object: objectText.replace(OBJECT_TYPE_PREFIX, ""),
    roles,
  };
}
