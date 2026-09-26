# Phase 3B.2 — Operational commercial funnel: implementation report

| | |
| --- | --- |
| **Status** | **IMPLEMENTED LOCALLY. OWNER VISUAL REVIEW REQUIRED BEFORE THE SINGLE REMOTE INTEGRATION CYCLE.** Local commits on `feature/phase-3b2-operational-funnel`, not pushed, no PR. |
| **Base** | `feature/clinical-phase-1` at `8aa65873247e34e1753f61e6f67b16ce93114e7e`, the PR #14 merge that integrated Phase 3B.1. Post-merge CI Check #78 (run 36204665177): Build, Test, Typecheck, ESLint and Database security & reproducibility passed; only the historical e2e baseline (9 failed, 1 skipped) and the Prettier baseline (`sampleCsv.test.ts`, `canAccess.test.ts`) are red. `main` is unchanged at `a863e2a0`. |
| **Branch** | `feature/phase-3b2-operational-funnel` |
| **Governing records** | The Phase 3B.2 brief (controlled batch, 2026-09-26); **owner decision R** (commercial browser authority; [DECISIONS.md](DECISIONS.md), [ADR 0019](adr/0019-company-os-operator-surface.md) "Owner decision R"); [ADR 0013](adr/0013-pipeline-stages-are-configuration.md); CLAUDE.md's five rules. |
| **Data** | Synthetic data only. BASELINE Q8 OPEN. No real patient data; no production deploy. |

## 1. What this batch is

The read-only Funil comercial of Phase 3B.1 becomes a narrow operational tool. On each opportunity card the owner can now:

- **move** it to another configured stage;
- **set, change or clear** its commercial next action;
- **convert** it into a configured converted stage;
- **mark it lost** with a configured loss reason.

Each act is its own browser function with its own gate, needs a second, deliberate confirmation, and changes the Atomic CRM's `public.deals` itself: the CRM stays the one commercial source of truth. When the owner has configured the commercial follow-up bridge, setting a next action also plans the Phase 3A follow-up cadence so its first occurrence is due exactly at that instant; changing it supersedes that plan, and clearing, converting or losing cancels it. Nothing sends a message.

## 2. Authority and the path of an act

**Owner decision R** amends ADR 0019's count of browser mutations from two to six (`decide_review`, `trip_stop` and these four) and keeps its least-privilege architecture unchanged. `company_os_api` grows from 17 to 21 functions.

```
browser (authenticated)
  → company_os_api.<act>            fixed arguments; owned by ops_operator_api
  → ops.gate_<act>                  resolver first; one callee; no-store; lock_timeout 2s → OS429
  → ops.<act>_as_member             the narrow act: provider-neutral, reads nothing in public
  → ops.crm_<verb>_deal             the ONE CRM adapter write
  → public.deals
```

