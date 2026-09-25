# Phase 3B.1 — Commercial funnel and funnel intelligence: implementation report

| | |
| --- | --- |
| **Status** | **IMPLEMENTED LOCALLY. OWNER VISUAL REVIEW REQUIRED BEFORE THE SINGLE REMOTE INTEGRATION CYCLE.** Local commits on `feature/phase-3b-commercial-funnel`, not pushed, no PR. |
| **Base** | `feature/clinical-phase-1` at `7c72e226c715a1a4b3f97396c548d1af55ac2724`, the PR #13 merge that integrated Phase 3A. Post-merge CI Check #75 (run 36160591321): Build, Test, Typecheck, ESLint and Database security & reproducibility passed. Only the historical e2e baseline (9 failed, 1 skipped) and the Prettier baseline (`sampleCsv.test.ts`, `canAccess.test.ts`) are red, so the overall workflow is red, not green. `main` is unchanged at `a863e2a0`. |
| **Branch** | `feature/phase-3b-commercial-funnel` |
| **Governing records** | The Phase 3B.1 brief (controlled batch, 2026-09-25); owner decision Q (the commercial funnel before RAG, sequencing only; [DECISIONS.md](DECISIONS.md)); [ADR 0013](adr/0013-pipeline-stages-are-configuration.md); CLAUDE.md's five rules. |
| **Data** | Synthetic data only. BASELINE Q8 OPEN. No real patient data; no production deploy. |

## 0. Position

