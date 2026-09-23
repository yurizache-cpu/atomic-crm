// Synthetic company_os_api responses for the SHELL's browser tests (session
// lifecycle, surface switch, storage probes), each valid against its contract
// (the real adapter parses every one of them). They carry no activity: the
// screens' tests replay answers recorded from the real projections
// (recorded.ts). These stay hand-built because the shell tests need states one
// recorded tenant cannot hold: two users, two tenants, a membership that moves
// between them, and refusal sequences.

/** A deterministic synthetic uuid (version 4 layout, lower case). */
export const syntheticId = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export const AT = "2026-09-22T10:00:00.000000Z";

export const USER_A = { userId: syntheticId(1) };
export const USER_B = { userId: syntheticId(2) };
export const TENANT_A = syntheticId(101);
export const TENANT_B = syntheticId(102);

export const operatorContext = (tenantId: string, tenantName: string) => ({
  v: 1,
  asOf: AT,
  principal: { id: syntheticId(201) },
  tenant: { id: tenantId, name: tenantName },
  role: "tenant_operator",
  dataPolicy: "synthetic_or_test_only",
  allowedActions: { decideReview: false, tripStop: false, viewAdvice: true },
  serverTime: AT,
});

/** One active tenant-scoped stop whose reason is `reason`. */
export const stopList = (reason: string) => ({
  v: 1,
  asOf: AT,
  items: [
    {
      id: syntheticId(301),
      scope: "tenant",
      jobKind: null,
      origin: "owner",
      target: null,
      trippedAt: AT,
      reason,
      clearedAt: null,
      clearedReason: null,
    },
  ],
  nextCursor: null,
});

export const withheldAdvice = (reviewId: string) => ({
  v: 1,
  asOf: AT,
  reviewId,
  withheld: "origin_not_synthetic_or_test",
});
