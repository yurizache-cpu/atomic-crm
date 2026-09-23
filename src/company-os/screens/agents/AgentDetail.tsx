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
import { agentDisplayName } from "../../format/displayNames";
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
      <Section title={agentDisplayName(agent.name)}>
        <Fields label="Configuração do agente">
          <Field term="Identificador">
            <IdText id={agent.id} />
          </Field>
          <Field term="Nome interno">{agent.slug}</Field>
          <Field term="Empresa">{agent.company.name}</Field>
          <Field term="Departamento">{agent.department.name}</Field>
          <Field term="Última execução">
            <Timestamp value={agent.lastRunAt} />
          </Field>
        </Fields>
      </Section>
      <Section title="Situação">
        {current ? null : (
          <p role="status" className="text-sm font-medium">
            {STATE_UNKNOWN_NOTE}
          </p>
        )}
        <AgentStateBadges agent={agent} current={current} />
        <Fields label="O que comprova a situação">
          <Field term="Execuções que precisam de atenção">
            {current ? (
              <span>{agent.attentionCount}</span>
            ) : (
              <StateBadge value="unknown" />
            )}
          </Field>
          {current ? <AgentEvidenceFields agent={agent} /> : null}
        </Fields>
      </Section>
      <Section title="Execuções recentes">
        {data.recentRuns.length === 0 ? (
          <Note>Este agente ainda não tem execuções.</Note>
        ) : (
          <RunTable
            runs={data.recentRuns}
            label="Execuções recentes"
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
    <QueryView query={agent} what="o agente">
      {(data) => (
        <AgentDetailBody data={data} receivedAt={agent.dataUpdatedAt} />
      )}
    </QueryView>
  );
};

export const AgentDetail = () => {
  const agentId = useRouteRecordId("agentId");
  return (
    <ScreenLayout title="Agente">
      <BackToAgents />
      {agentId === null ? (
        <RecordNotFound />
      ) : (
        <AgentDetailRead agentId={agentId} />
      )}
    </ScreenLayout>
  );
};