| | |
| --- | --- |
| Phase 3A | **INTEGRATED** (PR #13, merge `7c72e226`) |
| Phase 3B.1 | **COMMERCIAL FUNNEL + FUNNEL INTELLIGENCE** |
| Current commercial authority | **ATOMIC CRM `public.deals`** |
| Company OS | **READ ONLY** |
| Second commercial store | **NO** |
| Browser commercial mutations | **NONE** |
| Browser mutable RPCs | **2** (`decide_review`, `trip_stop`); `company_os_api` still 17 functions, none added |
| Transition history | **FROM THIS PHASE FORWARD ONLY** |
| Historical stage conversion before the ledger | **UNKNOWN** |
| Google Ads API | **NOT CONNECTED** (no CPL, CAC, ROAS or spend) |
| RAG | **DEFERRED BY SEQUENCING, NOT REJECTED** (decision Q) |
| Q8 | **OPEN** |
| Real patient data used in the demo | **NO** |

## 1. What this batch is

The owner can now open **Funil comercial** in Company OS and see, at a glance:

- how many opportunities are open, and in which configured stage;
- how long each has been in its current stage;
- which have an overdue next action, which have one today, and which have none;
- what converted and what was lost in the last 30 days, with the closing rate and its denominator;
- where opportunities came from, as the CRM recorded it;
- which stage changes were observed since the transition ledger started;
- exactly what history is not known.

Nothing in Company OS writes a commercial record. The existing CRM keeps creating, moving, converting and losing opportunities.

## 2. Architecture: one source of truth, one seam

**No second commercial store.** No `ops.opportunities`, `ops.deals` or copy of a deal exists. The Atomic CRM's `public.deals` is the only commercial record, and Company OS reads it.

**The seam.** It follows the convention Phase 2B set with `ops.crm_contact_by_phone`:

```
public.deals + public.configuration + public.acquisition_attributions
  + public.loss_reasons + public.deal_stage_transitions
        ↓   (read only)
ops.crm_commercial_funnel(tenant, zone, as_of) and its crm_ helpers   ← the ONE CRM adapter
        ↓
ops.cos_commercial_funnel(tenant, as_of)                              ← provider-neutral
        ↓
ops.read_overview → company_os_api.overview (existing, unchanged surface)
        ↓
contracts/company-os-api/funnel.ts (strict) → Funil comercial
```

- **The adapter is the only CRM-aware code.** `ops.crm_commercial_funnel`, `crm_deal_card`, `crm_deal_origin`, `crm_text_ok` and `crm_safe_amount` are the only functions that know the CRM's tables. Replacing the CRM means replacing them. The contract, the neutral entry and the screen stay, and nothing in the contract names the Atomic CRM.
- **The tenant gate comes first.** The adapter serves only the tenant that owns the local CRM (`ops.tenants.owns_local_crm`, at most one tenant). It decides that before it reads anything of the CRM, and any other tenant reads `{"status": "not_configured"}`. The tenant is the caller's membership, resolved by the existing gate from `auth.uid()`; the overview takes no argument.
- **The read graph gains one CRM callee, narrowly.** Phase 2C's Company OS read graph read nothing of the CRM (`company_os_api.sql` P5 and M2). As the brief directs, P5 now allows exactly one read callee, `crm_commercial_funnel`, and M2 lists it among the readers of `owns_local_crm`. Every other CRM service stays forbidden, and every `cos_`, `read_` and `gate_` body still reads nothing in schema public. `commercial_funnel.sql` F1 pins the adapter itself: five functions, INVOKER, reachable by no role, reading only the five CRM tables, with no write and no dynamic SQL.
- **No new API.** The funnel travels in the existing overview, like the Agenda. `company_os_api` is at its 17-function ceiling and stays there.

**Why there is no `pipelines` / `pipeline_stages` table.** ADR 0013 designs such tables for a future multi-tenant CRM. This read-only adapter does not need them. The CRM already stores the ordered stage codes, their labels and the converted stages in `public.configuration` (`dealStages`, `dealPipelineStatuses`), exactly as its Settings save them. That is configuration as data, and reading it adds no second configuration source.

## 3. Stages are configuration, and the configuration must be stored

- **Order, labels and conversion come from the stored configuration.** The ordered codes and labels are `configuration.config -> 'dealStages'`, and the converted stages are `-> 'dealPipelineStatuses'`. No stage code or label appears in any migration or engine file. The clinic's nine stages exist only as demo and test data.
- **Absent or malformed configuration is stated, never guessed.** The funnel then reads `stages_not_configured` with a reason, `missing` or `invalid`. Invalid covers:
  - a non-array;
  - no stages, or more than 30;
  - a blank, over-long or duplicate code or label;
  - a converted stage that is not listed.
- **Important limitation.** On a fresh database `public.configuration.config` is `{}`. The CRM's frontend then shows the stage list from its own code (`defaultConfiguration.ts`), which the database cannot see. The funnel therefore appears only after the owner saves the stages once in the CRM's Settings. Until then Company OS says so ("Etapas do funil não configuradas") instead of assuming the frontend's defaults. Seeding the configuration in a migration would put tenant vocabulary in DDL (SI-25, ADR 0013), so it is not done.
- **Deals in an unlisted stage stay visible.** Current deals whose stage code is not configured (legacy or imported values) are counted and shown in their own column, "Etapa não configurada", without their raw code.

## 4. Definitions: facts, not inferences

| Term | Exact meaning |
| --- | --- |
| Current deal | Not archived and not lost (`archived_at` and `lost_at` null). The board shows current deals. |
| Open / Em andamento | A current deal that is not converted: `converted_at` null, and its stage is not a configured converted stage. |
| Converted (outcome) | `converted_at` set, `lost_at` null. It is the CRM's own dated fact. Payment is never inferred. |
| Lost (outcome) | `lost_at` set, `converted_at` null. The loss reason is the configured label. |
| Conflicting | Both set: counted as neither, and reported. |
| Converted undated | A current deal in a converted stage with no `converted_at`: converted by configuration, but in no period count, and reported. |
| New | `created_at` within the window. Archived deals are included, because creation is a dated fact. |
| Window | 30 days (720 fixed hours) for new, converted, lost and movements; 90 days (2160 hours) for origins. Fixed hours, so no session zone can move a window. |
| Closing rate — 30 days | converted ÷ (converted + lost), both over outcomes dated in the same 30 days, shown with the denominator ("2 convertidas de 5 encerradas"). There is no rate when the denominator is 0, and never a stage-to-stage ratio of current counts. |
| Stage age | Whole days, in the tenant's zone, since `stage_entered_at`, the current stage only. Past stage durations were never recorded. |
| Next action | The deal's own `next_action_at`: `overdue` (before now), `today` (from now until the tenant's midnight), `future`, or `none`. |
| Movement | An observed ledger row: an entry ("Entrou em …") or a change ("A → B"). |

