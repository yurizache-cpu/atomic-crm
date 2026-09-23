import { Link } from "react-router";

import { type AgentDetail as AgentDetailData } from "../../../../contracts/company-os-api/index.ts";
import {
  Field,
  Fields,
  IdText,
  Note,
  ScreenLayout,
  Section,
  StateBadge,
  Timestamp,
} from "../../components/display";
import { QueryView } from "../../components/queryStates";
import { RecordNotFound } from "../../components/RecordNotFound";
import { useRouteRecordId } from "../../components/routeRecord";
import { LIST_PATHS } from "../../components/recordPaths";
import { STATE_UNKNOWN_NOTE } from "../../copy";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";
import { useIsStateCurrent } from "../../query/useIsStateCurrent";
import { RunTable } from "../runs/RunTable";
import { AgentEvidenceFields, AgentStateBadges } from "./AgentState";

// One agent (get_agent): its configuration labels, its state with every id
// that proves it, and its 20 most recent runs. Read every 15 s while visible,
// like the list; never the agent's role or description (configuration free
// text the projection leaves out).

const BackToAgents = () => (
  <Link to={LIST_PATHS.agents} className="text-sm underline underline-offset-4">
    All agents
  </Link>
);

const AgentDetailBody = ({
  data,
  receivedAt,
}: {
  data: AgentDetailData;
  receivedAt: number;
}) => {
  const current = useIsStateCurrent(receivedAt);
  const { agent } = data;
  return (
    <>
      <Section title={agent.name}>
        <Fields label="Agent configuration">
          <Field term="Agent id">
            <IdText id={agent.id} />
          </Field>
          <Field term="Slug">{agent.slug}</Field>
          <Field term="Company">{agent.company.name}</Field>
          <Field term="Department">{agent.department.name}</Field>
          <Field term="Last run">
            <Timestamp value={agent.lastRunAt} />
          </Field>
        </Fields>
      </Section>
      <Section title="State">
        {current ? null : (
          <p role="status" className="text-sm font-medium">
            {STATE_UNKNOWN_NOTE}
          </p>
        )}
        <AgentStateBadges agent={agent} current={current} />
        <Fields label="Agent state evidence">
          <Field term="Runs needing attention (count)">
            {current ? (
              <span>{agent.attentionCount}</span>
            ) : (
              <StateBadge value="unknown" />
            )}
          </Field>
          {current ? <AgentEvidenceFields agent={agent} /> : null}
        </Fields>
      </Section>
      <Section title="Recent runs">
        {data.recentRuns.length === 0 ? (
          <Note>This agent has no run yet.</Note>
        ) : (
          <RunTable
            runs={data.recentRuns}
            label="Recent runs"
            current={current}
          />
        )}
      </Section>
    </>
  );
};

const AgentDetailRead = ({ agentId }: { agentId: string }) => {
  const agent = useCompanyOsQuery(
    "get_agent",
    { p_agent_id: agentId },
    { poll: true },
  );
  return (
    <QueryView query={agent} what="the agent">
      {(data) => (
        <AgentDetailBody data={data} receivedAt={agent.dataUpdatedAt} />
      )}
    </QueryView>
  );
};

export const AgentDetail = () => {
  const agentId = useRouteRecordId("agentId");
  return (
    <ScreenLayout title="Agent">
      <BackToAgents />
      {agentId === null ? (
        <RecordNotFound />
      ) : (
        <AgentDetailRead agentId={agentId} />
      )}
    </ScreenLayout>
  );
};
