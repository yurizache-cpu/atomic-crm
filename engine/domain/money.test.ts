// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CompanyOsError } from "./errors.ts";
import {
  formatMicrosAsUsd,
  parseUsdAmountToMicros,
  parseUsdRate,
  parseUsdRateMillionths,
} from "./money.ts";

// Exact decimal money: what an owner types is what the database stores, or it is
// refused. Nothing here may pass through a floating-point number.

const codeOf = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error instanceof CompanyOsError ? error.code : error;
  }
  return "returned";
};

describe("parsing a daily amount in USD", () => {
  it.each([
    ["0", "0"],
    ["1", "1000000"],
    ["0.1", "100000"],
    ["0.000001", "1"],
    ["12.345678", "12345678"],
    ["1.50000000", "1500000"],
    ["1000000000", "1000000000000000"],
    ["1000000000.000000", "1000000000000000"],
  ])("reads %s USD as exactly %s micro-USD", (text, micros) => {
    expect(parseUsdAmountToMicros(text)).toBe(micros);
  });

  it("keeps a value no float can hold exactly", () => {
    // 999999999.999999 is not representable as a double: it would round.
    expect(parseUsdAmountToMicros("999999999.999999")).toBe("999999999999999");
  });

  it.each([
    ["seven significant decimals", "0.0000001"],
    ["a sub-micro remainder", "1.2345675"],
    ["above one billion USD", "1000000000.000001"],
    ["a huge value", "9".repeat(30)],
    ["an exponent", "1e3"],
    ["a leading space", " 1"],
    ["a trailing space", "1 "],
    ["a negative amount", "-1"],
    ["a plus sign", "+1"],
    ["a leading zero", "01.5"],
    ["a doubled zero", "00"],
    ["a bare point", "."],
    ["a missing whole part", ".5"],
    ["a trailing point", "5."],
    ["a thousands separator", "1,000"],
    ["a decimal comma", "1,5"],
    ["an empty string", ""],
    ["hexadecimal", "0x10"],
    ["infinity", "Infinity"],
    ["not a number", "NaN"],
    ["a non-ASCII digit", String.fromCodePoint(0x661)],
  ])("refuses %s rather than guessing", (_case, text) => {
    expect(codeOf(() => parseUsdAmountToMicros(text))).toBe("invalid_argument");
  });

  it("refuses a value that is not text", () => {
    expect(codeOf(() => parseUsdAmountToMicros(1 as unknown as string))).toBe(
      "invalid_argument",
    );
  });
});

describe("parsing a rate in USD per million tokens", () => {
  it.each([
    ["2.50", "2.5"],
    ["0.075000", "0.075"],
    ["0", "0"],
    ["0.000000", "0"],
    ["10", "10"],
    ["99999999", "99999999"],
    ["0.000001", "0.000001"],
  ])("normalises %s to %s without changing its value", (text, normalised) => {
    expect(parseUsdRate(text)).toBe(normalised);
  });

  it("compares two rates exactly in millionths", () => {
    expect(parseUsdRateMillionths("0.3")).toBe(300_000n);
    expect(
      parseUsdRateMillionths("0.30") < parseUsdRateMillionths("0.300001"),
    ).toBe(true);
  });

  it.each([
    ["seven significant decimals", "0.1234567"],
    ["above the rate bound", "99999999.000001"],
    ["a huge value", "100000000"],
    ["an exponent", "1e3"],
    ["a leading space", " 1"],
    ["a negative rate", "-1"],
    ["a leading zero", "007"],
  ])("refuses %s", (_case, text) => {
    expect(codeOf(() => parseUsdRate(text))).toBe("invalid_argument");
  });
});

describe("formatting micro-USD", () => {
  it.each<[string | number | bigint, string]>([
    [0, "0.000000"],
    [1, "0.000001"],
    [1_234_567, "1.234567"],
    ["1000000000000000", "1000000000.000000"],
    [-1, "-0.000001"],
    ["-2500000", "-2.500000"],
    [9_007_199_254_740_993n, "9007199254.740993"],
  ])("formats %s micro-USD as %s USD", (micros, usd) => {
    expect(formatMicrosAsUsd(micros)).toBe(usd);
  });

  it.each<[string, unknown]>([
    ["a fractional number", 1.5],
    ["an unsafe integer", 2 ** 53],
    ["a decimal string", "1.5"],
    ["an empty string", ""],
    ["a string with a space", " 1"],
    ["a string with a leading zero", "01"],
    ["null", null],
  ])("refuses %s", (_case, micros) => {
    expect(
      codeOf(() => formatMicrosAsUsd(micros as string | number | bigint)),
    ).toBe("invalid_argument");
  });
});
