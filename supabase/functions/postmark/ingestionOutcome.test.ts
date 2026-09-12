// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  MAX_DELIVERY_ATTEMPTS,
  classifyFailureStatus,
  collectRecipientResults,
  decideReplay,
  escalateUnrecordedFailure,
  foldOutcomes,
  httpStatusForOutcome,
  isStalePending,
  isUsableIdempotencyKey,
  ledgerStatusForOutcome,
  STALE_PENDING_MS,
  SYNTHETIC_KEY_PREFIX,
  type RecipientOutcome,
  type RecipientResult,
} from "./ingestionOutcome";

// Before this file existed, the Postmark webhook returned 200 on every
// ingestion failure: `addNoteToContact` signals failure by RETURNING a
// Response, the handler discarded it, and Postmark never retried. The first
// replacement was rejected because it introduced its own fail-open — a
// recipient whose ingestion was transient had its outcome discarded by an
// early `return` inside the recipients loop — and because the fix had no test
// coverage at all (docs/PHASE_0_5_REPORT.md §2.4).
//
// Everything in this file runs today, with no database.

describe("foldOutcomes — delivery outcome from per-recipient outcomes", () => {
  it("returns ingested, and therefore 200, when every recipient was ingested", () => {
    // Arrange
    const outcomes: RecipientOutcome[] = ["ingested", "ingested", "ingested"];

    // Act
    const folded = foldOutcomes(outcomes);

    // Assert
    expect(folded).toBe("ingested");
    expect(httpStatusForOutcome(folded)).toBe(200);
  });

  it("returns transient, and therefore 500, when any recipient was transient", () => {
    const outcomes: RecipientOutcome[] = ["ingested", "transient", "ingested"];

    const folded = foldOutcomes(outcomes);

    expect(folded).toBe("transient");
    expect(httpStatusForOutcome(folded)).toBe(500);
  });

  it("returns permanent, and therefore 200, when every recipient failed permanently", () => {
    // 200 is not a bug here: retrying a permanently invalid message can never
    // succeed, and a non-2xx would make Postmark retry it on a schedule
    // forever. The durable ledger row is what stops this being a silent drop.
    const outcomes: RecipientOutcome[] = ["permanent", "permanent"];

    const folded = foldOutcomes(outcomes);

    expect(folded).toBe("permanent");
    expect(httpStatusForOutcome(folded)).toBe(200);
  });

  it("treats a redelivery of an already-ingested message as a success", () => {
    expect(foldOutcomes(["duplicate", "duplicate"])).toBe("duplicate");
    expect(httpStatusForOutcome(foldOutcomes(["duplicate"]))).toBe(200);
  });

  it("reports success when some recipients landed and the rest are unrecoverable", () => {
    // The permanent ones have their own ledger rows; redelivering could not
    // fix them and would re-run the recipients that already worked.
    expect(foldOutcomes(["ingested", "permanent"])).toBe("ingested");
    expect(foldOutcomes(["duplicate", "permanent"])).toBe("duplicate");
  });

  it("never reports success for a delivery with no recipient outcomes", () => {
    // An empty fold means nothing was ingested. Calling that "ingested" is the
    // fail-open shape this module exists to prevent.
    expect(foldOutcomes([])).toBe("permanent");
    expect(foldOutcomes([])).not.toBe("ingested");
  });
});

describe("foldOutcomes — REGRESSION: a transient recipient is never dropped", () => {
  // This is the bug that got the previous implementation rejected. Every case
  // below fails against any fold where a later recipient can overwrite an
  // earlier recipient's outcome.
  it.each([
    [["transient", "ingested"]],
    [["transient", "permanent"]],
    [["transient", "duplicate"]],
    [["ingested", "transient"]],
    [["permanent", "transient"]],
    [["duplicate", "transient"]],
    [["transient", "ingested", "permanent", "duplicate"]],
    [["ingested", "permanent", "duplicate", "transient"]],
  ])("keeps %j at transient -> 500", (outcomes) => {
    const folded = foldOutcomes(outcomes as RecipientOutcome[]);

    expect(folded).toBe("transient");
    expect(httpStatusForOutcome(folded)).toBe(500);
  });

  it("is order-independent: one transient anywhere among successes still retries", () => {
    const others: RecipientOutcome[] = ["ingested", "duplicate", "permanent"];

    for (let position = 0; position <= others.length; position++) {
      const outcomes: RecipientOutcome[] = [
        ...others.slice(0, position),
        "transient",
        ...others.slice(position),
      ];

      expect(foldOutcomes(outcomes), `transient at index ${position}`).toBe(
        "transient",
      );
    }
  });
});

