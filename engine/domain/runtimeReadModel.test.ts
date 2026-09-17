// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TxClient } from "../db/types.ts";
import { CompanyOsError } from "./errors.ts";
import { HELD_JOB_SCAN_LIMIT, readRuntimeStatus } from "./runtimeReadModel.ts";

// The owner's one-object runtime status with no database: what it asks, how it
// assembles the answer, and what it never reads. Which rows match is proven
// against a real Postgres by the driver-backed tests.

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const LIMIT = "b0000000-0000-4000-8000-00000000000b";
const SINCE = "2026-09-17T00:00:00.000000Z";
const NOW = "2026-09-17T13:45:00.123456Z";

interface Answers {
  readonly stops?: readonly unknown[];
  readonly runsToday?: readonly unknown[];
  readonly held?: readonly unknown[];
  readonly attention?: readonly unknown[];
  readonly spend?: readonly unknown[];
  readonly tenants?: readonly unknown[];
  readonly fail?: unknown;
}

const spendRecord = {
  limit_id: LIMIT,
  scope: "global",
  tenant_id: null,
  company_id: null,
  timezone: "UTC",
  window_start: SINCE,
  daily_limit_micros: "5000000",
  charged_micros: "1250000",
  settled_micros: "1000000",
  estimated_micros: "1000000",
  remaining_micros: "3750000",
  running_runs: "1",
  unknown_cost_runs: "0",
  refused_runs: "0",
  settled_exhausted: false,
  new_run_admission: "conditional",
};

/** Answers each statement the status makes by what it reads, and records them all. */
const statusDatabase = (answers: Answers = {}) => {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const pick = (sql: string): readonly unknown[] => {
    if (sql.includes("group by s.scope, s.origin")) return answers.stops ?? [];
    if (sql.includes("left join ops.agent_runs r on r.started_at")) {
      return (
        answers.runsToday ?? [
          { since: SINCE, generated_at: NOW, status: null, count: 0 },
        ]
      );
    }
    if (sql.includes("ops.job_covering_stop")) {
      return answers.held ?? [{ scanned: 0, held: 0 }];
    }
    if (sql.includes("from ops.agent_runs r\n where")) {
      return answers.attention ?? [{ count: 0 }];
    }
    if (sql.includes("ops.spend_status()")) return answers.spend ?? [];
    if (sql.includes("from ops.tenants t")) return answers.tenants ?? [];
    throw new Error(`an unexpected statement: ${sql}`);
  };
  const tx: TxClient = {
    async query<TRow>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      if (answers.fail !== undefined) throw answers.fail;
      return { rows: [...pick(sql)] as TRow[] };
    },
  };
  return { tx, calls };
};

const outcomeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof CompanyOsError ? error.code : error;
  }
  return "resolved";
};

