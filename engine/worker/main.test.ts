// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MODEL_ROUTE_POLICIES } from "../models/router.ts";
import {
  assertLeaseFitsModelRoutes,
  LEASE_PREPARE_ALLOWANCE_MS,
  resolveWorkerId,
} from "./main.ts";
import { DEFAULT_LEASE_SAFETY_MARGIN_MS } from "./runOneJob.ts";

// The boot gates as pure functions. main() itself needs a database and a
// process; what matters here is the arithmetic and what the refusal says.

const STANDARD_MS = MODEL_ROUTE_POLICIES.standard.timeoutMs;
const REASONING_MS = MODEL_ROUTE_POLICIES.reasoning.timeoutMs;

/** The runtime's own constants, never a copy of their values. */
const requiredSeconds = (timeoutMs: number) =>
  Math.ceil(
    (LEASE_PREPARE_ALLOWANCE_MS + timeoutMs + DEFAULT_LEASE_SAFETY_MARGIN_MS) /
      1000,
  );

describe("the worker refuses a lease too short for its longest model call", () => {
  it("refuses a lease one second short of the prepare allowance, route timeout and safety margin", () => {
    for (const timeoutMs of [STANDARD_MS, REASONING_MS]) {
      expect(() =>
        assertLeaseFitsModelRoutes(requiredSeconds(timeoutMs) - 1, timeoutMs),
      ).toThrow(/Refusing to start/);
    }
  });

  it("accepts a lease that exactly fits", () => {
    for (const timeoutMs of [STANDARD_MS, REASONING_MS]) {
      expect(() =>
        assertLeaseFitsModelRoutes(requiredSeconds(timeoutMs), timeoutMs),
      ).not.toThrow();
    }
  });

  it("refuses a lease that fits the route timeout alone", () => {
    // The margin is not optional slack: the settle transaction runs inside it,
    // after the deadline. Without it the lease, not the route, ends the call.
    expect(() =>
      assertLeaseFitsModelRoutes(Math.ceil(REASONING_MS / 1000), REASONING_MS),
    ).toThrow(/Refusing to start/);
  });

  it("starts with the default 60 second lease on the standard route, and refuses it for the reasoning route", () => {
    expect(() => assertLeaseFitsModelRoutes(60, STANDARD_MS)).not.toThrow();
    expect(() => assertLeaseFitsModelRoutes(60, REASONING_MS)).toThrow(
      /Refusing to start/,
    );
  });

  it("names the variable and the route timeout, and says what would fit", () => {
    const refusal = () => assertLeaseFitsModelRoutes(30, STANDARD_MS);
    expect(refusal).toThrow(/OPS_WORKER_LEASE_SECONDS/);
    expect(refusal).toThrow(`(${STANDARD_MS} ms)`);
    expect(refusal).toThrow(`at least ${requiredSeconds(STANDARD_MS)} seconds`);
  });

  it("does not echo the configured lease back", () => {
    // The lease is an environment value, and no environment value is repeated
    // in a boot message. 37 appears in none of the constants it cites.
    let message = "";
    try {
      assertLeaseFitsModelRoutes(37, STANDARD_MS);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Refusing to start/);
    expect(message).not.toMatch(/\b37\b/);
  });

  it("does not gate a worker with no model route configured, which makes no call", () => {
    expect(() => assertLeaseFitsModelRoutes(1, 0)).not.toThrow();
  });
});

describe("no two worker processes share a lease identity", () => {
  it("keeps a configured OPS_WORKER_ID as the name and makes it unique per process", () => {
    const first = resolveWorkerId("ops-worker-a", "host", 11, "aaaa1111");
    const second = resolveWorkerId("ops-worker-a", "host", 12, "bbbb2222");
    expect(first).toBe("ops-worker-a:aaaa1111");
    expect(second).toBe("ops-worker-a:bbbb2222");
    expect(first).not.toBe(second);
  });

  it("names an unconfigured worker by host and process", () => {
    expect(resolveWorkerId(undefined, "host", 11, "aaaa1111")).toBe(
      "host:11:aaaa1111",
    );
    expect(resolveWorkerId("", "host", 11, "aaaa1111")).toBe(
      "host:11:aaaa1111",
    );
  });
});
