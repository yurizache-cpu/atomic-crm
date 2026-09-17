// @vitest-environment node
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { parseWorkerDetail } from "../models/routeSummary.ts";
import { MODEL_ROUTE_POLICIES } from "../models/router.ts";
import { createModelRouterFromEnv } from "../models/routingConfig.ts";
import { TEST_API_KEY } from "../models/testSupport/openAiFakeFetch.ts";
import {
  assertLeaseFitsModelRoutes,
  LEASE_PREPARE_ALLOWANCE_MS,
  main,
  resolveWorkerId,
  workerStartDetail,
} from "./main.ts";
import { DEFAULT_LEASE_SAFETY_MARGIN_MS } from "./runOneJob.ts";

// The boot gates as pure functions, plus one run of main() itself with the
// database and the worker loop replaced, to prove what it hands the loop.

interface StartedWorker {
  readonly workerId: string;
  readonly startDetail?: string;
}

const boot = vi.hoisted(() => ({
  /** What main() handed the worker loop, one entry per start. */
  started: [] as StartedWorker[],
  closed: 0,
}));

vi.mock("./runWorker.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runWorker: async (options: StartedWorker) => {
    boot.started.push(options);
    return {};
  },
}));

vi.mock("../db/workerDatabase.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // No pool and no socket. The identity is the constrained one main() requires.
  createWorkerDatabase: () => ({
    withTransaction: async () => {
      throw new Error("main() runs no transaction of its own");
    },
    identity: async () => ({
      user: "ops_worker_login",
      isSuperuser: false,
      bypassesRls: false,
      isOpsWorkerMember: true,
    }),
    close: async () => {
      boot.closed += 1;
    },
  }),
}));

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

describe("the worker publishes its model routes at boot, and never its provider key", () => {
  it("starts with a detail naming each configured route's provider, model and ceilings, and never the key", () => {
    // Arrange: the production path, from an environment that holds a key.
    const fetch = vi.fn(async () => new Response("{}", { status: 500 }));
    const router = createModelRouterFromEnv(
      {
        AGENT_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: TEST_API_KEY,
        AGENT_MODEL_ECONOMY: "gpt-test-economy",
        AGENT_MODEL_STANDARD: "gpt-test-standard",
      },
      { fetch },
    );

    // Act
    const detail = workerStartDetail(router);

    // Assert
    expect(parseWorkerDetail(detail)).toEqual({
      state: "started",
      routes: [
        {
          route: "economy",
          provider: "openai",
          model: "gpt-test-economy",
          maxOutputTokens: MODEL_ROUTE_POLICIES.economy.maxOutputTokens,
          timeoutMs: MODEL_ROUTE_POLICIES.economy.timeoutMs,
        },
        {
          route: "standard",
          provider: "openai",
          model: "gpt-test-standard",
          maxOutputTokens: MODEL_ROUTE_POLICIES.standard.maxOutputTokens,
          timeoutMs: MODEL_ROUTE_POLICIES.standard.timeoutMs,
        },
      ],
    });
    expect(detail).not.toContain(TEST_API_KEY);
    expect(detail).not.toContain("sentinel0key");
    expect(inspect(detail)).not.toContain(TEST_API_KEY);
    // Building the detail asks the provider nothing.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("starts a worker with no model provider configured with an empty route list", () => {
    // Arrange
    const router = createModelRouterFromEnv({});

    // Act
    const detail = workerStartDetail(router);

    // Assert
    expect(parseWorkerDetail(detail)).toEqual({ state: "started", routes: [] });
  });

  it("hands the worker loop it starts a boot detail naming the configured route, and never the key its environment holds", async () => {
    // Arrange: the real entry point, over an environment holding a key.
    const fetch = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    const environment: Readonly<Record<string, string>> = {
      OPS_WORKER_DATABASE_URL: "unused-because-the-database-is-replaced",
      AGENT_MODEL_PROVIDER: "openai",
      OPENAI_API_KEY: TEST_API_KEY,
      AGENT_MODEL_ECONOMY: "",
      AGENT_MODEL_STANDARD: "gpt-test-standard",
      AGENT_MODEL_REASONING: "",
      OPS_WORKER_ID: "",
      OPS_WORKER_LEASE_SECONDS: "",
      OPS_WORKER_POOL_SIZE: "",
      OPS_WORKER_STATEMENT_TIMEOUT_MS: "",
      OPS_WORKER_POLL_INTERVAL_MS: "",
      OPS_WORKER_HEARTBEAT_INTERVAL_MS: "",
      OPS_WORKER_REAP_INTERVAL_MS: "",
    };
    for (const [name, value] of Object.entries(environment)) {
      vi.stubEnv(name, value);
    }
    const signals = ["SIGINT", "SIGTERM"] as const;
    const listenersBefore = signals.map((signal) => process.listeners(signal));
    boot.started.length = 0;
    boot.closed = 0;

    try {
      // Act
      await main();

      // Assert
      expect(boot.started).toHaveLength(1);
      const [{ startDetail }] = boot.started;
      expect(parseWorkerDetail(startDetail)).toEqual({
        state: "started",
        routes: [
          {
            route: "standard",
            provider: "openai",
            model: "gpt-test-standard",
            maxOutputTokens: MODEL_ROUTE_POLICIES.standard.maxOutputTokens,
            timeoutMs: MODEL_ROUTE_POLICIES.standard.timeoutMs,
          },
        ],
      });
      expect(startDetail).not.toContain(TEST_API_KEY);
      expect(startDetail).not.toContain("sentinel0key");
      expect(fetch).not.toHaveBeenCalled();
      expect(boot.closed).toBe(1);
    } finally {
      // main() installs its own shutdown handlers; this test removes them.
      signals.forEach((signal, index) => {
        for (const listener of process.listeners(signal)) {
          if (!listenersBefore[index].includes(listener)) {
            process.removeListener(signal, listener);
          }
        }
      });
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});
