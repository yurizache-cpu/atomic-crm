// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TxClient } from "../db/types.ts";
import { CompanyOsError } from "./errors.ts";
import {
  MAX_LISTED_MODEL_PRICES,
  listModelPrices,
  parseIsoInstantMicros,
  recordModelPrice,
  type ModelPriceAct,
  type ModelPriceInput,
} from "./modelPrices.ts";

// What the typed boundary decides with no database. Which version prices a run,
// that a version is immutable, and that an expired one prices nothing are the
// database's, proven by the SQL suites and the driver-backed tests.

const PRICE = "f0000000-0000-4000-8000-00000000000f";
const RECORD_SQL =
  "select ops.record_model_price($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as result";

const INPUT: ModelPriceInput = {
  provider: "openai",
  model: "gpt-test-2026-01-01",
  inputUsdPerMtok: "1.250000",
  outputUsdPerMtok: "10",
  reasoningInOutput: true,
  effectiveFrom: "2026-09-17T00:00:00Z",
  expiresAt: "2027-03-17T00:00:00Z",
};

const ACT: ModelPriceAct = {
  source: "provider pricing page, read 2026-09-17",
  actor: "owner",
};

interface RecordedCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const recordingDatabase = (rows: readonly unknown[]) => {
  const calls: RecordedCall[] = [];
  const tx: TxClient = {
    async query<TRow>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [...rows] as TRow[] };
    },
  };
  return { tx, calls };
};

const unreachable: TxClient = {
  query: () => {
    throw new Error("the database was reached with input that is never valid");
  },
};

const failingWith = (code: string, message: string): TxClient => ({
  query: async () => {
    throw Object.assign(new Error(message), { code });
  },
});

const outcomeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof CompanyOsError ? error.code : error;
  }
  return "resolved";
};

describe("recording a model price version", () => {
  it("sends the ten arguments in ops.record_model_price's order, with normalised exact rates and the cached rate last", async () => {
    const { tx, calls } = recordingDatabase([{ result: PRICE }]);

    const id = await recordModelPrice(
      tx,
      { ...INPUT, cachedInputUsdPerMtok: "0.125" },
      ACT,
    );

    expect(id).toBe(PRICE);
    expect(calls).toEqual([
      {
        sql: RECORD_SQL,
        params: [
          "openai",
          "gpt-test-2026-01-01",
          "1.25",
          "10",
          true,
          "2026-09-17T00:00:00Z",
          "2027-03-17T00:00:00Z",
          ACT.source,
          "owner",
          "0.125",
        ],
      },
    ]);
  });

  it("sends no cached rate as null, so cached input is billed in full", async () => {
    const { tx, calls } = recordingDatabase([{ result: PRICE }]);

    await recordModelPrice(tx, INPUT, ACT);

    expect(calls[0]?.params).toHaveLength(10);
    expect(calls[0]?.params[9]).toBeNull();
  });

  it("accepts a validity of exactly 366 days and an explicit non-UTC offset", async () => {
    const { tx, calls } = recordingDatabase([{ result: PRICE }]);

    await recordModelPrice(
      tx,
      {
        ...INPUT,
        effectiveFrom: "2026-01-01T00:00:00-03:00",
        expiresAt: "2027-01-02T00:00:00-03:00",
      },
      ACT,
    );

    expect(calls).toHaveLength(1);
  });

  it.each<[string, Partial<ModelPriceInput>]>([
    ["an upper-case provider", { provider: "OpenAI" }],
    ["an empty model", { model: "" }],
    ["a model with a space", { model: "gpt test" }],
    [
      "a rate with seven decimals, which would round",
      { inputUsdPerMtok: "0.1234567" },
    ],
    ["a negative rate", { outputUsdPerMtok: "-1" }],
    ["a rate in exponent form", { outputUsdPerMtok: "1e1" }],
    ["a rate above the bound", { inputUsdPerMtok: "100000000" }],
    [
      "a cached rate above the input rate",
      { cachedInputUsdPerMtok: "1.250001" },
    ],
    [
      "an unstated reasoning rule",
      { reasoningInOutput: "yes" as unknown as boolean },
    ],
    ["a date with no time", { effectiveFrom: "2026-09-17" }],
    ["a time with no offset", { effectiveFrom: "2026-09-17T00:00:00" }],
    ["a time with no seconds", { effectiveFrom: "2026-09-17T00:00Z" }],
    ["an impossible day", { effectiveFrom: "2026-02-30T00:00:00Z" }],
    ["an impossible hour", { expiresAt: "2027-03-17T24:00:00Z" }],
    ["a local-time phrase", { expiresAt: "next year" }],
    ["an expiry before the start", { expiresAt: "2026-09-16T23:59:59Z" }],
    ["an expiry equal to the start", { expiresAt: "2026-09-17T00:00:00Z" }],
    [
      "a validity one microsecond over 366 days",
      { expiresAt: "2027-09-18T00:00:00.000001Z" },
    ],
  ])("refuses %s before reaching the database", async (_case, change) => {
    expect(
      await outcomeOf(
        recordModelPrice(unreachable, { ...INPUT, ...change }, ACT),
      ),
    ).toBe("invalid_argument");
  });

  it.each<[string, ModelPriceAct]>([
    ["an empty source", { source: "", actor: "owner" }],
    ["a blank source", { source: " \t ", actor: "owner" }],
    ["a 501-character source", { source: "s".repeat(501), actor: "owner" }],
    ["a malformed actor", { source: "pricing page", actor: "The Owner" }],
  ])("refuses %s before reaching the database", async (_case, act) => {
    expect(await outcomeOf(recordModelPrice(unreachable, INPUT, act))).toBe(
      "invalid_argument",
    );
  });

  it("surfaces a different version at the same moment as invalid_state", async () => {
    expect(
      await outcomeOf(
        recordModelPrice(
          failingWith(
            "OS409",
            "ops.record_model_price: a different price version is already recorded for that model from that moment",
          ),
          INPUT,
          ACT,
        ),
      ),
    ).toBe("invalid_state");
  });

  it("refuses to invent an id when the database returns none", async () => {
    const outcome = await outcomeOf(
      recordModelPrice(recordingDatabase([]).tx, INPUT, ACT),
    );

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(CompanyOsError);
  });
});

