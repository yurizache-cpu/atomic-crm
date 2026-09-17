// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TxClient } from "../db/types.ts";
import { CompanyOsError } from "./errors.ts";
import {
  MAX_LISTED_SPEND_LIMITS,
  MAX_LISTED_TENANTS_WITHOUT_BUDGET,
  listSpendLimits,
  listTenantsWithoutBudget,
  readSpendStatus,
  retireSpendLimit,
  setSpendLimit,
  type SpendLimitAct,
  type SpendLimitTarget,
  type SpendLimitValue,
} from "./spendLimits.ts";

// What the typed boundary decides with no database. That absence refuses, that
// admission is serialised, and what "today" means are the database's, proven by
// the SQL suites and the driver-backed tests.

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const COMPANY = "b0000000-0000-4000-8000-00000000000b";
const LIMIT = "c0000000-0000-4000-8000-00000000000c";
const SET_SQL =
  "select ops.set_spend_limit($1, $2::bigint, $3, $4, $5, $6, $7) as result";
const RETIRE_SQL = "select ops.retire_spend_limit($1, $2, $3) as result";

const VALUE: SpendLimitValue = { dailyUsd: "25.50", timezone: "UTC" };
const ACT: SpendLimitAct = { reason: "monthly budget review", actor: "owner" };

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

describe("setting a spend limit", () => {
  it.each<[SpendLimitTarget, readonly unknown[]]>([
    [{ scope: "global" }, [null, null]],
    [{ scope: "tenant", tenantId: TENANT }, [TENANT, null]],
    [
      { scope: "company", tenantId: TENANT, companyId: COMPANY },
      [TENANT, COMPANY],
    ],
  ])(
    "sends a %o limit as exact micro-USD text, never a float",
    async (target, coordinates) => {
      const { tx, calls } = recordingDatabase([{ result: LIMIT }]);

      expect(await setSpendLimit(tx, target, VALUE, ACT)).toBe(LIMIT);
      expect(calls).toEqual([
        {
          sql: SET_SQL,
          params: [
            target.scope,
            "25500000",
            "UTC",
            ACT.reason,
            "owner",
            ...coordinates,
          ],
        },
      ]);
      expect(typeof calls[0]?.params[1]).toBe("string");
    },
  );

  it("passes an IANA zone through for the database to check", async () => {
    const { tx, calls } = recordingDatabase([{ result: LIMIT }]);

    await setSpendLimit(
      tx,
      { scope: "tenant", tenantId: TENANT },
      { dailyUsd: "1", timezone: "America/Sao_Paulo" },
      ACT,
    );

    expect(calls[0]?.params[2]).toBe("America/Sao_Paulo");
  });

  it.each<[string, SpendLimitTarget, string]>([
    ["an unknown scope", { scope: "department" as never }, "invalid_argument"],
    [
      "a tenant limit with no tenant",
      { scope: "tenant" },
      "missing_tenant_scope",
    ],
    [
      "a company limit with an empty tenant",
      { scope: "company", tenantId: "", companyId: COMPANY },
      "missing_tenant_scope",
    ],
    [
      "a global limit naming a tenant",
      { scope: "global", tenantId: TENANT },
      "invalid_argument",
    ],
    [
      "a tenant limit naming a company",
      { scope: "tenant", tenantId: TENANT, companyId: COMPANY },
      "invalid_argument",
    ],
    [
      "a company limit with no company",
      { scope: "company", tenantId: TENANT },
      "invalid_argument",
    ],
    [
      "a malformed company",
      { scope: "company", tenantId: TENANT, companyId: "acme" },
      "malformed_identifier",
    ],
  ])("refuses %s before reaching the database", async (_case, target, code) => {
    expect(
      await outcomeOf(setSpendLimit(unreachable, target, VALUE, ACT)),
    ).toBe(code);
  });

  it.each<[string, SpendLimitValue]>([
    ["an amount that would round", { dailyUsd: "0.0000001", timezone: "UTC" }],
    ["a negative amount", { dailyUsd: "-5", timezone: "UTC" }],
    ["an amount in exponent form", { dailyUsd: "1e3", timezone: "UTC" }],
    [
      "an amount above one billion USD",
      { dailyUsd: "1000000001", timezone: "UTC" },
    ],
    ["an empty time zone", { dailyUsd: "5", timezone: "" }],
    ["a time zone with a space", { dailyUsd: "5", timezone: "Sao Paulo" }],
    ["an offset in place of a zone", { dailyUsd: "5", timezone: "+03:00" }],
    [
      "a time zone with a quote",
      { dailyUsd: "5", timezone: "UTC'; drop table x" },
    ],
  ])("refuses %s before reaching the database", async (_case, value) => {
    expect(
      await outcomeOf(
        setSpendLimit(unreachable, { scope: "global" }, value, ACT),
      ),
    ).toBe("invalid_argument");
  });

  it.each<[string, SpendLimitAct]>([
    ["a blank reason", { reason: "  ", actor: "owner" }],
    ["a 501-character reason", { reason: "r".repeat(501), actor: "owner" }],
    ["a malformed actor", { reason: "review", actor: "Owner" }],
  ])("refuses %s before reaching the database", async (_case, act) => {
    expect(
      await outcomeOf(
        setSpendLimit(unreachable, { scope: "global" }, VALUE, act),
      ),
    ).toBe("invalid_argument");
  });

  it("surfaces an unknown time zone and a changed zone as the database's typed refusals", async () => {
    expect(
      await outcomeOf(
        setSpendLimit(
          failingWith(
            "OS400",
            "ops.set_spend_limit: the time zone is missing or unknown",
          ),
          { scope: "global" },
          { dailyUsd: "5", timezone: "Mars/Olympus" },
          ACT,
        ),
      ),
    ).toBe("invalid_argument");
    expect(
      await outcomeOf(
        setSpendLimit(
          failingWith(
            "OS409",
            "ops.set_spend_limit: a new version keeps the time zone",
          ),
          { scope: "global" },
          VALUE,
          ACT,
        ),
      ),
    ).toBe("invalid_state");
  });

  it("refuses to invent an id when the database returns none", async () => {
    const outcome = await outcomeOf(
      setSpendLimit(recordingDatabase([]).tx, { scope: "global" }, VALUE, ACT),
    );

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(CompanyOsError);
  });
});

