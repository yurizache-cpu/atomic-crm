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
| Database | `20261008120000_model_gateway_hardening.sql` | The pre-PR review's corrections (§7a): answers held NULL-safely to exactly the asked questions; an answered decision never charged zero; a profile's pool on its capability's own tier; the agent's definition enforced (`agent_not_permitted`); the ceiling's settled spend refusing and calls in flight retried (`OS429`); the reaper settling a decision whose attempt died; no current OpenRouter authorization for protected content. |
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
| Ceiling filled only by calls in flight | `OS429`, the run stays pending | `model_gateway.sql` H6 |
| A capability or data class outside the agent's profile | `agent_not_permitted` | `model_gateway.sql` H5 |
| A profile pool on another route tier | refused OS400 | `model_gateway.sql` H4 |
| Answers missing a value or adding an unasked key | refused by the database too | `model_gateway.sql` H1 |
| A failed decision the model answered | charged its reservation, never zero | `model_gateway.sql` H2 |
| A decision whose attempt died | the reaper settles it `indeterminate` | `model_gateway.sql` H3 |
| Jev answers outside the spec | `answers_rejected` | `structuredDecisionEvaluate.test.ts`, `model_gateway.sql` G2 |

## 7. Evidence

The broad local validation, on 2026-10-02, after a clean `db reset` of the isolated e2e stack:

- **`test:db`:** 25 of 26 suites pass, including the new `model_gateway.sql` (sections A to G). The one red is `ownerSessionPool.mjs`, which fails locally on this machine only: the edge runtime and the antivirus's HTTPS interception (CLAUDE.md, Known issues). CI is its judge.
- **`test:db:engine`:** 409 of 409 driver-backed tests in 55 files, including the new end-to-end `modelGatewayFlow.dbtest.ts`, which runs the real worker loop and database with scripted gateways: cases A and B and four failure cases.
- **`test:db:upgrade`:** PASS. Legacy data keeps its meaning across the two new migrations.
- **Unit projects:** 3845 passed and 30 skipped, after the PR #24 review fixes (3830 before them). The only reds are local false reds:
  - an untracked, stale `.claude/worktrees/` copy of the hooks;
  - two `scripts/` tests that cannot be collected from a CRLF checkout of a hashbang script. Converted to LF, as git stores them and CI checks them out, they pass 22 of 22.
- **Security invariants:** 85 of 85, SI-78 included.
- **Typecheck and lint:** 0 errors.
- **Mutation-tested guards:** the candidate gate (E1, two mutations), the OpenRouter refusal for protected classes (F1), the agent ceiling (E8), the decision's answer and substitution checks (G5), its spend window (G4) and its Q8 refusal (G7); after the pre-PR review (§7a), eight more: the NULL-safe answer check and the unasked key (H1), the charge of an answered failure (H2), the reaper (H3), the profile tier (H4), the agent's definition (H5) and both halves of the ceiling split (H6). Each mutation turned its named assertion red.

## 7a. Pre-PR review

An independent review of the whole branch, before the pull request, found no P0 and no P1, and ten P2. Eight were fixed in `20261008120000_model_gateway_hardening.sql` and the code; two were corrected in the documentation:

| # | Finding | Resolution |
|---|---|---|
| 1 | The database's answer check was NULL-unsafe and accepted unasked keys | Fixed; H1 |
| 2 | A failed decision the model answered could be charged zero | Fixed: zero only without a served model; H2 |
| 3 | Calls in flight could permanently refuse a run under the agent ceiling | Fixed: settled spend refuses, in-flight spend is OS429; H6 |
| 4 | Decision spend is outside the agent ceiling | Documented: the ceiling covers the agent's own runs; decisions count in the global and tenant windows (ADR §G) |
| 5 | Lead intelligence sent `has_open_opportunity: false` without knowing it | Fixed: `unknown`, a three-valued signal |
| 6 | The ADR said the pool is fixed at request and the advice runs after the business decision | Corrected to what the code does (ADR §C, §E) |
| 7 | A profile pool on the wrong tier silently refused every run; capabilities and data classes were not enforced | Fixed; H4, H5 |
| 8 | A decision whose job died stayed running | Fixed: the reaper settles it; H3 |
| 9 | The OpenRouter ban covered new authorizations only | The end state asserts none exists |
| 10 | The staging worker skipped the lease check and the reaper | Fixed: the lease is sized to the longest route, and the maintenance runs before and after the loop |

## 7b. Automated review on PR #24

The automated review left two P2 comments. The owner ruled both in scope (2026-10-03), and both are fixed:

1. **Take the upstream provider from the documented metadata.** OpenRouter documents the served provider only as opt-in routing metadata: the request header `X-OpenRouter-Metadata: enabled`, and `openrouter_metadata.endpoints.available[]` on the response, where the endpoint marked `selected` served the call. The top-level `provider` field it had returned in the first live run is not documented.
   - **What the adapter does now:** it sends the header on every chat call and records the provider of the one selected endpoint. With no endpoint selected, more than one, a malformed name, or the key echoed back, it records no route; it never substitutes the undocumented field. That field is read only when the metadata is missing altogether, which the header should never allow.
   - **Only the selected provider's name is kept,** never the list of endpoints.
   - **Routing does not change:** the header adds metadata and nothing else. The request still names one exact model with `allow_fallbacks: false`.
   - **Proof:** five adapter tests and four mutations. Removing the header, ignoring `selected`, preferring the undocumented field, or accepting two selected endpoints each turned a test red.
2. **A call the gateway served and billed keeps its audit when its answer is unusable.**
   - **The audit travels with the error:** `ModelError` now carries the provider route and the reported cost, well formed or null. They are set wherever a billed answer turns out unusable: the chat adapter, the router's contract check and the Decisions adapter.
   - **The agent run's failure branch** records the gateway report before the failure. The failure keeps the served model, the response id, the usage and the latency, as it did before. A failed decision settles with the same audit.
   - **The run's failure is kept apart from the paid call:** the run is `failed`, while `ops.agent_run_routes` keeps the provider and OpenRouter's reported cost.
   - **The database charges the usage estimate, or the reservation when no usage came back; never zero.** Only a refusal with no response at all is charged nothing, a rule that predates this milestone.
   - **Proof:**
     - five handler tests through the real adapter: output that is not JSON, a refused finish reason (`length`), a refused model substitution, a refusal, and output failing the structured contract. Each keeps the report before the failure, and each makes one call on the first candidate, with no fallback;
     - SQL case H7: a billed failure with usage is charged its estimate, one without usage its reservation, and the route keeps its report;
     - mutations, each caught by name: the adapter, the router or the handler dropping the report, a paid failure charged zero, and the usage estimate ignored.

**An independent review of the fix (2026-10-03)** found no P0 and no P1, and two minor notes:
- **The Jev adapter keeps the top-level `provider`.** The Decisions API documents that field in its response (research of 2026-10-02), unlike chat completions, so no change is needed.
- **Open, minor, predates the fix:** a response with no readable model is stored as `model_substituted` with the requested id as its served model. The charge stays non-zero, the safe direction, but the audit field is not confirmed by the response. The follow-up: classify it as `unknown` (indeterminate) with no served model, in chat and in decisions.

**Q8 and fallback are unchanged.** The database still decides the candidates before any router (SI-78); OpenRouter still cannot be authorized for `person_text` or `health`; the recorded provider route is audit only and authorizes nothing; and no change here calls a second model or a second provider.

CI on the PR head: Test, Build, Typecheck, ESLint and Database pass. e2e is exactly 9 failed and 1 skipped, the same ids, and Prettier is exactly the two baseline files. No new regression.

## 8. Staging

**Configured (2026-10-02),** on the staging project only, by owner acts through the connector:

- the 68 canonical migrations, the hardening included;
- five models in the registry, each with a price valid until 2026-12-31: `openai/gpt-6-luna`, `qwen/qwen3.5-flash-02-23`, `anthropic/claude-haiku-4.5`, `anthropic/claude-sonnet-5.5`, `typesafe/jev-1.13`, with their dated builds as accepted builds;
- pools: `reception_low_cost` (Luna, Qwen, Haiku), `general_fast` (Luna), `reasoning_medium` (Sonnet), `structured_decision` (Jev);
- the Receptionist profile above;
- the existing US$0.16 daily global ceiling and tenant budget, unchanged.

**Owner setup (2026-10-03):**
- the account's Data Policies: every data-training option off (one, "Allow free endpoints that train on request data", was on and was turned off), the 1% data discount off, and Zero Data Retention left off for now because it could exclude a test model;
- the key `atomic-crm-staging`, credit limit US$5, kept only in `%USERPROFILE%\.atomic-crm\staging.env`.

**The synthetic real-model run: PASS (2026-10-03).**
- Two synthetic messages were admitted on staging:
  - **case A:** a new lead asking how the service works and what it costs;
  - **case B:** an existing client asking for a second copy of a billing document.
