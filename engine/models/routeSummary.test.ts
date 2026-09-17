// @vitest-environment node
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createFakeModelProvider } from "./fakeModelProvider.ts";
import { createModelRouter, MODEL_ROUTE_POLICIES } from "./router.ts";
import {
  formatWorkerDetail,
  parseWorkerDetail,
  routePolicyMatches,
  summarizeRoutes,
  WORKER_DETAIL_MAX_LENGTH,
  WORKER_DETAIL_VERSION,
  type RouteSummaryEntry,
} from "./routeSummary.ts";
import { createModelRouterFromEnv } from "./routingConfig.ts";
import { TEST_API_KEY } from "./testSupport/openAiFakeFetch.ts";

const fakeRouter = (
  routes: readonly (readonly ["economy" | "standard" | "reasoning", string])[],
) => {
  const provider = createFakeModelProvider({ type: "respond", content: {} });
  return createModelRouter({
    routes: new Map(
      routes.map(([route, model]) => [
        route,
        { provider: provider.name, model },
      ]),
    ),
    providers: new Map([[provider.name, provider]]),
  });
};

const STANDARD: RouteSummaryEntry = {
  route: "standard",
  provider: "openai",
  model: "gpt-test-standard",
  maxOutputTokens: MODEL_ROUTE_POLICIES.standard.maxOutputTokens,
  timeoutMs: MODEL_ROUTE_POLICIES.standard.timeoutMs,
};

/** A detail string with one route entry, built by hand so it can be widened. */
const detailWith = (
  entry: unknown,
  top: Readonly<Record<string, unknown>> = {},
) =>
  JSON.stringify({
    version: WORKER_DETAIL_VERSION,
    state: "started",
    routes: [entry],
    ...top,
  });

describe("a worker publishes the routes it resolved, and an operator reads back exactly that", () => {
  it("summarises only the configured tiers, in tier order, with the policy each will send", () => {
    // Arrange
    const router = fakeRouter([
      ["reasoning", "fake-reasoning-1"],
      ["economy", "fake-economy-1"],
    ]);

    // Act
    const summary = summarizeRoutes(router);

    // Assert
    expect(summary).toEqual([
      {
        route: "economy",
        provider: "fake",
        model: "fake-economy-1",
        maxOutputTokens: MODEL_ROUTE_POLICIES.economy.maxOutputTokens,
        timeoutMs: MODEL_ROUTE_POLICIES.economy.timeoutMs,
      },
      {
        route: "reasoning",
        provider: "fake",
        model: "fake-reasoning-1",
        maxOutputTokens: MODEL_ROUTE_POLICIES.reasoning.maxOutputTokens,
        timeoutMs: MODEL_ROUTE_POLICIES.reasoning.timeoutMs,
      },
    ]);
  });

  it("round-trips a summary through the heartbeat detail unchanged", () => {
    // Arrange
    const summary = summarizeRoutes(
      fakeRouter([
        ["economy", "fake-economy-1"],
        ["standard", "fake-standard-1"],
        ["reasoning", "fake-reasoning-1"],
      ]),
    );

    // Act
    const parsed = parseWorkerDetail(formatWorkerDetail("started", summary));

    // Assert
    expect(parsed).toEqual({ state: "started", routes: summary });
  });

  it("round-trips a worker with no routes as an empty list, not as nothing", () => {
    // Arrange
    const summary = summarizeRoutes(fakeRouter([]));

    // Act
    const parsed = parseWorkerDetail(formatWorkerDetail("started", summary));

    // Assert
    expect(parsed).toEqual({ state: "started", routes: [] });
  });

  it("refuses to format a state that is not a short lowercase word", () => {
    for (const state of [
      "",
      "Started",
      "started now",
      "started;x",
      "a".repeat(33),
    ]) {
      expect(() => formatWorkerDetail(state, [STANDARD])).toThrow(
        /short lowercase word/,
      );
    }
  });

  it("refuses to format a detail longer than its bound", () => {
    // Arrange: model ids at their longest, repeated past the bound.
    const long: RouteSummaryEntry = { ...STANDARD, model: "m".repeat(120) };
    const entries = Array.from({ length: 12 }, () => long);

    // Act / Assert
    expect(() => formatWorkerDetail("started", entries)).toThrow(
      /longer than its bound/,
    );
  });
});

