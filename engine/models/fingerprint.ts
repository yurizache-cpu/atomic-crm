// A stable fingerprint of exactly what a model call would send.
//
// Two runs with the same fingerprint asked the same provider the same question
// under the same prompt version. That is what lets a later phase recognise a
// repeated call, and what lets an auditor prove which prompt produced a stored
// result without storing the prompt next to it.
//
// The canonical form is spelled out rather than left to JSON.stringify's
// defaults, because it is a format other code (and possibly SQL) must be able
// to reproduce byte for byte:
//
//   {"prompt_version":…,"provider":…,"model":…,"instructions":…,"input":…,
//    "output_name":…,"output_schema":…,"max_output_tokens":…}
//
// Top-level keys in that FIXED order. `output_schema` with object keys sorted
// recursively by UTF-16 code unit; array order is preserved, because in a JSON
// schema array order can be meaning (`required`, `enum`). The schema is
// serialised by hand rather than by building a sorted object: an object puts
// integer-like keys first whatever order they were inserted in, and a key named
// `__proto__` assigned onto a plain object sets its prototype instead of adding
// a key.

import { createHash } from "node:crypto";
import type { ModelRequest } from "./types.ts";

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    // Matches JSON.stringify: an unrepresentable array element becomes null.
    return `[${value.map((item) => canonicalJson(item) ?? "null").join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    const members: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const serialized = canonicalJson(record[key]);
      // Matches JSON.stringify: a member with an unrepresentable value is omitted.
      if (serialized !== undefined) {
        members.push(`${JSON.stringify(key)}:${serialized}`);
      }
    }
    return `{${members.join(",")}}`;
  }
  // Strings, numbers, booleans and null; undefined, functions and symbols
  // yield undefined, which the callers above handle.
  return JSON.stringify(value) as string;
};

export function fingerprintModelRequest(
  request: ModelRequest,
  provider: string,
  promptVersion: string,
): string {
  const members: readonly (readonly [string, string])[] = [
    ["prompt_version", JSON.stringify(promptVersion)],
    ["provider", JSON.stringify(provider)],
    ["model", JSON.stringify(request.model)],
    ["instructions", JSON.stringify(request.instructions)],
    ["input", JSON.stringify(request.input)],
    ["output_name", JSON.stringify(request.output.name)],
    ["output_schema", canonicalJson(request.output.schema)],
    ["max_output_tokens", JSON.stringify(request.maxOutputTokens)],
  ];
  const canonical = `{${members.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(",")}}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
