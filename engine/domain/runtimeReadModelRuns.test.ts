// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TxClient } from "../db/types.ts";
import type { AgentRunStatus } from "./agentRunStateMachine.ts";
import { CompanyOsError } from "./errors.ts";
import {
  DEFAULT_LISTED_RUNS,
  MAX_LISTED_RUNS,
  RUN_COLUMNS,
  listRecentRuns,
  listRunsNeedingAttention,
} from "./runtimeReadModelRuns.ts";

// The owner's run reads with no database: what they ask for, and what they can
// never return. Which rows match is proven against a real Postgres by the
// driver-backed tests.

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const RUN = "b0000000-0000-4000-8000-00000000000b";

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

const outcomeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof CompanyOsError ? error.code : error;
  }
  return "resolved";
};

const record = {
  id: RUN,
  tenant_id: TENANT,
  company_id: "c0000000-0000-4000-8000-00000000000c",
  task_id: "d0000000-0000-4000-8000-00000000000d",
  agent_id: "e0000000-0000-4000-8000-00000000000e",
  retry_of_run_id: null,
  capability: "task_assessment",
  model_route: "standard",
  status: "indeterminate",
  error_category: "timeout",
  error_code: "deadline",
  provider: "openai",
  model: "gpt-test-2026-01-01",
  response_model: "gpt-test-2026-02-02",
  input_tokens: null,
  output_tokens: null,
  total_tokens: null,
  cached_input_tokens: null,
  reasoning_tokens: null,
  latency_ms: 45012,
  job_attempt: 1,
  price_id: "f0000000-0000-4000-8000-00000000000f",
  reserved_cost_micros: "92345",
  estimated_cost_micros: null,
  charged_cost_micros: "92345",
  stop_id: null,
  spend_limit_id: null,
  created_at: "2026-09-17T10:00:00.000000Z",
  started_at: "2026-09-17T10:00:01.000000Z",
  completed_at: "2026-09-17T10:00:46.000000Z",
};

describe("the columns a run read may return", () => {
  it.each([
    "result",
    "idempotency_key",
    "request_fingerprint",
    "correlation_id",
    "input_fingerprint",
    "prompt_version",
    "provider_request_id",
    "provider_response_id",
    "requested_by",
  ])("never reads a run's %s", (column) => {
    expect(RUN_COLUMNS).not.toMatch(new RegExp(`\\b${column}\\b`));
  });

  it("never reads a run's result, prompt, task or agent text", async () => {
    const recent = recordingDatabase([]);
    const attention = recordingDatabase([]);

    await listRecentRuns(recent.tx);
    await listRunsNeedingAttention(attention.tx);

    for (const { sql } of [...recent.calls, ...attention.calls]) {
      expect(sql).not.toMatch(/\bops\.tasks\b|\bops\.agents\b/);
      expect(sql).not.toMatch(/\bresult\b|\btitle\b|\bdescription\b/);
    }
  });
});

describe("listing recent runs", () => {
  it("reads the newest runs through parameters only, fifty by default", async () => {
    const { tx, calls } = recordingDatabase([]);

    await listRecentRuns(tx);
    await listRecentRuns(tx, {
      tenantId: TENANT,
      status: "indeterminate",
      limit: MAX_LISTED_RUNS,
    });

    expect(DEFAULT_LISTED_RUNS).toBe(50);
    expect(calls[0]?.params).toEqual([null, null, 50]);
    expect(calls[1]?.params).toEqual([TENANT, "indeterminate", 200]);
    expect(calls[1]?.sql).not.toContain(TENANT);
    expect(calls[0]?.sql).toMatch(/order by r\.created_at desc/);
  });

  it("returns each run with its requested and reported model side by side, and costs as exact text", async () => {
    const { tx } = recordingDatabase([record]);

    const [run] = await listRecentRuns(tx);

    expect(run).toEqual({
      id: RUN,
      tenantId: TENANT,
      companyId: record.company_id,
      taskId: record.task_id,
      agentId: record.agent_id,
      retryOfRunId: null,
      capability: "task_assessment",
      modelRoute: "standard",
      status: "indeterminate",
      errorCategory: "timeout",
      errorCode: "deadline",
      provider: "openai",
      model: "gpt-test-2026-01-01",
      responseModel: "gpt-test-2026-02-02",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
      latencyMs: 45012,
      jobAttempt: 1,
      priceId: record.price_id,
      reservedCostMicros: "92345",
      estimatedCostMicros: null,
      chargedCostMicros: "92345",
      stopId: null,
      spendLimitId: null,
      createdAt: record.created_at,
      startedAt: record.started_at,
      completedAt: record.completed_at,
    });
  });

  it.each<[string, Parameters<typeof listRecentRuns>[1], string]>([
    ["a malformed tenant", { tenantId: "dev" }, "malformed_identifier"],
    [
      "an unknown status",
      { status: "stuck" as AgentRunStatus },
      "invalid_argument",
    ],
    ["a zero limit", { limit: 0 }, "invalid_argument"],
    ["a limit above the bound", { limit: 201 }, "invalid_argument"],
    ["a fractional limit", { limit: 2.5 }, "invalid_argument"],
    [
      "a limit given as text",
      { limit: "10" as unknown as number },
      "invalid_argument",
    ],
  ])(
    "refuses %s before reaching the database",
    async (_case, options, code) => {
      expect(await outcomeOf(listRecentRuns(unreachable, options))).toBe(code);
    },
  );

  it("refuses a row whose status it does not know", async () => {
    const { tx } = recordingDatabase([{ ...record, status: "paused" }]);

    expect(await outcomeOf(listRecentRuns(tx))).toBeInstanceOf(Error);
  });
});

describe("listing runs that need an operator", () => {
  it("asks for unretried indeterminate runs and running runs without a live lease on the current clock", async () => {
    const { tx, calls } = recordingDatabase([]);

    await listRunsNeedingAttention(tx, { tenantId: TENANT });

    const [call] = calls;
    expect(call?.params).toEqual([TENANT, MAX_LISTED_RUNS]);
    expect(call?.sql).toMatch(/x\.retry_of_run_id = r\.id/);
    expect(call?.sql).toMatch(/j\.lease_expires_at > clock_timestamp\(\)/);
    expect(call?.sql).toMatch(/j\.attempts = r\.job_attempt/);
  });

  it("returns each run with the reason it needs attention", async () => {
    const { tx } = recordingDatabase([
      { ...record, attention: "indeterminate_not_retried" },
      {
        ...record,
        status: "running",
        completed_at: null,
        attention: "running_without_live_lease",
      },
    ]);

    expect(
      (await listRunsNeedingAttention(tx)).map(({ status, attention }) => ({
        status,
        attention,
      })),
    ).toEqual([
      { status: "indeterminate", attention: "indeterminate_not_retried" },
      { status: "running", attention: "running_without_live_lease" },
    ]);
  });

  it("refuses a row that comes back with no reason", async () => {
    const { tx } = recordingDatabase([record]);

    expect(await outcomeOf(listRunsNeedingAttention(tx))).toBeInstanceOf(Error);
  });

  it("refuses a malformed tenant before reaching the database", async () => {
    expect(
      await outcomeOf(
        listRunsNeedingAttention(unreachable, { tenantId: "tenant-a" }),
      ),
    ).toBe("malformed_identifier");
  });
});
