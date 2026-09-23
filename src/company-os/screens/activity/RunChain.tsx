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
    <QueryView query={run} what="a execução">
      {(data) => (
        <Section title="Etapas">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <RecordLink kind="run" id={data.id} label={`Execução ${data.id}`}>
              Ver execução
            </RecordLink>
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
            <RecordLink
              kind="taskChain"
              id={data.taskId}
              label={`Cadeia da tarefa ${data.taskId}`}
            >
              Ver cadeia da tarefa
            </RecordLink>
          </p>
          <ChainTable label="Cadeia da execução">
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
      title="Cadeia da execução"
      description="Os registros permanentes de uma execução do agente, etapa por etapa, cada um com o seu horário."
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
