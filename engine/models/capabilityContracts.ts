// Capability -> (prompt builder, output contract). The one place that knows
// which capabilities an agent run can have.
//
// It exists because the handler must NOT: before Phase 2A there was one
// capability and `agentRunExecute.ts` named it directly, which meant adding the
// second one would have put a growing switch inside the runtime that carries
// the lease, the fingerprint and the at-most-once settlement. A capability is a
// pair of pure values; the runtime should look it up and stay unchanged.
//
// THE DATABASE IS THE AUTHORITY on which capabilities exist:
// ops.agent_run_capabilities() decides what may be requested and on which model
// route, and ops.agent_run_result_valid() re-checks the stored result. This map
// must hold every capability that function offers — a capability the database
// admits and this map lacks is refused by the handler as
// `capability_unsupported`, which records the refusal rather than calling
// anything. A driver-backed test asserts the two agree.

import type { OutputContract } from "./outputContract.ts";
import type { AgentRunPromptContext, BuiltPrompt } from "./promptText.ts";
import {
  buildLeadTriagePrompt,
  LEAD_TRIAGE_CAPABILITY,
  leadTriageContract,
  type LeadTriage,
} from "./leadTriage.ts";
import {
  buildTaskAssessmentPrompt,
  TASK_ASSESSMENT_CAPABILITY,
  taskAssessmentContract,
  type TaskAssessment,
} from "./taskAssessment.ts";

/** Every shape a successful agent run can carry. */
export type AgentRunResult = TaskAssessment | LeadTriage;

export interface CapabilityBinding {
  /** The strict output contract, validated in this process and again by the database. */
  readonly contract: OutputContract<AgentRunResult>;
  /** Builds the prompt from the bounded context ops.claim_agent_run() returned. */
  readonly buildPrompt: (context: AgentRunPromptContext) => BuiltPrompt;
}

// A Map, not an object literal: `AGENT_RUN_CAPABILITIES.get("toString")` is
// undefined, so a capability name that arrives from the database can never
// resolve to something inherited.
export const AGENT_RUN_CAPABILITIES: ReadonlyMap<string, CapabilityBinding> =
  new Map<string, CapabilityBinding>([
    [
      TASK_ASSESSMENT_CAPABILITY,
      Object.freeze({
        contract: taskAssessmentContract,
        buildPrompt: buildTaskAssessmentPrompt,
      }),
    ],
    [
      LEAD_TRIAGE_CAPABILITY,
      Object.freeze({
        contract: leadTriageContract,
        buildPrompt: buildLeadTriagePrompt,
      }),
    ],
  ]);

/** The capability names this worker can execute, in registration order. */
export const SUPPORTED_CAPABILITIES: readonly string[] = Object.freeze([
  ...AGENT_RUN_CAPABILITIES.keys(),
]);
