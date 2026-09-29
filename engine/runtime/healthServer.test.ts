import { afterEach, describe, expect, it } from "vitest";

import { healthStaleAfterMs } from "../worker/main.ts";
import { createPollHealth, startHealthServer } from "./healthServer.ts";

// Production Hosting (SI-77): the deployed worker's health endpoint, over a real
// socket. It answers a status and nothing else.

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

const serve = async (isHealthy: () => boolean) => {
  const server = await startHealthServer({
    host: "127.0.0.1",
    port: 0,
    isHealthy,
  });
  closers.push(server.close);
  return `http://127.0.0.1:${server.port}`;
};

describe("the health endpoint", () => {
  it("answers 200 ok while healthy and 503 unavailable otherwise, with no other content", async () => {
    let healthy = true;
    const base = await serve(() => healthy);
    const ok = await fetch(`${base}/healthz`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("ok");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    healthy = false;
    const down = await fetch(`${base}/healthz`);
    expect(down.status).toBe(503);
    expect(await down.text()).toBe("unavailable");
  });

  it("is unhealthy, not broken, when the health question itself throws", async () => {
    const base = await serve(() => {
      throw new Error("synthetic");
    });
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
  });

  it("serves nothing but that one path, by GET or HEAD", async () => {
    const base = await serve(() => true);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
    expect((await fetch(`${base}/healthz`, { method: "POST" })).status).toBe(
      405,
    );
    const head = await fetch(`${base}/healthz`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});

describe("health from the worker loop", () => {
  it("is unhealthy until a poll reaches the database, then healthy while recent", () => {
    let clock = 1_000;
    const health = createPollHealth(60_000, () => clock);
    expect(health.isHealthy()).toBe(false);
    health.onPoll("failed");
    expect(health.isHealthy()).toBe(false);
    health.onPoll("ok");
    expect(health.isHealthy()).toBe(true);
    clock += 60_000;
    expect(health.isHealthy()).toBe(true);
    // Failures do not refresh it: a database that stays down goes unhealthy.
    health.onPoll("failed");
    clock += 1;
    expect(health.isHealthy()).toBe(false);
  });

  it("waits out a whole model call: twice the lease, never under a minute", () => {
    expect(healthStaleAfterMs(10)).toBe(60_000);
    expect(healthStaleAfterMs(60)).toBe(120_000);
    expect(healthStaleAfterMs(300)).toBe(600_000);
  });
});
