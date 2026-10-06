// The front desk's deterministic pre-model screen (ADR 0023 §B).
//
// Every inbound message a front-desk agent answers passes through here BEFORE
// any part of it reaches a model provider or the structured-decision layer
// (Jev). The screen runs locally, in our own process, and calls nothing.
//
// WHAT IT DOES. It splits a message into clauses, classifies each clause with
// a reviewed vocabulary pack, and keeps only what it RECOGNISES as
// administrative or benign. Everything else is replaced by one neutral marker:
// a clause the pack recognises as sensitive (health, intimate, distress) AND a
// clause it does not recognise at all. Keeping only the recognised is the
// conservative direction: an indirect phrase no pattern names ("as coisas
// estão pesadas") is omitted for being unrecognised, not passed for being
// unflagged.
//
// WHAT IT IS NOT. It is not anonymisation and it is not semantic detection.
// A sensitive word fused into an administrative clause without a recognised
// sensitive term passes, and a benign word the pack does not know is omitted.
// The synthetic corpus test measures both directions. Q8 stays the authority
// over which class of data may reach which provider (ADR 0020); this screen
// narrows what an authorized run sends.
//
// The marker is the same for every reason: the model learns that something
// was left out, never why, so the omission itself carries no health signal.
// The record of the screening (class, counts, versions) stays in our database;
// the omitted text never leaves the store it came from.

import { redactStructuredIdentifiers } from "../models/identifierRedaction.ts";
import { HEALTH_PT_BR_V3 } from "./packs/healthPtBr.ts";

export const SANITIZER_VERSION = "front_desk_screen.v3";
export const OMISSION_MARKER = "[trecho omitido]";

/** The most text the screen reads from one message; beyond it is omitted. */
export const MAX_SCREENED_LENGTH = 2000;

/**
 * A reviewed vocabulary. Patterns are matched against FOLDED text: lower case,
 * accents removed. A tenant selects a pack by id in its operating policy; it
 * never edits one (ADR 0023 §C).
 */
export interface SanitizerPack {
  readonly id: string;
  /** Danger to life or safety, matched on the whole message. */
  readonly crisis: readonly RegExp[];
  /** Health, intimate or distress content: the clause is omitted. */
  readonly sensitive: readonly RegExp[];
  /** An administrative request the front desk may serve. */
  readonly administrative: readonly RegExp[];
  /**
   * Administrative phrases that name a sensitive word without being about the
   * sender. They are never split, and the rest of their clause must be clean.
   */
  readonly administrativePhrases: readonly RegExp[];
  /** Greetings and acknowledgements: kept, but not an intent. */
  readonly benign: readonly RegExp[];
  /** The sender asks for a person. */
  readonly humanRequest: readonly RegExp[];
  /** The sender asks to stop receiving messages. */
  readonly optOut: readonly RegExp[];
}

export type MessageClass =
  /** Nothing omitted. */
  | "administrative"
  /** Something omitted, an administrative request kept. */
  | "mixed"
  /** Sensitive content omitted and no administrative request left. */
  | "sensitive_only"
  /** Danger to life or safety: nothing goes to any model. */
  | "safety"
  /** Unrecognised content omitted and no administrative request left. */
  | "unknown";

export type SafetyClass = "none" | "crisis";

/** The screening, exactly as ops.record_inbound_screening accepts it. */
export interface SanitizedMessage {
  readonly sanitizerVersion: string;
  readonly packId: string;
  readonly messageClass: MessageClass;
  /** The text a model or Jev may see; null when nothing may be sent. */
  readonly safeText: string | null;
  /** True when any clause was omitted as sensitive, or the message is a safety case. */
  readonly sensitiveContentPresent: boolean;
  /** True when nothing of the message may reach a model. */
  readonly fullyBlocked: boolean;
  readonly segmentsRedacted: number;
  readonly segmentsSensitive: number;
  readonly segmentsUnrecognised: number;
  readonly administrativeIntent: boolean;
  readonly humanRequested: boolean;
  readonly optOutRequested: boolean;
  /** A person must look at this conversation (safety, a request for a person, an opt-out). */
  readonly requiresHuman: boolean;
  readonly safetyClass: SafetyClass;
}

