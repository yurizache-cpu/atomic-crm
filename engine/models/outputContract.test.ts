// @vitest-environment node
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelError } from "./errors.ts";
import { defineOutputContract } from "./outputContract.ts";

const jsonSchema = () => ({
  type: "object",
  additionalProperties: false,
  required: ["label"],
  properties: { label: { type: "string" } },
});

const labelContract = () =>
  defineOutputContract({
    name: "label_contract",
    jsonSchema: jsonSchema(),
    schema: z.strictObject({ label: z.enum(["alpha", "beta"]) }),
    finalize: (parsed) => Object.freeze({ label: parsed.label }),
  });

describe("a contract is refused at definition when its name could not be sent", () => {
  it("rejects a name outside the provider's schema-name shape", () => {
    for (const name of ["", "has space", "a".repeat(65), "dots.not.allowed"]) {
      expect(() =>
        defineOutputContract({
          name,
          jsonSchema: jsonSchema(),
          schema: z.string(),
          finalize: (parsed) => parsed,
        }),
      ).toThrow("output contract name is malformed");
    }
  });
});

describe("parse returns the finalized value or a mismatch that quotes nothing", () => {
  it("returns what finalize produces from valid content", () => {
    const value = labelContract().parse({ label: "beta" });
    expect(value).toEqual({ label: "beta" });
    expect(Object.isFrozen(value)).toBe(true);
  });

  it("throws schema_validation with a fixed code and none of the content", () => {
    // zod's own issue text quotes the received value, and the received value is
    // model output — which can carry anything the prompt carried.
    const content = { label: "content-sentinel-9e1d" };
    let caught: unknown;
    try {
      labelContract().parse(content);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ModelError);
    const error = caught as ModelError;
    expect(error.category).toBe("schema_validation");
    expect(error.code).toBe("contract_mismatch");
    expect(inspect(error, { depth: 10, showHidden: true })).not.toContain(
      "content-sentinel-9e1d",
    );
  });
});

describe("the JSON schema handed to a provider cannot change after definition", () => {
  it("is deep-frozen", () => {
    const contract = labelContract();
    const properties = contract.jsonSchema.properties as Record<
      string,
      unknown
    >;
    expect(() => {
      properties.injected = { type: "string" };
    }).toThrow(TypeError);
  });

  it("is a copy, so later changes to the definition's object do not reach it", () => {
    const source = jsonSchema();
    const contract = defineOutputContract({
      name: "copy_check",
      jsonSchema: source,
      schema: z.unknown(),
      finalize: (parsed) => parsed,
    });
    source.required.push("smuggled");
    expect(contract.jsonSchema.required).toEqual(["label"]);
  });
});