describe("collectRecipientResults — every recipient is visited and kept", () => {
  it("keeps a transient result produced before a later recipient succeeds", async () => {
    // The rejected implementation returned from inside this loop. Here a
    // `return` can only end `ingest`, so the first recipient's transient
    // outcome survives into the fold.
    const ingest = vi.fn(
      async (email: string): Promise<RecipientResult> => ({
        email,
        outcome: email === "first@example.com" ? "transient" : "ingested",
      }),
    );

    const results = await collectRecipientResults(
      ["first@example.com", "second@example.com"],
      ingest,
      (email, error) => ({
        email,
        outcome: "transient",
        detail: String(error),
      }),
    );

    expect(ingest).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.outcome)).toEqual([
      "transient",
      "ingested",
    ]);
    expect(foldOutcomes(results.map((result) => result.outcome))).toBe(
      "transient",
    );
  });

  it("turns a thrown error into a transient result without abandoning the remaining recipients", async () => {
    const results = await collectRecipientResults(
      ["boom@example.com", "fine@example.com"],
      async (email) => {
        if (email === "boom@example.com") throw new Error("connection reset");
        return { email, outcome: "ingested" };
      },
      (email, error) => ({
        email,
        outcome: "transient",
        detail: `unhandled error: ${(error as Error).message}`,
      }),
    );

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      email: "boom@example.com",
      outcome: "transient",
      detail: "unhandled error: connection reset",
    });
    expect(results[1].outcome).toBe("ingested");
    expect(
      httpStatusForOutcome(foldOutcomes(results.map((r) => r.outcome))),
    ).toBe(500);
  });

  it("returns one result per recipient, in order", async () => {
    const results = await collectRecipientResults(
      ["a@example.com", "b@example.com", "c@example.com"],
      async (email) => ({ email, outcome: "ingested" }),
      (email) => ({ email, outcome: "transient" }),
    );

    expect(results.map((result) => result.email)).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
  });
});

describe("classifyFailureStatus — every known ingestion failure", () => {
  // The four failures addNoteToContact can signal, plus the unknown case.
  it.each([
    ["sales lookup failed", 500, "transient"],
    ["sender has no active sales row", 403, "permanent"],
    ["contact or company creation failed", 500, "transient"],
    ["note insert failed", 500, "transient"],
  ])("%s (HTTP %i) is %s", (_label, status, expected) => {
    expect(classifyFailureStatus(status as number)).toBe(expected);
  });

  it("treats an unrecognised status as transient, never as permanently lost", () => {
    // Fail towards redelivery: a durable record is written either way, so the
    // cost of being wrong here is extra deliveries, not a dropped email.
    for (const status of [0, 418, 502, 504]) {
      expect(classifyFailureStatus(status)).toBe("transient");
    }
  });

  it("maps each class onto the ledger status that records it", () => {
    expect(ledgerStatusForOutcome("ingested")).toBe("ingested");
    expect(ledgerStatusForOutcome("permanent")).toBe("failed_permanent");
    expect(ledgerStatusForOutcome("transient")).toBe("failed_transient");
  });
});

describe("escalateUnrecordedFailure — a failure we could not write down", () => {
  it("escalates an unrecorded permanent failure to transient so it is delivered again", () => {
    expect(escalateUnrecordedFailure("permanent", false)).toBe("transient");
  });

  it("leaves a recorded permanent failure permanent", () => {
    expect(escalateUnrecordedFailure("permanent", true)).toBe("permanent");
  });

  it("leaves every other outcome untouched", () => {
    expect(escalateUnrecordedFailure("ingested", false)).toBe("ingested");
    expect(escalateUnrecordedFailure("duplicate", false)).toBe("duplicate");
    expect(escalateUnrecordedFailure("transient", false)).toBe("transient");
  });
});