type ClauseKind = "administrative" | "benign" | "sensitive" | "unrecognised";

const DIACRITICS = /[\u0300-\u036f]/gu;

/**
 * Lower case and accents removed, ONE output unit per input unit, so a match
 * found in the folded text has the same offsets in the original.
 */
export function foldForScreening(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const unit = text[i];
    const base = unit.normalize("NFD").replace(DIACRITICS, "");
    const folded = (base.length === 1 ? base : unit).toLowerCase();
    out += folded.length === 1 ? folded : unit;
  }
  return out;
}

/** Lower case only, one output unit per input unit: accents stay ("é" is not "e"). */
function lowerForSplitting(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const lower = text[i].toLowerCase();
    out += lower.length === 1 ? lower : text[i];
  }
  return out;
}

// Clause boundaries: punctuation, line breaks, and the connectors that join two
// clauses in Portuguese. Matched on the LOWER-CASED text with its accents, so
// the verb "é" never reads as the connector "e".
const SEPARATOR =
  /[.!?;:,\n]+ ?| - | (?:e|mas|por[eé]m|pois|porque|porqu[eê]|ent[aã]o|s[oó] que|para|pra|por causa d[aeo]s?|devido a|j[aá] que|al[eé]m d[aeo]s?|tamb[eé]m) /gu;

const hasLetters = (text: string) => /\p{L}/u.test(text);
const matchesAny = (patterns: readonly RegExp[], text: string) =>
  patterns.some((pattern) => pattern.test(text));
const globalOf = (pattern: RegExp) =>
  new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );

/** The ranges an administrative phrase covers: no clause boundary falls inside one. */
function protectedRanges(
  pack: SanitizerPack,
  folded: string,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const pattern of pack.administrativePhrases) {
    for (const match of folded.matchAll(globalOf(pattern))) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  return ranges;
}

/** Clauses and the separators between them, as [clause, separator, clause, ...]. */
function splitClauses(
  original: string,
  ranges: Array<[number, number]>,
): string[] {
  const parts: string[] = [];
  let start = 0;
  for (const match of lowerForSplitting(original).matchAll(SEPARATOR)) {
    const from = match.index;
    const to = from + match[0].length;
    if (ranges.some(([a, b]) => from < b && to > a)) continue;
    parts.push(original.slice(start, from), original.slice(from, to));
    start = to;
  }
  parts.push(original.slice(start));
  return parts;
}

function classifyClause(pack: SanitizerPack, clause: string): ClauseKind {
  const folded = foldForScreening(clause).trim();
  if (!hasLetters(folded)) return "benign";
  const phrase = pack.administrativePhrases.find((pattern) =>
    pattern.test(folded),
  );
  if (phrase) {
    const remainder = folded.replace(globalOf(phrase), " ");
    return matchesAny(pack.sensitive, remainder)
      ? "sensitive"
      : "administrative";
  }
  if (matchesAny(pack.sensitive, folded)) return "sensitive";
  if (matchesAny(pack.administrative, folded)) return "administrative";
  const bare = folded
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/ +/gu, " ")
    .trim();
  if (matchesAny(pack.benign, bare)) return "benign";
  return "unrecognised";
}

function classOf(
  administrativeIntent: boolean,
  sensitive: number,
  unrecognised: number,
): MessageClass {
  if (sensitive + unrecognised === 0) return "administrative";
  if (administrativeIntent) return "mixed";
  return sensitive > 0 ? "sensitive_only" : "unknown";
}

const isPunctuation = (separator: string) => /^[.!?;:,\n]+ ?$/u.test(separator);

/**
 * Screen one inbound message. Pure and deterministic: the same text and pack
 * always give the same result.
 */
