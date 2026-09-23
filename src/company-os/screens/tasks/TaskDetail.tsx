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
import {
  contactResolutionLabel,
  inboundSourceLabel,
  taskTypeLabel,
} from "../../format/ptBR";
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
  <Fields label="Tarefa">
    <Field term="Identificador">
      <IdText id={task.id} />
    </Field>
    <Field term="Tipo">{taskTypeLabel(task.type)}</Field>
    <Field term={LIFECYCLE_STATUS_LABEL}>
      <StateBadge value={task.lifecycleStatus} />
    </Field>
    <Field term="Prioridade">{task.priority}</Field>
    <Field term="Prazo">
      <Timestamp value={task.dueAt} />
    </Field>
    <Field term="Criada">
      <Timestamp value={task.createdAt} />
    </Field>
    <Field term="Empresa">{task.company.name}</Field>
    <Field term="Departamento">
      {task.department === null ? <None /> : task.department.name}
    </Field>
    <Field term="Agente responsável">
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
    <Note>
      Sem registro de recebimento: esta tarefa não chegou como mensagem.
    </Note>
  ) : (
    <Fields label="Recebimento">
      <Field term="Origem">{inboundSourceLabel(inbound.sourceKind)}</Field>
      <Field term="Canal">
        {inbound.channelLabel === null ? <None /> : inbound.channelLabel}
      </Field>
      <Field term="Recebida">
        <Timestamp value={inbound.receivedAt} />
      </Field>
      <Field term="Contato no CRM">
        {inbound.contactResolution === null ? (
          <None />
        ) : (
          contactResolutionLabel(inbound.contactResolution)
        )}
      </Field>
      <Field term="Não contatar">
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
        Ver cadeia da tarefa
      </Link>
    );
  return (
    <>
      <Section title="Tarefa">
        <Note>{LIFECYCLE_STATUS_NOTE}</Note>
        <TaskFields task={task} />
        {chainLink}
      </Section>
      {current || !hasLiveRun(task) ? null : (
        <p role="status" className="text-sm font-medium">
          {STATE_UNKNOWN_NOTE}
        </p>
      )}
      <Section title="Etapas">
        <Pipeline pipeline={task.pipeline} current={current} />
      </Section>
      <Section title="Execuções">
        {task.runs.length === 0 ? (
          <Note>Nenhuma execução foi pedida para esta tarefa.</Note>
        ) : (
          <RunTable
            runs={task.runs}
            label="Execuções desta tarefa"
            current={current}
          />
        )}
        {task.runs.length < TASK_RUNS_LIMIT ? null : (
          <Note>{TASK_RUNS_CAPPED_NOTE}</Note>
        )}
      </Section>
      <Section title="Revisão">
        {task.review === null ? (
          <Note>Nenhuma revisão foi aberta para esta tarefa.</Note>
        ) : (
          <Fields label="Revisão desta tarefa">
            <ReviewSummaryFields review={task.review} />
          </Fields>
        )}
      </Section>
      <Section title="Envio">
        <OutboundRecord outbound={task.outbound} />
      </Section>
      <Section title="Recebimento">
        <Inbound inbound={task.inbound} />
      </Section>
      <Section title="Eventos">
        {task.events.items.length === 0 ? (
          <Note>Nenhum evento para esta tarefa.</Note>
        ) : (
          <EventTable events={task.events.items} label="Eventos desta tarefa" />
        )}
        {task.events.nextCursor === null ? null : (
          <Note>
            Os eventos mais antigos desta tarefa estão na cadeia da tarefa.
          </Note>
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
    <QueryView query={task} what="a tarefa">
      {(data) => <TaskDetailBody task={data} receivedAt={task.dataUpdatedAt} />}
    </QueryView>
  );
};

export const TaskDetail = () => {
  const taskId = useRouteRecordId("taskId");
  return (
    <ScreenLayout title="Tarefa">
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
