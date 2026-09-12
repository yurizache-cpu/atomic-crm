// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { PurgeLedgerOptions } from "../worker/capabilities.ts";
import { PermanentError } from "../worker/failures.ts";
import type { LeasedJob } from "../worker/job.ts";
import {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_ROW_LIMIT,
  postmarkLedgerRetention,
} from "./postmarkLedgerRetention.ts";

const job = (payload: unknown): LeasedJob => ({
  id: "11111111-1111-1111-1111-111111111111",
  tenant_id: "aaaaaaaa-0000-0000-0000-000000000001",
  kind: postmarkLedgerRetention.kind,
  payload,
  attempts: 1,
  max_attempts: 5,
});

const capabilities = (purged = 4) => {
  // Typed with its parameter so `.mock.calls[0]` is a one-tuple: an
  // argument-less `vi.fn` makes every call record an empty tuple, and the
  // assertions below would then be checking nothing.
  const purgeInboundEmailLedger = vi.fn(
    async (_options?: PurgeLedgerOptions) => purged,
  );
  return { caps: { purgeInboundEmailLedger }, purgeInboundEmailLedger };
};

describe("the handler declares exactly one capability", () => {
  it("asks for the purge and nothing else", () => {
    expect([...postmarkLedgerRetention.capabilities]).toEqual([
      "purgeInboundEmailLedger",
    ]);
  });

  it("is registered under a namespaced kind", () => {
    expect(postmarkLedgerRetention.kind).toBe("postmark.ledger_retention");
  });
});

describe("defaults match the policy written in the ledger migration", () => {
  it("keeps 90 days when the payload says nothing", async () => {
    const { caps, purgeInboundEmailLedger } = capabilities();
    await postmarkLedgerRetention.run(job({}), caps);
    expect(purgeInboundEmailLedger).toHaveBeenCalledWith({
      retentionDays: DEFAULT_RETENTION_DAYS,
      limit: DEFAULT_ROW_LIMIT,
    });
  });

  it("treats a non-object payload as no payload", async () => {
    const { caps, purgeInboundEmailLedger } = capabilities();
    for (const payload of [null, "nope", 7, [1, 2, 3]]) {
      await postmarkLedgerRetention.run(job(payload), caps);
    }
    for (const call of purgeInboundEmailLedger.mock.calls) {
      expect(call[0]).toEqual({
        retentionDays: DEFAULT_RETENTION_DAYS,
        limit: DEFAULT_ROW_LIMIT,
      });
    }
  });
});

describe("the payload tunes the run, it does not command it", () => {
  it("passes a longer retention window through", async () => {
    const { caps, purgeInboundEmailLedger } = capabilities();
    await postmarkLedgerRetention.run(job({ retention_days: 365 }), caps);
    expect(purgeInboundEmailLedger).toHaveBeenCalledWith({
      retentionDays: 365,
      limit: DEFAULT_ROW_LIMIT,
    });
  });

  it("passes a SHORTER window through too, because the floor is the database's job", async () => {
    // Deliberately not clamped here. A guard in the handler would be a second
    // place to get it wrong, and the security boundary has to hold against a
    // handler that never ran this check at all.
    const { caps, purgeInboundEmailLedger } = capabilities();
    await postmarkLedgerRetention.run(job({ retention_days: 1 }), caps);
    expect(purgeInboundEmailLedger).toHaveBeenCalledWith({
      retentionDays: 1,
      limit: DEFAULT_ROW_LIMIT,
    });
  });

  it("rejects a nonsensical value permanently rather than retrying it", async () => {
    const { caps, purgeInboundEmailLedger } = capabilities();
    for (const bad of [-1, 0, 1.5, "90", true, {}]) {
      await expect(
        postmarkLedgerRetention.run(job({ retention_days: bad }), caps),
      ).rejects.toThrow(PermanentError);
    }
    expect(purgeInboundEmailLedger).not.toHaveBeenCalled();
  });

  it("treats an explicit null as 'not specified', like the database does", async () => {
    // JSON has no "absent" for a present key, so `null` is how a caller says
    // "use the policy default". The database applies the same rule with
    // coalesce, and disagreeing here would make the two layers differ.
    const { caps, purgeInboundEmailLedger } = capabilities();
    await postmarkLedgerRetention.run(job({ retention_days: null }), caps);
    expect(purgeInboundEmailLedger).toHaveBeenCalledWith({
      retentionDays: DEFAULT_RETENTION_DAYS,
      limit: DEFAULT_ROW_LIMIT,
    });
  });

  it("rejects a bad limit the same way", async () => {
    const { caps } = capabilities();
    await expect(
      postmarkLedgerRetention.run(job({ limit: -5 }), caps),
    ).rejects.toThrow(PermanentError);
  });

  it("ignores a payload field that tries to name a tenant", async () => {
    // There is nowhere for it to go. The handler has no tenant parameter and
    // the capability takes none.
    const { caps, purgeInboundEmailLedger } = capabilities();
    await postmarkLedgerRetention.run(
      job({ tenant_id: "bbbbbbbb-0000-0000-0000-000000000002" }),
      caps,
    );
    const [args] = purgeInboundEmailLedger.mock.calls[0];
    expect(JSON.stringify(args)).not.toMatch(/tenant/i);
  });
});

describe("what it reports", () => {
  it("returns counts and parameters only", async () => {
    const { caps } = capabilities(12);
    const detail = await postmarkLedgerRetention.run(
      job({ retention_days: 120, limit: 50 }),
      caps,
    );
    expect(detail).toBe("purged=12 retention_days=120 limit=50");
  });

  it("reports a run that removed nothing", async () => {
    // The second run of an already-converged purge. Not an error.
    const { caps } = capabilities(0);
    const detail = await postmarkLedgerRetention.run(job({}), caps);
    expect(detail).toContain("purged=0");
  });

  it("never reports row content", async () => {
    const { caps } = capabilities(3);
    const detail = await postmarkLedgerRetention.run(
      job({ retention_days: 90 }),
      caps,
    );
    expect(detail).not.toMatch(/@/);
    expect(detail).toMatch(/^purged=\d+ retention_days=\d+ limit=\d+$/);
  });
});
