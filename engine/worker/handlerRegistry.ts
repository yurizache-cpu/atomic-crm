// The handler registry: job.kind -> one known handler, or nothing.
//
// FAIL CLOSED is the whole contract. An unknown kind is not "probably fine",
// not "try a default", not "look it up dynamically". It is a permanent failure
// with a recorded reason.
//
// What this module refuses to do, and why each one is a real attack:
//
//   * No dynamic import. A payload that can name a module can run any file on
//     disk.
//   * No lookup by a payload-supplied function name.
//   * No prototype-chain lookup. `handlers["constructor"]` and
//     `handlers["toString"]` resolve to FUNCTIONS on a plain object literal, so
//     a job of kind "toString" would "find a handler" and the runtime would
//     call it with a job and a capability bag. The registry is a Map, which has
//     no prototype chain to walk, so fail-closed is the default rather than
//     something a lookup guard has to remember to impose.

import type { CapabilityName, Capabilities } from "./capabilities.ts";
import type { LeasedJob } from "./job.ts";

/**
 * One unit of work.
 *
 * It receives the job and the capabilities it declared — and no tenant
 * argument. The tenant is ambient, enforced by RLS inside the transaction, so a
 * handler cannot widen it by forgetting a parameter or by trusting a payload
 * field.
 *
 * Returning a string records it on the job's `succeeded` event. It must be
 * metadata (counts, ids), never content.
 */
export interface HandlerDefinition<K extends CapabilityName = CapabilityName> {
  readonly kind: string;
  readonly capabilities: readonly K[];
  readonly run: (
    job: LeasedJob,
    capabilities: Pick<Capabilities, K>,
  ) => Promise<string | void>;
}

/** Erased form, for storage in the registry. */
export type AnyHandlerDefinition = HandlerDefinition<CapabilityName>;

export type HandlerRegistry = ReadonlyMap<string, AnyHandlerDefinition>;

/**
 * Builds a registry from an explicit list.
 *
 * A `Map` rather than an object: a Map has no prototype chain to walk, so
 * `registry.get("toString")` is `undefined` and the fail-closed path is the
 * default rather than something a lookup guard has to remember to impose.
 */
export function createRegistry(
  definitions: readonly AnyHandlerDefinition[],
): HandlerRegistry {
  const registry = new Map<string, AnyHandlerDefinition>();
  for (const definition of definitions) {
    if (!definition.kind.trim()) {
      throw new Error("a handler definition has a blank kind");
    }
    if (registry.has(definition.kind)) {
      throw new Error(
        `duplicate handler for kind "${definition.kind}": one kind, one handler, decided here and not at runtime`,
      );
    }
    registry.set(definition.kind, definition);
  }
  return registry;
}

/** Never throws, never guesses. Unknown kind -> undefined. */
export function resolveHandler(
  registry: HandlerRegistry,
  kind: string,
): AnyHandlerDefinition | undefined {
  if (typeof kind !== "string") return undefined;
  return registry.get(kind);
}
