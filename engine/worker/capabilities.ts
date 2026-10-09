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

/** What the one reply-send call produced (ADR 0026 §B). */
export interface ReplySendSettlement {
  readonly outcome: "sent" | "failed" | "indeterminate";
  /** The provider's message id, on success only. */
  readonly providerMessageId: string | null;
  readonly errorCode: string | null;
  readonly errorClass: string | null;
}

/** What a gateway reported about the call it served (ADR 0022 §H). Audit only. */
export interface AgentRunGatewayReport {
  readonly providerRoute: string | null;
  readonly reportedCostMicros: number | null;
}

/** A structured decision's settlement (ADR 0022 §E): what this attempt's one call did. */
export interface StructuredDecisionSettlement {
  readonly outcome: "completed" | "indeterminate" | "invalid" | "failed";
  /** The typed answers, on completion only. Validated again by the database. */
  readonly answers: unknown;
  readonly servedModel: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reportedCostMicros: number | null;
  readonly latencyMs: number | null;
  readonly providerRoute: string | null;
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
   * BASELINE Q8 D6/D7. Redacts the AI working content of the flow bound to the
   * leased retention job once it is due: `redacted`, or on a replay
   * `already_redacted` or `superseded`, or `deferred` when the flow is still in
   * progress, having queued and bound the flow's next job. It calls nothing and
   * returns no content.
   */
  redactDueContent(): Promise<string>;
  /**
   * ADR 0021 W5. Erases the phone number of the conversation bound to the
   * leased identifier retention job once it is due: `erased`, or on a replay
   * `already_erased` or `superseded`, or `deferred` when the sender wrote
   * again and the clock moved, having bound the conversation's next job. It
   * calls nothing and returns no number.
   */
  eraseDueContactIdentifier(): Promise<string>;
  /**
   * ADR 0026 §C. Records the opt-out bound to the leased crm.opt_out_record
   * job in the CRM (do_not_contact true, nothing else): `recorded`,
   * `already_recorded`, `unresolved`, `dismissed` (a person dismissed it:
   * nothing is written), `erased`, `deferred` (not due, or its
   * acknowledgement still on its way: its next job is bound), or on a replay
   * `superseded` or `already_settled`. It calls nothing and returns no number.
   */
  recordDueOptOut(): Promise<string>;
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
  /**
   * ADR 0022. The pool and the AUTHORIZED candidates of the run bound to the
   * leased job, in rank order: enabled, priced, structured, and allowed by Q8
   * for its data class. The worker chooses only among them.
   */
  agentRunModelCandidates(): Promise<unknown>;
  /** ADR 0022. Records once what the gateway reported for the running run. Audit only. */
  recordAgentRunGatewayReport(report: AgentRunGatewayReport): Promise<string>;
  /**
   * ADR 0022. Starts the structured decision bound to the leased job on this
   * gateway: answers its kind, the decision model the database chose, the
   * allowlisted input and the question spec, recorded `running` BEFORE the
   * call; or `refused` (protected data, no model, budget) or `stopped`.
   */
  startStructuredDecision(gateway: string): Promise<unknown>;
  /** Stores this attempt's decision outcome. `not_running` means it is not this attempt's to settle. */
  settleStructuredDecision(
    settlement: StructuredDecisionSettlement,
  ): Promise<string>;
  /**
   * ADR 0023. Whether the run bound to the leased job belongs to an agent with
   * a published front-desk operating policy, and the screening pack it names.
   */
  frontDeskPolicy(): Promise<unknown>;
  /**
   * ADR 0023. Records the local screening of the run bound to the leased job
   * and answers its disposition: `model` with the bounded context the prompt
   * is built from (the screened text, never the raw message), or a fixed reply
   * or a hold for a person, both of which settle the run with no call.
   */
  recordInboundScreening(screening: unknown): Promise<unknown>;
  /**
   * ADR 0026 §B. Begins the policy send bound to the leased job, for a worker
   * whose reply transport is `transport` (`meta`, `fake` or `none`): records
   * `sending` BEFORE the call and answers the request, or settles it without a
   * call (blocked, or an earlier attempt's send recorded indeterminate),
   * answers `stopped` recording nothing, or `released` with the job back in
   * the queue (no transport here, or a newer message still to be screened).
   */
  beginReplySend(transport: string): Promise<unknown>;
  /**
   * ADR 0026 §B. The last gate, in the transaction that makes the call: holds
   * the send's conversation and reads the stale rule again. Answers `send`,
   * or the status a send it will not call is in.
   */
  confirmReplySend(): Promise<unknown>;
  /** ADR 0026 §B. Stores this attempt's call outcome. `not_sending` means it is not this attempt's to settle. */
  settleReplySend(settlement: ReplySendSettlement): Promise<string>;
  /**
   * ADR 0026 §D. Begins the owner's notification bound to the leased job, for
   * a worker whose transport is `transport` (`meta`, `fake` or `none`):
   * records `sending` BEFORE the call, with every due notification of the
   * same target carried by it, and answers the template request; or settles
   * it without a call, answers `stopped` recording nothing, or `released`
   * with the job back in the queue (quiet hours, a cap, no transport here).
   */
  beginOwnerNotification(transport: string): Promise<unknown>;
  /** ADR 0026 §D. Stores this attempt's call outcome. `not_sending` means it is not this attempt's to settle. */
  settleOwnerNotification(settlement: ReplySendSettlement): Promise<string>;
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
  "redactDueContent",
  "eraseDueContactIdentifier",
  "startCalendarSync",
  "settleCalendarSync",
  "agentRunModelCandidates",
  "recordAgentRunGatewayReport",
  "startStructuredDecision",
  "settleStructuredDecision",
  "frontDeskPolicy",
  "recordInboundScreening",
  "beginReplySend",
  "confirmReplySend",
  "settleReplySend",
  "recordDueOptOut",
  "beginOwnerNotification",
  "settleOwnerNotification",
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

