import type { AgentRunSummary } from "../../../../contracts/company-os-api/index.ts";
import {
  Field,
  Fields,
  IdText,
  None,
  RecordLink,
  StateBadge,
  Timestamp,
} from "../../components/display";
import { humanize } from "../../format/labels";

// A run's summary fields as a definition list: identity, outcome, model,
// tokens, latency and timing. Token counts and latency are the server's
// integers; nothing is summed or converted here. While `current` is false
// (docs/PHASE_2C_BRIEF.md §10) the status and the attention read "unknown".

const Count = ({ value }: { value: number | null }) =>
  value === null ? <None /> : <span>{value}</span>;

const Text = ({ value }: { value: string | null }) =>
  value === null ? <None /> : <span>{value}</span>;

export const RunFields = ({
  run,
  current,
}: {
  run: AgentRunSummary;
  current: boolean;
}) => (
  <Fields label="Run summary">
    <Field term="Run id">
      <IdText id={run.id} />
    </Field>
    <Field term="Status">
      <StateBadge value={current ? run.status : "unknown"} />
    </Field>
    <Field term="Attention">
      {!current ? (
        <StateBadge value="unknown" />
      ) : run.attention === null ? (
        <None />
      ) : (
        <StateBadge value={run.attention} />
      )}
    </Field>
    <Field term="Error">
      {run.errorCategory === null ? (
        <None />
      ) : (
        <span>{`${humanize(run.errorCategory)} (${run.errorCode ?? "no code"})`}</span>
      )}
    </Field>
    <Field term="Agent">
      <RecordLink kind="agent" id={run.agentId} />
    </Field>
    <Field term="Task">
      <RecordLink kind="task" id={run.taskId} />
    </Field>
    <Field term="Company id">
      <IdText id={run.companyId} />
    </Field>
    <Field term="Capability">{run.capability}</Field>
    <Field term="Model route">{run.modelRoute}</Field>
    <Field term="Provider">
      <Text value={run.provider} />
    </Field>
    <Field term="Model">
      <Text value={run.model} />
    </Field>
    <Field term="Response model">
      <Text value={run.responseModel} />
    </Field>
    <Field term="Input tokens">
      <Count value={run.inputTokens} />
    </Field>
    <Field term="Output tokens">
      <Count value={run.outputTokens} />
    </Field>
    <Field term="Total tokens">
      <Count value={run.totalTokens} />
    </Field>
    <Field term="Cached input tokens">
      <Count value={run.cachedInputTokens} />
    </Field>
    <Field term="Reasoning tokens">
      <Count value={run.reasoningTokens} />
    </Field>
    <Field term="Latency (ms)">
      <Count value={run.latencyMs} />
    </Field>
    <Field term="Job attempt">
      <Count value={run.jobAttempt} />
    </Field>
    <Field term="Created">
      <Timestamp value={run.createdAt} />
    </Field>
    <Field term="Started">
      <Timestamp value={run.startedAt} />
    </Field>
    <Field term="Completed">
      <Timestamp value={run.completedAt} />
    </Field>
    <Field term="Stop naming this tenant">
      {run.stopRef === null ? <None /> : <IdText id={run.stopRef.id} />}
    </Field>
    <Field term="Spend limit">
      {run.spendLimitRef === null ? (
        <None />
      ) : (
        <span className="flex flex-wrap items-center gap-2">
          <IdText id={run.spendLimitRef.id} />
          <span>{`${run.spendLimitRef.scope} limit`}</span>
        </span>
      )}
    </Field>
  </Fields>
);