**Next-action ambiguity, recorded rather than resolved.** `lead_profiles.next_action_at` also exists. It is contact-level, and creating a task also writes it. Nothing establishes that either field takes precedence. Following the brief, the funnel uses the narrower, opportunity-level `deals.next_action_at` and does not read the contact-level one. Which field is canonical for commercial follow-up is an owner question (§14).

"Today" means the tenant's scheduling zone, the same rule as the Agenda, else UTC, and the zone is shown in Detalhes técnicos. Amounts are the deal's `amount`, labelled "Valor informado", and are never called revenue, cash or payment.

## 5. The stage-transition ledger (going forward only)

Migration `20260929120000_deal_stage_transition_ledger.sql`, mirrored statement for statement in `supabase/schemas/` (01, 02, 04, 05 and 06).

- **Shape.** `public.deal_stage_transitions` holds `id`, `deal_id`, `from_stage` (null for an entry), `to_stage` and `changed_at`. It lives in the CRM adapter layer, beside `public.deals`. It is an observation log, never the current stage: nothing reads it to decide a deal's stage.
- **Writer.** An AFTER INSERT OR UPDATE trigger on `public.deals`, in the deal write's own transaction:
  - an insert records its entry;
  - a change of `pipeline_stage` records one row;
  - a same-stage or other-column update, a refused write and a rolled-back one record nothing.

  The trigger adds no condition a valid deal write could fail: it has no length or shape check and inherits NOT NULL from `pipeline_stage`.
- **Order under concurrency.** `changed_at` is `clock_timestamp()`, read after the row lock. Concurrent changes of one deal are serialised by that lock, so a deal's rows form one chain in lock order, and the chain ends at the current stage. Nothing is claimed about the relative order of different deals' observations. The deal's own `stage_entered_at` is its transaction's start, which can be slightly earlier.
- **Append-only.** Updates are refused, the owner included. A delete is refused except the cascade from the deal's own deletion, so erasing a deal remains possible.
- **Backend-only.** RLS is on with no policy. anon, authenticated and service_role hold no privilege on the table, its sequence or its functions. The writer is `SECURITY DEFINER` with EXECUTE revoked from everyone, so a CRM user's own deal writes are observed while the browser can neither read nor write the ledger.
- **No fake history.** The migration asserts the ledger starts empty. No snapshot is taken, and deals that existed before it have no history until their next change. The upgrade replay asserts that no legacy deal gains a row.
- **Coverage.** The coverage start is the earliest observation still held. The screen states "Histórico de movimentações disponível a partir de …", or that nothing is recorded yet. Stage-to-stage conversion before coverage is unknown and never computed.
- **Two limits of an observation log.** Deleting the earliest-observed deals removes their observations, so the coverage start can move later: the statement is then conservative, never overstated. A stage change made in replica mode (`session_replication_role = replica`, restore or replication tooling) is not observed, like every ordinary trigger's.

## 6. Acquisition attribution

- **One contact, one source:** a deal with exactly one linked contact takes that contact's recorded `acquisition_attributions.source` (whitespace-trimmed), when every recorded source of that contact is the same.
- **Ambiguity is stated:** several contacts, or one contact with differing sources, read "Várias origens"; none reads "Sem origem registrada". Nothing is chosen arbitrarily.
- **No invented categories.** The CRM stores `source` as free text ("Origem"). The funnel shows it as recorded and never maps it to a category such as "Google Ads" or "Orgânico".
- **Identifier-shaped or rare values are withheld.** Either reads "Origem não exibida":
  - a value longer than 40 characters, with characters beyond letters, digits and `._&/+()-`, or with five or more digits;
  - a label that fewer than three distinct contacts carry. Channel names recur, while a free-text source naming one person (a referrer, say) does not. This threshold was added by the review (§12).