    async redactDueContent() {
      const { rows } = await tx.query<{ status: unknown }>(
        "select ops.redact_due_content() as status",
      );
      return statusOf(rows, "ops.redact_due_content");
    },

    async eraseDueContactIdentifier() {
      const { rows } = await tx.query<{ status: unknown }>(
        "select ops.erase_due_contact_identifier() as status",
      );
      return statusOf(rows, "ops.erase_due_contact_identifier");
    },

    async recordDueOptOut() {
      const { rows } = await tx.query<{ status: unknown }>(
        "select ops.record_due_opt_out() as status",
      );
      return statusOf(rows, "ops.record_due_opt_out");
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

    async agentRunModelCandidates() {
      const { rows } = await tx.query<{ candidates: unknown }>(
        "select ops.agent_run_model_candidates() as candidates",
      );
      return rows[0]?.candidates;
    },

    async recordAgentRunGatewayReport(report) {
      const { rows } = await tx.query<{ status: unknown }>(
        "select ops.record_agent_run_gateway_report($1, $2) as status",
        [report.providerRoute, report.reportedCostMicros],
      );
      return statusOf(rows, "ops.record_agent_run_gateway_report");
    },

    async startStructuredDecision(gateway) {
      const { rows } = await tx.query<{ start: unknown }>(
        "select ops.start_structured_decision($1) as start",
        [gateway],
      );
      return rows[0]?.start;
    },

    async settleStructuredDecision(settlement) {
      // The answers are model output: ONE bound jsonb parameter, never spliced.
      const { rows } = await tx.query<{ status: unknown }>(
        "select ops.settle_structured_decision($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9) as status",
        [
          settlement.outcome,
          settlement.outcome === "completed"
            ? JSON.stringify(settlement.answers)
            : null,
          settlement.servedModel,
          settlement.inputTokens,
          settlement.outputTokens,
          settlement.reportedCostMicros,
          settlement.latencyMs,
          settlement.providerRoute,
          settlement.errorCode,
        ],
      );
      return statusOf(rows, "ops.settle_structured_decision");
    },

    async frontDeskPolicy() {
      const { rows } = await tx.query<{ policy: unknown }>(
        "select ops.front_desk_policy_for_run() as policy",
      );
      return rows[0]?.policy;
    },

    async recordInboundScreening(screening) {
      // The screening is engine output: ONE bound jsonb parameter, never spliced.
      const { rows } = await tx.query<{ answer: unknown }>(
        "select ops.record_inbound_screening($1::jsonb) as answer",
        [JSON.stringify(screening)],
      );
      return rows[0]?.answer;
    },

    async beginReplySend(transport) {
      const { rows } = await tx.query<{ answer: unknown }>(
        "select ops.begin_reply_send($1) as answer",
        [transport],
      );
      return rows[0]?.answer;
    },

    async confirmReplySend() {
      const { rows } = await tx.query<{ answer: unknown }>(
        "select ops.confirm_reply_send() as answer",
      );
      return rows[0]?.answer;
    },

    async settleReplySend(settlement) {
      const { rows } = await tx.query<{ status: unknown }>(
        "select ops.settle_reply_send($1, $2, $3, $4) as status",
        [
          settlement.outcome,
          settlement.providerMessageId,
          settlement.errorCode,
          settlement.errorClass,
        ],
      );
      return statusOf(rows, "ops.settle_reply_send");
    },

    async beginOwnerNotification(transport) {
      const { rows } = await tx.query<{ answer: unknown }>(
        "select ops.begin_owner_notification($1) as answer",
        [transport],
      );
      return rows[0]?.answer;
    },

    async settleOwnerNotification(settlement) {
      const { rows } = await tx.query<{ status: unknown }>(
        "select ops.settle_owner_notification($1, $2, $3, $4) as status",
        [
          settlement.outcome,
          settlement.providerMessageId,
          settlement.errorCode,
          settlement.errorClass,
        ],
      );
      return statusOf(rows, "ops.settle_owner_notification");
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
