// The model router: route tier -> (provider, model), and the one place a
// structured model call is executed.
//
// WHAT IT REFUSES TO DO, each of which is a cost or trust decision that belongs
// to a person rather than to a code path:
//
//   * No default route. An unknown or unconfigured tier resolves to undefined
//     and the run is refused as configuration. A default would silently move a
//     "reasoning" workload onto whatever model happened to be configured.
//   * No fallback. A failing provider is not swapped for another one: that
//     would send tenant data to a vendor nobody chose for this route.
//   * No retry. Exactly one provider invocation per call. A retry of a call
//     that timed out may be a second paid call for a request the provider had
//     already processed; whether to try again is decided above this layer, from
//     a durable record, never here.
//
// A provider is not trusted to honour cancellation. The call is raced against
// the abort, and a provider that settles after the router has already given up
// is ignored, so a hung vendor SDK cannot hold a worker past its lease.

import { ModelError, toModelError } from "./errors.ts";
import { PROVIDER_ROUTE_PATTERN } from "./openRouterChat.ts";
import type { OutputContract } from "./outputContract.ts";
import {
  isModelId,
  isProviderIdentifier,
  isProviderName,
  MODEL_ROUTE_NAMES,
  normalizeLatencyMs,
  sanitizeUsage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelRouteName,
} from "./types.ts";

