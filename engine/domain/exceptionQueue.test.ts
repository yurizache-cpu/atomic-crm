// The exception queue's owner boundary refuses before the database (ADR 0025):
// a person records only `resolved` or `dismissed`; released and reconciled are
// the database's. The database's own behaviour is exceptionQueue.dbtest.ts.

import { describe, expect, it } from "vitest";
import type { TxClient } from "../db/types.ts";
import { CompanyOsError } from "./errors.ts";
import { resolveException } from "./exceptionQueue.ts";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const EXCEPTION = "00000000-0000-4000-8000-0000000000e1";

const untouched = (): { tx: TxClient; queried: () => boolean } => {
  let queried = false;
  const tx = {
    query: async () => {
      queried = true;
      throw new Error("not reached");
    },
  } as unknown as TxClient;
  return { tx, queried: () => queried };
};

describe("resolving an exception", () => {
  it("refuses a resolution only the database records, and asks it nothing", async () => {
    for (const resolution of ["released", "reconciled", "closed", ""]) {
      const { tx, queried } = untouched();
      await expect(
        resolveException(tx, {
          tenantId: TENANT,
          exceptionId: EXCEPTION,
          resolution,
          actor: "owner",
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      expect(queried()).toBe(false);
    }
  });

  it("refuses a malformed id or actor before the database", async () => {
    const { tx, queried } = untouched();
    await expect(
      resolveException(tx, {
        tenantId: TENANT,
        exceptionId: "not-a-uuid",
        resolution: "dismissed",
        actor: "owner",
      }),
    ).rejects.toBeInstanceOf(CompanyOsError);
    await expect(
      resolveException(tx, {
        tenantId: TENANT,
        exceptionId: EXCEPTION,
        resolution: "dismissed",
        actor: "two words",
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(queried()).toBe(false);
  });
});
