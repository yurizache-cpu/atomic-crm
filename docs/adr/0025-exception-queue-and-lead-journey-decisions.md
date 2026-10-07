# ADR 0025 — The exception queue, and the decisions the lead journey core needs

**Status:** Part A **Proposed for the owner's review**. It is implemented on `feature/lead-journey-core` (migration `20261016120000_exception_queue.sql`, SI-82) and not integrated. On acceptance it amends Accepted ADR 0023 §G in three ways (A3). Part B **Proposed**: owner decisions, nothing built. **Date:** 2026-10-07.

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

## Context

Milestone 2 of the program map ([CURRENT_STATE.md](../CURRENT_STATE.md) §8) is the lead journey core:
- identity resolution;
- attribution at entry;
- structured triage;
- the first catalogued events: `lead.created`, `lead.attribution_captured`, `triage.completed` and `exception.raised` ([DOMAIN_EVENT_CATALOG.md](../DOMAIN_EVENT_CATALOG.md)).

A map of the code (2026-10-07) found that most of it rests on decisions only the owner can make:
- **W6.** ADR 0021 W6 (a), decided, says no reply goes to a number outside the CRM. Creating a lead for a new number therefore revises an owner decision.
- **Contact writes.** Capturing attribution, or creating a contact, would be the first write from the Company OS into the CRM's contact tables. Today only the four deal acts write `public.*` (SI-68).
- **Health fields.** Structured triage fields include health content (the intake form's demand, its duration and its rating). The CRM's schema says it holds no clinical data.

One part rests on no new decision, and closes real gaps:
- A conversation moved to a person (danger, a request for a person, an opt-out) records no event, and nothing lists it. Messages that arrive while a person holds a conversation are listed nowhere either.
- A registered test device with no CRM contact gets a model call and a review that can never be accepted or sent, because W6 refuses it at the send. The cost is spent, and the review page offers a reply nobody can send.
- A failed or uncertain send is visible only through `npm run messaging -- outbound list`.

[RECEPTION_OPERATIONS_SPEC.md](../RECEPTION_OPERATIONS_SPEC.md) §19 says Reception raises `exception_raised` for exactly these, among others. [MANAGEMENT_OS_SPEC.md](../MANAGEMENT_OS_SPEC.md) §4 places the inbox in Layer 3.

An adversarial design review of the first draft found that raising only on a holder move would hide danger in a conversation that was already held, and that a send's exception written inside its settlement could undo a settled provider call. A second review, of the implementation, found that an open episode absorbed a repeat in silence, so a person could resolve danger without seeing a newer danger message, and that a message screened out of order could reconcile a newer refusal. The design below answers each finding.

## Part A. The exception queue

### A1. One store, with its events

`ops.exceptions` holds one row per exception episode. Each row carries:
- the tenant, the company, and the task of the message or send it came from;
- a **kind** from a closed engine vocabulary, and a **priority** the database derives from it;
- a **subject**: a conversation, or a send of that conversation, by its ops id. It never holds a CRM id, a phone number or text;
- for `contact_unresolved`, **why**: the admission's own answer (`not_found`, `ambiguous` or `unavailable`);
- when and by whom it was raised and resolved, and the **resolution**;
- how many times it **occurred** while open, with the latest occurrence's instant and message.

At most one episode is open per subject and kind (a partial unique index). Raising it again while it is open counts one more occurrence on it, with no second event. After it is resolved, a new occurrence is a new episode.

Each episode records `exception.raised` when it opens and `exception.resolved` when it closes, in the one event store (ADR 0024 §3):
- source `exception-queue`;
- subject the task;
- payload: the exception's id, kind, priority and subject kind, plus `detail` when raised or `resolution` when resolved;
- each event keyed on the episode's own id, so a repeat is the same fact.

The browser reads only the kind, the priority and the resolution.

An exception is raised open. While open it only counts a repeat; otherwise its identity never changes. It is resolved once and is then final. It leaves only with its subject, by a foreign key's cascade; a direct delete and a truncate are refused.

| Kind | Raised when | Priority | Resolved |
| --- | --- | --- | --- |
| `safety` | The screen found danger, whoever holds the conversation | urgent | only by a person's act |
| `opt_out` | The contact asked to stop, whoever holds the conversation | normal | only by a person's act |
| `person_requested` | The contact asked for a person (pack v4), whoever holds the conversation | high | `released` by the release, or a person's act |
| `configuration_missing` | The screen needed a fixed text the agent has not published, so a person holds the conversation | high | `released`, or a person's act |
| `message_waiting` | A message was held because a person holds the conversation (each one counted, whatever else is open) | normal | `released`, or a person's act |
| `contact_unresolved` | The conversation's newest admission found no single CRM contact (`not_found`, `ambiguous`, `unavailable`) | high | `reconciled` once the newest admission finds the contact reachable, or a person's act |
| `do_not_contact` | The conversation's newest admission found a CRM contact marked do-not-contact | normal | `reconciled` once the newest admission finds it reachable, or a person's act |
| `send_failed` | A send settled failed, except one the stale-reply gate stopped before any call (`newer_message`, ADR 0023 §L) | normal | `reconciled` by delivery evidence, or a person's act |
| `send_indeterminate` | A send's outcome is uncertain: settled indeterminate, or left `sending` past the five minutes after which a person may mark it | high | `reconciled` when it leaves indeterminate (to sent, delivered, read or failed), or a person's act |

A person resolves with `resolved` or `dismissed`, naming the count of occurrences the listing showed. If the exception recurred since, the act is refused (OS409) and the person lists it again: nobody resolves an occurrence they did not see. The database records `released` and `reconciled`. The vocabulary is engine words, never tenant vocabulary (CLAUDE.md rule 2).

### A2. Raised deterministically, where the facts are decided

A model never raises or resolves an exception (DOMAIN_EVENT_CATALOG §13.6).

**The screening.** `ops.record_inbound_screening`, the worker's lease-bound capability, raises the conversation kinds after it records the screening. It raises from the screening's own facts, not from a holder move, so a later danger message in a conversation that is already held still raises `safety`. It raises:
- `safety`, `person_requested` and `opt_out` from the screen's classes, whoever holds the conversation;
- `configuration_missing` when it held a message for want of a published fixed text;
- `contact_unresolved` or `do_not_contact` while the conversation's newest admission says no reply can reach the contact;
- `message_waiting` for each message held because a person holds the conversation.

An open `contact_unresolved` or `do_not_contact` is reconciled once the conversation's newest admission finds the contact reachable. The newest admission decides, not the screened message: messages are not screened in the order they arrived (several workers, a retry's backoff), and an older message must neither reconcile a newer refusal nor reopen a settled one. Only a message with a conversation raises: a synthetic admission has none.