export interface ModelRoutePolicy {
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

/**
 * Fixed per tier, not configurable from environment: a token ceiling is a cost
 * ceiling, and the timeout decides the lease a worker must hold (main.ts refuses
 * a lease shorter than the longest configured timeout).
 */
export const MODEL_ROUTE_POLICIES: Readonly<
  Record<ModelRouteName, ModelRoutePolicy>
> = Object.freeze({
  economy: Object.freeze({ maxOutputTokens: 2000, timeoutMs: 20_000 }),
  standard: Object.freeze({ maxOutputTokens: 8000, timeoutMs: 45_000 }),
  reasoning: Object.freeze({ maxOutputTokens: 25_000, timeoutMs: 90_000 }),
});

export interface ResolvedModelRoute {
  readonly route: ModelRouteName;
  readonly provider: string;
  readonly model: string;
  readonly policy: ModelRoutePolicy;
  /** Served builds that count as `model` (ADR 0022 §B); gateway routes only. */
  readonly acceptedResponseModels?: readonly string[];
}

/** One authorized candidate, as the database lists it for a run (ADR 0022 §D). */
export interface RouteCandidateRef {
  readonly gateway: string;
  readonly model: string;
  readonly acceptedBuilds: readonly string[];
}

export interface StructuredModelResult<T> extends ModelResponse {
  readonly value: T;
}

export interface ModelRouter {
  /** Unknown or unconfigured route -> undefined. Never a default, never a fallback route. */
  resolve(route: string): ResolvedModelRoute | undefined;
  /**
   * The configured gateway's name, or null when this router has none. With a
   * gateway, routes come from the database's authorized candidates, never from
   * configuration (ADR 0022 §D).
   */
  readonly gatewayName: string | null;
  /**
   * A route for ONE authorized candidate on the configured gateway, or
   * undefined when the candidate is not on it or the tier is not configured.
   * The router executes only routes it resolved itself.
   */
  resolveCandidate(
    route: string,
    candidate: RouteCandidateRef,
  ): ResolvedModelRoute | undefined;
  /** Largest timeout among CONFIGURED routes, 0 when none. Used by main.ts to refuse a lease shorter than a call. */
  readonly maxConfiguredTimeoutMs: number;
  /**
   * Runs one call. Exactly one provider invocation, no retry of any kind.
   * Applies the route's timeout on top of `signal`: the route timeout ->
   * ModelError("timeout", {code:"deadline"}); `signal` -> ModelError("cancelled",
   * {code:"aborted"}). Then validates `content` with `contract.parse`; failure ->
   * ModelError("schema_validation") carrying usage/ids/model/latency.
   */
  executeStructured<T>(
    route: ResolvedModelRoute,
    prompt: { readonly instructions: string; readonly input: string },
    contract: OutputContract<T>,
    signal: AbortSignal,
  ): Promise<StructuredModelResult<T>>;
}

interface ConfiguredRoute {
  readonly resolved: ResolvedModelRoute;
  readonly provider: ModelProvider;
}

const isRouteName = (value: unknown): value is ModelRouteName =>
  typeof value === "string" &&
  (MODEL_ROUTE_NAMES as readonly string[]).includes(value);

/**
 * THE request a structured call sends, and the only place it is assembled.
 *
 * Exported because a caller that records a fingerprint of the call must
 * fingerprint these exact bytes. A second copy of this shape elsewhere would
 * drift the first time either changed (a new field, a different ceiling), and
 * the stored fingerprint would then name a request nobody sent. Fields are
 * PICKED from `prompt`, never spread: a wider object must not widen the request.
 */
export function buildModelRequest(
  route: ResolvedModelRoute,
  prompt: { readonly instructions: string; readonly input: string },
  contract: OutputContract<unknown>,
): ModelRequest {
  return Object.freeze({
    model: route.model,
    instructions: prompt.instructions,
    input: prompt.input,
    output: Object.freeze({
      name: contract.name,
      schema: contract.jsonSchema,
    }),
    maxOutputTokens: route.policy.maxOutputTokens,
    ...(route.acceptedResponseModels && route.acceptedResponseModels.length > 0
      ? { acceptedResponseModels: route.acceptedResponseModels }
      : {}),
  });
}

/**
 * The shape ops.complete_agent_run() stores in agent_runs.finish_reason. A value
 * outside it would be nulled there without a trace; here it becomes a visible
 * "unknown" instead.
 */
const FINISH_REASON_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * The provider's answer, re-shaped by what the ROUTER knows rather than trusted
 * field by field: the provider name is the configured one, and every
 * network-derived value is shape-checked again. A provider adapter already does
 * this; the router does not assume every future adapter will.
 *
 * A provider that resolves something other than a response, or a response with
 * no content at all, has broken its own contract after the request may have
 * left. Nothing proves what the model did, so it is "unknown" (indeterminate),
 * never a known failure. Content that is present but wrong is a known answer,
 * and the contract check below records it as schema_validation.
 */
const normalizeResponse = (
  resolved: ResolvedModelRoute,
  raw: unknown,
): ModelResponse => {
  if (typeof raw !== "object" || raw === null) {
    throw new ModelError("unknown", {
      code: "provider_contract",
      model: resolved.model,
    });
  }
  const response = raw as Partial<Record<keyof ModelResponse, unknown>>;
  const normalized: ModelResponse = {
    provider: resolved.provider,
    model: isModelId(response.model) ? response.model : resolved.model,
    content: response.content,
    finishReason:
      typeof response.finishReason === "string" &&
      FINISH_REASON_PATTERN.test(response.finishReason)
        ? response.finishReason
        : "unknown",
    usage: sanitizeUsage(response.usage),
    providerRequestId: isProviderIdentifier(response.providerRequestId)
      ? response.providerRequestId
      : null,
    providerResponseId: isProviderIdentifier(response.providerResponseId)
      ? response.providerResponseId
      : null,
    latencyMs: normalizeLatencyMs(response.latencyMs) ?? 0,
    providerRoute:
      typeof response.providerRoute === "string" &&
      PROVIDER_ROUTE_PATTERN.test(response.providerRoute)
        ? response.providerRoute
        : null,
    reportedCostMicros:
      typeof response.reportedCostMicros === "number" &&
      Number.isSafeInteger(response.reportedCostMicros) &&
      response.reportedCostMicros >= 0 &&
      response.reportedCostMicros <= 1_000_000_000
        ? response.reportedCostMicros
        : null,
  };
  if (normalized.content === undefined) {
    throw new ModelError("unknown", {
      code: "provider_contract",
      usage: normalized.usage,
      providerRequestId: normalized.providerRequestId,
      providerResponseId: normalized.providerResponseId,
      model: normalized.model,
      latencyMs: normalized.latencyMs,
    });
  }
  return normalized;
};

/**
 * One provider invocation, bounded by the route timeout and the caller's
 * signal, whichever comes first. The FIRST of {settlement, timeout, abort} wins
 * and everything after it is swallowed — including the provider's own
 * "cancelled" rejection when we abort it, so a deadline is reported as a
 * deadline rather than as the cancellation it caused.
 *
 * setTimeout rather than AbortSignal.timeout: the timer is cleared the moment
 * the call settles, so a finished call leaves nothing keeping the process alive.
 */
const invokeOnce = (
  provider: ModelProvider,
  request: ModelRequest,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const providerAbort = new AbortController();
    let settled = false;

    const finish = () => {
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onCallerAbort);
    };
    const giveUp = (error: ModelError) => {
      if (settled) return;
      finish();
      providerAbort.abort();
      reject(error);
    };
    const onCallerAbort = () =>
      giveUp(
        new ModelError("cancelled", { code: "aborted", model: request.model }),
      );
    const timer = setTimeout(
      () =>
        giveUp(
          new ModelError("timeout", { code: "deadline", model: request.model }),
        ),
      timeoutMs,
    );
    signal.addEventListener("abort", onCallerAbort, { once: true });

