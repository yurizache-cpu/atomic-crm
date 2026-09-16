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
//
// TWO SHAPES, decided by the definition and never by the job:
//
//   * transactional (the default, `shape` absent): `run` does its work inside
//     the transaction that completes the job. Everything the database can do
//     reliably belongs here.
//   * external_call: ONE call to a service outside the database, which must not
//     be issued twice and must never hold a transaction open while it waits.
//     The work is split into `prepare` (a committed transaction), `call` (no
//     transaction, no capabilities) and `settle` (a second transaction). See
//     runOneJob.ts for why each boundary is where it is.

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
  /**
   * Absent on every transactional handler written so far. It exists only so
   * the union below has a discriminant every member carries.
   */
  readonly shape?: "transactional";
  readonly capabilities: readonly K[];
  readonly run: (
    job: LeasedJob,
    capabilities: Pick<Capabilities, K>,
  ) => Promise<string | void>;
}

/** What the call phase receives. Deliberately nothing that can reach SQL. */
export interface ExternalCallContext {
  /** Aborts on worker shutdown AND when the lease-derived deadline passes. */
  readonly signal: AbortSignal;
  /** Epoch ms (worker clock) after which the call must be treated as timed out. */
  readonly deadline: number;
}

export interface PrepareBudget {
  /**
   * Milliseconds between the start of prepare and the lease-derived deadline,
   * never negative. A handler whose call cannot finish inside it should settle
   * instead of calling: the lease would expire mid-call and the result could not
   * be recorded by this worker.
   */
  readonly callBudgetMs: number;
  /**
   * Milliseconds left until that deadline at the moment of asking, never
   * negative. Prepare can wait on locks, so the snapshot above goes stale: a
   * handler asks again immediately before it commits to a call.
   */
  remainingMs(): number;
}

export type PrepareOutcome<TState> =
  /** Nothing to call. `detail` completes the job in the prepare transaction. */
  | { readonly kind: "settled"; readonly detail: string }
  /** Commit the prepare transaction, then make the call with `state`. */
  | { readonly kind: "call"; readonly state: TState };

/**
 * The call's result, as DATA. A failed call is an outcome to record, not an
 * exception to retry: a paid call must never be re-issued by a job retry.
 */
export type CallOutcome<TResult> =
  | { readonly ok: true; readonly value: TResult; readonly durationMs: number }
  | {
      readonly ok: false;
      readonly error: unknown;
      readonly durationMs: number;
    };

/**
 * A handler whose work is ONE external call.
 *
 * Method syntax, not arrow properties, on purpose: methods are compared
 * bivariantly, so a concrete definition with its own state and result types is
 * assignable to the erased form the registry stores.
 */
export interface ExternalCallHandlerDefinition<
  KP extends CapabilityName = CapabilityName,
  KS extends CapabilityName = CapabilityName,
  TState = unknown,
  TResult = unknown,
> {
  readonly kind: string;
  readonly shape: "external_call";
  /** Granted to `prepare` only. */
  readonly prepareCapabilities: readonly KP[];
  /** Granted to `settle` only. `call` is granted nothing. */
  readonly settleCapabilities: readonly KS[];
  prepare(
    job: LeasedJob,
    capabilities: Pick<Capabilities, KP>,
    budget: PrepareBudget,
  ): Promise<PrepareOutcome<TState>>;
  call(state: TState, context: ExternalCallContext): Promise<TResult>;
  settle(
    state: TState,
    outcome: CallOutcome<TResult>,
    capabilities: Pick<Capabilities, KS>,
  ): Promise<string>;
}

/** Erased form, for storage in the registry. */
export type AnyHandlerDefinition =
  | HandlerDefinition<CapabilityName>
  | ExternalCallHandlerDefinition<
      CapabilityName,
      CapabilityName,
      unknown,
      unknown
    >;

export type HandlerRegistry = ReadonlyMap<string, AnyHandlerDefinition>;

export function isExternalCallHandler(
  definition: AnyHandlerDefinition,
): definition is ExternalCallHandlerDefinition {
  return definition.shape === "external_call";
}

/**
 * Refuses a definition the runtime could only discover to be broken while a
 * job is leased. The types already forbid every case below; this is the runtime
 * half, because a definition that forgot `shape` would otherwise register as a
 * transactional handler with no `run` and fail on every attempt instead of at
 * boot.
 */
function assertRunnable(definition: AnyHandlerDefinition): void {
  const shape: unknown = definition.shape;
  if (shape === "external_call") {
    const external = definition as ExternalCallHandlerDefinition;
    for (const method of ["prepare", "call", "settle"] as const) {
      if (typeof external[method] !== "function") {
        throw new Error(
          `handler "${definition.kind}" is an external_call handler without a ${method} function`,
        );
      }
    }
    for (const list of ["prepareCapabilities", "settleCapabilities"] as const) {
      if (!Array.isArray(external[list])) {
        throw new Error(
          `handler "${definition.kind}" is an external_call handler without a ${list} list`,
        );
      }
    }
    return;
  }
  if (shape !== undefined && shape !== "transactional") {
    throw new Error(
      `handler "${definition.kind}" declares an unknown shape: a shape is transactional or external_call, never a guess`,
    );
  }
  if (typeof (definition as HandlerDefinition).run !== "function") {
    throw new Error(
      `handler "${definition.kind}" is a transactional handler without a run function`,
    );
  }
}

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
    assertRunnable(definition);
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
