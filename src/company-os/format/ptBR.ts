import type { Money } from "../../../contracts/company-os-api/index.ts";

// The owner-facing vocabulary of the Company OS, in Brazilian Portuguese.
// Presentation only: every value is still the one the projection returned; a
// label never adds a fact the server did not report. Values with no label here
// fall back to their words (`needs_edit` -> "needs edit"), so an unknown enum
// is shown, never hidden.

export type Tone = "green" | "blue" | "amber" | "red" | "gray";

const words = (value: string): string => value.replaceAll("_", " ");

const labelFrom =
  (map: Readonly<Record<string, string>>) =>
  (value: string): string =>
    map[value] ?? words(value);

export const runStatusLabel = labelFrom({
  pending: "Na fila",
  running: "Executando",
  succeeded: "Concluída",
  failed: "Falhou",
  indeterminate: "Resultado incerto",
  cancelled: "Cancelada",
  unknown: "Desconhecido",
});

export const reviewStatusLabel = labelFrom({
  pending: "Aguardando sua revisão",
  accepted: "Aceita",
  rejected: "Rejeitada",
  needs_edit: "Precisa de ajuste",
});

export const taskStatusLabel = labelFrom({
  queued: "Na fila",
  assigned: "Atribuída",
  in_progress: "Em andamento",
  waiting: "Aguardando",
  completed: "Concluída",
  failed: "Falhou",
  cancelled: "Cancelada",
});

export const activityLabel = labelFrom({
  working: "Trabalhando",
  stale: "Sem sinal do trabalho",
  held: "Retido por pausa",
  queued: "Com trabalho na fila",
  idle: "Ocioso",
  unknown: "Desconhecido",
});

export const availabilityLabel = labelFrom({
  available: "Disponível",
  stopped: "Pausado",
  inactive: "Inativo",
  unknown: "Desconhecido",
});

export const outboundStatusLabel = labelFrom({
  authorized: "Envio autorizado por um pedido de envio do operador",
  blocked: "Envio bloqueado",
  sending: "Enviando",
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  failed: "Envio falhou",
  indeterminate: "Envio incerto",
});

export const admissionLabel = labelFrom({
  blocked: "Bloqueada",
  conditional: "Liberada dentro do orçamento",
  unconfigured: "Sem orçamento configurado",
});

export const stopScopeLabel = labelFrom({
  tenant: "Toda a empresa",
  company: "Empresa",
  department: "Departamento",
  agent: "Agente",
  job_kind: "Tipo de trabalho",
});

export const attentionLabel = labelFrom({
  indeterminate_not_retried: "Resultado incerto, sem nova tentativa",
  running_without_live_lease: "Executando sem sinal do trabalhador",
});

export const capabilityLabel = labelFrom({
  lead_triage: "Triagem de novo lead",
});

export const taskTypeLabel = capabilityLabel;

export const adviceLabel = labelFrom({
  triaged: "Triado",
  needs_input: "Precisa de mais informação",
  out_of_scope: "Fora do escopo",
  book_appointment: "Quer agendar",
  pricing: "Pergunta sobre preços",
  information: "Pede informações",
  support: "Pede suporte",
  other: "Outro",
  low: "Baixa",
  normal: "Normal",
  high: "Alta",
  possible_crisis: "Possível crise",
  minor: "Menor de idade",
  already_a_patient: "Já é paciente",
  spam: "Spam",
  unclear: "Pouco claro",
});

export const withheldLabel = labelFrom({
  capability_not_pinned:
    "não existe análise estruturada para este tipo de trabalho",
  origin_not_synthetic_or_test:
    "a tarefa não chegou por uma origem sintética ou de teste",
  contract_invalid: "a proposta guardada não corresponde ao formato esperado",
});

export const jobStepLabel = labelFrom({
  job_leased: "Trabalho assumido por um trabalhador",
  job_deferred: "Trabalho adiado por uma pausa",
  job_retry: "Nova tentativa agendada",
  job_reaped: "Trabalho recuperado após expirar",
});

export const sourceLabel = labelFrom({
  "agent-runtime": "Execução do agente",
  "agent-runtime-smoke": "Teste do agente",
  "company-os-ui": "Company OS",
  "lead-triage-demo": "Demonstração",
  "operator-cli": "Operador",
  "scheduling-demo": "Demonstração de agenda",
  seed: "Configuração inicial",
  "whatsapp-gateway": "WhatsApp",
  other: "Outra origem",
});

export const inboundSourceLabel = labelFrom({
  synthetic: "Mensagem sintética",
  whatsapp: "WhatsApp",
});

export const contactResolutionLabel = labelFrom({
  found: "Encontrado",
  not_found: "Não encontrado",
  ambiguous: "Mais de um contato",
  unavailable: "Consulta indisponível",
});

/** The tone of a state: green healthy, blue working, amber waiting, red problem. */
export const toneOfState = (value: string): Tone => {
  if (
    [
      "available",
      "succeeded",
      "accepted",
      "delivered",
      "read",
      "sent",
      "completed",
      "cleared",
    ].includes(value)
  )
    return "green";
  if (
    ["working", "running", "sending", "in_progress", "conditional"].includes(
      value,
    )
  )
    return "blue";
  if (
    [
      "pending",
      "queued",
      "held",
      "waiting",
      "needs_edit",
      "stale",
      "assigned",
      "indeterminate",
      "authorized",
      "indeterminate_not_retried",
      "running_without_live_lease",
    ].includes(value)
  )
    return "amber";
  if (["stopped", "failed", "blocked", "rejected", "cancelled"].includes(value))
    return "red";
  return "gray";
};

