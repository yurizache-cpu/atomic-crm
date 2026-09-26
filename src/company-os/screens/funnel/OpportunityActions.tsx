import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type {
  AvailableFunnel,
  FollowUpOutcome,
  OpportunityCard,
} from "../../../../contracts/company-os-api/index.ts";
import type {
  CommercialOutcome,
  CommercialRequest,
} from "../../query/useCommercialAct";
import {
  instantToWallTime,
  type ActKind,
  localDateTime,
  opportunityLabel,
  stageLabeller,
  wallTimeToInstant,
} from "./funnelModel";

// The four commercial acts on one opportunity card (Phase 3B.2, owner
// decision R): move to another configured stage, set or clear the next
// action, convert, mark as lost. Each opens its own panel inside the card and
// needs a second, deliberate confirmation; nothing is one click, nothing is
// dragged, and nothing moves before the server answers. A button is offered
// only when the operator context AND the card's own server hints allow it;
// every refusal still comes from the server.

const ACT_LABEL: Readonly<Record<ActKind, string>> = {
  move: "Mover etapa",
  next: "Definir próxima ação",
  convert: "Converter",
  lose: "Marcar como perdida",
};

export const OpportunityActionButtons = ({
  card,
  acts,
  open,
  pending,
  onOpen,
}: {
  card: OpportunityCard;
  acts: readonly ActKind[];
  open: ActKind | null;
  pending: boolean;
  onOpen: (kind: ActKind) => void;
}) =>
  acts.length === 0 ? null : (
    <div
      role="group"
      aria-label={`Ações da ${opportunityLabel(card.dealRef)}`}
      className="flex flex-wrap gap-1"
    >
      {acts.map((kind) => (
        <Button
          key={kind}
          variant="outline"
          size="sm"
          className={cn(
            "h-7 px-2 text-xs",
            kind === "lose" && "text-destructive hover:text-destructive",
          )}
          aria-label={`${ACT_LABEL[kind]}: ${opportunityLabel(card.dealRef)}`}
          aria-expanded={open === kind}
          disabled={pending}
          onClick={() => onOpen(kind)}
        >
          {ACT_LABEL[kind]}
        </Button>
      ))}
    </div>
  );

/** The panel's frame: a labelled alertdialog whose safe choice has the focus. */
const Panel = ({
  id,
  title,
  children,
  confirmLabel,
  canConfirm,
  pending,
  destructive = false,
  onConfirm,
  onCancel,
  extra,
}: {
  id: string;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  canConfirm: boolean;
  pending: boolean;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  extra?: ReactNode;
}) => {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), [id]);
  return (
    <div
      role="alertdialog"
      aria-labelledby={id}
      className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-2 text-xs"
    >
      <p id={id} className="text-sm font-medium">
        {title}
      </p>
      {children}
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          className="h-7 px-2 text-xs"
          variant={destructive ? "destructive" : "default"}
          disabled={pending || !canConfirm}
          onClick={onConfirm}
        >
          {pending ? "Salvando…" : confirmLabel}
        </Button>
        {extra}
        <Button
          ref={cancel}
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          disabled={pending}
          onClick={onCancel}
        >
          Cancelar
        </Button>
      </div>
    </div>
  );
};

/** One radio per choice, in a labelled group. */
const Choices = ({
  legend,
  name,
  choices,
  value,
  onChange,
}: {
  legend: string;
  name: string;
  choices: readonly { value: string; label: string }[];
  value: string | null;
  onChange: (value: string) => void;
}) => (
  <fieldset className="flex flex-col gap-1">
    <legend className="mb-1 text-xs text-muted-foreground">{legend}</legend>
    {choices.map((choice) => (
      <label key={choice.value} className="flex items-center gap-2">
        <input
          type="radio"
          name={name}
          value={choice.value}
          checked={value === choice.value}
          onChange={() => onChange(choice.value)}
        />
        {choice.label}
      </label>
    ))}
  </fieldset>
);

interface PanelProps {
  card: OpportunityCard;
  funnel: AvailableFunnel;
  pending: boolean;
  onSubmit: (request: CommercialRequest) => void;
  onCancel: () => void;
}

