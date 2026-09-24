// decision.shadow_evaluate (Phase 2D.1): ONE shadow decision, through the
// DecisionPort, under the governed external-call shape every provider call uses.
//
//   prepare  (TX2a, committed) start the evaluation the LEASE is bound to: the
//            database re-checks the synthetic and test scope and the stops,
//            records `running` with this provider, and hands back the
//            allowlisted input and the vector version the evaluation's policy
//            accepts (Phase 2D.2). `stopped` holds the job; anything but
//            `running` settles it without asking anyone. A policy whose vector
//            version this worker does not answer with rolls the start back:
//            the evaluation stays pending, for a compatible worker or the
//            owner's `decision recover`.
//   call     (no transaction, no capabilities) ask the provider. Data in, an
//            unknown value out; nothing here can reach the database.
//   settle   (TX2b) validate the answer against the strict vector schema, the
//            provider that was started and the input's fingerprint, then store
//            it; the database validates it again and applies the deterministic
//            policy. An answer that fails is stored `invalid`, never coerced.
//            A provider that was never reached is `failed`; any other failure
//            is `indeterminate`, and nothing asks again (at most once).
//
// ADVISORY ONLY. The handler holds no capability that decides a review, sends,
// writes the CRM, trips or clears a stop, or changes a budget, and it declares
// no post-settlement step. The human review stays required whatever the
// provider answers.

import { z } from "zod";
import {
  DecisionProviderUnavailableError,
  type DecisionPort,
  type DecisionRequest,
} from "../decision/decisionPort.ts";
import {
  DECISION_VECTOR_VERSION,
  DecisionInputSchema,
  DecisionVectorSchema,
} from "../decision/decisionVector.ts";
import type {
  ExternalCallHandlerDefinition,
  ObservedSettlement,
  PrepareOutcome,
} from "../worker/handlerRegistry.ts";
import type { CallOutcome } from "../worker/handlerRegistry.ts";
import type { ShadowDecisionSettlement } from "../worker/capabilities.ts";
import {
  PermanentError,
  SecurityError,
  TransientError,
} from "../worker/failures.ts";
import { payloadObject } from "../worker/job.ts";

export const DECISION_SHADOW_EVALUATE_KIND = "decision.shadow_evaluate";

/** The least lease a provider call may start with. */
export const MIN_DECISION_CALL_BUDGET_MS = 2_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;

const startSchema = z.object({
  status: z.string(),
  evaluationId: z.string().regex(UUID).optional(),
  inputFingerprint: z.string().optional(),
  input: z.unknown().optional(),
  vectorVersion: z.string().optional(),
  // For telemetry only (Phase 2E.1): the policy version the start recorded.
  policyVersion: z.string().optional(),
});

type PrepareCapability = "startShadowDecision";
type SettleCapability = "settleShadowDecision";

interface ShadowState {
  readonly evaluationId: string;
  /** The evaluation's policy version, for telemetry only. */
  readonly policyVersion: string | undefined;
  /** null when the database's input failed this worker's schema: nothing is asked. */
  readonly request: DecisionRequest | null;
}

export type DecisionShadowEvaluateHandler = ExternalCallHandlerDefinition<
  PrepareCapability,
  SettleCapability,
  ShadowState,
  unknown
>;

const describe = (evaluationId: string, status: string): string =>
  `decision_evaluation=${evaluationId} status=${status}`;

/** What the settlement records for a call that did not answer with a vector. */
function failureSettlement(error: unknown): ShadowDecisionSettlement {
  if (error instanceof DecisionProviderUnavailableError) {
    return {
      outcome: "failed",
      vector: null,
      errorCode: REASON_CODE.test(error.code)
        ? error.code
        : "provider_unavailable",
    };
  }
  // The provider may have been reached and may have answered: unknown.
  return {
    outcome: "indeterminate",
    vector: null,
    errorCode: "provider_error",
  };
}