**A send.** `ops.sync_send_exceptions` derives a send's exceptions from its state, under the send's row lock, as every writer of it takes it. Each kind is raised at most once per send, and never again once a person resolved it. It runs:
- in the gateway's status entry (`ops.receive_whatsapp_status`), for a failure the provider reports after the send and for the evidence that settles an uncertain or failed one;
- in the owner's mark (`ops.mark_outbound_indeterminate`);
- after the send act ends a send failed or indeterminate, in a transaction of its own (TX4 in `engine/domain/outboundSend.ts`). It never runs inside the transaction that called the provider and settled the send, so no failure of it can undo a settled call (the Phase 2A §16 rule). Asking again for a send already settled so runs TX4 again. If TX4 fails, the settlement stands, the report says `exceptionsSynced: false` (the messaging tool warns), and asking again or `front-desk exceptions sync` records it.

A send blocked at the last gate, or refused at the request, raises nothing: it was never called, and the person who ran the send act sees the refusal in its answer.

**The release.** `ops.release_conversation` locks the conversation's state first. It is refused (OS409) while a `safety` or `opt_out` exception is open on the conversation: a person resolves those with the act, then releases. A release resolves `person_requested`, `configuration_missing` and `message_waiting` as `released`, by the person who released. It never resolves a send's exception. An operator's takeover raises nothing: a person chose to hold the conversation, and a message that then arrives raises `message_waiting`.

