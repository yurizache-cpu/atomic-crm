# Phase 2D.2 + 2D.3 — Decision quality, recovery and calibration (shadow mode): implementation report

| | |
| --- | --- |
| **Status** | **LOCAL, OWNER VISUAL REVIEW REQUIRED (2026-09-24).** Four implementation commits, one review-fix commit and this record on `feature/phase-2d-decision-quality`; not pushed, no PR, not merged. Real Jev NOT CONNECTED; Q8 OPEN; browser mutable RPCs still 2; no execution authority added. |
| **Base** | `feature/clinical-phase-1` at `6adc4a7e7741950967f83577013f8b293a0e16a9`, the PR #10 merge that integrated 2D.1 (a normal merge; parents `f195c2a7` and `4966655b`). Post-merge CI Check #65 (run 36037591630): Build, Test, Typecheck, ESLint and Database security & reproducibility passed; only the historical e2e baseline (9 failed, 1 skipped, the same cases) and the Prettier baseline (`sampleCsv.test.ts`, `canAccess.test.ts`) are red. `main` unchanged at `a863e2a0`. |
| **Branch** | `feature/phase-2d-decision-quality` |
| **Governing records** | [PHASE_2D1_REPORT.md](PHASE_2D1_REPORT.md); decision P ([DECISIONS.md](DECISIONS.md)): a provider-neutral DecisionPort, Jev in shadow mode first, never authoritative. |
| **Data** | Synthetic and test data only. BASELINE Q8 OPEN. No real patient data; no production deploy. |

## 1. What this batch is

2D.1 stored one advisory shadow evaluation per synthetic or test lead triage review. This batch makes that record trustworthy enough to measure, without giving it any authority:

- **2D.2, contract hardening and recovery.** Policies are immutable and versioned. Reason codes come from a closed vocabulary. The owner has a narrow, idempotent repair for a request that never ran.
- **2D.3, calibration.** Aggregate agreement counts between the engine's recommendations and human decisions, per policy and provider version, on a read-only Company OS tab.

**Authority is unchanged.** Every outcome is still "human review required", the deterministic Company Engine owns the classification, and no decision, send, CRM write or stop act was added anywhere.

## 2. Contract hardening (2D.2)

- **Migration `20260926120000_decision_quality.sql`** (forward only, one file).
- **`ops.decision_policies`**, an immutable registry.
  - `decision_shadow.v1` (2D.1) is recorded and RETIRED; `decision_shadow.v2` is current.
  - Exactly one version is current (a unique partial index).
  - A version is never edited, deleted or truncated, and it is retired once (ENABLE ALWAYS triggers).
  - A CHECK binds each row to its executable vector version, so no version exists without an executable meaning.
  - RLS is enabled and forced; no role holds any privilege on it.
- **`ops.decision_policy_outcome(version, vector)`** has one fixed branch per version. A new meaning is a new version, never an edit. v1 and v2 classify identically (`abstained`, `high_caution`, `low_confidence` below 0.6, `recommendation_available`); v2 only narrows what a vector may say. The 2D.1 function `ops.decision_shadow_policy` now delegates to the v1 branch, so it keeps its exact meaning.
- **A closed reason vocabulary, `lead_triage_reasons.v1`.** It has 11 codes:
  - `triage_complete`, `intent_book_appointment`, `intent_pricing`, `intent_information`;
  - `flag_possible_crisis`, `flag_minor`, `flag_spam`;
  - `contact_do_not_contact`, `outcome_out_of_scope`, `outcome_needs_input`, `insufficient_signal`.
  
  `decision_vector.v2` must use only these codes; an unknown code is refused, never coerced. The database (`ops.lead_triage_reason_codes_v1`, `ops.decision_vector_valid`) and the worker (`LEAD_TRIAGE_REASON_CODES`, `DecisionVectorSchema`) hold the same list, and a driver-backed test keeps them in step. v1 vectors stay valid as stored history, under the pattern check they were stored with.
- **Evaluations keep their exact version.**
  - `policy_version` is a foreign key to the registry.
  - A completed row's outcome must equal THAT version's classification of its vector. The check is NULL-safe: an unclassifiable vector cannot pass.
  - The vector's version must be the policy's, also NULL-safe; the vector check types every value before comparing it, so a JSON null never passes.
  - Idempotency stays per (review, version): a new version is a new evaluation, and a completed one is never rewritten.
