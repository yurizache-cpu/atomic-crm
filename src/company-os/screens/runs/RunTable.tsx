import { PlayCircle } from "lucide-react";

import type { AgentRunSummary } from "../../../../contracts/company-os-api/index.ts";
import { RecordLink } from "../../components/display";
import {
  Meta,
  MoneyValue,
  OwnerCard,
  RelativeTime,
  StatusChip,
  TechnicalDetails,
} from "../../components/owner";
import {
  attentionLabel,
  capabilityLabel,
  exactMoney,
  runStatusLabel,
  toneOfState,
} from "../../format/ptBR";
import { agentDisplayName } from "../../format/displayNames";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";
import { shownRunStatus } from "./liveness";

// Agent runs as the owner reads them (docs/PHASE_2C_BRIEF.md §12 screen 5):
// what the agent did, whether it finished, when, with which model, how long it
// took and what it cost, never the result text (a run carries none). The
// agent's name comes from list_agents, the same read the Equipe screen shows.
// Ids, route, tokens and exact amounts stay in the technical details. Every
// list passes `current`, whether its answer is younger than two polling
// intervals (§10): once it is not, a run that can still change reads
// "Desconhecido", and a settled run keeps its final status (liveness.ts).

const durationLabel = (ms: number | null): string | null => {
  if (ms === null) return null;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`;
};

const RunCard = ({
  run,
  current,
  agentName,
}: {
  run: AgentRunSummary;
  current: boolean;
  agentName: string | null;
}) => {
  const status = shownRunStatus(run, current);
  const duration = durationLabel(run.latencyMs);
  return (
    <OwnerCard
      label={`Execução ${capabilityLabel(run.capability)}`}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-primary/10 p-2.5 text-primary">
            <PlayCircle aria-hidden className="size-5" />
          </span>
          <div className="flex flex-col">
            <RecordLink
              kind="run"
              id={run.id}
              label={`Abrir execução ${run.id}`}
            >
              {agentName === null ? "Agente" : agentDisplayName(agentName)}
            </RecordLink>
            <span className="text-sm text-muted-foreground">
              {capabilityLabel(run.capability)}
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="flex flex-wrap justify-end gap-1">
            <StatusChip
              tone={toneOfState(status)}
              label={runStatusLabel(status)}
            />
            {status === "unknown" || run.attention === null ? null : (
              <StatusChip tone="amber" label={attentionLabel(run.attention)} />
            )}
          </span>
          <span className="text-xs text-muted-foreground">
            <RelativeTime value={run.createdAt} />
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        <Meta label="Modelo">{run.model ?? run.responseModel ?? "—"}</Meta>
        {duration === null ? null : <Meta label="Duração">{duration}</Meta>}
        <Meta label="Custo">
          <MoneyValue value={run.chargedCost} />
        </Meta>
      </div>
      <TechnicalDetails
        rows={[
          ["Execução", run.id],
          ["Tarefa", run.taskId],
          ["Agente", run.agentId],
          ["Capacidade", run.capability],
          ["Rota", run.modelRoute],
          ["Provedor", run.provider ?? "—"],
          ["Modelo da resposta", run.responseModel ?? "—"],
          ["Situação", run.status],
          [
            "Erro",
            run.errorCategory === null
              ? "—"
              : `${run.errorCategory} ${run.errorCode ?? ""}`,
          ],
          [
            "Tokens (entrada/saída)",
            `${run.inputTokens ?? "—"} / ${run.outputTokens ?? "—"}`,
          ],
          [
            "Custo cobrado",
            run.chargedCost === null ? "—" : exactMoney(run.chargedCost),
          ],
          ["Criada (UTC)", run.createdAt],
          ["Concluída (UTC)", run.completedAt ?? "—"],
        ]}
      />
    </OwnerCard>
  );
};

export const RunTable = ({
  runs,
  label,
  current,
}: {
  runs: readonly AgentRunSummary[];
  label: string;
  /** Whether the answer the runs came in is still current (§10). */
  current: boolean;
}) => {
  const agents = useCompanyOsQuery("list_agents", {});
  const nameOf = (id: string) =>
    agents.data?.items.find((agent) => agent.id === id)?.name ?? null;
  return (
    <div role="list" aria-label={label} className="flex flex-col gap-3">
      {runs.map((run) => (
        <div role="listitem" key={run.id}>
          <RunCard
            run={run}
            current={current}
            agentName={nameOf(run.agentId)}
          />
        </div>
      ))}
    </div>
  );
};