    let invocation: Promise<unknown>;
    try {
      invocation = Promise.resolve(
        provider.execute(request, providerAbort.signal),
      );
    } catch (error) {
      finish();
      reject(toModelError(error));
      return;
    }
    invocation.then(
      (value) => {
        if (settled) return;
        finish();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        finish();
        reject(toModelError(error));
      },
    );
  });

export function createModelRouter(options: {
  readonly routes: ReadonlyMap<
    ModelRouteName,
    { readonly provider: string; readonly model: string }
  >;
  readonly providers: ReadonlyMap<string, ModelProvider>;
  /**
   * ADR 0022: a gateway whose routes are the database's authorized candidates,
   * on these tiers only. Exclusive with static routes.
   */
  readonly gateway?: {
    readonly provider: ModelProvider;
    readonly tiers: readonly ModelRouteName[];
  };
}): ModelRouter {
  const configured = new Map<ModelRouteName, ConfiguredRoute>();
  const gateway = options.gateway ?? null;
  if (gateway) {
    if (options.routes.size > 0) {
      throw new Error("a router takes static routes or a gateway, never both");
    }
    if (!isProviderName(gateway.provider.name)) {
      throw new Error("the gateway does not carry a valid provider name");
    }
    if (gateway.tiers.length === 0 || !gateway.tiers.every(isRouteName)) {
      throw new Error(
        `gateway tiers must be one or more of ${MODEL_ROUTE_NAMES.join(", ")}`,
      );
    }
  }
  // The gateway routes this router resolved: executeStructured runs only these.
  const issued = new WeakSet<ResolvedModelRoute>();

  // Construction errors are boot errors. They name the ROUTE, which is one of
  // three fixed words, and never echo a provider name or model id: those come
  // from configuration, and configuration is where a pasted secret ends up.
  for (const [route, target] of options.routes) {
    if (!isRouteName(route)) {
      throw new Error(
        `model route must be one of ${MODEL_ROUTE_NAMES.join(", ")}`,
      );
    }
    const provider = options.providers.get(target.provider);
    if (!provider) {
      throw new Error(
        `model route "${route}" names a provider that is not registered`,
      );
    }
    // A registry key that disagrees with the provider's own name would make
    // every stored `provider` column a guess about which adapter really ran.
    if (!isProviderName(provider.name) || provider.name !== target.provider) {
      throw new Error(
        `the provider registered for model route "${route}" does not carry its registered name`,
      );
    }
    if (!isModelId(target.model)) {
      throw new Error(`the model id for model route "${route}" is malformed`);
    }
    configured.set(route, {
      provider,
      resolved: Object.freeze({
        route,
        provider: provider.name,
        model: target.model,
        policy: MODEL_ROUTE_POLICIES[route],
      }),
    });
  }

  const maxConfiguredTimeoutMs = Math.max(
    0,
    ...[...configured.values()].map(
      ({ resolved }) => resolved.policy.timeoutMs,
    ),
    ...(gateway?.tiers ?? []).map(
      (tier) => MODEL_ROUTE_POLICIES[tier].timeoutMs,
    ),
  );

  return Object.freeze({
    maxConfiguredTimeoutMs,

    gatewayName: gateway?.provider.name ?? null,

    resolve(route: string): ResolvedModelRoute | undefined {
      return isRouteName(route) ? configured.get(route)?.resolved : undefined;
    },

    resolveCandidate(
      route: string,
      candidate: RouteCandidateRef,
    ): ResolvedModelRoute | undefined {
      if (
        !gateway ||
        !isRouteName(route) ||
        !gateway.tiers.includes(route) ||
        candidate.gateway !== gateway.provider.name ||
        !isModelId(candidate.model) ||
        !candidate.acceptedBuilds.every(isModelId)
      ) {
        return undefined;
      }
      const resolved: ResolvedModelRoute = Object.freeze({
        route,
        provider: gateway.provider.name,
        model: candidate.model,
        policy: MODEL_ROUTE_POLICIES[route],
        acceptedResponseModels: Object.freeze([...candidate.acceptedBuilds]),
      });
      issued.add(resolved);
      return resolved;
    },

    async executeStructured<T>(
      route: ResolvedModelRoute,
      prompt: { readonly instructions: string; readonly input: string },
      contract: OutputContract<T>,
      signal: AbortSignal,
    ): Promise<StructuredModelResult<T>> {
      // The route must be one THIS router resolved. A hand-built route could
      // name a different model or carry a longer timeout; the policy used below
      // is always the configured one, never the caller's copy.
      const entry = isRouteName(route?.route)
        ? configured.get(route.route)
        : undefined;
      // A gateway route counts only if THIS router issued that exact object:
      // a hand-built route naming another model is refused like any other.
      const fromGateway = gateway !== null && issued.has(route);
      if (
        !fromGateway &&
        (!entry ||
          entry.resolved.provider !== route.provider ||
          entry.resolved.model !== route.model)
      ) {
        throw new ModelError("configuration", { code: "route_not_configured" });
      }
      const { resolved, provider } =
        fromGateway && gateway
          ? { resolved: route, provider: gateway.provider }
          : (entry as ConfiguredRoute);

      // Already cancelled: no request is issued at all, so nothing is billed.
      if (signal.aborted) {
        throw new ModelError("cancelled", {
          code: "aborted",
          model: resolved.model,
        });
      }

      // Built from the CONFIGURED route, never the caller's copy.
      const request = buildModelRequest(resolved, prompt, contract);

      const response = normalizeResponse(
        resolved,
        await invokeOnce(provider, request, resolved.policy.timeoutMs, signal),
      );

      let value: T;
      try {
        value = contract.parse(response.content);
      } catch (error) {
        // The call happened and was paid for; the answer is unusable. Everything
        // needed to account for it travels with the error.
        throw new ModelError("schema_validation", {
          code:
            error instanceof ModelError &&
            error.category === "schema_validation"
              ? error.code
              : "contract_mismatch",
          usage: response.usage,
          providerRequestId: response.providerRequestId,
          providerResponseId: response.providerResponseId,
          model: response.model,
          latencyMs: response.latencyMs,
        });
      }
      return Object.freeze({ ...response, value });
    },
  });
}
