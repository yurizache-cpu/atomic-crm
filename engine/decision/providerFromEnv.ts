// Which DecisionPort a worker runs with, from DECISION_SHADOW_PROVIDER. Backend
// only (never VITE_). Shadow evaluation is opt-in per worker deployment:
//
//   unset  -> off: no shadow decision is requested after a triage settles, and
//             a queued one (an owner request) settles `failed`,
//             provider_not_configured, without calling anything;
//   fake   -> the deterministic fake provider (not Jev);
//   jev    -> the Jev boundary, which has no approved contract and calls nothing.
//
// Anything else refuses to start: a misspelt provider is not "off".

import { createFakeDecisionProvider } from "./fakeDecisionProvider.ts";
import { createJevDecisionProvider } from "./jevDecisionProvider.ts";
import {
  UNCONFIGURED_DECISION_PORT,
  type DecisionPort,
} from "./decisionPort.ts";

export interface DecisionShadowConfig {
  readonly port: DecisionPort;
  /** Whether a settled triage requests a shadow decision. */
  readonly requestsShadowDecisions: boolean;
}

export function decisionShadowFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): DecisionShadowConfig {
  const raw = env.DECISION_SHADOW_PROVIDER;
  if (raw === undefined || raw === "") {
    return { port: UNCONFIGURED_DECISION_PORT, requestsShadowDecisions: false };
  }
  if (raw === "fake") {
    return {
      port: createFakeDecisionProvider(),
      requestsShadowDecisions: true,
    };
  }
  if (raw === "jev") {
    return { port: createJevDecisionProvider(), requestsShadowDecisions: true };
  }
  throw new Error(
    'DECISION_SHADOW_PROVIDER must be unset, "fake" or "jev"; refusing to start',
  );
}
