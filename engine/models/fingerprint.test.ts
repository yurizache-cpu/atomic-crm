// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fingerprintModelRequest } from "./fingerprint.ts";
import type { ModelRequest } from "./types.ts";

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const REQUEST: ModelRequest = {
  model: "gpt-test-1",
  instructions: "Be brief.",
  input: "Assess this.",
  output: {
    name: "task_assessment",
    schema: {
      type: "object",
      required: ["b", "a"],
      properties: { b: { type: "string" }, a: { type: "string" } },
      additionalProperties: false,
    },
  },
  maxOutputTokens: 2000,
};

const fingerprint = (request: ModelRequest = REQUEST) =>
  fingerprintModelRequest(request, "openai", "task_assessment.v1");

describe("the fingerprint is a sha256 over the documented canonical form", () => {
  it("matches the canonical string written out by hand", () => {
    // The literal below IS the format. Another implementation (SQL, a later
    // language) must reproduce it byte for byte, so it is pinned here rather
    // than derived from the code under test.
    const canonical =
      '{"prompt_version":"task_assessment.v1","provider":"openai","model":"gpt-test-1",' +
      '"instructions":"Be brief.","input":"Assess this.","output_name":"task_assessment",' +
      '"output_schema":{"additionalProperties":false,"properties":{"a":{"type":"string"},"b":{"type":"string"}},"required":["b","a"],"type":"object"},' +
      '"max_output_tokens":2000}';
    expect(fingerprint()).toBe(sha256(canonical));
    expect(fingerprint()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("orders integer-like keys and __proto__ as text, not as object property order", () => {
    // A sorted-then-stringified object would put "9" before "10" and would lose
    // an own "__proto__" key entirely.
    const schema = JSON.parse(
      '{"__proto__":{"x":1},"9":true,"10":false}',
    ) as Record<string, unknown>;
    const request = { ...REQUEST, output: { name: "n", schema } };
    const canonical =
      '{"prompt_version":"task_assessment.v1","provider":"openai","model":"gpt-test-1",' +
      '"instructions":"Be brief.","input":"Assess this.","output_name":"n",' +
      '"output_schema":{"10":false,"9":true,"__proto__":{"x":1}},"max_output_tokens":2000}';
    expect(fingerprint(request)).toBe(sha256(canonical));
  });

  it("returns the same value on every call", () => {
    expect(fingerprint()).toBe(fingerprint(structuredClone(REQUEST)));
  });
});

describe("the fingerprint tracks meaning, not incidental layout", () => {
  it("ignores the key order of the schema", () => {
    const reordered: ModelRequest = {
      ...REQUEST,
      output: {
        name: REQUEST.output.name,
        schema: {
          additionalProperties: false,
          properties: { a: { type: "string" }, b: { type: "string" } },
          required: ["b", "a"],
          type: "object",
        },
      },
    };
    expect(fingerprint(reordered)).toBe(fingerprint());
  });

  it("keeps array order, which in a schema can be meaning", () => {
    const swapped: ModelRequest = {
      ...REQUEST,
      output: {
        name: REQUEST.output.name,
        schema: { ...REQUEST.output.schema, required: ["a", "b"] },
      },
    };
    expect(fingerprint(swapped)).not.toBe(fingerprint());
  });

  it("changes when any fingerprinted field changes", () => {
    const base = fingerprint();
    const variants: readonly string[] = [
      fingerprintModelRequest(REQUEST, "openai", "task_assessment.v2"),
      fingerprintModelRequest(REQUEST, "fake", "task_assessment.v1"),
      fingerprint({ ...REQUEST, model: "gpt-test-2" }),
      fingerprint({ ...REQUEST, instructions: "Be thorough." }),
      fingerprint({ ...REQUEST, input: "Assess that." }),
      fingerprint({ ...REQUEST, output: { ...REQUEST.output, name: "other" } }),
      fingerprint({
        ...REQUEST,
        output: {
          ...REQUEST.output,
          schema: { ...REQUEST.output.schema, type: "array" },
        },
      }),
      fingerprint({ ...REQUEST, maxOutputTokens: 2001 }),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it("does not confuse text moved between instructions and input", () => {
    expect(
      fingerprint({ ...REQUEST, instructions: "ab", input: "c" }),
    ).not.toBe(fingerprint({ ...REQUEST, instructions: "a", input: "bc" }));
  });
});
