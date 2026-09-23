import type { AgentSummary } from "../../../../contracts/company-os-api/index.ts";

/**
 * The activity the UI may print (docs/PHASE_2C_BRIEF.md §10): "working" needs
 * at least one working run id as its evidence, whatever the activity says.
 */
export const shownActivity = (agent: AgentSummary): string =>
  agent.activity === "working" && agent.evidence.workingRunIds.length === 0
    ? "unknown"
    : agent.activity;
