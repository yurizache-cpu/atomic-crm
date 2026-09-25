import type {
  AvailableFunnel,
  FunnelMovement,
  NEXT_ACTION_STATES,
  OpportunityCard,
  Origin,
  OriginCount,
} from "../../../../contracts/company-os-api/index.ts";

// The Funil screen's wording and arithmetic, all of it presentation: every
// count, state and window is the server's (contracts/company-os-api/funnel.ts).
// The one computation here is the closing rate's percentage, from the two
// counts the server returns, and it is withheld when their sum is zero.

type Tone = "green" | "blue" | "amber" | "red" | "gray";

/** "Oportunidade #123": the CRM's reference, never a title or a name. */
export const opportunityLabel = (dealRef: number): string =>
  `Oportunidade #${dealRef}`;

/** The configured label of a stage code; null (not configured) reads as such. */
export const stageLabeller = (funnel: AvailableFunnel) => {
  const labels = new Map(funnel.stages.map((s) => [s.code, s.label]));
  return (code: string | null): string =>
    code === null
      ? "Etapa não configurada"
      : (labels.get(code) ?? "Etapa não configurada");
};

/** Time in the current stage, in whole days in the tenant's zone. */
export const stageAgeText = (days: number): string =>
  days === 0 ? "Hoje" : days === 1 ? "Há 1 dia" : `Há ${days} dias`;

const dateTimeIn = (timeZone: string) =>
  new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

const dateIn = (timeZone: string) =>
  new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

/** "04/03 às 11:00" in the tenant's zone. */
export const localDateTime = (instant: string, timeZone: string): string => {
  const parts = dateTimeIn(timeZone).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get("day")}/${get("month")} às ${get("hour")}:${get("minute")}`;
};

/** "24/02/2030" in the tenant's zone. */
export const localDate = (instant: string, timeZone: string): string =>
  dateIn(timeZone).format(new Date(instant));

export const NEXT_ACTION_CHIP: Readonly<
  Record<(typeof NEXT_ACTION_STATES)[number], { label: string; tone: Tone }>
> = {
  overdue: { label: "Próxima ação atrasada", tone: "red" },
  today: { label: "Próxima ação hoje", tone: "amber" },
  future: { label: "Próxima ação agendada", tone: "blue" },
  none: { label: "Sem próxima ação", tone: "gray" },
};

/** The chip a card shows about its next action, with its instant when it has one. */
export const nextActionText = (
  card: OpportunityCard,
  timeZone: string,
): { label: string; tone: Tone } => {
  const chip = NEXT_ACTION_CHIP[card.nextAction];
  return card.nextActionAt === null
    ? chip
    : {
        ...chip,
        label: `${chip.label} · ${localDateTime(card.nextActionAt, timeZone)}`,
      };
};

/** A deal's origin as the CRM recorded it; never a guessed category. */
export const originText = (origin: Origin): string => {
  switch (origin.kind) {
    case "recorded":
      return origin.label;
    case "unknown":
      return "Sem origem registrada";
    case "multiple":
      return "Várias origens";
    case "withheld":
      return "Origem não exibida";
  }
};

export const originCountLabel = (item: OriginCount): string => {
  switch (item.kind) {
    case "recorded":
      return item.label ?? "";
    case "other":
      return "Outras origens registradas";
    case "unknown":
      return "Sem origem registrada";
    case "multiple":
      return "Várias origens";
    case "withheld":
      return "Origem não exibida";
  }
};

/** An informed amount, in the CRM's currency when it has one. Never revenue. */
export const amountText = (amount: number, currency: string | null): string =>
  currency === null
    ? new Intl.NumberFormat("pt-BR").format(amount)
    : new Intl.NumberFormat("pt-BR", {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
      }).format(amount);

/**
 * The closing rate over the window: converted / (converted + lost), both
 * counted over outcomes dated in the same window. No denominator, no rate.
 */
export const closingRate = (
  summary: AvailableFunnel["summary"],
): { value: string; hint: string } => {
  const closed = summary.converted + summary.lost;
  if (closed === 0) {
    return {
      value: "—",
      hint: `Nenhuma oportunidade encerrada em ${summary.windowDays} dias`,
    };
  }
  const percent = Math.round((summary.converted / closed) * 100);
  return {
    value: `${percent}%`,
    hint: `${summary.converted} convertida${summary.converted === 1 ? "" : "s"} de ${closed} encerrada${closed === 1 ? "" : "s"}`,
  };
};

/** One observed movement, as a sentence about stages only. */
export const movementText = (
  movement: FunnelMovement,
  label: (code: string | null) => string,
): string =>
  movement.entered
    ? `Entrou em ${label(movement.toStage)}`
    : `${label(movement.fromStage)} → ${label(movement.toStage)}`;

/** What is known about movement history, stated plainly. */
export const coverageText = (
  movements: AvailableFunnel["movements"],
  timeZone: string,
): string =>
  movements.coverageStart === null
    ? "Nenhuma movimentação registrada ainda. O histórico começa na primeira mudança de etapa observada; o que aconteceu antes não é conhecido."
    : `Histórico de movimentações disponível a partir de ${localDate(movements.coverageStart, timeZone)}. Antes disso, as mudanças de etapa não foram registradas.`;

/** "Mostrando 10 de 14" when a list holds fewer items than its total. */
export const shownOf = (shown: number, total: number): string | null =>
  total > shown ? `Mostrando ${shown} de ${total}` : null;
