// Fail-closed SQL tokenizer and statement classifier.
//
// Deliberately NOT a SQL parser. `pgsql-ast-parser@12`, a devDependency until
// 2026-09-13 (it backed the SQL validator of the MCP function removed that day),
// was measured against this corpus first:
//
//   create or replace view public.x with (security_invoker = on) as select 1;
//     -> THROWS (syntax error at `with`)
//   create or replace view "public"."contacts_summary" as select 1;
//     -> parses
//
// It throws on the SAFE form and accepts the UNSAFE one, and throws outright on
// `grant`, `revoke`, `alter default privileges` and `create policy`. A parser
// that cannot represent `security_invoker` cannot enforce it. Whole-file parse
// succeeds on 4 of the 29 migrations.
//
// So: a character scanner that understands quoting, plus a CLOSED list of
// statement heads. Anything the scanner cannot terminate, and any head not on
// the list, raises InvariantError. Ambiguity fails; it never passes.

/** Raised when the corpus cannot be read with certainty. Never caught. */
export class InvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvariantError";
  }
}

/**
 * @typedef {object} Statement
 * @property {string} file
 * @property {number} line     1-based line of the statement's first real SQL.
 * @property {string} raw
 * @property {string} masked   Comments dropped, literals blanked, dollar bodies
 *                             replaced by `$body<N>$`, identifier quotes
 *                             stripped, whitespace collapsed, lowercased.
 * @property {string[]} bodies Raw dollar-quoted bodies, in order.
 */

/**
 * Walk `text` once, emitting every structural region. The single source of
 * truth for quoting, shared by the splitter, the masker and the comment
 * stripper — three consumers that MUST agree, or a `grant` hidden in a comment
 * becomes a finding while a real one does not.
 *
 * @param {string} text
 * @param {string} where
 * @param {(kind: string, start: number, end: number, line: number) => void} emit
 *   kind: "code" (one char), "line-comment", "block-comment", "string",
 *   "ident", "dollar".
 */
function walk(text, where, emit) {
  const n = text.length;
  let i = 0;
  let line = 1;

  while (i < n) {
    const c = text[i];

    if (c === "-" && text[i + 1] === "-") {
      const start = i;
      while (i < n && text[i] !== "\n") i++;
      emit("line-comment", start, i, line);
      continue;
    }

    if (c === "/" && text[i + 1] === "*") {
      const start = i;
      const startLine = line;
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth++;
          i += 2;
          continue;
        }
        if (text[i] === "*" && text[i + 1] === "/") {
          depth--;
          i += 2;
          continue;
        }
        if (text[i] === "\n") line++;
        i++;
      }
      if (depth > 0) {
        throw new InvariantError(
          `${where}:${startLine} unterminated block comment. The tokenizer cannot read this file, so nothing in it can be classified.`,
        );
      }
      emit("block-comment", start, i, startLine);
      continue;
    }

    if (c === "'") {
      const start = i;
      const startLine = line;
      i++;
      for (;;) {
        if (i >= n) {
          throw new InvariantError(
            `${where}:${startLine} unterminated string literal. The tokenizer cannot read this file, so nothing in it can be classified.`,
          );
        }
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        // A backslash escapes the next character inside an E-string. Honouring
        // it unconditionally can only make the scan more conservative.
        if (text[i] === "\\" && i + 1 < n) {
          if (text[i + 1] === "\n") line++;
          i += 2;
          continue;
        }
        if (text[i] === "\n") line++;
        i++;
      }
      emit("string", start, i, startLine);
      continue;
    }

    if (c === '"') {
      const start = i;
      const startLine = line;
      i++;
      for (;;) {
        if (i >= n) {
          throw new InvariantError(
            `${where}:${startLine} unterminated quoted identifier. The tokenizer cannot read this file, so nothing in it can be classified.`,
          );
        }
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (text[i] === "\n") line++;
        i++;
      }
      emit("ident", start, i, startLine);
      continue;
    }

    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (m) {
        const tag = m[0];
        const startLine = line;
        const close = text.indexOf(tag, i + tag.length);
        if (close === -1) {
          throw new InvariantError(
            `${where}:${startLine} unterminated dollar-quoted string ${tag}. The tokenizer cannot read this file, so nothing in it can be classified.`,
          );
        }
        const end = close + tag.length;
        for (let k = i; k < end; k++) if (text[k] === "\n") line++;
        emit("dollar", i, end, startLine);
        i = end;
        continue;
      }
    }

    emit("code", i, i + 1, line);
    if (c === "\n") line++;
    i++;
  }
}

