import { Link } from "react-router";

import { RecordLink, ScreenLayout, Section } from "../../components/display";
import { QueryView } from "../../components/queryStates";
import { RecordNotFound } from "../../components/RecordNotFound";
import { useRouteRecordId } from "../../components/routeRecord";
import { LIST_PATHS } from "../../components/recordPaths";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";
import { ChainTable } from "./ChainTable";
import { RunChainRows } from "./RunChainRows";

// One run's chain (docs/PHASE_2C_BRIEF.md §11): run requested, job leased,
// provider call begun and result settled, each with its own facts or shown as
// absent, and a link to the chain of the task the run belongs to.

const RunChainRead = ({ runId }: { runId: string }) => {
  const run = useCompanyOsQuery("get_run", { p_run_id: runId });
  return (
    <QueryView query={run} what="the run">
      {(data) => (
        <Section title="Steps">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            Run <RecordLink kind="run" id={data.id} /> of task
            <RecordLink
              kind="taskChain"
              id={data.taskId}
              label={`Task chain ${data.taskId}`}
            />
          </p>
          <ChainTable label="Run chain">
            <RunChainRows runId={data.id} withHeading={false} />
          </ChainTable>
        </Section>
      )}
    </QueryView>
  );
};

export const RunChain = () => {
  const runId = useRouteRecordId("runId");
  return (
    <ScreenLayout
      title="Run chain"
      description="The durable facts of one agent run, laid out by step; each fact shows its own time."
    >
      <Link
        to={LIST_PATHS.activity}
        className="text-sm underline underline-offset-4"
      >
        Activity feed
      </Link>
      {runId === null ? <RecordNotFound /> : <RunChainRead runId={runId} />}
    </ScreenLayout>
  );
};
