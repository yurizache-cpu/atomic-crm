// Agents and their truthful state (docs/PHASE_2C_BRIEF.md §9, §10; SI-57).
//
// Two axes and attention, as ops.agent_operational_state computes them. The
// refinement below restates the projection's own precedence, so the contract
// refuses what the UI must never render: "working" without a working run id,
// "stopped" without the stop that proves it, "inactive" without the unit.
// Never the agent's role or description (configuration free text).

import { z } from "zod";
import {
  CountSchema,
  ENVELOPE_SHAPE,
  NameSchema,
  NamedRefSchema,
  SlugSchema,
  TimestampSchema,
  UuidSchema,
} from "./primitives.ts";
import { AgentRunSummarySchema } from "./runs.ts";
import { TenantStopRefSchema } from "./stops.ts";
import {
  AgentActivitySchema,
  AgentAvailabilitySchema,
  OrgUnitSchema,
} from "./vocabulary.ts";

/** Evidence arrays are capped at 20 ids; the counts are not. */
const RunIdsSchema = z.array(UuidSchema).max(20);

const AgentSummaryObjectSchema = z.strictObject({
  id: UuidSchema,
  slug: SlugSchema,
  name: NameSchema,
  company: NamedRefSchema,
  department: NamedRefSchema,
  availability: AgentAvailabilitySchema,
  activity: AgentActivitySchema,
  attentionCount: CountSchema,
  lastRunAt: TimestampSchema.nullable(),
  evidence: z.strictObject({
    workingRunIds: RunIdsSchema,
    heldRunIds: RunIdsSchema,
    queuedRunIds: RunIdsSchema,
    staleRunIds: RunIdsSchema,
    attentionRunIds: RunIdsSchema,
    stop: TenantStopRefSchema.nullable(),
    inactiveUnit: OrgUnitSchema.nullable(),
  }),
});

type AgentSummaryObject = z.infer<typeof AgentSummaryObjectSchema>;

/** The activity the evidence proves, in the projection's precedence. */
export const activityProvenBy = (
  evidence: AgentSummaryObject["evidence"],
): AgentSummaryObject["activity"] => {
  if (evidence.workingRunIds.length > 0) return "working";
  if (evidence.staleRunIds.length > 0) return "stale";
  if (evidence.heldRunIds.length > 0) return "held";
  if (evidence.queuedRunIds.length > 0) return "queued";
  return "idle";
};

export const AgentSummarySchema = AgentSummaryObjectSchema.superRefine(
  (agent, ctx) => {
    const { evidence } = agent;
    if (agent.activity !== activityProvenBy(evidence)) {
      ctx.addIssue({
        code: "custom",
        path: ["activity"],
        message: "activity is not the one its evidence proves",
      });
    }
    const inactive = evidence.inactiveUnit !== null;
    const expected = inactive
      ? "inactive"
      : evidence.stop !== null
        ? "stopped"
        : "available";
    if (agent.availability !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["availability"],
        message: "availability is not the one its evidence proves",
      });
    }
    if (agent.attentionCount < evidence.attentionRunIds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["attentionCount"],
        message: "attentionCount is below the attention evidence",
      });
    }
  },
);

/** list_agents: at most 500 agents. */
export const AgentListSchema = z.strictObject({
  ...ENVELOPE_SHAPE,
  items: z.array(AgentSummarySchema).max(500),
});

/** get_agent: the agent's state and its 20 most recent runs. */
export const AgentDetailSchema = z.strictObject({
  ...ENVELOPE_SHAPE,
  agent: AgentSummarySchema,
  recentRuns: z.array(AgentRunSummarySchema).max(20),
});

export type AgentSummary = z.infer<typeof AgentSummarySchema>;
export type AgentList = z.infer<typeof AgentListSchema>;
export type AgentDetail = z.infer<typeof AgentDetailSchema>;
