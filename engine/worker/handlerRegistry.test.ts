// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createRegistry,
  isExternalCallHandler,
  resolveHandler,
  type AnyHandlerDefinition,
  type ExternalCallHandlerDefinition,
} from "./handlerRegistry.ts";

const handler = (kind: string): AnyHandlerDefinition => ({
  kind,
  capabilities: [],
  run: async () => "ok",
});

const externalHandler = (kind: string): ExternalCallHandlerDefinition => ({
  kind,
  shape: "external_call",
  prepareCapabilities: [],
  settleCapabilities: [],
  prepare: async () => ({ kind: "settled", detail: "nothing to call" }),
  call: async () => null,
  settle: async () => "settled",
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
    if (entry && isExternalCallHandler(entry)) {
      throw new Error("registered a transactional handler, resolved another");
    }
    expect(typeof entry?.run).toBe("function");
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "capabilities",
      "kind",
      "run",
    ]);
  });
});

describe("a handler's shape is declared by its definition, never by the job", () => {
  it("registers an external_call handler and tells it apart from a transactional one", () => {
    const registry = createRegistry([
      handler("work.in_transaction"),
      externalHandler("work.external"),
    ]);
    const transactional = resolveHandler(registry, "work.in_transaction");
    const external = resolveHandler(registry, "work.external");
    expect(transactional && isExternalCallHandler(transactional)).toBe(false);
    expect(external && isExternalCallHandler(external)).toBe(true);
  });

  it("refuses an external_call handler missing prepare, call or settle", () => {
    // Found at boot, not on the first leased job, where it would fail every
    // attempt of every job of that kind.
    for (const method of ["prepare", "call", "settle"]) {
      const broken = {
        ...externalHandler("work.external"),
        [method]: undefined,
      } as unknown as AnyHandlerDefinition;
      expect(() => createRegistry([broken])).toThrow(
        new RegExp(`without a ${method} function`),
      );
    }
  });

  it("refuses an external_call handler without its capability lists", () => {
    for (const list of ["prepareCapabilities", "settleCapabilities"]) {
      const broken = {
        ...externalHandler("work.external"),
        [list]: undefined,
      } as unknown as AnyHandlerDefinition;
      expect(() => createRegistry([broken])).toThrow(
        new RegExp(`without a ${list} list`),
      );
    }
  });

  it("refuses post-settlement steps that are not a list", () => {
    const broken = {
      ...externalHandler("work.external"),
      afterSettlement: "openRunReview",
    } as unknown as AnyHandlerDefinition;
    expect(() => createRegistry([broken])).toThrow(
      /afterSettlement that is not a list of steps/,
    );
  });

  it("refuses a shape it does not know", () => {
    const misspelt = {
      ...handler("work.misspelt"),
      shape: "external-call",
    } as unknown as AnyHandlerDefinition;
    expect(() => createRegistry([misspelt])).toThrow(/unknown shape/);
  });

  it("refuses an external call that forgot its shape instead of registering it as transactional", () => {
    // Without the shape it would be a transactional handler with no `run`.
    const shapeless = {
      kind: "work.shapeless",
      prepareCapabilities: [],
      settleCapabilities: [],
      prepare: async () => ({ kind: "settled", detail: "none" }),
      call: async () => null,
      settle: async () => "settled",
    } as unknown as AnyHandlerDefinition;
    expect(() => createRegistry([shapeless])).toThrow(
      /transactional handler without a run function/,
    );
  });
});