Lock order: the conversation's state, then a send, then the exceptions. The owner's act locks only the exception it resolves.

### A3. A contact no reply can reach gets no model

The screening now holds a message before any model or fixed text when all of these hold:
- it is not danger, a request for a person or an opt-out;
- it has a conversation;
- its admission's do-not-contact snapshot says no reply can reach the contact (ADR 0021 W6 (a), SI-48). Unknown counts as unreachable.

The disposition is `held_for_person`: no model, no Jev, no review. The answer keeps its exact shape.

The holder does **not** move. The agent keeps the conversation, so once a person creates or links the CRM contact (W6 (a)), the contact's next message is answered as usual and reconciles the exception. Danger, a request for a person and an opt-out are decided as before, before the hold, and from such a contact also raise `contact_unresolved` or `do_not_contact`.

**Limits:**
- The held message itself stays unanswerable through the system: its admission snapshot says do-not-contact. `front-desk reply` refuses it, because the person does not hold the conversation, and an accept of such a review is refused anyway. A person waits for the contact's next message. Answering the held message after a person links the contact is a Part B decision (B1).
- A3 applies to agents with a published operating policy (the front desk). A lead-triage agent without one is unchanged; Q8 keeps its data synthetic or test.
- **On acceptance, Part A amends ADR 0023 §G in three ways:**
  1. its automatic holds gain "a contact no reply can reach", a hold the agent keeps (the holder does not move);
  2. a release is no longer unconditional: it is refused while a `safety` or `opt_out` exception is open;
  3. `front_desk_held_for_person` no longer implies that a person holds the conversation. `front-desk reply` still answers the latest held message: after a takeover with no newer message, that is the held message itself, and its accept is refused because its admission said no reply could reach the contact.
- It also changes the owner's test procedure: a registered test device needs a CRM contact, with the opt-out recorded false, or every message from it is held.

### A4. Who reads and resolves

- **Owner tool, read-only by default:** `npm run front-desk -- exceptions --tenant <uuid> [--all]` lists open exceptions (or all), most urgent first. It shows kinds, priorities, ids and instants, never text.
- **Owner act:** `npm run front-desk -- exception resolve --tenant <uuid> --id <uuid> --resolution resolved|dismissed --occurrences <n> --actor <label>`. `<n>` is the count the listing showed; a stale count is refused. A repeat answers the recorded resolution and records nothing.
- **Owner act:** `npm run front-desk -- exceptions sync --tenant <uuid>` derives every send's exceptions once. It skips a send a transaction holds. Use it after a send whose exception could not be recorded, and once after applying this migration, for the sends that already exist.
- **The browser** sees `exception.raised` and `exception.resolved` in the activity feed. The Layer 3 inbox screen is not built here.

### A5. What does not change, and what is not covered

