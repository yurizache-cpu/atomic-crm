import {
  AlertTriangle,
  Hourglass,
  PauseCircle,
  Scale,
  Send,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import type { OverviewSummary } from "../../../../contracts/company-os-api/index.ts";
import { COMPANY_OS_ROOT, LIST_PATHS } from "../../components/recordPaths";
import type { Tone } from "../../format/ptBR";

// Saúde operacional (Phase 2E.2): what the screen derives from the overview,
// as pure functions. Every number is a sum of counts the server computed from
// authoritative rows; nothing is estimated, scored or graded. "Precisa de
// atenção" lists only concrete states that exist now or happened in the last
// 24 hours, and no age is ever judged: there is no approved threshold, so the
// screen shows the age itself.

type Health = OverviewSummary["operationalHealth"];

const count = (
  map: Readonly<Partial<Record<string, number>>>,
  ...keys: string[]
): number => keys.reduce((sum, key) => sum + (map[key] ?? 0), 0);

/** Failures recorded in the window, by what failed. */
export const failuresInWindow = (health: Health) => {
  const parts = {
    jobs: health.queue.failedInWindow,
    runs: count(health.agentRuns.inWindowByStatus, "failed"),
    decisions:
      health.decisions.inWindow.failed + health.decisions.inWindow.invalid,
    sends: count(health.outbound.inWindowByStatus, "failed"),
  };
  return {
    ...parts,
    total: parts.jobs + parts.runs + parts.decisions + parts.sends,
  };
};

/** Outcomes nobody can know (the call may or may not have happened), in the window. */
export const uncertainInWindow = (health: Health) => {
  const parts = {
    runs: count(health.agentRuns.inWindowByStatus, "indeterminate"),
    decisions: health.decisions.inWindow.indeterminate,
    sends: count(health.outbound.inWindowByStatus, "indeterminate"),
  };
  return { ...parts, total: parts.runs + parts.decisions + parts.sends };
};

export interface ExternalCallRow {
  readonly label: string;
  readonly done: number;
  readonly failed: number;
  readonly uncertain: number;
  /** Requested and not yet settled: waiting for its call, or in it. */
  readonly inProgress: number;
}

/**
 * The work that calls a service outside the Company OS, by its recorded
 * outcome in the window: agent runs (the model), shadow decisions (the
 * decision provider) and WhatsApp sends.
 */
export const externalCallRows = (health: Health): ExternalCallRow[] => {
  const runs = health.agentRuns.inWindowByStatus;
  const decisions = health.decisions.inWindow;
  const sends = health.outbound.inWindowByStatus;
  return [
    {
      label: "Modelo de IA (execuções de agente)",
      done: count(runs, "succeeded"),
      failed: count(runs, "failed"),
      uncertain: count(runs, "indeterminate"),
      inProgress: count(runs, "pending", "running"),
    },
    {
      label: "Motor de decisão (modo sombra)",
      done: decisions.completed + decisions.abstained,
      failed: decisions.failed + decisions.invalid,
      uncertain: decisions.indeterminate,
      inProgress: health.decisions.pendingNow,
    },
    {
      label: "WhatsApp (envios)",
      done: count(sends, "sent", "delivered", "read"),
      failed: count(sends, "failed"),
      uncertain: count(sends, "indeterminate"),
      inProgress: count(sends, "authorized", "sending"),
    },
  ];
};

export interface AttentionItem {
  readonly id: string;
  readonly icon: LucideIcon;
  readonly tone: Tone;
  readonly text: string;
  readonly to: string;
}

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/** Concrete states only, most urgent first. Empty means nothing needs attention. */
export const attentionItems = (data: OverviewSummary): AttentionItem[] => {
  const health = data.operationalHealth;
  const items: AttentionItem[] = [];
  if (health.queue.expiredLeases > 0) {
    items.push({
      id: "expired-leases",
      icon: Hourglass,
      tone: "red",
      text: `${plural(health.queue.expiredLeases, "execução passou", "execuções passaram")} do prazo sem concluir; um trabalhador ativo as devolve à fila na próxima verificação`,
      to: `${LIST_PATHS.runs}?attention=1`,
    });
  }
  if (data.runs.needingAttention > 0) {
    items.push({
      id: "runs-attention",
      icon: AlertTriangle,
      tone: "amber",
      text: `${plural(data.runs.needingAttention, "execução de agente precisa", "execuções de agente precisam")} de atenção (resultado incerto ou sem trabalho ativo)`,
      to: `${LIST_PATHS.runs}?attention=1`,
    });
  }
  if (data.outbound.indeterminateOpen > 0) {
    items.push({
      id: "sends-uncertain",
      icon: Send,
      tone: "amber",
      text: `${plural(data.outbound.indeterminateOpen, "envio com resultado incerto", "envios com resultado incerto")} em aberto`,
      to: `${COMPANY_OS_ROOT}/communications`,
    });
  }
  if (health.decisions.inWindow.indeterminate > 0) {
    items.push({
      id: "decisions-uncertain",
      icon: Scale,
      tone: "amber",
      text: `${plural(health.decisions.inWindow.indeterminate, "decisão em sombra terminou", "decisões em sombra terminaram")} com resultado incerto nas últimas 24 h`,
      to: LIST_PATHS.reviews,
    });
  }
  if (
    data.stops.tenantScopedActive > 0 ||
    data.platform.globalAdmissionBlocked
  ) {
    items.push({
      id: "stops",
      icon: PauseCircle,
      tone: "red",
      text:
        data.stops.tenantScopedActive > 0
          ? `${plural(data.stops.tenantScopedActive, "pausa ativa bloqueia", "pausas ativas bloqueiam")} execuções desta empresa`
          : "Uma pausa da plataforma bloqueia novas execuções",
      to: LIST_PATHS.stops,
    });
  }
  const failures = failuresInWindow(health);
  if (failures.total > 0) {
    items.push({
      id: "failures",
      icon: XCircle,
      tone: "amber",
      text: `${plural(failures.total, "falha registrada", "falhas registradas")} nas últimas 24 h`,
      to: LIST_PATHS.runs,
    });
  }
  return items;
};

/** Owner words for an engine job kind; the kind itself stays in the details. */
export const jobKindLabel = (kind: string): string =>
  ({
    "agent_run.execute": "Execução de agente",
    "decision.shadow_evaluate": "Decisão em sombra",
    "postmark.ledger_retention": "Manutenção do registro de e-mails",
  })[kind] ?? "Outro trabalho";
