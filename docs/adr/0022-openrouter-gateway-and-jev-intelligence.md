# ADR 0022 — OpenRouter as the model gateway, Jev as the structured decision layer, model pools filtered by Q8

**Status:** Accepted by owner directive (2026-10-02, the "OpenRouter + Jev + multi-model Company OS" milestone brief). Implemented on `feature/openrouter-jev-intelligence`. **PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

| Record | State |
|---|---|
| DIRECT OPENAI/LUNA PRIMARY ARCHITECTURE | **SUPERSEDED** (the OpenAI Responses adapter stays as an alternative adapter; ADR 0016 is not withdrawn) |
| OPENROUTER MULTI-MODEL GATEWAY | **SELECTED** |
| JEV BUSINESS DECISION LAYER | **SELECTED**, shadow first |
| JEV ROUTING | **SHADOW-FIRST** |

**Relates to:**
- [ADR 0016](0016-agent-runs-and-model-providers.md): the run lifecycle, outcome taxonomy and at-most-once call, all unchanged.
- [ADR 0017](0017-runtime-governance.md): prices, spend limits and the kill switch, extended with an agent ceiling.
- [ADR 0020](0020-real-data-model-authorization.md): Q8, which stays the authority and gains model pools.
- 2D.1 / 2D.2 shadow decisions (`ops.decision_evaluations`): the pattern reused here, and the Jev boundary they reserved.

## Context

What existed before this record:
- **One provider for every tier.** The worker turned `AGENT_MODEL_PROVIDER=openai` and one model id per tier (economy, standard, reasoning) into routes.
- **The database knew a capability's tier, never its candidates.** Q8, the price and the spend check ran on the one `(provider, model)` pair the worker announced.
- **The Jev boundary called nothing.** No contract existed (2D.1).
- **Agents had a free-text `role` and nothing else.** No objective, capabilities, budget or model requirement.

Facts verified on 2026-10-02, from OpenRouter's live catalog and documentation:
- **OpenRouter serves Jev, TypeSafe's structured decision model.**
  - It answers on `POST /api/alpha/decisions`. The endpoint is an alpha, outside `/api/v1`.
  - The model is `typesafe/jev-1.13` (alias `~typesafe/jev-latest`, build `typesafe/jev-1.13-20260917`).
  - Pricing is US$0.042 per million input tokens; output is free.
  - Questions are `choice`, `noul` (a probability that a condition holds) or `score` (an ordered level). Answers carry probabilities, a confidence and `usage.cost`.
  - The model has documented limits: literal reading, no arithmetic, counting or dates, uncalibrated scores between levels, and susceptibility to adversarial state. It also has no published retention statement for this surface.
- **OpenRouter also offers the hosted `typesafe/jev-router`.** It picks a model and a reasoning effort on chat completions, and its include list goes in `plugins[{id:"jev-router", models:[…]}]`.
  - **Its documentation says that an include list that matches nothing is ignored (`list_fallback: "models_ignored"`) and the full pool is used.** The include list is therefore not a hard boundary.
- **Chat completions take a `provider` object.** `allow_fallbacks: false` with `only`/`order` forbids another provider; `data_collection: "deny"` and `zdr: true` restrict the endpoints.

## A. Principle: an agent is not a model

An agent is defined by data:
- **its identity in the organisation:** department, role and objective;
- **what it does:** capabilities, tools (none yet), the data it may access, and its workflow;
- **how it is held:** escalation and review policy, and a daily cost ceiling;
- **what it needs from a model:** the model pool for each capability.

The model is chosen per run. Nothing anywhere records `Receptionist = <model>`.

The pipeline:

```
event / message / task
  -> deterministic policy (tenant, identity, data class, capability, permissions, Q8, stops,
     do_not_contact, spend, retention, environment, allowlists)        [authority]
  -> Jev business decision (intent, department, capability, complexity,
     human escalation)                                                 [shadow first]
  -> Company OS routing -> agent + capability
  -> model requirements -> the capability's MODEL POOL
  -> Q8 / policy filter -> AUTHORIZED CANDIDATES                       [authority, in the database]
  -> model router (deterministic) + Jev routing advice                 [advice shadow first]
  -> ModelGateway (OpenRouter) -> exactly one model, no fallback
  -> structured result -> review -> outcome
  -> cost, latency, routing decision and audit
```

## B. The gateway: provider-neutral inside, OpenRouter outside

