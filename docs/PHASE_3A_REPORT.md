# Phase 3A.1 + 3A.2 — Follow-up engine and scheduling / booking foundation: implementation report

| | |
| --- | --- |
| **Status** | **IMPLEMENTED LOCALLY. OWNER VISUAL REVIEW REQUIRED BEFORE THE SINGLE REMOTE INTEGRATION CYCLE.** Local commits on `feature/phase-3a-followup-scheduling`, not pushed, no PR. |
| **Base** | `feature/clinical-phase-1` at `c375d326943c4fba37c1b2f6c3e807d4cec93a40`, the PR #12 merge that integrated Phase 2E.1 + 2E.2. Post-merge CI Check #71 (run 36080551021): Build, Test, Typecheck, ESLint and Database security & reproducibility passed; only the historical e2e baseline (9 failed, 1 skipped) and the Prettier baseline (`sampleCsv.test.ts`, `canAccess.test.ts`) are red, so the overall workflow is red, not green. `main` unchanged at `a863e2a0`. |
| **Branch** | `feature/phase-3a-followup-scheduling` |
| **Governing records** | The Phase 3A brief (controlled batch, 2026-09-25), decision P (2026-09-22: 3A after 2E), [ARCHITECTURE_ACCELERATION_REVIEW.md](ARCHITECTURE_ACCELERATION_REVIEW.md) (cal.diy: reference only; scheduling on our own queue), CLAUDE.md's five rules. |
| **Data** | Synthetic data only. BASELINE Q8 OPEN. No real patient data; no production deploy. |

## 0. Position

