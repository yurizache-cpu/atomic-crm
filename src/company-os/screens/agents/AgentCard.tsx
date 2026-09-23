import { Bot } from "lucide-react";

import type { AgentSummary } from "../../../../contracts/company-os-api/index.ts";
import { RecordLink, RunLinks } from "../../components/display";
import {
  Meta,
  OwnerCard,
  RelativeTime,
  StatusChip,
  TechnicalDetails,
} from "../../components/owner";
import {
  activityLabel,
  availabilityLabel,
  stopScopeLabel,
  toneOfState,
} from "../../format/ptBR";
import { agentDisplayName } from "../../format/displayNames";
import { shownActivity } from "./activityRule";

// One agent as the owner reads it (docs/PHASE_2C_BRIEF.md §10): availability
// and activity as two chips, so "Pausado" and "Trabalhando" appear together when
// both hold; "Trabalhando" only with at least one working run, each linking to
// its run, never from the activity value alone; and "Desconhecido" instead of
// either once the answer is older than two polling intervals. The ids that
// prove the state stay in the technical details.

const idList = (ids: readonly string[]) =>
  ids.length === 0 ? "—" : ids.join(", ");

export const AgentCard = ({
  agent,
  current,
}: {
  agent: AgentSummary;
  current: boolean;
}) => {
  const availability = current ? agent.availability : "unknown";
  const activity = current ? shownActivity(agent) : "unknown";
  const { evidence } = agent;
  const name = agentDisplayName(agent.name);
  return (
    <OwnerCard label={`Agente ${name}`} className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span className="rounded-xl bg-primary/10 p-2.5 text-primary">
          <Bot aria-hidden className="size-5" />
        </span>
        <div className="flex min-w-0 flex-col">
          <RecordLink kind="agent" id={agent.id} label={`Abrir ${name}`}>
            {name}
          </RecordLink>
          <span className="text-xs text-muted-foreground">
            {`${agent.department.name} · ${agent.company.name}`}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <StatusChip
          tone={toneOfState(availability)}
          label={availabilityLabel(availability)}
        />
        <StatusChip
          tone={toneOfState(activity)}
          label={activityLabel(activity)}
        />
      </div>
      {current && availability === "stopped" && evidence.stop !== null ? (
        <p className="text-sm text-rose-700 dark:text-rose-300">
          {`Impedido de iniciar novas execuções (pausa: ${stopScopeLabel(evidence.stop.scope).toLowerCase()}).`}
        </p>
      ) : null}
      {current &&
      availability === "inactive" &&
      evidence.inactiveUnit !== null ? (
        <p className="text-sm text-muted-foreground">
          {`Inativo por decisão de configuração (${evidence.inactiveUnit}).`}
        </p>
      ) : null}
      {current && activity === "working" ? (
        <span className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Trabalhando agora em:</span>
          <RunLinks ids={evidence.workingRunIds} />
        </span>
      ) : null}
      <div className="flex flex-col gap-1">
        <Meta label="Última atividade">
          <RelativeTime value={agent.lastRunAt} empty="nenhuma ainda" />
        </Meta>
        {current && agent.attentionCount > 0 ? (
          <Meta label="Execuções que precisam de atenção">
            {agent.attentionCount}
          </Meta>
        ) : null}
      </div>
      <TechnicalDetails
        rows={[
          ["Agente", agent.id],
          ["Identificador", agent.slug],
          ["Disponibilidade", agent.availability],
          ["Atividade", agent.activity],
          ["Execuções trabalhando", idList(evidence.workingRunIds)],
          ["Execuções sem sinal", idList(evidence.staleRunIds)],
          ["Execuções retidas", idList(evidence.heldRunIds)],
          ["Execuções na fila", idList(evidence.queuedRunIds)],
          ["Execuções com atenção", idList(evidence.attentionRunIds)],
          [
            "Pausa",
            evidence.stop === null
              ? "—"
              : `${evidence.stop.id} (${evidence.stop.scope}, ${evidence.stop.origin})`,
          ],
        ]}
      />
    </OwnerCard>
  );
};