- The bounded gateway worker ran 8 jobs, each on its first attempt: 2 agent runs and 6 Jev decisions. It then found the queue idle and stopped.
- Nothing was sent: no outbound row today, and both reviews are pending for a person.

| | Case A | Case B |
|---|---|---|
| Pool, candidates | `reception_low_cost`, 3 | `reception_low_cost`, 3 |
| Model executed (rank 1) | `openai/gpt-6-luna`, upstream OpenAI | `openai/gpt-6-luna`, upstream OpenAI |
| Run | succeeded, 858 in / 259 out tokens, 5.96 s | succeeded, 859 in / 251 out tokens, 3.84 s |
| Charged / OpenRouter reported | 216 / 216 micro-dollars | 212 / 212 micro-dollars |
| Triage | intent `pricing`, priority normal | intent `support`, priority normal |
| Jev business route | intent `pricing_question` (0.63), department `reception` (1.00), complexity low, human review 0.17 | intent `existing_client_admin` (1.00), department **`operations`** (0.99), complexity low, human review 0.22 |
| Agreement with the deterministic route | department agrees (`reception`) | department **disagrees**: Jev would send it to operations; execution stayed with `reception` (shadow) |
| Jev lead intelligence | objection `price`, next action `share_pricing_information`, follow-up priority high, commercial readiness medium | objection `unknown`, next action `answer_question`, follow-up priority high, commercial readiness low |
| Jev model-route advice | `qwen/qwen3.5-flash-02-23` (0.88) | `qwen/qwen3.5-flash-02-23` (0.90) |

- **Jev:** every decision completed on the pinned build `typesafe/jev-1.13-20260917`, upstream TypeSafe, in 0.28 to 0.33 s. Each cost 20 to 40 micro-dollars, and our charge equals OpenRouter's reported cost every time.
- **Routing economics** (`ops.model_economics`): 428 micro-dollars actual. The same tokens on the strongest authorized candidate would have cost 4267, about ten times more.
- **What the run showed:**
  - Case B is exactly the shadow comparison the milestone asked for. The deterministic route sent an administrative request to the front desk; Jev, with 0.99, would send it to operations. Nothing changed, and the disagreement is on record.
  - Jev's routing advice preferred the cheaper Qwen over the executed Luna both times. Promoting that advice to authority is a later, owner-approved step after evaluation.
- **OpenRouter's own key usage** still read 0 right after the run, while our ledger holds US$0.000616. Its meter is delayed or rounds below a cent; the per-request cost it reported matched ours exactly.

### 8a. The real end-to-end run on the reviewed head (2026-10-03)

This second run used PR head `b9eb3a99`, with both review fixes, after CI on that head was confirmed at the historical baseline. The same two synthetic demands were admitted again.

**Q8 before any router (staging, read-only):**
- `ops.model_pool_candidates` for pool `reception_low_cost` returned `synthetic` → Luna, Qwen, Haiku in rank order.
- The same call returned `health` → none and `person_text` → none: no authorization exists, and OpenRouter can never hold one for those classes.

| Checked | Case A2 (new lead, prices) | Case B2 (existing client, billing document) |
|---|---|---|
| Synthetic input | "Oi, vi seu site e queria saber como funcionam os atendimentos e valores." | "Olá, já sou cliente e preciso da segunda via da nota fiscal do pagamento de setembro." |
| Data class | `synthetic` | `synthetic` |
| Agent / department / capability (deterministic) | `reception-agent` / `reception` / `lead_triage` (tier `standard`) | the same |
| Pool and Q8 candidates | `reception_low_cost`: Luna, Qwen, Haiku | the same |
| Model requested → served | `openai/gpt-6-luna` → `openai/gpt-6-luna` | the same |
| Provider (documented metadata, `selected`) | `OpenAI` | `OpenAI` |
| Finish reason | completed (`stop`) | completed (`stop`) |
| Usage | 858 in / 210 out / 1068 total | 859 in / 252 out / 1111 total |
| Latency | 4.42 s | 5.02 s |
| Reserved → charged; OpenRouter reported | 4849 → **191**; reported 191 | 4851 → **212**; reported 212 |
| Gateway audit (`ops.agent_run_routes`) | pool, 3 candidates, model, provider and reported cost recorded | the same |
| Settlement | `succeeded`; triage intent `pricing`, priority normal | `succeeded`; triage intent `support`, priority normal |
| Review | opened, `pending` (human review required) | opened, `pending` |
| Audit trail (events) | requested, execution requested, started, succeeded, review pending | the same |
| **Jev business decision** | intent `pricing_question` (0.62); department `reception` (1.00); capability `lead_triage`; complexity low; human escalation 0.18 | intent `existing_client_admin` (1.00); department **`operations`** (0.99); capability `lead_triage`; complexity low; human escalation 0.21 |
| Against the deterministic route | agrees | **disagrees on department** (shadow; execution stayed at `reception`) |
| **Jev model-route advice** | `qwen/qwen3.5-flash-02-23` (0.89); executed Luna | `qwen/qwen3.5-flash-02-23` (0.91); executed Luna |
| Jev lead intelligence | objection `price`, next action `share_pricing_information` | objection `unknown`, next action `answer_question` |
| Jev calls | 3, completed, pinned build `typesafe/jev-1.13-20260917`, upstream TypeSafe, 0.30 to 0.31 s, 94 micro-dollars, each equal to OpenRouter's report | 3, completed, 0.31 to 0.40 s, 94 micro-dollars |