| | |
| --- | --- |
| Phase 2E | **INTEGRATED** (PR #12, merge `c375d326`) |
| Phase 3A.1 | **FOLLOW-UP ENGINE**: implemented |
| Phase 3A.2 | **SCHEDULING / BOOKING FOUNDATION**: implemented |
| CalendarPort | **IMPLEMENTED** (provider-neutral port, deterministic fake provider, at-most-once sync lifecycle) |
| Google Calendar | **NOT CONNECTED** (§6: what is missing) |
| Browser scheduling mutations | **NONE** |
| Browser mutable RPCs | **2** (`decide_review`, `trip_stop`); company_os_api still 17 functions |
| Autonomous follow-up sending | **NO** |
| Q8 | **OPEN** |
| Real patient data | **NO** |
| Authoritative system | Company Engine / PostgreSQL; the calendar is an adapter |

## 1. What this batch is

The Company OS can now answer, from its own authoritative state and without any external calendar: which follow-ups are scheduled, which are due now, which were completed or cancelled, what the next follow-up of a subject is, which appointments exist, which times are free, whether bookings conflict (they cannot), what was rescheduled or cancelled, what comes today and this week, and whether a calendar mirror is local-only or simulated.

No scheduler, cron, second queue, workflow engine or worker type was added. No dependency was added. cal.diy was used as a reference for vocabulary only; nothing was copied or adopted. The engine is generic: nothing in DDL or engine code names a patient, a psychologist, a therapy or a session. The clinic's words ("Atendimento inicial", the 3/7/10-day cadence, America/Sao_Paulo) exist only as the synthetic demo's tenant data.

## 2. The follow-up engine (3A.1)

Migration `20260928120000_follow_up_engine.sql`, forward only.

- **Policies and versions.** `ops.follow_up_policies` (a tenant key and label) and `ops.follow_up_policy_versions` (1 to 12 strictly increasing offsets, in minutes from an anchor). A version is immutable; defining the same cadence again returns the latest version, and a different cadence is the next version. A plan stays bound to the version it was scheduled with. The demo cadence is 4320, 10080 and 14400 minutes (3, 7 and 10 days); another tenant defines another cadence with no DDL.
- **Plans.** `ops.follow_up_plans`: one per subject (a task, a conversation or an opaque reference such as `lead:DEMO-101`; never a name, phone, email or message), created once per tenant-scoped idempotency key (the same request returns the same plan; a different request under the key is refused OS409). At most one ACTIVE plan per subject, held by a partial unique index: a new plan for the subject supersedes the active one, and that plan's scheduled occurrences become `superseded` (a due one stays open work).
- **Occurrences.** `ops.follow_ups`: one per (plan, step), never two (unique). Its due time is DERIVED by the insert guard as the anchor plus the step's offset as a FIXED number of minutes (`make_interval(mins => …)`), so no session time zone or daylight-saving rule can move it; a caller's due time that disagrees is refused.
- **State machine**, an ENABLE ALWAYS trigger: `scheduled → due → completed`; `scheduled | due → cancelled`; `scheduled → superseded`. Only the occurrence's own due job makes it due; a closed occurrence never changes; reasons are snake_case codes, never text.
- **History.** Open work (an active plan, a scheduled or due occurrence) is never deleted, and nothing is truncated. No service deletes anything. Closed history may be deleted by the owner only (retention, LGPD erasure).
- **Services** (owner-only, SECURITY INVOKER): define a policy version, schedule a plan, complete or cancel a follow-up, cancel a plan. Every change records a content-free fact through `ops.record_event` (`follow_up.scheduled`, `due`, `completed`, `cancelled`, `superseded`; facts: the step and a cancellation's reason code).

### 2.1 Execution on the existing queue

Every occurrence gets ONE `follow_up.due` job via `ops.enqueue_job`, available at its due time (`available_at`), keyed `follow_up.due:<id>`. When the queue leases it, the handler (`engine/handlers/followUpDue.ts`) calls the worker's one new capability, `ops.mark_follow_up_due()`: lease-bound, argument-free, it resolves the occurrence from the live lease (never the payload) and moves it from scheduled to due. A replay finds it due or closed and changes nothing. The change and the job's completion share one transaction. **A due follow-up is operator work, never a permission to contact anyone**: no message, model, provider, CRM row or review is touched.

### 2.2 Stops: a new GOVERNED job class

`follow_up.due` is neither external (it calls nothing) nor internal (maintenance the kill switch never holds). Phase 3A adds a third class, **governed**: database-only work a company unit owns, transactional, and held by the ONE stop evaluator.

- At the lease: `ops.lease_job` already holds every queued kind that is not internal, so a covering stop keeps the job queued with no attempt consumed.
- At the start of its transaction: the runtime (`engine/worker/runOneJob.ts`, before the handler) asks `ops.job_execution_stop()`, which takes the kill-switch lock shared for the rest of the transaction, and a covering stop defers the job exactly as it defers an external call (queued again, attempt restored, a `deferred` job event).
- The capability re-checks under the same lock and refuses (OS423), so no path marks a follow-up due under a covering stop.
- `ops.job_covering_stop` resolves a follow-up job's company, department and (when the plan names one) agent from the plan, fixed at scheduling; a stop on another department does not hold it.

**What a stop means for follow-ups, exactly:** already-scheduled follow-ups stay recorded and untouched; a due job is held (at the lease) or deferred (after it), never destroyed; clearing the stop lets it run, and the follow-up becomes due. Scheduling a plan is admitted under a stop (it only records work), consistent with "admitted work is held, not destroyed". A job_kind stop cannot name `follow_up.due` (it names only external kinds, SI-37). SI-37 is amended to state the governed class.

## 3. The booking foundation (3A.2)

Migration `20260928130000_booking_foundation.sql`, forward only.

- **Configuration, all tenant data:** `ops.scheduling_settings` (the tenant's scheduling zone, which local day "today" is), `ops.booking_resources` (a professional, a room: kind and label are tenant words), `ops.booking_types` (duration 5–720 min, buffers before and after 0–240 min, the step between offered starts; a new duration is a new type), and `ops.availability_rules` (an ISO weekday, a local start and end time on whole minutes, an IANA zone, effective dates; a window never crosses midnight).
- **Time.** An authoritative instant is a `timestamptz`. A local clock time exists only inside a rule, always with its zone. Zones are validated against the database's own zone list. Nothing assumes UTC is local; nothing hardcodes Brazil.
- **Bookings** (`ops.bookings`): resource, type, start and end instants, the rule's zone, status (`booked`, `cancelled`, `rescheduled`), provenance (`source`), an opaque subject (task, conversation or reference), audit fields, and the predecessor of a reschedule. The insert guard DERIVES the end, the buffers and the occupied range from the type, snapshots them on the row, and a later type change never moves an existing booking. A booking's resource, type, time and subject are fixed.

### 3.1 Conflict prevention at the authority boundary

A GiST exclusion constraint, `bookings_no_overlap`: no two BOOKED bookings of one resource may have overlapping occupied ranges (`[start − buffer_before, end + buffer_after)`, half-open, so a booking may start exactly when the previous one's buffer ends). **Core PostgreSQL only, no extension:** `btree_gist` is available (1.7) but was not added, because the same correctness is provable without it; each resource has an internal, never-exposed `slot_key` (a unique identity), and the constraint compares `int8range(slot_key, slot_key, '[]')` with `&&` as the resource equality. The booking's slot key is bound to its resource by a composite foreign key. PostgreSQL enforces the constraint under every isolation level and for every writer, the owner's raw DML included: a racing booking of the same time waits for the first and fails (SQLSTATE 23P01, mapped to OS409 by the services). No `SELECT`-then-`INSERT` check exists. Cancelled and rescheduled bookings leave the constraint and so free their time.

### 3.2 Services

- **Create** (`ops.create_booking`): once per tenant-scoped idempotency key; the start is an instant in the future; the appointment must fit a window of an active rule on its own local date in the rule's zone.
- **Reschedule** (`ops.reschedule_booking`): ONE statement closes the booking as `rescheduled` (freeing its time) and inserts its successor under the constraint. If the new time is refused, the error leaves the function and the statement fails as a whole, so the original stays booked: never zero bookings, never two. One successor per booking (unique), so a chain never forks. Idempotent by key; two racing reschedules of one booking leave exactly one booked successor (the second waits on the row lock and finds it closed).
- **Cancel** (`ops.cancel_booking`): explicit, with a reason code, idempotent, records when, frees the time; a rescheduled booking is refused (its successor is the one to cancel). Nothing is deleted; a booked booking can never be deleted.
- **Slots** (`ops.available_slots`): deterministic, STABLE, bounded (a range of at most 31 days, at most 500 slots, never in the past). It walks whole UTC dates one day either side and anchors each rule's window in its own zone, so no session zone enters; it steps in absolute minutes from the window's start, and subtracts booked occupied time with the type's buffers.

**Daylight saving, as measured and pinned by tests:** a local time inside a gap moves forward by the gap (02:30 on New York's spring-forward day is 03:30 EDT), a repeated local time resolves to its later, standard-time occurrence, and 09:00 New York is 13:00Z before the November change and 14:00Z after it. America/Sao_Paulo has had no daylight saving since 2019.

Every change records a content-free fact (`booking.created`, `booking.rescheduled`, `booking.cancelled`; a cancellation's reason code is its only fact).

## 4. The calendar as an adapter (CalendarPort)

Migration `20260928140000_calendar_sync.sql`; `engine/calendar/`; `engine/handlers/calendarSync.ts`.

- **Not authoritative.** Company OS booking state is settled first, in PostgreSQL; a sync never changes a booking.
- **Connection.** `ops.calendar_connections`: per company, the provider kind and a generic event title the owner configures as data (required, no default: the demo configures "Atendimento", and a title is tenant vocabulary, never DDL). The **provider gate**, a CHECK, admits only `fake`: a real provider kind is a reviewed migration after its authentication and data-processing decisions. No credential or token column exists (asserted by the migration and by `follow_up_scheduling.sql` S6).
- **Lifecycle.** A booking change of a connected company requests ONE `ops.calendar_syncs` row and ONE job in the same transaction (an AFTER trigger on bookings): a new booking is a `create`, a rescheduled successor an `update` of its chain's event, a cancellation a `cancel`. A company without an active connection is local-only: nothing is requested.
- **Three external job kinds:** `calendar.create`, `calendar.update`, `calendar.cancel`. The one kill switch holds them at the lease and before the call; a job_kind stop can name each. A sync requested under a stop is recorded and its job held, never refused and never destroyed.
- **At most once** (the Phase 1D/2D shape): `ops.start_calendar_sync` records `running` BEFORE the call; a start that finds an earlier attempt's `running` settles it `indeterminate` (`execution_interrupted`) and never calls again; a timeout, an abort, a 5xx-like error or an unreadable answer is `indeterminate` and is never retried; only a provider that was not reached, or that refused without acting, is `failed`. A provider event id is stored only on an unambiguous success (a CHECK).
- **One chain, in order, at its current time.** A booking and its reschedule successors are one chain with one calendar event. Its syncs run in the order they were requested: a sync waits (nothing recorded, the job retries) while an earlier sync of its chain is not settled, and on its job's last attempt it stops waiting and settles `failed` (`earlier_sync_not_settled`), calling nothing, rather than staying pending with no job. A create or an update carries the chain HEAD's current times, never the times at request, so a create that runs after its booking moved places the event where the booking is now. A create whose chain head is no longer booked (cancelled before the create ran) is `skipped` (`booking_not_booked`) and creates nothing; an update or cancel whose chain has no confirmed event is `skipped` (`no_confirmed_event`). A sync that never started may settle `failed` without an event id (a worker with no provider).
- **Minimised request** (`CalendarEventRequestSchema`, strict): the generic title, the start and end instants, the IANA zone and an opaque reference (the sync's id). There is no field for a description, attendee, location, name, phone, email, note, message, model output, triage text, resource label or booking-type label; an extra key is refused before a provider sees it, and the database built the request from the booking's instants alone.
- **Providers.** `FakeCalendarProvider` (deterministic ids derived from the reference, scripted outcomes: ok, rejected, timeout, server error; opens no socket); the Google boundary (`googleCalendarProvider.ts`), which calls nothing. `CALENDAR_PROVIDER` (unset: none, a calendar job settles `failed` `provider_not_configured` without calling; `fake`; `google`) opts a worker in; anything else refuses to start.

## 5. Company OS: the Agenda (read only)

Migration `20260928150000_agenda_read_model.sql`: `ops.cos_agenda(tenant, as_of)`, returned by the EXISTING overview read as `agenda`, so no company_os_api function is added (still 17, exactly two acts) and the browser gains no mutation.

- **Deterministic:** a pure function of the rows and the instant; every window is keyed on an appointment's start or a follow-up's due time in the tenant's scheduling zone, never on the moment a change was recorded.
- **What it carries:** today's bookings in every state; the next 7 days' booked; the cancellations and reschedules in that window (with the successor's time); counts, including a verification count of overlapping booked bookings (always 0); follow-ups needing action, overdue (due before today), due today, awaiting the worker (scheduled and past due: the worker is not running, or a stop holds it), scheduled in the next 7 days and closed around this week; the next five free slots of each active resource and type in the next 14 days; the calendar's state (`local_only` or `simulated`) and the sync states of upcoming bookings.
- **Minimised:** ids of the tenant's own rows, instants, states, reason codes and configuration labels. Never a subject reference, name, phone, email, message, actor label, idempotency key, fingerprint, slot key, provider event id, error text or conversation id (the existing forbidden-key guard caught a `conversationId` during implementation; it was removed).
- **Screen:** Agenda (`/company-os/agenda`, group Operação), pt-BR, polled every 15 s; values read "Desconhecido" once stale. Headline cards: Hoje, Próximos 7 dias, Follow-ups vencidos, Follow-ups hoje, Próximo horário livre, Sincronização. Sections: Agenda de hoje, Follow-ups (Precisam de ação, Agendados, Encerrados recentemente), Próximos horários (with Cancelados ou remarcados nesta semana), Disponibilidade, Calendário ("Somente local" or "Simulado", always "Google Agenda: não conectado", uncertain syncs, and Detalhes técnicos with the zone and the conflict count). Times are shown in the agenda's own zone, not the browser's. The screen has no button, input or form; the note on follow-ups says the Company OS sends nothing on its own.
- **Saúde operacional:** one new attention item, "sincronização de calendário incerta em atendimentos futuros", linking to the Agenda, and owner labels for the four new job kinds (which also appear in its per-kind queue). The Activity feed learns the follow-up, booking and calendar facts (allowlisted types, content-free facts).
- **Recorded answers.** The shared recordings hold the empty agenda of a tenant with no scheduling rows (its local date pinned like `asOf`). A dedicated recorder (`companyOsAgendaRecording.dbtest.ts`) captures a fictional clinic's week from the real `ops.cos_agenda` at a fixed 2030 instant, maps its ids, parses it with the strict contract and sweeps it for every subject and actor it planted; the Agenda tests replay it.

## 6. Google Calendar: NOT CONNECTED, and what is missing

The repository has no approved Google authentication model: no OAuth client, consent screen or redirect, no service account or domain-wide delegation, no rule for storing or encrypting a refresh token, and no data-processing contract for sending a psychology clinic's appointment times to Google (LGPD). None was invented, no credential was requested, and no token schema exists. Connecting it needs, in order:

1. an owner decision on the authentication model (per-professional OAuth, or a Workspace service account) and on where and how a refresh token or key is stored and encrypted (never in plaintext, never in `ops` tables readable by any application role);
2. an owner decision on the data processing: which calendar, what an event may carry (the minimised request already carries only a generic title, times, a zone and an opaque reference), and the lawful basis;
3. a reviewed adapter behind `CalendarPort` (`googleCalendarProvider.ts` has the shape and calls nothing), using the governed external call this job kind already runs under;
4. a reviewed migration widening `calendar_connections_provider_gate`.

## 7. Security and privacy

- **Tenant isolation:** every scheduling row carries its tenant, and every reference is a composite foreign key or a guard (a plan cannot name another tenant's company, an occurrence another tenant's plan, a booking another tenant's resource or type, a sync another tenant's booking); every service scopes by the tenant it is given; the worker's three capabilities resolve their row from the live lease only; the agenda reads only the tenant's rows (S7 and the dbtests prove tenant B's rows never appear).
- **Access (SI-65):** no application or capability role holds a privilege on the eleven new tables (all ENABLE + FORCE RLS) or executes a scheduling service; the worker executes exactly `mark_follow_up_due`, `start_calendar_sync` and `settle_calendar_sync` (pinned in `company_domain_core.sql` A4/A5).
- **Browser:** reads only; no scheduling act; no phone, email, message, note, clinical text, token or secret in any projection; storage sweeps and the read-only sweep include the Agenda route.
- **Q8:** nothing in this phase reaches a model. Scheduling arithmetic is deterministic SQL. The calendar request carries no content.
- **Invariants:** SI-37 amended (governed class); SI-62 (follow-ups), SI-63 (bookings and conflicts), SI-64 (the calendar adapter), SI-65 (owner-only scheduling authority and the tool's act allowlist) added, each with enforcement points that go red by name if removed.

## 8. Operator tool and demo

- `npm run scheduling`: read-only by default (`followups`, `bookings`, `slots` in a read-only transaction) with exactly five acts: `followup complete`, `followup cancel`, `booking create`, `booking reschedule`, `booking cancel`. Each is one recorded, idempotent owner act; reasons are codes; an instant must carry its offset (a local time alone is refused before any connection opens); nothing prints a subject reference, an actor label or a key. There is no act that sends, marks a follow-up due, configures, or touches a stop. This is a new tool with its own invariant (SI-65); SI-39 (the ops tool) is unchanged.
- `npm run scheduling:demo`: local and manual only (§11).

## 9. Observability

No new metric or span name. The new kinds flow through the existing TelemetryPort: `follow_up.due` joins the job-kind label set (`company_os_jobs_total`, `company_os_job_duration_seconds`), and `calendar.create`, `calendar.update`, `calendar.cancel` are the external-call operations (`company_os_external_calls_total{operation,outcome}`, provider duration with `provider_kind="fake"`), all closed sets derived from the job-kind lists. No booking, follow-up, tenant or user-entered value is a label. Telemetry has no authority and its failure changes nothing (SI-61 unchanged).

## 10. Evidence (local)

Local runs on this machine, after the review fixes and the final contract fix (commit 7). Not CI: nothing is pushed.

| Check | Result |
| --- | --- |
| `npm run typecheck`, ESLint, Prettier on the changed files | green |
| `functions` unit project | 2140/2140 in 91 files; within it `securityInvariants.test.ts` 72/72 (64 invariants, SI-01 to SI-65, SI-07 retired), `migrationInvariants.test.ts` 139/139, `companyOsMigrationGuard.test.ts` 89/89, `companyOsEventAllowlist.test.ts` 13/13, `schemaReproducibility.test.ts` 32/32 |
| `app` unit project (real Chromium) | 467 passed, 1 skipped, 1 failed across 58 files. The failure was `ContactEdit.test.tsx` ("does not submit empty email and phone entries on mobile"), in a file this branch does not touch, and it passed 8/8 in isolation: the known load-sensitivity of this project. After the contract fix, `src/company-os` passed 221/221 in 26 files, the Agenda's 8 included. |
| `npm run test:db` | 19/19 suites, the new `follow_up_scheduling.sql` (S1 to S7 and 2 deliberate breaks, each caught by its own check) included |
| `npm run test:db:engine` | 378/378 in 49 files on a freshly reset stack (the first broad run found the contract gap of commit 7: 377/378) |
| `npm run test:db:upgrade` | PASS (legacy data kept its meaning; the owner guard halted and resumed) |
| `npm run build`, `npm run scan:build` | green; 20 text files scanned, 0 blocking, 0 advisory |
| `node scripts/production-scope.mjs`, `node scripts/dev-signing-key.mjs` | OK |
| `scripts/test` guard files (claude project) | 16 of 18 files green. The two reds are the recorded local-only false reds: `run-db-upgrade-test.test.mjs` does not collect on a CRLF checkout (a `#!` hashbang; CI on LF passes it), and a stale `.claude/worktrees/` copy of `pending-deploys.test.mjs` |
| `npm run check:local-exposure` | OK: every published binding loopback-only |

The final broad run found two defects that the focused runs had missed, both fixed in commit 7:

- The browser contract did not know the thirteen new event types or the `scheduling-demo` source. It would have refused every Phase 3A event in the Activity feed after the demo. Found by `companyOsContractVocabulary.dbtest.ts`.
- "appointment" in three `COMMENT ON` strings. Found by the tenant-vocabulary guard in `schemaReproducibility.test.ts`.

## 11. Owner demo

Local and synthetic only. On a freshly reset e2e stack: `npm run scheduling:demo` with `ADMIN_DATABASE_URL` and `OPS_WORKER_DATABASE_URL` on the same local database. It configures the development seed's tenant (zone America/Sao_Paulo, two fictional agendas, "Atendimento inicial" 50 min + 10 min after, every day 07:00–21:00, a SIMULATED calendar, the 3/7/10-day demo cadence), books today's and the week's free slots through the real services, cancels one and moves one, schedules four follow-up plans already past their first step, runs the real worker loop (follow-ups become due; the booking changes are mirrored to the fake calendar), then completes one follow-up, cancels another and leaves one waiting for the worker. Nothing is sent. Then open the Agenda.

Measured on 2026-09-25: 7 bookings (6 booked, 1 cancelled, 1 rescheduled), 4 plans, 6 calendar calls. The demo cancels and moves a booking BEFORE the worker runs, so the calendar outcome shows the §4 rules at work:
- the cancelled booking is never mirrored (create `skipped` `booking_not_booked`, cancel `skipped` `no_confirmed_event`);
- the moved booking's create carries its NEW time and is the fake's third create, which answers a scripted server error, so it is `indeterminate` and never retried;
- that booking's update is then `skipped` (`no_confirmed_event`);
- the other five creates are `synced`.

The Agenda reads: Hoje 2, Próximos 7 dias 4, Follow-ups vencidos 1 (2 need action), 1 awaiting processing, Sincronização "Simulado" with 1 uncertain sync, and "Google Agenda: não conectado". The Activity feed shows the follow-up, booking and calendar events (commit 7), and Saúde operacional raises "1 sincronização de calendário incerta ou com falha em atendimentos futuros". Note: the demo leaves queued future follow-up jobs in the seed tenant; run the driver-backed suites before it, or reset the stack after it.

## 12. Review

ONE focused final reviewer (the only subagent of the batch), on P0/P1 correctness and security over the whole branch diff. **P0: 0. P1: 0.** Its findings, all fixed in `f89e72ae`, each with a regression test:

- **P2:** an update or cancel sync that settled `failed` without a call (a worker with no calendar provider) violated `calendar_syncs_changed_event`, so its job failed permanently and the sync stayed `pending` forever. A sync that never started may now fail without an event id.
- **P2:** a create that ran after its booking moved or was cancelled sent the original times, and two changes of one chain could reach the provider out of order. Fixed as §4 describes: the chain head's current times, request order, `booking_not_booked`, and a `failed` give-up. Saúde operacional now flags failed as well as uncertain syncs.
- **P3:** a tenant word in DDL. The calendar event title had an "Atendimento" default; it is now required data.
- **P3:** SI-63's caveat now states that insert derivation and the foreign keys are ORIGIN-mode checks, while the exclusion constraint holds in every mode.
- **Note:** the agenda's windows are in hours, not days, so a session time zone near a daylight-saving change cannot move them.

The final broad run (§10) then found the two gaps fixed in commit 7.

## 13. Decisions for the owner (proposed, not made)

1. **The governed job class** (§2.2): approve it as an amendment to ADR 0017 §6 and SI-37.
2. **Calendar syncs requested under a stop are held, not refused** (§4): owner decision E refuses new agent runs and shadow decisions under a stop; a calendar sync is part of an admitted booking change, so it is recorded and held. Confirm.
3. **Browser scheduling actions** (book, reschedule, cancel, complete a follow-up): a separate, explicit authority decision (an OD-8a migration, a catalogued function, SI-58), not taken here.
4. **Google Calendar** (§6).
5. **Retention** of closed follow-ups, bookings and syncs (owner-deletable history; no retention job exists).

## 14. Carried forward (not done here)

- No resolution act for an uncertain or stuck calendar sync (a person resolves it outside the Company OS), and no resync after a failed one.
- No unavailable periods (holidays) in availability; no scheduling configuration commands in the CLI (the demo configures through the services).
- A follow-up plan is scheduled through the service (the demo, the tests); no CLI act schedules one, and nothing schedules one automatically from a triage.
- `ops.cos_agenda` computes up to ten resource/type pairs of slots on every overview read; at scale it may want a summary.
- Saúde operacional's "Chamadas externas" table (`ops.cos_operational_health`, Phase 2E) has no calendar row. Calendar outcomes are counted on the Agenda, and an uncertain or failed sync is a Saúde operacional attention item. A calendar row would redefine that projection, so it is left for an owner request.
- The demo leaves queued future follow-up jobs in the seed tenant, which a later driver-backed suite's worker could lease; reset before the suites.

## 15. What this batch does not do

It sends no message and adds no autonomous follow-up, reminder, text generation, WhatsApp automation or model call. It adds no RAG, pgvector, Google Ads, Umami, browser automation, real Jev, Model Router, Judge, clinical notes, billing, package sales, public booking portal, Google Meet automation or recurring treatment plans. It adds no browser mutation, no company_os_api function, no dependency, no scheduler or queue, and opens nothing of Q8.
