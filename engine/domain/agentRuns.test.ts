// @vitest-environment node
import { describe, expect, expectTypeOf, it } from "vitest";
import type { TxClient } from "../db/types.ts";
import {
  requestAgentRun,
  type AgentRunRequestContext,
  type RequestAgentRunInput,
} from "./agentRuns.ts";
import { CompanyOsError } from "./errors.ts";

// What the typed boundary itself decides, with no database. Scope resolution,
// the gates, idempotency, lineage and the kill switch need one, and are proven
// against a real Postgres in supabase/tests/agent_runtime.sql.

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const OTHER_TENANT = "b0000000-0000-4000-8000-00000000000b";
const TASK = "c0000000-0000-4000-8000-00000000000c";
const AGENT = "d0000000-0000-4000-8000-00000000000d";
const RUN = "e0000000-0000-4000-8000-00000000000e";
const PARENT = "f0000000-0000-4000-8000-00000000000f";
const CORRELATION = "10000000-0000-4000-8000-000000000001";
const CAUSATION = "20000000-0000-4000-8000-000000000002";

const REQUEST_SQL =
  "select ops.request_agent_run($1, $2, $3, $4, $5, $6, $7) as result";

interface RecordedCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** A database that answers every call with `result` and records what it was sent. */
const recordingDatabase = (result: unknown) => {
  const calls: RecordedCall[] = [];
  const tx: TxClient = {
    async query<TRow>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [{ result }] as unknown as TRow[] };
    },
  };
  return { tx, calls };
};

/** A database that must never be reached. */
const unreachable: TxClient = {
  query: () => {
    throw new Error("the database was reached with input that is never valid");
  },
};

/** A database that answers every call with one pg-shaped error. */
const failingWith = (code: string, message: string): TxClient => ({
  query: async () => {
    throw Object.assign(new Error(message), { code });
  },
});

const context = (
  overrides: Partial<AgentRunRequestContext> = {},
): AgentRunRequestContext => ({
  tenantId: TENANT,
  source: "test",
  ...overrides,
});

const input = (
  overrides: Partial<RequestAgentRunInput> = {},
): RequestAgentRunInput => ({
  taskId: TASK,
  agentId: AGENT,
  capability: "task_assessment",
  idempotencyKey: "assessment:1",
  ...overrides,
});

const outcomeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof CompanyOsError ? error.code : error;
  }
  return "resolved";
};