- **The interface.** The existing `ModelProvider` interface (`engine/models/types.ts`) is the internal `ModelGateway` contract. No OpenRouter request or response shape crosses it.
- **The adapter.** `engine/models/openRouterChat.ts` (provider name `openrouter`) calls `POST https://openrouter.ai/api/v1/chat/completions` with a closed request shape:
  - **Message shape:** the system and user messages; strict `json_schema` output; `max_tokens`.
  - **No fallback:** `provider: {allow_fallbacks: false, require_parameters: true, data_collection: "deny"}`. There is no `models` fallback list, no `route`, no tools and no plugins.
  - **What it reports:** the served model and the upstream provider (the "provider route"), plus usage including OpenRouter's reported cost.
  - **A substitution is refused.** A served model that differs from the requested exact id is never accepted as the result; it is recorded `invalid_response` / `model_substituted`.
- **The error taxonomy is ADR 0016's.** A 402 (no credits) and a 404 (no endpoint satisfies the constraints) are `failed`/`configuration` (`insufficient_credits`, `model_route_unavailable`). A timeout, transport failure or 5xx is `indeterminate`.
- **The OpenAI Responses adapter stays.** It is an alternative adapter and is no longer the primary path.
- **The key.** `OPENROUTER_API_KEY` is backend environment only: never `VITE_`, never in Git, the database, a log or Netlify. The scan and preflight treat it as a model-provider key.

## C. Model registry and model pools: owner data, read by the database

