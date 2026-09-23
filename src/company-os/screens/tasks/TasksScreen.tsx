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
  TASK_STATUSES,
  type TaskSummary,
} from "../../../../contracts/company-os-api/index.ts";
import { AgentFilter } from "../../components/AgentFilter";
import {
  None,
  Note,
  RecordLink,
  ScreenLayout,
  StateBadge,
  Timestamp,
} from "../../components/display";
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

const TaskRow = ({
  task,
  current,
}: {
  task: TaskSummary;
  current: boolean;
}) => (
  <TableRow>
    <TableCell>
      <RecordLink kind="task" id={task.id} />
    </TableCell>
    <TableCell>{task.type}</TableCell>
    <TableCell>
      <StateBadge value={task.lifecycleStatus} />
    </TableCell>
    <TableCell>
      <Pipeline pipeline={task.pipeline} current={current} />
    </TableCell>
    <TableCell>
      {task.assignedAgent === null ? (
        <None />
      ) : (
        <RecordLink kind="agent" id={task.assignedAgent.id}>
          {task.assignedAgent.name}
        </RecordLink>
      )}
    </TableCell>
    <TableCell>
      {task.company.name}
      {task.department === null ? null : (
        <div className="text-xs text-muted-foreground">
          {task.department.name}
        </div>
      )}
    </TableCell>
    <TableCell>{task.priority}</TableCell>
    <TableCell>
      <Timestamp value={task.createdAt} />
    </TableCell>
  </TableRow>
);

export const TaskTable = ({
  tasks,
  current,
}: {
  tasks: readonly TaskSummary[];
  /** Whether the answer the tasks came in is still current (§10). */
  current: boolean;
}) => (
  <Table aria-label="Tasks">
    <TableHeader>
      <TableRow>
        <TableHead>Task</TableHead>
        <TableHead>Type</TableHead>
        <TableHead>{LIFECYCLE_STATUS_LABEL}</TableHead>
        <TableHead>Pipeline</TableHead>
        <TableHead>Assigned agent</TableHead>
        <TableHead>Company / department</TableHead>
        <TableHead>Priority</TableHead>
        <TableHead>Created</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} current={current} />
      ))}
    </TableBody>
  </Table>
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
    <ScreenLayout title="Tasks" description={LIFECYCLE_STATUS_NOTE}>
      <FilterBar>
        <SearchParamSelect
          label="Lifecycle status"
          param="status"
          options={optionsOf(TASK_STATUSES)}
        />
        <AgentFilter />
      </FilterBar>
      <PagesView query={tasks} what="the tasks">
        {current || !items.some(hasLiveLatestRun) ? null : (
          <p role="status" className="text-sm font-medium">
            {STATE_UNKNOWN_NOTE}
          </p>
        )}
        <TaskTable tasks={items} current={current} />
        {items.length === 0 ? <Note>No task matches.</Note> : null}
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
