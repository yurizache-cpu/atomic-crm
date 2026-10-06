// The front desk's hallucination check (ADR 0023 §E): every checkable fact a
// reply candidate states must appear in what the agent was given.
//
// A model is told to state only the facts of its knowledge, availability and
// conversation state; this check does not trust that. It extracts the facts a
// pattern can recognise from the reply (amounts of money, times of day, dates,
// links, e-mail addresses, long digit runs such as a phone number or a
// payment key) and looks each up in the facts the run was given. A reply that
// states one it was not given is UNGROUNDED: the handler marks it for a
// person (needs_human_review, flag "unclear") before it is stored.
//
// It cannot check prose ("we are open on Saturdays"); the review does. It is
// deliberately strict: a time the knowledge writes as "19h" and the reply as
// "19:00" matches, an amount written "150" and "150,00" matches, and anything
// else that differs does not.

export interface GroundingResult {
  readonly grounded: boolean;
  /** How many facts in the reply were not in what the agent was given. */
  readonly unsupported: number;
}

const MONEY =
  /R\$\s?\d{1,3}(?:[.\s]?\d{3})*(?:,\d{1,2})?|\b\d+(?:,\d{2})?\s?reais\b/giu;
const TIME = /\b([01]?\d|2[0-3])(?::([0-5]\d)|h([0-5]\d)?)(?!\d)/giu;
const ISO_TIME = /T([01]\d|2[0-3]):([0-5]\d)/gu;
const DATE = /\b([0-2]?\d|3[01])\/(0?[1-9]|1[0-2])(?:\/(\d{4}|\d{2}))?\b/gu;
// No trailing \b: in "2026-10-13T19:00" the date runs straight into the "T".
const ISO_DATE = /\b(\d{4})-(0[1-9]|1[0-2])-([0-2]\d|3[01])(?!\d)/gu;
const URL = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/giu;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gu;
const DIGIT_RUN = /(?<!\d)\d[\d\s().-]{6,}\d(?!\d)/gu;
// Hours before or after something are a duration, not a time of day: in
// "lembretes 24h e 5h antes" no clock time is stated (the round-two
// receptionist test, 2026-10-05). Read on the text right after an "Nh".
const DURATION_AFTER =
  /^(?:\s*(?:,|e|ou)\s*\d{1,2}\s?(?:h|horas?))*\s+(?:antes|depois|ap[oó]s|de anteced[eê]ncia)\b/iu;

const moneyKey = (raw: string): string => {
  const digits = raw.replace(/[^\d,]/gu, "");
  const [whole, cents = "00"] = digits.split(",");
  return `${Number(whole.replace(/\D/gu, ""))},${cents.padEnd(2, "0")}`;
};
const timeKey = (hours: string, minutes: string | undefined): string =>
  `${hours.padStart(2, "0")}:${(minutes ?? "00").padStart(2, "0")}`;
const dateKey = (day: string, month: string, year?: string): string => {
  const dayMonth = `${day.padStart(2, "0")}/${month.padStart(2, "0")}`;
  if (year === undefined) return dayMonth;
  return `${dayMonth}/${year.length === 2 ? `20${year}` : year}`;
};
const trimUrl = (url: string): string =>
  url.replace(/[.,;:!?]+$/u, "").toLowerCase();
const digitsOf = (raw: string): string => raw.replace(/\D/gu, "");

function factKeys(text: string): Set<string> {
  const keys = new Set<string>();
  // Only an amount the facts write as money is a price: a bare number in
  // the context (a turn count, a slot's month) never is (PR #28 review).
  for (const m of text.matchAll(MONEY)) keys.add(`money:${moneyKey(m[0])}`);
  for (const m of text.matchAll(TIME))
    keys.add(`time:${timeKey(m[1], m[2] ?? m[3])}`);
  for (const m of text.matchAll(ISO_TIME))
    keys.add(`time:${timeKey(m[1], m[2])}`);
  // A known date answers a claim without a year, and, with its year, only a
  // claim of that same year (PR #28 review).
  for (const m of text.matchAll(DATE)) {
    keys.add(`date:${dateKey(m[1], m[2])}`);
    if (m[3] !== undefined) keys.add(`date:${dateKey(m[1], m[2], m[3])}`);
  }
  for (const m of text.matchAll(ISO_DATE)) {
    keys.add(`date:${dateKey(m[3], m[2])}`);
    keys.add(`date:${dateKey(m[3], m[2], m[1])}`);
  }
  for (const m of text.matchAll(URL)) keys.add(`url:${trimUrl(m[0])}`);
  for (const m of text.matchAll(EMAIL)) keys.add(`email:${m[0].toLowerCase()}`);
  for (const m of text.matchAll(DIGIT_RUN))
    keys.add(`digits:${digitsOf(m[0])}`);
  return keys;
}

function claimedKeys(text: string): string[] {
  const keys: string[] = [];
  for (const m of text.matchAll(MONEY)) keys.push(`money:${moneyKey(m[0])}`);
  for (const m of text.matchAll(TIME)) {
    const isDuration =
      m[0].toLowerCase().endsWith("h") &&
      DURATION_AFTER.test(text.slice(m.index + m[0].length));
    if (!isDuration) keys.push(`time:${timeKey(m[1], m[2] ?? m[3])}`);
  }
  for (const m of text.matchAll(DATE))
    keys.push(`date:${dateKey(m[1], m[2], m[3])}`);
  for (const m of text.matchAll(URL)) keys.push(`url:${trimUrl(m[0])}`);
  for (const m of text.matchAll(EMAIL))
    keys.push(`email:${m[0].toLowerCase()}`);
  for (const m of text.matchAll(DIGIT_RUN)) {
    // A date or a time already counted is not also a digit run.
    if (/[/:]/u.test(m[0])) continue;
    keys.push(`digits:${digitsOf(m[0])}`);
  }
  return keys;
}

/** Checks a reply candidate against the facts its run was given. Pure. */
export function checkGrounding(reply: string, facts: string): GroundingResult {
  const known = factKeys(facts);
  const unsupported = claimedKeys(reply).filter(
    (claim) => !known.has(claim),
  ).length;
  return Object.freeze({ grounded: unsupported === 0, unsupported });
}
