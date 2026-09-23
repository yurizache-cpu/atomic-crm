import { Link } from "react-router";

import { type TaskDetail as TaskDetailData } from "../../../../contracts/company-os-api/index.ts";
import { EventTable } from "../../components/EventTable";
import {
  Field,
  Fields,
  IdText,
  None,
  Note,
  RecordLink,
  ScreenLayout,
  Section,
  StateBadge,
  Timestamp,
  YesNo,
} from "../../components/display";
import { QueryView } from "../../components/queryStates";
import { RecordNotFound } from "../../components/RecordNotFound";
import { useRouteRecordId } from "../../components/routeRecord";
import { LIST_PATHS, recordPath } from "../../components/recordPaths";
import {
  LIFECYCLE_STATUS_LABEL,
  LIFECYCLE_STATUS_NOTE,
  STATE_UNKNOWN_NOTE,
  TASK_RUNS_CAPPED_NOTE,
  TASK_RUNS_LIMIT,
} from "../../copy";
import { humanize } from "../../format/labels";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";
import { useIsStateCurrent } from "../../query/useIsStateCurrent";
import { ReviewSummaryFields } from "../reviews/ReviewSummaryFields";
import { isLiveRun } from "../runs/liveness";
import { RunTable } from "../runs/RunTable";
import { OutboundRecord } from "./OutboundRecord";
import { Pipeline } from "./Pipeline";

// One task (get_task): the derived pipeline, its runs, its review, its single
// outbound record, how it arrived and the first page of its events
// (docs/PHASE_2C_BRIEF.md §9, §12). Never the title or the description: the
// description is the inbound body, and the projection does not carry it.
// While one of its runs can still change, the task is read again every 15 s
// while visible, and once the answer is older than two polling intervals such
// a run's status reads "unknown" (§10, runs/liveness.ts).

const TaskFields = ({ task }: { task: TaskDetailData }) => (
  <Fields label="Task">
    <Field term="Task id">
      <IdText id={task.id} />
    </Field>
    <Field term="Type">{task.type}</Field>
    <Field term={LIFECYCLE_STATUS_LABEL}>
      <StateBadge value={task.lifecycleStatus} />
    </Field>
    <Field term="Priority">{task.priority}</Field>
    <Field term="Due">
      <Timestamp value={task.dueAt} />
    </Field>
    <Field term="Created">
      <Timestamp value={task.createdAt} />
    </Field>
    <Field term="Company">{task.company.name}</Field>
    <Field term="Department">
      {task.department === null ? <None /> : task.department.name}
    </Field>
    <Field term="Assigned agent">
      {task.assignedAgent === null ? (
        <None />
      ) : (
        <RecordLink kind="agent" id={task.assignedAgent.id}>
          {task.assignedAgent.name}
        </RecordLink>
      )}
    </Field>
  </Fields>
);

const Inbound = ({ inbound }: { inbound: TaskDetailData["inbound"] }) =>
  inbound === null ? (
    <Note>No admission record: this task did not arrive as a message.</Note>
  ) : (
    <Fields label="Inbound">
      <Field term="Source">{inbound.sourceKind}</Field>
      <Field term="Channel">
        {inbound.channelLabel === null ? <None /> : inbound.channelLabel}
      </Field>
      <Field term="Received">
        <Timestamp value={inbound.receivedAt} />
      </Field>
      <Field term="Contact resolution">
        {inbound.contactResolution === null ? (
          <None />
        ) : (
          humanize(inbound.contactResolution)
        )}
      </Field>
      <Field term="Do not contact">
        <YesNo value={inbound.doNotContact} />
      </Field>
    </Fields>
  );

/** Whether anything the task page shows about its runs can still change. */
const hasLiveRun = (task: TaskDetailData): boolean =>
  task.runs.some(isLiveRun) ||
  (task.pipeline.latestRun !== null && isLiveRun(task.pipeline.latestRun));

const TaskDetailBody = ({
  task,
  receivedAt,
}: {
  task: TaskDetailData;
  receivedAt: number;
}) => {
  const current = useIsStateCurrent(receivedAt);
  const chainPath = recordPath("taskChain", task.id);
  const chainLink =
    chainPath === null ? null : (
      <Link to={chainPath} className="text-sm underline underline-offset-4">
        Open the task chain
      </Link>
    );
  return (
    <>
      <Section title="Task">
        <Note>{LIFECYCLE_STATUS_NOTE}</Note>
        <TaskFields task={task} />
        {chainLink}
      </Section>
      {current || !hasLiveRun(task) ? null : (
        <p role="status" className="text-sm font-medium">
          {STATE_UNKNOWN_NOTE}
        </p>
      )}
      <Section title="Pipeline">
        <Pipeline pipeline={task.pipeline} current={current} />
      </Section>
      <Section title="Runs">
        {task.runs.length === 0 ? (
          <Note>No run was requested for this task.</Note>
        ) : (
          <RunTable
            runs={task.runs}
            label="Runs of this task"
            current={current}
          />
        )}
        {task.runs.length < TASK_RUNS_LIMIT ? null : (
          <Note>{TASK_RUNS_CAPPED_NOTE}</Note>
        )}
      </Section>
      <Section title="Review">
        {task.review === null ? (
          <Note>No review was opened for this task.</Note>
        ) : (
          <Fields label="Review of this task">
            <ReviewSummaryFields review={task.review} />
          </Fields>
        )}
      </Section>
      <Section title="Outbound record">
        <OutboundRecord outbound={task.outbound} />
      </Section>
      <Section title="Inbound">
        <Inbound inbound={task.inbound} />
      </Section>
      <Section title="Events">
        {task.events.items.length === 0 ? (
          <Note>No event names this task.</Note>
        ) : (
          <EventTable events={task.events.items} label="Events of this task" />
        )}
        {task.events.nextCursor === null ? null : (
          <Note>Older events of this task are in the task chain.</Note>
        )}
      </Section>
    </>
  );
};

const TaskDetailRead = ({ taskId }: { taskId: string }) => {
  const task = useCompanyOsQuery(
    "get_task",
    { p_task_id: taskId },
    { poll: hasLiveRun },
  );
  return (
    <QueryView query={task} what="the task">
      {(data) => <TaskDetailBody task={data} receivedAt={task.dataUpdatedAt} />}
    </QueryView>
  );
};

export const TaskDetail = () => {
  const taskId = useRouteRecordId("taskId");
  return (
    <ScreenLayout title="Task">
      <Link
        to={LIST_PATHS.tasks}
        className="text-sm underline underline-offset-4"
      >
        All tasks
      </Link>
      {taskId === null ? (
        <RecordNotFound />
      ) : (
        <TaskDetailRead taskId={taskId} />
      )}
    </ScreenLayout>
  );
};
