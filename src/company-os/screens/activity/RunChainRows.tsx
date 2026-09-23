import type { EventSummary } from "../../../../contracts/company-os-api/index.ts";
import { RecordLink } from "../../components/display";
import { useShownEvents } from "../../components/eventsInView";
import {
  LoadingText,
  PageControls,
  ReadError,
} from "../../components/queryStates";
import { JOB_STEPS_NOTE } from "../../copy";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";
import { itemsOf, useCompanyOsPages } from "../../query/useCompanyOsPages";
import { ChainRow, EventStepRow, JobStepFacts, OtherFacts } from "./ChainTable";
import {
  CHAIN_EVENTS_PAGE,
  JOB_STEP_ID,
  RUN_STEPS,
  eventsOutside,
} from "./chainSteps";

// The run-level steps of a chain (docs/PHASE_2C_BRIEF.md §11), as table rows:
// run requested, job leased (the id-free steps of the run's own job, which has
// no ops.events fact), provider call begun and result settled. Whether the
// provider was reached is known only from the settlement.

const JobRow = ({ runId }: { runId: string }) => {
  const run = useCompanyOsQuery("get_run", { p_run_id: runId });
  const label = RUN_STEPS.find((step) => step.id === JOB_STEP_ID)?.label ?? "";
  return (
    <ChainRow label={label}>
      {run.isError ? (
        <ReadError error={run.error} onRetry={() => void run.refetch()} />
      ) : run.data === undefined ? (
        <LoadingText what="the job steps" />
      ) : (
        <div className="flex flex-col gap-1">
          <JobStepFacts steps={run.data.jobSteps} />
          <span className="text-xs text-muted-foreground">
            {JOB_STEPS_NOTE}
          </span>
        </div>
      )}
    </ChainRow>
  );
};

const StepRows = ({
  runId,
  events,
  complete,
}: {
  runId: string;
  events: readonly EventSummary[];
  complete: boolean;
}) => (
  <>
    {RUN_STEPS.map((step) =>
      step.id === JOB_STEP_ID ? (
        <JobRow key={step.id} runId={runId} />
      ) : (
        <EventStepRow
          key={step.id}
          step={step}
          events={events}
          complete={complete}
        />
      ),
    )}
  </>
);

export const RunChainRows = ({
  runId,
  withHeading,
}: {
  runId: string;
  withHeading: boolean;
}) => {
  const events = useCompanyOsPages("list_events", {
    p_subject_type: "agent_run",
    p_subject_id: runId,
    p_limit: CHAIN_EVENTS_PAGE,
  });
  const items = itemsOf(events.data);
  useShownEvents(items);
  const other = eventsOutside(items, RUN_STEPS);
  return (
    <>
      {withHeading ? (
        <ChainRow label="Agent run">
          <RecordLink kind="runChain" id={runId} label={`Run chain ${runId}`} />
        </ChainRow>
      ) : null}
      {events.isError && !events.isFetchNextPageError ? (
        <ChainRow label="Run events">
          <ReadError
            error={events.error}
            onRetry={() => void events.refetch()}
          />
        </ChainRow>
      ) : events.data === undefined ? (
        <ChainRow label="Run events">
          <LoadingText what="the run's events" />
        </ChainRow>
      ) : (
        <>
          <StepRows
            runId={runId}
            events={items}
            complete={!events.hasNextPage}
          />
          {other.length === 0 ? null : (
            <ChainRow label="Other facts on this run">
              <OtherFacts events={other} />
            </ChainRow>
          )}
          {events.hasNextPage || events.isFetchNextPageError ? (
            <ChainRow label="More run events">
              <PageControls query={events} />
            </ChainRow>
          ) : null}
        </>
      )}
    </>
  );
};