- **The lifecycle follows the version.**
  - A request uses the current version.
  - A request made under a version since retired is refused `policy_retired` at its start and never evaluated under it.
  - The start hands the worker the vector version it expects. The handler asks the provider only when that is `decision_vector.v2`. Otherwise it throws, so the start rolls back and the evaluation stays pending, for a compatible worker or `decision recover`.
- **`get_review`'s `shadowDecision`** gains `policyVersion`, prefers the current version's evaluation, and can carry the `policy_retired` refusal.

## 3. Recovery (2D.2)

`npm run ops -- decision recover --review <uuid> --tenant <uuid>` calls `ops.recover_shadow_decision`. It is owner only: SECURITY INVOKER, executable by no role, and reached by no `company_os_api` function. Its outcomes:

| Outcome | When | What it does |
| --- | --- | --- |
| `created` | No evaluation under the current version | Requests one, as the post-settlement step would have (`trigger_source = operator.recover`) |
| `stopped` | An active stop covers it | Nothing is created, enqueued or recorded; run it again once a person has cleared the stop. The post-settlement request keeps owner decision E: a request made under a stop is recorded refused, with no job. |
| `repaired` | Pending, and its job is missing or ended without starting it | Attaches exactly one new job (the guard now allows a pending → pending job replacement). A job being started is `leased` and held `for share` by `ops.leased_job()`, so it is never replaced. |
| `in_progress` | Its job is queued or leased, or it was started under a live lease | Nothing |
| `already_complete` | Settled (completed, invalid, failed or refused) | Nothing; never rewritten |
| `indeterminate_requires_human_operator` | Started, and no live lease (running or indeterminate) | Nothing: the provider may have been asked, so it is NEVER asked again |
| `not_eligible` | Outside the synthetic and test scope (BASELINE Q8), or not a lead triage review with a stored result | Nothing |

Every outcome is idempotent. Recovery decides no review, sends nothing, writes no CRM row and trips or clears no stop. SI-39's act allowlist gains `decision recover`: a reviewed extension of the invariant, **whose wording needs the owner's confirmation** (the SI texts are owner-approved).

## 4. Calibration (2D.3)

`ops.cos_decision_intelligence(tenant)` is returned inside the overview projection (`overview.decisionIntelligence`), because the `company_os_api` catalogue stays at its 17 functions. It gives counts only, per policy version and provider identity:

- evaluations, recommendations, abstentions, pending, indeterminate, invalid, failed and refused ones;
- reviews with a human decision, comparable pairs (a recommendation AND a human decision), agreements and disagreements;
- the distribution by recommendation and by human outcome.

It carries no id, name, text, input, reason or time. It is **AGREEMENT, never accuracy**: a human decision is not ground truth. The contract checks that agreements plus disagreements equal the comparable pairs. Tenant isolation is by the caller's tenant, as for every read.

**The Company OS view.** Decisões gains a read-only tab, "Inteligência" (`?view=intelligence`).
- It carries the badge "Modo sombra" and the fixed text: "Estes números comparam recomendações do motor com decisões humanas. Eles não representam uma medida de acurácia clínica ou verdade objetiva."
- Six neutral cards cover the current policy version: Avaliações em sombra, Com decisão humana, Concordâncias, Discordâncias, Sem recomendação, Indeterminadas.
- Agreement always shows its denominator ("4 de 6 comparáveis"). A rate appears only from 5 comparable pairs, and the distributions only from 5 evaluations.
- Older versions are listed apart and never added in.
- There is no chart, no score, no colour judgement and no control.

A review's section adds the policy version, the provider version and the reason codes as the owner reads them ("Possível situação de crise", "Pergunta sobre valores", and so on). A code outside the current vocabulary reads "Motivo de uma versão anterior". The raw codes stay under "Detalhes técnicos".

## 5. Jev readiness (documentation only)

**REAL JEV CONNECTIVITY = NO.** Nothing about Jev was invented: no package, endpoint, SDK, authentication, pricing or API contract. `JevDecisionProvider` stays the 2D.1 boundary that reaches nothing. Before a real Jev slice can start, the owner must approve all of the following:

1. **A verified API or SDK:** its name, version, licence, hosting (self-hosted or a service) and provenance, under the open-source-first rules and `.claude/rules/dependency-safety.md`.
2. **An authentication model:** a credential held by the worker only, in a backend environment variable, never `VITE_`; its rotation and scope.
3. **A request and response schema** mapped to `decision_input.v1` and `decision_vector.v2`, or to new versions of them, with the reason vocabulary. Anything else is a new version, never an edit.
4. **Price and cost semantics:** the decision job kind has no price, spend reservation or settlement yet. A real call needs them under the same fail-closed rules as model calls (ADR 0017).
5. **Timeout and idempotency:** whether the provider accepts an idempotency key, its latency bounds, and how an ambiguous answer is classified (indeterminate, never retried: at most once).
6. **Data processing terms:** what the provider may retain or learn from, and where it processes data. This is part of Q8 and the LGPD position; while Q8 is open, only synthetic or test inputs, and the allowlisted input already carries no body, draft or identity.

## 6. Evidence (local)

| Suite | Result |
| --- | --- |
| `test:db` | 18/18 (after the review fixes, `decision_shadow.sql` and `company_os_api.sql` re-run green on a fresh reset). `decision_shadow.sql` gains D12 (registry and history), D13 (vocabulary), D14 (recovery), D15 (calibration) and mutants X6 (a vocabulary admitting a free-form code) and X7 (a recovery re-asking a started evaluation), each caught. `company_os_api.sql` pins the new read callee and the overview's new key paths. |
| `test:db:engine` | 320/320 in 44 files, including the new `decisionQuality.dbtest.ts`: vocabulary parity, a repair asking the provider exactly once, a started evaluation never re-asked, two concurrent recoveries recording one evaluation and one job, two concurrent repairs attaching one new job. |
| `test:db:upgrade` | PASS (legacy data kept its meaning) |
| `functions` | 2033/2033 (security invariants, migration guard, contracts, CLI), re-run after the review fixes |
| `app` | 452 passed, 1 skipped (the known skip); the Company OS subset is 205/205, with the new view, the section labels and the read-only sweep over the new route |
| typecheck, lint (changed files), Prettier (changed files), build, `scan:build`, production scope, signing key | green |

## 7. Review (one focused pass)

One read-only reviewer covered the four implementation commits. It found **no P0 or P1**. It checked:

- recovery racing the worker's start (at most one live job, never a second provider call);
- the relaxed guard (running never returns to pending);
- access and search paths, tenant scoping, and `read_overview` (identical apart from the new key);
- existing v1 rows (they revalidate; a v1 pending request is refused `policy_retired`);
- the contract against the SQL, and the wording.

Every finding it raised is settled in `e8e9dec2`:

| Severity | Finding | Disposition |
| --- | --- | --- |
| P2 | `decision_vector_valid` let a JSON null version or provider kind through `not in`; the vector-version check passed on NULL. Nothing bad could be stored (the outcome checks held), but the SQL and TS validators disagreed. | Fixed: typed first, NULL-safe check; null cases in D1 and the parity dbtest |
| P3 | A vector-version mismatch in the handler settled the evaluation `failed` for good. | Fixed: it throws, so the start rolls back and the evaluation stays repairable |
| P3 | Recovery's `stopped` meant "recorded refused for good" for a missing request, but "try again later" for a pending one. | Fixed: under a stop, recovery records nothing in both cases |
| P3 | Lease liveness used `now()`, where `ops.leased_job()` uses `clock_timestamp()`. | Fixed |
| P3 | The contract capped the groups at 200 while SQL does not; groups sorted as text (`v10` before `v2`). | Fixed: no cap; sorted by version number |

**A deploy note, not a defect.** A 2D.1 worker still running after this migration ignores `vectorVersion` and answers v1, and the database stores that answer `invalid`, never as a recommendation. Stop old workers before, or with, the migration.

## 8. What this batch does not do

It connects no real Jev and adds no Model Router, Judge or multi-model vote. It adds no observability platform (2E), no scheduling, memory, RAG or growth, and no autonomous WhatsApp action. It adds no browser mutation, no new queue, worker, scheduler or job kind, and no dependency. It opens nothing of Q8 and touches no real patient text.
