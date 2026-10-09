# Current state

**What this is:** the operational state a fresh session reads after CLAUDE.md. It changes with every merged milestone (the maintenance rule in CLAUDE.md). The stable product and architecture are in [COMPANY_OS_MASTER_BLUEPRINT.md](COMPANY_OS_MASTER_BLUEPRINT.md). The long-term program map is in [ROADMAP.md](ROADMAP.md).

**Updated:** 2026-10-09, after PR #34's merge (`679a118a`) and staging's update to it, on `feature/automatic-fixed-texts`.

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

> Repository state overrides stale conversation history. Verify SHAs with `git fetch origin` before acting: this file can lag one merge behind.

---

## 1. Branches

| Item | State |
| --- | --- |
| Repository | `yurizache-cpu/atomic-crm` (public: never commit a real phone number, a secret or patient data) |
| Integration branch | `feature/clinical-phase-1` at `679a118a`: PR #34's normal merge (2026-10-09; parents `1bcefd50`, PR #33's merge, and `5804eb99`, the tree equal to the reviewed head) |
| `main` | `a863e2a0`. Never touched by this program; no production deploy |
| Working branch | `feature/automatic-fixed-texts` (ADR 0026 slice 2, §3; PR #35), from `5804eb99`, now part of `679a118a`; stacked on it, `feature/crm-leads-and-opt-out` (slice 3) |
| Retained, integrated | `feature/autonomous-front-desk` at `5804eb99` (PR #34); `feature/lead-journey-core` at `4aecf2a8` (PR #33); `feature/front-desk-pack-v4` at `ddd4b162` (PR #32); `feature/front-desk-prompt-v4` at `af6d12b3` (PR #31); `feature/company-os-master-blueprint` at `c6b930dd` (PR #30); `feature/front-desk-review-context` at `d35325da` (PR #29) |

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
  - 82 security invariants on the integration branch (SI-01 to SI-83, SI-07 retired; SI-84 and SI-86 arrive with slices 3 and 4, SI-85 is reserved for the site's triage) with live guards ([SECURITY_INVARIANTS.md](SECURITY_INVARIANTS.md));
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

- **PR #34** (merge `679a118a`, 2026-10-09; [ADR 0026](adr/0026-autonomous-front-desk-for-leads.md), Proposed, and its slice 1; SI-72, SI-80, SI-81 and SI-82 amended): who wrote a review (`agent`, `fixed` or `person`, immutable, backfilled exactly), a person's reply to the newest message, and a refused message counted for the person who holds the conversation (migration `20261017120000_review_authorship.sql`). The automated review completed with no finding. PR CI on `5804eb99` and the post-merge run 37952954128 on `679a118a` match the historical baseline (§7).
- **PR #33** (merge `1bcefd50`, 2026-10-08; [ADR 0025](adr/0025-exception-queue-and-lead-journey-decisions.md) Part A, SI-82, SI-80 amended): the exception queue, `ops.exceptions` (migration `20261016120000_exception_queue.sql`).
  - The screening raises a request for a person and an opt-out (whoever holds the conversation), a missing fixed text, a message waiting with a person, and a contact no reply can reach (`contact_unresolved` with its reason, `do_not_contact`). A send's state raises a failed or uncertain send, recorded after its settlement, never inside it.
  - Danger is not an exception (owner decision, 2026-10-08): the front desk answers leads, danger gets the owner's fixed safety text, and the conversation stays with the agent. The safety and sensitive-subject fixed texts reach a later model call only as the neutral marker (W1, `4aecf2a8`).
  - At most one exception is open per subject and kind; a repeat is counted, and a person resolves it only by naming the count they saw. A release is refused while an opt-out is open.
  - A3: a front-desk message whose admission says no reply can reach the contact gets no model.
  - Owner tool: `npm run front-desk -- exceptions | exception resolve | exceptions sync`.
  - Reviews: an adversarial review (11 findings, answered in `d3e0e61c`), the automated review's two P2 (answered in `ed8155a7`) and the design mapper's W1 finding (`4aecf2a8`).
  - CI: PR CI on `4aecf2a8` (both runs) matches the historical baseline (§7); the post-merge run 37840048356 on `1bcefd50` matches it too.
  - Not covered yet (ADR 0025 A5): a run that ends after its screening sent it to the model raises nothing.
- **PR #32** (merge `02ae43e7`, 2026-10-07; ADR 0023 §C, §D): pack `health_pt_br.v4` and configured `handoffNames` (migration `20261015120000_front_desk_handoff_names.sql`). On two blind samples of ordinary traffic v4 recognised 65 and 62 of 77 requests for a person (v3: 25 and 20), with no false handoff in about 550 messages. The automated review's P2 (a relative's name discounted every configured name) was fixed before the merge; its P1 (declare the two functions in `supabase/schemas`) does not apply, since the `ops` schema has always lived in migrations only. PR CI on `ddd4b162` (both runs) and the post-merge run 37610865276 on `02ae43e7` match the historical baseline (§7).
- **PR #31** (merge `90be88dc`, 2026-10-06; ADR 0023 §C, §E): receptionist v4. It brings prompt `lead_triage.v4`, pack `health_pt_br.v3`, the grounding check's duration rule and migration `20261014120000_front_desk_context_received_at.sql`. PR CI on `af6d12b3` (both runs) and the post-merge run 37466466840 on `90be88dc` match the historical baseline (§7). The automated review did not run (the Codex account reached its usage limit); a manual review found nothing blocking, and found the gap that pack v4 closes (§3, item 1).
- **PR #30** (merge `9069f5c1`, 2026-10-06; ADR 0024): the canonical project memory, docs only, brought up to date with PR #29's merge before its own. The automated review's one P2 (the event catalog's subject types) was fixed before the merge. PR CI on `c6b930dd` matched the historical baseline (§7).
- **PR #29** (merge `33c03771`, 2026-10-06; ADR 0023 §L, SI-81): the review context, the stale-reply closure (the automated review's two P1 fixed before the merge) and pack `health_pt_br.v2`. Migrations `20261012120000_front_desk_review_context.sql` and `20261013120000_front_desk_stale_reply_closure.sql`. PR CI on `d35325da` and the post-merge run 37453392364 on `33c03771` both match the historical baseline (§7): Build, ESLint, Typecheck, Test and Database pass; e2e exactly 9 failed and 1 skipped; Prettier exactly the two baseline files.

**Active:**

1. **ADR 0026, the autonomous front desk for leads** (integrated with its slice 1 by PR #34; the owner's product decisions of 2026-10-08). The WhatsApp receptionist answers leads, not patients; a patient talks to the owner directly. The owner decided:
   - the receptionist sends its fixed texts by itself now, and its model replies once the supervised test shows it can;
   - a new WhatsApp number becomes a CRM lead automatically (B1 revised from (b) to (c)), which needs the contact write adapter (B2) and an automatic opt-out record;
   - the site's qualification triage is kept for the owner to read; the receptionist may ask the same qualification questions, but a health answer never reaches a model (W1 holds);
   - a request for a person puts the conversation on a waiting list and notifies the owner on WhatsApp; the owner reads, replies and sends from the browser;
   - patient reminders (confirmation, five hours before, the video-call link five minutes before) belong to the scheduling milestone;
   - after a danger message, no booking: a booking request then goes to the waiting list (delegated to the design);
   - a crisis gets two warmer fixed texts the owner approves, then a narrow crisis conversation in which a model reads the message to lead the person to the CVV: the owner's one exception to W1, test data only, supervised, after the live test;
   - a contact who asked to stop and writes again is answered normally: that message lifts the contact's own opt-out (replacing B7 (b));
   - no team names for now.

   [ADR 0026](adr/0026-autonomous-front-desk-for-leads.md) (Proposed) records them, with eight slices, each its own PR: (1) who wrote a review, and a person's reply to the newest message; (2) automatic fixed texts; (3) automatic leads, the opt-out in the CRM and B7 (b)'s lift; (4) the waiting list and the owner's WhatsApp notification; (5) the browser inbox; (6) no booking after a crisis; (7) the site's triage kept for the owner; (8) a fixed text when a run ends with no reply; (9) the crisis conversation. No owner decision stays open.

   **Slice 1, built on this branch** (migration `20261017120000_review_authorship.sql`; SI-72, SI-80, SI-81 and SI-82 amended):
   - `ops.review_items.author` (agent, fixed, person), backfilled from each run's ending and bound at insert; no review opens on a redacted task;
   - the model's earlier turns become an allowlist keyed on the author: the agent's own reply and the fixed clarification, handoff and opt-out acknowledgements verbatim, anything else, a person's reply included, as the marker (W1);
   - a person replies to the conversation's newest message, whatever happened to it, naming the revision `front-desk conversations` prints (`front-desk reply --revision`); an image or audio inside that revision does not make the reply stale, a message after it does; up to five replies per message and revision; a run still waiting does not refuse the person;
   - a draft the agent or a fixed text wrote is stale once a person answered its message, but for the safety text and the opt-out acknowledgement; the review page says who wrote a reply and when a person already answered it;
   - the safety text and the opt-out acknowledgement are drafted whoever holds the conversation; a refused message in a conversation a person holds is counted for that person.
   - **Reviews:** an adversarial review (four lenses, each finding verified) confirmed 10 findings, all answered on this branch: the protective texts survive a person's reply, the review page names a person, a stop no longer blocks a manual reply, the backfill keeps each old reply as stale as it was, the gateway reads the holder under a lock, the cap counts per revision, an erased message is refused with its reason, the opt-out wording no longer promises an automatic record, and the missing tests were added.
   - **Local evidence:** typecheck and ESLint clean; `functions` 2,529 tests; 27 SQL suites (new F7b); 464 driver-backed cases (new `reviewAuthorship.dbtest.ts`); the `app` project; the browser recordings re-recorded (the conversation block's `author` and `answeredByPerson`).

2. **`feature/automatic-fixed-texts`, stacked on `feature/autonomous-front-desk` (PR #34): slice 2, the owner's published fixed texts leave on their own** (ADR 0026 §B; migration `20261018120000_automatic_fixed_texts.sql`; SI-83 added, SI-45, SI-49, SI-50, SI-80, SI-81 and SI-82 amended). Its PR opens once PR #34 is merged.
   - The operating policy may list, in `automaticFixedTexts`, the fixed texts that leave without a person, from a closed list of fixed-text keys; AI-written replies stay supervised. The screening accepts a listed text as policy (`published_fixed_text`, reviewer `policy:fixed-text`) and queues one `outbound.reply_send` job, for test or synthetic data only.
   - The worker carries it under every send gate, holding the conversation through the one call; at most once; blocked after 30 minutes; past three automatic texts in an hour (the safety texts exempt) a person holds the conversation; a text that did not leave raises `send_blocked`.
   - Two safety texts (`safety`, `safety_followup`), one family: two close crisis messages send one text. The safety texts may reach a number the CRM does not know or knows as opted out (owner decision 9). The operator's send never carries a policy send.
   - The worker reads `REPLY_TRANSPORT` (unset, `meta` with `WHATSAPP_ACCESS_TOKEN`, or `fake` on a developer's machine only).
   - **Review:** an adversarial review confirmed nine findings, all answered on this branch (ADR 0026 §B): the gates judge the contact before a stop, a replaced text is settled stale first, the last gate waits a bounded time and puts the send back when it must wait, the cap counts only texts that left or can leave, the worker's reaper closes out a send its job left unsettled, and the missing tests were added (each fix mutation-checked).
   - **Before any key is listed on staging (owner actions):** the fixed texts published with both safety texts and the privacy notice's escalation line; a token whose system user holds the test WhatsApp Business Account alone; channel `85ae4f8b…` (the clinic number) deactivated.

3. **`feature/crm-leads-and-opt-out`, stacked on `feature/automatic-fixed-texts`: slice 3, leads, the opt-out in the CRM, the lift and the CRM copy's retention** (ADR 0026 §C, "Built in slice 3"; SI-84 added, SI-09, SI-39, SI-45, SI-48, SI-79, SI-80 and SI-82 amended). Four migrations, one commit each; its PR opens once slice 2's is merged.
   - **3a** (`20261019120000_whatsapp_leads.sql`): a registered test sender the CRM does not know becomes a contact, its lead profile and a `whatsapp` attribution before the admission reads the CRM, within the owner's daily cap (`npm run front-desk -- lead-policy record`; none in force, nothing created); a near-duplicate (the last eight digits) waits for a person; the first name only from a profile name that reads as a name, otherwise the owner's placeholder; `lead.created`.
   - **3b** (`20261019130000_crm_consent_and_opt_out.sql`): the opt-out reaches the CRM after its acknowledgement (or the window's end), through the worker's internal `crm.opt_out_record` job; a person's dismissal records nothing; an erasure records a pending opt-out first; the CRM's append-only consent ledger records every change of the flag with its origin; `lead.opted_out`.
   - **3c** (`20261019140000_opt_out_lift.sql`): the contact's own later message that is not an opt-out lifts the contact's own opt-out (owner decision 9), as the CRM holds it then, and gives the conversation back to the agent; a crisis message is never held by the lift; the CRM form cannot clear the contact's own opt-out; `lead.opt_out_lifted`.
   - **3d** (`20261019150000_crm_copy_retention.sql`): an erasure deletes a contact the system created for the number once no live conversation names it and no person worked on it (content-free edit marks), holding the contact before it checks.
   - **Review** (`20261019160000_slice3_review_fixes.sql`, and `merge_contacts` re-sealed): an adversarial review of the branch (five lenses, 28 findings, 25 answered, 3 refuted). A flag a person set is never cleared by a message, even once the contact also opted out by message; naming the flag on again takes nothing over; only an acknowledgement a person accepted brings the record forward (an automatic one leaves a person the window to dismiss); a dismissal or a merge committing mid-record is seen; the erasure and the merge take their locks in one order; a takeover of an opt-out hold is recorded; an opt-out keeps a system-created lead only while in force.
   - **Local evidence:** typecheck and ESLint clean; the `functions` project; 30 SQL suites (new `crm_leads.sql`, `crm_consent.sql`, `crm_copy_retention.sql`); the driver-backed suites (new `whatsappLeads`, `crmOptOut`, `optOutLift`, `crmCopyRetention`); the `app` project; the upgrade replay. Each review fix was mutation-checked (the earlier definition put back, its test red).
   - **Before it is enabled on staging (owner actions):** the privacy notice's line on CRM records; the lead policy recorded (placeholder and daily cap).
   - **Deployment order:** stop every worker (`staging:gateway-worker`, `staging:fake-worker`) before applying `20261019130000`, and restart workers only from the integrated code: a worker without the `crm.opt_out_record` handler fails that job permanently.

4. **`feature/owner-notifications`, stacked on `feature/crm-leads-and-opt-out`: slice 4, the waiting list and the owner's WhatsApp notification** (ADR 0026 §D, "Built in slice 4"; SI-86 added, SI-48 and SI-82 amended). Its PR opens once slice 3's is merged.
   - **The target** (`20261020120000_owner_notifications.sql`): the owner's own number, the test channel it is sent from, two approved utility templates, the kinds, quiet hours (22:00 to 08:00) and caps (10 an hour, 30 a day), recorded only by `npm run front-desk -- notify-target record` with the number read from a file and never printed; never a number a conversation or a CRM contact holds, but the owner's registered device.
   - **The intent:** a request for a person, or a message waiting for one that is newer than the person's latest reply and not danger, records one notification and its `owner_notification.send` job in the transaction that raises the episode, isolated so it never fails it; once per conversation between person replies.
   - **The send:** the worker's job waits a minute, outside quiet hours and within the caps, carries every due notification of the target as one template (a digest across conversations), sets aside what a release or a reply already answered, calls at most once and never again; a stop of the channel's unit holds it; without a transport it waits until it expires after a day.
   - **The owner's number writing in** is refused before any conversation is written (`owner_number`), unless it is the registered device. Status callbacks settle a notification by the digest of its provider id or, when uncertain, by its correlation and the owner's number.
   - **The waiting list** (`20261020130000_waiting_list_read_model.sql`): who waits for a person now, oldest first, with the notification's state, as a section "Fila de atendimento" of the overview (optional in the contract, so the frontend ships first).
   - **Also:** `npm run ops -- identifiers erase --number-file`; `npm run front-desk -- notify-target show|retire` and `notifications`.
   - **Local evidence:** typecheck and ESLint clean; the `functions` project; 31 SQL suites (new `owner_notifications.sql`); the driver-backed suites (new `ownerNotifications`, `companyOsWaitingListRecording`); the overview's browser tests; the recordings re-recorded (the empty waiting list) and a populated one recorded.
   - **Before it is enabled on staging (owner actions):** the two utility templates (`aviso_fila_conversa`, `aviso_fila_resumo`) approved on the test WhatsApp account; the target recorded (the registered device can be it). **Deployment order:** worker, frontend, database.

## 4. Staging (cost-first, [COST_FIRST_STAGING.md](COST_FIRST_STAGING.md))

- **Supabase** `erhrochojnugszkkoqrv` (sa-east-1, PostgreSQL 17):
  - all 77 integrated migrations through `20261017120000`, never the seed: PR #29's two and PR #31's one were applied on 2026-10-06, PR #32's one on 2026-10-07, PR #33's one on 2026-10-08 and PR #34's one on 2026-10-09 (pinned CLI, dry run first; the 26 existing reviews took their author, 22 `agent` and 4 `fixed`); the hosted verifier then reported 0 blocking and 0 advisory findings.
  - `front-desk exceptions sync` ran once on 2026-10-08 over the 10 existing sends: it opened one `send_failed`, the 2026-10-02 Meta probe send refused with 131005 (a user token's permission error, before the system-user token), and nothing else.
- **Frontend:** the Netlify site `atomic-crm-staging`, republished on 2026-10-09 from `679a118a` right after its migration (PR #34 changed the conversation block of the browser contract; Netlify deploy `6ac90a93215a5397e3a84c69`; preflight 0 blocking and 1 advisory, the published source maps; live check 0/0). The review page shows the screened message, who answered (for example "Texto fixo: Passagem para uma pessoa") and the reply draft (checked in the browser).
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
| 2 | ADR 0021 W6, lead creation for a new WhatsApp number: **decided 2026-10-08, then revised the same day** to automatic creation (ADR 0025 B1 (c), carried by ADR 0026). It needs B2 (the contact write adapter) | Real lead entry (workstream A) |
| 2a | ADR 0026 (Proposed): accept or amend it (no decision open). ADR 0025 Part A is integrated (PR #33); its Part B items are carried by ADR 0026 | The autonomous front desk's slices |
| 2b | Register the owner's own WhatsApp number for notifications, by the owner's own act (never written in the repository), and approve a Meta utility template for the notification | The owner's WhatsApp notification (ADR 0026) |
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
   - the first catalogued events (`lead.created`, `lead.attribution_captured`, `triage.completed`, `exception.raised`). `exception.raised` and `exception.resolved` are integrated (PR #33); the rest is planned in ADR 0026.
   - the autonomous front desk for leads (ADR 0026): automatic fixed replies, automatic lead creation, the waiting list with the owner's notification, and the browser inbox.
3. **Scheduling in the journey (workstream B):** offering real slots in conversation, the booking page with holds, `outcome.first_appointment_booked`, and rescheduling and cancellation through the conversation. Calendar and Meet follow once the provider decision is made.

## 9. Exactly next action

1. **ADR 0026 slice 2** (§3, item 2): PR #35 from `feature/automatic-fixed-texts` into `feature/clinical-phase-1`, its CI against the baseline (§7), the owner's review and the merge on the owner's request; then, on staging, migration `20261018120000` (pinned CLI, dry run first, never the seed), the hosted verifier and the frontend (if its contract changed). Then slice 3's PR from `feature/crm-leads-and-opt-out` (§3, item 3), merged on the owner's request and applied to staging the same way, every worker stopped before `20261019130000`.
2. **Team names (`handoffNames`):** the owner chose none for now (2026-10-08). Operating policy v4 stays published; a request for a person by role or in general still hands over.
3. **Run the live supervised receptionist test** on the Meta test number (the owner's device must be a CRM contact with the opt-out recorded false, [COST_FIRST_STAGING.md](COST_FIRST_STAGING.md) §12):
   - a fresh quick tunnel to the local gateway and a fresh verify token, which the owner pastes into the Meta app's webhook settings (the WhatsApp Business Account product);
   - the gateway (`npm run whatsapp:gateway`) and the worker (`npm run staging:gateway-worker`), both through `scripts/with-staging.mjs`, from the integrated code;
   - each reply accepted by the owner in the browser at AAL2, then carried by `npm run messaging -- send`. The 2026-10-05 autonomous test used a session-local auto-accept script that is not in the repository and is not a product feature;
   - then stop everything and rotate the verify token.
4. **Then the rest of milestone 2 of §8,** following ADR 0026's slices.