/**
 * Mask one statement: drop comments, blank literal CONTENTS, replace
 * dollar-quoted bodies with an opaque marker, strip identifier quotes, collapse
 * whitespace, lowercase.
 *
 * Blanking is what keeps `select 'pg_net is gone';` clean while
 * `create extension pg_net;` is not. Identifier case is folded, so two
 * relations differing only by case collide — which FAILS the declared-set
 * check rather than passing it.
 *
 * `preserveStrings` keeps literal contents, for exactly one caller: resolving
 * an `EXECUTE '<sql>'` argument inside a DO block, impossible once blanked.
 *
 * @param {string} raw
 * @param {string} where
 * @param {{ preserveStrings?: boolean }} [options]
 * @returns {{ masked: string, bodies: string[] }}
 */
export function maskStatement(raw, where = "<inline>", options = {}) {
  const preserveStrings = options.preserveStrings === true;
  let out = "";
  const bodies = [];
  walk(raw, where, (kind, start, end) => {
    const slice = raw.slice(start, end);
    switch (kind) {
      case "line-comment":
      case "block-comment":
        out += " ";
        break;
      case "string":
        out += preserveStrings ? slice : "''";
        break;
      case "ident":
        out += slice.slice(1, -1).replace(/""/g, '"');
        break;
      case "dollar":
        bodies.push(slice);
        out += ` $body${bodies.length - 1}$ `;
        break;
      default:
        out += slice;
    }
  });
  return { masked: out.replace(/\s+/g, " ").trim().toLowerCase(), bodies };
}

/**
 * Remove comments while PRESERVING literals, then lowercase. Used for
 * catalogue-predicate matching inside DO blocks: matching a predicate against
 * RAW text would match it in a comment, and `20260911235500_drop_pg_net.sql:35`
 * contains the words `drop extension pg_net` inside a `--` comment.
 *
 * @param {string} text
 * @param {string} where
 * @returns {string}
 */
export function stripSqlComments(text, where = "<inline>") {
  let out = "";
  walk(text, where, (kind, start, end) => {
    if (kind === "line-comment" || kind === "block-comment") {
      out += " ";
      return;
    }
    out += text.slice(start, end);
  });
  return out.toLowerCase();
}

/**
 * Split SQL into top-level statements. Semicolons inside comments, strings,
 * quoted identifiers and dollar-quoted bodies do not split.
 *
 * `strictTail` (default) refuses non-comment text after the final semicolon: an
 * unterminated statement means the split is a guess. It is off for one caller
 * only — a DO block body, which legitimately ends `... end` with no semicolon.
 *
 * @param {string} sql
 * @param {string} file
 * @param {{ strictTail?: boolean, preserveStrings?: boolean }} [options]
 * @returns {Statement[]}
 */
export function splitStatements(sql, file, options = {}) {
  const strictTail = options.strictTail !== false;
  /** @type {Statement[]} */
  const statements = [];
  const cuts = [];
  walk(sql, file, (kind, start, end, line) => {
    if (kind === "code" && sql[start] === ";") cuts.push({ start, end, line });
  });

  let from = 0;
  const emitRange = (start, end) => {
    const raw = sql.slice(start, end);
    const { masked, bodies } = maskStatement(raw, file, options);
    if (!masked.length) return;
    // Line of the first character of actual SQL. Leading comments are skipped
    // deliberately: an override marker must sit ABOVE the offending statement,
    // and a line pointing at the statement's own comment block would make that
    // window meaningless.
    let offset = 0;
    walk(raw, file, (kind, at) => {
      if (offset !== 0) return;
      if (kind === "line-comment" || kind === "block-comment") return;
      if (kind === "code" && /\s/.test(raw[at])) return;
      offset = at;
    });
    const line = 1 + (sql.slice(0, start + offset).match(/\n/g) || []).length;
    statements.push({ file, line, raw, masked, bodies });
  };

  for (const cut of cuts) {
    emitRange(from, cut.start);
    from = cut.end;
  }

  const { masked: tailMasked } = maskStatement(sql.slice(from), file, options);
  if (tailMasked.length && !strictTail) {
    emitRange(from, sql.length);
  } else if (tailMasked.length) {
    throw new InvariantError(
      `${file}: text after the last semicolon that is not a comment: ${JSON.stringify(
        tailMasked.slice(0, 120),
      )}. Every statement must be terminated, or the split is a guess.`,
    );
  }

  return statements;
}

/**
 * The CLOSED classification list. Order matters: the first match wins, so
 * longer heads precede the prefixes they extend.
 *
 * `security: true` routes the statement through the hazard rules and the
 * replay; `false` means inert for the declared domains (views, extensions,
 * grants, RLS, storage). Promoting a head is a one-line reviewable diff.
 * Leaving one OFF the list is what makes an unanticipated statement —
 * `create publication`, `create foreign table`, `security label`, a verb a
 * future PostgreSQL adds — fail on sight with nobody having written a rule.
 */
