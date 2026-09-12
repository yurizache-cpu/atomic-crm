// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { TxClient } from "../db/types.ts";
import { grantCapabilities, CAPABILITY_NAMES } from "./capabilities.ts";

const fakeTx = () => {
  const calls: { sql: string; params?: readonly unknown[] }[] = [];
  const tx: TxClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ purged: 7 }] } as never;
    },
  };
  return { tx, calls };
};

describe("a handler receives capabilities, not a database", () => {
  it("grants exactly what was declared", () => {
    const { tx } = fakeTx();
    const granted = grantCapabilities(tx, ["purgeInboundEmailLedger"]);
    expect(typeof granted.purgeInboundEmailLedger).toBe("function");
    expect(Object.keys(granted)).toEqual(["purgeInboundEmailLedger"]);
  });

  it("grants NOTHING when nothing was declared", () => {
    // The fail-closed default. A handler that declared no capabilities gets an
    // object with no methods, so reaching for one is a TypeError at the call
    // site rather than a privilege nobody reviewed.
    const { tx } = fakeTx();
    const granted = grantCapabilities(tx, []);
    expect(Object.keys(granted)).toEqual([]);
    expect(
      (granted as Record<string, unknown>).purgeInboundEmailLedger,
    ).toBeUndefined();
  });

  it("cannot be widened after it is built", () => {
    const { tx } = fakeTx();
    const granted = grantCapabilities(tx, []) as Record<string, unknown>;
    expect(Object.isFrozen(granted)).toBe(true);
    expect(() => {
      "use strict";
      granted.purgeInboundEmailLedger = () => Promise.resolve(0);
    }).toThrow();
  });

  it("refuses a capability name that does not exist", () => {
    const { tx } = fakeTx();
    expect(() => grantCapabilities(tx, ["deleteEverything" as never])).toThrow(
      /unknown capability/i,
    );
  });

  it("exposes no way to run arbitrary SQL", () => {
    const { tx } = fakeTx();
    const granted = grantCapabilities(tx, [
      "purgeInboundEmailLedger",
    ]) as Record<string, unknown>;
    // The transaction itself must not be reachable from the capability bag.
    for (const value of Object.values(granted)) {
      expect(value).not.toBe(tx);
    }
    expect(Object.values(granted)).not.toContain(tx.query);
  });
});

describe("the purge capability", () => {
  it("calls the ops function and passes NO tenant", async () => {
    // The property that matters: there is no tenant parameter to get wrong.
    // The database resolves it from the live lease.
    const { tx, calls } = fakeTx();
    const granted = grantCapabilities(tx, ["purgeInboundEmailLedger"]);
    const purged = await granted.purgeInboundEmailLedger({
      retentionDays: 120,
      limit: 10,
    });

    expect(purged).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("ops.purge_inbound_email_ledger");
    expect(calls[0].params).toEqual([120, 10]);
    expect(JSON.stringify(calls[0])).not.toMatch(/tenant/i);
  });

  it("passes nulls when nothing was specified, so the database picks", async () => {
    const { tx, calls } = fakeTx();
    const granted = grantCapabilities(tx, ["purgeInboundEmailLedger"]);
    await granted.purgeInboundEmailLedger();
    expect(calls[0].params).toEqual([null, null]);
  });

  it("is parameterised, never interpolated", async () => {
    const { tx, calls } = fakeTx();
    const granted = grantCapabilities(tx, ["purgeInboundEmailLedger"]);
    await granted.purgeInboundEmailLedger({ retentionDays: 45 });
    expect(calls[0].sql).not.toContain("45");
    expect(calls[0].sql).toContain("$1");
  });
});

describe("the capability list", () => {
  it("is small, and every entry is a deliberate decision", () => {
    // If this fails, a capability was added. That is fine — but it is a review
    // event, and this test is the prompt for it.
    expect([...CAPABILITY_NAMES]).toEqual(["purgeInboundEmailLedger"]);
  });
});

describe("noop guard", () => {
  it("does not call the database when only building the bag", () => {
    const query = vi.fn();
    grantCapabilities({ query } as unknown as TxClient, [
      "purgeInboundEmailLedger",
    ]);
    expect(query).not.toHaveBeenCalled();
  });
});