describe("reading an ISO instant exactly", () => {
  it("counts microseconds and applies the offset", () => {
    expect(parseIsoInstantMicros("1970-01-01T00:00:00Z")).toBe(0n);
    expect(parseIsoInstantMicros("1970-01-01T00:00:00.000001Z")).toBe(1n);
    expect(parseIsoInstantMicros("1970-01-01T01:00:00+01:00")).toBe(0n);
    expect(parseIsoInstantMicros("2026-09-17T00:00:00.5Z")).toBe(
      BigInt(Date.UTC(2026, 8, 17)) * 1000n + 500_000n,
    );
  });

  it("accepts a leap day only in a leap year", () => {
    expect(parseIsoInstantMicros("2028-02-29T00:00:00Z")).not.toBeNull();
    expect(parseIsoInstantMicros("2027-02-29T00:00:00Z")).toBeNull();
  });
});

describe("listing model prices", () => {
  const record = {
    id: PRICE,
    provider: "openai",
    model: "gpt-test-2026-01-01",
    input_usd_per_mtok: "1.250000",
    cached_input_usd_per_mtok: null,
    output_usd_per_mtok: "10.000000",
    reasoning_in_output: true,
    effective_from: "2026-09-17T00:00:00.000000Z",
    expires_at: "2027-03-17T00:00:00.000000Z",
    source: "pricing page",
    recorded_by: "owner",
    recorded_at: "2026-09-17T08:00:00.000000Z",
    status: "current",
    sort_from: new Date("2026-09-17T00:00:00Z"),
  };

  it("reads current, expired and future versions only, bounded, unless history is asked for", async () => {
    const recent = recordingDatabase([]);
    await listModelPrices(recent.tx);
    const all = recordingDatabase([]);
    await listModelPrices(all.tx, { includeHistory: true });

    expect(MAX_LISTED_MODEL_PRICES).toBe(500);
    expect(recent.calls[0]?.params).toEqual([false, 500]);
    expect(all.calls[0]?.params).toEqual([true, 500]);
    expect(recent.calls[0]?.sql).toMatch(/v\.status <> 'superseded'/);
    expect(recent.calls[0]?.sql).toMatch(
      /ops\.current_model_price\(p\.provider, p\.model, now\(\)\)/,
    );
    // Only the latest effective version past its expiry reads as expired; the
    // database proves which rows match (a driver-backed test is still owed).
    expect(recent.calls[0]?.sql).toMatch(
      /when p\.effective_from > now\(\) then 'future'/,
    );
    expect(recent.calls[0]?.sql).toMatch(
      /when p\.expires_at <= now\(\)\s+and p\.effective_from = \(select max\(q\.effective_from\)/,
    );
  });

  it("returns each version with its exact rates as text and the status the database computed", async () => {
    const { tx } = recordingDatabase([record]);

    expect(await listModelPrices(tx)).toEqual([
      {
        id: PRICE,
        provider: "openai",
        model: "gpt-test-2026-01-01",
        inputUsdPerMtok: "1.250000",
        cachedInputUsdPerMtok: null,
        outputUsdPerMtok: "10.000000",
        reasoningInOutput: true,
        effectiveFrom: "2026-09-17T00:00:00.000000Z",
        expiresAt: "2027-03-17T00:00:00.000000Z",
        source: "pricing page",
        recordedBy: "owner",
        recordedAt: "2026-09-17T08:00:00.000000Z",
        status: "current",
      },
    ]);
  });

  it("refuses a status it does not know rather than typing it", async () => {
    const { tx } = recordingDatabase([{ ...record, status: "stale" }]);

    expect(await outcomeOf(listModelPrices(tx))).toBeInstanceOf(Error);
  });

  it("refuses a non-boolean includeHistory before reaching the database", async () => {
    expect(
      await outcomeOf(
        listModelPrices(unreachable, {
          includeHistory: "yes" as unknown as boolean,
        }),
      ),
    ).toBe("invalid_argument");
  });

  it("maps a database refusal to its typed code", async () => {
    expect(
      await outcomeOf(
        listModelPrices(
          failingWith("OS403", "ops.current_model_price: row security"),
        ),
      ),
    ).toBe("refused");
  });
});
