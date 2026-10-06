# Current state

**What this is:** the operational state a fresh session reads after CLAUDE.md. It changes with every merged milestone (the maintenance rule in CLAUDE.md). The stable product and architecture are in [COMPANY_OS_MASTER_BLUEPRINT.md](COMPANY_OS_MASTER_BLUEPRINT.md). The long-term program map is in [ROADMAP.md](ROADMAP.md).

**Updated:** 2026-10-06, after PR #29's merge (`33c03771`), in the Company OS master blueprint milestone ([ADR 0024](adr/0024-three-layer-company-os-and-outcome-engine.md)).

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

> Repository state overrides stale conversation history. Verify SHAs with `git fetch origin` before acting: this file can lag one merge behind.

---

## 1. Branches

| Item | State |
| --- | --- |
| Repository | `yurizache-cpu/atomic-crm` (public: never commit a real phone number, a secret or patient data) |
| Integration branch | `feature/clinical-phase-1` at `33c03771`: PR #29's normal merge (2026-10-06; parents `26c14347` and `d35325da`, the tree equal to the reviewed head). PR #30, this canonical memory, merges on top of it |
| `main` | `a863e2a0`. Never touched by this program; no production deploy |
| Open PR #30 | `feature/company-os-master-blueprint`, the canonical project memory (ADR 0024), into `feature/clinical-phase-1` |
| Retained, integrated | `feature/front-desk-review-context` at `d35325da` (PR #29) |
| Pushed, no PR | `feature/front-desk-prompt-v4` at `6aa80176`, built on PR #29's head; the integration branch must be merged into it before its PR (§3) |

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
  - 73 canonical migrations, the latest `20261013120000_front_desk_stale_reply_closure.sql`.
- **Models:**
  - OpenRouter as the gateway;
  - model registry and pools filtered by Q8;
  - agent profiles with enforced ceilings;
  - Jev structured decisions in shadow (business route, model route, lead intelligence);
  - model economics (ADR 0022).
- **Layer 1, Operations:**
  - WhatsApp transport for test channels, with a signed gateway and supervised human send (ADR 0018);
  - the LGPD minimum: privacy notice and identifier clock (ADR 0021);
  - the front-desk agent: a local screen with pack `health_pt_br.v2` (screen `front_desk_screen.v3`), versioned configuration, conversation state, takeover, grounding check and prompt `lead_triage.v3` (ADR 0023);
  - the review of synthetic or test data shows the screened message and the reply draft, and a reply the contact's newer message made stale (admitted or refused) is never sent: the last gate holds the conversation through the provider call (ADR 0023 §L, SI-81);
  - the follow-up engine and the booking foundation, with a fake calendar port (Phase 3A);
  - the commercial funnel with four narrow acts and the follow-up bridge (Phase 3B).
- **Layer 3, Management (foundation):**
  - the operator surface `src/company-os/`: overview, tasks, runs, activity, reviews with Jev decisions, decision intelligence, operational health, agenda, funnel, costs, agents, communications and stops;
  - two plus four narrow browser acts (ADR 0019).
- **Layer 2, Growth:** nothing beyond the CRM's `acquisition_attributions` table and lead intelligence in shadow.

The status of every workstream is in the [ROADMAP.md](ROADMAP.md) program map.

## 3. Active work

**Just integrated: PR #29** (merge `33c03771`, 2026-10-06; ADR 0023 §L, SI-81): the review context, the stale-reply closure (the automated review's two P1 fixed before the merge) and pack `health_pt_br.v2`. Migrations `20261012120000_front_desk_review_context.sql` and `20261013120000_front_desk_stale_reply_closure.sql`. PR CI on `d35325da` and the post-merge run 37453392364 on `33c03771` both match the historical baseline (§7): Build, ESLint, Typecheck, Test and Database pass; e2e exactly 9 failed and 1 skipped; Prettier exactly the two baseline files.

1. **`feature/front-desk-prompt-v4`, the receptionist the owner chose (Gemini 3.8 Flash; ADR 0023 §C, §E on the branch):**
   - **Prompt `lead_triage.v4`:** voice and rules from the round-two model test; persona and locale as configuration; it says it cannot book.
   - **Pack `health_pt_br.v3`.**
   - **The grounding check's duration rule.**
   - **Migration `20261014120000_front_desk_context_received_at.sql`:** the message's instant and up to ten slots in the context.
   - **Verification:** unit, SQL and pipeline tests are green locally.
   - **Next:** merge `feature/clinical-phase-1` into it (a normal merge), then open its PR into `feature/clinical-phase-1`.
2. **PR #30, this milestone** (ADR 0024): the canonical project memory, docs only, brought up to date with PR #29's merge before its own.

## 4. Staging (cost-first, [COST_FIRST_STAGING.md](COST_FIRST_STAGING.md))

- **Supabase** `erhrochojnugszkkoqrv` (sa-east-1, PostgreSQL 17):
  - the 71 migrations through `20261011120000`, never the seed;
  - it lacks PR #29's two integrated migrations (`20261012120000`, `20261013120000`) and the v4 branch's `20261014120000`;
  - the integrated send path calls `ops.confirm_outbound_send`, which only PR #29's second migration creates, so **apply PR #29's migrations before any send from the integrated code**.
- **Frontend:** the Netlify site `atomic-crm-staging`, published before PR #29: its review page does not show the message and reply section yet. Republish after the migrations.
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
  - operating policy v3 and playbook v3, 2026-10-06 (persona "Lia", provisional; locale `pt-BR`; pack `health_pt_br.v3`; scheduling connected to a test agenda);
  - knowledge v2 and fixed messages v2.
  - ⚠️ **Pack v3 exists only on `feature/front-desk-prompt-v4`.** A worker run from the integrated code (which knows packs v1 and v2) refuses every front-desk run (`screening_pack_unknown`, fail closed). Run the worker from the v4 branch, or publish a policy that names `health_pt_br.v2`.
- **Test agenda:**
  - resource `26e8a919…` and booking type `4d29d51d…` (50 minutes);
  - weekly rules built from the owner's free times of the week of 2026-10-05 (times only, no patient), valid until 2026-10-31.
- **Spend:** global and tenant limit US$0.16 per day; the Receptionist's ceiling US$0.50 per day; the OpenRouter test key had about US$1.85 of its US$5 used on 2026-10-06.
- **Measured 2026-10-06** (loopback pre-check, synthetic, nothing sent): Gemini 3.8 Flash through the engine reasoned 1,000 to 2,500 tokens per reply (12 to 21 s, US$0.007 to US$0.013). A per-model reasoning-effort setting is an open question. Four pending reviews from that pre-check sit on channel `85ae4f8b…` and are never sent.

## 5. Owner actions and external dependencies

| # | Item | Blocks |
| --- | --- | --- |
| 1 | The persona name ("Lia" is provisional), how and when the video-call link is sent (missing from the knowledge), and whether to test Gemini with less reasoning | The live receptionist test's quality |
| 2 | ADR 0021 W6: may a lead be created for a new WhatsApp number? | Real lead entry (workstream A) |
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
1. **Receptionist v4, supervised and live (workstream A):** with PR #29 integrated, apply its migrations to staging, integrate the prompt v4 PR and apply its migration, then run the owner's live supervised WhatsApp test on Gemini.
2. **The lead journey core (workstreams A and E):**
   - lead creation for new numbers (after the W6 decision);
   - deterministic identity resolution;
   - attribution capture at entry;
   - structured triage (paths A and B);
   - the first catalogued events (`lead.created`, `lead.attribution_captured`, `triage.completed`, `exception.raised`).
3. **Scheduling in the journey (workstream B):** offering real slots in conversation, the booking page with holds, `outcome.first_appointment_booked`, and rescheduling and cancellation through the conversation. Calendar and Meet follow once the provider decision is made.

## 9. Exactly next action

1. **Bring staging up to PR #29:**
   - apply `20261012120000` and `20261013120000` to staging (pinned CLI, dry run first, never the seed);
   - publish the staging frontend (the review contract changed);
   - verify the review page in the browser.
2. **Bring the integration branch into `feature/front-desk-prompt-v4`**, open its PR, verify CI against the baseline, address the automated review, merge, and apply migration `20261014120000` to staging.
3. **Run the live supervised receptionist test** on the Meta test number:
   - a fresh quick tunnel to the local gateway and a fresh verify token, which the owner pastes into the Meta app's webhook settings (the WhatsApp Business Account product);
   - the gateway (`npm run whatsapp:gateway`) and the worker (`npm run staging:gateway-worker`), both through `scripts/with-staging.mjs`, from the integrated code;
   - each reply accepted by the owner in the browser at AAL2, then carried by `npm run messaging -- send`. The 2026-10-05 autonomous test used a session-local auto-accept script that is not in the repository and is not a product feature;
   - then stop everything and rotate the verify token.
4. **Then start milestone 2 of §8.**
