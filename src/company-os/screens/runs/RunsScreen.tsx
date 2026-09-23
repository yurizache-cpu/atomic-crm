import { Route, Routes, useSearchParams } from "react-router";

import { AGENT_RUN_STATUSES } from "../../../../contracts/company-os-api/index.ts";
import { AgentFilter } from "../../components/AgentFilter";
import { Note, ScreenLayout } from "../../components/display";
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

const ATTENTION_OPTIONS = [{ value: "1", label: "Needing attention only" }];

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
      title="Agent runs"
      description="Newest first. Costs are the server's figures; no result text is ever shown."
    >
      <FilterBar>
        <SearchParamSelect
          label="Status"
          param="status"
          options={optionsOf(AGENT_RUN_STATUSES)}
        />
        <AgentFilter />
        <SearchParamSelect
          label="Attention"
          param="attention"
          options={ATTENTION_OPTIONS}
          allLabel="All runs"
        />
      </FilterBar>
      <PagesView query={runs} what="the runs">
        {current || !items.some(isLiveRun) ? null : (
          <p role="status" className="text-sm font-medium">
            {STATE_UNKNOWN_NOTE}
          </p>
        )}
        <RunTable runs={items} label="Agent runs" current={current} />
        {items.length === 0 ? <Note>No run matches.</Note> : null}
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
