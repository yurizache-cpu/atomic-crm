// @vitest-environment node
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  agentRunStatusForCategory,
  MODEL_ERROR_CATEGORIES,
  ModelError,
  toModelError,
  type ModelErrorCategory,
} from "./errors.ts";

const printed = (error: unknown): string =>
  [
    error instanceof Error ? error.message : "",
    error instanceof Error ? String(error.stack) : "",
    JSON.stringify(error) ?? "",
    inspect(error, { depth: 10, showHidden: true }),
  ].join("\n");

describe("the category list is closed and ordered", () => {
  it("lists the eleven categories in the documented order, frozen", () => {
    expect([...MODEL_ERROR_CATEGORIES]).toEqual([
      "configuration",
      "authentication",
      "rate_limit",
      "timeout",
      "transport",
      "provider_5xx",
      "invalid_request",
      "invalid_response",
      "schema_validation",
      "cancelled",
      "unknown",
    ]);
    expect(Object.isFrozen(MODEL_ERROR_CATEGORIES)).toBe(true);
  });
});

describe("a run's recorded status follows whether the end of the call is known", () => {
  // This table is what ops.agent_run_error_status() must mirror. A category
  // moved from indeterminate to failed invites a re-issue of a paid call that
  // may already have been processed.
  const FAILED: readonly ModelErrorCategory[] = [
    "configuration",
    "authentication",
    "rate_limit",
    "invalid_request",
    "provider_5xx",
    "invalid_response",
    "schema_validation",
  ];
  const INDETERMINATE: readonly ModelErrorCategory[] = [
    "timeout",
    "transport",
    "cancelled",
    "unknown",
  ];

  it("records a call that was answered or provably refused as failed", () => {
    for (const category of FAILED) {
      expect(agentRunStatusForCategory(category)).toBe("failed");
    }
  });

  it("records a call that may have been processed unseen as indeterminate", () => {
    for (const category of INDETERMINATE) {
      expect(agentRunStatusForCategory(category)).toBe("indeterminate");
    }
  });

  it("partitions every category into exactly one of the two", () => {
    expect([...FAILED, ...INDETERMINATE].sort()).toEqual(
      [...MODEL_ERROR_CATEGORIES].sort(),
    );
  });

  it("treats a category from outside the type as indeterminate", () => {
    expect(
      agentRunStatusForCategory("made_up" as unknown as ModelErrorCategory),
    ).toBe("indeterminate");
    expect(
      agentRunStatusForCategory("toString" as unknown as ModelErrorCategory),
    ).toBe("indeterminate");
  });
});

describe("the message is fixed text, never provider content", () => {
  it("is the category's fixed text alone, even when a provider reported a code", () => {
    const error = new ModelError("authentication", { code: "invalid_api_key" });
    expect(error.message).toBe("model provider refused the credentials");
    expect(error.code).toBe("invalid_api_key");
    expect(new ModelError("timeout").message).toBe("model call timed out");
  });

  it("drops a code that is not a short lowercase identifier", () => {
    const secretLooking = "sk-" + "Proj-UPPERCASE-looking-key";
    for (const code of [
      "Invalid API Key",
      "has space",
      "a".repeat(101),
      "",
      "-leading-dash",
      secretLooking,
      'quote"inside',
      42 as unknown as string,
    ]) {
      const error = new ModelError("invalid_request", { code });
      expect(error.code).toBeNull();
      expect(error.message).toBe("model provider rejected the request");
    }
    expect(
      printed(new ModelError("unknown", { code: secretLooking })),
    ).not.toContain(secretLooking);
  });

  it("keeps a code at the length limit", () => {
    const code = `a${"b".repeat(99)}`;
    expect(new ModelError("unknown", { code }).code).toBe(code);
  });

  it("is an Error named ModelError", () => {
    const error = new ModelError("rate_limit");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ModelError");
    expect(error.category).toBe("rate_limit");
  });

  it("coerces a category from outside the type to unknown", () => {
    const error = new ModelError("nonsense" as unknown as ModelErrorCategory);
    expect(error.category).toBe("unknown");
    expect(error.message).toBe("model call failed for an unclassified reason");
  });
});

