// @vitest-environment node
import { describe, expect, it } from "vitest";
import { TEST_API_KEY } from "../models/testSupport/openAiFakeFetch.ts";
import { runStagingGatewayWorker } from "./stagingGatewayWorker.ts";

const run = (env: Record<string, string>) => {
  const err: string[] = [];
  let opened = false;
  return runStagingGatewayWorker({
    env,
    stdout: () => {},
    stderr: (line) => err.push(line),
    openDatabase: () => {
      opened = true;
      throw new Error("never opened in these cases");
    },
  }).then((code) => ({ code, err: err.join("\n"), opened }));
};

const BASE = {
  DEPLOYMENT_ENVIRONMENT: "staging",
  AGENT_MODEL_GATEWAY: "openrouter",
  OPENROUTER_API_KEY: TEST_API_KEY,
  OPS_WORKER_DATABASE_URL:
    "postgresql://ops_worker_login.x:pw@pooler.example.com:5432/postgres",
};

describe("the bounded staging gateway worker", () => {
  it.each([
    [{ ...BASE, DEPLOYMENT_ENVIRONMENT: "production" }, /staging|production/],
    [
      { ...BASE, AGENT_MODEL_GATEWAY: "" },
      /AGENT_MODEL_GATEWAY must be openrouter/,
    ],
    [{ ...BASE, STAGING_MAX_JOBS: "500" }, /STAGING_MAX_JOBS is 1 to 20/],
    [{ ...BASE, OPS_WORKER_DATABASE_URL: "" }, /OPS_WORKER_DATABASE_URL/],
    [{ ...BASE, OPENROUTER_API_KEY: "" }, /OPENROUTER_API_KEY is required/],
  ])("refuses before opening any connection: %j", async (env, message) => {
    const result = await run(env as Record<string, string>);
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(message);
    expect(result.err).not.toContain(TEST_API_KEY);
    expect(result.opened).toBe(false);
  });
});
