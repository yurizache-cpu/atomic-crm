# Domain event catalog

**What this is:** the canonical vocabulary of typed business events through which AI employees and surfaces collaborate ([ADR 0024](adr/0024-three-layer-company-os-and-outcome-engine.md) §3). Employees collaborate primarily through **events, tasks, state and decisions**, not free-form conversation. A consumer never parses chat history to learn what happened.

This catalog defines **semantics and status first**. An event marked PLANNED does not exist in the database. It is built in the milestone that needs it, which adds it here first.

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

---

## 1. Where events live

There is **one event store: `ops.events`** (ADR 0015 §7). This catalog extends it. It never adds a second bus, queue or store.

| Concern | How `ops.events` holds it today |
| --- | --- |
| Unique id | `id` (uuid) |
| Tenant | `tenant_id`, plus `company_id` (composite keys make a cross-tenant row unstorable) |
| Type | `type`, dotted lower case with at least one dot (`family.name`), checked by the table |
| Timestamp | `created_at` (the transaction start; `seq` orders insertion and is internal only, SI-26) |
| Source | `source` (the writer: `whatsapp-gateway`, `operator-cli`, `front-desk`, a worker, …) |
| Entity reference | `subject_type` and `subject_id` (`company`, `department`, `agent`, `task`, `agent_run`, the last added by `20260914120000_agent_runtime.sql`), plus ids in the payload. A new subject type is a migration of the table constraint |
| Payload | `payload`, a JSON object of at most 16 KB, **minimised**: ids, states, enums, amounts, instants |
| Correlation and causation | `correlation_id`, `causation_id` (the cause must already exist, same tenant and company) |
| Idempotency | An optional idempotency key on `ops.record_event` (a redelivery records nothing new) |

**Lifecycle facts are derived, never asserted:** task, agent and run lifecycle events are written by triggers from state changes (ADR 0015 §7). A service records a business fact through `ops.record_event` only for types that are not lifecycle-derived.

## 2. The event contract

Every important domain event conceptually defines:
- **unique id, tenant, type and version.** The version travels in the payload as `"v": <n>` once a type's payload shape changes; a consumer reads the versions it knows.
- **timestamp, source, and the entity references** (subject plus payload ids).
- **a minimal typed payload:** never free-form text, message bodies, drafts, phone numbers, health content or secrets (SI-52). A payload is `operational` data by construction (ADR 0020 §B).
- **an idempotency or correlation key** wherever the fact can be delivered twice (provider webhooks, uploads, retries).
- **data classification:** `operational` by rule. A type that would need a more sensitive payload is redesigned to carry a reference instead.
- **retention classification:** events are durable, content-free business facts. Content lives in its own store with its own clock (ADR 0020 §I, SI-72), never in an event.

## 3. Naming

- **Canonical names** (left column below) are the business names used in specifications: `first_appointment_paid`, `booking_created`.
- **Types** are what `ops.events.type` stores: `family.name` (`outcome.first_appointment_paid`, `booking.created`).
- Existing types keep their names. A planned event reuses an existing type when one already records the fact.
- **Service-business terms, not clinic terms.** Appointment, session, package and payment are generic for appointment-based businesses. Clinic words (patient, therapy) never appear in types (CLAUDE.md rule 2). Outcome kinds are tenant configuration of generic categories ([GROWTH_INTELLIGENCE_SPEC.md](GROWTH_INTELLIGENCE_SPEC.md) §3).

**Status legend:**
- **EXISTS:** recorded today;
- **PARTIAL:** the fact is recorded, but not as this event, or not completely;
- **PLANNED:** not recorded.

## 4. Acquisition

| Canonical name | Type | Status | Semantics | Producer → consumers |
| --- | --- | --- | --- | --- |
| `lead_attribution_captured` | `lead.attribution_captured` | PARTIAL: the CRM's `acquisition_attributions` table exists, nothing captures at entry and no event is recorded | Attribution metadata (source, campaign ids, UTM, click id) captured for a resolved person | Entry adapters → Outcome Engine, Analytics, Growth |
| `lead_created` | `lead.created` | EXISTS (ADR 0026 §C): the WhatsApp admission created a CRM contact, its lead profile and a `whatsapp` attribution for a registered test sender the CRM did not know; producer `ops.crm_create_whatsapp_lead`, source `whatsapp-gateway`, subject the company, payload `{channel_id, conversation_id}` (the browser reads only the channel), once per conversation | A new person entered the funnel (after identity resolution) | Identity resolution → Reception, Analytics, Daily Brief |
| `lead_opted_out` | `lead.opted_out` | EXISTS (ADR 0026 §C): the worker recorded a contact's own opt-out in the CRM (`lead_profiles.do_not_contact` true, recorded in the consent ledger as the system's) after its acknowledgement settled or the window ended; producer `ops.settle_crm_opt_out_request`, source `agent-runtime`, subject the opt-out message's task, no payload | A contact asked to stop and the CRM now says so | CRM → Reception, Analytics |
| `triage_started` | `triage.started` | PLANNED | The structured triage questionnaire began (path B) | Reception → Analytics |
| `triage_completed` | `triage.completed` | PLANNED | Every required triage field is present (path A or B); a deterministic fact | Reception → Outcome Engine, Analytics, next best action |

