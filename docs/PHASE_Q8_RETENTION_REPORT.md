# BASELINE Q8 — D6/D7 AI working-content retention and redaction report

**Status:** **Q8 D6/D7 RETENTION: INTEGRATED (2026-09-28).** Built on `feature/q8-retention-redaction` (from `feature/clinical-phase-1` at `99666512`); PR #17, normal merge `c388bf53b3236a1b5d9d0bb552c58541c06d36f0` into `feature/clinical-phase-1` (parents `99666512`, `fb234afe`); the source branch `feature/q8-retention-redaction` is retained at `fb234afe`, and `main` is unchanged at `a863e2a0`. The automated review's P1 (a due flow still in progress spent its job's retries and could be left with no job) was fixed before the merge in `fb234afe`. Post-merge Check #94 (run 36445210729): Test, Build, Typecheck, ESLint and Database security & reproducibility PASS; the workflow stays red only for the historical baseline, e2e exactly 9 failed and 1 skipped and Prettier exactly 2 errors; no new regression. The retention fallback (§9) is the final internal-retention correction. *(Superseded status: "implemented; integrated by one PR".)*
**Decision record:** [ADR 0020](adr/0020-real-data-model-authorization.md) §H (owner decisions D6 and D7) and §I (this implementation).
**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.** This batch enforces the lifecycle of content the model boundary already guards. It enables nothing.

## 1. What D6 and D7 require

- **D6:** AI working content is kept 30 days after the review that completes its flow. This is not clinical-record retention.
- **D7:** content is redacted in place, non-content audit evidence is kept, and audit history is never hard-deleted.

## 2. The content, traced

Traced from the lead-triage input to the decision:

| Row | Content (redacted) | Content-derived unkeyed digest (nulled) |
| --- | --- | --- |
| `ops.tasks` | `description` (the admitted body) | `request_fingerprint` (sha256 over the task request, description included) |
| `ops.agent_runs` | `result` (advice and reply draft) | `input_fingerprint` (sha256 over the minimised prompt input) |
| `ops.review_items` | `proposed` (the copy of the result), `decision_note` (the reviewer's free text) | — |
| `ops.inbound_messages` | — (it never held the body) | `body_fingerprint` (sha256 over source, sender and body) |

**Kept, because none of it is content:**
- every id;
- the class, the status and the decision;
- the reviewer, the instants and the cost;
- the usage counts and refusal codes;
- the provider and model;
- the authorization reference and the idempotency keys;
- every event and act log;
- the run's request fingerprint (ids only).

**Not in this batch's scope, recorded as follow-ups:**
- **The decision-shadow input fingerprint** hashes classification enums only. Protected classes never reach it (SI-71).
- **The contact reference, conversations and every WhatsApp identifier** stay ADR 0018's decision, which production WhatsApp still needs.
- **Provider-side copies** are ADR 0020 §C evidence, not this database lifecycle.

## 3. The clock

- **Anchor:** the database's `reviewed_at` of the task's latest decided review (`now()` in `ops.record_review_decision`). A later decided review of the same task moves it forward, never back.
- **Days:**
  - where a model-data authorization applied, the one the anchoring run relied on sets the days through its `content_retention_days` (1 to 30);
  - where none applied (the in-process provider, local and test only), the days are 30;
  - never more than 30.
- Days are 24-hour days, so the due instant does not depend on a session's time zone.
- **Scope:** `health` and `person_text` tasks only. `synthetic` and `test` content has no D6 clock.
- ~~**Flows with no decided review:** every authorized person-content capability (`lead_triage`, the only one) reaches the review lifecycle. A flow whose run failed, was refused or is indeterminate, or whose review is never decided, has no clock. Explicit erasure covers it. **A policy for such abandoned flows is an owner decision this batch does not take.**~~ *(Decided by the owner on 2026-09-28 and built as the fallback clocks, §9.)*

## 4. The mechanism

- **Ledger:** `ops.content_retention` holds one row per protected task. It records:
  - the anchoring review, its instant, the days and the authorization relied on;
  - the due instant and the bound job;
  - when, why (`retention_expired` or `erasure`) and by whom the content was redacted.

  It holds no content. Its guards keep the task and class fixed, let the anchor move only forward and make a redaction final. It has RLS forced and no grant.
- **Automatic expiry:** deciding a review of a protected task queues one INTERNAL `content.retention_due` job, available at the due instant. This is the existing queue and the Phase 3A.1 follow-up pattern: no cron and no second queue.
  - The worker's one new lease-bound capability, `ops.redact_due_content()`, resolves the flow from the leased job and never from the payload.
  - A flow still in progress at its deadline (a run pending or running, a review undecided) is deferred. The job queues and binds the flow's next job an hour on, then succeeds, so it never spends its attempts waiting and the flow is never left without a job (the PR review's P1, fixed before the merge).
  - A replay answers `already_redacted`; an earlier anchor's job answers `superseded`.
  - The kind is maintenance, so the kill switch never holds it.
