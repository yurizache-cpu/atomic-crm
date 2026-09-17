// Production scope, workflow reader: GitHub workflow YAML read line by line,
// for scripts/production-scope-database-gate.mjs (Phase 1D.2).
//
// No YAML parser (no new dependency). Each reader returns what it can read
// unambiguously and reports, or returns null for, anything it would have to
// guess at, so the rules that use it can refuse instead of interpreting. Keys
// are compared lowercase. It knows nothing about Supabase or the gate.

import { workflowUnits } from "./dev-signing-key.mjs";

export const PLAIN_KEY = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
export const JOB_ID = /^[A-Za-z_][\w-]*$/;

/** Line breaks to a YAML reader (NEL, U+2028, U+2029), controls, and characters that render as nothing, built from numbers so this file holds none. */
// prettier-ignore
export const HIDDEN_RANGES = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0xa0, 0xa0],
  [0x1680, 0x1680], [0x2000, 0x200b], [0x200e, 0x200f], [0x2028, 0x202f],
  [0x205f, 0x2064], [0x2066, 0x206f], [0x3000, 0x3000], [0xfeff, 0xfeff],
];
export const HIDDEN = new RegExp(
  `\r(?!\n)|[${HIDDEN_RANGES.map((r) => r.map((c) => String.fromCharCode(c)).join("-")).join("")}]`,
);
export const MARKER = /^(?:(?:---|\.\.\.)(?:[ \t]|$)|%)/;
export const BLOCK_SCALAR = /^[|>][-+1-9]*$/;

