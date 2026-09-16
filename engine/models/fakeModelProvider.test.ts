// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelError } from "./errors.ts";
import {
  createFakeModelProvider,
  FAKE_DEFAULT_USAGE,
  type FakeBehavior,
} from "./fakeModelProvider.ts";
import type { ModelRequest } from "./types.ts";

const request = (model = "fake-model-1"): ModelRequest => ({
  model,
  instructions: "Assess.",
  input: "A task.",
  output: { name: "task_assessment", schema: { type: "object" } },
  maxOutputTokens: 2000,
});

const signal = () => new AbortController().signal;

type Settlement = "resolved" | "rejected" | "pending";

const settlementWithin = async (
  promise: Promise<unknown>,
  ms: number,
): Promise<Settlement> =>
  Promise.race([
    promise.then(
      (): Settlement => "resolved",
      (): Settlement => "rejected",
    ),
    new Promise<Settlement>((resolve) =>
      setTimeout(() => resolve("pending"), ms),
    ),
  ]);

afterEach(() => {
  vi.useRealTimers();
});

describe("respond returns a scripted answer shaped like a real provider's", () => {
  it("fills in the documented defaults", async () => {
    const provider = createFakeModelProvider({
      type: "respond",
      content: { ok: true },
    });
    const response = await provider.execute(request(), signal());
    expect(response).toMatchObject({
      provider: "fake",
      model: "fake-model-1",
      content: { ok: true },
      finishReason: "completed",
      usage: FAKE_DEFAULT_USAGE,
      providerRequestId: "fake-req-1",
      providerResponseId: "fake-resp-1",
    });
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("honours a scripted model, explicit null usage and a custom name", async () => {
    const provider = createFakeModelProvider(
      { type: "respond", content: {}, usage: null, model: "reported-model" },
      { name: "second_fake" },
    );
    const response = await provider.execute(request(), signal());
    expect(response.provider).toBe("second_fake");
    expect(response.model).toBe("reported-model");
    expect(response.usage).toBeNull();
  });

  it("numbers ids by call, and measures latency with the injected clock", async () => {
    let clock = 0;
    const provider = createFakeModelProvider(
      { type: "respond", content: {} },
      { now: () => (clock += 7) },
    );
    await provider.execute(request(), signal());
    const second = await provider.execute(request(), signal());
    expect(second.providerRequestId).toBe("fake-req-2");
    expect(second.providerResponseId).toBe("fake-resp-2");
    expect(second.latencyMs).toBe(7);
  });

  it("does not validate content: malformed output is the contract's to catch", async () => {
    const provider = createFakeModelProvider({
      type: "respond",
      content: "not an object",
    });
    expect((await provider.execute(request(), signal())).content).toBe(
      "not an object",
    );
  });

  it("refuses a name that could not be registered", () => {
    expect(() =>
      createFakeModelProvider({ type: "hang" }, { name: "Not Valid" }),
    ).toThrow("malformed");
  });
});

describe("calls are recorded and observable while in flight", () => {
  it("records every request in order, as a snapshot", async () => {
    const provider = createFakeModelProvider({ type: "respond", content: {} });
    await provider.execute(request("first"), signal());
    const snapshot = provider.calls;
    await provider.execute(request("second"), signal());
    expect(snapshot.map((call) => call.model)).toEqual(["first"]);
    expect(provider.calls.map((call) => call.model)).toEqual([
      "first",
      "second",
    ]);
  });

  it("passes each request and its zero-based index to a script function", async () => {
    const seen: [string, number][] = [];
    const provider = createFakeModelProvider(
      (received, index): FakeBehavior => {
        seen.push([received.model, index]);
        return index === 0
          ? { type: "respond", content: {} }
          : { type: "fail", category: "rate_limit" };
      },
    );
    await provider.execute(request("a"), signal());
    await expect(
      provider.execute(request("b"), signal()),
    ).rejects.toMatchObject({
      category: "rate_limit",
    });
    expect(seen).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });

  it("resolves callStarted only once the Nth call has started", async () => {
    const provider = createFakeModelProvider({ type: "hang" });
    const secondStarted = provider.callStarted(2);
    const controller = new AbortController();
    const first = provider.execute(request(), controller.signal);
    expect(await settlementWithin(secondStarted, 20)).toBe("pending");
    const second = provider.execute(request(), controller.signal);
    expect(await settlementWithin(secondStarted, 20)).toBe("resolved");
    expect(await settlementWithin(provider.callStarted(1), 20)).toBe(
      "resolved",
    );
    controller.abort();
    await Promise.allSettled([first, second]);
  });
});

describe("failures are ModelErrors only", () => {
  it("rejects with the scripted category, code and usage", async () => {
    const provider = createFakeModelProvider({
      type: "fail",
      category: "authentication",
      code: "invalid_api_key",
      usage: FAKE_DEFAULT_USAGE,
    });
    const error = await provider
      .execute(request(), signal())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({
      category: "authentication",
      code: "invalid_api_key",
      usage: FAKE_DEFAULT_USAGE,
    });
  });

  it("turns a throwing script function into an unknown ModelError", async () => {
    const provider = createFakeModelProvider(() => {
      throw new Error("script defect");
    });
    const error = await provider
      .execute(request(), signal())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).category).toBe("unknown");
  });
});

describe("abort behaviour is scriptable", () => {
  it("hang rejects as cancelled once the signal aborts, and not before", async () => {
    const provider = createFakeModelProvider({ type: "hang" });
    const controller = new AbortController();
    const pending = provider.execute(request(), controller.signal);
    expect(await settlementWithin(pending, 20)).toBe("pending");
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      category: "cancelled",
      code: "aborted",
    });
  });

  it("ignore_abort never settles, even after an abort", async () => {
    const provider = createFakeModelProvider({ type: "ignore_abort" });
    const controller = new AbortController();
    const pending = provider.execute(request(), controller.signal);
    controller.abort();
    expect(await settlementWithin(pending, 30)).toBe("pending");
  });

  it("delay waits before behaving as scripted", async () => {
    vi.useFakeTimers();
    const provider = createFakeModelProvider({
      type: "delay",
      ms: 1000,
      then: { type: "respond", content: { late: true } },
    });
    let done = false;
    const pending = provider.execute(request(), signal()).then((response) => {
      done = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).content).toEqual({ late: true });
  });

  it("delay rejects as cancelled when aborted mid-wait", async () => {
    vi.useFakeTimers();
    const provider = createFakeModelProvider({
      type: "delay",
      ms: 1000,
      then: { type: "respond", content: {} },
    });
    const controller = new AbortController();
    const pending = provider.execute(request(), controller.signal);
    const outcome = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    expect(await outcome).toMatchObject({ category: "cancelled" });
  });
});
