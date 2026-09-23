import { Route, Routes, useSearchParams } from "react-router";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import {
  AGENT_ACTIVITIES,
  AGENT_AVAILABILITIES,
  type AgentSummary,
} from "../../../../contracts/company-os-api/index.ts";
import {
  Note,
  RecordLink,
  ScreenLayout,
  StateBadge,
  Timestamp,
} from "../../components/display";
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
import { AgentStateBadges, ListEvidence } from "./AgentState";

// Screen 4, Agents (docs/PHASE_2C_BRIEF.md §12): configuration labels,
// availability, activity and attention, with the run and stop ids that prove
// them, read every 15 s while the tab is visible. The activity and
// availability filters narrow the one answer list_agents gave; they read
// nothing else.

const AgentRow = ({
  agent,
  current,
}: {
  agent: AgentSummary;
  current: boolean;
}) => (
  <TableRow>
    <TableCell>
      <RecordLink kind="agent" id={agent.id} label={`Agent ${agent.name}`}>
        {agent.name}
      </RecordLink>
      <div className="text-xs text-muted-foreground">{agent.slug}</div>
    </TableCell>
    <TableCell>{agent.company.name}</TableCell>
    <TableCell>{agent.department.name}</TableCell>
    <TableCell>
      <div className="flex flex-col gap-1">
        <AgentStateBadges agent={agent} current={current} />
        <ListEvidence agent={agent} current={current} />
      </div>
    </TableCell>
    <TableCell>
      {current ? (
        <span>{agent.attentionCount}</span>
      ) : (
        <StateBadge value="unknown" />
      )}
    </TableCell>
    <TableCell>
      <Timestamp value={agent.lastRunAt} />
    </TableCell>
  </TableRow>
);

const matchesFilters = (
  agent: AgentSummary,
  activity: string | null,
  availability: string | null,
) =>
  (activity === null || agent.activity === activity) &&
  (availability === null || agent.availability === availability);

const AgentTable = ({
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
      <Table aria-label="Agents">
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Company</TableHead>
            <TableHead>Department</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Attention</TableHead>
            <TableHead>Last run</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((agent) => (
            <AgentRow key={agent.id} agent={agent} current={current} />
          ))}
        </TableBody>
      </Table>
      {shown.length === 0 ? <Note>No agent matches.</Note> : null}
    </>
  );
};

const AgentList = () => {
  const agents = useCompanyOsQuery("list_agents", {}, { poll: true });
  return (
    <ScreenLayout
      title="Agents"
      description="Availability and activity as the server computed them, with the ids that prove them."
    >
      <FilterBar>
        <SearchParamSelect
          label="Activity"
          param="activity"
          options={optionsOf(AGENT_ACTIVITIES)}
        />
        <SearchParamSelect
          label="Availability"
          param="availability"
          options={optionsOf(AGENT_AVAILABILITIES)}
        />
      </FilterBar>
      <QueryView query={agents} what="the agents">
        {(data) => (
          <AgentTable agents={data.items} receivedAt={agents.dataUpdatedAt} />
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
