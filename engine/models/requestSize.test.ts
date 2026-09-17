// @vitest-environment node
import { describe, expect, it } from "vitest";
import { modelRequestByteSize } from "./requestSize.ts";
import type { ModelRequest } from "./types.ts";

const requestOf = (
  parts: Partial<Pick<ModelRequest, "instructions" | "input">> & {
    readonly name?: string;
    readonly schema?: Readonly<Record<string, unknown>>;
  } = {},
): ModelRequest => ({
  model: "gpt-test-standard",
  instructions: parts.instructions ?? "",
  input: parts.input ?? "",
  output: { name: parts.name ?? "", schema: parts.schema ?? {} },
  maxOutputTokens: 8000,
});

describe("a model request's size is the UTF-8 byte length of the text the model reads", () => {
  it("counts ASCII text one byte per character across instructions, input, schema and output name", () => {
    // Arrange
    const request = requestOf({
      instructions: "abc",
      input: "hello",
      schema: { type: "object" },
      name: "x",
    });

    // Act
    const size = modelRequestByteSize(request);

    // Assert: 3 + 5 + '{"type":"object"}' (17) + 1
    expect(size).toBe(26);
  });

  it("counts multi-byte characters by their encoded bytes, never by string length", () => {
    // Arrange: 2-, 3- and 4-byte characters; the emoji is two UTF-16 units.
    const request = requestOf({ instructions: "é€", input: "😀" });

    // Act
    const size = modelRequestByteSize(request);

    // Assert: 2 + 3 + 4, plus the empty schema "{}" (2)
    expect("é€😀".length).toBe(4);
    expect(size).toBe(11);
  });

  it("counts raw control characters as one byte each, and the schema's escaped ones as JSON writes them", () => {
    // Arrange
    const request = requestOf({
      input: "\u0000\n\t",
      schema: { d: "\n\u0001" },
    });

    // Act
    const size = modelRequestByteSize(request);

    // Assert: 3 raw bytes, plus '{"d":"\n\u0001"}' escaped, which is 16 bytes
    expect(JSON.stringify({ d: "\n\u0001" })).toBe('{"d":"\\n\\u0001"}');
    expect(size).toBe(3 + 16);
  });

  it("counts quotes and backslashes in the schema after JSON escaping", () => {
    // Arrange
    const request = requestOf({ schema: { q: '"\\' } });

    // Act
    const size = modelRequestByteSize(request);

    // Assert: '{"q":"\"\\"}' is 12 bytes
    expect(size).toBe(12);
  });

  it("never counts less than the whole request's text measured as one string, even when a surrogate pair is split between parts", () => {
    // Arrange: a high surrogate ends the instructions, its low half starts the input.
    const instructions = "a\ud83d";
    const input = "\ude00b";
    const request = requestOf({ instructions, input, name: "n" });
    const joined = `${instructions}${input}{}n`;

    // Act
    const size = modelRequestByteSize(request);

    // Assert: the joined text has one 4-byte character; the parts, two 3-byte replacements.
    expect(new TextEncoder().encode(joined).byteLength).toBe(9);
    expect(size).toBe(11);
    expect(size).toBeGreaterThanOrEqual(
      new TextEncoder().encode(joined).byteLength,
    );
  });

  it("does not count the model id or the output ceiling, which the model does not read", () => {
    // Arrange
    const base = requestOf({ input: "same" });
    const other: ModelRequest = {
      ...base,
      model: "a-much-longer-model-identifier-2026-09-17",
      maxOutputTokens: 25000,
    };

    // Act / Assert
    expect(modelRequestByteSize(other)).toBe(modelRequestByteSize(base));
  });
});
