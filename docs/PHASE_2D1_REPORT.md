# Phase 2D.1 — Decision engine foundation, shadow mode: implementation report

| | |
| --- | --- |
| **Status** | **OWNER-TESTED / READY FOR INTEGRATION (2026-09-24).** Phase 2D has STARTED; 2D.1 is its first slice. Pushed for remote CI; no PR yet. Real Jev NOT CONNECTED; Q8 OPEN; browser mutable RPCs 2; no execution authority added. |
| **Base** | `feature/clinical-phase-1` at `f195c2a74725fa77233b23053cfed59f260017e1` (the PR #9 merge that integrated S7.2). Post-merge CI Check #62 (run 36004980326): Build, Test, Typecheck, ESLint and Database security & reproducibility passed; only the historical e2e baseline (9 failed, 1 skipped, the same cases) and the Prettier baseline (`sampleCsv.test.ts`, `canAccess.test.ts`) are red. The workflow is not green. `main` unchanged at `a863e2a0`. |
| **Branch** | `feature/phase-2d-decision-shadow` |
| **Governing records** | [PHASE_2C_BRIEF.md](PHASE_2C_BRIEF.md) §22 and decision P ([DECISIONS.md](DECISIONS.md)): a provider-neutral DecisionPort, Jev in shadow mode first, never authoritative. No Phase 2D brief or ADR exists yet; this slice stays inside the recorded direction and changes no authority. |
| **Data** | Synthetic and test data only. BASELINE Q8 OPEN. No real patient data; no production deploy. |

## 1. What 2D.1 is

The first decision layer, observational only:

```
lead triage review opened (synthetic or WhatsApp test)
  → ops.request_shadow_decision (once per review and policy version)
  → decision.shadow_evaluate job (existing queue, existing worker)
  → DecisionPort (fake provider, or the Jev boundary)
  → strict DecisionVector, validated in the worker and again in the database
  → deterministic Company Engine policy (classifies; human review required)
  → ops.decision_evaluations
  → read-only projection on the review's page
```

**Authority is unchanged.** The Company Engine's deterministic policy owns the outcome, and in 2D.1 every outcome is "human review required". The DecisionPort is advisory. Jev is shadow only. No execution authority was added.

## 2. What exists

- **Migration `20260925120000_decision_shadow.sql`** (forward only).
  - `ops.decision_evaluations`: tenant, company, the run's department and agent, the review, the trigger, the policy version (`decision_shadow.v1`), an idempotency key, the status, the provider identity, a sha256 fingerprint of the input (never the input), the vector, the policy outcome, and `human_review_required`, pinned true by a CHECK.
  - Its guard triggers (ENABLE ALWAYS) fix the identity and allow only these transitions: `pending → running | refused` and `running → completed | indeterminate | invalid | failed`. A settled row is history. RLS is enabled and forced; no application or capability role holds any privilege on the table.
  - `ops.decision_input_for_review` builds the allowlisted input: `sourceClass` (synthetic or whatsapp_test), `contactPolicy`, and the triage `outcome`, `intent`, `priority`, `flags` and `needsHumanReview`, each checked against its vocabulary. It carries no message body, reply draft, summary, next action, phone number, email, name, auth identity, CRM note, or tenant or record id.
  - `ops.decision_vector_valid` (a strict key set, types and ranges) and `ops.decision_shadow_policy`. The policy returns `abstained`, `high_caution`, `low_confidence` (confidence below 0.6) or `recommendation_available`. Even 1.0 confidence decides nothing.
  - `ops.request_shadow_decision` makes one request per review and policy version.
    - A review outside the synthetic and test scope (`ops.cos_review_decidable`, the same predicate the browser decision uses) is never requested: no row and no job.
    - A request under an active stop is recorded `refused`/`stopped`, with no job (owner decision E).
  - `ops.request_shadow_decision_for_settled_job` is a runtime step after an agent run's settlement. It runs in its own transaction, only for the worker that completed the job, like `ops.open_review_for_settled_job`.
  - `ops.start_shadow_decision` and `ops.settle_shadow_decision` are lease-bound DEFINER capabilities.
    - The start re-checks the scope (refused if it no longer holds) and the stops (the job is held). It records `running`, with the provider identity and the fingerprint, before the provider is asked.
    - A `running` row that a later attempt finds is settled `indeterminate` and the provider is not asked again (at most once).
    - The settlement validates the vector again, against the schema, the started provider and the fingerprint. A failed vector is stored `invalid`, never coerced.
  - `decision.shadow_evaluate` is an **external** job kind. The one kill switch holds it at the lease and again at the start, a `job_kind` stop can name it, and `ops.job_covering_stop` resolves its unit from the evaluation. No task can request it.
  - `get_review` gains `shadowDecision`, which is one of:
    - `null`: in scope, nothing requested;
    - `{status: "unavailable"}`: outside the scope;
    - a minimised evaluation, with no input, fingerprint, job or error text.
  - The migration asserts its end state, including that no decision function names a review decision, a send, the outbound path, the CRM, a stop act, a budget, a price, a channel or a membership, or runs dynamic SQL.
- **`engine/decision/`**.
  - `DecisionPort`, and the strict `DecisionInputSchema` and `DecisionVectorSchema` (zod).
  - `createFakeDecisionProvider`: deterministic rules over the structured input, labelled `fake`.
  - `createJevDecisionProvider`: the Jev boundary (see §3).
  - `decisionShadowFromEnv`: `DECISION_SHADOW_PROVIDER` unset means off (no request after a settled triage); `fake` and `jev` select a provider; anything else refuses to start.
- **Worker.**
  - `engine/handlers/decisionShadowEvaluate.ts` is an external_call handler holding only `startShadowDecision` and `settleShadowDecision`, with no post-settlement step.
  - `afterSettlement` gains `requestShadowDecision`, declared only when a provider is configured.
  - `CAPABILITY_NAMES` gains the two capabilities.
- **Company OS.** The review's page has a read-only section: "Inteligência de decisão", badge "Modo sombra", "Esta recomendação não executa nenhuma ação e não substitui sua decisão."
  - It shows the recommendation (Aceitar, Precisa de ajuste, Rejeitar or Sem recomendação), the confidence, the caution, and the policy with "Revisão humana obrigatória".
  - The engine label for the fake provider is "Simulação determinística (não é o Jev)".
  - Once a review is decided, it also shows an observational comparison: "Resultado humano" and "Concordância com a recomendação".
  - Pending, indeterminate, invalid, failed, refused, unavailable and "no evaluation" each have their own text, and none shows a recommendation.
  - `humanReviewRequired` is `z.literal(true)` in the contract, so a projection claiming otherwise fails to parse.
  - **No new browser mutation:** exactly `decide_review` and `trip_stop`, 17 functions.

## 3. Jev: NOT connected

No Jev package, API, endpoint, protocol or credential has been approved or verified; "Jev" is recorded only as the owner's name for the future provider (brief §22, ROADMAP). So none was invented.

`JevDecisionProvider` has the port's shape and its own identity (`jev`/`unconnected`). Its `evaluate` reaches nothing and reports `jev_contract_not_approved`, so an evaluation settles `failed`. A unit test stubs `fetch` and proves no call is made.

The fake provider is not Jev, and the screen says so.

**Blocker for real connectivity:** a real provider call must go through the governed external call this job kind already runs under (the kill switch and at most once), and it must also carry price and spend accounting. The decision kind has no price, spend reservation or settlement yet. That is a separate slice with an approved Jev contract.

## 4. Evidence (local)

| Suite | Result |
| --- | --- |
| `test:db` | 18/18, including the new `decision_shadow.sql` (see below) |
| `test:db:engine` | 314/314 in 43 files, including the new `decisionShadow.dbtest.ts` (see below) |
| Upgrade replay | PASS |
| `functions` | 2025 |
| Company OS `app` | 199 in 23 files, including the read-only sweep |
| Static checks | Migration guard 253/253; typecheck, ESLint, Prettier on the changed files, build, bundle scan, production scope and signing key green |

**`decision_shadow.sql`** is one rolled-back transaction:

- D1: the vector check and the policy.
- D2: the input allowlist, with sentinels in the body, contact, summary, draft and next action.
- D3: Q8, idempotency, a foreign review, the job shape.
- D4: a request under a stop.
- D5: the lifecycle, with the review, its decisions, tasks, runs, events, sends, stops, money, channels and the CRM untouched.
- D6: at most once.
- D7: every vector outcome, and malformed or mismatched vectors.
- D8: the guard.
- D9: stops at the start, including a `job_kind` stop naming the new kind.
- D10: the projection.
- D11: access, including a live lease required and no new browser mutation.
- X1 to X5: a settlement that decides the review, both Q8 lines removed, an input carrying the body, the human-review constant dropped, and a second browser mutation. Each is caught by its own check.

**`decisionShadow.dbtest.ts`** runs through the real worker runtime:

- the pipeline, with the provider asked the allowlisted input only, the vector stored, the review untouched, and the owner still deciding independently;
- no provider configured → no request;
- an out-of-scope review → the provider is never asked;
- an agent stop holds the job until it is cleared;
- an ambiguous failure → indeterminate, asked once;
- a malformed answer → invalid;
- two concurrent requests → one evaluation and one job;
- a repeated step → the same evaluation.

## 4a. Owner visual test (2026-09-24): PASS

On a synthetic review, the owner saw the fake shadow provider recommend **Aceitar at 82%**. The page showed "Modo sombra", "Revisão humana obrigatória", "Simulação determinística (não é o Jev)" and the no-action warning.

The owner deliberately disagreed and recorded **Precisa de ajuste**. The confirmation read "Esta ação registra sua decisão. Nenhuma mensagem será enviada."

The human result was persisted independently: the review is `needs_edit`, recorded by the member's principal. The shadow evaluation was unchanged (still `accept`, 0.82). The comparison showed "Concordância com a recomendação: Não". No message was sent (no outbound row), and the shadow engine executed no action. A shadow recommendation is not decision authority.

## 5. Review (one focused pass)

**P0: 0. P1: 0.**

The pass checked:

- execution authority;
- a Q8 bypass;
- raw content reaching the provider;
- tenant isolation;
- the provider mutating reviews;
- a hidden network path;
- duplicate invocation;
- a browser mutation;
- a stop bypass;
- unvalidated provider payloads.

**P2/P3, recorded, not fixed:**

- Reason codes are provider-chosen identifiers, limited by pattern (`^[a-z][a-z0-9_]{0,63}$`) and shown only under the technical details. A closed vocabulary is needed before a real provider.
- The runtime step is best effort. A request whose step failed has no CLI recovery; the owner can call `ops.request_shadow_decision` as the database owner.
- A stop tripped after a start commits does not interrupt that call; the lease bounds it, as for agent runs.
- The policy version is pinned to `decision_shadow.v1`; a new version is a migration.

**Backlog carried:**

- the cosmetic "Psychology Clinic" demo name;
- the S7.1 Codex P2s (`communication_status` not refreshed after a decision; "already recorded" shown as "Decisão registrada");
- the PR #9 Codex P2s (target state is derived from the stops read so far; the 500-agent cap on trip targets).

**Proposed invariant, not in the registry.** The owner decides its final text: "A shadow decision is advisory: it is requested only for synthetic or test lead triage reviews, receives only the allowlisted structured input, is stored with human review required, and no decision function decides a review, sends, writes the CRM, trips or clears a stop, or changes money, channels or memberships."

## 6. What 2D.1 does not do

No Model Router, Judge, voting, Jev chains, automatic action selection, scheduling, RAG, memory, growth or Phase 2E observability platform. No review is decided, nothing is sent, no CRM row is written, no stop is tripped or cleared, and no budget, price, channel or membership changes. Q8 stays OPEN.