const MovePanel = ({
  card,
  funnel,
  pending,
  onSubmit,
  onCancel,
}: PanelProps) => {
  const [target, setTarget] = useState<string | null>(null);
  const targets = funnel.stages
    .filter((s) => !s.converted && s.code !== card.stage)
    .map((s) => ({ value: s.code, label: s.label }));
  return (
    <Panel
      id={`move-${card.dealRef}`}
      title={`Mover a ${opportunityLabel(card.dealRef)} para outra etapa?`}
      confirmLabel="Mover"
      canConfirm={target !== null}
      pending={pending}
      onCancel={onCancel}
      onConfirm={() =>
        target !== null &&
        onSubmit({
          act: "move_opportunity",
          input: {
            p_deal_ref: card.dealRef,
            p_target_stage: target,
            p_expected_revision: card.revision,
          },
        })
      }
    >
      <Choices
        legend="Nova etapa"
        name={`move-target-${card.dealRef}`}
        choices={targets}
        value={target}
        onChange={setTarget}
      />
      <p className="text-muted-foreground">
        Etapas de conversão ficam em &quot;Converter&quot;, que também registra
        a data de conversão.
      </p>
    </Panel>
  );
};

const BRIDGE_NOTE: Readonly<Record<AvailableFunnel["followUpBridge"], string>> =
  {
    configured:
      "Os follow-ups configurados serão ajustados a partir desta próxima ação.",
    invalid:
      "A configuração de follow-up automático precisa ser revista pelo responsável; nenhum follow-up será ajustado.",
    not_configured: "Nenhum follow-up automático está configurado.",
  };

const NextActionPanel = ({
  card,
  funnel,
  pending,
  onSubmit,
  onCancel,
}: PanelProps) => {
  const zone = funnel.timezone;
  const initial =
    card.nextActionAt === null
      ? { date: funnel.today, time: "09:00" }
      : instantToWallTime(card.nextActionAt, zone);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const instant = wallTimeToInstant(date, time, zone);
  const submit = (next: string | null) =>
    onSubmit({
      act: "set_opportunity_next_action",
      input: {
        p_deal_ref: card.dealRef,
        p_next_action_at: next,
        p_expected_revision: card.revision,
      },
    });
  return (
    <Panel
      id={`next-${card.dealRef}`}
      title={`Próxima ação da ${opportunityLabel(card.dealRef)}`}
      confirmLabel="Salvar próxima ação"
      canConfirm={instant !== null}
      pending={pending}
      onCancel={onCancel}
      onConfirm={() => instant !== null && submit(instant)}
      extra={
        card.nextActionAt === null ? null : (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={pending}
            onClick={() => submit(null)}
          >
            Remover próxima ação
          </Button>
        )
      }
    >
      <div className="flex flex-wrap gap-2">
        <label className="flex flex-col gap-1">
          Data
          <input
            type="date"
            className="rounded border bg-background px-1"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          Horário
          <input
            type="time"
            className="rounded border bg-background px-1"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </label>
      </div>
      <p role="status">
        {instant === null
          ? `Data ou horário inválido no fuso ${zone}.`
          : `Será registrada para ${localDateTime(instant, zone)} (${zone}).`}
      </p>
      <p className="text-muted-foreground">
        {BRIDGE_NOTE[funnel.followUpBridge]}
      </p>
    </Panel>
  );
};

const ConvertPanel = ({
  card,
  funnel,
  pending,
  onSubmit,
  onCancel,
}: PanelProps) => {
  const converted = funnel.stages
    .filter((s) => s.converted)
    .map((s) => ({ value: s.code, label: s.label }));
  const [target, setTarget] = useState<string | null>(
    converted.length === 1 ? converted[0].value : null,
  );
  return (
    <Panel
      id={`convert-${card.dealRef}`}
      title="Marcar esta oportunidade como convertida?"
      confirmLabel="Converter"
      canConfirm={target !== null}
      pending={pending}
      onCancel={onCancel}
      onConfirm={() =>
        target !== null &&
        onSubmit({
          act: "convert_opportunity",
          input: {
            p_deal_ref: card.dealRef,
            p_target_stage: target,
            p_expected_revision: card.revision,
          },
        })
      }
    >
      <p>{opportunityLabel(card.dealRef)}</p>
      {converted.length === 1 ? (
        <p>Etapa de conversão: {converted[0].label}</p>
      ) : (
        <Choices
          legend="Etapa de conversão"
          name={`convert-target-${card.dealRef}`}
          choices={converted}
          value={target}
          onChange={setTarget}
        />
      )}
      <p className="text-muted-foreground">
        A data de conversão será registrada agora e a próxima ação será
        removida.
      </p>
    </Panel>
  );
};

const LosePanel = ({
  card,
  funnel,
  pending,
  onSubmit,
  onCancel,
}: PanelProps) => {
  const [reason, setReason] = useState<string | null>(null);
  return (
    <Panel
      id={`lose-${card.dealRef}`}
      title="Marcar esta oportunidade como perdida?"
      confirmLabel="Marcar como perdida"
      destructive
      canConfirm={reason !== null}
      pending={pending}
      onCancel={onCancel}
      onConfirm={() =>
        reason !== null &&
        onSubmit({
          act: "lose_opportunity",
          input: {
            p_deal_ref: card.dealRef,
            p_loss_reason: reason,
            p_expected_revision: card.revision,
          },
        })
      }
    >
      <p>{opportunityLabel(card.dealRef)}</p>
      <Choices
        legend="Motivo da perda"
        name={`lose-reason-${card.dealRef}`}
        choices={funnel.lossReasons.map((r) => ({
          value: r.code,
          label: r.label,
        }))}
        value={reason}
        onChange={setReason}
      />
      <p className="text-muted-foreground">
        A data da perda será registrada agora e a próxima ação será removida.
      </p>
    </Panel>
  );
};

