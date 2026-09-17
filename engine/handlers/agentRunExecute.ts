// The agent run handler: ONE model call for ONE run, never two.
//
// It is an external_call handler (engine/worker/externalCall.ts), and each phase
// has exactly one job:
//
//   prepare  (TX2a, committed) claim the run the LEASE is bound to, refuse what
//            cannot be attempted, and record `running` BEFORE any call leaves
//            the process. Only the database's token `running` means "call".
//            `stopped` means an execution stop holds the run: nothing was
//            written, and the runtime defers the job (owner decision B). Every
//            other token means the run is already settled, and nothing is
//            called.
//   call     (no transaction) exactly one router invocation. No retry, no loop,
//            no second call on any error.
//   settle   (TX2b) record the result or the failure for THIS attempt. A run the
//            database says is no longer this attempt's is a refusal that rolls
//            TX2b back; the sweep owns it from there.
//
// WHAT IS NOT TRUSTED, and where each is checked:
//
//   * The job payload. It is data. The run comes from ops.claim_agent_run(),
//     which resolves it from the live lease; the payload's agent_run_id is only
//     compared against that answer, and a mismatch is a security failure before
//     anything else runs. It never selects a run.
//   * The claim. It is parsed against exactly the two shapes the migration
//     returns. Anything else is a permanent failure with a fixed message.
//   * The model's answer. The router validates it against the output contract,
//     the database validates it again, and here it is only ever passed through
//     as the `result` parameter. No field of it is read, logged or acted on.
//
// WHAT NEVER LEAVES THIS FILE in a detail string or an error message: the task
// text, the prompt, the result, the summary, or a provider's error text.
// Details carry ids, statuses, the route, provider, model, token counts and a
// category — metadata an operator can grep without reading tenant data.
//
// It never logs, never reads process.env and never imports the domain, the
// database layer or a driver: everything it may do arrives as a capability.

import { z } from "zod";
import {
  ModelError,
  toModelError,
  type ModelErrorCategory,
} from "../models/errors.ts";
import { fingerprintModelRequest } from "../models/fingerprint.ts";
import {
  buildModelRequest,
  type ModelRouter,
  type ResolvedModelRoute,
  type StructuredModelResult,
} from "../models/router.ts";
import {
  buildTaskAssessmentPrompt,
  TASK_ASSESSMENT_CAPABILITY,
  taskAssessmentContract,
  type BuiltPrompt,
  type TaskAssessment,
} from "../models/taskAssessment.ts";
import { normalizeLatencyMs, type ModelUsage } from "../models/types.ts";
import type { Capabilities } from "../worker/capabilities.ts";
import {
  PermanentError,
  SecurityError,
  TransientError,
} from "../worker/failures.ts";
import type {
  CallOutcome,
  ExternalCallContext,
  ExternalCallHandlerDefinition,
  PrepareOutcome,
} from "../worker/handlerRegistry.ts";
import { payloadObject } from "../worker/job.ts";

export const AGENT_RUN_EXECUTE_KIND = "agent_run.execute";

/**
 * Below this, a call is not started. Nothing is durable yet when it is refused
 * (the run is still pending), so the job retries under a fresh lease instead of
 * recording a call the lease could not have bounded.
 */
export const MIN_CALL_BUDGET_MS = 5_000;

/** Details are metadata, and bounded like one. */
const DETAIL_MAX_LENGTH = 400;

type PrepareCapability = "claimAgentRun" | "startAgentRun" | "refuseAgentRun";
type SettleCapability = "completeAgentRun" | "failAgentRun";

export interface AgentRunExecuteDependencies {
  readonly modelRouter: ModelRouter;
  /** Epoch ms on the same clock as the runtime's deadline. Tests only. */
  readonly now?: () => number;
}

/** What prepare hands the call. Frozen; nothing in it reaches the database. */
export interface AgentRunCallState {
  readonly runId: string;
  readonly route: ResolvedModelRoute;
  readonly prompt: BuiltPrompt;
  readonly promptVersion: string;
}

