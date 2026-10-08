# Current state

**What this is:** the operational state a fresh session reads after CLAUDE.md. It changes with every merged milestone (the maintenance rule in CLAUDE.md). The stable product and architecture are in [COMPANY_OS_MASTER_BLUEPRINT.md](COMPANY_OS_MASTER_BLUEPRINT.md). The long-term program map is in [ROADMAP.md](ROADMAP.md).

**Updated:** 2026-10-07, after PR #32's merge (`02ae43e7`) and staging's update to it, on `feature/lead-journey-core`.

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

> Repository state overrides stale conversation history. Verify SHAs with `git fetch origin` before acting: this file can lag one merge behind.

---

## 1. Branches

| Item | State |
| --- | --- |
| Repository | `yurizache-cpu/atomic-crm` (public: never commit a real phone number, a secret or patient data) |
| Integration branch | `feature/clinical-phase-1` at `02ae43e7`: PR #32's normal merge (2026-10-07; parents `90be88dc`, PR #31's merge, and `ddd4b162`, the tree equal to the reviewed head) |
| `main` | `a863e2a0`. Never touched by this program; no production deploy |
| Open PR #33 | `feature/lead-journey-core`, from `02ae43e7`, into `feature/clinical-phase-1`: the exception queue (§3) |
| Retained, integrated | `feature/front-desk-pack-v4` at `ddd4b162` (PR #32); `feature/front-desk-prompt-v4` at `af6d12b3` (PR #31); `feature/company-os-master-blueprint` at `c6b930dd` (PR #30); `feature/front-desk-review-context` at `d35325da` (PR #29) |

## 2. Integrated capabilities (on `feature/clinical-phase-1`)

By layer. Detail in each ADR and report.

- **Company OS core:**
  - tenants, companies, departments, agents, tasks and events in `ops` (ADR 0015);
  - the Postgres job queue and worker with lease-bound tenancy (ADR 0001, ADR 0012);
  - agent runs at most once (ADR 0016);
  - versioned prices, spend limits and the kill switch (ADR 0017, ADR 0010).
- **Governance and security:**
  - Q8 fail-closed enforcement, data classes, and content and identifier retention (ADR 0020, ADR 0021 W1 to W6);
  - Production Security Gate A (AAL2 for the Company OS and CRM data, CSP, no third-party enrichment);
  - the Gate B host contract and verifiers;
  - 80 security invariants (SI-01 to SI-81, SI-07 retired) with live guards ([SECURITY_INVARIANTS.md](SECURITY_INVARIANTS.md));
  - 75 canonical migrations, the latest `20261015120000_front_desk_handoff_names.sql`.
- **Models:**
  - OpenRouter as the gateway;
  - model registry and pools filtered by Q8;
  - agent profiles with enforced ceilings;
  - Jev structured decisions in shadow (business route, model route, lead intelligence);
  - model economics (ADR 0022).
- **Layer 1, Operations:**
  - WhatsApp transport for test channels, with a signed gateway and supervised human send (ADR 0018);
  - the LGPD minimum: privacy notice and identifier clock (ADR 0021);
  - the front-desk agent (ADR 0023): a local screen with pack `health_pt_br.v4` (screen `front_desk_screen.v3`; v4 recognises how leads ask for a person, and the team members the operating policy's `handoffNames` lists), versioned configuration with the assistant's name and locale, conversation state, takeover, grounding check, and prompt `lead_triage.v4` (the receptionist the owner chose, on Gemini 3.8 Flash), whose context says when the contact wrote and lists up to ten free slots;
  - the review of synthetic or test data shows the screened message and the reply draft, and a reply the contact's newer message made stale (admitted or refused) is never sent: the last gate holds the conversation through the provider call (ADR 0023 §L, SI-81);
  - the follow-up engine and the booking foundation, with a fake calendar port (Phase 3A);
  - the commercial funnel with four narrow acts and the follow-up bridge (Phase 3B).
- **Layer 3, Management (foundation):**
  - the operator surface `src/company-os/`: overview, tasks, runs, activity, reviews with Jev decisions, decision intelligence, operational health, agenda, funnel, costs, agents, communications and stops;
  - two plus four narrow browser acts (ADR 0019).
- **Layer 2, Growth:** nothing beyond the CRM's `acquisition_attributions` table and lead intelligence in shadow.

The status of every workstream is in the [ROADMAP.md](ROADMAP.md) program map.

## 3. Active work

**Just integrated:**

- **PR #32** (merge `02ae43e7`, 2026-10-07; ADR 0023 §C, §D): pack `health_pt_br.v4` and configured `handoffNames` (migration `20261015120000_front_desk_handoff_names.sql`). On two blind samples of ordinary traffic v4 recognised 65 and 62 of 77 requests for a person (v3: 25 and 20), with no false handoff in about 550 messages. The automated review's P2 (a relative's name discounted every configured name) was fixed before the merge; its P1 (declare the two functions in `supabase/schemas`) does not apply, since the `ops` schema has always lived in migrations only. PR CI on `ddd4b162` (both runs) and the post-merge run 37610865276 on `02ae43e7` match the historical baseline (§7).
- **PR #31** (merge `90be88dc`, 2026-10-06; ADR 0023 §C, §E): receptionist v4. It brings prompt `lead_triage.v4`, pack `health_pt_br.v3`, the grounding check's duration rule and migration `20261014120000_front_desk_context_received_at.sql`. PR CI on `af6d12b3` (both runs) and the post-merge run 37466466840 on `90be88dc` match the historical baseline (§7). The automated review did not run (the Codex account reached its usage limit); a manual review found nothing blocking, and found the gap that pack v4 closes (§3, item 1).
- **PR #30** (merge `9069f5c1`, 2026-10-06; ADR 0024): the canonical project memory, docs only, brought up to date with PR #29's merge before its own. The automated review's one P2 (the event catalog's subject types) was fixed before the merge. PR CI on `c6b930dd` matched the historical baseline (§7).
- **PR #29** (merge `33c03771`, 2026-10-06; ADR 0023 §L, SI-81): the review context, the stale-reply closure (the automated review's two P1 fixed before the merge) and pack `health_pt_br.v2`. Migrations `20261012120000_front_desk_review_context.sql` and `20261013120000_front_desk_stale_reply_closure.sql`. PR CI on `d35325da` and the post-merge run 37453392364 on `33c03771` both match the historical baseline (§7): Build, ESLint, Typecheck, Test and Database pass; e2e exactly 9 failed and 1 skipped; Prettier exactly the two baseline files.

1. **`feature/lead-journey-core`: the exception queue** ([ADR 0025](adr/0025-exception-queue-and-lead-journey-decisions.md) Part A, Proposed for the owner's review; SI-82, SI-80 amended).
   - **What it is:** `ops.exceptions`, one store of the moments a person must act on. The database raises them where the facts are decided:
     - the screening raises danger, a request for a person and an opt-out (whoever holds the conversation), a missing fixed text, a message waiting with a person, and a contact no reply can reach;
     - a send's state raises a failed or uncertain send, recorded after its settlement, never inside it.
   - At most one exception is open per subject and kind. A repeat is counted on it, and a person resolves it only by naming the count the person saw. It is resolved once (by a release, provider evidence, a reachable contact, or a person's act) and recorded as `exception.raised` and `exception.resolved` (source `exception-queue`).
   - **Not covered yet:** a run that ends after its screening sent it to the model (the agent's daily ceiling, a refusal at the run's start, a failed or indeterminate run) raises nothing (ADR 0025 A5).
   - **A3:** a front-desk message whose admission says no reply can reach the contact gets no model. A release is refused while danger or an opt-out is open. On acceptance, both amend ADR 0023 §G.
   - **Owner tool:** `npm run front-desk -- exceptions | exception resolve (--occurrences) | exceptions sync`.
   - **Migration:** `20261016120000_exception_queue.sql`.
   - **Reviews:**
     - an adversarial review of the implementation (four lenses, each verified) confirmed 11 findings, answered in `d3e0e61c`. The main one: an open episode absorbed a repeat in silence, so a person could resolve danger without seeing a newer danger message. A repeat is now counted, and the act names the count it saw.
     - The automated review of PR #33 posted two P2, answered in the next commit: an unknown consent is labelled `contact_unresolved` / `consent_unknown`, never an opt-out, and a capped listing says it is capped.
   - **Local evidence (2026-10-07, last head):**
     - typecheck, ESLint and Prettier clean;
     - `functions` 2,527 tests;
     - 27 SQL suites (new F8);
     - 455 driver-backed cases (new `exceptionQueue.dbtest.ts`). The committed browser recordings were re-recorded: the tenant feed has one more event, `exception.raised`;
     - the `app` project and the upgrade replay pass.
   - **PR CI on `d3e0e61c`:**
     - the push run matches the historical baseline (§7): core PASS, e2e exactly 9 failed and 1 skipped, Prettier exactly the two baseline files;
     - the pull_request run's e2e job ran no test: the runner hit a container-registry rate limit while starting the stack, an infrastructure failure.
   - **Next:** CI on the new head, then the owner's review of ADR 0025 Part A; merge only on the owner's request. After the merge, on staging: apply `20261016120000` (pinned CLI, dry run first, never the seed), run the hosted verifier, then `front-desk exceptions sync` once for the sends that already exist.

## 4. Staging (cost-first, [COST_FIRST_STAGING.md](COST_FIRST_STAGING.md))

- **Supabase** `erhrochojnugszkkoqrv` (sa-east-1, PostgreSQL 17):
  - all 75 integrated migrations through `20261015120000`, never the seed: PR #29's two and PR #31's one were applied on 2026-10-06, PR #32's one on 2026-10-07 (pinned CLI, dry run first); the hosted verifier then reported 0 blocking and 0 advisory findings.
- **Frontend:** the Netlify site `atomic-crm-staging`, republished on 2026-10-06 from the integrated code (PR #29; Netlify deploy `6ac4dff19a75e014e31006e8`; preflight 0 blocking, live check 0/0). The review page shows the screened message and the reply draft (checked in the browser). PR #31 changed no frontend code.
- **Runtime:** local only (`scripts/with-staging.mjs`: worker, gateway). No Fly, no always-on webhook.
- **Tenant** `265b8fb8-839f-4351-a503-fe38f75822d1`; Receptionist agent `2ed31fc7-3509-46aa-99ff-507d06c90b7d`.
- **Channels (both `test` mode, the owner's device registered):**
  - `8db3c466…` on Meta's test number, for live tests (the Meta app is in development mode, so only the test number delivers);
  - `85ae4f8b…` on the future clinic number, used for loopback pre-checks.
- **Models:**
  - pool `reception_low_cost`: Gemini 3.8 Flash rank 1, GPT-6 Luna rank 2, Haiku 4.5 rank 3 (since 2026-10-06);
  - Qwen 3.5 Flash disabled: its only host breaks strict structured output;
  - prices current until 2026-12-31.
- **Front-desk configuration published:**
  - operating policy v4, 2026-10-07: v3's content (persona "Lia", provisional; locale `pt-BR`; scheduling connected to a test agenda) with pack `health_pt_br.v4`, and no `handoffNames` until the owner confirms the team's names;
  - playbook v3, knowledge v2 and fixed messages v2.
  - **Pre-check (2026-10-07, loopback, synthetic, nothing sent):** a request for a person on channel `85ae4f8b…` was screened with pack v4 under policy v4, got the handoff text with no model call, and moved the conversation to a person; it was then released.
- **Test agenda:**
  - resource `26e8a919…` and booking type `4d29d51d…` (50 minutes);
  - weekly rules built from the owner's free times of the week of 2026-10-05 (times only, no patient), valid until 2026-10-31.
- **Spend:** global and tenant limit US$0.16 per day; the Receptionist's ceiling US$0.50 per day; the OpenRouter test key had about US$1.85 of its US$5 used on 2026-10-06.
- **Measured 2026-10-06** (loopback pre-check, synthetic, nothing sent): Gemini 3.8 Flash through the engine reasoned 1,000 to 2,500 tokens per reply (12 to 21 s, US$0.007 to US$0.013). A per-model reasoning-effort setting is an open question. Four pending reviews from that pre-check sit on channel `85ae4f8b…` and are never sent.

## 5. Owner actions and external dependencies

| # | Item | Blocks |
| --- | --- | --- |
| 1 | The persona name ("Lia" is provisional), how and when the video-call link is sent (missing from the knowledge), and whether to test Gemini with less reasoning | The live receptionist test's quality |
| 2 | ADR 0021 W6, lead creation for a new WhatsApp number: **decided 2026-10-08** ([ADR 0025](adr/0025-exception-queue-and-lead-journey-decisions.md) B1 (b)): an owner act creates the contact from a held conversation, marked do-not-contact until a person confirms. It needs B2 (the contact write adapter) to be built | Real lead entry (workstream A) |
| 2a | ADR 0025: accept or amend Part A (the exception queue, and A3, which amends ADR 0023 §G); decide Part B, B2 to B6 (CRM contact writes, identity resolution, attribution, structured triage and its health fields, lead event subjects). B1 and B7 were decided on 2026-10-08, option (b) each | The exception queue's merge; the rest of milestone 2 |
| 3 | ADR 0021 W7 (a production webhook host; Netlify recommended) and W8 (Meta actions: templates, app live); the system-user token expires 2026-12-01 | Production WhatsApp; messages outside the 24-hour window |
| 4 | A payment provider | Workstream C |
| 5 | Calendar provider authentication, token storage and data-processing terms (Google Calendar, Meet) | Workstream B's calendar part |
| 6 | Google Ads conversion feedback: identifiers, lawful basis, health-advertising policy ([GROWTH_INTELLIGENCE_SPEC.md](GROWTH_INTELLIGENCE_SPEC.md) §6) | Workstream F's uploads |
| 7 | The production frontend host ([DECISIONS.md](DECISIONS.md), OPEN) | Go-live (workstream J) |

## 6. Production gates

- **PRODUCTION REAL-DATA AUTHORIZATION: CLOSED.** No Q8 model-data authorization is recorded.
- **REAL PATIENT MODEL TRAFFIC: DISABLED.** A real sender's message is `health` and is refused before any model. No health information goes to AI through OpenRouter.
- **Production WhatsApp gate: CLOSED** (ADR 0018, ADR 0021: W7 and W8 open).
- **Send mode:** `supervised`. `autonomous` is not representable.
- **Deployments:** no production deploy; `main` untouched.

## 7. Historical CI baseline

A PR is accepted only if its reds are exactly these:
- **e2e-test:** 9 failed and 1 skipped.
  - `adminAccountManagerFilter.spec.ts:42` and `:79`, chromium and Mobile Chrome;
  - `bulkContactTags.spec.ts:3`, chromium;
  - `onboarding.spec.ts:3` and `userAddingATask.spec.ts:42`, both projects.

  Read the ids in the job log, not the colour.
- **Prettier:** exactly `src/components/atomic-crm/dataImport/sampleCsv.test.ts` and `src/components/atomic-crm/providers/commons/canAccess.test.ts`.
- **Everything else must pass:** Build, ESLint, Typecheck, Test, Database security and reproducibility.
- **The Supabase CLI is pinned to 2.117.0.** Locally, always `npx --yes supabase@2.117.0 … --workdir .supabase-e2e`; a bare `npx supabase` pulls a newer CLI and image.

## 8. Next three implementation milestones

From the ROADMAP program map:
1. **Receptionist v4, supervised and live (workstream A):** PR #29, PR #31 and PR #32 are integrated and on staging; the owner's live supervised WhatsApp test on Gemini remains.
2. **The lead journey core (workstreams A and E):**
   - lead creation for new numbers (after the W6 decision);
   - deterministic identity resolution;
   - attribution capture at entry;
   - structured triage (paths A and B);
   - the first catalogued events (`lead.created`, `lead.attribution_captured`, `triage.completed`, `exception.raised`). `exception.raised` and `exception.resolved` are built on `feature/lead-journey-core` (ADR 0025 Part A); the rest waits on ADR 0025 Part B.
3. **Scheduling in the journey (workstream B):** offering real slots in conversation, the booking page with holds, `outcome.first_appointment_booked`, and rescheduling and cancellation through the conversation. Calendar and Meet follow once the provider decision is made.

## 9. Exactly next action

1. **PR #33, the exception queue** (§3, item 1): CI on its new head against the baseline (§7), then the owner's review of ADR 0025 Part A and the merge on the owner's request.
2. **Team names (`handoffNames`):** the owner chose none for now (2026-10-08). Operating policy v4 stays published; a request for a person by role or in general still hands over.
3. **Run the live supervised receptionist test** on the Meta test number (the owner's device must be a CRM contact with the opt-out recorded false, [COST_FIRST_STAGING.md](COST_FIRST_STAGING.md) §12):
   - a fresh quick tunnel to the local gateway and a fresh verify token, which the owner pastes into the Meta app's webhook settings (the WhatsApp Business Account product);
   - the gateway (`npm run whatsapp:gateway`) and the worker (`npm run staging:gateway-worker`), both through `scripts/with-staging.mjs`, from the integrated code;
   - each reply accepted by the owner in the browser at AAL2, then carried by `npm run messaging -- send`. The 2026-10-05 autonomous test used a session-local auto-accept script that is not in the repository and is not a product feature;
   - then stop everything and rotate the verify token.
4. **Then the rest of milestone 2 of §8,** once the owner decides ADR 0025 Part B.
