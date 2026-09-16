// The production model router, built from environment.
//
// Pure: it reads only the `env` object it is handed (main.ts passes
// process.env), so a test can prove what a given environment produces without
// touching the real one, and nothing in engine/models reads process.env at all.
//
// THE CHOICES IT MAKES, and why each fails closed:
//
//   * AGENT_MODEL_PROVIDER unset or empty -> a router with NO routes. The
//     worker still starts and every agent run is refused as `configuration`.
//     No model access is a legitimate deployment; a guessed provider is not.
//   * "openai" -> the OpenAI Responses adapter. Anything else, INCLUDING
//     "fake", throws at boot. The scripted provider is test-only; an
//     environment variable must not be able to replace real answers with
//     canned ones.
//   * A tier with no model id is simply unconfigured, and resolves to
//     undefined. There is no default model per tier: which model serves
//     "reasoning" is a cost decision made in deployment, not in code.
//
// Error messages name the VARIABLE and never its value. The value of a
// misconfigured variable is exactly where a pasted key ends up, and boot errors
// are printed to a terminal and shipped to logs.

import {
  createOpenAiResponsesProvider,
  OPENAI_PROVIDER_NAME,
} from "./openaiResponses.ts";
import { createModelRouter, type ModelRouter } from "./router.ts";
import { isModelId, type ModelRouteName } from "./types.ts";

export interface ModelRoutingEnv {
  readonly [name: string]: string | undefined;
}

const TIER_VARIABLES: readonly (readonly [ModelRouteName, string])[] =
  Object.freeze([
    ["economy", "AGENT_MODEL_ECONOMY"],
    ["standard", "AGENT_MODEL_STANDARD"],
    ["reasoning", "AGENT_MODEL_REASONING"],
  ]);

/** Builds the production router from environment. Pure: reads only `env`. Never logs, never returns the key. */
export function createModelRouterFromEnv(
  env: ModelRoutingEnv,
  dependencies: { readonly fetch?: typeof fetch } = {},
): ModelRouter {
  const providerName = env.AGENT_MODEL_PROVIDER;
  if (providerName === undefined || providerName === "") {
    return createModelRouter({ routes: new Map(), providers: new Map() });
  }
  if (providerName !== OPENAI_PROVIDER_NAME) {
    throw new Error(
      'AGENT_MODEL_PROVIDER must be unset, empty or "openai". The fake provider is test-only and cannot be selected from environment.',
    );
  }

  const apiKey = env.OPENAI_API_KEY;
  if (typeof apiKey !== "string" || apiKey === "" || /\s/.test(apiKey)) {
    throw new Error(
      "OPENAI_API_KEY is required when AGENT_MODEL_PROVIDER is openai, and must not contain whitespace.",
    );
  }

  const routes = new Map<
    ModelRouteName,
    { readonly provider: string; readonly model: string }
  >();
  for (const [route, variable] of TIER_VARIABLES) {
    const model = env[variable];
    if (model === undefined || model === "") continue;
    // A model id is sent in every request body and stored with every run. The
    // two extra checks catch the one mistake that turns that into a key leak:
    // the key pasted into the wrong variable. No model id starts with "sk-".
    if (
      !isModelId(model) ||
      model.startsWith("sk-") ||
      model.includes(apiKey)
    ) {
      throw new Error(`${variable} is not a valid model id.`);
    }
    routes.set(route, { provider: OPENAI_PROVIDER_NAME, model });
  }
  if (routes.size === 0) {
    throw new Error(
      `At least one of ${TIER_VARIABLES.map(([, variable]) => variable).join(", ")} is required when AGENT_MODEL_PROVIDER is openai.`,
    );
  }

  const provider = createOpenAiResponsesProvider({
    apiKey,
    fetch: dependencies.fetch,
  });
  return createModelRouter({
    routes,
    providers: new Map([[provider.name, provider]]),
  });
}
