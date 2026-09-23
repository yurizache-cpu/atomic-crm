import { Link } from "react-router";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { type AgentRunDetail } from "../../../../contracts/company-os-api/index.ts";
import {
  Field,
  Fields,
  IdText,
  MoneyText,
  None,
  Note,
  RecordLink,
  RunLinks,
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
import { JOB_STEPS_NOTE, STATE_UNKNOWN_NOTE } from "../../copy";
import { jobStepLabel, stopScopeLabel } from "../../format/ptBR";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";
import { useIsStateCurrent } from "../../query/useIsStateCurrent";
import { isLiveRun } from "./liveness";
import { RunFields } from "./RunFields";

// One agent run (get_run): its summary, the job's liveness, the id-free job
// steps, the stop naming this tenant that covers it and the runs that retried
// it (docs/PHASE_2C_BRIEF.md §9, §12). No result text, provider id or
// platform id exists in the projection, so none can be shown.
//
// While the run's state can still change it is read again every 15 s while
// the page is visible, and an answer older than two polling intervals shows
// its status, attention, job status and lease as "unknown" (§10). A settled
// run with no live lease and nothing needing attention has reached its final
// state, so it is neither polled nor aged.

/** Whether what the run shows can still change: its status, or its job's lease. */
const isLiveRunDetail = (run: AgentRunDetail): boolean =>
  isLiveRun(run) || run.job?.leaseLive === true;

const JobFields = ({
  job,
  current,
}: {
  job: AgentRunDetail["job"];
  current: boolean;
}) =>
  job === null ? (
    <Note>Não existe trabalho para esta execução.</Note>
  ) : (
    <Fields label="Trabalho">
      <Field term="Situação do trabalho">
        <StateBadge value={current ? job.status : "unknown"} />
      </Field>
      <Field term="Tentativas">{job.attempts}</Field>
      <Field term="Disponível a partir de">
        <Timestamp value={job.availableAt} />
      </Field>
      <Field term="Trabalhador ativo agora">
        {current ? (
          <YesNo value={job.leaseLive} />
        ) : (
          <StateBadge value="unknown" />
        )}
      </Field>
      <Field term="Último tipo de erro">
        {job.lastErrorClass === null ? <None /> : job.lastErrorClass}
      </Field>
    </Fields>
  );

const JobSteps = ({ steps }: { steps: AgentRunDetail["jobSteps"] }) => (
  <>
    <Note>{JOB_STEPS_NOTE}</Note>
    {steps.length === 0 ? (
      <Note>Nenhuma etapa registrada.</Note>
    ) : (
      <Table aria-label="Etapas do trabalho">
        <TableHeader>
          <TableRow>
            <TableHead>Etapa</TableHead>
            <TableHead>Tentativa</TableHead>
            <TableHead>Quando</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {steps.map((step, index) => (
            <TableRow key={`${step.at}-${step.step}-${index}`}>
              <TableCell>{jobStepLabel(step.step)}</TableCell>
              <TableCell>{step.attempt ?? "—"}</TableCell>
              <TableCell>
                <Timestamp value={step.at} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )}
  </>
);

const CoveringStop = ({ stop }: { stop: AgentRunDetail["coveringStop"] }) =>
  stop === null ? (
    <None>nenhuma pausa desta empresa cobre esta execução</None>
  ) : (
    <span className="flex flex-wrap items-center gap-2">
      <IdText id={stop.id} />
      <span>{`alcance: ${stopScopeLabel(stop.scope)} · origem: ${stop.origin}`}</span>
    </span>
  );

const RunDetailBody = ({
  run,
  receivedAt,
}: {
  run: AgentRunDetail;
  receivedAt: number;
}) => {
  const fresh = useIsStateCurrent(receivedAt);
  const current = fresh || !isLiveRunDetail(run);
  const chainPath = recordPath("runChain", run.id);
  return (
    <>
      {current ? null : (
        <p role="status" className="text-sm font-medium">
          {STATE_UNKNOWN_NOTE}
        </p>
      )}
      <Section title="Execução">
        <RunFields run={run} current={current} />
        {chainPath === null ? null : (
          <Link to={chainPath} className="text-sm underline underline-offset-4">
            Ver cadeia da execução
          </Link>
        )}
      </Section>
      <Section title="Novas tentativas">
        <Fields label="Novas tentativas">
          <Field term="Nova tentativa de">
            {run.retryOfRunId === null ? (
              <None />
            ) : (
              <RecordLink
                kind="run"
                id={run.retryOfRunId}
                label={`Execução ${run.retryOfRunId}`}
              >
                Ver execução original
              </RecordLink>
            )}
          </Field>
          <Field term="Tentada de novo por">
            <RunLinks ids={run.retriedByRunIds} />
          </Field>
        </Fields>
      </Section>
      <Section title="Trabalho">
        <JobFields job={run.job} current={current} />
        <JobSteps steps={run.jobSteps} />
      </Section>
      <Section title="Pausa que cobre esta execução">
        <CoveringStop stop={run.coveringStop} />
      </Section>
      <Section title="Custo">
        <Fields label="Custo">
          <Field term="Reservado">
            <MoneyText value={run.reservedCost} />
          </Field>
          <Field term="Estimado">
            <MoneyText value={run.estimatedCost} />
          </Field>
          <Field term="Cobrado">
            <MoneyText value={run.chargedCost} />
          </Field>
        </Fields>
      </Section>
    </>
  );
};

const RunDetailRead = ({ runId }: { runId: string }) => {
  const run = useCompanyOsQuery(
    "get_run",
    { p_run_id: runId },
    { poll: isLiveRunDetail },
  );
  return (
    <QueryView query={run} what="a execução">
      {(data) => <RunDetailBody run={data} receivedAt={run.dataUpdatedAt} />}
    </QueryView>
  );
};

export const RunDetail = () => {
  const runId = useRouteRecordId("runId");
  return (
    <ScreenLayout title="Execução">
      <Link
        to={LIST_PATHS.runs}
        className="text-sm underline underline-offset-4"
      >
        All agent runs
      </Link>
      {runId === null ? <RecordNotFound /> : <RunDetailRead runId={runId} />}
    </ScreenLayout>
  );
};