- **Nothing else leaves the CRM.** gclid, campaign, campaign id, ad, keyword, UTM values, landing page and contact ids never leave the adapter.
- **Breakdown:** deals created in the last 90 days, the top 8 recorded sources by count, then the other recorded sources summed, then unknown, multiple and withheld. The counts sum to the total (a contract refinement).

## 7. Company OS: Funil comercial (read only)

`/company-os/funnel`, group Operação, in pt-BR. It is polled with the overview every 15 s, and values read "Desconhecido" once stale.

- **Summary cards:**
  - Em andamento;
  - Novas, Convertidas and Perdidas nos últimos 30 dias;
  - Taxa de fechamento — 30 dias, with its denominator;
  - Próxima ação atrasada, with the number due today;
  - Sem próxima ação.
- **The board.** A horizontally scrollable board with one column per configured stage, in the configured order. Each column shows its exact count, its informed amount and up to 25 cards with "Mostrando 25 de N" beyond. Open stages list the longest-waiting first; converted stages list the most recent first. Each card holds:
  - "Oportunidade #id";
  - time in stage;
  - a next-action chip with its local time, or "Convertida";
  - the origin;
  - the informed amount.

  The cards are articles, with no drag affordance and no control. The note says moving happens in the CRM.
- **Precisa de atenção:** overdue next actions ordered by due time, and open opportunities without one, oldest in stage first, 10 each with totals.
- **Movimentações recentes:** the coverage statement, then the 15 newest observations in 30 days, with their total.
- **Origem das oportunidades** and **Resultados recentes:** the recent converted and lost outcomes with their date, informed amount or loss reason, and stage. Conflicting and undated conversions are stated when present.
- **Unavailable states:** no local CRM ("Funil comercial não configurado"), stages missing or invalid, loading, a read error and a stale answer.
- **No link to the CRM deal.** A link would teach the generic screen the Atomic CRM's routes. The adapter can supply one later (§15).

## 8. Security and privacy

- **Tenancy:** only the owning tenant reads the funnel. Another tenant reads `not_configured`, byte for byte, whatever the CRM holds (`commercial_funnel.sql` T). The funnel follows ownership when it moves, and deliberate break X3 makes the adapter ignore the tenant; the tenancy check catches it.
- **Minimisation:** the projection carries no title, name, contact, contact id, email, phone, note, description, click id, campaign, keyword, UTM or actor.
  - The SQL suite plants a sentinel in every title, name, note, click id, campaign and keyword, and sweeps both text and keys (N).
  - The recorder sweeps the real projection.
  - The strict contract has no key for any of them.
- **No browser mutation:** no new `company_os_api` function, grant or act; the screen reads only the overview. The ledger has no browser privilege, and a CRM user cannot read or write it (L3).
- **Robust to what the CRM accepts.** The CRM lets a person enter a five-digit year or `infinity` in a date, and insert a deal with any id. The adapter therefore:
  - clamps every emitted instant to the years 0001 to 9999, while a next action keeps its raw classification;
  - counts, but never lists, a deal whose id a browser number cannot hold;
  - is isolated by the neutral entry: any other CRM fault makes the funnel read "unavailable", with a SQLSTATE-only warning, and the rest of the overview (Início, Agenda, Saúde operacional) still answers.

  Covered by `commercial_funnel.sql` R and X6, and by the strict parse of the whole overview in `companyOsFunnelRecording.dbtest.ts`.
