import type {
  Agenda,
  AvailabilityPair,
  BookingSummary,
  FollowUpSummary,
} from "../../../../contracts/company-os-api/index.ts";
import type { Tone } from "../../format/ptBR";

// Agenda (Phase 3A): what the screen derives from the overview's agenda, as
// pure functions. The server decided every partition (today, the next seven
// days, what needs action) from its own rows; these functions only pick words
// and format instants IN THE AGENDA'S TIME ZONE, never the browser's, so an
// owner travelling abroad still reads the clinic's hours. No arithmetic on
// dates happens here beyond formatting.

/** "09:00" in the agenda's zone. */
export const localTime = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));

/** "qua., 06/03 às 10:00" in the agenda's zone. */
export const localDayTime = (iso: string, timeZone: string): string => {
  const at = new Date(iso);
  const day = new Intl.DateTimeFormat("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    timeZone,
  }).format(at);
  return `${day} às ${localTime(iso, timeZone)}`;
};

/** "segunda-feira, 4 de março" for the server's local date (YYYY-MM-DD). */
export const longDate = (localDate: string): string => {
  const [year, month, day] = localDate.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
};

/** A booking's span: "09:00–09:50". */
export const bookingSpan = (booking: BookingSummary): string =>
  `${localTime(booking.startAt, booking.timezone)}–${localTime(booking.endAt, booking.timezone)}`;

export const bookingStatusLabel = (booking: BookingSummary): string => {
  if (booking.status === "cancelled") return "Cancelado";
  if (booking.status === "rescheduled") {
    return booking.rescheduledTo === null
      ? "Remarcado"
      : `Remarcado para ${localDayTime(booking.rescheduledTo.startAt, booking.timezone)}`;
  }
  return "Agendado";
};

export const bookingStatusTone = (booking: BookingSummary): Tone =>
  booking.status === "booked"
    ? "blue"
    : booking.status === "cancelled"
      ? "gray"
      : "amber";

/** A booking's calendar mirror, in owner words; null when none was requested. */
export const calendarSyncLabel = (
  status: BookingSummary["calendarSync"],
): { readonly label: string; readonly tone: Tone } | null => {
  switch (status) {
    case null:
      return null;
    case "synced":
      return { label: "Calendário sincronizado", tone: "green" };
    case "pending":
    case "running":
      return { label: "Sincronização pendente", tone: "blue" };
    case "indeterminate":
      return { label: "Sincronização incerta", tone: "amber" };
    case "failed":
      return { label: "Sincronização falhou", tone: "red" };
    case "skipped":
      return { label: "Sem evento no calendário", tone: "gray" };
  }
};

/** A reason code, in owner words when it is a known one. */
export const reasonLabel = (code: string): string =>
  ({
    patient_request: "a pedido do cliente",
    lead_replied: "o contato respondeu",
    lead_converted: "o contato agendou",
    operator_cancelled: "cancelado pelo operador",
    plan_superseded: "substituído por um novo plano",
    completed: "concluído",
  })[code] ?? code.replaceAll("_", " ");

/** "Follow-up 2 de 3". */
export const followUpStep = (followUp: FollowUpSummary): string =>
  `Follow-up ${followUp.step} de ${followUp.stepCount}`;

export const followUpStateLabel = (followUp: FollowUpSummary): string => {
  switch (followUp.status) {
    case "due":
      return "Precisa de ação";
    case "scheduled":
      return followUp.awaitingProcessing
        ? "Aguardando processamento"
        : "Agendado";
    case "completed":
      return "Concluído";
    case "cancelled":
      return "Cancelado";
    case "superseded":
      return "Substituído";
  }
};

export const followUpTone = (followUp: FollowUpSummary): Tone =>
  followUp.status === "due"
    ? "amber"
    : followUp.status === "scheduled"
      ? followUp.awaitingProcessing
        ? "amber"
        : "blue"
      : followUp.status === "completed"
        ? "green"
        : "gray";

/** The earliest offered slot across every resource and type, or null. */
export const nextFreeSlot = (
  availability: readonly AvailabilityPair[],
): { readonly pair: AvailabilityPair; readonly startAt: string } | null => {
  let best: { pair: AvailabilityPair; startAt: string } | null = null;
  for (const pair of availability) {
    const first = pair.nextSlots[0];
    if (
      first !== undefined &&
      (best === null || Date.parse(first.startAt) < Date.parse(best.startAt))
    ) {
      best = { pair, startAt: first.startAt };
    }
  }
  return best;
};

export const CALENDAR_STATE_TEXT: Readonly<
  Record<Agenda["calendar"]["state"], { title: string; text: string }>
> = {
  local_only: {
    title: "Somente local",
    text: "Os agendamentos existem apenas no Company OS. Nenhum calendário externo está conectado.",
  },
  simulated: {
    title: "Simulado",
    text: "Os agendamentos são espelhados num calendário de teste, sem nenhum serviço externo.",
  },
};

/** Calendar mirrors that ended uncertain or failed, among the upcoming bookings. */
export const calendarAttention = (agenda: Agenda): number =>
  agenda.calendar.upcomingSyncs.indeterminate +
  agenda.calendar.upcomingSyncs.failed;

/** Bookings of the next seven days, grouped by their local day, in order. */
export const byLocalDay = (
  bookings: readonly BookingSummary[],
): readonly { readonly day: string; readonly items: BookingSummary[] }[] => {
  const groups = new Map<string, BookingSummary[]>();
  for (const booking of bookings) {
    const day = new Intl.DateTimeFormat("pt-BR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: booking.timezone,
    }).format(new Date(booking.startAt));
    groups.set(day, [...(groups.get(day) ?? []), booking]);
  }
  return [...groups].map(([day, items]) => ({ day, items }));
};