- **The registry.** `ops.model_registry` holds one row per `(gateway, model)`:
  - family;
  - structured-output, reasoning and tool support;
  - context, latency and cost classes;
  - enabled or disabled.

  Rows are owner data, recorded by an owner act and never by a migration (the pattern of ADR 0017's prices). A model id lives only there and in a price row, never in code.
- **The pools.** `ops.model_pools` names a pool, its purpose and its route tier (output ceiling and timeout); its members are `ops.model_pool_members` (pool, gateway, model, rank).
  - The pool definitions are architecture and ship in a migration. Members are owner data.
  - Only the pools used now exist: `reception_low_cost` (lead triage), `general_fast` (task assessment) and `reasoning_medium` (reserved for escalation; empty until used).
- **Which pool a run uses.** A capability names its default pool, and an agent profile (§G) may name another pool for a capability. **A run's pool is fixed when it is requested,** so the evidence cannot move afterwards.

## D. Q8 removes candidates before any router sees them

`ops.agent_run_model_candidates()` is lease-bound and SECURITY DEFINER, and it is the worker's new capability. For the leased run it returns the pool members that pass all of these, in rank order:
- enabled in the registry;
- on the configured gateway;
- authorized for the run's data class by `ops.model_data_authorized` (synthetic and test are exempt, as today);
- with a current price.

`ops.start_agent_run` gains one gate after Q8: the announced `(provider, model)` must be one of those candidates, or the run settles refused with `model_not_authorized`. So the database, never the router, is the boundary.

**OpenRouter cannot be authorized for protected data in this milestone.** The insert guard of `ops.model_data_authorizations` refuses gateway `openrouter` for `person_text` and `health`. The reason: an authorization would have to bind the upstream provider route (an `only` list with `zdr`), and that shape is designed but not built. So no `openrouter/*` wildcard, and no OpenRouter model, can ever carry protected data until a later ADR builds the route binding.

**The hosted `typesafe/jev-router` is not used to execute anything.** Its include list can be silently ignored, so it could choose outside the authorized set. That is exactly the "choose first, check later" order this design forbids. Jev's routing role is filled through the Decisions API instead (§E), choosing only among candidates the database has already authorized.

## E. Two Jev uses, kept separate and auditable

Both are rows of one provider-neutral ledger, `ops.structured_decisions`, with a closed `decision_kind` and a versioned question set per kind. Both run on the existing queue through one external job kind, `decision.structured_evaluate`, so the kill switch covers them and the call is at most once. Both are **shadow first**: they record what Jev would decide and change nothing that executes. Both use the Q8 gate: a decision about a task whose data class is not exempt is refused `data_not_authorized` and calls nothing, so in this milestone only synthetic and test data reach Jev.

1. **The business decision** (kind `business_route`, question set `business_routing.v1`):
   - **When:** after the task's run settles, from the worker's existing after-settlement step. Shadow decisions never sit in front of execution.
   - **What it asks:** intent (versioned choice), department (choice over the tenant's departments plus `human_review` and `no_action`), capability (choice), complexity (`score`: low, medium, high) and human escalation (`noul`).
   - **What it records:** the answers with their probabilities and confidence, the exact Jev build, and the route the deterministic path actually took, for comparison.
   - **Deterministic rules can still force human review**, whatever Jev says.
2. **Model-routing advice** (kind `model_route`):
   - **When:** after the business decision settles, so its complexity is known.
   - **What it asks:** Jev chooses among *that run's authorized candidates*, described by their registry classes, given the capability and the business decision's complexity when one exists.
   - **What it records:** the candidates, the model the deterministic policy executed and Jev's choice. Because execution is deterministic during shadow, there is no extra call before the run and no fallback question.

**The deterministic routing policy:** the lowest-rank authorized candidate. It escalates to a stronger pool only when a deterministic rule says so; none does yet.

**Not in this milestone:**
- **No clinical use of Jev:** no diagnosis, treatment, clinical risk or clinical recommendation.
- **No councils, voting or chained models:** one structured decision, then one executor.

## F. CRM lead intelligence: shadow, operational signals only

Kind `lead_intelligence` (question set `lead_intelligence.v1`) is a third row kind in the same ledger:
- commercial readiness, scheduling readiness and follow-up priority (`score`);
- the objection category (`choice`);
- the next best administrative or commercial action (`choice`).

**Its state is built from an allowlist of operational fields only:**
- the triage's intent and priority enums;
- the CRM funnel state;
- counts and intervals of interactions.

**It never includes** the message text, a summary, a diagnosis, a condition, medication, the severity of suffering or any clinical record. The builder is tested to refuse anything else. Sensitive health information is never a lever for commercial pressure.

Each output is stored with its probabilities, the model build and the time. Outcomes observed later are stored beside it (replied, scheduled, attended, converted, value, time to conversion), so the scores can be calibrated. **The interface never presents a score as a factual probability of conversion** before calibration exists.

## G. The agent definition (the Receptionist)

`ops.agent_profiles` is versioned owner data per agent:
- objective;
- capabilities;
- tools (empty);
- accessible data classes;
- escalation policy;
- review policy (human review always required today);
- a daily cost ceiling;
- a model pool per capability.

**The ceiling is enforced.** `ops.start_agent_run` refuses `agent_budget_exhausted` when the agent's settled and running charges for today, plus the run's reservation, would exceed it. This applies in addition to the global, tenant and company limits.

The staging tenant's `reception-agent` becomes the **Receptionist**: lead triage, the `reception_low_cost` pool, human review required, and a small ceiling. Any authorized model in its pool can execute it without redefining the agent.

## H. Cost, latency and quality measurement

Every run records:
- the gateway, the model, the provider route, the tokens and the latency;
- our charged cost, from the owner's price (authoritative, ADR 0017), and OpenRouter's reported cost, kept separately for reconciliation.

Every Jev decision records its own usage and cost under the same daily budget, through a price row for the Jev build.

A read model reports cost by run, agent, department, capability, model and tenant, plus the routing economics: actual cost against the cost the strongest authorized candidate would have had at the same tokens.

Prompts are not stored for analytics. Retention (ADR 0020 §I) is unchanged.

## I. Failure behaviour (all fail closed, all recorded)

| Failure | Behaviour |
|---|---|
| **OpenRouter unavailable** | `indeterminate` or `failed` by ADR 0016's taxonomy; no retry and no fallback model. |
| **No authorized candidate** (a model disabled, removed, unauthorized or unpriced) | Refused `model_route_unavailable`; no call. |
| **The worker announces a model outside the candidates** | Refused `model_not_authorized`. |
| **Jev unavailable, invalid, an unexpected answer type or a missing key** | The decision row settles `failed`, `invalid` or `indeterminate`; nothing downstream changes. |
| **Low confidence or unknown intent** | Recorded as such. When the decision becomes authoritative later, these route to human review. |
| **Budget exhausted** (global, tenant, company or agent), **kill switch, data class not authorized** | The existing codes. |
| **A forbidden fallback** | Impossible by construction: one exact model, `allow_fallbacks: false`, and no `models` list. |

## J. What this record does NOT do

- It opens no real-data path, records no authorization for protected data, and keeps the production WhatsApp gate closed.
- It makes no business decision automatic: Jev runs in shadow only.
- It adds no clinical use of Jev.
- It uses no hosted router to execute anything.
- It adds no new recurring infrastructure. The OpenRouter key and credits are an owner action and an owner cost approval.

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**