- **Visibility within the tenant.** A Company OS member sees every opportunity of the local CRM, whoever owns it in the CRM. The CRM itself limits a non-administrator to their own deals. This follows the approved membership model (tenant-wide, explicitly granted by the owner, ADR 0019), and it is recorded as an owner question (§14), not decided here.
- **Invariants:** SI-66 (the ledger) and SI-67 (the funnel's read seam), each with enforcement points that go red by name.
- **Q8:** nothing in this phase reaches a model; every number is deterministic SQL.

## 9. Observability

No new metric, span or label: the funnel is part of the existing overview read, which the Company OS client already polls. No deal, stage, source or tenant becomes a label. Telemetry stays non-authoritative (SI-60, SI-61).

## 10. Bounds and indexes

- **Bounds:** 25 cards per stage (at most 30 stages), 10 per attention and outcome list, 15 movements, 8 named origins, with exact totals wherever a list is capped. Windows are fixed.
- **Indexes:**
  - `deals (next_action_at)`, limited to current deals (the board by stage uses the existing `deals_pipeline_stage_idx`; a composite index the first draft added was redundant with it and was dropped in review);
  - `deals (converted_at)` and `deals (lost_at)`, partial;
  - `deals (created_at)`;
  - the ledger by `(changed_at, id)` and `(deal_id, changed_at, id)`.
- **No materialised view,** at clinic scale.

## 11. Evidence (local)

Local runs on this machine after the review fixes (commit `0bea7c49`), each broad suite once, on a freshly reset e2e stack. Not CI: nothing is pushed.

| Check | Result |
| --- | --- |
| `npm run test:db` | 20/20 suites, including the new `commercial_funnel.sql` (F1, L1–L3, M, A, N, R, T and six deliberate breaks X1–X6, each caught by its own check) |
| `npm run test:db:engine` | 383/383 in 51 files, including `commercialFunnelLedger.dbtest.ts` (3: a verified lock wait, an eight-way race, a rollback under a waiter) and `companyOsFunnelRecording.dbtest.ts` (2: the recording from the real projection, and a strict parse with hostile CRM values) |
| `npm run test:db:upgrade` | PASS; no legacy deal gains history, and the operator's new deals record exactly their entries |
| `functions` unit project | 2144/2144 in 91 files; `securityInvariants.test.ts` 74/74 (66 invariants, SI-01 to SI-67, SI-07 retired) |
| `app` unit project (real Chromium) | 478 passed, 1 skipped, 0 failed in 59 files; Funil comercial 10/10 |
| `scripts/test` guard files | 15 files, 319 tests (`run-db-upgrade-test.test.mjs` collected after normalising its local working copy to LF) |
| `npm run typecheck` | 0 errors |
| `npm run lint` | 0 errors. The 64 warnings are the historical ones, all in files this branch does not touch or in a stray local worktree copy. The branch's changed files pass with `--max-warnings=0`. |
| Changed-file Prettier | green |
| `npm run build`, `npm run scan:build` | green; 20 text files, 0 blocking, 0 advisory |
| `node scripts/production-scope.mjs`, `node scripts/dev-signing-key.mjs` | OK |

**Found and fixed during development:**
- The concurrency test first deadlocked on the two-connection `adminPool()` (the trap `dbFixture.ts` describes); the racing transactions now have a pool of their own with a bounded wait.
- `company_os_api.sql` M2 and P5 correctly refused the first adapter, which was named `cos_atomic_crm_*` and read schema public. The adapter was renamed to the `crm_` convention, and the gate moved inside it.

## 12. Review

One focused final reviewer, the only subagent of the batch, over the whole diff `7c72e226..HEAD`, with read-only SQL experiments rolled back. It found **P0: 0 and P1: 1**, and the P1 is fixed.

- **P1 (fixed): values the CRM accepts could take down the whole overview.**
  - **What broke:** a five-digit year or `infinity` in `next_action_at`, `infinity` in `stage_entered_at`, or an explicitly inserted deal id ≤ 0 or above 2^53. They produced a timestamp the strict contract refuses, a card whose next-action state and instant disagreed, a SQL error (`cannot subtract infinite dates`) or a reference the contract refuses.
  - **Why it mattered:** the funnel is part of the overview, so every overview screen would have failed for every member.
  - **The fix:** `ops.crm_instant` clamps every emitted instant, classification stays on the raw value, out-of-range ids are counted but never listed, and the neutral entry isolates adapter faults as `unavailable`.
  - **Proof:** `commercial_funnel.sql` R and X6, and a strict parse of the funnel and the whole overview with these values in `companyOsFunnelRecording.dbtest.ts`.
- **P2 (fixed): a free-text origin could name a person.** A recorded label is now shown only when at least three distinct contacts carry it (§6). `commercial_funnel.sql` A proves a single-contact label is withheld.
- **P2 (recorded, not changed): members see every salesperson's deals.** It follows the approved tenant-wide membership model and is an owner question (§8, §14).
- **P3, fixed:**
  - `company_os_api.sql` no longer depends on the local CRM's stored stages: it removes them inside its own rolled-back transaction.
  - The redundant composite index is dropped.
  - The demo refuses a CRM holding contacts as well as deals, and commits ownership, stages and opportunities in one transaction.
- **P3, recorded:** the coverage start can move later when the earliest-observed deals are deleted, and replica-mode writes are not observed (§5).

Everything else the reviewer checked held:

- the single source of truth, with nothing reading the ledger to decide a stage;
- the tenant gate before any CRM read, with EXECUTE revoked everywhere;
- same-transaction, lock-serialised observations;
- ordinary CRM writes, including browser-role updates, deletes and a company-delete cascade;
- a declarative schema identical to the migration;
- 17 functions and no new grant;
- stages as data;
- narrow guard edits;
- every aggregate's definition.

## 13. Owner demo

Local and synthetic only. On a freshly reset e2e stack:

```bash
ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54342/postgres npm run funnel:demo
```

The demo:

1. gives the local CRM to the development seed's tenant, and sets its zone to America/Sao_Paulo if it has none;
2. saves the clinic's nine stages in the CRM's configuration, as its Settings would;
3. creates seventeen fictional opportunities through ordinary CRM writes: 2, 2, 2, 2, 1, 1, 1, 1 and 2 per stage, plus three recent losses, with Google Ads, Orgânico, Indicação, none and several-contact origins, and overdue, today, future and missing next actions;
4. moves three of them to their current stage, so the ledger observes real changes.

It refuses a CRM that already holds deals, a local CRM owned by another tenant, and a stored stage configuration it would replace.

**What the movement list shows.** It holds the seventeen entries and the three changes, all minutes old, because that is when the demo wrote them. The ledger cannot backdate an observation. A real clinic's entries carry their real creation times.

## 14. Decisions

**Recorded:** decision Q, the commercial funnel before RAG (sequencing only).

**Proposed, not made:**

1. **Commercial authority in Company OS** (move a stage, mark won or lost, set a next action). This needs a separate, explicit decision: an OD-8a migration, a catalogued function and an SI-58 extension. The board is deliberately read-only.
2. **Which next action is canonical** for commercial follow-up: the deal's or the contact's (§4).
3. **A link from a card to the CRM deal,** supplied by the adapter.
4. **An acquisition category mapping** (e.g. grouping "Google Ads" spellings). It would be tenant configuration, never code, and would also replace the three-contact threshold with a vocabulary.
5. **Funnel visibility inside the tenant:** whether every Company OS member should see every salesperson's opportunities, which is the current tenant-wide membership model, or only a CRM administrator.

## 15. Carried forward (not done here)

- **Phase 3A links:** follow-up and booking chips on opportunities. No existing opaque subject reference names a deal (3A subjects are a task, a conversation or a free reference), so no deterministic link exists and none was guessed.
- **Stage-to-stage conversion analytics:** possible once the ledger's coverage holds complete cohorts, meaning deals whose entry was observed.
- **The movement list** interleaves entries and changes, newest first. A later refinement could separate them.
- **Growth and marketing:** Google Ads, Umami, CPL, CAC and ROAS (a later growth phase), and generic `pipelines` tables (ADR 0013) when a tenant's CRM is not the local one.
- **The overview payload** now carries the funnel; at larger scale the funnel may want its own read.
- **Phase 3A UX backlog, unchanged:** "Follow-ups hoje" may read "Com vencimento hoje", and "Aguardando processamento" may leave "Agendados".

## 16. What this batch does not do

It adds none of:

- a browser mutation, drag and drop persistence, or create or edit from Company OS;
- a second commercial store;
- payments, billing, lead scoring, prediction or autonomous sales decisions;
- WhatsApp automation, a model call, RAG, pgvector, real Jev, the Model Router, the Google Ads API or Umami;
- a clinical feature, a public booking portal, or 3D or isometric UI.

It opens nothing of Q8.