| Act | Arguments | Writes on `public.deals` |
| --- | --- | --- |
| `move_opportunity` | deal, target stage, revision | `pipeline_stage` (the CRM's pipeline trigger keeps `stage`, `stage_entered_at`, `updated_at`; the ledger trigger observes it) |
| `set_opportunity_next_action` | deal, absolute instant or null, revision | `next_action_at` only |
| `convert_opportunity` | deal, converted stage, revision | `pipeline_stage`, `converted_at` (database clock), `next_action_at` null |
| `lose_opportunity` | deal, loss reason code, revision | `lost_at` (database clock), `loss_reason_id`, `next_action_at` null; the stage is kept |

- **No generic write.** No act takes a table, a column, SQL text, an operation name or a payload object; the browser never supplies a tenant, company, actor, salesperson or source. No create, delete, reopen, amount, title, contact, salesperson, company, category or closing-date edit exists.
- **The CRM adapter writes** (`ops.crm_move_deal`, `crm_set_deal_next_action`, `crm_convert_deal`, `crm_lose_deal`) all begin with `ops.crm_lock_deal`: the tenant must own the local CRM (OS403, decided before any CRM row is read, whatever the id); an id outside 1..2^53−1 and a missing one are the same OS404; the row is locked `FOR UPDATE`; an archived deal is closed to every act (OS409).
- **Stages are configuration** (ADR 0013). Each act validates against the CRM's STORED configuration (`ops.crm_stage_configuration`, shared with the read adapter). Missing or malformed closes every act (OS409); nothing falls back to the frontend's defaults. Moving into a converted stage is refused: conversion is its own act, so `converted_at` is never forgotten.
- **Open** means not archived, not lost, not converted and not in a configured converted stage. Move and next action need an open deal; convert needs a deal that is not lost (a converted-stage deal without a date may be dated); lose needs a deal that is not converted.

## 3. Concurrency: the revision

`ops.crm_deal_revision` is an opaque digest (`r1.` + 32 hex) of the deal row's state: stage, stage entry, next action, conversion, loss, loss reason, archive and `updated_at`, which the CRM's trigger stamps on every write. Instants enter as epoch text, so no session time zone or float setting changes it. Each card carries it, and every act names the revision it was made from.

Inside the act's transaction: lock the row → recompute the revision → refuse a mismatch with OS409 → change → return the new revision. No timestamp from the browser is ever authority. Of two acts made from one revision, exactly one commits (§10). A repeat whose result already holds (the same stage, the same instant, the same conversion, the same loss reason) answers `unchanged` whatever revision it names and changes nothing; a different outcome for a closed deal is OS409.

Two changes inside ONE transaction share the database clock, so a state that returns to an earlier one inside a transaction repeats its revision. No browser request can make two changes in one transaction.

## 4. Outcome consistency (hard stop 5 checked)

The CRM's own deal form sets "Perdida em" and "Conversão confirmada em" as independent date inputs, and the Phase 3B.1 funnel already counts a deal carrying both as "conflicting". A table constraint forbidding both would therefore break an existing CRM write path, so, as the brief directs, **no constraint is added**. The four acts themselves never create both, under the row lock: converting refuses a lost deal, losing refuses a converted one (SQL suite O, driver-backed races in both orders).

The CRM's form also labels `converted_at` "Registre apenas após confirmação manual de pagamento". Company OS's conversion is a commercial outcome only and says so ("Marcar esta oportunidade como convertida?"), writing no payment, package or patient fact; that the CRM's own help text ties the field to payment confirmation is recorded for the owner (§14).

## 5. Next action and the follow-up bridge

**The field.** The commercial workflow writes `public.deals.next_action_at`, the opportunity's own next action, only. `lead_profiles.next_action_at` is not read, written or synced (SQL suite S compares a digest of `lead_profiles` before and after every act). The broader question of which next action is canonical stays an owner question (§14).

**The instant.** The browser sends an absolute ISO instant. The owner types a date and a time on the funnel's IANA zone (`funnel.timezone`); `wallTimeToInstant` resolves it with Intl (a daylight-saving gap is refused, a repeated hour is its earlier instant) and the panel shows the result back before it is saved. The server refuses an infinity and anything more than 30 days before or 366 days after now (OS400).

**Configuration** (`ops.commercial_follow_up_bridges`, owner-only, never browser-editable). An append-only version per change; the latest is current. Enabled names a Company OS company, a department, an optional agent and one pinned follow-up policy version; disabled names nothing. Nothing is inferred from a first row or a label. `ops.configure_commercial_follow_up_bridge` refuses an inactive or foreign unit and a policy version that is not its policy's latest (the Phase 3A service plans a policy's latest version). The funnel projection reports only the status: `not_configured`, `configured` or `invalid` (a unit became inactive, or the pinned cadence has a newer version).

**Timing.** The Phase 3A cadence is offsets from an anchor. The bridge anchors at `next_action_at − first offset`, so step 1 is due exactly at the next action and the other steps keep their relative cadence. The cadence is tenant data; nothing hardcodes 3, 7 or 10 days.

**Provenance and ownership.** `ops.commercial_follow_up_plans` records each plan the bridge created and its deal. The bridge supersedes or cancels only those, never a plan merely because its opaque subject `deal:<ref>` matches. Before planning it takes the Phase 3A service's own advisory locks, key then subject, so no concurrent scheduler can create or supersede a plan for the subject between its check and its plan.

