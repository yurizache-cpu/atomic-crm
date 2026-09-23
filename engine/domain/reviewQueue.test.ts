// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TxClient } from "../db/types.ts";
import { CompanyOsError } from "./errors.ts";
import {
  DEFAULT_LISTED_REVIEWS,
  listReviewItems,
  MAX_LISTED_REVIEWS,
  MAX_REVIEW_NOTE_LENGTH,
  readReviewItem,
  recordReviewDecision,
  REVIEW_DECISIONS,
  type ReviewDecision,
} from "./reviewQueue.ts";

// What the review queue sends and what it refuses to send. What the database
// does with a decision — terminal once decided, refused for a lead that must
// not be contacted — is proven by the driver-backed suite.

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const REVIEW = "e0000000-0000-4000-8000-00000000000e";

const record = (overrides: Record<string, unknown> = {}) => ({
  id: REVIEW,
  tenant_id: TENANT,
  company_id: "b0000000-0000-4000-8000-00000000000b",
  task_id: "c0000000-0000-4000-8000-00000000000c",
  agent_run_id: "d0000000-0000-4000-8000-00000000000d",
  capability: "lead_triage",
  status: "pending",
  do_not_contact: false,
  reviewer: null,
  decision_note: null,
  created_at: "2026-09-17T12:00:00.000000Z",
  reviewed_at: null,
  ...overrides,
});

const recorder = (rows: unknown[] = [record()]) => {
  const queries: { sql: string; params: readonly unknown[] }[] = [];
  const tx: TxClient = {
    async query<TRow>(sql: string, params: readonly unknown[] = []) {
      queries.push({ sql, params });
      return { rows: rows as TRow[] };
    },
  };
  return { queries, tx };
};

const refusalFrom = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CompanyOsError);
    return (error as CompanyOsError).code;
  }
  throw new Error("expected a CompanyOsError");
};

const refusal = async (run: (tx: TxClient) => Promise<unknown>) => {
  const { tx } = recorder();
  try {
    await run(tx);
  } catch (error) {
    expect(error).toBeInstanceOf(CompanyOsError);
    return (error as CompanyOsError).code;
  }
  throw new Error("expected a CompanyOsError");
};

describe("listing review items", () => {
  it("reads only, with every option bound", async () => {
    const { queries, tx } = recorder();

    await listReviewItems(tx, {
      tenantId: TENANT,
      status: "pending",
      limit: 20,
    });

    expect(queries[0].sql).toMatch(/^select\b/);
    expect(queries[0].sql).not.toMatch(/insert|update|delete|truncate/i);
    expect(queries[0].params).toEqual([TENANT, "pending", 20]);
    expect(queries[0].sql).not.toContain(TENANT);
  });

  it("defaults to every tenant, every status and a bounded page", async () => {
    const { queries, tx } = recorder();
    await listReviewItems(tx);
    expect(queries[0].params).toEqual([null, null, DEFAULT_LISTED_REVIEWS]);
  });

  it("puts what is waiting first", async () => {
    const { queries, tx } = recorder();
    await listReviewItems(tx);
    expect(queries[0].sql).toContain("v.status = 'pending' desc");
  });

  it("does not return the advice in a listing", async () => {
    const { tx } = recorder([record({ proposed: { summary: "advice" } })]);
    const [item] = await listReviewItems(tx);
    expect(item).not.toHaveProperty("proposed");
    expect(item.status).toBe("pending");
    expect(Object.isFrozen(item)).toBe(true);
  });

  it.each<[string, unknown]>([
    ["a tenant that is not a uuid", { tenantId: "tenant" }],
    ["an invented status", { status: "approved" }],
    ["a limit of zero", { limit: 0 }],
    ["a limit past the ceiling", { limit: MAX_LISTED_REVIEWS + 1 }],
    ["a fractional limit", { limit: 1.5 }],
  ])("refuses %s", async (_name, options) => {
    expect(
      await refusal((tx) => listReviewItems(tx, options as object)),
    ).toMatch(/invalid_argument|malformed_identifier/);
  });

  it("throws rather than typing an unknown status through", async () => {
    const { tx } = recorder([record({ status: "approved" })]);
    await expect(listReviewItems(tx)).rejects.toThrow("unknown status");
  });
});