export type AgentRunExecuteHandler = ExternalCallHandlerDefinition<
  PrepareCapability,
  SettleCapability,
  AgentRunCallState,
  StructuredModelResult<TaskAssessment>
>;

const RUN_ID = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** Exactly the two shapes ops.claim_agent_run() returns. Strict: an extra key is a contract change. */
const claimSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("settled"),
    agent_run_id: RUN_ID,
    status: z.enum(["succeeded", "failed", "indeterminate", "cancelled"]),
  }),
  z.strictObject({
    action: z.literal("start"),
    agent_run_id: RUN_ID,
    capability: z.string(),
    model_route: z.string(),
    agent: z.strictObject({
      name: z.string(),
      role: z.string(),
      description: z.string().nullable(),
    }),
    task: z.strictObject({
      type: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      priority: z.number().int(),
      due_at: z.string().nullable(),
    }),
  }),
]);

type RefusalCode = "capability_unsupported" | "route_unavailable";

/** A database status token as it may appear in a detail, or a marker that it was not one. */
const statusToken = (status: string): string =>
  /^[a-z][a-z_]{0,39}$/.test(status) ? status : "unrecognized";

const countToken = (count: number | null | undefined): string =>
  typeof count === "number" ? String(count) : "-";

const describeRun = (runId: string, status: string): string =>
  `agent_run=${runId} status=${statusToken(status)}`;

const describeSettlement = (
  state: AgentRunCallState,
  status: string,
  usage: ModelUsage | null,
  category: ModelErrorCategory | null,
): string =>
  [
    describeRun(state.runId, status),
    `route=${state.route.route}`,
    `provider=${state.route.provider}`,
    `model=${state.route.model}`,
    `input_tokens=${countToken(usage?.inputTokens)}`,
    `output_tokens=${countToken(usage?.outputTokens)}`,
    `category=${category ?? "-"}`,
  ]
    .join(" ")
    .slice(0, DETAIL_MAX_LENGTH);

/** What ops.complete_agent_run records: a valid result, or a refused one. */
const COMPLETION_STATUSES: readonly string[] = Object.freeze([
  "succeeded",
  "failed",
]);
/** What ops.fail_agent_run records: the status the database derives. */
const FAILURE_STATUSES: readonly string[] = Object.freeze([
  "failed",
  "indeterminate",
]);

/**
 * Accepts only a status this settlement can have recorded.
 *
 * `not_running` means the run is not running, or was started by another
 * attempt: settling it anyway would overwrite someone else's record. Any other
 * token is a database answer this handler does not understand, and completing
 * the job on it would claim a settlement nobody verified. Both roll TX2b back,
 * and the sweep settles the run.
 */
const requireOwnSettlement = (
  status: string,
  recorded: readonly string[],
): void => {
  if (status === "not_running") {
    throw new SecurityError(
      "the agent run was settled by someone else while its call ran",
    );
  }
  if (!recorded.includes(status)) {
    throw new SecurityError(
      "the database answered a settlement status this handler does not recognise",
    );
  }
};

/**
 * A call that ended without a result, with what the call phase observed about
 * WHY. Only the call can see its signal; settle cannot, so the observation
 * travels with the error. Its message is fixed, and it carries no cause.
 */
class AgentRunCallFailure extends Error {
  readonly modelError: ModelError;
  readonly deadlineReached: boolean;
  constructor(modelError: ModelError, deadlineReached: boolean) {
    super("the model call ended without a result");
    this.name = "AgentRunCallFailure";
    this.modelError = modelError;
    this.deadlineReached = deadlineReached;
  }
}

/** What AbortSignal.timeout aborts with: a DOMException named TimeoutError. */
const isTimeoutReason = (reason: unknown): boolean =>
  typeof reason === "object" &&
  reason !== null &&
  (reason as { name?: unknown }).name === "TimeoutError";

const isAbortReason = (reason: unknown): boolean =>
  isTimeoutReason(reason) ||
  (typeof reason === "object" &&
    reason !== null &&
    (reason as { name?: unknown }).name === "AbortError");

