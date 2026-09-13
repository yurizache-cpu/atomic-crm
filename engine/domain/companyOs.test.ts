import { describe, expect, it } from "vitest";
import type { TxClient } from "../db/types.ts";
import {
  assignTask,
  createCompany,
  transitionTask,
  type DomainContext,
} from "./companyOs.ts";
import { CompanyOsError } from "./errors.ts";
import type { TaskStatus } from "./taskStateMachine.ts";

// What the typed boundary itself decides, with no database. Everything that
// needs one — scope resolution, the state machine, events, integrity — is proven
// against a real Postgres in companyOs.dbtest.ts and company_domain_core.sql.

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const TASK = "c0000000-0000-4000-8000-00000000000c";
const AGENT = "d0000000-0000-4000-8000-00000000000d";

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