/** An event's type as a sentence; the type itself stays in the technical details. */
export const eventSentence = labelFrom({
  "company.created": "Empresa criada",
  "company.status_changed": "Situação da empresa alterada",
  "department.created": "Departamento criado",
  "department.status_changed": "Situação do departamento alterada",
  "agent.created": "Agente criado",
  "agent.status_changed": "Situação do agente alterada",
  "task.created": "Nova tarefa criada",
  "task.assigned": "Tarefa atribuída a um agente",
  "task.status_changed": "Situação da tarefa alterada",
  "task.completed": "Tarefa concluída",
  "task.failed": "Tarefa falhou",
  "task.cancelled": "Tarefa cancelada",
  "task.execution_requested": "Execução pedida para a tarefa",
  "agent_run.requested": "Execução do agente pedida",
  "agent_run.started": "Agente começou a trabalhar",
  "agent_run.succeeded": "Agente concluiu o trabalho",
  "agent_run.failed": "Execução do agente falhou",
  "agent_run.indeterminate": "Execução com resultado incerto",
  "agent_run.cancelled": "Execução cancelada",
  "lead_triage.admitted": "Novo lead recebido",
  "lead_triage.review_pending": "Triagem pronta: aguardando revisão",
  "lead_triage.reviewed": "Decisão registrada na triagem",
  "communication.received": "Mensagem recebida",
  "communication.inbound_refused": "Mensagem recusada",
  "communication.inbound_held": "Mensagem retida",
  "communication.channel_configured": "Canal configurado",
  "communication.outbound_authorized": "Envio autorizado pelo operador",
  "communication.outbound_attempted": "Envio tentado",
  "communication.outbound_blocked": "Envio bloqueado",
  "communication.outbound_sent": "Mensagem enviada",
  "communication.outbound_failed": "Envio falhou",
  "communication.outbound_indeterminate": "Envio com resultado incerto",
  "communication.delivery_updated": "Situação da entrega atualizada",
  "follow_up.scheduled": "Follow-up agendado",
  "follow_up.due": "Follow-up precisa de ação",
  "follow_up.completed": "Follow-up concluído",
  "follow_up.cancelled": "Follow-up cancelado",
  "follow_up.superseded": "Follow-up substituído por um novo plano",
  "booking.created": "Atendimento agendado",
  "booking.rescheduled": "Atendimento remarcado",
  "booking.cancelled": "Atendimento cancelado",
  "calendar.sync_requested": "Sincronização de calendário pedida",
  "calendar.sync_completed": "Calendário sincronizado",
  "calendar.sync_failed": "Sincronização de calendário falhou",
  "calendar.sync_indeterminate": "Sincronização de calendário incerta",
  "calendar.sync_skipped": "Sincronização de calendário sem evento",
});

export const yesNoLabel = (value: boolean): string => (value ? "Sim" : "Não");

const TIME = new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit",
  minute: "2-digit",
});
const DATE = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const EXACT = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "medium",
  timeZone: "UTC",
});

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * A contract timestamp as the owner reads it, in the browser's own time zone:
 * "agora", "há 2 min", "há 1 h" within the last hours, then "hoje às 11:35",
 * "ontem às 18:02" or a date. The exact UTC value is `exactTime`.
 */
export const relativeTime = (iso: string, now: number = Date.now()): string => {
  const at = new Date(iso);
  const seconds = Math.round((now - at.getTime()) / 1000);
  if (seconds < 45 && seconds > -45) return "agora";
  if (seconds > 0 && seconds < 3600)
    return `há ${Math.round(seconds / 60)} min`;
  if (seconds > 0 && seconds < 6 * 3600)
    return `há ${Math.round(seconds / 3600)} h`;
  const days = Math.round(
    (startOfDay(new Date(now)) - startOfDay(at)) / 86_400_000,
  );
  if (days === 0) return `hoje às ${TIME.format(at)}`;
  if (days === 1) return `ontem às ${TIME.format(at)}`;
  return `${DATE.format(at)} às ${TIME.format(at)}`;
};

export const exactTime = (iso: string): string =>
  `${EXACT.format(new Date(iso))} UTC`;

const USD = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * The server's USD amount in words an owner reads: "US$ 1,23", or "< US$ 0,01"
 * for a charge below one cent. Formatting only: the exact amount the server
 * computed stays in the technical details (`exactMoney`).
 */
export const moneyLabel = (money: Money): string => {
  if (money.micros === "0") return USD.format(0);
  if (money.micros.startsWith("-")) return USD.format(Number(money.usd));
  return BigInt(money.micros) < 10_000n
    ? "< US$ 0,01"
    : USD.format(Number(money.usd));
};

export const exactMoney = (money: Money): string =>
  `${money.usd} USD (${money.micros} micros)`;

/** Any state value, when the screen does not say which kind it is. */
export const stateLabel = labelFrom({
  pending: "Pendente",
  running: "Executando",
  succeeded: "Concluída",
  failed: "Falhou",
  indeterminate: "Incerto",
  cancelled: "Cancelada",
  accepted: "Aceita",
  rejected: "Rejeitada",
  needs_edit: "Precisa de ajuste",
  working: "Trabalhando",
  stale: "Sem sinal",
  held: "Retido",
  queued: "Na fila",
  idle: "Ocioso",
  available: "Disponível",
  stopped: "Pausado",
  inactive: "Inativo",
  unknown: "Desconhecido",
  blocked: "Bloqueada",
  conditional: "Liberada",
  unconfigured: "Sem orçamento",
  leased: "Em execução",
  cleared: "Encerrada",
  active: "Ativa",
  assigned: "Atribuída",
  in_progress: "Em andamento",
  waiting: "Aguardando",
  completed: "Concluída",
  read_only: "Somente leitura",
  test: "Teste",
  production: "Produção",
});
