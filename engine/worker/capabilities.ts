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
//
// The agent run capabilities extend that rule to the RUN: none of them takes a
// run, task, agent or job id either. The database resolves the one run a call
// may touch from the job the live lease holds, so a handler that read a forged
// id out of a payload would have nowhere to send it.

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

/**
 * What `ops.claim_agent_run()` returned, as the driver parsed the jsonb.
 * Deliberately `unknown`: the handler parses it, because a shape assumed here
 * would be a shape nobody checked.
 */
export type AgentRunClaim = unknown;

export interface AgentRunStart {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly inputFingerprint: string;
}

export interface AgentRunUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly reasoningTokens: number | null;
}

export interface AgentRunCompletion {
  /** The contract-validated value. The database validates it again before storing it. */
  readonly result: unknown;
  readonly responseModel: string | null;
  readonly finishReason: string | null;
  readonly providerRequestId: string | null;
  readonly providerResponseId: string | null;
  readonly usage: AgentRunUsage | null;
  readonly latencyMs: number | null;
}

export interface AgentRunFailure {
  /** A model error category. The database decides what status it means. */
  readonly category: string;
  readonly code: string | null;
  readonly responseModel: string | null;
  readonly providerRequestId: string | null;
  readonly providerResponseId: string | null;
  readonly usage: AgentRunUsage | null;
  readonly latencyMs: number | null;
}

/** The complete set of capabilities that exist. Adding one is a review event. */
export interface Capabilities {
  /**
   * LGPD retention for `public.inbound_emails`. Returns rows removed.
   * Refuses unless the lease's tenant owns this deployment's CRM.
   */
  purgeInboundEmailLedger(options?: PurgeLedgerOptions): Promise<number>;
  /**
   * The bounded prompt context of the run bound to the leased job, or the
   * status it is already settled in. Settles a run an EARLIER attempt left
   * running as indeterminate, rather than starting it again.
   */
  claimAgentRun(): Promise<AgentRunClaim>;
  /**
   * Re-checks every gate and the execution stops, then records the run as
   * running. Only the token `running` means "call the provider".
   */
  startAgentRun(start: AgentRunStart): Promise<string>;
  /** Fails a pending run this worker cannot attempt, with a short code. */
  refuseAgentRun(code: string): Promise<string>;
  /** Stores this attempt's result. `not_running` means the run is not this attempt's to settle. */
  completeAgentRun(completion: AgentRunCompletion): Promise<string>;
  /** Stores this attempt's failure. `not_running` as above. */
  failAgentRun(failure: AgentRunFailure): Promise<string>;
}

export type CapabilityName = keyof Capabilities;

export const CAPABILITY_NAMES: readonly CapabilityName[] = Object.freeze([
  "purgeInboundEmailLedger",
  "claimAgentRun",
  "startAgentRun",
  "refuseAgentRun",
  "completeAgentRun",
  "failAgentRun",
]);

/**
 * The status token a status-returning capability answered with. Every one of
 * those functions returns text on every path, so a missing value is a contract
 * break, and it throws: an invented token could read as a decision the
 * database never made.
 */
const statusOf = (
  rows: readonly { status?: unknown }[],
  fn: string,
): string => {
  const status = rows[0]?.status;
  if (typeof status !== "string") {
    throw new Error(`${fn} returned no status`);
  }
  return status;
};

/** The usage columns, always all five, in the functions' parameter order. */
const usageParams = (usage: AgentRunUsage | null): readonly unknown[] => [
  usage?.inputTokens ?? null,
  usage?.outputTokens ?? null,
  usage?.totalTokens ?? null,
  usage?.cachedInputTokens ?? null,
  usage?.reasoningTokens ?? null,
];

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

    async claimAgentRun() {
      const { rows } = await tx.query<{ claim: unknown }>(
        "select ops.claim_agent_run() as claim",
      );
      return rows[0]?.claim;
    },

    async startAgentRun(start) {
      const { rows } = await tx.query<{ status: unknown }>(
        "select ops.start_agent_run($1, $2, $3, $4) as status",
        [
          start.provider,
          start.model,
          start.promptVersion,
          start.inputFingerprint,
        ],
      );
      return statusOf(rows, "ops.start_agent_run");
    },

    async refuseAgentRun(code) {
      const { rows } = await tx.query<{ status: unknown }>(
        "select ops.refuse_agent_run($1) as status",
        [code],
      );
      return statusOf(rows, "ops.refuse_agent_run");
    },

    async completeAgentRun(completion) {
      // The result travels as ONE bound jsonb parameter. It is model output, so
      // it is never spliced into the statement and never read here.
      const { rows } = await tx.query<{ status: unknown }>(
        "select ops.complete_agent_run($1::jsonb, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as status",
        [
          JSON.stringify(completion.result),
          completion.responseModel,
          completion.finishReason,
          completion.providerRequestId,
          completion.providerResponseId,
          ...usageParams(completion.usage),
          completion.latencyMs,
        ],
      );
      return statusOf(rows, "ops.complete_agent_run");
    },

    async failAgentRun(failure) {
      const { rows } = await tx.query<{ status: unknown }>(
        "select ops.fail_agent_run($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as status",
        [
          failure.category,
          failure.code,
          failure.responseModel,
          failure.providerRequestId,
          failure.providerResponseId,
          ...usageParams(failure.usage),
          failure.latencyMs,
        ],
      );
      return statusOf(rows, "ops.fail_agent_run");
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