The existing `lead_triage.*` types are the AI reading one message (the `lead_triage` capability). They are **not** the questionnaire above.

## 5. Communication

| Canonical name | Type | Status | Semantics |
| --- | --- | --- | --- |
| `message_received` | `communication.received` (admitted), `communication.inbound_refused`, `communication.inbound_held` | EXISTS | An inbound message became work, was refused on the record, or was held; content-free (SI-53) |
| `reply_generated` | `agent_run.succeeded` + `lead_triage.review_pending` | EXISTS | A run produced a reply candidate and a review opened; the draft lives on the review item, never in the event |
| `reply_reviewed` | `lead_triage.reviewed` | EXISTS | A person (or the owner CLI) decided the review |
| `message_sent` | `communication.outbound_authorized`, `communication.outbound_attempted`, `communication.outbound_sent`, `communication.outbound_failed`, `communication.outbound_indeterminate`, `communication.outbound_blocked`, `communication.delivery_updated` | EXISTS | The send lifecycle, at most once (SI-50), and Meta's delivery statuses |
| `human_takeover_started` / `human_takeover_ended` | `ops.conversation_transitions` (holder agent ↔ person) | PARTIAL: an append-only transition record exists; no `ops.events` row. Since ADR 0025 each message that arrives while a person holds the conversation is counted on a `message_waiting` exception (`exception.raised` when it opens) | A person took a conversation over, or released it. Becomes an event when the exception inbox consumes it |
| `follow_up_due` | `follow_up.due` | EXISTS | A follow-up occurrence came due: operator work, never a send (SI-62) |
| `follow_up_completed` | `follow_up.completed` (also `follow_up.scheduled`, `.cancelled`, `.superseded`) | EXISTS | The follow-up's lifecycle |

## 6. Scheduling

| Canonical name | Type | Status | Semantics |
| --- | --- | --- | --- |
| `availability_offered` | `scheduling.availability_offered` | PLANNED (optional) | Slots were offered in a SENT reply or shown on the booking page. Analytics only, recorded on send, not on draft |
| `booking_created` | `booking.created` | EXISTS | A booking occupies a resource's time (no overlap, SI-63) |
| `booking_rescheduled` | `booking.rescheduled` | EXISTS | Atomic, idempotent move |
| `booking_cancelled` | `booking.cancelled` | EXISTS | The time is freed |
| (calendar mirror) | `calendar.sync_requested`, `.sync_completed`, `.sync_failed`, `.sync_indeterminate`, `.sync_skipped` | EXISTS (fake provider) | The external calendar mirrors bookings and is never their authority (SI-64) |
| `appointment_confirmed` | `appointment.confirmed` | PLANNED | The person confirmed (T-24h action) or payment confirmed the first appointment |
| `appointment_attended` | `appointment.attended` | PLANNED | The appointment happened: the psychologist's record or an authorized act |
| `appointment_no_show` | `appointment.no_show` | PLANNED | The person did not attend |
| Slot hold | `booking.hold_placed`, `booking.hold_released` | PLANNED | A short-lived reservation while a person completes a booking |

## 7. Payments

All PLANNED. No payment provider is connected.

| Canonical name | Type | Semantics |
| --- | --- | --- |
| `payment_requested` | `payment.requested` | Payment instructions or a link were sent for a booking or a package |
| `payment_pending` | `payment.pending` | The provider reports a payment in progress |
| `payment_confirmed` | `payment.confirmed` | **Authoritative settlement:** a provider webhook, verified and idempotent, or an authorized manual confirmation (who, when). Never a receipt image, never a model |
| `payment_failed` | `payment.failed` | Settlement failed or expired |
| `payment_refunded` | `payment.refunded` | A refund; offsets revenue and outcomes, never edits them |

## 8. Commercial outcomes (the Outcome Engine)

Outcomes are **derived once from authoritative domain facts** by the Outcome Engine. They are not a second record of those facts: they add value, attribution and funnel meaning. All PLANNED.

| Canonical name | Type | Derived from | Value |
| --- | --- | --- | --- |
| `first_appointment_booked` | `outcome.first_appointment_booked` | The person's first `booking.created` | None, or the expected price |
| `first_appointment_paid` | `outcome.first_appointment_paid` | `payment.confirmed` for the first appointment | Confirmed amount |
| `first_appointment_attended` | `outcome.first_appointment_attended` | `appointment.attended` for the first appointment | None |
| `package_offered` | `package.offered` | An approved administrative offer was sent | Offered price |
| `package_purchased` | `outcome.package_purchased` | `payment.confirmed` for a package | Confirmed amount |
| `package_renewal_due` | `package.renewal_due` | The package ledger reaching its threshold | None |
| `package_renewed` | `outcome.package_renewed` | `payment.confirmed` for a renewal | Confirmed amount |

