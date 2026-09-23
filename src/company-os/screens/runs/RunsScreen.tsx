import { PlayCircle } from "lucide-react";
import { Route, Routes, useSearchParams } from "react-router";

import { AGENT_RUN_STATUSES } from "../../../../contracts/company-os-api/index.ts";
import { AgentFilter } from "../../components/AgentFilter";
import { ScreenLayout } from "../../components/display";
import { EmptyState } from "../../components/owner";
import { runStatusLabel } from "../../format/ptBR";
import { PageControls, PagesView } from "../../components/queryStates";
import {
  FilterBar,
  SearchParamSelect,
} from "../../components/SearchParamSelect";
import { oneOf, optionsOf, uuidOrNull } from "../../format/labels";
import { itemsOf, useCompanyOsPages } from "../../query/useCompanyOsPages";
import { useIsStateCurrent } from "../../query/useIsStateCurrent";
import { STATE_UNKNOWN_NOTE } from "../../copy";
import { isLiveRun } from "./liveness";
import { RunDetail } from "./RunDetail";
import { RunTable } from "./RunTable";

// Screen 5, Agent runs (docs/PHASE_2C_BRIEF.md §12): the tenant's runs, newest
// first, filtered by status, agent and attention through list_runs' own
// arguments, one opaque-cursor page at a time. While a run it shows can still
// change, every loaded page is read again every 15 s while visible, and once
// the answer is older than two polling intervals such a run's status reads
// "unknown" (§10, liveness.ts), as on the run's own page.

const ATTENTION_OPTIONS = [
  { value: "1", label: "Só as que precisam de atenção" },
];

const RunList = () => {
  const [params] = useSearchParams();
  const runs = useCompanyOsPages(
    "list_runs",
    {
      p_status: oneOf(params.get("status"), AGENT_RUN_STATUSES),
      p_agent_id: uuidOrNull(params.get("agent")),
      p_attention_only: params.get("attention") === "1",
    },
    { poll: (read) => read.some(isLiveRun) },
  );
  const items = itemsOf(runs.data);
  const current = useIsStateCurrent(runs.dataUpdatedAt);
  return (
    <ScreenLayout
      title="Execuções"
      description="O que seus agentes fizeram, das mais recentes para as mais antigas."
    >
      <FilterBar>
        <SearchParamSelect
          label="Situação"
          param="status"
          options={optionsOf(AGENT_RUN_STATUSES, runStatusLabel)}
        />
        <AgentFilter />
        <SearchParamSelect
          label="Atenção"
          param="attention"
          options={ATTENTION_OPTIONS}
          allLabel="Todas"
        />
      </FilterBar>
      <PagesView query={runs} what="as execuções">
        {current || !items.some(isLiveRun) ? null : (
          <p role="status" className="text-sm font-medium">
            {STATE_UNKNOWN_NOTE}
          </p>
        )}
        <RunTable runs={items} label="Execuções" current={current} />
        {items.length === 0 ? (
          <EmptyState
            icon={PlayCircle}
            title="Nenhuma execução corresponde a este filtro."
          />
        ) : null}
        <PageControls query={runs} />
      </PagesView>
    </ScreenLayout>
  );
};

export const AgentRunsScreen = () => (
  <Routes>
    <Route index element={<RunList />} />
    <Route path=":runId" element={<RunDetail />} />
  </Routes>
);
