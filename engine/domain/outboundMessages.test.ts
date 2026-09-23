// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TxClient } from "../db/types.ts";
import { CompanyOsError } from "./errors.ts";
import {
  markOutboundIndeterminate,
  requestOutboundSend,
} from "./outboundMessages.ts";

// Who an outbound act may name, with no database. What the owner services do
// with a send (eligibility at the request and before the call, at most one call)
// is proven against a real Postgres in whatsappOutbound.dbtest.ts.

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const REVIEW = "e0000000-0000-4000-8000-00000000000e";
const OUTBOUND = "c0000000-0000-4000-8000-00000000000c";
const PRINCIPAL_LABEL = "principal:a1000000-0000-4000-8000-0000000000a1";

const recordingDatabase = (result: unknown) => {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const tx: TxClient = {
    async query<TRow>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [{ result }] as TRow[] };
    },
  };
  return { tx, calls };
};

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CompanyOsError);
    return (error as CompanyOsError).code;
  }
  throw new Error("expected a CompanyOsError");
};

describe("the operator label of an outbound act", () => {
  it.each([PRINCIPAL_LABEL, PRINCIPAL_LABEL.toUpperCase(), "", " owner"])(
    "refuses %j as the operator asking for a send, before reaching the database",
    async (requestedBy) => {
      const { tx, calls } = recordingDatabase({});

      expect(
        await codeOf(
          requestOutboundSend(tx, {
            tenantId: TENANT,
            reviewId: REVIEW,
            requestedBy,
            source: "operator-cli",
          }),
        ),
      ).toBe("invalid_argument");
      expect(calls).toEqual([]);
    },
  );

  it.each([PRINCIPAL_LABEL, "Principal:owner", ""])(
    "refuses %j as the operator marking a send indeterminate, before reaching the database",
    async (actor) => {
      const { tx, calls } = recordingDatabase({});

      expect(
        await codeOf(markOutboundIndeterminate(tx, TENANT, OUTBOUND, actor)),
      ).toBe("invalid_argument");
      expect(calls).toEqual([]);
    },
  );

  it("records a person's own label verbatim, one that merely mentions principal: included", async () => {
    const requested = recordingDatabase({
      outbound_message_id: OUTBOUND,
      status: "authorized",
      created: true,
    });
    await requestOutboundSend(requested.tx, {
      tenantId: TENANT,
      reviewId: REVIEW,
      requestedBy: "owner (not a principal: label)",
      source: "operator-cli",
    });
    const marked = recordingDatabase({ state: "indeterminate" });
    await markOutboundIndeterminate(marked.tx, TENANT, OUTBOUND, "ops:on-call");

    expect(requested.calls[0]?.params).toEqual([
      TENANT,
      REVIEW,
      "owner (not a principal: label)",
      "operator-cli",
    ]);
    expect(marked.calls[0]?.params).toEqual([TENANT, OUTBOUND, "ops:on-call"]);
  });
});
