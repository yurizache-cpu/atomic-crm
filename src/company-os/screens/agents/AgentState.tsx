import type { ReactNode } from "react";

import type { AgentSummary } from "../../../../contracts/company-os-api/index.ts";
import {
  Field,
  IdText,
  None,
  RunLinks,
  StateBadge,
} from "../../components/display";
import { humanize } from "../../format/labels";
import { shownActivity } from "./activityRule";

// An agent's state as docs/PHASE_2C_BRIEF.md §10 requires it to be shown:
// availability and activity are two badges, so "stopped" and "working" appear
// together when both hold; "working" appears only with at least one working
// run id, each linking to its run, never from the activity value alone; and an
// answer older than two polling intervals shows "unknown" instead of either.

export const AgentStateBadges = ({
  agent,
  current,
}: {
  agent: AgentSummary;
  current: boolean;
}) => (
  <span className="flex flex-wrap items-center gap-2">
    <StateBadge
      value={current ? agent.availability : "unknown"}
      label={`availability: ${current ? humanize(agent.availability) : "unknown"}`}
    />
    <StateBadge
      value={current ? shownActivity(agent) : "unknown"}
      label={`activity: ${current ? humanize(shownActivity(agent)) : "unknown"}`}
    />
  </span>
);

const EvidenceGroup = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <span className="flex flex-wrap items-center gap-1 text-xs">
    <span className="text-muted-foreground">{`${label}:`}</span>
    {children}
  </span>
);

/**
 * The list's proof beside the badges: every non-empty group of run ids, each
 * a link, and the stop or the inactive unit. Nothing while the state is
 * unknown, and the working runs only where "working" is shown.
 */
export const ListEvidence = ({
  agent,
  current,
}: {
  agent: AgentSummary;
  current: boolean;
}) => {
  if (!current) return null;
  const { evidence } = agent;
  const working =
    shownActivity(agent) === "working" ? evidence.workingRunIds : [];
  const groups = [
    { label: "working runs", ids: working },
    { label: "stale runs", ids: evidence.staleRunIds },
    { label: "held runs", ids: evidence.heldRunIds },
    { label: "queued runs", ids: evidence.queuedRunIds },
  ].filter((group) => group.ids.length > 0);
  return (
    <span className="flex flex-col gap-1">
      {groups.map((group) => (
        <EvidenceGroup key={group.label} label={group.label}>
          <RunLinks ids={group.ids} />
        </EvidenceGroup>
      ))}
      {evidence.stop === null ? null : (
        <EvidenceGroup label="stop">
          <IdText id={evidence.stop.id} />
        </EvidenceGroup>
      )}
      {evidence.inactiveUnit === null ? null : (
        <EvidenceGroup label="inactive unit">
          <span>{evidence.inactiveUnit}</span>
        </EvidenceGroup>
      )}
    </span>
  );
};

const StopEvidence = ({ stop }: { stop: AgentSummary["evidence"]["stop"] }) =>
  stop === null ? (
    <None>no stop naming this tenant covers this agent</None>
  ) : (
    <span className="flex flex-wrap items-center gap-2">
      <IdText id={stop.id} />
      <span>{`scope ${humanize(stop.scope)}, origin ${stop.origin}`}</span>
    </span>
  );

/** Every id that proves the agent's state, as definition-list rows. */
export const AgentEvidenceFields = ({ agent }: { agent: AgentSummary }) => {
  const { evidence } = agent;
  return (
    <>
      <Field term="Working runs (live lease)">
        <RunLinks ids={evidence.workingRunIds} />
      </Field>
      <Field term="Stale runs (no live lease)">
        <RunLinks ids={evidence.staleRunIds} />
      </Field>
      <Field term="Held runs">
        <RunLinks ids={evidence.heldRunIds} />
      </Field>
      <Field term="Queued runs">
        <RunLinks ids={evidence.queuedRunIds} />
      </Field>
      <Field term="Runs needing attention">
        <RunLinks ids={evidence.attentionRunIds} />
      </Field>
      <Field term="Covering stop">
        <StopEvidence stop={evidence.stop} />
      </Field>
      <Field term="Inactive unit">
        {evidence.inactiveUnit === null ? (
          <None />
        ) : (
          <span>{evidence.inactiveUnit}</span>
        )}
      </Field>
    </>
  );
};