export const HEADS = [
  {
    head: "alter default privileges",
    re: /^alter\s+default\s+privileges\b/,
    security: true,
  },
  { head: "alter extension", re: /^alter\s+extension\b/, security: true },
  {
    head: "alter materialized view",
    re: /^alter\s+materialized\s+view\b/,
    security: true,
  },
  { head: "alter view", re: /^alter\s+view\b/, security: true },
  { head: "alter table", re: /^alter\s+table\b/, security: true },
  { head: "alter function", re: /^alter\s+function\b/, security: false },
  { head: "alter sequence", re: /^alter\s+sequence\b/, security: false },
  { head: "alter type", re: /^alter\s+type\b/, security: false },
  { head: "alter index", re: /^alter\s+index\b/, security: false },
  { head: "comment on", re: /^comment\s+on\b/, security: false },
  { head: "create extension", re: /^create\s+extension\b/, security: true },
  {
    head: "create materialized view",
    re: /^create\s+(or\s+replace\s+)?materialized\s+view\b/,
    security: true,
  },
  {
    head: "create view",
    re: /^create\s+(or\s+replace\s+)?(recursive\s+)?view\b/,
    security: true,
  },
  {
    head: "create function",
    re: /^create\s+(or\s+replace\s+)?function\b/,
    security: false,
  },
  {
    head: "create index",
    re: /^create\s+(unique\s+)?index\b/,
    security: false,
  },
  { head: "create policy", re: /^create\s+policy\b/, security: false },
  { head: "create schema", re: /^create\s+schema\b/, security: false },
  { head: "create sequence", re: /^create\s+sequence\b/, security: false },
  // Security-relevant: a new table with no RLS is a relation an application
  // role can read with no policy applied.
  { head: "create table", re: /^create\s+table\b/, security: true },
  // Security-relevant since Phase 1C: ops invariants live in triggers. Creating
  // one is what credits a drop; dropping one, or CASCADE-dropping a function,
  // table, schema, type or sequence it depends on, removes the invariant.
  {
    head: "create trigger",
    re: /^create\s+(or\s+replace\s+)?trigger\b/,
    security: true,
  },
  { head: "create type", re: /^create\s+type\b/, security: false },
  { head: "do", re: /^do\b/, security: true },
  { head: "drop extension", re: /^drop\s+extension\b/, security: true },
  {
    head: "drop materialized view",
    re: /^drop\s+materialized\s+view\b/,
    security: true,
  },
  { head: "drop view", re: /^drop\s+view\b/, security: true },
  { head: "drop function", re: /^drop\s+function\b/, security: true },
  { head: "drop index", re: /^drop\s+index\b/, security: false },
  { head: "drop policy", re: /^drop\s+policy\b/, security: false },
  { head: "drop schema", re: /^drop\s+schema\b/, security: true },
  { head: "drop sequence", re: /^drop\s+sequence\b/, security: true },
  { head: "drop table", re: /^drop\s+table\b/, security: true },
  { head: "drop trigger", re: /^drop\s+trigger\b/, security: true },
  { head: "drop type", re: /^drop\s+type\b/, security: true },
  { head: "grant", re: /^grant\b/, security: true },
  { head: "revoke", re: /^revoke\b/, security: true },
  { head: "insert into", re: /^insert\s+into\b/, security: true },
  { head: "update", re: /^update\b/, security: true },
  { head: "delete from", re: /^delete\s+from\b/, security: false },
  { head: "select", re: /^select\b/, security: false },
  // Security-relevant since Phase 1C: `set session_replication_role = replica`
  // turns off every ORIGIN trigger and every foreign-key check for the rest of
  // the session, and `set search_path to ops` makes unqualified names in later
  // statements resolve into ops while this guard reads them as public.*.
  { head: "set", re: /^set\b/, security: true },
  { head: "analyze", re: /^analyze\b/, security: false },
];

/**
 * @param {Statement} statement
 * @returns {{ head: string, security: boolean }}
 */
export function classifyHead(statement) {
  for (const entry of HEADS) {
    if (entry.re.test(statement.masked)) {
      return { head: entry.head, security: entry.security };
    }
  }
  throw new InvariantError(
    `${statement.file}:${statement.line} UNCLASSIFIED STATEMENT: ${JSON.stringify(
      statement.masked.slice(0, 120),
    )}\n    Add its head to HEADS in supabase/invariants/sqlStatements.mjs and decide, in review, whether it is security-relevant or inert. An unclassified statement is refused rather than assumed harmless.`,
  );
}
