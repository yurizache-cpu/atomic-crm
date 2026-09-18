// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSyntheticContactPolicy } from "./syntheticContactPolicy.ts";

// The Phase 2A consent source: trusted configuration, failing closed. Whether
// an admission records what it answers is leadIntake.test.ts; whether the
// database then refuses to accept a blocked lead's draft is the SQL and
// driver-backed suites.

describe("the synthetic contact policy", () => {
  it("lets a contact listed as eligible be contacted", () => {
    const policy = createSyntheticContactPolicy({ eligible: ["synthetic:a"] });
    expect(policy.doNotContact("synthetic:a")).toBe(false);
  });

  it("blocks a contact listed as blocked", () => {
    const policy = createSyntheticContactPolicy({ blocked: ["synthetic:a"] });
    expect(policy.doNotContact("synthetic:a")).toBe(true);
  });

  it("lets blocked win when a contact is listed as both", () => {
    const policy = createSyntheticContactPolicy({
      eligible: ["synthetic:a"],
      blocked: ["synthetic:a"],
    });
    expect(policy.doNotContact("synthetic:a")).toBe(true);
  });

  it("blocks every contact it has never heard of", () => {
    const policy = createSyntheticContactPolicy({ eligible: ["synthetic:a"] });
    expect(policy.doNotContact("synthetic:b")).toBe(true);
    expect(createSyntheticContactPolicy({}).doNotContact("synthetic:a")).toBe(
      true,
    );
  });

  it("does not match on a near miss", () => {
    const policy = createSyntheticContactPolicy({ eligible: ["synthetic:a"] });
    for (const ref of ["synthetic:A", "synthetic:a ", "synthetic:", "a"]) {
      expect(policy.doNotContact(ref)).toBe(true);
    }
  });

  it("is not changed by mutating the lists it was built from", () => {
    const eligible = ["synthetic:a"];
    const blocked: string[] = [];
    const policy = createSyntheticContactPolicy({ eligible, blocked });

    eligible.push("synthetic:b");
    blocked.push("synthetic:a");

    expect(policy.doNotContact("synthetic:a")).toBe(false);
    expect(policy.doNotContact("synthetic:b")).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
  });
});