| Act | Follow-up outcome |
| --- | --- |
| set, bridge configured | `scheduled`: a new plan through `ops.schedule_follow_up_plan`, superseding the previous bridge plan in the same company (its scheduled steps become superseded; a due step stays open work, the Phase 3A semantics); a bridge plan left in a company the bridge no longer names is cancelled |
| set, not configured | `not_configured`; any previous bridge plan is cancelled (it no longer describes the deal) |
| set, cannot plan | `not_scheduled` with `configuration_invalid`, `outside_window` (the anchor falls outside the service's window) or `existing_plan` (an active plan someone else created for the subject, never superseded); a previous bridge plan is cancelled |
| clear | `cancelled` (or `none`): the deal's active bridge plans, every open step, reason `commercial_next_action_cleared` |
| convert, lose | the same, reasons `opportunity_converted`, `opportunity_lost` |

The deal change and the follow-up change commit together or not at all (driver-backed test). A superseded plan names its successor through a DEFERRED foreign key; the act checks it inside the gate and defers it again, so a commit can never fail after the answer. The plan key names the act (`commercial:act:<act id>`): one act, one plan.

**Not done:** the bridge reacts to the four Company OS acts only; a next action, conversion or loss recorded in the CRM's own form moves no plan. No owner CLI command configures the bridge yet (the owner's credential calls the service; the demo does) — backlog.

## 6. Audit

The stage ledger (SI-66) already records every stage change, including the acts'. `ops.events` is not used for the commercial acts: every event belongs to a Company OS company, and a CRM deal names none, so writing one would mean inventing a company. Instead `ops.commercial_acts` records each act that changed something: the act (`moved`, `next_action_set`, `next_action_cleared`, `converted`, `lost`), the deal reference, the principal (`principal:<uuid>`), the database time and a minimised fact (a stage code, an instant, a loss reason code, the follow-up outcome). It is append-only, RLS-forced with no policy and no grant. A no-op records nothing. The follow-up service still writes its own `follow_up.*` events in the bridge's company, with source `company-os-ui`.

## 7. Company OS: the operational Funil comercial

- **Controls** appear on a card only when the operator context says the tenant may act (`allowedActions.moveOpportunity` … `loseOpportunity`, true exactly when the tenant owns the local CRM) AND the card's own server hints (`actions.move`, `setNextAction`, `convert`, `lose`) allow it. A converted card offers nothing.
- **Panels.** Each act opens its own labelled alertdialog in the card; the safe choice has the focus; the confirm button stays disabled until the act's input is chosen. Move lists the configured stages but the current and converted ones. Convert preselects the one converted stage, or asks when several are configured. Lose requires a configured reason; no free text. The next-action panel shows what the follow-up bridge will do, or says none is configured, and offers "Remover próxima ação" when there is one.
- **No optimism.** Nothing moves before the server answers. Success is shown only from the committed answer, then the funnel is read again. OS409 shows "A oportunidade mudou desde a última atualização. Atualize e tente novamente." and the funnel is read again; OS429 says the CRM was busy and nothing changed; OS403/OS404/OS400 have data-free texts; any other failure (a lost answer, a broken contract) says the result is uncertain and to check the refreshed funnel before trying again. An act is never retried automatically.
- **No drag and drop**, and no create, delete, reopen or edit control.
- **3B.1 UX backlog, taken:** "Próxima ação atrasada" and "Vence hoje" are separate cards; "Movimentações recentes" shows the latest 8 with "Ver todas (N)" / "Mostrar menos"; the board says how many stages it holds and to scroll sideways.

## 8. Security and privacy