describe("retiring a spend limit", () => {
  it("sends the limit, the reason and the actor, and reports whether this act ended it", async () => {
    const retired = recordingDatabase([{ result: true }]);
    const already = recordingDatabase([{ result: false }]);

    expect(await retireSpendLimit(retired.tx, LIMIT, ACT)).toBe(true);
    expect(await retireSpendLimit(already.tx, LIMIT, ACT)).toBe(false);
    expect(retired.calls).toEqual([
      { sql: RETIRE_SQL, params: [LIMIT, ACT.reason, "owner"] },
    ]);
  });

  it("refuses a malformed limit or act before reaching the database", async () => {
    expect(await outcomeOf(retireSpendLimit(unreachable, "limit-1", ACT))).toBe(
      "malformed_identifier",
    );
    expect(
      await outcomeOf(
        retireSpendLimit(unreachable, LIMIT, { reason: "", actor: "owner" }),
      ),
    ).toBe("invalid_argument");
  });

  it("maps an unknown limit to not_found and reads only a boolean as the outcome", async () => {
    expect(
      await outcomeOf(
        retireSpendLimit(
          failingWith("OS404", "ops.retire_spend_limit: limit not found"),
          LIMIT,
          ACT,
        ),
      ),
    ).toBe("not_found");
    expect(
      await outcomeOf(
        retireSpendLimit(recordingDatabase([{ result: null }]).tx, LIMIT, ACT),
      ),
    ).toBeInstanceOf(Error);
  });
});

describe("listing spend limits", () => {
  const record = {
    id: LIMIT,
    scope: "tenant",
    tenant_id: TENANT,
    company_id: null,
    daily_limit_micros: "25500000",
    timezone: "America/Sao_Paulo",
    reason: "monthly budget review",
    set_by: "owner",
    set_at: "2026-09-17T08:00:00.000000Z",
    ended_at: null,
    ended_by: null,
    end_reason: null,
  };

  it("reads active limits only, bounded, unless history is asked for", async () => {
    const active = recordingDatabase([]);
    await listSpendLimits(active.tx);
    const all = recordingDatabase([]);
    await listSpendLimits(all.tx, { includeHistory: true });

    expect(MAX_LISTED_SPEND_LIMITS).toBe(500);
    expect(active.calls[0]?.params).toEqual([false, 500]);
    expect(all.calls[0]?.params).toEqual([true, 500]);
    expect(active.calls[0]?.sql).toMatch(/l\.ended_at is null/);
  });

  it("returns each limit in micro-USD and in USD", async () => {
    const { tx } = recordingDatabase([record]);

    expect(await listSpendLimits(tx)).toEqual([
      {
        id: LIMIT,
        scope: "tenant",
        tenantId: TENANT,
        companyId: null,
        dailyLimitMicros: "25500000",
        dailyLimitUsd: "25.500000",
        timezone: "America/Sao_Paulo",
        reason: "monthly budget review",
        setBy: "owner",
        setAt: "2026-09-17T08:00:00.000000Z",
        endedAt: null,
        endedBy: null,
        endReason: null,
      },
    ]);
  });

  it("refuses a row whose scope it does not know", async () => {
    const { tx } = recordingDatabase([{ ...record, scope: "fleet" }]);

    expect(await outcomeOf(listSpendLimits(tx))).toBeInstanceOf(Error);
  });
});

