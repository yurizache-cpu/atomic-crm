// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PermanentError } from "../worker/failures.ts";
import type { LeasedJob } from "../worker/job.ts";
import {
  CONTACT_IDENTIFIER_RETENTION_DUE_KIND,
  contactIdentifierRetentionDue,
} from "./contactIdentifierRetentionDue.ts";

// The phone identifier retention handler (ADR 0021 W5). Its whole effect is
// one capability call; supabase/tests/whatsapp_transport.sql section N proves
// that effect against the database. This file holds what the handler itself
// decides: its one capability, that a conversation whose clock moved is
// retried rather than finished, and that an answer outside the database's
// contract is never recorded as a status.

const job: LeasedJob = {
  id: "00000000-0000-4000-8000-000000000001",
  tenant_id: "00000000-0000-4000-8000-000000000002",
  kind: CONTACT_IDENTIFIER_RETENTION_DUE_KIND,
  // A payload is a reference, never authority: a forged id here reaches nothing.
  payload: {
    contact_identifier_retention_id: "not-a-real-id",
    tenant_id: "forged",
  },
  attempts: 1,
  max_attempts: 10,
};

describe("the phone identifier retention handler", () => {
  it("declares exactly the one capability that erases the leased conversation's number", () => {
    expect(contactIdentifierRetentionDue.kind).toBe(
      "contact.identifier_retention_due",
    );
    expect([...contactIdentifierRetentionDue.capabilities]).toEqual([
      "eraseDueContactIdentifier",
    ]);
    expect(contactIdentifierRetentionDue.shape).toBeUndefined();
  });

  it("records the database's answer as a status token, a deferral included, so no attempt is spent waiting", async () => {
    for (const answer of [
      "erased",
      "already_erased",
      "superseded",
      "deferred",
    ]) {
      let calls = 0;
      const detail = await contactIdentifierRetentionDue.run(job, {
        eraseDueContactIdentifier: async () => {
          calls += 1;
          return answer;
        },
      });
      expect(detail).toBe(`contact_identifier_retention=${answer}`);
      expect(calls).toBe(1);
    }
  });

  it("fails permanently, recording nothing of it, when the answer is outside the contract", async () => {
    const run = contactIdentifierRetentionDue.run(job, {
      eraseDueContactIdentifier: async () => "5511999990000",
    });
    await expect(run).rejects.toBeInstanceOf(PermanentError);
    await expect(run).rejects.toThrow(
      "ops.erase_due_contact_identifier answered outside its contract",
    );
    await expect(run).rejects.not.toThrow(/5511999990000/);
  });
});