/**
 * Did the LEASE deadline end this call, rather than shutdown?
 *
 * The external_call runtime aborts the call's signal with `AbortSignal.any([shutdown,
 * AbortSignal.timeout(deadline - now)])`, so an aborted signal's reason names
 * whichever came first: a TimeoutError is the deadline, anything else (an
 * AbortError from shutdown) is not. A signal not yet aborted past the deadline
 * is a timer that has not fired yet, which is still the deadline.
 */
const deadlineEndedCall = (
  context: ExternalCallContext,
  now: () => number,
): boolean =>
  context.signal.aborted
    ? isTimeoutReason(context.signal.reason)
    : now() >= context.deadline;

/**
 * The failure to record for a call outcome that is not ok.
 *
 * The router reports ANY abort of the signal it is given as `cancelled`. When
 * the lease deadline caused it, the run is recorded as a `timeout` with code
 * `deadline`; a shutdown abort stays `cancelled`. Both are indeterminate, but
 * only one says the lease-bound budget ran out.
 *
 * An error that is not this handler's own is the runtime abandoning a call that
 * ignored its signal: it rejects with the signal's reason, which is classified
 * the same way.
 */
const failureToRecord = (
  error: unknown,
): {
  readonly error: ModelError;
  readonly category: ModelErrorCategory;
  readonly code: string | null;
} => {
  const { modelError, deadlineReached } =
    error instanceof AgentRunCallFailure
      ? error
      : {
          modelError: isAbortReason(error)
            ? new ModelError("cancelled", { code: "aborted" })
            : toModelError(error),
          deadlineReached: isTimeoutReason(error),
        };
  if (modelError.category === "cancelled" && deadlineReached) {
    return { error: modelError, category: "timeout", code: "deadline" };
  }
  return {
    error: modelError,
    category: modelError.category,
    code: modelError.code,
  };
};

