// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PermanentError, TransientError } from "../worker/failures.ts";
import type { LeasedJob } from "../worker/job.ts";
import {
  CONTENT_RETENTION_DUE_KIND,
  contentRetentionDue,
} from "./contentRetentionDue.ts";

// The retention handler (BASELINE Q8 D6/D7). Its whole effect is one
// capability call; engine/domain/contentRetention.dbtest.ts proves that effect
// against the database. This file holds what the handler itself decides: its
// one capability, that a flow not yet redactable is retried rather than
// finished, and that an answer outside the database's contract is never
// recorded as a status.

const job: LeasedJob = {
  id: "00000000-0000-4000-8000-000000000001",
  tenant_id: "00000000-0000-4000-8000-000000000002",
  kind: CONTENT_RETENTION_DUE_KIND,
  // A payload is a reference, never authority: a forged id here reaches nothing.
  payload: { content_retention_id: "not-a-real-id", tenant_id: "forged" },
  attempts: 1,
  max_attempts: 10,
};

describe("the content retention handler", () => {
  it("declares exactly the one capability that redacts the leased flow", () => {
    expect(contentRetentionDue.kind).toBe("content.retention_due");
    expect([...contentRetentionDue.capabilities]).toEqual(["redactDueContent"]);
    expect(contentRetentionDue.shape).toBeUndefined();
  });

  it("records the database's final answer as a status token", async () => {
    for (const answer of ["redacted", "already_redacted", "superseded"]) {
      let calls = 0;
      const detail = await contentRetentionDue.run(job, {
        redactDueContent: async () => {
          calls += 1;
          return answer;
        },
      });
      expect(detail).toBe(`content_retention=${answer}`);
      expect(calls).toBe(1);
    }
  });

  it("retries a flow still in progress or not yet due, instead of finishing the job", async () => {
    for (const answer of ["in_progress", "not_due"]) {
      await expect(
        contentRetentionDue.run(job, { redactDueContent: async () => answer }),
      ).rejects.toBeInstanceOf(TransientError);
    }
  });

  it("fails permanently, recording nothing of it, when the answer is outside the contract", async () => {
    const run = contentRetentionDue.run(job, {
      redactDueContent: async () => "SENTINEL patient text",
    });
    await expect(run).rejects.toBeInstanceOf(PermanentError);
    await expect(run).rejects.toThrow(
      "ops.redact_due_content answered outside its contract",
    );
  });
});
