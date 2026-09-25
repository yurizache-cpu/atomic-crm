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
  /**
   * The output-token ceiling the request will carry: the route policy's. The
   * database reserves spend against its own copy of that policy and refuses a
   * start whose ceiling disagrees (ADR 0017 §2).
   */
  readonly maxOutputTokens: number;
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

/** Who answers a shadow decision, recorded before the provider is asked. */
export interface ShadowDecisionProvider {
  readonly kind: string;
  readonly id: string;
  readonly version: string;
}

/** A shadow decision's settlement: the vector, or why there is none. */
export interface ShadowDecisionSettlement {
  readonly outcome: "completed" | "indeterminate" | "invalid" | "failed";
  /** The validated vector, for `completed` only. The database validates it again. */
  readonly vector: unknown;
  readonly errorCode: string | null;
}

/** A calendar sync's settlement (Phase 3A.2): what this attempt's one call did. */
export interface CalendarSyncSettlement {
  readonly outcome: "synced" | "failed" | "indeterminate";
  /** A created event's id, on success only; null otherwise and for update or cancel. */
  readonly externalEventId: string | null;
  readonly errorCode: string | null;
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
   * Re-checks every gate, the execution stops, the price and the spend limits,
   * then records the run as running. Only the token `running` means "call the
   * provider". Spend contention raises OS429 and records nothing.
   */
  startAgentRun(start: AgentRunStart): Promise<string>;
  /** Fails a pending run this worker cannot attempt, with a short code. */
  refuseAgentRun(code: string): Promise<string>;
  /** Stores this attempt's result. `not_running` means the run is not this attempt's to settle. */
  completeAgentRun(completion: AgentRunCompletion): Promise<string>;
  /** Stores this attempt's failure. `not_running` as above. */
  failAgentRun(failure: AgentRunFailure): Promise<string>;
  /**
   * Phase 2D.1. The allowlisted input of the shadow decision bound to the
   * leased job, recorded as `running` with this provider BEFORE it is asked.
   * Settles an earlier attempt's `running` as indeterminate rather than asking
   * again, answers `stopped` under a covering stop (recording nothing), and
   * `refused` out of the synthetic and test scope.
   */
  startShadowDecision(provider: ShadowDecisionProvider): Promise<unknown>;
  /** Stores the settlement. `not_running` means it is not this attempt's to settle. */
  settleShadowDecision(settlement: ShadowDecisionSettlement): Promise<string>;
  /**
   * Phase 3A.1. Moves the follow-up bound to the leased job from scheduled to
   * due, once: `due`, or on a replay `already_due`, `completed`,
   * `cancelled` or `superseded`, changing nothing. It contacts nobody.
   */
  markFollowUpDue(): Promise<string>;
  /**
   * Phase 3A.2. Starts the calendar sync bound to the leased job for a worker
   * whose calendar provider is `providerKind`: records `running` BEFORE the
   * provider is called and answers the minimised request, or settles it
   * without a call, or answers `stopped` or `wait` recording nothing. An
   * earlier attempt's `running` is settled indeterminate, never called again.
   */
  startCalendarSync(providerKind: string): Promise<unknown>;
  /** Stores this attempt's call outcome. `not_running` means it is not this attempt's to settle. */
  settleCalendarSync(settlement: CalendarSyncSettlement): Promise<string>;
}

export type CapabilityName = keyof Capabilities;

export const CAPABILITY_NAMES: readonly CapabilityName[] = Object.freeze([
  "purgeInboundEmailLedger",
  "claimAgentRun",
  "startAgentRun",
  "refuseAgentRun",
  "completeAgentRun",
  "failAgentRun",
  "startShadowDecision",
  "settleShadowDecision",
  "markFollowUpDue",
  "startCalendarSync",
  "settleCalendarSync",
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
        "select ops.start_agent_run($1, $2, $3, $4, $5) as status",
        [
          start.provider,
          start.model,
          start.promptVersion,
          start.inputFingerprint,
          start.maxOutputTokens,
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

    async startShadowDecision(provider) {
      const { rows } = await tx.query<{ start: unknown }>(
        "select ops.start_shadow_decision($1, $2, $3) as start",
        [provider.kind, provider.id, provider.version],
      );
      return rows[0]?.start;
    },

    async settleShadowDecision(settlement) {
      // Provider output travels as ONE bound jsonb parameter, never spliced.
      const { rows } = await tx.query<{ status: unknown }>(
        "select ops.settle_shadow_decision($1, $2::jsonb, $3) as status",
        [
          settlement.outcome,
          settlement.outcome === "completed"
            ? JSON.stringify(settlement.vector)
            : null,
          settlement.errorCode,
        ],
      );
      return statusOf(rows, "ops.settle_shadow_decision");
    },

    async markFollowUpDue() {
      const { rows } = await tx.query<{ status: unknown }>(
        "select ops.mark_follow_up_due() as status",
      );
      return statusOf(rows, "ops.mark_follow_up_due");
    },

    async startCalendarSync(providerKind) {
      const { rows } = await tx.query<{ start: unknown }>(
        "select ops.start_calendar_sync($1) as start",
        [providerKind],
      );
      return rows[0]?.start;
    },

    async settleCalendarSync(settlement) {
      const { rows } = await tx.query<{ status: unknown }>(
        "select ops.settle_calendar_sync($1, $2, $3) as status",
        [settlement.outcome, settlement.externalEventId, settlement.errorCode],
      );
      return statusOf(rows, "ops.settle_calendar_sync");
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