export function sanitizeMessage(
  text: string,
  pack: SanitizerPack = HEALTH_PT_BR_V3,
): SanitizedMessage {
  const truncated = text.length > MAX_SCREENED_LENGTH;
  // Line breaks are clause boundaries, so they survive until the split: only
  // the other whitespace is collapsed here, and the kept text is normalised
  // after (PR #28 review). Structured identifiers go first, so an address or
  // a number becomes its marker before a dot or a dash inside it can read as
  // a boundary.
  const original = redactStructuredIdentifiers(
    text
      .slice(0, MAX_SCREENED_LENGTH)
      .replace(/\r\n?/gu, "\n")
      .replace(/[^\S\n]+/gu, " ")
      .replace(/ *\n[\s]*/gu, "\n")
      .trim(),
  );
  const folded = foldForScreening(original);
  // Whole-message phrases (danger, a request for a person, an opt-out) may
  // run across a line break, so they are matched on one line.
  const oneLine = folded.replace(/\s+/gu, " ");
  const humanRequested = matchesAny(pack.humanRequest, oneLine);
  const optOutRequested = matchesAny(pack.optOut, oneLine);
  const base = {
    sanitizerVersion: SANITIZER_VERSION,
    packId: pack.id,
    humanRequested,
    optOutRequested,
  };

  if (matchesAny(pack.crisis, oneLine)) {
    return Object.freeze({
      ...base,
      messageClass: "safety",
      safeText: null,
      sensitiveContentPresent: true,
      fullyBlocked: true,
      segmentsRedacted: 1,
      segmentsSensitive: 1,
      segmentsUnrecognised: 0,
      administrativeIntent: false,
      requiresHuman: true,
      safetyClass: "crisis",
    });
  }

  const parts = splitClauses(original, protectedRanges(pack, folded));
  const out: string[] = [];
  let sensitive = 0;
  let unrecognised = 0;
  let administrativeIntent = false;
  let lastWasOmission = false;

  for (let index = 0; index < parts.length; index += 2) {
    const clause = parts[index] ?? "";
    const separator = parts[index + 1] ?? "";
    const kind = clause.trim() === "" ? "benign" : classifyClause(pack, clause);
    if (kind === "sensitive" || kind === "unrecognised") {
      if (kind === "sensitive") sensitive += 1;
      else unrecognised += 1;
      if (!lastWasOmission) {
        // A word connector left dangling before the omission goes with it.
        if (out.length > 0 && !isPunctuation(out[out.length - 1]))
          out[out.length - 1] = " ";
        out.push(OMISSION_MARKER);
      } else if (
        isPunctuation(separator) &&
        out.length > 0 &&
        isPunctuation(out[out.length - 1])
      ) {
        // One marker for a run of omissions, and one punctuation after it:
        // the earlier clause's gives way to this one's (never ", .").
        out.pop();
      }
      lastWasOmission = true;
      if (isPunctuation(separator)) out.push(separator);
      continue;
    }
    if (kind === "administrative") administrativeIntent = true;
    if (lastWasOmission && out.length > 0 && !/\s$/u.test(out[out.length - 1]))
      out.push(" ");
    out.push(clause, separator);
    lastWasOmission = false;
  }
  if (truncated) {
    unrecognised += 1;
    if (!lastWasOmission) out.push(" ", OMISSION_MARKER);
  }

  const joined = out.join("").replace(/\s+/gu, " ").trim();
  // Nothing left to read is nothing to answer: an empty message is unknown.
  const messageClass =
    joined === ""
      ? "unknown"
      : classOf(administrativeIntent, sensitive, unrecognised);
  const fullyBlocked =
    messageClass === "sensitive_only" || messageClass === "unknown";
  return Object.freeze({
    ...base,
    messageClass,
    safeText: fullyBlocked
      ? null
      : redactStructuredIdentifiers(joined).slice(0, 4000),
    sensitiveContentPresent: sensitive > 0,
    fullyBlocked,
    segmentsRedacted: sensitive + unrecognised,
    segmentsSensitive: sensitive,
    segmentsUnrecognised: unrecognised,
    administrativeIntent,
    requiresHuman: humanRequested || optOutRequested,
    safetyClass: "none",
  });
}
