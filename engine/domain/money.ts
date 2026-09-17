// Exact money for the owner's governance acts (ADR 0017 §1–§3).
//
// The database keeps money as bigint micro-USD and rates as numeric. Between an
// operator's keyboard and those columns nothing may round: a daily limit typed
// as "0.1" must be 100000 micro-USD, never 99999.99999999999. So this module
// never touches a JavaScript number for an amount. Text is parsed with a regular
// expression and carried as BigInt, and results leave as decimal strings.
//
// A value with more than six significant decimals is REFUSED, never rounded: a
// rounded price is a price nobody read. Trailing zeros are not significant, so
// "1.50000000" is the same exact value as "1.5" and is accepted. Leading zeros
// are refused ("01.5"), so a mistyped amount never reads as another one. There is
// no sign, no exponent, no separator and no surrounding space.

import { CompanyOsError } from "./errors.ts";

export const MICROS_PER_USD = 1_000_000n;

/** The largest daily limit, in USD: the spend_limits_amount_range CHECK (10^15 micro-USD). */
export const MAX_DAILY_LIMIT_USD = 1_000_000_000n;

/** The largest rate, in USD per million tokens: ops.record_model_price's bound. */
export const MAX_RATE_USD_PER_MTOK = 99_999_999n;

const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const INTEGER_TEXT = /^-?(0|[1-9][0-9]*)$/;
/** Far above any accepted value, far below anything costly to parse. */
const MAX_TEXT_LENGTH = 40;
const DECIMALS = 6;

/** The exact value of a non-negative decimal, in millionths, or a refusal. */
function parseMillionths(text: unknown, field: string): bigint {
  if (typeof text !== "string" || text.length > MAX_TEXT_LENGTH) {
    throw new CompanyOsError(
      "invalid_argument",
      `${field} must be a non-negative decimal`,
    );
  }
  const match = DECIMAL.exec(text);
  if (match === null) {
    throw new CompanyOsError(
      "invalid_argument",
      `${field} must be a non-negative decimal with no sign, exponent, space or leading zero`,
    );
  }
  const [, whole, fraction = ""] = match;
  const significant = fraction.replace(/0+$/, "");
  if (significant.length > DECIMALS) {
    throw new CompanyOsError(
      "invalid_argument",
      `${field} has more than ${DECIMALS} decimals; it is refused rather than rounded`,
    );
  }
  return (
    BigInt(whole) * MICROS_PER_USD + BigInt(significant.padEnd(DECIMALS, "0"))
  );
}

/**
 * A daily limit in USD, as the decimal string of its micro-USD, for
 * ops.set_spend_limit. 0 to 1,000,000,000 USD, at most six decimals.
 */
export function parseUsdAmountToMicros(text: string): string {
  const micros = parseMillionths(text, "the daily amount");
  if (micros > MAX_DAILY_LIMIT_USD * MICROS_PER_USD) {
    throw new CompanyOsError(
      "invalid_argument",
      `the daily amount is at most ${MAX_DAILY_LIMIT_USD} USD`,
    );
  }
  return micros.toString();
}

/**
 * A rate in USD per million tokens, normalised (no trailing zeros, no trailing
 * point), for ops.record_model_price. 0 to 99,999,999, at most six decimals.
 */
export function parseUsdRate(text: string): string {
  return formatMillionths(parseUsdRateMillionths(text), false);
}

/** The same rate, as millionths of a USD per million tokens, for comparing two rates exactly. */
export function parseUsdRateMillionths(text: string): bigint {
  const millionths = parseMillionths(text, "a rate");
  if (millionths > MAX_RATE_USD_PER_MTOK * MICROS_PER_USD) {
    throw new CompanyOsError(
      "invalid_argument",
      `a rate is at most ${MAX_RATE_USD_PER_MTOK} USD per million tokens`,
    );
  }
  return millionths;
}

function toBigInt(micros: string | number | bigint): bigint {
  if (typeof micros === "bigint") return micros;
  if (typeof micros === "number" && Number.isSafeInteger(micros)) {
    return BigInt(micros);
  }
  if (
    typeof micros === "string" &&
    micros.length <= MAX_TEXT_LENGTH &&
    INTEGER_TEXT.test(micros)
  ) {
    return BigInt(micros);
  }
  throw new CompanyOsError(
    "invalid_argument",
    "micro-USD must be a whole number",
  );
}

function formatMillionths(value: bigint, fixed: boolean): string {
  const sign = value < 0n ? "-" : "";
  const magnitude = value < 0n ? -value : value;
  const whole = (magnitude / MICROS_PER_USD).toString();
  const fraction = (magnitude % MICROS_PER_USD)
    .toString()
    .padStart(DECIMALS, "0");
  const shown = fixed ? fraction : fraction.replace(/0+$/, "");
  // Concatenation rather than a template: the production-scope guard reads a
  // template that joins interpolations around a dot as a brace glob.
  const integral = sign + whole;
  return shown === "" ? integral : integral + "." + shown;
}

/**
 * Micro-USD as USD with exactly six decimals: 1234567 -> "1.234567". Negative is
 * allowed, because what remains of a limit can be below zero.
 */
export function formatMicrosAsUsd(micros: string | number | bigint): string {
  return formatMillionths(toBigInt(micros), true);
}