- **Owner sweep:** `npm run ops -- retention sweep --actor <label> [--limit <n>]` redacts, up to the limit (1 to 1000), the flows due and not yet redacted. It skips tasks another transaction holds, so two sweeps or a sweep and the worker never process one flow twice.
- **Owner erasure (D7):** `npm run ops -- retention erase --tenant <uuid> --task <uuid> --actor <label>` redacts one task's flow now, in its own tenant only.
  - It is refused while a run is pending or running or a review is undecided.
  - It is refused for any class but `health` and `person_text`.
  - No browser, gateway or worker path reaches it.
- **Read:** `npm run ops -- retention list [--tenant <uuid>]` lists ids, classes, instants and reasons.

## 5. Redaction semantics

- **One transaction, one instant:** `ops.redact_task_content` locks the task, then the ledger row. It records the redaction, then removes the content and the digests above and sets `content_redacted_at` on every row to the ledger's instant.
- **Guards:** every guard that keeps those rows immutable asks `ops.content_redaction_permitted` first. It admits only a redaction the ledger records at that instant, which removes the named content and changes no other column. Everything else is refused:
  - content written back;
  - a marker cleared or moved;
  - a redaction that also changes a decision.

  Constraints keep a redacted row's content absent.
- **Follow-on:**
  - A redacted task gets no new run.
  - A redacted review's send is blocked (`content_redacted`), never attempted.
  - The task keeps its class (`health` stays `health`).
  - The authorization a redacted run relied on stays provable and undeletable.

## 6. Security

