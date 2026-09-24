// Every job kind is classified, and the classification is total (ADR 0017 §6).
//
//   * EXTERNAL kinds act outside the database. The kill switch holds them, at
//     the lease and again immediately before their call, so each must be an
//     external_call handler: that is the only shape whose call phase the
//     runtime checks against the stops first.
//   * INTERNAL kinds are database maintenance. The kill switch never holds
//     them, so administration stays up during a stop, and each must be a
//     transactional handler: a kind that is never held must never call out.
//
// These lists mirror ops.external_job_kinds() and ops.internal_job_kinds(); a
// driver-backed test asserts equality. The worker refuses to build a registry
// that disagrees with them, so a new kind is a reviewed change here, in the
// registry and in the database together.

import {
  isExternalCallHandler,
  type HandlerRegistry,
} from "./handlerRegistry.ts";

export const EXTERNAL_JOB_KINDS: readonly string[] = Object.freeze([
  "agent_run.execute",
  "decision.shadow_evaluate",
]);

export const INTERNAL_JOB_KINDS: readonly string[] = Object.freeze([
  "postmark.ledger_retention",
]);

/**
 * Refuses a registry holding a kind that is unclassified, classified twice, or
 * registered with the wrong shape for its class. The message names the kind
 * and nothing else.
 */
export function assertRegistryClassified(registry: HandlerRegistry): void {
  for (const [kind, handler] of registry) {
    const external = EXTERNAL_JOB_KINDS.includes(kind);
    const internal = INTERNAL_JOB_KINDS.includes(kind);
    if (external === internal) {
      throw new Error(
        `job kind "${kind}" must be classified as exactly one of external or internal`,
      );
    }
    if (external && !isExternalCallHandler(handler)) {
      throw new Error(
        `job kind "${kind}" is external, so its handler must be an external_call handler`,
      );
    }
    if (internal && isExternalCallHandler(handler)) {
      throw new Error(
        `job kind "${kind}" is internal, so its handler must be a transactional handler`,
      );
    }
  }
}
