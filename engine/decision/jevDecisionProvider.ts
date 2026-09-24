// The Jev boundary (Phase 2D.1). "Jev" is the owner's name for the future
// decision provider behind the DecisionPort (docs/PHASE_2C_BRIEF.md §22,
// decision P). No Jev package, API, endpoint, protocol or credential has been
// approved or verified, so this adapter invents none: it has the port's shape,
// its own identity, and an evaluate that never reaches anything and reports
// the provider as unavailable. Wiring a real Jev is a later, separate slice
// that must go through the governed external call (price, spend limits, the
// kill switch, at most once) this job kind already runs under.

import {
  DecisionProviderUnavailableError,
  type DecisionPort,
} from "./decisionPort.ts";
import type { DecisionProviderIdentity } from "./decisionVector.ts";

export const JEV_DECISION_PROVIDER: DecisionProviderIdentity = Object.freeze({
  kind: "jev",
  id: "jev",
  version: "unconnected",
});

export function createJevDecisionProvider(): DecisionPort {
  return Object.freeze({
    identity: JEV_DECISION_PROVIDER,
    async evaluate(): Promise<unknown> {
      throw new DecisionProviderUnavailableError("jev_contract_not_approved");
    },
  });
}