describe("reading the runtime status", () => {
  it("answers one object with stops by scope and origin, today's runs by status, held jobs, attention and spend", async () => {
    const { tx } = statusDatabase({
      stops: [
        { scope: "global", origin: "system", count: 1 },
        { scope: "job_kind", origin: "owner", count: 2 },
      ],
      runsToday: [
        { since: SINCE, generated_at: NOW, status: "failed", count: 1 },
        { since: SINCE, generated_at: NOW, status: "succeeded", count: 7 },
      ],
      held: [{ scanned: 12, held: 3 }],
      attention: [{ count: 2 }],
      spend: [spendRecord],
      tenants: [{ tenant_id: TENANT, slug: "clinic" }],
    });

    const status = await readRuntimeStatus(tx);

    expect(status).toEqual({
      generatedAt: NOW,
      activeStops: [
        { scope: "global", origin: "system", count: 1 },
        { scope: "job_kind", origin: "owner", count: 2 },
      ],
      runsStartedToday: {
        since: SINCE,
        byStatus: { failed: 1, succeeded: 7 },
      },
      heldJobs: {
        held: 3,
        scanned: 12,
        scanLimit: HELD_JOB_SCAN_LIMIT,
        complete: true,
      },
      runsNeedingAttention: 2,
      spend: [
        expect.objectContaining({
          limitId: LIMIT,
          scope: "global",
          chargedMicros: "1250000",
          settledMicros: "1000000",
          chargedUsd: "1.250000",
          remainingUsd: "3.750000",
        }),
      ],
      globalCeilingConfigured: true,
      tenantsWithoutBudget: [{ tenantId: TENANT, slug: "clinic" }],
    });
  });

  it("reports an idle runtime as zero runs today, nothing held and nothing stopped", async () => {
    const { tx } = statusDatabase();

    const status = await readRuntimeStatus(tx);

    expect(status.activeStops).toEqual([]);
    expect(status.runsStartedToday).toEqual({ since: SINCE, byStatus: {} });
    expect(status.heldJobs).toMatchObject({ held: 0, complete: true });
    expect(status.runsNeedingAttention).toBe(0);
    expect(status.spend).toEqual([]);
    // With no ceiling row, nothing can start: the status says so, not by absence.
    expect(status.globalCeilingConfigured).toBe(false);
  });

  it("counts today's runs from UTC midnight, on the database's clock", async () => {
    const { tx, calls } = statusDatabase();

    await readRuntimeStatus(tx);

    const runsToday = calls.find(({ sql }) =>
      sql.includes("left join ops.agent_runs r on r.started_at"),
    );
    expect(runsToday?.sql).toContain(
      "date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'",
    );
    expect(runsToday?.sql).toMatch(/r\.started_at >= w\.since/);
  });

  it("counts held jobs with the lease's own evaluator, over queued external jobs in lease order", async () => {
    const { tx, calls } = statusDatabase();

    await readRuntimeStatus(tx);

    const held = calls.find(({ sql }) => sql.includes("ops.job_covering_stop"));
    expect(held?.sql).toContain(
      "ops.job_covering_stop(q.tenant_id, q.id, q.kind) is not null",
    );
    expect(held?.sql).toMatch(/j\.status = 'queued'/);
    expect(held?.sql).toMatch(
      /not \(j\.kind = any \(ops\.internal_job_kinds\(\)\)\)/,
    );
    expect(held?.sql).toMatch(
      /order by j\.priority, j\.available_at, j\.created_at, j\.id/,
    );
  });

  it("caps the held-job scan at ten thousand queued jobs and says when its count is only a lower bound", async () => {
    const { tx, calls } = statusDatabase({
      held: [{ scanned: HELD_JOB_SCAN_LIMIT, held: 9 }],
    });

    const status = await readRuntimeStatus(tx);

    expect(HELD_JOB_SCAN_LIMIT).toBe(10_000);
    const held = calls.find(({ sql }) => sql.includes("ops.job_covering_stop"));
    expect(held?.params).toEqual([HELD_JOB_SCAN_LIMIT]);
    expect(held?.sql).toMatch(/limit \$1\)/);
    expect(status.heldJobs).toEqual({
      held: 9,
      scanned: HELD_JOB_SCAN_LIMIT,
      scanLimit: HELD_JOB_SCAN_LIMIT,
      complete: false,
    });
  });

  it("counts every run needing attention across tenants, through a null tenant parameter", async () => {
    const { tx, calls } = statusDatabase();

    await readRuntimeStatus(tx);

    const attention = calls.find(({ sql }) =>
      sql.includes("x.retry_of_run_id = r.id"),
    );
    expect(attention?.params).toEqual([null]);
    expect(attention?.sql).toMatch(/^select count\(\*\)::int as count/);
  });

  it("reads the runtime status through plain parameterised selects only, never a write", async () => {
    const { tx, calls } = statusDatabase();

    await readRuntimeStatus(tx);

    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const { sql } of calls) {
      expect(sql.trimStart()).toMatch(/^select\b/);
      expect(sql).not.toMatch(
        /\b(insert|update|delete|truncate|set_config|nextval)\b/i,
      );
      expect(sql).not.toContain(TENANT);
    }
  });

  it("never reads a run's result, prompt, task or agent text, idempotency key or correlation id", async () => {
    const { tx, calls } = statusDatabase();

    await readRuntimeStatus(tx);

    for (const { sql } of calls) {
      expect(sql).not.toMatch(/\bops\.tasks\b|\bops\.agents\b|\bops\.events\b/);
      expect(sql).not.toMatch(
        /\bresult\b|\btitle\b|\bdescription\b|\bpayload\b|\bidempotency_key\b|\bcorrelation_id\b/,
      );
    }
  });

  it.each([
    [
      "an unknown stop scope",
      { stops: [{ scope: "fleet", origin: "owner", count: 1 }] },
    ],
    [
      "an unknown stop origin",
      { stops: [{ scope: "global", origin: "robot", count: 1 }] },
    ],
    [
      "an unknown run status",
      {
        runsToday: [
          { since: SINCE, generated_at: NOW, status: "paused", count: 1 },
        ],
      },
    ],
    ["a negative count", { attention: [{ count: -1 }] }],
    ["a missing window", { runsToday: [] }],
  ])("refuses %s rather than typing it", async (_case, answers) => {
    const { tx } = statusDatabase(answers);

    expect(await outcomeOf(readRuntimeStatus(tx))).toBeInstanceOf(Error);
  });

  it("surfaces the database's refusal to answer under row security as a typed error", async () => {
    const { tx } = statusDatabase({
      fail: Object.assign(
        new Error(
          "ops.spend_status: row security would hide runs or limits from this caller",
        ),
        { code: "OS403", severity: "ERROR" },
      ),
    });

    expect(await outcomeOf(readRuntimeStatus(tx))).toBe("refused");
  });
});