describe("decideReplay — a delivery whose claim hit the unique index", () => {
  it("skips the work for a message already ingested", () => {
    expect(decideReplay({ status: "ingested", attempts: 2 })).toBe(
      "skip-ingested",
    );
  });

  it("skips the work for a message already recorded as permanently failed", () => {
    expect(decideReplay({ status: "failed_permanent", attempts: 2 })).toBe(
      "skip-failed-permanent",
    );
  });

  it("replays the work for a transient failure, which is the only replay path there is", () => {
    expect(decideReplay({ status: "failed_transient", attempts: 2 })).toBe(
      "retry-work",
    );
  });

  it("waits, rather than claiming success, while an earlier delivery is pending", () => {
    expect(decideReplay({ status: "pending", attempts: 2 })).toBe(
      "wait-for-in-flight",
    );
  });

  it("gives up once the attempt cap is reached, so retries cannot run forever", () => {
    expect(
      decideReplay({
        status: "failed_transient",
        attempts: MAX_DELIVERY_ATTEMPTS,
      }),
    ).toBe("give-up");
    expect(decideReplay({ status: "pending", attempts: 3 }, 3)).toBe("give-up");
  });

  it("keeps terminal states terminal even past the cap", () => {
    expect(decideReplay({ status: "ingested", attempts: 999 })).toBe(
      "skip-ingested",
    );
    expect(decideReplay({ status: "failed_permanent", attempts: 999 })).toBe(
      "skip-failed-permanent",
    );
  });

  it("never treats an unrecognised stored status as success", () => {
    expect(decideReplay({ status: "something_new", attempts: 1 })).toBe(
      "wait-for-in-flight",
    );
  });
});

// ---------------------------------------------------------------------------
// Added after adversarial review. Both blocks pin a fail-open the reviewer
// found in the first cut of this change; neither was caught by the 34 tests
// above, which is why they are here rather than in a follow-up.
// ---------------------------------------------------------------------------

describe("isUsableIdempotencyKey — a synthetic key must never reach the work", () => {
  // The synthetic key is unique per DELIVERY. If one reached the ingest path,
  // every Postmark redelivery would claim a fresh row and create another note,
  // which is exactly the duplication the ledger exists to prevent.
  it("rejects a synthetic key", () => {
    expect(
      isUsableIdempotencyKey(
        `${SYNTHETIC_KEY_PREFIX}b9f1c2d3-0000-4000-8000-000000000000`,
      ),
    ).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["a number", 42],
    ["an object", { id: "x" }],
    ["an array", ["x"]],
  ])("rejects %s", (_label, value) => {
    expect(isUsableIdempotencyKey(value)).toBe(false);
  });

  it("accepts a real Postmark MessageID", () => {
    expect(isUsableIdempotencyKey("73e6d360-66eb-11e1-8e72-a8904824019b")).toBe(
      true,
    );
  });
});

describe("decideReplay — a pending row must not stay stuck forever", () => {
  const NOW = Date.parse("2026-09-11T12:00:00.000Z");
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  it("waits while an earlier delivery may still be running", () => {
    expect(
      decideReplay(
        { status: "pending", attempts: 2, received_at: at(1000) },
        10,
        NOW,
      ),
    ).toBe("wait-for-in-flight");
  });

  it("replays a pending claim whose request died", () => {
    // Without this, a claim written by a request that then crashed blocks every
    // redelivery until the attempt cap writes the message off as
    // failed_permanent — a message that was never ingested at all.
    expect(
      decideReplay(
        {
          status: "pending",
          attempts: 2,
          received_at: at(STALE_PENDING_MS + 1),
        },
        10,
        NOW,
      ),
    ).toBe("retry-work");
  });

  it("waits rather than replays when the timestamp is unreadable", () => {
    // Re-running work risks a duplicate note; waiting risks only reaching the
    // cap, which still leaves the raw payload for a manual replay.
    for (const received_at of [undefined, null, "", "not-a-date"]) {
      expect(
        decideReplay({ status: "pending", attempts: 2, received_at }, 10, NOW),
      ).toBe("wait-for-in-flight");
    }
  });

  it("still caps a stale pending row rather than replaying forever", () => {
    expect(
      decideReplay(
        {
          status: "pending",
          attempts: 10,
          received_at: at(STALE_PENDING_MS * 100),
        },
        10,
        NOW,
      ),
    ).toBe("give-up");
  });
});

describe("isStalePending", () => {
  const NOW = Date.parse("2026-09-11T12:00:00.000Z");

  it("is false one millisecond before the boundary", () => {
    expect(
      isStalePending(new Date(NOW - STALE_PENDING_MS + 1).toISOString(), NOW),
    ).toBe(false);
  });

  it("is true exactly at the boundary", () => {
    expect(
      isStalePending(new Date(NOW - STALE_PENDING_MS).toISOString(), NOW),
    ).toBe(true);
  });

  it("is false for a clock skew that puts the claim in the future", () => {
    expect(isStalePending(new Date(NOW + 60_000).toISOString(), NOW)).toBe(
      false,
    );
  });
});
