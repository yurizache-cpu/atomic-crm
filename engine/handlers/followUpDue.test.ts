// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PermanentError } from "../worker/failures.ts";
import type { LeasedJob } from "../worker/job.ts";
import { FOLLOW_UP_DUE_KIND, followUpDue } from "./followUpDue.ts";

// The follow-up due handler (Phase 3A.1). Its whole effect is one capability
// call; engine/domain/followUpEngine.dbtest.ts proves that effect against the
// database. This file holds what the handler itself decides: which capability
// it may use, what it records, and that an answer outside the database's
// contract is never recorded as a status.

const job: LeasedJob = {
  id: "00000000-0000-4000-8000-000000000001",
  tenant_id: "00000000-0000-4000-8000-000000000002",
  kind: FOLLOW_UP_DUE_KIND,
  // A payload is a reference, never authority: a forged id here reaches nothing.
  payload: { follow_up_id: "not-a-real-id", tenant_id: "forged" },
  attempts: 1,
  max_attempts: 5,
};

describe("the follow-up due handler", () => {
  it("declares exactly the one capability that marks the leased follow-up due", () => {
    expect(followUpDue.kind).toBe("follow_up.due");
    expect([...followUpDue.capabilities]).toEqual(["markFollowUpDue"]);
    expect(followUpDue.shape).toBeUndefined();
  });

  it("records the database's answer as a status token, for a first run and for every replay", async () => {
    for (const answer of [
      "due",
      "already_due",
      "completed",
      "cancelled",
      "superseded",
    ]) {
      let calls = 0;
      const detail = await followUpDue.run(job, {
        markFollowUpDue: async () => {
          calls += 1;
          return answer;
        },
      });
      expect(detail).toBe(`follow_up=${answer}`);
      expect(calls).toBe(1);
    }
  });

  it("fails permanently, recording nothing of it, when the answer is outside the contract", async () => {
    const run = followUpDue.run(job, {
      markFollowUpDue: async () => "sent to lead@example.test",
    });
    await expect(run).rejects.toBeInstanceOf(PermanentError);
    await expect(
      followUpDue.run(job, { markFollowUpDue: async () => "x" }),
    ).rejects.toThrow("ops.mark_follow_up_due answered outside its contract");
  });
});