- What reaches a model is unchanged for every message that reaches one (SI-80, amended only to name A3's hold).
- No CRM write, no new browser act, no new worker or gateway capability, no new dependency.
- The send's own checks are unchanged (SI-49, SI-50, SI-81).
- **Not covered:**
  - A message refused before its screening raises nothing, because nothing screened it: an execution stop, the Q8 gate, or a spend limit at the request.
  - A run that ends after its screening sent it to the model raises nothing either: the agent's daily ceiling or another refusal at the run's start (the Q8 re-check, the route, a spend limit reached since the request, no gateway candidate), and a failed, invalid or indeterminate run. Its conversation stays with the agent with no review. A `reply_not_drafted` kind, raised by the post-settlement step the review already uses, would cover it. That is a follow-up, never a write inside a paid settlement.
  - A send left `sending` by a process that died is listed only once a status callback, the owner's indeterminate mark or the owner's sync reads it, five minutes after it began. No periodic sweep runs.
  - Nothing is backfilled at migration time. The owner's sync lists past sends, and a held conversation's next message lists the conversation.
  - Each item's owner and due time (MANAGEMENT_OS_SPEC §4) are left to Layer 3. Columns for them could be set when an exception is raised without a guard change, but assigning them to an existing exception needs the guard amended.
  - A person's reply does not resolve `message_waiting`. The person resolves it, or the release does, and a later held message is counted on it in the meantime.
- A `do_not_contact` episode a person dismissed opens again with the contact's next message: each message from such a contact is a new fact for a person. Whether a message from an opted-out contact may lift the opt-out is an owner policy (B7), not something Part A implies.

## Part B. Decisions the rest of the lead journey core needs (owner, Proposed)

Each decision lists the options and a recommendation. Nothing in Part B is built.

- **B1. A lead for a new WhatsApp number (revises W6).**
  - Options:
    - (a) keep W6 (a): a person creates or links the contact, which Part A now makes visible;
    - (b) an owner act creates the CRM contact and its lead profile from a held conversation, marked do-not-contact until a person confirms;
    - (c) automatic creation at admission.
  - **Recommended: (b).** It is one recorded person act. It leaves the gateway path untouched (SI-48, SI-53), and no reply is possible before a person decides. The same act could re-answer the held message, once the contact is reachable.
- **B2. The first Company OS write into the CRM's contact tables.**
  - The adapter is a `crm_` write adapter, gated on `owns_local_crm` like the deal acts (SI-68), with its own invariant and write-path pins.
  - **Recommended:** one adapter for "create contact with phone, and its lead profile", and one for "append an attribution touch". Nothing else.
- **B3. Identity resolution beyond an exact phone match.**
  - Options:
    - normalise phones at write, which needs a country rule SI-48 forbids guessing;
    - keep exact match, and raise `contact_unresolved` for the rest (Part A).
  - **Recommended:**
    - keep exact match;
    - add an email match only for the form channel;
    - keep merges a person's act (the CRM's `merge_contacts`, consent as OR).
- **B4. Attribution at entry.**
  - Meta's webhook can carry an ad referral for click-to-WhatsApp ads, which the gateway parser drops today.
  - **Recommended:**
    - verify the current fields in Meta's documentation first;
    - capture them on the admission record (commercial metadata only, never text);
    - append them to `acquisition_attributions` through B2's adapter once the contact exists, keeping the first touch;
    - add a first-touch marker to the table, since today the CRM panel overwrites the latest row.
- **B5. Structured triage and its health fields.**
  - The question set is versioned configuration (a new kind), and each field has a data class.
  - **Recommended:**
    - store health-class answers only in an ops table under the D6/D7 retention clock, never in the CRM, an event or a model's input;
    - carry `triage.completed` as counts, path and version only;
    - make completion deterministic, or a person's act, never a model's extraction (the screen omits health answers before any model).
  - The owner names the fields.
- **B6. The subject of lead events.**
  - `ops.events` subjects are company, department, agent, task and agent_run.
  - **Recommended:** a `conversation` subject for Reception facts. The CRM contact is referenced only as the opaque `crm:contact:<id>`, never as a foreign key into `public.*` (CLAUDE.md rule 1).
- **B7. A message from a contact who opted out.**
  - Today the CRM flag is the only gate (ADR 0021 W3 (b)), and nothing lifts it but a person in the CRM.
  - Options:
    - (a) a message never lifts an opt-out;
    - (b) a person may lift it after the contact writes again, with the message recorded as the reason;
    - (c) a message lifts it automatically.
  - **Recommended: (b).**
  - Related: once the flag is recorded, the opt-out acknowledgement can no longer be sent (eligibility refuses do-not-contact), so it must leave before the flag is recorded. That ordering is the owner's call too.

## Consequences

- Reception's exceptions become durable, deterministic, deduplicated facts with a recorded resolution. The Layer 3 inbox later reads them. Nothing moves out of its own authority: reviews stay reviews, and stops stay stops.
- A message whose reply could never be sent costs nothing on the front desk, and a person is told.
- Danger and an opt-out keep the conversation with a person until a person says they were dealt with.
- The rest of the lead journey core waits on B1 to B7.

## What this record does NOT do

- It does not open production, authorize real data or change the send gates.
- It does not create CRM contacts or write attributions (B1, B2, B4).
- It does not build the inbox screen (Layer 3) or the triage questionnaire (B5).
