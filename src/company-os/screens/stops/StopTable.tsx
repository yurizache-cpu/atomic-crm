import { PauseCircle } from "lucide-react";

import type { ExecutionStopSummary } from "../../../../contracts/company-os-api/index.ts";
import { RecordLink } from "../../components/display";
import {
  Meta,
  OwnerCard,
  RelativeTime,
  StatusChip,
  TechnicalDetails,
} from "../../components/owner";
import { stopScopeLabel } from "../../format/ptBR";
import { useOperatorScope } from "../../session/runtime";

// Stops naming the caller's tenant, from their own rows
// (docs/PHASE_2C_BRIEF.md §9, §12): what is paused, why and since when, and
// whether the pause is still active. Read-only: a stop is tripped and cleared
// only through the operator CLI, and no tripped_by or cleared_by label is ever
// shown. A tenant job_kind stop is listed read-only like the others.

const meaningOf = (stop: ExecutionStopSummary): string => {
  if (stop.clearedAt !== null) return "Esta pausa foi encerrada.";
  switch (stop.scope) {
    case "agent":
      return "Este agente está impedido de iniciar novas execuções.";
    case "department":
      return "Os agentes deste departamento estão impedidos de iniciar novas execuções.";
    case "company":
      return "Os agentes desta empresa estão impedidos de iniciar novas execuções.";
    case "job_kind":
      return "Este tipo de trabalho está impedido de iniciar novas execuções nesta empresa.";
    default:
      return "Toda a empresa está impedida de iniciar novas execuções.";
  }
};

const TargetName = ({ stop }: { stop: ExecutionStopSummary }) => {
  const { context } = useOperatorScope();
  if (stop.target === null) return <span>{context.tenant.name}</span>;
  const { target } = stop;
  return target.agentId === null ? (
    <span>{target.name}</span>
  ) : (
    <RecordLink
      kind="agent"
      id={target.agentId}
      label={`Agente ${target.name}`}
    >
      {target.name}
    </RecordLink>
  );
};

const StopCard = ({ stop }: { stop: ExecutionStopSummary }) => {
  const active = stop.clearedAt === null;
  return (
    <OwnerCard
      label={`Pausa ${stopScopeLabel(stop.scope)}`}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span
            className={
              active
                ? "rounded-xl bg-rose-500/10 p-2.5 text-rose-700 dark:text-rose-300"
                : "rounded-xl bg-muted p-2.5 text-muted-foreground"
            }
          >
            <PauseCircle aria-hidden className="size-5" />
          </span>
          <div className="flex flex-col gap-1">
            <span className="font-medium">
              <TargetName stop={stop} />
            </span>
            <span className="text-sm">{meaningOf(stop)}</span>
          </div>
        </div>
        <span className="flex flex-wrap gap-1">
          <StatusChip
            tone={active ? "red" : "green"}
            label={active ? "Ativa" : "Encerrada"}
          />
          {stop.scope === "job_kind" ? (
            <StatusChip tone="gray" label="Somente leitura" />
          ) : null}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <Meta label="Alcance">{stopScopeLabel(stop.scope)}</Meta>
        <Meta label="Motivo">
          <span className="whitespace-pre-wrap">{stop.reason}</span>
        </Meta>
        <Meta label="Início">
          <RelativeTime value={stop.trippedAt} />
        </Meta>
        {active ? null : (
          <>
            <Meta label="Encerrada">
              <RelativeTime value={stop.clearedAt} />
            </Meta>
            <Meta label="Motivo do encerramento">
              {stop.clearedReason ?? "—"}
            </Meta>
          </>
        )}
      </div>
      <TechnicalDetails
        rows={[
          ["Pausa", stop.id],
          ["Alcance", stop.scope],
          ["Tipo de trabalho", stop.jobKind ?? "—"],
          ["Origem", stop.origin],
          ["Empresa", stop.target?.companyId ?? "—"],
          ["Departamento", stop.target?.departmentId ?? "—"],
          ["Agente", stop.target?.agentId ?? "—"],
          ["Início (UTC)", stop.trippedAt],
          ["Encerrada (UTC)", stop.clearedAt ?? "—"],
        ]}
      />
    </OwnerCard>
  );
};

export const StopTable = ({
  stops,
  label,
}: {
  stops: readonly ExecutionStopSummary[];
  label: string;
}) => (
  <div role="list" aria-label={label} className="flex flex-col gap-3">
    {stops.map((stop) => (
      <div role="listitem" key={stop.id}>
        <StopCard stop={stop} />
      </div>
    ))}
  </div>
);
