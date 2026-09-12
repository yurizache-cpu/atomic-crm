// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createRegistry,
  resolveHandler,
  type AnyHandlerDefinition,
} from "./handlerRegistry.ts";

const handler = (kind: string): AnyHandlerDefinition => ({
  kind,
  capabilities: [],
  run: async () => "ok",
});

describe("the registry is an explicit list", () => {
  it("resolves a registered kind", () => {
    const registry = createRegistry([handler("a.thing")]);
    expect(resolveHandler(registry, "a.thing")?.kind).toBe("a.thing");
  });

  it("refuses two handlers for one kind", () => {
    // Which of the two would run is not something to discover at 3am.
    expect(() => createRegistry([handler("dup"), handler("dup")])).toThrow(
      /duplicate handler/i,
    );
  });

  it("refuses a blank kind", () => {
    expect(() => createRegistry([handler("   ")])).toThrow(/blank kind/i);
  });
});

describe("unknown kinds fail closed", () => {
  const registry = createRegistry([handler("known")]);

  it("returns undefined for a kind nobody registered", () => {
    expect(resolveHandler(registry, "not.registered")).toBeUndefined();
  });

  it("returns undefined for the empty string", () => {
    expect(resolveHandler(registry, "")).toBeUndefined();
  });

  it("does not resolve inherited object properties", () => {
    // The reason the registry is a Map and not an object literal. On a plain
    // object, `handlers["constructor"]` and `handlers["toString"]` are
    // FUNCTIONS, so a job whose kind is "toString" would find a handler and the
    // runtime would call it with a job and a capability bag.
    for (const kind of [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "__proto__",
    ]) {
      expect(resolveHandler(registry, kind)).toBeUndefined();
    }
  });

  it("does not resolve a non-string kind", () => {
    expect(resolveHandler(registry, 42 as unknown as string)).toBeUndefined();
  });
});

describe("what the registry deliberately cannot express", () => {
  it("has no way to register a handler from data", () => {
    // A guard against the shape, not just the current code: if a future change
    // adds a dynamic path, this assertion is where the review conversation
    // starts. `createRegistry` takes definitions with a `run` FUNCTION, so a
    // payload carrying a module path or a function name has nowhere to go.
    const registry = createRegistry([handler("known")]);
    const entry = resolveHandler(registry, "known");
    expect(typeof entry?.run).toBe("function");
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "capabilities",
      "kind",
      "run",
    ]);
  });
});
