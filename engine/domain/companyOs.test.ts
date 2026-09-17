import { describe, expect, it } from "vitest";
import type { TxClient } from "../db/types.ts";
import {
  assignTask,
  createCompany,
  createTask,
  recordEvent,
  transitionTask,
  type DomainContext,
} from "./companyOs.ts";
import { CompanyOsError } from "./errors.ts";
import type { TaskStatus } from "./taskStateMachine.ts";

// What the typed boundary itself decides, with no database. Everything that
// needs one — scope resolution, the state machine, events, integrity, and what an
// idempotency key deduplicates — is proven against a real Postgres in
// companyOs.dbtest.ts and company_domain_core.sql.

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const COMPANY = "b0000000-0000-4000-8000-00000000000b";
const TASK = "c0000000-0000-4000-8000-00000000000c";
const AGENT = "d0000000-0000-4000-8000-00000000000d";
const EVENT = "e0000000-0000-4000-8000-00000000000e";

/** A database that answers one id and records what it was sent. */
const recording = (result: string) => {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const tx: TxClient = {
    async query<TRow>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [{ result }] as TRow[] };
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

const context = (overrides: Partial<DomainContext> = {}): DomainContext => ({
  tenantId: TENANT,
  source: "test",
  ...overrides,
});

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof CompanyOsError ? error.code : error;
  }
  return "resolved";
};

describe("the Company OS domain boundary", () => {
  it("fails closed on a missing tenant scope before reaching the database", async () => {
    expect(
      await codeOf(
        createCompany(unreachable, context({ tenantId: "" }), {
          slug: "x",
          name: "X",
        }),
      ),
    ).toBe("missing_tenant_scope");
  });

  it("rejects a malformed tenant scope before reaching the database", async () => {
    expect(
      await codeOf(
        createCompany(unreachable, context({ tenantId: "not-a-uuid" }), {
          slug: "x",
          name: "X",
        }),
      ),
    ).toBe("malformed_identifier");
  });

  it("rejects malformed ids and provenance before reaching the database", async () => {
    expect(
      await codeOf(assignTask(unreachable, context(), TASK, "agent-7")),
    ).toBe("malformed_identifier");
    expect(
      await codeOf(
        assignTask(unreachable, context({ source: "Not Valid" }), TASK, AGENT),
      ),
    ).toBe("invalid_argument");
    expect(
      await codeOf(
        assignTask(
          unreachable,
          context({ correlationId: "nope" }),
          TASK,
          AGENT,
        ),
      ),
    ).toBe("malformed_identifier");
  });

  it("refuses a runtime label that is not a task status", async () => {
    expect(
      await codeOf(
        transitionTask(
          unreachable,
          context(),
          TASK,
          "thinking" as unknown as TaskStatus,
        ),
      ),
    ).toBe("invalid_argument");
  });

  it("surfaces a database refusal as a typed error", async () => {
    expect(
      await codeOf(
        assignTask(
          failingWith("OS404", "agent not found in this company"),
          context(),
          TASK,
          AGENT,
        ),
      ),
    ).toBe("not_found");
  });

  it("forwards a task's idempotency key as the thirteenth and last argument of ops.create_task", async () => {
    const { tx, calls } = recording(TASK);

    await createTask(tx, context(), {
      companyId: COMPANY,
      type: "operations.supply_order",
      title: "Order paper",
      idempotencyKey: "integration:order-42",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe(
      "select ops.create_task($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) as result",
    );
    expect(calls[0]?.params).toEqual([
      TENANT,
      COMPANY,
      "operations.supply_order",
      "Order paper",
      "test",
      null,
      null,
      null,
      100,
      null,
      null,
      null,
      "integration:order-42",
    ]);
  });

  it("forwards an event's idempotency key as the tenth and last argument of ops.record_event", async () => {
    const { tx, calls } = recording(EVENT);

    await recordEvent(tx, context(), {
      companyId: COMPANY,
      type: "crm.lead_received",
      idempotencyKey: "webhook:delivery-7",
    });

    expect(calls[0]?.sql).toBe(
      "select ops.record_event($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as result",
    );
    expect(calls[0]?.params).toHaveLength(10);
    expect(calls[0]?.params[9]).toBe("webhook:delivery-7");
  });

  it("forwards no idempotency key as null, keeping today's non-deduplicated create", async () => {
    const task = recording(TASK);
    const event = recording(EVENT);

    await createTask(task.tx, context(), {
      companyId: COMPANY,
      type: "operations.supply_order",
      title: "Order paper",
    });
    await recordEvent(event.tx, context(), {
      companyId: COMPANY,
      type: "crm.lead_received",
    });

    expect(task.calls[0]?.params).toHaveLength(13);
    expect(task.calls[0]?.params[12]).toBeNull();
    expect(event.calls[0]?.params).toHaveLength(10);
    expect(event.calls[0]?.params[9]).toBeNull();
  });

  it.each([
    ["an empty key", ""],
    ["a key with a space", "order 42"],
    ["a key with a control character", `order${String.fromCodePoint(0)}42`],
    ["a key with a non-ASCII character", `order-${String.fromCodePoint(0xe9)}`],
    ["a 201-character key", "k".repeat(201)],
    ["a key that is not text", 42 as unknown as string],
  ])("never sends %s to the database", async (_case, idempotencyKey) => {
    expect(
      await codeOf(
        createTask(unreachable, context(), {
          companyId: COMPANY,
          type: "operations.supply_order",
          title: "Order paper",
          idempotencyKey,
        }),
      ),
    ).toBe("invalid_argument");
    expect(
      await codeOf(
        recordEvent(unreachable, context(), {
          companyId: COMPANY,
          type: "crm.lead_received",
          idempotencyKey,
        }),
      ),
    ).toBe("invalid_argument");
  });

  it("accepts a key of exactly 200 printable characters", async () => {
    const { tx, calls } = recording(TASK);
    const key = "~".repeat(199) + "!";

    await createTask(tx, context(), {
      companyId: COMPANY,
      type: "operations.supply_order",
      title: "Order paper",
      idempotencyKey: key,
    });

    expect(calls[0]?.params[12]).toBe(key);
  });

  it("surfaces a key already naming a different request as invalid_state", async () => {
    const refusal = failingWith(
      "OS409",
      "ops.create_task: that idempotency key already names a different task request",
    );

    expect(
      await codeOf(
        createTask(refusal, context(), {
          companyId: COMPANY,
          type: "operations.supply_order",
          title: "Order toner instead",
          idempotencyKey: "integration:order-42",
        }),
      ),
    ).toBe("invalid_state");
    expect(
      await codeOf(
        recordEvent(refusal, context(), {
          companyId: COMPANY,
          type: "crm.lead_received",
          idempotencyKey: "webhook:delivery-7",
        }),
      ),
    ).toBe("invalid_state");
  });

  it("does not disguise a native permission failure as a domain refusal", async () => {
    const outcome = await codeOf(
      assignTask(
        failingWith("42501", "permission denied for function assign_task"),
        context(),
        TASK,
        AGENT,
      ),
    );
    expect(outcome).not.toBeInstanceOf(CompanyOsError);
    expect((outcome as { code?: string }).code).toBe("42501");
  });
});
