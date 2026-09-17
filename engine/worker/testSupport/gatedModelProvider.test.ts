import { describe, expect, it } from "vitest";
import { ModelError } from "../../models/errors.ts";
import type { ModelRequest } from "../../models/types.ts";
import { createGatedModelProvider } from "./gatedModelProvider.ts";

const REQUEST: ModelRequest = Object.freeze({
  model: "fake-model-1",
  instructions: "Assess the task.",
  input: "{}",
  output: Object.freeze({ name: "task_assessment", schema: {} }),
  maxOutputTokens: 8000,
});

const ANSWER = Object.freeze({ outcome: "completed" });

/** Resolves to "settled" if `promise` settles before the current macrotask queue drains. */
const settledSoon = async (promise: Promise<unknown>): Promise<string> =>
  Promise.race([
    promise.then(
      () => "settled",
      () => "settled",
    ),
    new Promise<string>((resolve) => setImmediate(() => resolve("pending"))),
  ]);

describe("the gated model provider", () => {
  it("counts a call when it starts, holds it until the gate opens, then answers with the scripted response", async () => {
    const provider = createGatedModelProvider({
      type: "respond",
      content: ANSWER,
    });

    const call = provider.execute(REQUEST, new AbortController().signal);

    expect(provider.started).toBe(1);
    expect(provider.inFlight).toBe(1);
    expect(provider.requests).toEqual([REQUEST]);
    expect(await settledSoon(call)).toBe("pending");
    provider.open();
    const response = await call;
    expect(response.content).toEqual(ANSWER);
    expect(provider.inFlight).toBe(0);
  });

  it("rejects a call waiting at the gate as cancelled as soon as its signal aborts", async () => {
    const provider = createGatedModelProvider({
      type: "respond",
      content: ANSWER,
    });
    const controller = new AbortController();

    const call = provider.execute(REQUEST, controller.signal);
    controller.abort();

    const error = await call.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ category: "cancelled", code: "aborted" });
    expect(provider.inFlight).toBe(0);
  });

  it("delegates the scripted failure once the gate is open", async () => {
    const provider = createGatedModelProvider({
      type: "fail",
      category: "provider_5xx",
    });
    provider.open();

    await expect(
      provider.execute(REQUEST, new AbortController().signal),
    ).rejects.toMatchObject({ category: "provider_5xx" });
  });

  it("resolves callStarted once the nth call has started, and remembers the most calls ever in flight", async () => {
    const provider = createGatedModelProvider({
      type: "respond",
      content: ANSWER,
    });
    const secondStarted = provider.callStarted(2);
    const signal = new AbortController().signal;

    const first = provider.execute(REQUEST, signal);
    expect(await settledSoon(secondStarted)).toBe("pending");
    const second = provider.execute(REQUEST, signal);
    await secondStarted;
    expect(provider.maxInFlight).toBe(2);
    provider.open();
    await Promise.all([first, second]);
    await provider.execute(REQUEST, signal);

    expect(provider.started).toBe(3);
    expect(provider.inFlight).toBe(0);
    expect(provider.maxInFlight).toBe(2);
  });
});
