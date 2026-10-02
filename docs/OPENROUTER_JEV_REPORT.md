# OpenRouter + Jev + multi-model Company OS — report

**Status (2026-10-02): IMPLEMENTED on `feature/openrouter-jev-intelligence` from `feature/clinical-phase-1` at `6da21fbd`.** The decisions are [ADR 0022](adr/0022-openrouter-gateway-and-jev-intelligence.md); this report records what was built, how it was proven and what is still open.

| Record | State |
|---|---|
| DIRECT OPENAI/LUNA PRIMARY ARCHITECTURE | **SUPERSEDED** (the OpenAI Responses adapter stays as an alternative; ADR 0016 is not withdrawn) |
| OPENROUTER MULTI-MODEL GATEWAY | **SELECTED** |
| JEV BUSINESS DECISION LAYER | **SELECTED**, shadow first |
| JEV ROUTING | **SHADOW-FIRST** |
| WHATSAPP / META MILESTONE | **PAUSED BY OWNER** (2026-10-02) on `feature/staging-model-and-meta`; it resumes after this milestone is merged and verified |

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

## 1. Why

The owner moved the priority from WhatsApp to the model layer on 2026-10-02. Two things were wrong with continuing as before:

- **One provider for every tier.** The worker turned `AGENT_MODEL_PROVIDER=openai` and one model id per tier into routes. Choosing another model meant a deploy, and a model id lived in the environment of one process.
- **An agent was a free-text `role`.** Nothing said what it is for, what it may do, what data it may see or what it may spend. The plan's rule: **an agent is not a model.**

## 2. The pipeline

Every step before the call is deterministic and owned by the database. Jev never removes a gate and never chooses what runs.

```
inbound (synthetic or test) → admission → task (data class from provenance)
  → agent run requested (the agent's capability, the capability's tier)
  → worker claims the run
  → ops.agent_run_model_candidates(): the agent's pool for the capability,
      minus every model that is disabled, unpriced, without structured
      output, or NOT AUTHORIZED FOR THE TASK'S DATA CLASS (Q8)
  → the router takes the first candidate on its gateway (rank order)
  → ops.start_agent_run re-checks: stop, Q8, candidate membership,
      price, spend limits, the agent's daily ceiling (under lock)
  → one call to OpenRouter: one exact model, no fallback
  → settlement (served build checked, usage and cost recorded)
  → after settlement: review opened; Jev decisions requested (shadow)
      business_route · lead_intelligence · model_route
```

**Q8 removes candidates before any router.** The forbidden order, "Jev chooses anything, check security later", cannot be expressed: the router only ever sees the database's list, and the start refuses any model outside it (`model_not_authorized`), or a run with no list (`model_route_unavailable`).

## 3. What was built

| Area | Files | What |
|---|---|---|
| Gateway | `engine/models/openRouterChat.ts`, `engine/models/httpTransport.ts` | The OpenRouter chat-completions adapter: strict JSON schema output, `provider: {allow_fallbacks: false, require_parameters: true, data_collection: "deny"}`, the served build checked against the requested model and its accepted builds (`model_substituted` otherwise), the provider route and the reported cost kept, and every status mapped onto ADR 0016's failed-or-indeterminate taxonomy. |
| Jev | `engine/models/openRouterDecisions.ts`, `engine/decision/structured/` | The Decisions API adapter (`POST /api/alpha/decisions`), a pinned build only (an alias is refused), and three question sets: `business_routing.v1`, `lead_intelligence.v1`, `model_route.v1`. Answers are parsed strictly against the questions asked. |
| Router | `engine/models/router.ts`, `engine/models/routingConfig.ts` | A gateway mode, exclusive with the static routes: the router resolves only a candidate the database listed, and executes only a route it resolved itself. `AGENT_MODEL_GATEWAY=openrouter` with `OPENROUTER_API_KEY`. |
| Database | `20261006120000_model_gateway_registry.sql` | `ops.model_registry`, `ops.model_pools`, `ops.model_pool_members`, `ops.agent_profiles`, `ops.agent_run_routes`; the candidate gate and the agent ceiling in `ops.start_agent_run`; OpenRouter refused for `person_text` and `health` authorizations; owner acts. |
| Database | `20261007120000_structured_decisions.sql` | `ops.structured_decisions` (one ledger for both Jev uses), its job kind `decision.structured_evaluate`, the decision's own reservation inside the daily spend window, `ops.decision_outcomes`, and the reads `ops.structured_decision_summary` and `ops.model_economics`. |
| Worker | `engine/handlers/agentRunExecute.ts`, `engine/handlers/structuredDecisionEvaluate.ts`, `engine/worker/*` | Four new lease-bound capabilities; the after-settlement step that requests the decisions; the decision handler, which builds its questions, holds them to the recorded spec and calls Jev once. |
| Owner tool | `engine/cli/models.ts` (`npm run models`) | Reads: `list`, `profiles`, `decisions`, `economics`. Acts: `record`, `enable`, `disable`, `pool add`, `pool remove`, `profile record`, `outcome record`. |
| Staging run | `engine/cli/stagingGatewayWorker.ts` (`npm run staging:gateway-worker`) | The real worker registry on the real gateway, staging only, at most 20 jobs, one JSON line per job and never content. |