describe("structured details are kept only when storable", () => {
  it("keeps well-formed usage, ids, model and latency", () => {
    const error = new ModelError("schema_validation", {
      code: "contract_mismatch",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cachedInputTokens: 0,
        reasoningTokens: null,
      },
      providerRequestId: "req_abc-123:x.y",
      providerResponseId: "resp_0123",
      model: "gpt-test/2026-01:preview",
      latencyMs: 412,
    });
    expect(error.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedInputTokens: 0,
      reasoningTokens: null,
    });
    expect(error.providerRequestId).toBe("req_abc-123:x.y");
    expect(error.providerResponseId).toBe("resp_0123");
    expect(error.model).toBe("gpt-test/2026-01:preview");
    expect(error.latencyMs).toBe(412);
  });

  it("drops ids, model and latency that do not have the expected shape", () => {
    for (const bad of [
      "has space",
      "x".repeat(201),
      'quo"te',
      "",
      "line\nbreak",
    ]) {
      const error = new ModelError("unknown", {
        providerRequestId: bad,
        providerResponseId: bad,
        model: bad,
      });
      expect(error.providerRequestId).toBeNull();
      expect(error.providerResponseId).toBeNull();
      expect(error.model).toBeNull();
    }
    for (const latencyMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(new ModelError("unknown", { latencyMs }).latencyMs).toBeNull();
    }
  });

  it("drops token counts that are not non-negative integers, and freezes the copy", () => {
    const usage = {
      inputTokens: -1,
      outputTokens: 1.5,
      totalTokens: Number.NaN,
      cachedInputTokens: "3" as unknown as number,
      reasoningTokens: 7,
    };
    const error = new ModelError("invalid_response", { usage });
    expect(error.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cachedInputTokens: null,
      reasoningTokens: 7,
    });
    expect(Object.isFrozen(error.usage)).toBe(true);
    usage.reasoningTokens = 9;
    expect(error.usage?.reasoningTokens).toBe(7);
  });

  it("keeps numbers only in the range an integer column accepts", () => {
    // Postgres refuses 2147483648 and 12.5 as integer input, failing the whole
    // statement rather than nulling the one field.
    const error = new ModelError("schema_validation", {
      usage: {
        inputTokens: 2_147_483_648,
        outputTokens: 2_147_483_647,
        totalTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
      latencyMs: 12.4,
    });
    expect(error.usage?.inputTokens).toBeNull();
    expect(error.usage?.outputTokens).toBe(2_147_483_647);
    expect(error.latencyMs).toBe(12);
    expect(
      new ModelError("unknown", { latencyMs: 2_147_483_648 }).latencyMs,
    ).toBeNull();
  });

  it("defaults every detail to null", () => {
    const error = new ModelError("transport");
    expect([
      error.code,
      error.usage,
      error.providerRequestId,
      error.providerResponseId,
      error.model,
      error.latencyMs,
    ]).toEqual([null, null, null, null, null, null]);
  });
});

describe("toModelError", () => {
  it("passes a ModelError through as the same instance", () => {
    const original = new ModelError("rate_limit", {
      code: "insufficient_quota",
    });
    expect(toModelError(original)).toBe(original);
  });

  it("turns anything else into unknown without carrying its text, code or cause", () => {
    const secret = "sk-" + "secret-inside-a-thrown-error";
    for (const thrown of [
      new Error(secret),
      Object.assign(new Error(secret), { code: "invalid_api_key" }),
      new Error("wrapper", { cause: new Error(secret) }),
      secret,
      { message: secret },
      null,
      undefined,
    ]) {
      const error = toModelError(thrown);
      expect(error).toBeInstanceOf(ModelError);
      expect(error.category).toBe("unknown");
      expect(error.code).toBeNull();
      expect(printed(error)).not.toContain(secret);
    }
  });
});
