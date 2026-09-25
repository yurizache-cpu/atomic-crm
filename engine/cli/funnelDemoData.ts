// The synthetic commercial funnel (Phase 3B.1): one fictional clinic's
// opportunities, shared by the owner demo (funnelDemo.ts) and the recorded
// projection the browser tests replay (engine/domain/
// companyOsFunnelRecording.dbtest.ts).
//
// TENANT DATA, NOT ENGINE VOCABULARY. The stage codes and labels are the
// clinic's current configuration (what the CRM's Settings store in
// public.configuration), exactly as a tenant would configure them; the engine
// and the adapter know none of them (ADR 0013).
//
// Fictional: no deal has a real title, no contact a real name, and every
// instant is relative to an "as of" instant the caller chooses.

export interface FunnelDemoStage {
  readonly value: string;
  readonly label: string;
}

export const FUNNEL_DEMO_STAGES: readonly FunnelDemoStage[] = Object.freeze([
  { value: "new_lead", label: "Novo lead" },
  { value: "contact_started", label: "Contato iniciado" },
  { value: "conversation_active", label: "Conversa ativa" },
  { value: "initial_session_scheduled", label: "Sessão inicial agendada" },
  { value: "initial_session_paid", label: "Sessão inicial paga" },
  { value: "initial_session_attended", label: "Sessão inicial realizada" },
  { value: "continuity_offered", label: "Continuidade oferecida" },
  { value: "continuity_accepted", label: "Continuidade aceita" },
  { value: "continuity_converted", label: "Continuidade convertida" },
]);

/** The configured converted stages (the CRM's dealPipelineStatuses). */
export const FUNNEL_DEMO_CONVERTED: readonly string[] = Object.freeze([
  "continuity_converted",
]);

/** The acquisition sources the fictional contacts carry, as recorded. */
export type FunnelDemoOrigin =
  | "Google Ads"
  | "Orgânico"
  | "Indicação"
  | "none"
  | "multiple";

export type FunnelDemoNextAction = "overdue" | "today" | "future" | "none";

export interface FunnelDemoDeal {
  /** The fixture's own label; never reaches the projection. */
  readonly label: string;
  readonly stage: string;
  readonly createdDaysAgo: number;
  readonly enteredDaysAgo: number;
  readonly nextAction: FunnelDemoNextAction;
  readonly origin: FunnelDemoOrigin;
  readonly amount: number | null;
  readonly convertedDaysAgo?: number;
  readonly lost?: { readonly daysAgo: number; readonly reason: string };
}

// 2 + 2 + 2 + 2 + 1 + 1 + 1 + 1 + 2 current deals, and 3 recent losses.
// prettier-ignore
export const FUNNEL_DEMO_DEALS: readonly FunnelDemoDeal[] = Object.freeze([
  { label: "r01", stage: "new_lead", createdDaysAgo: 0, enteredDaysAgo: 0, nextAction: "none", origin: "Google Ads", amount: null },
  { label: "r02", stage: "new_lead", createdDaysAgo: 1, enteredDaysAgo: 1, nextAction: "today", origin: "Orgânico", amount: null },
  { label: "r03", stage: "contact_started", createdDaysAgo: 4, enteredDaysAgo: 3, nextAction: "overdue", origin: "Google Ads", amount: 250 },
  { label: "r04", stage: "contact_started", createdDaysAgo: 3, enteredDaysAgo: 2, nextAction: "future", origin: "none", amount: null },
  { label: "r05", stage: "conversation_active", createdDaysAgo: 9, enteredDaysAgo: 5, nextAction: "overdue", origin: "Indicação", amount: null },
  { label: "r06", stage: "conversation_active", createdDaysAgo: 2, enteredDaysAgo: 1, nextAction: "none", origin: "multiple", amount: null },
  { label: "r07", stage: "initial_session_scheduled", createdDaysAgo: 8, enteredDaysAgo: 2, nextAction: "future", origin: "Google Ads", amount: 250 },
  { label: "r08", stage: "initial_session_scheduled", createdDaysAgo: 12, enteredDaysAgo: 6, nextAction: "today", origin: "Orgânico", amount: 250 },
  { label: "r09", stage: "initial_session_paid", createdDaysAgo: 14, enteredDaysAgo: 4, nextAction: "future", origin: "Google Ads", amount: 250 },
  { label: "r10", stage: "initial_session_attended", createdDaysAgo: 18, enteredDaysAgo: 8, nextAction: "overdue", origin: "Indicação", amount: 250 },
  { label: "r11", stage: "continuity_offered", createdDaysAgo: 40, enteredDaysAgo: 10, nextAction: "none", origin: "Google Ads", amount: 1200 },
  { label: "r12", stage: "continuity_accepted", createdDaysAgo: 22, enteredDaysAgo: 3, nextAction: "future", origin: "Orgânico", amount: 1200 },
  { label: "r13", stage: "continuity_converted", createdDaysAgo: 26, enteredDaysAgo: 2, nextAction: "none", origin: "Google Ads", amount: 1200, convertedDaysAgo: 2 },
  { label: "r14", stage: "continuity_converted", createdDaysAgo: 25, enteredDaysAgo: 12, nextAction: "none", origin: "Indicação", amount: 1200, convertedDaysAgo: 12 },
  { label: "r15", stage: "conversation_active", createdDaysAgo: 6, enteredDaysAgo: 3, nextAction: "none", origin: "Google Ads", amount: null, lost: { daysAgo: 1, reason: "no_response" } },
  { label: "r16", stage: "contact_started", createdDaysAgo: 10, enteredDaysAgo: 8, nextAction: "none", origin: "none", amount: null, lost: { daysAgo: 6, reason: "price" } },
  { label: "r17", stage: "initial_session_scheduled", createdDaysAgo: 45, enteredDaysAgo: 25, nextAction: "none", origin: "Orgânico", amount: 250, lost: { daysAgo: 20, reason: "postponed" } },
]);

const DAY_MS = 24 * 60 * 60 * 1000;

/** An instant `days` before `asOf`. */
export const daysBefore = (asOf: Date, days: number): Date =>
  new Date(asOf.getTime() - days * DAY_MS);

/**
 * The next-action instant the spec names, relative to `asOf`: two days ago,
 * 30 minutes on (still today when `asOf` is before 23:30 in the tenant's
 * zone), two days on, or none.
 */
export const nextActionAt = (
  asOf: Date,
  state: FunnelDemoNextAction,
): Date | null => {
  switch (state) {
    case "overdue":
      return daysBefore(asOf, 2);
    case "today":
      return new Date(asOf.getTime() + 30 * 60 * 1000);
    case "future":
      return daysBefore(asOf, -2);
    case "none":
      return null;
  }
};