export function createDecisionShadowEvaluateHandler(dependencies: {
  readonly decisionPort: DecisionPort;
}): DecisionShadowEvaluateHandler {
  const { decisionPort } = dependencies;
  const identity = decisionPort.identity;

  const handler: DecisionShadowEvaluateHandler = {
    kind: DECISION_SHADOW_EVALUATE_KIND,
    shape: "external_call",
    prepareCapabilities: Object.freeze<PrepareCapability[]>([
      "startShadowDecision",
    ]),
    settleCapabilities: Object.freeze<SettleCapability[]>([
      "settleShadowDecision",
    ]),

    async prepare(
      job,
      capabilities,
      budget,
    ): Promise<PrepareOutcome<ShadowState>> {
      const named = payloadObject(job.payload).decision_evaluation_id;
      if (typeof named !== "string" || !UUID.test(named)) {
        throw new PermanentError(
          "the job names no decision evaluation; nothing was started",
        );
      }
      const parsed = startSchema.safeParse(
        await capabilities.startShadowDecision({
          kind: identity.kind,
          id: identity.id,
          version: identity.version,
        }),
      );
      if (!parsed.success) {
        throw new PermanentError(
          "ops.start_shadow_decision returned a shape this handler does not accept",
        );
      }
      const start = parsed.data;
      // A job whose lease is bound to no evaluation, or to another one, is a
      // forged or mis-routed job: refused, on the record.
      if (start.evaluationId !== named) {
        throw new SecurityError(
          "the job's decision_evaluation_id does not name the evaluation its lease is bound to",
        );
      }
      if (start.status === "stopped") {
        return { kind: "held" };
      }
      if (start.status !== "running") {
        return { kind: "settled", detail: describe(named, start.status) };
      }
      // `running` is committed only with this prepare transaction: a lease too
      // short to ask throws, so the start rolls back and nothing is asked.
      if (budget.remainingMs() < MIN_DECISION_CALL_BUDGET_MS) {
        throw new TransientError(
          "lease too short to ask the decision provider; nothing was started",
        );
      }
      // The evaluation's policy names the one vector version it accepts. A
      // worker that answers with another asks nobody, and throws, so the start
      // rolls back and the evaluation stays pending (never burnt as failed).
      if (start.vectorVersion !== DECISION_VECTOR_VERSION) {
        throw new TransientError(
          "this worker does not answer the evaluation's vector version; nothing was started",
        );
      }
      const input = DecisionInputSchema.safeParse(start.input);
      return {
        kind: "call",
        providerKind: identity.kind,
        state: Object.freeze({
          evaluationId: named,
          policyVersion: start.policyVersion,
          request:
            input.success && typeof start.inputFingerprint === "string"
              ? Object.freeze({
                  input: input.data,
                  inputFingerprint: start.inputFingerprint,
                })
              : null,
        }),
      };
    },

    async call(state, context) {
      if (state.request === null) {
        throw new DecisionProviderUnavailableError("input_rejected");
      }
      return decisionPort.evaluate(state.request, { signal: context.signal });
    },

    async settle(
      state,
      outcome: CallOutcome<unknown>,
      capabilities,
    ): Promise<ObservedSettlement> {
      let settlement: ShadowDecisionSettlement;
      if (outcome.ok) {
        const vector = DecisionVectorSchema.safeParse(outcome.value);
        const matches =
          vector.success &&
          vector.data.provider.kind === identity.kind &&
          vector.data.provider.id === identity.id &&
          vector.data.provider.version === identity.version &&
          vector.data.inputFingerprint === state.request?.inputFingerprint;
        settlement = matches
          ? { outcome: "completed", vector: vector.data, errorCode: null }
          : { outcome: "invalid", vector: null, errorCode: "vector_rejected" };
      } else {
        settlement = failureSettlement(outcome.error);
      }
      const status = await capabilities.settleShadowDecision(settlement);
      if (status === "not_running") {
        throw new PermanentError(
          "the shadow decision was not this attempt's to settle",
        );
      }
      return {
        detail: describe(state.evaluationId, status),
        observation: {
          subject: "decision_evaluation",
          status,
          policyVersion: state.policyVersion,
        },
      };
    },
  };
  return Object.freeze(handler);
}
