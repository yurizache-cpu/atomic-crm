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
  // Phase 1C: ops invariants live in triggers, and a drop removes one as surely
  // as `alter table … disable trigger`. `create or replace trigger` resets an
  // ALWAYS trigger to ORIGIN. CASCADE removes them with no statement naming
  // them (views are excluded here: `drop view` above already surfaces it).
  /\bdrop\s+trigger\b/,
  /\bcreate\s+(or\s+replace\s+)?trigger\b/,
  /\bdrop\s+(function|procedure|table|schema|type|domain|sequence)\b.*\bcascade\b/,
  /\balter\s+default\s+privileges\b/,
  /\bgrant\b/,
  /\bupdate\s+storage\.buckets\b/,
  /\binsert\s+into\s+storage\.buckets\b/,
];

/** Phase 2C (companyOsApi.mjs): every rule of the Company OS surface and its
 *  OD-8a exception applies inside a DO body as it does at top level. Emitted
 *  only when it is the chunk's EARLIEST hazard, so these verbs never change
 *  how an existing body is read (`revoke grant option for …` stays one
 *  REVOKE, never also a `grant …`). */
const SURFACE_HAZARD_VERBS = [
  /\brevoke\b/,
  /\b(create|alter|drop)\s+(role|user|group)\b/,
  /\balter\s+(function|routine|procedure|sequence|type|domain|schema)\b/,
  /\bcreate\s+schema\b/,
  /\bcreate\s+(or\s+replace\s+)?(function|procedure)\b/,
  /\bdrop\s+(function|routine|procedure|schema)\b/,
  /\breassign\s+owned\b/,
  // Anchored at a statement start (the chunk's own, or after a plpgsql block
  // keyword the split glued to it): `update … set role = …` is a column.
  /(?<=^|\b(?:begin|loop|then|else)\s+)(set|reset)\s+((session|local)\s+)?(role|session\s+authorization)\b/,
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

// `%I` / `%L` / `%s`, positional `%1$I` and a `-` width flag included, stand
// for an identifier or value that cannot be known statically; an opaque
// substitute keeps the statement classifiable without pretending to know which
// object it names.
const FORMAT_PLACEHOLDER = /%(\d+\$)?-?[ils]/g;

/** True when nothing but the end of the argument follows position `end`:
 *  `;`, the end of the text, or USING / INTO. A literal followed by `||` (or
 *  anything else) is not the whole argument, and reading only its first
 *  literal would silently drop the tail (Phase 2C). */
const argumentEndsAt = (text, end) =>
  /^\s*($|;|using\b|into\b)/.test(text.slice(end));

/** Resolve one EXECUTE argument to SQL text, or null if it cannot be read. */
function resolveExecuteArgument(text, pos, bodies) {
  const rest = text.slice(pos);
  const bodyRef = /^\$body(\d+)\$/.exec(rest);
  if (bodyRef) {
    if (!argumentEndsAt(text, pos + bodyRef[0].length)) return null;
    return unwrapDollar(bodies[Number(bodyRef[1])] ?? "");
  }
  if (text[pos] === "'") {
    const end = findLiteralEnd(text, pos);
    if (end === -1 || !argumentEndsAt(text, end)) return null;
    return unwrapSingle(text.slice(pos, end));
  }
  if (/^format\s*\(/.test(rest)) {
    const group = readParens(text, text.indexOf("(", pos));
    if (!group || !argumentEndsAt(text, group.end)) return null;
    const firstArg = splitAtDepth(group.inner, ",")[0] ?? "";
    // The format string must be ONE complete literal: `format('a ' || 'b', …)`
    // would otherwise unwrap to garbled SQL that matches no rule.
    if (
      firstArg.startsWith("'") &&
      findLiteralEnd(firstArg, 0) === firstArg.length
    ) {
      return unwrapSingle(firstArg).replace(FORMAT_PLACEHOLDER, "x_dynamic");
    }
    const ref = /^\$body(\d+)\$$/.exec(firstArg);
    if (ref) {
      return unwrapDollar(bodies[Number(ref[1])] ?? "").replace(
        FORMAT_PLACEHOLDER,
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
    const emittedAt = new Set();
    const hits = [...BODY_HAZARD_VERBS, ...SURFACE_HAZARD_VERBS]
      .map((verb) => verb.exec(chunk.masked))
      .filter(Boolean);
    const earliest = Math.min(...hits.map((hit) => hit.index));
    for (const verb of BODY_HAZARD_VERBS) {
      const hit = verb.exec(chunk.masked);
      if (!hit || emittedAt.has(hit.index)) continue;
      emittedAt.add(hit.index);
      emit(chunk.masked.slice(hit.index).trim());
    }
    for (const verb of SURFACE_HAZARD_VERBS) {
      const hit = verb.exec(chunk.masked);
      if (!hit || hit.index !== earliest || emittedAt.has(hit.index)) continue;
      emittedAt.add(hit.index);
      emit(chunk.masked.slice(hit.index).trim());
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
