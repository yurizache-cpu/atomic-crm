import { Route, Routes, useSearchParams } from "react-router";

import { ListChecks } from "lucide-react";

import {
  TASK_STATUSES,
  type TaskSummary,
} from "../../../../contracts/company-os-api/index.ts";
import { AgentFilter } from "../../components/AgentFilter";
import { Note, RecordLink, ScreenLayout } from "../../components/display";
import {
  EmptyState,
  OwnerCard,
  RelativeTime,
  TechnicalDetails,
} from "../../components/owner";
import { PageControls, PagesView } from "../../components/queryStates";
import {
  FilterBar,
  SearchParamSelect,
} from "../../components/SearchParamSelect";
import {
  LIFECYCLE_STATUS_LABEL,
  LIFECYCLE_STATUS_NOTE,
  STATE_UNKNOWN_NOTE,
} from "../../copy";
import { oneOf, optionsOf, uuidOrNull } from "../../format/labels";
import { taskStatusLabel, taskTypeLabel } from "../../format/ptBR";
import { itemsOf, useCompanyOsPages } from "../../query/useCompanyOsPages";
import { useIsStateCurrent } from "../../query/useIsStateCurrent";
import { isLiveRun } from "../runs/liveness";
import { Pipeline } from "./Pipeline";
import { TaskDetail } from "./TaskDetail";

// Screen 3, Tasks (docs/PHASE_2C_BRIEF.md §12): the tenant's tasks, newest
// first, by lifecycle status and assigned agent, one opaque-cursor page at a
// time. A task's title and description (the inbound body) are never read, so
// a task is known here by its id, type and pipeline. While a latest run it
// shows can still change, the list is read again every 15 s while visible,
// and such a run reads "unknown" once the answer is too old (§10).

const hasLiveLatestRun = (task: TaskSummary): boolean =>
  task.pipeline.latestRun !== null && isLiveRun(task.pipeline.latestRun);

const TaskCard = ({
  task,
  current,
}: {
  task: TaskSummary;
  current: boolean;
}) => (
  <OwnerCard
    label={`Tarefa ${taskTypeLabel(task.type)}`}
    className="flex flex-col gap-4"
  >
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <span className="rounded-xl bg-primary/10 p-2.5 text-primary">
          <ListChecks aria-hidden className="size-5" />
        </span>
        <div className="flex flex-col">
          <RecordLink
            kind="task"
            id={task.id}
            label={`Abrir tarefa ${task.id}`}
          >
            {taskTypeLabel(task.type)}
          </RecordLink>
          <span className="text-xs text-muted-foreground">
            {task.assignedAgent === null
              ? "Sem agente responsável"
              : `Responsável: ${task.assignedAgent.name}`}
            {task.department === null ? "" : ` · ${task.department.name}`}
          </span>
        </div>
      </div>
      <span className="text-xs text-muted-foreground">
        Criada <RelativeTime value={task.createdAt} />
      </span>
    </div>
    <Pipeline pipeline={task.pipeline} current={current} />
    <TechnicalDetails
      rows={[
        ["Tarefa", task.id],
        ["Tipo", task.type],
        [LIFECYCLE_STATUS_LABEL, task.lifecycleStatus],
        ["Prioridade", String(task.priority)],
        ["Empresa", task.company.name],
        ["Última execução", task.pipeline.latestRun?.id ?? "—"],
        ["Revisão", task.pipeline.review?.id ?? "—"],
        ["Envio", task.pipeline.outbound?.id ?? "—"],
        ["Criada (UTC)", task.createdAt],
      ]}
    />
  </OwnerCard>
);

export const TaskTable = ({
  tasks,
  current,
}: {
  tasks: readonly TaskSummary[];
  /** Whether the answer the tasks came in is still current (§10). */
  current: boolean;
}) => (
  <div role="list" aria-label="Tarefas" className="flex flex-col gap-4">
    {tasks.map((task) => (
      <div role="listitem" key={task.id}>
        <TaskCard task={task} current={current} />
      </div>
    ))}
  </div>
);

const TaskList = () => {
  const [params] = useSearchParams();
  const tasks = useCompanyOsPages(
    "list_tasks",
    {
      p_status: oneOf(params.get("status"), TASK_STATUSES),
      p_agent_id: uuidOrNull(params.get("agent")),
    },
    { poll: (read) => read.some(hasLiveLatestRun) },
  );
  const items = itemsOf(tasks.data);
  const current = useIsStateCurrent(tasks.dataUpdatedAt);
  return (
    <ScreenLayout
      title="Tarefas"
      description="O trabalho da sua empresa, do recebimento ao envio."
    >
      <FilterBar>
        <SearchParamSelect
          label="Situação estrutural"
          param="status"
          options={optionsOf(TASK_STATUSES, taskStatusLabel)}
        />
        <AgentFilter />
      </FilterBar>
      <Note>{LIFECYCLE_STATUS_NOTE}</Note>
      <PagesView query={tasks} what="as tarefas">
        {current || !items.some(hasLiveLatestRun) ? null : (
          <p role="status" className="text-sm font-medium">
            {STATE_UNKNOWN_NOTE}
          </p>
        )}
        <TaskTable tasks={items} current={current} />
        {items.length === 0 ? (
          <EmptyState icon={ListChecks} title="Nenhuma tarefa para mostrar." />
        ) : null}
        <PageControls query={tasks} />
      </PagesView>
    </ScreenLayout>
  );
};

export const TasksScreen = () => (
  <Routes>
    <Route index element={<TaskList />} />
    <Route path=":taskId" element={<TaskDetail />} />
  </Routes>
);
