import { describe, expect, it } from "vitest";

import {
  OperationalHealthSchema,
  OverviewSummarySchema,
  type OperationalHealth,
} from "../../contracts/company-os-api/index.ts";
import { CONTRACT_SAMPLES } from "./testSupport/companyOsContractSamples.ts";

// The overview's operational health contract (Phase 2E.2): strict, exact and
// content-free. A percentile exists only from its minimum sample, the per-kind
// queue adds up to its totals, no window holds more spend than the last 7
// days, and nothing outside the declared keys is accepted.

const overview = CONTRACT_SAMPLES.overview[0] as {
  operationalHealth: OperationalHealth;
};
const health = overview.operationalHealth;

const withHealth = (patch: (copy: OperationalHealth) => void) => {
  const copy = structuredClone(health) as OperationalHealth;
  patch(copy);
  return copy;
};

describe("the operational health contract", () => {
  it("accepts the projection's shape inside the overview", () => {
    expect(OverviewSummarySchema.safeParse(overview).success).toBe(true);
    expect(OperationalHealthSchema.safeParse(health).success).toBe(true);
  });

  it("refuses a percentile reported below its minimum sample, and one missing above it", () => {
    for (const latency of [
      { sampleSize: 2, p50Ms: 400, p95Ms: null },
      { sampleSize: 19, p50Ms: 400, p95Ms: 900 },
      { sampleSize: 25, p50Ms: 400, p95Ms: null },
      { sampleSize: 25, p50Ms: 900, p95Ms: 400 },
    ]) {
      const broken = withHealth((copy) => {
        Object.assign(copy.agentRuns.latency, latency);
      });
      expect(OperationalHealthSchema.safeParse(broken).success).toBe(false);
    }
  });

  it("refuses per-kind queue rows that do not add up to the totals", () => {
    const broken = withHealth((copy) => {
      copy.queue.ready += 1;
    });
    expect(OperationalHealthSchema.safeParse(broken).success).toBe(false);
  });

  it("refuses a shorter spend window holding more than the last 7 days", () => {
    const broken = withHealth((copy) => {
      copy.spend.chargedToday = { micros: "9000", usd: "0.009000" };
    });
    expect(OperationalHealthSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts no identifier, text or extra key anywhere", () => {
    const uuid = "0b8f3a3e-5c1a-4d2e-9f6b-2a7c1d9e4f10";
    for (const broken of [
      withHealth((copy) => {
        copy.queueByKind[0] = { ...copy.queueByKind[0], kind: uuid };
      }),
      withHealth((copy) => {
        Object.assign(copy.queue, { lastError: "SENTINEL connection refused" });
      }),
      withHealth((copy) => {
        Object.assign(copy, { score: 83 });
      }),
      withHealth((copy) => {
        Object.assign(copy.agentRuns.inWindowByStatus, { [uuid]: 1 });
      }),
    ]) {
      expect(OperationalHealthSchema.safeParse(broken).success).toBe(false);
    }
  });
});