describe("the route summary never carries a provider key", () => {
  it("publishes provider, model and ceilings, and never the key, for a router built from an environment holding one", () => {
    // Arrange
    const fetch = vi.fn(async () => new Response("{}", { status: 500 }));
    const router = createModelRouterFromEnv(
      {
        AGENT_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: TEST_API_KEY,
        AGENT_MODEL_STANDARD: "gpt-test-standard",
        AGENT_MODEL_REASONING: "gpt-test-reasoning",
      },
      { fetch },
    );

    // Act
    const summary = summarizeRoutes(router);
    const detail = formatWorkerDetail("started", summary);

    // Assert
    expect(parseWorkerDetail(detail)?.routes).toEqual([
      STANDARD,
      {
        route: "reasoning",
        provider: "openai",
        model: "gpt-test-reasoning",
        maxOutputTokens: MODEL_ROUTE_POLICIES.reasoning.maxOutputTokens,
        timeoutMs: MODEL_ROUTE_POLICIES.reasoning.timeoutMs,
      },
    ]);
    for (const text of [detail, JSON.stringify(summary), inspect(summary)]) {
      expect(text).not.toContain(TEST_API_KEY);
      expect(text).not.toContain("sentinel0key");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("formats only the five summary fields of an entry, however wide the entry it is given", () => {
    // Arrange
    const widened = {
      ...STANDARD,
      apiKey: TEST_API_KEY,
    } as RouteSummaryEntry;

    // Act
    const detail = formatWorkerDetail("started", [widened]);

    // Assert
    expect(detail).not.toContain(TEST_API_KEY);
    expect(parseWorkerDetail(detail)?.routes).toEqual([STANDARD]);
  });
});

describe("a detail that is not exactly this version's shape is ignored, never shown", () => {
  it("reads an older worker's plain text, another version or a non-string as no summary", () => {
    for (const detail of [
      "started",
      "",
      null,
      undefined,
      42,
      "{not json",
      "[]",
      "null",
      detailWith(STANDARD, { version: "worker.detail.v2" }),
      detailWith(STANDARD, { version: undefined }),
    ]) {
      expect(parseWorkerDetail(detail)).toBeNull();
    }
  });

  it("refuses a widened detail object", () => {
    expect(
      parseWorkerDetail(detailWith(STANDARD, { key: TEST_API_KEY })),
    ).toBeNull();
  });

  it("refuses a detail whose state is not a short lowercase word", () => {
    for (const state of ["Started", "", 7, null]) {
      expect(parseWorkerDetail(detailWith(STANDARD, { state }))).toBeNull();
    }
  });

  it("refuses a widened or narrowed route entry", () => {
    const { timeoutMs: _dropped, ...narrowed } = STANDARD;
    for (const entry of [
      { ...STANDARD, apiKey: TEST_API_KEY },
      { ...STANDARD, baseUrl: "https://example.test" },
      narrowed,
    ]) {
      expect(parseWorkerDetail(detailWith(entry))).toBeNull();
    }
  });

  it("refuses a route entry whose values are not a tier, provider name, model id and positive whole numbers", () => {
    for (const entry of [
      { ...STANDARD, route: "premium" },
      { ...STANDARD, provider: "OpenAI" },
      { ...STANDARD, model: "gpt test" },
      { ...STANDARD, model: "" },
      { ...STANDARD, maxOutputTokens: 0 },
      { ...STANDARD, maxOutputTokens: 1.5 },
      { ...STANDARD, maxOutputTokens: "8000" },
      { ...STANDARD, timeoutMs: -1 },
      [STANDARD],
      null,
      "standard",
    ]) {
      expect(parseWorkerDetail(detailWith(entry))).toBeNull();
    }
  });

  it("refuses a detail longer than its bound, even when it is otherwise well formed", () => {
    // Arrange
    const long = { ...STANDARD, model: "m".repeat(120) };
    const within = JSON.stringify({
      version: WORKER_DETAIL_VERSION,
      state: "started",
      routes: Array.from({ length: 3 }, () => long),
    });
    const beyond = JSON.stringify({
      version: WORKER_DETAIL_VERSION,
      state: "started",
      routes: Array.from({ length: 12 }, () => long),
    });

    // Act / Assert
    expect(within.length).toBeLessThanOrEqual(WORKER_DETAIL_MAX_LENGTH);
    expect(beyond.length).toBeGreaterThan(WORKER_DETAIL_MAX_LENGTH);
    expect(parseWorkerDetail(within)?.routes).toHaveLength(3);
    expect(parseWorkerDetail(beyond)).toBeNull();
  });
});

describe("an operator can see a worker whose route policy differs from this build's", () => {
  it("matches a published route whose ceilings are this build's", () => {
    expect(routePolicyMatches(STANDARD)).toBe(true);
  });

  it("keeps a published route whose ceilings differ, and reports the skew", () => {
    // Arrange
    const skewed = [
      { ...STANDARD, maxOutputTokens: STANDARD.maxOutputTokens + 1 },
      { ...STANDARD, timeoutMs: STANDARD.timeoutMs - 1 },
    ];

    // Act
    const parsed = skewed.map((entry) => parseWorkerDetail(detailWith(entry)));

    // Assert
    parsed.forEach((detail, index) => {
      expect(detail?.routes).toEqual([skewed[index]]);
      expect(routePolicyMatches(detail!.routes[0])).toBe(false);
    });
  });
});