- **SI-72 (new):**
  - protected content is gone once its deadline is processed;
  - redaction changes no content-free audit fact and deletes no row;
  - only the owner (and the worker's bound job) can redact;
  - a tenant cannot redact another tenant's content;
  - the ledger holds no content and no application role reads it.
- **SI-39 (extended):** `retention erase` and `retention sweep` join the operator CLI's act allowlist.
- **SI-70:** its caveat now points to SI-72.
- **P0:** none. **P1:** none open.
- **Found and fixed during the batch:** a redacted review would otherwise have handed `begin_outbound_send` a null draft. It is now blocked, and a new run about a redacted task is refused.
- **Mutation-checked:** removing the "changes nothing else" check from the guard helper makes `content_retention.sql` G3 fail by name.

## 7. Validation (local, once)

- New `supabase/tests/content_retention.sql`, sections A–K: the clock, before and at the deadline, repeats, erasure, tenant isolation, the guards, privileges, the send block, the moving anchor and the deferral of a flow in progress.
- `test:db`: 23/23 suites, on a clean reset with the new migration.
- `test:db:engine`: 402/402 in 54 files, including the new `contentRetention.dbtest.ts` (3 cases through the real worker loop).
- The `functions` project: 2207/2207 in 96 files, with security invariants 79/79 and the static migration guards green.
- Upgrade replay over legacy data: PASS.
- Typecheck green; ESLint 0 errors; build and bundle scan 0 blocking; production scope and signing-key guards OK.

## 8. Remaining gates (unchanged by this batch)

Before any real authorization:
- contract coverage for sensitive health data and a DPA;
- zero-data-retention and retention evidence;
- the exact provider, project and model;
- the lawful basis and an international-transfer mechanism;
- for WhatsApp, ADR 0018's own gate: a new Accepted ADR, the live Meta probe and the PUBLIC helper decision.

## 9. The retention fallback: the final internal-retention correction (2026-09-28)

Built on `feature/q8-retention-fallback` from `feature/clinical-phase-1` at `c388bf53`, by migration `20261003120000_content_retention_fallback.sql`. **INTEGRATED:** PR #18, normal merge `c4938029e9d185af0c7716892924c93199d3c5e6` into `feature/clinical-phase-1` (parents `c388bf53`, `b354be29`); the source branch `feature/q8-retention-fallback` is retained at `b354be29`, and `main` is unchanged at `a863e2a0`. The automated review's one finding (P2, in scope: two reviews decided at one instant could keep the longer period) was fixed before the merge in `b354be29`. Post-merge Check #99 (run 36457607762): Test, Build, Typecheck, ESLint and Database security & reproducibility PASS; the workflow stays red only for the historical baseline, e2e exactly 9 failed and 1 skipped and Prettier exactly 2 errors; no new regression.

- **Owner policy (final):** no `health` or `person_text` AI working content may remain indefinitely merely because its flow never reached a decided review.
- **One effective state per protected task,** derived by `ops.content_retention_anchor` from the task's own rows, in this order:

  | Reason (`anchor_reason`) | When it applies | Anchor | Days |
  | --- | --- | --- | --- |
  | `review_decided` | a review of the task is decided | the latest decided review's `reviewed_at` | the relied-on authorization's `content_retention_days`, or 30 (unchanged D6); two reviews decided at one instant take the shorter period |
  | `review_undecided` | otherwise, a review exists | the latest review's `created_at` | 30 |
  | `terminal_without_review` | otherwise, a run finished (`succeeded`, `failed`, `indeterminate` or `cancelled`) | the latest `completed_at` | 30 |
  | `task_created` | otherwise | the task's `created_at` | 30 |

- **Precedence:** the clock only moves forward (or, at an equal instant, to a reason of higher precedence), and no fallback ever displaces a decided review's clock. A redaction is final.
- **When it is applied:** when the task is created, when a review of it opens, when one is decided, and whenever its job fires or the owner sweeps it (`ops.refresh_content_retention`). A run's terminal instant is read then, never written inside the run's settlement, so nothing here can roll a paid settlement back.
- **One job per flow:** the bound job is moved in place while it is queued; a new one is queued and bound only when the bound one is running or finished.
- **Safety:** only a run pending or running defers automatic expiry. The job then leaves exactly one next job an hour on, so nothing exhausts its retries and no due flow is left without a job. An undecided review no longer holds expiry: past its fallback it is redacted and stays pending with no content. The owner's erasure keeps its stricter rule (refused while a run is active or a review undecided).
- **Redaction:** unchanged (§5). Content is removed in place, the fingerprints are nulled, and no row is deleted. The class stays, and the authorization linkage and every content-free fact stay.
- **Backfill:** every protected task already stored received its state and its one job at the migration.
- **Invariant:** SI-72 extended; numbering unchanged.
- **Tests:** `content_retention.sql` section L (the undecided review, a decision superseding a fallback on the same job, a run ended without a review, a task with no run, repeats, two reviews decided at one instant keeping the shorter period, and exactly one queued job for every unredacted flow). The retention dbtest adds a flow that never reached a review, redacted by the real worker.
- **Status:** **Q8 INTERNAL RETENTION LIFECYCLE: COMPLETE**, meaning model-boundary enforcement, D6/D7 working-content retention and the abandoned-flow fallback. **PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**