describe("requesting an agent run", () => {
  it("sends exactly the seven request arguments, in order, and resolves to the run id", async () => {
    const { tx, calls } = recordingDatabase(RUN);

    const id = await requestAgentRun(tx, context(), input());

    expect(id).toBe(RUN);
    expect(calls).toEqual([
      {
        sql: REQUEST_SQL,
        params: [
          TENANT,
          TASK,
          AGENT,
          "task_assessment",
          "assessment:1",
          "test",
          null,
        ],
      },
    ]);
  });

  it("names a retry's parent run as the seventh argument", async () => {
    const { tx, calls } = recordingDatabase(RUN);

    await requestAgentRun(tx, context(), input({ retryOfRunId: PARENT }));

    expect(calls[0]?.params[6]).toBe(PARENT);
  });

  it("offers no correlation or causation to set", () => {
    expectTypeOf<keyof AgentRunRequestContext>().toEqualTypeOf<
      "tenantId" | "source"
    >();
    expectTypeOf<keyof RequestAgentRunInput>().toEqualTypeOf<
      "taskId" | "agentId" | "capability" | "idempotencyKey" | "retryOfRunId"
    >();
  });

  it("never forwards lineage or a tenant smuggled onto the context or the input", async () => {
    const { tx, calls } = recordingDatabase(RUN);
    const smuggledContext = {
      tenantId: TENANT,
      source: "test",
      correlationId: CORRELATION,
      causationId: CAUSATION,
    };
    const smuggledInput = {
      ...input(),
      tenantId: OTHER_TENANT,
      correlationId: CORRELATION,
      causationId: CAUSATION,
    };

    await requestAgentRun(tx, smuggledContext, smuggledInput);

    const params = calls[0]?.params ?? [];
    expect(params).toHaveLength(7);
    expect(params[0]).toBe(TENANT);
    for (const smuggled of [CORRELATION, CAUSATION, OTHER_TENANT]) {
      expect(params).not.toContain(smuggled);
    }
  });

  it.each<[string, AgentRunRequestContext, RequestAgentRunInput, string]>([
    [
      "an empty tenant scope",
      context({ tenantId: "" }),
      input(),
      "missing_tenant_scope",
    ],
    [
      "an absent tenant scope",
      context({ tenantId: undefined as unknown as string }),
      input(),
      "missing_tenant_scope",
    ],
    [
      "a malformed tenant scope",
      context({ tenantId: "tenant-a" }),
      input(),
      "malformed_identifier",
    ],
    [
      "a malformed source",
      context({ source: "Not Valid" }),
      input(),
      "invalid_argument",
    ],
    ["an empty source", context({ source: "" }), input(), "invalid_argument"],
    [
      "a source with an @, which only a stop actor may carry",
      context({ source: "ops:on-call@example" }),
      input(),
      "invalid_argument",
    ],
    [
      "a 129-character source",
      context({ source: "s".repeat(129) }),
      input(),
      "invalid_argument",
    ],
    [
      "a malformed task id",
      context(),
      input({ taskId: "task-7" }),
      "malformed_identifier",
    ],
    [
      "an empty agent id",
      context(),
      input({ agentId: "" }),
      "malformed_identifier",
    ],
    [
      "a malformed retry parent",
      context(),
      input({ retryOfRunId: "run-1" }),
      "malformed_identifier",
    ],
    [
      "an upper-case capability",
      context(),
      input({ capability: "Task_Assessment" }),
      "invalid_argument",
    ],
    [
      "a capability with a trailing dot",
      context(),
      input({ capability: "task_assessment." }),
      "invalid_argument",
    ],
    [
      "a capability with a space",
      context(),
      input({ capability: "task assessment" }),
      "invalid_argument",
    ],
    [
      "an empty capability",
      context(),
      input({ capability: "" }),
      "invalid_argument",
    ],
    [
      "a 101-character capability",
      context(),
      input({ capability: "a".repeat(101) }),
      "invalid_argument",
    ],
    [
      "an empty idempotency key",
      context(),
      input({ idempotencyKey: "" }),
      "invalid_argument",
    ],
    [
      "an idempotency key with a space",
      context(),
      input({ idempotencyKey: "has space" }),
      "invalid_argument",
    ],
    [
      "an idempotency key with a tab",
      context(),
      input({ idempotencyKey: "has\ttab" }),
      "invalid_argument",
    ],
    [
      "a non-ASCII idempotency key",
      context(),
      input({ idempotencyKey: "chave-é" }),
      "invalid_argument",
    ],
    [
      "a 201-character idempotency key",
      context(),
      input({ idempotencyKey: "k".repeat(201) }),
      "invalid_argument",
    ],
  ])(
    "refuses %s before reaching the database",
    async (_case, ctx, request, code) => {
      expect(await outcomeOf(requestAgentRun(unreachable, ctx, request))).toBe(
        code,
      );
    },
  );

  it("accepts the longest capability and key the database accepts", async () => {
    const { tx, calls } = recordingDatabase(RUN);

    await requestAgentRun(
      tx,
      context(),
      input({
        capability: `a.${"b".repeat(98)}`,
        idempotencyKey: "~".repeat(200),
      }),
    );

    expect(calls).toHaveLength(1);
  });

  it("rejects the promise rather than throwing, so a caller handling the promise sees every refusal", async () => {
    const pending = requestAgentRun(
      unreachable,
      context({ tenantId: "" }),
      input(),
    );

    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toBeInstanceOf(CompanyOsError);
  });

  it.each([
    [
      "OS409",
      "that idempotency key already names a different agent run request",
      "invalid_state",
    ],
    ["OS404", "task not found in this tenant", "not_found"],
    ["OS403", "'made_up' is not an agent run capability", "refused"],
  ])(
    "surfaces the database's %s refusal as a typed error",
    async (sqlstate, message, code) => {
      expect(
        await outcomeOf(
          requestAgentRun(failingWith(sqlstate, message), context(), input()),
        ),
      ).toBe(code);
    },
  );

  it("does not disguise a native permission failure as a domain refusal", async () => {
    const outcome = await outcomeOf(
      requestAgentRun(
        failingWith(
          "42501",
          "permission denied for function request_agent_run",
        ),
        context(),
        input(),
      ),
    );

    expect(outcome).not.toBeInstanceOf(CompanyOsError);
    expect((outcome as { code?: string }).code).toBe("42501");
  });

  it("refuses to invent an id when the database returns none", async () => {
    const { tx } = recordingDatabase(null);

    const outcome = await outcomeOf(requestAgentRun(tx, context(), input()));

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(CompanyOsError);
  });
});
