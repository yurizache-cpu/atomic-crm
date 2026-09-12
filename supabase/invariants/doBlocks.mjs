// What a `do $$ … $$` block contributes to the replay.
//
// DO bodies are deliberately NOT run through the closed head grammar. plpgsql
// is `begin` / `declare` / `if` / `foreach` / `raise` / `end`, none of which are
// SQL heads, so applying the grammar would fail every DO block — penalising the
// GOOD pattern, since every hand-written security migration here asserts its end
// state in a DO block. Bodies get the hazard rules and the effect model instead.
//
// Two passes, each on the representation that makes it correct:
//   Pass 1 reads literal statements with string contents BLANKED, so the words
//   inside `raise exception 'anon still holds privileges …'` can never be read
//   as a statement.
//   Pass 2 resolves EXECUTE arguments with string contents PRESERVED, the only
//   way to read them. An argument that does not resolve to a literal (or to
//   `format('<literal>', …)`) is reported in EVERY file, sealed or not, because
//   the end-state model cannot be sound without it.

import { maskStatement, splitStatements } from "./sqlStatements.mjs";
import { readParens, skipWs, splitAtDepth } from "./parse.mjs";

/** Hazard verbs that must be noticed even mid-chunk. Splitting a body on `;`
 *  glues `for … loop` to the first statement inside it, so
 *  `… loop grant all on public.t to anon;` would otherwise start with `for`. */
const BODY_HAZARD_VERBS = [
  /\bcreate\s+(or\s+replace\s+)?(recursive\s+|materialized\s+)?view\b/,
  /\bcreate\s+extension\b/,
  /\bdrop\s+extension\b/,
  /\bdrop\s+(materialized\s+)?view\b/,
  /\balter\s+(materialized\s+view|view|table)\b/,
  /\balter\s+default\s+privileges\b/,
  /\bgrant\b/,
  /\bupdate\s+storage\.buckets\b/,
  /\binsert\s+into\s+storage\.buckets\b/,
];

/** Strip the `$tag$` delimiters from a dollar-quoted body. */
export function unwrapDollar(body) {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(body);
  return m ? body.slice(m[0].length, body.length - m[0].length) : body;
}

const unwrapSingle = (literal) => literal.slice(1, -1).replace(/''/g, "'");

/** End index (exclusive) of the single-quoted literal starting at `pos`. */
function findLiteralEnd(text, pos) {
  for (let i = pos + 1; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "'") {
      if (text[i + 1] === "'") {
        i++;
        continue;
      }
      return i + 1;
    }
  }
  return -1;
}

/** Resolve one EXECUTE argument to SQL text, or null if it cannot be read. */
function resolveExecuteArgument(text, pos, bodies) {
  const rest = text.slice(pos);
  const bodyRef = /^\$body(\d+)\$/.exec(rest);
  if (bodyRef) return unwrapDollar(bodies[Number(bodyRef[1])] ?? "");
  if (text[pos] === "'") {
    const end = findLiteralEnd(text, pos);
    return end === -1 ? null : unwrapSingle(text.slice(pos, end));
  }
  if (/^format\s*\(/.test(rest)) {
    const group = readParens(text, text.indexOf("(", pos));
    if (!group) return null;
    const firstArg = splitAtDepth(group.inner, ",")[0] ?? "";
    // `%I` / `%L` / `%s` stand for an identifier or value that cannot be known
    // statically; an opaque substitute keeps the statement classifiable without
    // pretending to know which object it names.
    if (firstArg.startsWith("'") && firstArg.endsWith("'")) {
      return unwrapSingle(firstArg).replace(/%[ils]/g, "x_dynamic");
    }
    const ref = /^\$body(\d+)\$$/.exec(firstArg);
    if (ref) {
      return unwrapDollar(bodies[Number(ref[1])] ?? "").replace(
        /%[ils]/g,
        "x_dynamic",
      );
    }
  }
  return null;
}

/**
 * @param {{file: string, line: number, bodies: string[]}} statement
 * @returns {{derived: object[], unresolved: string[]}}
 */
export function scanDoBody(statement) {
  const derived = [];
  const unresolved = [];

  const body = statement.bodies.length ? unwrapDollar(statement.bodies[0]) : "";
  if (!body.trim().length) return { derived, unresolved };

  const emit = (masked, bodies = []) =>
    derived.push({
      masked,
      bodies,
      line: statement.line,
      file: statement.file,
      fromDoBlock: true,
    });

  // Pass 1 — literal statements, literals blanked.
  for (const chunk of splitStatements(body, statement.file, {
    strictTail: false,
  })) {
    for (const verb of BODY_HAZARD_VERBS) {
      const hit = verb.exec(chunk.masked);
      if (hit) emit(chunk.masked.slice(hit.index).trim());
    }
  }

  // Pass 2 — dynamic SQL, literals preserved.
  const withStrings = maskStatement(body, statement.file, {
    preserveStrings: true,
  });
  const text = withStrings.masked;

  // This pass keeps string literals intact (it has to — the dynamic SQL IS a
  // literal), which means the word `execute` can also appear INSIDE one, where
  // it is not a statement at all. `has_function_privilege(role, fn, 'EXECUTE')`
  // is the real case that found this: an ordinary assertion was reported as
  // unresolvable dynamic SQL and blocked a correct migration.
  //
  // Quote parity is sound here because this text has already been through
  // maskStatement: comments are gone, quoted identifiers are unwrapped, and
  // dollar-quoted bodies are placeholders — so every remaining `'` is a string
  // delimiter, and a doubled `''` flips parity twice.
  const insideLiteral = new Uint8Array(text.length);
  for (let i = 0, open = 0; i < text.length; i += 1) {
    if (text[i] === "'") open ^= 1;
    else insideLiteral[i] = open;
  }

  const executeRe = /\bexecute\b/g;
  let hit;
  while ((hit = executeRe.exec(text)) !== null) {
    if (insideLiteral[hit.index]) continue;
    const pos = skipWs(text, hit.index + "execute".length);
    // `execute function f()` inside a CREATE TRIGGER is not dynamic SQL.
    if (/^(function|procedure)\b/.test(text.slice(pos))) continue;

    const literal = resolveExecuteArgument(text, pos, withStrings.bodies);
    if (literal === null) {
      unresolved.push(
        `${statement.file}:${statement.line} EXECUTE whose argument is not a literal or format('<literal>', …): ` +
          JSON.stringify(text.slice(pos, pos + 80)),
      );
      continue;
    }
    for (const inner of splitStatements(literal, statement.file, {
      strictTail: false,
    })) {
      emit(inner.masked, inner.bodies);
    }
  }

  return { derived, unresolved };
}
