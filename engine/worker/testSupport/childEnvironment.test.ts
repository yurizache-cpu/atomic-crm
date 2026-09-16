// What a spawned test process inherits. A provider key or a model route that
// leaked into a test worker would put a real provider one change away from
// synthetic data, so the inherited copy must drop them and keep the rest.

import { describe, expect, it } from "vitest";
import {
  isModelConfigurationVariable,
  testChildEnvironment,
} from "./childEnvironment.ts";

// Key-shaped values are assembled, so no key-shaped literal sits in the source.
const FAKE_OPENAI_KEY = ["sk", "dbtest", "child", "env", "0001"].join("-");
const FAKE_ANTHROPIC_KEY = ["sk", "ant", "dbtest", "child", "env"].join("-");

describe("the environment a driver-backed suite spawns a process with", () => {
  it("drops provider keys and every model routing variable, and keeps everything else", () => {
    const inherited = {
      PATH: "/usr/bin",
      OPS_WORKER_DATABASE_URL: "postgresql://127.0.0.1:54342/postgres",
      OPENAI_API_KEY: FAKE_OPENAI_KEY,
      ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
      AGENT_MODEL_PROVIDER: "openai",
      AGENT_MODEL_STANDARD: "gpt-dbtest-1",
      AGENT_MODEL_TIMEOUT_MS: "30000",
      OPENAI_API_KEY_HINT: "kept: not a key variable",
    };

    const env = testChildEnvironment(inherited);

    expect(env).toEqual({
      PATH: "/usr/bin",
      OPS_WORKER_DATABASE_URL: "postgresql://127.0.0.1:54342/postgres",
      OPENAI_API_KEY_HINT: "kept: not a key variable",
    });
    expect(Object.values(env)).not.toContain(FAKE_OPENAI_KEY);
    expect(inherited.OPENAI_API_KEY).toBe(FAKE_OPENAI_KEY);
  });

  it("matches the names ignoring case, as win32 does", () => {
    expect(isModelConfigurationVariable("openai_api_key")).toBe(true);
    expect(isModelConfigurationVariable("Anthropic_Api_Key")).toBe(true);
    expect(isModelConfigurationVariable("agent_model_reasoning")).toBe(true);
    expect(isModelConfigurationVariable("MY_AGENT_MODEL_NOTE")).toBe(false);
  });

  it("applies what a case passes explicitly after dropping the inherited variables", () => {
    const env = testChildEnvironment(
      { OPS_WORKER_ID: "inherited", AGENT_MODEL_PROVIDER: "openai" },
      { OPS_WORKER_ID: "dbtest-child", FAKE_MODEL_BEHAVIOR: "respond" },
    );

    expect(env).toEqual({
      OPS_WORKER_ID: "dbtest-child",
      FAKE_MODEL_BEHAVIOR: "respond",
    });
  });
});
