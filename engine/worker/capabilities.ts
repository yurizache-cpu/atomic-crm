// What a handler is allowed to DO.
//
// A handler never receives a database client. It receives an object holding
// exactly the capabilities its registry entry declared, and nothing else. That
// is the difference between "the handler is trusted not to misuse SQL" and "the
// handler cannot express the misuse".
//
// This is the earliest form of what will later be the Tool Gateway. It is
// deliberately not that yet: no registry of tools, no policy engine, no
// dynamic dispatch. One typed object, built per job, from a fixed list.
//
// Every capability below MUST be a `SECURITY DEFINER` function in `ops` that
// resolves the tenant from the live lease itself. A capability that took a
// tenant argument would hand tenancy back to the caller, which is the thing
// Phase 1A removed.

import type { TxClient } from "../db/types.ts";

export interface PurgeLedgerOptions {
  /**
   * Days of history to KEEP. The database floors this, so asking for a shorter
   * window than policy cannot delete recent data — see
   * `ops.purge_inbound_email_ledger`.
   */
  retentionDays?: number;
  /** Ceiling on rows removed in one run, so one job cannot hold a long lock. */
  limit?: number;
}

/** The complete set of capabilities that exist. Adding one is a review event. */
export interface Capabilities {
  /**
   * LGPD retention for `public.inbound_emails`. Returns rows removed.
   * Refuses unless the lease's tenant owns this deployment's CRM.
   */
  purgeInboundEmailLedger(options?: PurgeLedgerOptions): Promise<number>;
}

export type CapabilityName = keyof Capabilities;

export const CAPABILITY_NAMES: readonly CapabilityName[] = Object.freeze([
  "purgeInboundEmailLedger",
]);

/** Every capability, bound to one transaction. Never handed to a handler whole. */
function allCapabilities(tx: TxClient): Capabilities {
  return {
    async purgeInboundEmailLedger(options = {}) {
      const { rows } = await tx.query<{ purged: number }>(
        "select ops.purge_inbound_email_ledger($1, $2) as purged",
        [options.retentionDays ?? null, options.limit ?? null],
      );
      return Number(rows[0]?.purged ?? 0);
    },
  };
}

/**
 * Builds the capability object for one handler: only the names it declared.
 *
 * An undeclared capability is ABSENT, not merely undocumented — reaching for it
 * is `undefined is not a function` at the call site rather than a silent
 * privilege the handler was never reviewed for.
 */
export function grantCapabilities<K extends CapabilityName>(
  tx: TxClient,
  granted: readonly K[],
): Pick<Capabilities, K> {
  const all = allCapabilities(tx);
  const granted_: Partial<Capabilities> = {};
  for (const name of granted) {
    if (!CAPABILITY_NAMES.includes(name)) {
      throw new Error(
        `unknown capability "${String(name)}": capabilities are a fixed list, not a lookup`,
      );
    }
    granted_[name] = all[name];
  }
  return Object.freeze(granted_) as Pick<Capabilities, K>;
}
