// decision.structured_evaluate (ADR 0022 §E): one structured decision (Jev),
// shadow only, at most once.
//
// prepare: ops.start_structured_decision(gateway) records the decision
//   `running` with the model the DATABASE chose (the rank-1 enabled, priced
//   member of the structured_decision pool on this gateway), the allowlisted
//   input and the question spec, before anything is asked. Protected data, no
//   model or no budget is refused there, with no call. The question set for the
//   kind is built here from that input, and its option keys must equal the
//   spec's exactly; a mismatch asks nobody and settles failed.
// call:    exactly one Decisions API request; no retry, no fallback model.
// settle:  the answers are held to the questions asked (parseDecisionAnswers),
//          then to the spec again by the database. Unusable answers are
//          `invalid`; a known refusal `failed`; anything ambiguous
//          `indeterminate`. Nothing downstream changes: nothing reads it to act.

import { z } from "zod";
import {
  buildBusinessRoutingRequest,
  BUSINESS_ROUTING_VERSION,
} from "../decision/structured/businessRouting.ts";
import {
  buildLeadIntelligenceRequest,
  LEAD_INTELLIGENCE_VERSION,
} from "../decision/structured/leadIntelligence.ts";
import {
  buildModelRouteRequest,
  MODEL_ROUTE_VERSION,
} from "../decision/structured/modelRouteAdvice.ts";
import {
  DecisionAnswerError,
  parseDecisionAnswers,
  type DecisionQuestions,
  type StructuredDecisionGateway,
  type StructuredDecisionRequest,
  type StructuredDecisionResponse,
} from "../decision/structured/types.ts";
import {
  agentRunStatusForCategory,
  ModelError,
  toModelError,
} from "../models/errors.ts";
import { normalizeLatencyMs } from "../models/types.ts";
import type { StructuredDecisionSettlement } from "../worker/capabilities.ts";
import {
  PermanentError,
  SecurityError,
  TransientError,
} from "../worker/failures.ts";
import type {
  CallOutcome,
  ExternalCallHandlerDefinition,
  PrepareOutcome,
} from "../worker/handlerRegistry.ts";
import { payloadObject } from "../worker/job.ts";

export const STRUCTURED_DECISION_EVALUATE_KIND = "decision.structured_evaluate";

/** The least lease a decision call may start with. */
export const MIN_STRUCTURED_DECISION_BUDGET_MS = 2_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type PrepareCapability = "startStructuredDecision";
type SettleCapability = "settleStructuredDecision";

const startSchema = z.object({
  status: z.string(),
  decisionId: z.string().optional(),
  kind: z
    .enum(["business_route", "lead_intelligence", "model_route"])
    .optional(),
  questionSet: z.string().optional(),
  model: z.string().optional(),
  acceptedBuilds: z.array(z.string()).optional(),
  input: z.unknown().optional(),
  spec: z.record(z.string(), z.unknown()).optional(),
});

const specEntry = z.union([
  z.object({ type: z.literal("choice"), options: z.array(z.string()) }),
  z.object({ type: z.literal("score"), levels: z.number().int() }),
  z.object({ type: z.literal("noul") }),
]);

export interface StructuredDecisionState {
  readonly decisionId: string;
  readonly kind: string;
  readonly model: string;
  readonly acceptedBuilds: readonly string[];
  /** Null when the input or the spec could not be turned into this kind's questions: nobody is asked. */
  readonly request: StructuredDecisionRequest | null;
  readonly rejection: string | null;
}

export type StructuredDecisionEvaluateHandler = ExternalCallHandlerDefinition<
  PrepareCapability,
  SettleCapability,
  StructuredDecisionState,
  StructuredDecisionResponse
>;

/** The question set this worker builds for a kind, from the database's input. */
const buildRequest = (
  kind: string,
  questionSet: string | undefined,
  model: string,
  input: unknown,
): StructuredDecisionRequest => {
  const record = (input ?? {}) as Record<string, unknown>;
  if (kind === "business_route" && questionSet === BUSINESS_ROUTING_VERSION) {
    return buildBusinessRoutingRequest(model, {
      sourceClass: record.sourceClass as "synthetic" | "test",
      message: String(record.message ?? ""),
      departments: z.array(z.string()).parse(record.departments),
      capabilities: z.array(z.string()).parse(record.capabilities),
    });
  }
  if (
    kind === "lead_intelligence" &&
    questionSet === LEAD_INTELLIGENCE_VERSION
  ) {
    return buildLeadIntelligenceRequest(model, record as never);
  }
  if (kind === "model_route" && questionSet === MODEL_ROUTE_VERSION) {
    return buildModelRouteRequest(model, record as never);
  }
  throw new Error("this worker does not build that question set");
};

/** The questions must offer exactly what the database recorded as asked. */
const matchesSpec = (
  questions: DecisionQuestions,
  spec: Readonly<Record<string, unknown>>,
): boolean => {
  const keys = Object.keys(questions).sort();
  const specKeys = Object.keys(spec).sort();
  if (keys.join("|") !== specKeys.join("|")) return false;
  for (const key of keys) {
    const entry = specEntry.safeParse(spec[key]);
    const question = questions[key];
    if (!entry.success || entry.data.type !== question.type) return false;
    if (entry.data.type === "choice" && question.type === "choice") {
      if (
        Object.keys(question.criteria).join("|") !==
        entry.data.options.join("|")
      ) {
        return false;
      }
    }
    if (entry.data.type === "score" && question.type === "score") {
      if (question.criteria.length !== entry.data.levels) return false;
    }
  }
  return true;
};