const PANELS: Readonly<Record<ActKind, (props: PanelProps) => ReactNode>> = {
  move: MovePanel,
  next: NextActionPanel,
  convert: ConvertPanel,
  lose: LosePanel,
};

export const OpportunityActionPanel = ({
  kind,
  ...props
}: PanelProps & { kind: ActKind }) => {
  const Selected = PANELS[kind];
  return <Selected {...props} />;
};

// ---------------------------------------------------------------------------
// What the owner is told once an act settles.
// ---------------------------------------------------------------------------

export const STALE_TEXT =
  "A oportunidade mudou desde a última atualização. Atualize e tente novamente.";
export const UNKNOWN_TEXT =
  "Não foi possível confirmar se a alteração foi registrada. O funil foi atualizado; confira a oportunidade antes de tentar de novo.";

const REFUSAL_TEXT: Readonly<
  Record<Exclude<CommercialOutcome["kind"], "done">, string>
> = {
  stale: `${STALE_TEXT} O funil já foi atualizado.`,
  busy: "O CRM estava ocupado e nada foi alterado. Tente novamente em instantes.",
  not_allowed: "Você não tem acesso para alterar oportunidades.",
  not_found: "Esta oportunidade não foi encontrada. O funil foi atualizado.",
  refused: "A alteração não foi aceita. Revise os dados e tente novamente.",
  unknown: UNKNOWN_TEXT,
};

const followUpText = (followUp: FollowUpOutcome | null): string | null => {
  if (followUp === null) return null;
  switch (followUp.status) {
    case "scheduled":
      return "Os follow-ups configurados foram ajustados a partir desta próxima ação.";
    case "cancelled":
      return "O follow-up automático desta oportunidade foi cancelado.";
    case "not_scheduled":
      switch (followUp.reason) {
        case "existing_plan":
          return "Já havia um follow-up criado fora desta tela para esta oportunidade; ele foi mantido e nenhum follow-up automático foi ajustado.";
        case "outside_window":
          return "A cadência de follow-up começaria fora do período permitido; nenhum follow-up automático foi agendado.";
        default:
          return "A configuração de follow-up automático precisa ser revista pelo responsável; nenhum follow-up foi ajustado.";
      }
    default:
      return null;
  }
};

/** The sentence for an act the server recorded. */
const doneText = (
  request: CommercialRequest,
  funnel: AvailableFunnel,
): string => {
  const who = opportunityLabel(request.input.p_deal_ref);
  const label = stageLabeller(funnel);
  switch (request.act) {
    case "move_opportunity":
      return `${who} movida para ${label(request.input.p_target_stage)}.`;
    case "set_opportunity_next_action":
      return request.input.p_next_action_at === null
        ? `Próxima ação da ${who} removida.`
        : `Próxima ação da ${who} registrada para ${localDateTime(request.input.p_next_action_at, funnel.timezone)}.`;
    case "convert_opportunity":
      return `${who} marcada como convertida em ${label(request.input.p_target_stage)}.`;
    case "lose_opportunity": {
      const reason = funnel.lossReasons.find(
        (r) => r.code === request.input.p_loss_reason,
      );
      return `${who} marcada como perdida${reason ? ` (${reason.label})` : ""}.`;
    }
  }
};

export const CommercialOutcomeMessage = ({
  outcome,
  funnel,
}: {
  outcome: CommercialOutcome;
  funnel: AvailableFunnel;
}) => {
  const good = outcome.kind === "done";
  const text =
    outcome.kind === "done"
      ? [
          outcome.changed
            ? doneText(outcome.request, funnel)
            : `Nada mudou: a ${opportunityLabel(outcome.request.input.p_deal_ref)} já estava assim.`,
          followUpText(outcome.followUp),
        ]
          .filter((part) => part !== null)
          .join(" ")
      : REFUSAL_TEXT[outcome.kind];
  return (
    <p
      role="status"
      className={cn(
        "rounded-lg border px-3 py-2 text-sm",
        good
          ? "border-emerald-500/40 bg-emerald-500/10"
          : "border-amber-500/40 bg-amber-500/10",
      )}
    >
      {text}
    </p>
  );
};
