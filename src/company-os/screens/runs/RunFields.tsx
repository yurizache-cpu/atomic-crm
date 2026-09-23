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
import { attentionLabel, runStatusLabel } from "../../format/ptBR";

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
  <Fields label="Resumo da execução">
    <Field term="Identificador">
      <IdText id={run.id} />
    </Field>
    <Field term="Situação">
      <StateBadge
        value={current ? run.status : "unknown"}
        label={runStatusLabel(current ? run.status : "unknown")}
      />
    </Field>
    <Field term="Atenção">
      {!current ? (
        <StateBadge value="unknown" />
      ) : run.attention === null ? (
        <None />
      ) : (
        <StateBadge
          value={run.attention}
          label={attentionLabel(run.attention)}
        />
      )}
    </Field>
    <Field term="Erro">
      {run.errorCategory === null ? (
        <None />
      ) : (
        <span>{`${humanize(run.errorCategory)} (${run.errorCode ?? "sem código"})`}</span>
      )}
    </Field>
    <Field term="Agente">
      <RecordLink kind="agent" id={run.agentId} />
    </Field>
    <Field term="Tarefa">
      <RecordLink kind="task" id={run.taskId} />
    </Field>
    <Field term="Empresa">
      <IdText id={run.companyId} />
    </Field>
    <Field term="Trabalho">{run.capability}</Field>
    <Field term="Rota do modelo">{run.modelRoute}</Field>
    <Field term="Provedor">
      <Text value={run.provider} />
    </Field>
    <Field term="Modelo">
      <Text value={run.model} />
    </Field>
    <Field term="Modelo da resposta">
      <Text value={run.responseModel} />
    </Field>
    <Field term="Tokens de entrada">
      <Count value={run.inputTokens} />
    </Field>
    <Field term="Tokens de saída">
      <Count value={run.outputTokens} />
    </Field>
    <Field term="Tokens no total">
      <Count value={run.totalTokens} />
    </Field>
    <Field term="Tokens de entrada em cache">
      <Count value={run.cachedInputTokens} />
    </Field>
    <Field term="Tokens de raciocínio">
      <Count value={run.reasoningTokens} />
    </Field>
    <Field term="Duração (ms)">
      <Count value={run.latencyMs} />
    </Field>
    <Field term="Tentativa do trabalho">
      <Count value={run.jobAttempt} />
    </Field>
    <Field term="Criada">
      <Timestamp value={run.createdAt} />
    </Field>
    <Field term="Iniciada">
      <Timestamp value={run.startedAt} />
    </Field>
    <Field term="Concluída">
      <Timestamp value={run.completedAt} />
    </Field>
    <Field term="Pausa desta empresa">
      {run.stopRef === null ? <None /> : <IdText id={run.stopRef.id} />}
    </Field>
    <Field term="Limite de gasto">
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