**A controlled paid-but-unusable call.** A tiny diagnostic showed that OpenRouter serves a request for the dated id `openai/gpt-6-luna-20260922` as `openai/gpt-6-luna`. The setup, by recorded owner acts:
- that id was registered with no accepted builds and a one-day price;
- it was placed at rank 1 of `general_fast`, with Luna at rank 2;
- the `marketing-analyst` agent was given a profile routing `lead_triage` there;
- one synthetic message was admitted to that agent: "Oi, gostaria de saber se vocês têm horários disponíveis na próxima semana."

The result:
- **The run failed:** `invalid_response` / `model_substituted`. Requested `openai/gpt-6-luna-20260922`, served `openai/gpt-6-luna`, and no result was stored.
- **The paid call stayed recorded:** response id present, 855 in / 156 out / 1011 tokens, 3.64 s. The charge was **164 micro-dollars, its usage estimate, equal to OpenRouter's reported 164 and not zero**. The route row keeps provider `OpenAI`, the reported cost and both candidates.
- **No fallback and no second call:** one job, one run for the task, and the route names the probe; Luna at rank 2 was never called. There was no review, since a failed run proposes nothing, and the events read requested, execution requested, started, failed.
- **The shadow decisions still ran:** the business route and model-route advice completed for the settled run. Lead intelligence needs a successful triage, so it was not asked.
- **Afterwards, by owner acts:** the probe left the pool and was disabled (its price expires in a day), Luna is back at rank 1, and the probe agent's profile now has a 1 micro-dollar ceiling and no pool.

**Diagnostics outside the ledger.** Three one-line synthetic calls with the metadata header cost about 12 micro-dollars in all. Each returned `openrouter_metadata` with exactly one `selected` endpoint (`OpenAI`), which confirms live that the adapter's route now comes from the documented mechanism.

**The day's totals** (`ops.model_economics`, both runs and the controlled case):
- 5 runs, 995 micro-dollars charged, equal to the 995 OpenRouter reported per call;
- 14 Jev decisions, 433 micro-dollars;
- the same tokens on the strongest authorized candidate: 8458;
- nothing sent (no outbound message today) and no data authorization recorded.

OpenRouter's account meter read US$0.001197 at the end, against our ledger's US$0.001428 plus about US$0.000012 of diagnostics. That fits a meter lagging the latest calls and our rounding up to whole micro-dollars per call; the ledger errs high, never low.

## 9. Costs

- **New recurring infrastructure:** none.
- **OpenRouter:** prepaid credit chosen by the owner (about US$5), with a key credit limit of US$5; our own limits apply first, because an OpenRouter budget does not replace ours.
- **Model spend in the synthetic run:** 616 micro-dollars (US$0.000616): 428 for the two runs and 188 for the six Jev decisions.
- **Model spend on 2026-10-03, both runs and the controlled failure:** 1428 micro-dollars in the ledger (995 runs, 433 decisions), plus about 12 for diagnostics: US$0.0014 of the US$5 credit.

## 10. Not done, by design

- No production model traffic, no real patient data, no clinical use of Jev.
- No council, swarm or voting; one model per run.
- No authoritative Jev: its outputs are recorded and compared, never acted on.
- The hosted `typesafe/jev-router` is not used.
- No new infrastructure, and no WhatsApp change in this milestone.

## 11. Next

1. ~~The real-model synthetic run on staging.~~ PASS (2026-10-03), §8.
2. The pull request into `feature/clinical-phase-1`, its review and its integration.
3. **Resume WhatsApp automatically:** bring `feature/staging-model-and-meta` onto the new head and route WhatsApp through the Company OS, Jev and the authorized pools on OpenRouter.

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**