const describe = (id: string, status: string): string =>
  `structured_decision=${id} status=${/^[a-z][a-z_]{0,39}$/.test(status) ? status : "unrecognized"}`;

export function createStructuredDecisionEvaluateHandler(dependencies: {
  readonly gateway: StructuredDecisionGateway;
}): StructuredDecisionEvaluateHandler {
  const { gateway } = dependencies;

  const handler: StructuredDecisionEvaluateHandler = {
    kind: STRUCTURED_DECISION_EVALUATE_KIND,
    shape: "external_call",
    prepareCapabilities: Object.freeze<PrepareCapability[]>([
      "startStructuredDecision",
    ]),
    settleCapabilities: Object.freeze<SettleCapability[]>([
      "settleStructuredDecision",
    ]),

    async prepare(
      job,
      capabilities,
      budget,
    ): Promise<PrepareOutcome<StructuredDecisionState>> {
      const named = payloadObject(job.payload).structured_decision_id;
      if (typeof named !== "string" || !UUID.test(named)) {
        throw new PermanentError(
          "the job names no structured decision; nothing was started",
        );
      }
      const parsed = startSchema.safeParse(
        await capabilities.startStructuredDecision(gateway.name),
      );
      if (!parsed.success) {
        throw new PermanentError(
          "ops.start_structured_decision returned a shape this handler does not accept",
        );
      }
      const start = parsed.data;
      if (start.decisionId !== named) {
        throw new SecurityError(
          "the job's structured_decision_id does not name the decision its lease is bound to",
        );
      }
      if (start.status === "stopped") return { kind: "held" };
      if (start.status !== "running") {
        return { kind: "settled", detail: describe(named, start.status) };
      }
      if (budget.remainingMs() < MIN_STRUCTURED_DECISION_BUDGET_MS) {
        throw new TransientError(
          "lease too short to ask the decision model; nothing was started",
        );
      }
      const model = start.model ?? "";
      let request: StructuredDecisionRequest | null = null;
      let rejection: string | null = null;
      try {
        const built = buildRequest(
          start.kind ?? "",
          start.questionSet,
          model,
          start.input,
        );
        request = Object.freeze({
          ...built,
          acceptedResponseModels: Object.freeze([
            ...(start.acceptedBuilds ?? []),
          ]),
        });
        if (!matchesSpec(request.questions, start.spec ?? {})) {
          request = null;
          rejection = "question_spec_mismatch";
        }
      } catch {
        request = null;
        rejection = "input_rejected";
      }
      return {
        kind: "call",
        providerKind: gateway.name,
        state: Object.freeze({
          decisionId: named,
          kind: start.kind ?? "",
          model,
          acceptedBuilds: Object.freeze([...(start.acceptedBuilds ?? [])]),
          request,
          rejection,
        }),
      };
    },

    async call(state, context) {
      if (state.request === null) {
        // Never reached: the settlement below records it failed, with no call.
        throw new ModelError("configuration", {
          code: state.rejection ?? "input_rejected",
        });
      }
      return gateway.decide(state.request, context.signal);
    },

    async settle(
      state,
      outcome: CallOutcome<StructuredDecisionResponse>,
      capabilities,
    ) {
      let settlement: StructuredDecisionSettlement;
      if (outcome.ok) {
        const response = outcome.value;
        const base = {
          servedModel: response.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          reportedCostMicros: response.reportedCostMicros,
          latencyMs: normalizeLatencyMs(response.latencyMs),
          providerRoute: response.providerRoute,
        };
        try {
          const answers = parseDecisionAnswers(
            state.request!.questions,
            response.answers,
          );
          settlement = {
            ...base,
            outcome: "completed",
            answers,
            errorCode: null,
          };
        } catch (error) {
          settlement = {
            ...base,
            outcome: "invalid",
            answers: null,
            errorCode:
              error instanceof DecisionAnswerError
                ? "answers_rejected"
                : "answers_unreadable",
          };
        }
      } else {
        const error = toModelError(outcome.error);
        const known = agentRunStatusForCategory(error.category) === "failed";
        settlement = {
          outcome: known ? "failed" : "indeterminate",
          answers: null,
          servedModel: error.model ?? null,
          inputTokens: error.usage?.inputTokens ?? null,
          outputTokens: error.usage?.outputTokens ?? null,
          reportedCostMicros: error.reportedCostMicros,
          latencyMs: normalizeLatencyMs(error.latencyMs ?? outcome.durationMs),
          providerRoute: error.providerRoute,
          errorCode: /^[a-z][a-z0-9_]{0,63}$/.test(error.code ?? "")
            ? error.code
            : error.category,
        };
      }
      const status = await capabilities.settleStructuredDecision(settlement);
      if (status === "not_running") {
        throw new PermanentError(
          "the structured decision was not this attempt's to settle",
        );
      }
      return describe(state.decisionId, status);
    },
  };
  return Object.freeze(handler);
}