export function createAgentRunExecuteHandler(
  dependencies: AgentRunExecuteDependencies,
): AgentRunExecuteHandler {
  const { modelRouter } = dependencies;
  const now = dependencies.now ?? (() => Date.now());

  const refuse = async (
    capabilities: Pick<Capabilities, "refuseAgentRun">,
    runId: string,
    code: RefusalCode,
  ): Promise<PrepareOutcome<never>> => {
    const status = await capabilities.refuseAgentRun(code);
    return {
      kind: "settled",
      detail: `${describeRun(runId, status)} code=${code}`,
    };
  };

  const handler: AgentRunExecuteHandler = {
    kind: AGENT_RUN_EXECUTE_KIND,
    shape: "external_call",
    prepareCapabilities: Object.freeze<PrepareCapability[]>([
      "claimAgentRun",
      "startAgentRun",
      "refuseAgentRun",
    ]),
    settleCapabilities: Object.freeze<SettleCapability[]>([
      "completeAgentRun",
      "failAgentRun",
    ]),

    async prepare(job, capabilities, budget) {
      const parsed = claimSchema.safeParse(await capabilities.claimAgentRun());
      if (!parsed.success) {
        // Fixed text: zod's issues quote the received value, and the received
        // value holds task and agent text.
        throw new PermanentError(
          "ops.claim_agent_run returned a shape this handler does not accept; nothing was started",
        );
      }
      const claim = parsed.data;

      // Before anything else acts on the claim. A payload naming a different
      // run is a forged or mis-routed job, and it is refused rather than
      // quietly corrected, so the attempt that tried is on the record.
      if (payloadObject(job.payload).agent_run_id !== claim.agent_run_id) {
        throw new SecurityError(
          "the job's agent_run_id does not name the run its lease is bound to",
        );
      }

      if (claim.action === "settled") {
        return {
          kind: "settled",
          detail: describeRun(claim.agent_run_id, claim.status),
        };
      }
      if (claim.capability !== TASK_ASSESSMENT_CAPABILITY) {
        return refuse(
          capabilities,
          claim.agent_run_id,
          "capability_unsupported",
        );
      }
      const route = modelRouter.resolve(claim.model_route);
      if (!route) {
        return refuse(capabilities, claim.agent_run_id, "route_unavailable");
      }
      if (budget.remainingMs() < MIN_CALL_BUDGET_MS) {
        throw new TransientError("lease too short to start a model call");
      }

      const prompt = buildTaskAssessmentPrompt({
        agent: {
          name: claim.agent.name,
          role: claim.agent.role,
          description: claim.agent.description,
        },
        task: {
          type: claim.task.type,
          title: claim.task.title,
          description: claim.task.description,
          priority: claim.task.priority,
          dueAt: claim.task.due_at,
        },
      });
      // The SAME builder the router sends with, so the stored fingerprint is a
      // fingerprint of the request the provider receives.
      const inputFingerprint = fingerprintModelRequest(
        buildModelRequest(route, prompt, taskAssessmentContract),
        route.provider,
        prompt.promptVersion,
      );

      const status = await capabilities.startAgentRun({
        provider: route.provider,
        model: route.model,
        promptVersion: prompt.promptVersion,
        inputFingerprint,
        // The ceiling buildModelRequest put in the request above. The database
        // reserves spend against it and refuses one that is not the route's.
        maxOutputTokens: route.policy.maxOutputTokens,
      });
      // A start that raises (budget contention is OS429) records nothing: it
      // rolls the prepare transaction back, the job retries on its backoff and
      // the run stays pending, so nothing is called.
      //
      // Only `running` means "call". `stopped` is held: the start wrote
      // nothing and still holds the kill-switch lock, so the runtime defers the
      // job in this transaction and the run stays pending until the stop is
      // cleared. `cancelled` (a gate), `already_running`, `indeterminate`,
      // a finished status, or a token nobody defined all mean the same thing
      // here: never call.
      if (status === "stopped") {
        return { kind: "held" };
      }
      if (status !== "running") {
        return {
          kind: "settled",
          detail: describeRun(claim.agent_run_id, status),
        };
      }
      // The start can wait on the task, organisation, kill-switch and spend locks. A
      // lease that ran short meanwhile starts nothing: throwing rolls the prepare
      // transaction back, so `running` is never committed and no call follows.
      if (budget.remainingMs() < MIN_CALL_BUDGET_MS) {
        throw new TransientError(
          "lease ran too short while the run was started; nothing was called",
        );
      }

      return {
        kind: "call",
        state: Object.freeze({
          runId: claim.agent_run_id,
          route,
          prompt,
          promptVersion: prompt.promptVersion,
        }),
      };
    },

    async call(state, context) {
      try {
        return await modelRouter.executeStructured(
          state.route,
          state.prompt,
          taskAssessmentContract,
          context.signal,
        );
      } catch (error) {
        throw new AgentRunCallFailure(
          toModelError(error),
          deadlineEndedCall(context, now),
        );
      }
    },

    async settle(
      state,
      outcome: CallOutcome<StructuredModelResult<TaskAssessment>>,
      capabilities,
    ) {
      if (outcome.ok) {
        const response = outcome.value;
        const status = await capabilities.completeAgentRun({
          result: response.value,
          responseModel: response.model,
          finishReason: response.finishReason,
          providerRequestId: response.providerRequestId,
          providerResponseId: response.providerResponseId,
          usage: response.usage,
          latencyMs: response.latencyMs,
        });
        requireOwnSettlement(status, COMPLETION_STATUSES);
        return describeSettlement(state, status, response.usage, null);
      }

      const failure = failureToRecord(outcome.error);
      const status = await capabilities.failAgentRun({
        category: failure.category,
        code: failure.code,
        responseModel: failure.error.model,
        providerRequestId: failure.error.providerRequestId,
        providerResponseId: failure.error.providerResponseId,
        usage: failure.error.usage,
        latencyMs:
          failure.error.latencyMs ?? normalizeLatencyMs(outcome.durationMs),
      });
      requireOwnSettlement(status, FAILURE_STATUSES);
      return describeSettlement(
        state,
        status,
        failure.error.usage,
        failure.category,
      );
    },
  };
  return Object.freeze(handler);
}