describe("reading today's spend", () => {
  const status = {
    limit_id: LIMIT,
    scope: "global",
    tenant_id: null,
    company_id: null,
    timezone: "UTC",
    window_start: "2026-09-17T00:00:00.000000Z",
    daily_limit_micros: "5000000",
    charged_micros: "5000001",
    settled_micros: "5000000",
    estimated_micros: "1200000",
    remaining_micros: "-1",
    running_runs: "2",
    unknown_cost_runs: "1",
    refused_runs: "3",
    settled_exhausted: true,
    new_run_admission: "blocked",
  };

  it("returns every total, settled spend included, as exact micro-USD text and as USD, including a negative remainder", async () => {
    const { tx, calls } = recordingDatabase([status]);

    expect(await readSpendStatus(tx)).toEqual([
      {
        limitId: LIMIT,
        scope: "global",
        tenantId: null,
        companyId: null,
        timezone: "UTC",
        windowStart: "2026-09-17T00:00:00.000000Z",
        dailyLimitMicros: "5000000",
        chargedMicros: "5000001",
        settledMicros: "5000000",
        estimatedMicros: "1200000",
        remainingMicros: "-1",
        dailyLimitUsd: "5.000000",
        chargedUsd: "5.000001",
        settledUsd: "5.000000",
        estimatedUsd: "1.200000",
        remainingUsd: "-0.000001",
        runningRuns: 2,
        unknownCostRuns: 1,
        refusedRuns: 3,
        settledExhausted: true,
        newRunAdmission: "blocked",
      },
    ]);
    expect(calls[0]?.sql).toMatch(/from ops\.spend_status\(\) s/);
    expect(calls[0]?.params).toEqual([null]);
  });

  it("reads settled exhaustion and the next start's admission as two separate columns of the database's status", async () => {
    const { tx, calls } = recordingDatabase([
      {
        ...status,
        settled_exhausted: false,
        new_run_admission: "blocked",
      },
    ]);

    const [row] = await readSpendStatus(tx);

    expect(row).toMatchObject({
      settledExhausted: false,
      newRunAdmission: "blocked",
    });
    expect(calls[0]?.sql).toMatch(
      /s\.settled_exhausted, s\.new_run_admission\s+from ops\.spend_status\(\) s/,
    );
  });

  it("refuses a new-run admission it does not know, rather than reading it as room to start", async () => {
    const { tx } = recordingDatabase([
      { ...status, new_run_admission: "available" },
    ]);

    expect(await outcomeOf(readSpendStatus(tx))).toBeInstanceOf(Error);
  });

  it("filters to the global ceiling and one tenant's limits through a parameter", async () => {
    const { tx, calls } = recordingDatabase([]);

    await readSpendStatus(tx, { tenantId: TENANT });

    expect(calls[0]?.params).toEqual([TENANT]);
    expect(calls[0]?.sql).not.toContain(TENANT);
  });

  it("refuses a malformed tenant before reaching the database", async () => {
    expect(
      await outcomeOf(readSpendStatus(unreachable, { tenantId: "dev" })),
    ).toBe("malformed_identifier");
  });

  it("refuses a count that is not a count", async () => {
    const { tx } = recordingDatabase([{ ...status, running_runs: "-1" }]);

    expect(await outcomeOf(readSpendStatus(tx))).toBeInstanceOf(Error);
  });
});

describe("listing tenants without a budget", () => {
  it("reads tenants with no active tenant limit, bounded", async () => {
    const { tx, calls } = recordingDatabase([
      { tenant_id: TENANT, slug: "dev" },
    ]);

    expect(await listTenantsWithoutBudget(tx)).toEqual([
      { tenantId: TENANT, slug: "dev" },
    ]);
    expect(MAX_LISTED_TENANTS_WITHOUT_BUDGET).toBe(200);
    expect(calls[0]?.params).toEqual([200]);
    expect(calls[0]?.sql).toMatch(
      /l\.scope = 'tenant' and l\.tenant_id = t\.id and l\.ended_at is null/,
    );
  });
});
