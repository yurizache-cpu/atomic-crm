import { Route, Routes, useSearchParams } from "react-router";

import { Bot } from "lucide-react";

import {
  AGENT_ACTIVITIES,
  AGENT_AVAILABILITIES,
  type AgentSummary,
} from "../../../../contracts/company-os-api/index.ts";
import { ScreenLayout } from "../../components/display";
import { EmptyState } from "../../components/owner";
import { QueryView } from "../../components/queryStates";
import {
  FilterBar,
  SearchParamSelect,
} from "../../components/SearchParamSelect";
import { STATE_UNKNOWN_NOTE } from "../../copy";
import { oneOf, optionsOf } from "../../format/labels";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";
import { useIsStateCurrent } from "../../query/useIsStateCurrent";
import { AgentDetail } from "./AgentDetail";
import { activityLabel, availabilityLabel } from "../../format/ptBR";
import { AgentCard } from "./AgentCard";

// Screen 4, Agents (docs/PHASE_2C_BRIEF.md §12): configuration labels,
// availability, activity and attention, with the run and stop ids that prove
// them, read every 15 s while the tab is visible. The activity and
// availability filters narrow the one answer list_agents gave; they read
// nothing else.

const matchesFilters = (
  agent: AgentSummary,
  activity: string | null,
  availability: string | null,
) =>
  (activity === null || agent.activity === activity) &&
  (availability === null || agent.availability === availability);

const AgentGrid = ({
  agents,
  receivedAt,
}: {
  agents: readonly AgentSummary[];
  receivedAt: number;
}) => {
  const current = useIsStateCurrent(receivedAt);
  const [params] = useSearchParams();
  const activity = oneOf(params.get("activity"), AGENT_ACTIVITIES);
  const availability = oneOf(params.get("availability"), AGENT_AVAILABILITIES);
  const shown = agents.filter((agent) =>
    matchesFilters(agent, activity, availability),
  );
  return (
    <>
      {current ? null : (
        <p role="status" className="text-sm font-medium">
          {STATE_UNKNOWN_NOTE}
        </p>
      )}
      <div
        role="list"
        aria-label="Equipe de IA"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
      >
        {shown.map((agent) => (
          <div role="listitem" key={agent.id}>
            <AgentCard agent={agent} current={current} />
          </div>
        ))}
      </div>
      {shown.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="Nenhum agente corresponde a este filtro."
        />
      ) : null}
    </>
  );
};

const AgentList = () => {
  const agents = useCompanyOsQuery("list_agents", {}, { poll: true });
  return (
    <ScreenLayout
      title="Equipe de IA"
      description="Quem está disponível, trabalhando ou pausado agora, como o servidor calculou."
    >
      <FilterBar>
        <SearchParamSelect
          label="Atividade"
          param="activity"
          options={optionsOf(AGENT_ACTIVITIES, activityLabel)}
        />
        <SearchParamSelect
          label="Disponibilidade"
          param="availability"
          options={optionsOf(AGENT_AVAILABILITIES, availabilityLabel)}
        />
      </FilterBar>
      <QueryView query={agents} what="a equipe">
        {(data) => (
          <AgentGrid agents={data.items} receivedAt={agents.dataUpdatedAt} />
        )}
      </QueryView>
    </ScreenLayout>
  );
};

export const AgentsScreen = () => (
  <Routes>
    <Route index element={<AgentList />} />
    <Route path=":agentId" element={<AgentDetail />} />
  </Routes>
);