export const isBlank = (line) => line.trim() === "";
export const isComment = (line) => /^[ \t]*#/.test(line);
export const leadOf = (line) => line.match(/^[ \t]*/)[0];
export const withoutComment = (value) => value.replace(/(?:^|[ \t]+)#.*$/, "");
export const unquote = (value) => value.replace(/^(['"])(.*)\1$/, "$2");
export const splitLines = (content) => content.split(/\r?\n/);

/** A value that opens a quoted scalar or a flow collection and does not close it on its line. */
export const opensAcrossLines = (value) =>
  value.startsWith("'")
    ? !/^'(?:[^']|'')*'$/.test(value)
    : value.startsWith('"')
      ? !/^"(?:[^"\\]|\\.)*"$/.test(value)
      : /^[[{]/.test(value) && !/^(?:\[[^[\]{}]*\]|\{[^[\]{}]*\})$/.test(value);

/**
 * Lines whose meaning a line reader would have to guess: a hidden line break
 * or invisible character, a document marker or directive, and a value that
 * can swallow the lines after it. Block scalar content is skipped: its extent
 * is set by indentation, which every reader here agrees on.
 */
export function lineProblems(lines) {
  const problems = [];
  let scalarColumn = null;
  lines.forEach((line, i) => {
    const at = (detail) => problems.push({ line: i + 1, detail });
    if (HIDDEN.test(line)) {
      return at("a line break or invisible character a YAML reader may see");
    }
    if (isBlank(line) || isComment(line)) return;
    if (scalarColumn !== null && leadOf(line).length > scalarColumn) return;
    scalarColumn = null;
    if (MARKER.test(line) && !(i === 0 && line.trim() === "---")) {
      return at("a document marker or directive");
    }
    const text = line.trim().replace(/^(?:-(?:[ \t]+|$))+/, "");
    const key = text.match(/^[A-Za-z_][\w-]*[ \t]*:(?:[ \t]+|$)/);
    const value = withoutComment(key ? text.slice(key[0].length) : text);
    if (BLOCK_SCALAR.test(value.trim())) {
      scalarColumn = line.trimEnd().length - text.length;
    } else if (opensAcrossLines(value.trim())) {
      at("a quoted value or flow collection that does not close on its line");
    }
  });
  return problems;
}

/** Top-level lines as {line, key}, `key` lowercase or undefined when not a plain key. */
export const topLevelKeys = (lines) =>
  lines.flatMap((line, i) => {
    if (/^(?:[ \t]|#|$)/.test(line) || (i === 0 && line === "---")) return [];
    return [{ line: i + 1, key: line.match(PLAIN_KEY)?.[1].toLowerCase() }];
  });

/** A job read line by line: keys as Map<lowercase key, {line, value without comment, block, lines}>. */
export function jobReader(id, index, problem) {
  const job = { id, line: index + 1, lineNumbers: [], keys: new Map() };
  let keyIndent = null;
  let key = null;
  const read = (i, lead, text) => {
    job.lineNumbers.push(i + 1);
    keyIndent ??= lead;
    if (lead < keyIndent) return problem(i, `an indentation under "${id}"`);
    if (lead > keyIndent || /^-(?:[ \t]|$)/.test(text)) {
      // A value's own lines. A sequence may sit at its key's indentation.
      if (!key) problem(i, `a value under no readable key of job "${id}"`);
      key?.block.push(text);
      key?.lines.push(i + 1);
      return;
    }
    const m = text.match(PLAIN_KEY);
    const value = m ? withoutComment(m[2] ?? "") : "";
    key = null;
    if (!m || /^[&*!]/.test(value)) {
      return problem(i, `a key of job "${id}" that is not a plain key`);
    }
    const name = m[1].toLowerCase();
    if (job.keys.has(name)) problem(i, `a second ${m[1]} in job "${id}"`);
    key = { line: i + 1, value, block: [], lines: [] };
    job.keys.set(name, key);
  };
  return { job, read };
}

/**
 * Each job's own keys, keyed by lowercase id, plus every line whose meaning
 * these rules would have to guess and the lines outside `jobs:`. Null when the
 * file has no plain `jobs:` block.
 */
export function readJobs(lines) {
  const at = lines.findIndex((line) => /^jobs:[ \t]*(?:#.*)?$/.test(line));
  if (at === -1) return null;
  const jobs = new Map();
  const problems = [];
  const problem = (index, detail) => problems.push({ line: index + 1, detail });
  lines.forEach((line, i) => {
    if (i !== at && /^["']?jobs["']?[ \t]*:/i.test(line)) {
      problem(i, "a second jobs block");
    }
  });
  let end = lines.length;
  let jobIndent = null;
  let reader = null;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line) || isComment(line)) continue;
    const lead = leadOf(line);
    if (lead.length === 0) {
      end = i; // the next top-level key ends `jobs:`
      break;
    }
    if (lead.includes("\t")) {
      problem(i, "tab indentation");
      continue;
    }
    jobIndent ??= lead.length;
    if (lead.length > jobIndent) {
      reader?.read(i, lead.length, line.trim()); // no reader: already reported
      continue;
    }
    const m = line.trim().match(PLAIN_KEY);
    reader = null;
    if (lead.length < jobIndent || !m || withoutComment(m[2] ?? "")) {
      problem(i, "a job id that is not a plain key");
      continue;
    }
    if (jobs.has(m[1].toLowerCase())) problem(i, `a second job "${m[1]}"`);
    reader = jobReader(m[1], i, problem);
    jobs.set(m[1].toLowerCase(), reader.job);
  }
  return { jobs, problems, top: [...lines.slice(0, at), ...lines.slice(end)] };
}

/** A step's own keys (lowercase) as {raw, value, block}, or null when a line cannot be placed. */
export function stepKeys(step, lines) {
  const [first, ...rest] = step.lines.map((n) => lines[n - 1]);
  const item = first.match(/^[ \t]*-[ \t]+(\S.*)$/);
  if (!item) return null;
  const column = first.length - item[1].length;
  const keys = new Map();
  let key = null;
  const entries = [[column, item[1]]];
  rest.forEach((line) => entries.push([leadOf(line).length, line.trim()]));
  for (const [lead, text] of entries) {
    if (lead > column && key) {
      key.block.push(text);
      continue;
    }
    const m = lead === column && text.match(PLAIN_KEY);
    if (!m || keys.has(m[1].toLowerCase())) return null;
    key = { raw: m[2] ?? "", value: withoutComment(m[2] ?? ""), block: [] };
    keys.set(m[1].toLowerCase(), key);
  }
  return keys;
}

/** What a step runs, without its name: a name is never run, and may well mention Supabase. */
export const stepCode = (keys) =>
  [...keys]
    .filter(([key]) => key !== "name")
    .flatMap(([key, { raw, block }]) => [`${key}: ${raw}`, ...block])
    .join("\n");

/** Each job's steps, from dev-signing-key's reader, by job. */
export const stepsReader = (lines) => {
  const units = workflowUnits(lines) ?? [];
  return (job) =>
    units.find((u) => u.unit.toLowerCase() === job.id.toLowerCase())?.steps ??
    [];
};

/** The job ids a `needs` key names (lowercase), [] without one, null when unreadable. */
export function needsOf(key) {
  if (!key) return [];
  let ids;
  if (key.block.length > 0) {
    if (key.value) return null;
    ids = key.block.map((text) => withoutComment(text).match(/^-[ \t]+(.+)$/));
    ids = ids.map((m) => m?.[1] ?? "");
  } else {
    const flow = key.value.match(/^\[(.*)\]$/);
    ids = flow ? flow[1].split(",") : [key.value];
    if (flow && ids.length > 1 && ids.at(-1).trim() === "") ids.pop();
  }
  ids = ids.map((text) => unquote(text.trim()));
  if (!ids.every((id) => JOB_ID.test(id))) return null;
  return ids.map((id) => id.toLowerCase());
}

/** A workflow's trigger names (lowercase), whether any is configured, and its `on` line; null when unreadable. */
export function triggersOf(lines) {
  const at = lines.flatMap((line, i) => (/^on[ \t]*:/i.test(line) ? [i] : []));
  if (at.length !== 1) return null;
  const value = withoutComment(lines[at[0]].replace(/^on[ \t]*:/i, "")).trim();
  const children = [];
  let indent = null;
  let configured = false;
  for (const line of lines.slice(at[0] + 1)) {
    if (isBlank(line) || isComment(line)) continue;
    const lead = leadOf(line).length;
    if (lead === 0) break;
    indent ??= lead;
    if (lead < indent) return null;
    configured ||= lead > indent;
    if (lead > indent) continue;
    const text = withoutComment(line.trim());
    const key = text.match(PLAIN_KEY);
    const name = key?.[1] ?? text.match(/^-[ \t]+([\w-]+)$/)?.[1];
    if (!name) return null;
    children.push(name);
  }
  if (value && children.length > 0) return null;
  const list = value.match(/^\[(.*)\]$/)?.[1] ?? value;
  const names = value
    ? list.split(",").map((t) => unquote(t.trim()))
    : children;
  if (names.length === 0 || !names.every((n) => JOB_ID.test(n))) return null;
  const lowercase = names.map((n) => n.toLowerCase());
  return { line: at[0] + 1, names: lowercase, configured };
}
