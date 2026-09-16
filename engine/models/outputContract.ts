// An output contract: the shape a model's answer must have before anything
// downstream may read it.
//
// Two halves that describe the same envelope, on purpose. `jsonSchema` is what
// the PROVIDER is asked to constrain generation to; it is limited to what the
// provider's strict mode accepts, so it cannot express length limits. `parse`
// is what THIS process trusts, and it re-checks everything, lengths included,
// because a provider's structured-output guarantee is a feature of someone
// else's service rather than a property we can prove. The database re-validates
// the stored result a third time.

import type { z } from "zod";
import { ModelError } from "./errors.ts";

export interface OutputContract<T> {
  /** Matches OUTPUT_CONTRACT_NAME_PATTERN. */
  readonly name: string;
  /** OpenAI strict-mode compatible. Deep-frozen. */
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  /** Validates untrusted model content; throws ModelError("schema_validation", {code:"contract_mismatch"}). */
  parse(content: unknown): T;
}

export const OUTPUT_CONTRACT_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
};

/**
 * Builds a contract from a hand-written JSON schema and the zod schema that
 * enforces it locally.
 *
 * `finalize` turns the zod output into the value callers receive (typically a
 * frozen copy). A zod failure is reported with a FIXED code and none of zod's
 * issue text: issue messages quote the received value, and the received value
 * is model output.
 */
export function defineOutputContract<S extends z.ZodType, T>(definition: {
  readonly name: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly schema: S;
  readonly finalize: (parsed: z.output<S>) => T;
}): OutputContract<T> {
  if (!OUTPUT_CONTRACT_NAME_PATTERN.test(definition.name)) {
    throw new Error("output contract name is malformed");
  }
  const { schema, finalize } = definition;
  return Object.freeze({
    name: definition.name,
    jsonSchema: deepFreeze(structuredClone(definition.jsonSchema)),
    parse(content: unknown): T {
      const result = schema.safeParse(content);
      if (!result.success) {
        throw new ModelError("schema_validation", {
          code: "contract_mismatch",
        });
      }
      return finalize(result.data);
    },
  });
}