- **Membership:** the Phase 2C model, unchanged. An active `tenant_operator` membership of the tenant that owns the local CRM is the prerequisite (the resolver refuses anything else, OS403, re-read at every call); nothing derives Company OS authority from a CRM administrator, owner flag, email or salesperson.
- **`owns_local_crm`:** decided by `ops.crm_lock_deal` before any CRM row is read (OS403 for any other tenant, whatever the id), and again at resolve time; moving CRM ownership changes eligibility on the next request (SQL suite A; driver-backed member test).
- **Cross-tenant:** an id no browser was shown and a missing one answer the same OS404, byte for byte (the live probe).
- **PII:** responses carry the deal reference, the revision, an outcome, a stage code, an instant and a follow-up status only; the act log and the follow-up events carry no title, name, contact, note or loss label (SQL suite G sweeps the planted sentinels).
- **No generic write capability:** each act's path is pinned callee by callee (SQL suite F2), the CRM adapter writes only `public.deals`, by UPDATE, and no role can execute any function of the path directly.
- **No autonomous messaging:** nothing on the path names a send, an outbound row, WhatsApp, an agent run, an enqueue of its own or a stop (F2 and the migration's end state); follow-up due jobs are the existing governed `follow_up.due` kind, operator work only.
- **Q8:** OPEN. No model is involved: every act is deterministic.
- **Invariants:** SI-68 (the four acts) and SI-69 (the bridge) added; SI-21, SI-58, SI-65's caveat and SI-67 amended.

## 9. Tests added or updated

- `supabase/tests/commercial_opportunity_acts.sql` (new): F2 path pins; A authority; M move; N next action; B bridge (configure refusals, exact cadence, supersede, clear, existing plan, outside window, invalid, reassigned company, disabled); C convert; L lose; O never both outcomes; S nothing else moved; G act log and history; five deliberate breaks X1–X5, each caught by its own check.
- `supabase/tests/company_os_api.sql`: the catalogue (21), the gates and their bounds, the internal catalogue, the owns_local_crm readers, the identity matrix for the four acts, the operator context.
- `supabase/tests/commercial_funnel.sql`: the read adapter's thirteen functions; card revision and allowed acts; loss reasons; bridge status.
- `supabase/tests/company_domain_core.sql`, `decision_shadow.sql`: the new gates and counts.
- The live probe (`companyOsApiExposure.mjs`, `companyOsProbe/commercialActChecks.mjs`): the HTTP catalogue, identity refusals, arguments PostgREST does not know, OS404 alike, OS400.
- `engine/domain/commercialOpportunityActs.dbtest.ts` (new): the races and the member path (§10).
- Contracts and recordings: `commercial.ts`, the card and context schemas, re-recorded funnel and tenant responses (a stable stand-in revision per deal).
- The static guard and trust root (the fourth allowlisted migration), and the security-invariant registry.
- UI: `FunnelActions.test.tsx` (new), `funnelModel.test.ts` (new), `FunnelScreen.test.tsx` updated.

## 10. Evidence (local)

Local runs on this machine after the review fix (`d0babcbc`), each broad suite once. Not CI: nothing is pushed.

| Check | Result |
| --- | --- |
| `npm run test:db` (after a clean reset) | 21/21 suites, including the new `commercial_opportunity_acts.sql` (F2, A, M, N, B, C, L, O, S, G, and five deliberate breaks X1–X5, each caught by its own check) and the live probe with the commercial acts |
| `npm run test:db:engine` | 391/391 in 52 files, including `commercialOpportunityActs.dbtest.ts` (7: two moves, a move against a conversion, a conversion against a loss in both orders, two next actions, the next action and its plan together and a rollback, the member path, the 2 s OS429 bound) |
| `npm run test:db:upgrade` | PASS; legacy data kept its meaning |
| `functions` unit project | 2148/2148 in 91 files; `securityInvariants.test.ts` 76/76 (68 invariants, SI-01 to SI-69, SI-07 retired) |
| `app` unit project (real Chromium) | 493 passed, 1 skipped, 0 failed in 62 files; the Funil comercial 25/25 (screen, acts, the open-panel revision, wall-clock time) |
| `scripts/test` guard files | 15 files, 319 tests |
| `npm run typecheck` | 0 errors |
| `npm run lint` | 0 errors; the 64 warnings are the historical ones, and the branch's changed files pass with `--max-warnings=0` |
| Changed-file Prettier | green |
| `npm run build`, `npm run scan:build` | green; 20 text files, 0 blocking, 0 advisory |
| `node scripts/production-scope.mjs`, `node scripts/dev-signing-key.mjs` | OK |
| `npm run funnel:operations-demo` | runs end to end on an empty local CRM (§12) |

**Found and fixed during development:**
- A `set constraints all immediate` in the acts outlived them in a multi-act transaction and made a later supersede fail on the deferred successor key; the act now checks that one constraint and defers it again.
- A plan key derived from the deal's revision could repeat inside one transaction (the database clock is the same); the key now names the act.
- SQL does not promise the order of an OR, so two test assertions that called an act and read its row in one expression were split.

## 11. Review

One focused final reviewer (the brief's maximum), over `8aa65873..` before the broad run: **P0 0, P1 1, fixed.**

- **P1, fixed (`fix(company-os): keep the revision an act panel was opened on`).** An open act panel read the card's revision at submit time, and the 15 s overview poll could hand it a newer one, so a change another person made while the panel was open could be overwritten without a conflict: the database's guarantee held, but the browser defeated "the revision the browser saw". The board now records the revision when a panel opens and every act names it (a change made meanwhile is OS409); once the card changed under an open panel, the panel says so and disables its confirm and clear buttons. A component test swaps the card's revision under an open panel.
- **P3, fixed with it:** the next-action panel no longer offers to save an existing next action left untouched (it would be rounded to the minute and planned again).
- **Verified clean by the reviewer:** tenant and membership first; no TOCTOU (the revision is checked after `FOR UPDATE`); the digest is independent of the session zone and float settings (measured on PostgreSQL 15.8); each act writes only its own columns and never `lead_profiles`; no act leaves both outcomes; the bridge's lock strings and order equal the service's, and a race with a manual scheduler fails closed with OS409; the anchor arithmetic; the only deferrable constraint in the database is checked inside the gate; no PII in responses, the act log or events; nothing reaches a send, a run or a stop.
- **P3, recorded, not fixed:**
  - OS409 always reads "A oportunidade mudou…", although it also covers a missing or invalid stored configuration, a deal no longer open and a multiple-membership conflict; the funnel is read again, which shows the real state.
  - If the overview cannot be read for more than two polling intervals while an act is in flight, the board unmounts and that act's outcome message is not shown (the act is never retried, so nothing is at risk).
  - The bridge's cancellations on the not-configured, invalid and outside-window paths, and of a plan left in another company, run without that subject's advisory lock: a concurrent manual supersede makes the act fail with OS409, and a retry succeeds.
  - `public.configuration` is read without a lock: a concurrent Settings save that removes a stage while a move commits into it leaves the deal under "Etapa não configurada" (benign, visible).
  - Recorded owner questions rather than defects: the acts do not apply the CRM's own per-salesperson checks, so any member acts on any deal of the tenant (§14 item 2); a CRM-form edit moves no bridge plan (§5); converting a deal already in a converted stage without a date stamps `converted_at` now.

## 12. Owner demo

`npm run funnel:operations-demo` (local and manual only) builds the Phase 3B.1 fictional funnel, configures the bridge explicitly as the owner (its own Company OS unit, a demo cadence of 1 hour, 2 days and 5 days after the anchor), then makes the four acts as their gates make them, each in its own transaction:

- a move, and the same move repeated from the earlier view, refused (OS409);
- a next action set and changed (plan superseded), and on another deal set then cleared (plan cancelled);
- a conversion and a loss, each cancelling the plan the bridge made.

It prints the funnel's counts before and after (active 12 → 10, converted 2 → 3, lost 3 → 4), the ledger's observation of the move, and each deal's plans, and leaves five open opportunities for the owner.

## 13. Decisions

- **R — Commercial browser authority** (owner, 2026-09-26): recorded in [DECISIONS.md](DECISIONS.md) and ADR 0019. No other owner decision is made here.

## 14. Owner questions carried

1. **Canonical next action.** The commercial workflow writes `public.deals.next_action_at`; `lead_profiles.next_action_at` also exists and is not synced. Which is canonical for commercial follow-up stays open.
2. **Sales visibility and RBAC.** Tenant-wide today. A future phase decides tenant-wide, department-scoped, salesperson-scoped or role-configurable visibility and authority.
3. **Conversion wording in the CRM.** The CRM's own form says to record `converted_at` "only after manual confirmation of payment"; Company OS treats conversion as a commercial outcome only and never mentions payment. Whether the CRM's help text or the conversion semantics should change is the owner's.

## 15. Backlog (not done here)

- An owner CLI command to show and configure the follow-up bridge.
- The bridge follows Company OS acts only; CRM-form edits move no plan.
- Superseding a plan keeps a due step open (Phase 3A semantics); whether a changed next action should also close a due step is a later decision.

## 16. What this batch does not do

No opportunity creation, drag and drop, deletion, reopening, amount, title, contact or salesperson edit; no billing or payment; no Google Ads or real Google Calendar; no RAG or pgvector; no real Jev; no new LLM workflow or predictive scoring; no autonomous WhatsApp; no browser scheduling act from the Agenda; no new dependency.
