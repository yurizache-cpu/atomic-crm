import { Link } from "react-router";

import {
  AGENT_RUN_STATUSES,
  OUTBOUND_STATUSES,
  type OverviewSummary,
} from "../../../../contracts/company-os-api/index.ts";
import {
  Field,
  Fields,
  Note,
  ScreenLayout,
  Section,
  StateBadge,
  Timestamp,
  YesNo,
} from "../../components/display";
import { QueryView } from "../../components/queryStates";
import { LIST_PATHS } from "../../components/recordPaths";
import {
  ACCEPTED_WITHOUT_SEND_LABEL,
  OVERVIEW_PROOF_NOTE,
  PLATFORM_ADMISSION_LABEL,
  STATE_UNKNOWN_NOTE,
} from "../../copy";
import { humanize } from "../../format/labels";
import { outboundStatusText } from "../../format/outbound";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";
import { useIsStateCurrent } from "../../query/useIsStateCurrent";

// Screen 1, Overview (docs/PHASE_2C_BRIEF.md §12): the server's counts, each a
// link to the list that proves it, read every 15 s while the tab is visible.
// An answer older than two polling intervals shows every value as "unknown"
// (§10). No vanity metrics, no spend amounts, and the accepted reviews with no
// send recorded are a count, never "awaiting a send" (§7.5).
//
// Some lists cannot yet narrow to exactly what their count counts: list_runs
// has no date filter, and neither list_tasks nor list_reviews selects by
// outbound record. Until the contracts gain those selectors, each such count
// says beside its link what the list shows instead (`listShows`).

/** One count as a link to its list; "unknown" when the answer is too old. */
const CountLink = ({
  label,
  count,
  to,
  current,
  listShows,
}: {
  label: string;
  count: number;
  to: string;
  current: boolean;
  /** What the linked list shows when it does not narrow to this count. */
  listShows?: string;
}) => {
  const scope = listShows === undefined ? "" : ` (${listShows})`;
  return (
    <Field term={label}>
      {current ? (
        <span className="flex flex-wrap items-baseline gap-x-2">
          <Link
            to={to}
            aria-label={`${label}: ${count}${scope}`}
            className="font-medium underline underline-offset-4"
          >
            {count}
          </Link>
          {listShows === undefined ? null : (
            <span className="text-xs text-muted-foreground">{`(${listShows})`}</span>
          )}
        </span>
      ) : (
        <StateBadge value="unknown" />
      )}
    </Field>
  );
};

const TASK_PIPELINE_LIST = "the list shows every task: see its pipeline column";

const withParam = (path: string, name: string, value: string) =>
  `${path}?${new URLSearchParams({ [name]: value }).toString()}`;

const AgentCounts = ({
  agents,
  current,
}: {
  agents: OverviewSummary["agents"];
  current: boolean;
}) => {
  const byActivity = (activity: string) =>
    withParam(LIST_PATHS.agents, "activity", activity);
  const byAvailability = (availability: string) =>
    withParam(LIST_PATHS.agents, "availability", availability);
  return (
    <Section title="Agents">
      <Fields label="Agent counts">
        <CountLink
          label="Agents"
          count={agents.total}
          to={LIST_PATHS.agents}
          current={current}
        />
        <CountLink
          label="Working"
          count={agents.working}
          to={byActivity("working")}
          current={current}
        />
        <CountLink
          label="Held"
          count={agents.held}
          to={byActivity("held")}
          current={current}
        />
        <CountLink
          label="Queued"
          count={agents.queued}
          to={byActivity("queued")}
          current={current}
        />
        <CountLink
          label="Stale"
          count={agents.stale}
          to={byActivity("stale")}
          current={current}
        />
        <CountLink
          label="Stopped"
          count={agents.stopped}
          to={byAvailability("stopped")}
          current={current}
        />
        <CountLink
          label="Inactive"
          count={agents.inactive}
          to={byAvailability("inactive")}
          current={current}
        />
      </Fields>
    </Section>
  );
};

const RunCounts = ({
  runs,
  current,
}: {
  runs: OverviewSummary["runs"];
  current: boolean;
}) => {
  const statuses = AGENT_RUN_STATUSES.filter(
    (status) => runs.todayByStatus[status] !== undefined,
  );
  return (
    <Section title="Agent runs">
      <Fields label="Agent run counts">
        {statuses.map((status) => (
          <CountLink
            key={status}
            label={`Runs today: ${humanize(status)}`}
            count={runs.todayByStatus[status] ?? 0}
            to={withParam(LIST_PATHS.runs, "status", status)}
            current={current}
            listShows={`the list shows ${humanize(status)} runs of every day`}
          />
        ))}
        <CountLink
          label="Runs working now"
          count={runs.workingNow}
          to={withParam(LIST_PATHS.agents, "activity", "working")}
          current={current}
        />
        <CountLink
          label="Runs needing attention"
          count={runs.needingAttention}
          to={withParam(LIST_PATHS.runs, "attention", "1")}
          current={current}
        />
      </Fields>
      {current && statuses.length === 0 ? (
        <Note>No run was created today.</Note>
      ) : null}
    </Section>
  );
};