## 4. Agent definition: the Receptionist

The Receptionist is the staging `reception-agent` with an `ops.agent_profiles` version:

- **objective:** "Receive inbound enquiries, understand what the person needs and prepare an advisory triage for a human to review. Never sends, never decides clinically.";
- **capabilities:** `lead_triage`; **tools:** none (a profile with a tool is refused);
- **data classes:** `synthetic`, `test`;
- **escalation:** human review always; **review:** human review required;
- **daily cost ceiling:** US$0.50 (500 000 micro-dollars), America/Sao_Paulo;
- **models:** `lead_triage` → pool `reception_low_cost`.

No model id appears in the agent. Changing the model is an owner act on the pool, recorded and versioned.

## 5. Jev, its two uses

Both are shadow only, on one ledger, asked after the run is settled and only about synthetic or test content:

- **A. Business decision** (`business_route`): the intent, the department (the tenant's own departments plus `human_review` and `no_action`), the capability, the complexity and whether a person must review. Stored beside the deterministic route, which is what actually ran.
- **B. Model route advice** (`model_route`): a choice among the run's own authorized candidates, given the capability, the complexity and the input size. Stored beside the model that actually ran. It never changes the route.
- **Lead intelligence** (`lead_intelligence`): commercial and scheduling readiness, follow-up priority, the main objection and the next best action, from operational signals only (intent, funnel stage, message counts, elapsed time). No diagnosis, condition, medication or severity reaches it, and no percentage is shown: the scores are uncalibrated.

## 6. Failure behaviour

Every failure is closed and recorded; ADR 0022 §I has the table. Proven cases:

| Case | Result | Proof |
|---|---|---|
| Every pool model disabled | run refused `gateway_candidate_unavailable`, nothing called | `modelGatewayFlow.dbtest.ts` |
| Model outside the candidates announced | `model_not_authorized` | `model_gateway.sql` E1 |
| Health task | refused `data_not_authorized` before a job; no Jev decision | `modelGatewayFlow.dbtest.ts`, `model_gateway.sql` G7 |
| OpenRouter authorization for person or health content | refused OS403 | `model_gateway.sql` F1 |
| Kill switch | decision jobs held, run once cleared | `modelGatewayFlow.dbtest.ts` |
| Jev out of credits / timeout | decision `failed` / `indeterminate` | `modelGatewayFlow.dbtest.ts` |
| A served build that was not requested | `model_substituted`, cost kept | `openRouterChat.test.ts`, `model_gateway.sql` G5 |
| A failed call on the first candidate | settled; the second candidate is never called | `agentRunExecute.test.ts` |
| Agent ceiling reached | `agent_budget_exhausted` | `model_gateway.sql` E8 |
| Jev answers outside the spec | `answers_rejected` | `structuredDecisionEvaluate.test.ts`, `model_gateway.sql` G2 |

## 7. Evidence

To be completed by the broad validation at the end of the milestone.

## 8. Staging

**Configured (2026-10-02),** on the staging project only, by owner acts through the connector:

- the 67 canonical migrations;
- five models in the registry, each with a price valid until 2026-12-31: `openai/gpt-6-luna`, `qwen/qwen3.5-flash-02-23`, `anthropic/claude-haiku-4.5`, `anthropic/claude-sonnet-5.5`, `typesafe/jev-1.13`, with their dated builds as accepted builds;
- pools: `reception_low_cost` (Luna, Qwen, Haiku), `general_fast` (Luna), `reasoning_medium` (Sonnet), `structured_decision` (Jev);
- the Receptionist profile above;
- the existing US$0.16 daily global ceiling and tenant budget, unchanged.

**The real-model run waits on the owner's OpenRouter key** (OWNER ACTION REQUIRED — OPENROUTER). It runs two synthetic demands: a new lead asking how the service works and what it costs (case A), and an existing client asking for a billing document (case B).

## 9. Costs

- **New recurring infrastructure:** none.
- **OpenRouter:** prepaid credit chosen by the owner (about US$5), with a key credit limit; our own limits apply first, because an OpenRouter budget does not replace ours.

## 10. Not done, by design

- No production model traffic, no real patient data, no clinical use of Jev.
- No council, swarm or voting; one model per run.
- No authoritative Jev: its outputs are recorded and compared, never acted on.
- The hosted `typesafe/jev-router` is not used.
- No new infrastructure, and no WhatsApp change in this milestone.

## 11. Next

1. The real-model synthetic run on staging, once the key exists.
2. The pull request into `feature/clinical-phase-1`, its review and its integration.
3. **Resume WhatsApp automatically:** bring `feature/staging-model-and-meta` onto the new head and route WhatsApp through the Company OS, Jev and the authorized pools on OpenRouter.

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**