describe("reading one review item", () => {
  it("returns the advice a person is being asked to decide about", async () => {
    const proposed = { outcome: "triaged", summary: "wants a first session" };
    const { queries, tx } = recorder([record({ proposed })]);

    const item = await readReviewItem(tx, REVIEW, { tenantId: TENANT });

    expect(item?.proposed).toEqual(proposed);
    expect(queries[0].params).toEqual([REVIEW, TENANT]);
  });

  it("answers nothing for an item another tenant owns", async () => {
    const { tx } = recorder([]);
    expect(
      await readReviewItem(tx, REVIEW, { tenantId: TENANT }),
    ).toBeUndefined();
  });

  it("refuses an id that is not a uuid", async () => {
    expect(await refusal((tx) => readReviewItem(tx, "the-first-one"))).toBe(
      "malformed_identifier",
    );
  });
});

describe("recording a decision", () => {
  const decided = (status: string, recorded = true) =>
    recorder([{ result: { review_item_id: REVIEW, status, recorded } }]);

  it.each(REVIEW_DECISIONS)("records %s as a bound value", async (decision) => {
    const { queries, tx } = decided(decision);

    const result = await recordReviewDecision(
      tx,
      { tenantId: TENANT, source: "operator-cli" },
      { reviewId: REVIEW, decision, reviewer: "owner", note: "looks right" },
    );

    expect(result).toEqual({
      reviewItemId: REVIEW,
      status: decision,
      recorded: true,
    });
    expect(queries[0].sql).toContain("ops.record_review_decision");
    expect(queries[0].params).toEqual([
      TENANT,
      REVIEW,
      decision,
      "owner",
      "operator-cli",
      "looks right",
    ]);
  });

  it("reports a repeated decision as already recorded", async () => {
    const { tx } = decided("accepted", false);
    const result = await recordReviewDecision(
      tx,
      { tenantId: TENANT, source: "operator-cli" },
      { reviewId: REVIEW, decision: "accepted", reviewer: "owner" },
    );
    expect(result.recorded).toBe(false);
  });

  it("sends no note as null rather than as an empty string", async () => {
    const { queries, tx } = decided("rejected");
    await recordReviewDecision(
      tx,
      { tenantId: TENANT, source: "operator-cli" },
      { reviewId: REVIEW, decision: "rejected", reviewer: "owner" },
    );
    expect(queries[0].params[5]).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ["no decision", { decision: undefined }],
    ["a decision of pending", { decision: "pending" }],
    ["an invented decision", { decision: "approved" }],
    ["nobody deciding", { reviewer: undefined }],
    ["a blank reviewer", { reviewer: "" }],
    ["an oversize note", { note: "a".repeat(MAX_REVIEW_NOTE_LENGTH + 1) }],
    ["an item that is not a uuid", { reviewId: "the-first-one" }],
  ])("refuses a decision with %s", async (_name, overrides) => {
    const code = await refusal((tx) =>
      recordReviewDecision(tx, { tenantId: TENANT, source: "operator-cli" }, {
        reviewId: REVIEW,
        decision: "accepted" as ReviewDecision,
        reviewer: "owner",
        ...overrides,
      } as never),
    );
    expect(["invalid_argument", "malformed_identifier"]).toContain(code);
  });

  it.each([
    "principal:a1000000-0000-4000-8000-0000000000a1",
    "Principal:a1000000-0000-4000-8000-0000000000a1",
  ])(
    "refuses a reviewer label claiming the principal: prefix (%s) before reaching the database",
    async (reviewer) => {
      const { queries, tx } = recorder();

      const code = await refusalFrom(
        recordReviewDecision(
          tx,
          { tenantId: TENANT, source: "operator-cli" },
          { reviewId: REVIEW, decision: "accepted", reviewer },
        ),
      );

      expect(code).toBe("invalid_argument");
      expect(queries).toEqual([]);
    },
  );

  it("refuses a decision with no tenant scope", async () => {
    expect(
      await refusal((tx) =>
        recordReviewDecision(
          tx,
          { tenantId: "", source: "operator-cli" },
          { reviewId: REVIEW, decision: "accepted", reviewer: "owner" },
        ),
      ),
    ).toBe("malformed_identifier");
  });

  it("refuses an answer that is not a decision", async () => {
    const { tx } = recorder([{ result: { status: "accepted" } }]);
    await expect(
      recordReviewDecision(
        tx,
        { tenantId: TENANT, source: "operator-cli" },
        { reviewId: REVIEW, decision: "accepted", reviewer: "owner" },
      ),
    ).rejects.toThrow("no decision");
  });
});
