// What the build scanner's rule modules (scripts/scan-build-rules-*.mjs)
// read in common: regex fragments, and the parts of a matched assignment.

// Regex fragments shared by the rules. `\x60` is the backtick.
//
// A quote, optionally escaped: a source map's sourcesContent escapes every
// quote of its sources once more (`"` becomes `\"`).
export const QUOTE = String.raw`\\*["'\x60]`;
// One character of a quoted literal value, or one escape sequence in it
// (`\\`, `\n`, `\/`, and each of those escaped once more by a source map). A
// run of backslashes belongs to the value unless a quote follows it: then it
// escapes the closing QUOTE. Before 2026-09-23 a backslash ended the value, so
// a secret with an escape in it (measured: a Vite `define` of
// `{OPS_WORKER_PASSWORD: "…\\…"}`) was no finding at all.
export const VALUE_CHAR = String.raw`(?:[^\s"'\x60\\]|\\+[^\s"'\x60\\])`;
// One character of an unquoted `.env` value. The same, except that an escaped
// newline, return or tab ends it: in a source map that escape ends the line,
// and the value must not run on into the next variable's.
export const BARE_VALUE_CHAR = String.raw`(?:[^\s"'\x60\\]|\\+[^\s"'\x60\\nrt])`;
// Where a name or token may start: after a character that cannot continue it,
// or right after an escaped newline, return or tab, whose letter is a word
// character.
export const NAME_START = String.raw`(?:(?<=\\[nrt])|(?<![A-Za-z0-9_]))`;
// The start of a line, in a file or inside an escaped string.
export const LINE_START = String.raw`(?:^|(?<=\\[nr]))`;
// A template interpolation is code, not a literal value.
export const NOT_INTERPOLATION = String.raw`(?!\$\{)`;

/** The name a matched assignment starts with. */
export const assignedName = (match) => match.match(/^[A-Za-z0-9_]+/)?.[0] ?? "";

/** The value after the first `:` or `=` of a matched assignment. */
const ASSIGNED_VALUE = new RegExp(
  String.raw`[:=]\s*\\*["'\x60]?(${VALUE_CHAR}+)`,
);
export const assignedValue = (match) => match.match(ASSIGNED_VALUE)?.[1] ?? "";
