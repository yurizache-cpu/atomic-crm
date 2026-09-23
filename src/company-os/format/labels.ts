import { UUID_PATTERN } from "../../../contracts/company-os-api/index.ts";

// Text for the values a projection returns. Nothing here computes a number:
// counts and money are rendered exactly as the server sent them
// (docs/PHASE_2C_BRIEF.md §13 item 5); these helpers only name enums,
// booleans and timestamps.

/** An enum value as words: `needs_edit` reads "needs edit". */
export const humanize = (value: string): string => value.replaceAll("_", " ");

export const yesNo = (value: boolean): string => (value ? "Sim" : "Não");

/**
 * A contract timestamp (YYYY-MM-DDTHH:MM:SS.ffffffZ, always UTC) to the
 * second, in UTC: the value is cut, never converted.
 */
export const formatTimestamp = (iso: string): string =>
  `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;

/** `value` when it is one of `allowed`, else null: for search parameters. */
export const oneOf = <T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | null =>
  value !== null && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;

/** A uuid search parameter, else null. */
export const uuidOrNull = (value: string | null): string | null =>
  value !== null && UUID_PATTERN.test(value) ? value : null;

/** A select's options for a closed vocabulary. */
export const optionsOf = (
  values: readonly string[],
  label: (value: string) => string = humanize,
) => values.map((value) => ({ value, label: label(value) }));