const ReviewAndStopCounts = ({
  data,
  current,
}: {
  data: OverviewSummary;
  current: boolean;
}) => (
  <Section title="Reviews and stops">
    <Fields label="Review and stop counts">
      <CountLink
        label="Reviews pending"
        count={data.reviews.pending}
        to={LIST_PATHS.reviews}
        current={current}
      />
      <Field term="Oldest pending review since">
        {current ? (
          <Timestamp value={data.reviews.oldestPendingAt} />
        ) : (
          <StateBadge value="unknown" />
        )}
      </Field>
      <CountLink
        label="Active stops naming this tenant"
        count={data.stops.tenantScopedActive}
        to={LIST_PATHS.stops}
        current={current}
      />
    </Fields>
  </Section>
);

const OutboundCounts = ({
  outbound,
  current,
}: {
  outbound: OverviewSummary["outbound"];
  current: boolean;
}) => {
  const statuses = OUTBOUND_STATUSES.filter(
    (status) => outbound.todayByStatus[status] !== undefined,
  );
  return (
    <Section title="Outbound records">
      <Note>
        Counts only. Each task's single outbound record shows in the pipeline
        column of the Tasks list.
      </Note>
      <Fields label="Outbound counts">
        {statuses.map((status) => (
          <CountLink
            key={status}
            label={`Outbound records today: ${outboundStatusText(status)}`}
            count={outbound.todayByStatus[status] ?? 0}
            to={LIST_PATHS.tasks}
            current={current}
            listShows={TASK_PIPELINE_LIST}
          />
        ))}
        <CountLink
          label="Indeterminate sends open"
          count={outbound.indeterminateOpen}
          to={LIST_PATHS.tasks}
          current={current}
          listShows={TASK_PIPELINE_LIST}
        />
        <CountLink
          label={ACCEPTED_WITHOUT_SEND_LABEL}
          count={outbound.acceptedWithoutSend}
          to={withParam(LIST_PATHS.reviews, "status", "accepted")}
          current={current}
          listShows="the list shows every accepted review: see its outbound record column"
        />
      </Fields>
    </Section>
  );
};

const AdmissionState = ({
  data,
  current,
}: {
  data: OverviewSummary;
  current: boolean;
}) => (
  <Section title="Admission">
    <Fields label="Admission">
      <Field term="Tenant admission">
        {current ? (
          <Link
            to={LIST_PATHS.costs}
            aria-label={`Tenant admission: ${data.admission.tenantAdmission}`}
          >
            <StateBadge value={data.admission.tenantAdmission} />
          </Link>
        ) : (
          <StateBadge value="unknown" />
        )}
      </Field>
      <Field term={PLATFORM_ADMISSION_LABEL}>
        {current ? (
          <YesNo value={data.platform.globalAdmissionBlocked} />
        ) : (
          <StateBadge value="unknown" />
        )}
      </Field>
    </Fields>
  </Section>
);

const OverviewBody = ({
  data,
  receivedAt,
}: {
  data: OverviewSummary;
  receivedAt: number;
}) => {
  const current = useIsStateCurrent(receivedAt);
  return (
    <>
      {current ? null : (
        <p role="status" className="text-sm font-medium">
          {STATE_UNKNOWN_NOTE}
        </p>
      )}
      <Note>{OVERVIEW_PROOF_NOTE}</Note>
      <div className="grid gap-8 lg:grid-cols-2">
        <AgentCounts agents={data.agents} current={current} />
        <RunCounts runs={data.runs} current={current} />
        <ReviewAndStopCounts data={data} current={current} />
        <OutboundCounts outbound={data.outbound} current={current} />
        <AdmissionState data={data} current={current} />
      </div>
      <p className="text-xs text-muted-foreground">
        Server time of this answer: <Timestamp value={data.asOf} />
      </p>
    </>
  );
};

export const OverviewScreen = () => {
  const overview = useCompanyOsQuery("overview", {}, { poll: true });
  return (
    <ScreenLayout
      title="Overview"
      description="Counts computed by the server; each one links to the list that proves it."
    >
      <QueryView query={overview} what="the overview">
        {(data) => (
          <OverviewBody data={data} receivedAt={overview.dataUpdatedAt} />
        )}
      </QueryView>
    </ScreenLayout>
  );
};
