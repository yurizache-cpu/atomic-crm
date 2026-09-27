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

// The four commercial acts a card may offer (Phase 3B.2).
export type ActKind = "move" | "next" | "convert" | "lose";

/** Which acts a card offers: the operator context's hint and the card's. */
export const offeredActs = (
  card: OpportunityCard,
  allowed: {
    readonly moveOpportunity: boolean;
    readonly setOpportunityNextAction: boolean;
    readonly convertOpportunity: boolean;
    readonly loseOpportunity: boolean;
  },
): ActKind[] =>
  [
    allowed.moveOpportunity && card.actions.move ? "move" : null,
    allowed.setOpportunityNextAction && card.actions.setNextAction
      ? "next"
      : null,
    allowed.convertOpportunity && card.actions.convert ? "convert" : null,
    allowed.loseOpportunity && card.actions.lose ? "lose" : null,
  ].filter((kind): kind is ActKind => kind !== null);

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

// ---------------------------------------------------------------------------
// Wall-clock time in the funnel's zone (Phase 3B.2). The owner types a date
// and a time as they read them in the tenant's IANA zone; the act sends the
// absolute instant. No library: the zone's offset is read from Intl.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

const wallParts = (ms: number, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
};

/** The zone's offset from UTC at an instant, in ms (wall clock minus UTC). */
const offsetAt = (ms: number, timeZone: string): number => {
  const w = wallParts(ms, timeZone);
  const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wall - Math.floor(ms / 1000) * 1000;
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

/**
 * The absolute instant (ISO, UTC) of a date ("2030-03-04") and a time
 * ("09:30") on the wall clock of `timeZone`; null when either is malformed or
 * when that local time does not exist there (a daylight-saving gap). A time
 * that occurs twice (the hour repeated when clocks go back) is the earlier
 * instant.
 */
export const wallTimeToInstant = (
  date: string,
  time: string,
  timeZone: string,
): string | null => {
  const d = DATE_PATTERN.exec(date);
  const t = TIME_PATTERN.exec(time);
  if (d === null || t === null) return null;
  const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [hour, minute] = [Number(t[1]), Number(t[2])];
  if (hour > 23 || minute > 59) return null;
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wall);
  if (check.getUTCDate() !== day || check.getUTCMonth() !== month - 1) {
    return null;
  }
  const candidates = [
    ...new Set(
      [
        offsetAt(wall - DAY_MS, timeZone),
        offsetAt(wall + DAY_MS, timeZone),
      ].map((offset) => wall - offset),
    ),
  ]
    .filter((ms) => offsetAt(ms, timeZone) === wall - ms)
    .sort((a, b) => a - b);
  return candidates.length === 0 ? null : new Date(candidates[0]).toISOString();
};

/** An instant as the date and time the owner reads in `timeZone`. */
export const instantToWallTime = (
  instant: string,
  timeZone: string,
): { date: string; time: string } => {
  const w = wallParts(new Date(instant).getTime(), timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${w.year}-${pad(w.month)}-${pad(w.day)}`,
    time: `${pad(w.hour)}:${pad(w.minute)}`,
  };
};

/** "Mostrando 10 de 14" when a list holds fewer items than its total. */
export const shownOf = (shown: number, total: number): string | null =>
  total > shown ? `Mostrando ${shown} de ${total}` : null;