The CRM's commercial acts (move, next action, convert, lose; `ops.commercial_acts`, Phase 3B.2) and the deal stage ledger (`public.deal_stage_transitions`) stay the CRM funnel's own records (SI-66 to SI-68). The Outcome Engine milestone defines how a confirmed outcome and a deal conversion relate, with one writer.

## 9. Sessions and packages

All PLANNED except where noted.

| Canonical name | Type | Semantics |
| --- | --- | --- |
| `session_scheduled` | `booking.created`, with a package reference in the payload | A package session booked. PARTIAL: bookings exist, packages do not |
| `session_completed` | `appointment.attended`, with a package reference | **The only event that consumes a package session.** Never "link sent" |
| `session_cancelled` | `booking.cancelled`, with a package reference | Cancelled under the rule; the ledger records whether it consumed a session |
| Package activated / completed / expired | `package.activated`, `package.completed`, `package.expired` | The package ledger's lifecycle |

## 10. Growth

All PLANNED.

| Canonical name | Type | Semantics |
| --- | --- | --- |
| `conversion_ready_for_upload` | `conversion.ready_for_upload` | An outcome of an enabled conversion type is ready; its key is the outcome's source fact |
| `conversion_uploaded` | `conversion.uploaded` | The platform accepted it (once, idempotent) |
| `conversion_upload_failed` | `conversion.upload_failed` | Refused or indeterminate; reconciled, never blindly re-sent |
| `attribution_reconciled` | `attribution.reconciled` | Uploaded and accepted conversions agree, or the mismatch became an exception |

## 11. Management

| Canonical name | Type | Status | Semantics |
| --- | --- | --- | --- |
| `exception_raised` | `exception.raised` | EXISTS (ADR 0025 Part A, migration `20261016120000`; Proposed for the owner's review). Health's "Precisa de atenção", stops and indeterminate work stay their own reads | Something needs a person. Producer: the database only (`ops.record_inbound_screening` for the conversation kinds, `ops.sync_send_exceptions` for a send, after its settlement), never a model. Source `exception-queue`, subject the message's or send's task. Payload: `exception_id`, `kind` (`opt_out`, `person_requested`, `configuration_missing`, `message_waiting`, `contact_unresolved`, `do_not_contact`, `send_failed`, `send_indeterminate`), `priority` (`high`, `normal`, derived from the kind; danger is no kind, owner decision 2026-10-08), `subject_kind` (`conversation`, `outbound_message`), and `detail` for `contact_unresolved`. Keyed on the episode; a repeat while it is open is counted on the `ops.exceptions` row, with no second event. Consumers: the owner tool `front-desk exceptions`, the activity feed (kind and priority), the Layer 3 inbox later |
| `exception_resolved` | `exception.resolved` | EXISTS (ADR 0025 Part A) | The episode closed. Producer: a release (`released`), provider evidence or a reachable contact (`reconciled`), or a person's act `front-desk exception resolve` (`resolved`, `dismissed`). Payload: the raised payload's id, kind, priority and subject kind, plus `resolution`; who resolved it stays on the `ops.exceptions` row. The browser reads the kind, the priority and the resolution |
| `approval_requested` | `approval.requested` | PARTIAL: review items are the first approval kind | An act waits for the owner's approval |
| `approval_decided` | `approval.decided` | PARTIAL: `lead_triage.reviewed` | The owner decided |
| `daily_brief_generated` | `management.daily_brief_generated` | PLANNED | A brief snapshot was computed (figures only) |

## 12. Existing infrastructure events (kept as they are)

- **Organisation:** `company.created`, `company.status_changed`, `department.created`, `department.status_changed`, `agent.created`, `agent.status_changed`.
- **Work:** `task.created`, `task.assigned`, `task.status_changed`, `task.execution_requested`, `task.completed`, `task.failed`, `task.cancelled`.
- **Runs:** `agent_run.requested`, `agent_run.started`, `agent_run.succeeded`, `agent_run.failed`, `agent_run.cancelled`, `agent_run.indeterminate`.
- **Front desk:** `lead_triage.admitted`, `lead_triage.review_pending`, `lead_triage.reviewed`.
- **Channels:** `communication.channel_configured`.

Other append-only records stay where they are and are **not** duplicated into events:
- structured decisions (`ops.structured_decisions`);
- decision outcomes;
- screenings;
- conversation transitions;
- privacy notices;
- the retention ledgers;
- execution stops;
- commercial acts.

An event is added for one of them only when a consumer needs it.

## 13. Rules for adding an event

1. Add it to this catalog first, with its canonical name, type, semantics, producer, consumers and payload fields.
2. Reuse an existing type when it already records the fact. Never two events for one fact.
3. A payload is ids, states, enums, amounts and instants. Anything else is a reference.
4. A fact that can arrive twice carries an idempotency key.
5. The browser contract's known types (`ops.cos_event_known` and `contracts/company-os-api/`) are updated in the same milestone, or the Company OS shows the event as unknown.
6. Never let a model record a business fact. A model's output is a review item, a structured decision or a draft, never an event of the families above.
