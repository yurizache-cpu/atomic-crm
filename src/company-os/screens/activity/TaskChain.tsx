import { Link } from "react-router";

import {
  Note,
  RecordLink,
  ScreenLayout,
  Section,
} from "../../components/display";
import {
  LoadingText,
  PageControls,
  QueryView,
  ReadError,
} from "../../components/queryStates";
import { RecordNotFound } from "../../components/RecordNotFound";
import { useRouteRecordId } from "../../components/routeRecord";
import { useShownEvents } from "../../components/eventsInView";
import { LIST_PATHS } from "../../components/recordPaths";
import { TASK_RUNS_CAPPED_NOTE, TASK_RUNS_LIMIT } from "../../copy";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";
import { itemsOf, useCompanyOsPages } from "../../query/useCompanyOsPages";
import { ChainRow, ChainTable, EventStepRow, OtherFacts } from "./ChainTable";
import {
  CHAIN_EVENTS_PAGE,
  TASK_STEPS_AFTER_RUNS,
  TASK_STEPS_BEFORE_RUNS,
  eventsOutside,
  oldestFirst,
} from "./chainSteps";
import { RunChainRows } from "./RunChainRows";

// A task's chain (docs/PHASE_2C_BRIEF.md §11): from the message that created it
// to the provider's last status, laid out by step, one block of run steps per
// run of the task. Every fact is an ops.events row naming the task or one of
// its runs, or an id-free job step; a step with no fact is shown as absent.

const TASK_STEPS = [...TASK_STEPS_BEFORE_RUNS, ...TASK_STEPS_AFTER_RUNS];

const TaskChainTable = ({
  taskId,
  runIds,
}: {
  taskId: string;
  runIds: readonly string[];
}) => {
  const events = useCompanyOsPages("list_events", {
    p_subject_type: "task",
    p_subject_id: taskId,
    p_limit: CHAIN_EVENTS_PAGE,
  });
  const items = itemsOf(events.data);
  useShownEvents(items);
  if (events.isError && !events.isFetchNextPageError) {
    return (
      <ReadError error={events.error} onRetry={() => void events.refetch()} />
    );
  }
  if (events.data === undefined) return <LoadingText what="a cadeia" />;
  const complete = !events.hasNextPage;
  const other = eventsOutside(items, TASK_STEPS);
  return (
    <>
      <ChainTable label="Cadeia da tarefa">
        {TASK_STEPS_BEFORE_RUNS.map((step) => (
          <EventStepRow
            key={step.id}
            step={step}
            events={items}
            complete={complete}
          />
        ))}
        {runIds.length === 0 ? (
          <ChainRow label="Execução do agente">
            <Note>Nenhuma execução foi pedida para esta tarefa.</Note>
          </ChainRow>
        ) : (
          runIds.map((runId) => (
            <RunChainRows key={runId} runId={runId} withHeading />
          ))
        )}
        {TASK_STEPS_AFTER_RUNS.map((step) => (
          <EventStepRow
            key={step.id}
            step={step}
            events={items}
            complete={complete}
          />
        ))}
        {other.length === 0 ? null : (
          <ChainRow label="Outros registros desta tarefa">
            <OtherFacts events={other} />
          </ChainRow>
        )}
      </ChainTable>
      {events.hasNextPage || events.isFetchNextPageError ? (
        <PageControls query={events} />
      ) : null}
    </>
  );
};

const TaskChainRead = ({ taskId }: { taskId: string }) => {
  const task = useCompanyOsQuery("get_task", { p_task_id: taskId });
  return (
    <QueryView query={task} what="a tarefa">
      {(data) => (
        <Section title="Etapas">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            Task <RecordLink kind="task" id={data.id} />
          </p>
          {data.runs.length < TASK_RUNS_LIMIT ? null : (
            <Note>{TASK_RUNS_CAPPED_NOTE}</Note>
          )}
          <TaskChainTable
            taskId={data.id}
            runIds={oldestFirst(data.runs).map((run) => run.id)}
          />
        </Section>
      )}
    </QueryView>
  );
};

export const TaskChain = () => {
  const taskId = useRouteRecordId("taskId");
  return (
    <ScreenLayout
      title="Cadeia da tarefa"
      description="Os registros permanentes de uma tarefa, etapa por etapa, cada um com o seu horário."
    >
      <Link
        to={LIST_PATHS.activity}
        className="text-sm underline underline-offset-4"
      >
        Activity feed
      </Link>
      {taskId === null ? <RecordNotFound /> : <TaskChainRead taskId={taskId} />}
    </ScreenLayout>
  );
};
