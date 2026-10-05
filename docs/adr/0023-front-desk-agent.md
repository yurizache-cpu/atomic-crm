# ADR 0023 — The front-desk agent: an AI receptionist that screens before any model

**Status:** Accepted (owner product correction, 2026-10-04). Implemented on `feature/ai-receptionist` (migration `20261011120000_front_desk_agent.sql`). **Date:** 2026-10-04.

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

## Context

ADR 0021 recorded W1 as "no health information is ever fed to AI through OpenRouter; real patient messages are triaged by people". The owner corrected it on 2026-10-04. **The owner's rule is the first clause only.** The second clause was a wrong reading. The owner's product model is:

- **Lead.** A person who writes to the clinic's WhatsApp is a lead, not a patient. An AI receptionist (the models, with Jev where useful) answers them on administrative and commercial matters: how the service works, prices, format, availability, scheduling the first session, payment instructions, reminders, rescheduling, cancellation, follow-up, and a person when needed.
- **First session.** The psychologist conducts it. The receptionist provides no care.
- **Patient.** A lead who contracts treatment after the first session becomes a patient and talks to the psychologist directly about treatment, outside this system. Administrative matters (rescheduling, cancellation, payment administration, logistics) still go through the receptionist.
- **A person can take over** any conversation; that is the exception, not the default.

The code before this ADR answered one message at a time, sent the raw message text to the model and to Jev for test data, had no configuration the owner could version, no conversation memory, and no way to hand a conversation to a person.

## Decisions

### A. The domain distinction is policy, not a prompt

The engine stays domain-independent (CLAUDE.md rule 2; the vocabulary guard refuses words like "patient" or "clinical" in engine DDL), so the engine names the two parties **prospect** and **client**, and the agent a **front desk**. The tenant's words (lead, patient, recepção) are data.

- A conversation's **party kind** is derived deterministically when a message is screened: a CRM contact with a converted deal is a `client`; a number with no contact, or a contact without one, is a `prospect`; an ambiguous or unavailable CRM is `unknown`. The one reader is the CRM adapter `ops.crm_contact_is_client`, which serves only the tenant that owns the local CRM.
- A message with nothing but sensitive content gets a different fixed reply by party kind: a prospect is told this is talked about in the session; a client is told to talk to their professional directly.
- The model is told the party kind and that a client is served logistics only; the operating policy lists what each party kind may be served.

### B. Screen before any model: deterministic filter and selective omission

Pipeline: raw WhatsApp message → local screen → screened text → (Jev, shadow) → the agent's capability → Q8's authorized pool → OpenRouter → the model → a reply candidate → a person's review → the separate send act.

- **Where.** In the worker, for every `lead_triage` run of an agent with a published operating policy, before a route is chosen (`engine/handlers/agentRunExecute.ts`). The screen is `engine/frontDesk/messageSanitizer.ts`, version `front_desk_screen.v2` (v1 collapsed line breaks before splitting, so a clause on its own line could ride along with an administrative one; fixed before the merge, PR #28 review).
- **How.** Structured identifiers (e-mail, URL, CPF- and phone-shaped numbers) are replaced first. The message is split into clauses at punctuation and Portuguese connectors (never at the verb "é"). Each clause is classified with a reviewed **pack** (`health_pt_br.v1`): sensitive (health, intimate, distress, treatment history, being a patient), administrative, or benign; an administrative phrase that names a sensitive word without being about the sender ("a diferença entre psicólogo e psiquiatra") is never split, and the rest of its clause must still be clean. **Only recognised clauses are kept.** A sensitive clause AND an unrecognised one are replaced by one marker, `[trecho omitido]`, the same for every reason, so the omission itself says nothing about health.
- **Classes.**
  - `administrative`: nothing omitted.
  - `mixed`: something omitted, an administrative request kept; the screened text goes on.
  - `sensitive_only`: only sensitive content; nothing is sent; a fixed reply.
  - `safety`: danger to life or safety, matched on the whole message; nothing is sent; the fixed safety reply; the conversation goes to a person.
  - `unknown`: nothing recognised; nothing is sent; a fixed clarification.
- **Also detected deterministically:** a request for a person, and an opt-out. Both get their fixed reply and move the conversation to a person.
- **Recorded:** `ops.inbound_screenings`, one per run: class, counts, versions (screen, pack, and the four configuration versions), party kind, disposition, and the screened text. **Never the omitted text.** The raw message stays only where it already lived: `ops.tasks.description`, under the D6/D7 retention.
- **Jev receives the same screened text.** `ops.structured_decision_input` builds the business route from the latest screening's text, and is not eligible without one; it reads the raw description only for an agent without a front-desk policy, whose data Q8 limits to synthetic and test.
- **The limits, measured, not hidden.** The screen is lexical, not semantic, and not anonymisation (names stay). A sensitive phrase fused into an administrative clause without a recognised term passes; the corpus test documents one such case by name. Over-omission is bounded on a 30-message synthetic corpus: no omitted clause leaked, and every administrative request was kept. Q8 remains the authority over which class of data reaches which provider.

### C. A pack is reviewed code, selected by the tenant

The pack decides what never reaches a model. It lives in reviewed code with a synthetic corpus test and mutation checks; a tenant selects it by id in its operating policy and never edits it. A changed list is a new pack version, because every screening records the pack id it used.

### D. The four kinds of configuration are versioned system data

The owner's planning page (the Claude artifact "Recepção IA da Clínica") stays a planning and authoring aid. The database is the source of truth.

- `ops.agent_configuration_versions`, per agent and kind:
  - `operating_policy`: how the agent works.
  - `playbook`: stage objectives, required facts, transitions, forbidden behaviour, example phrasing; never canned sentences for ordinary conversation.
  - `knowledge`: the facts it may state, by domain.
  - `fixed_messages`: the exact texts where wording must not depend on a model.
- Each version is draft, published or superseded; only the published version is read. A version is immutable; a change is a new draft. Each version carries a content hash, who drafted and published it, and when.
- Each screening records the version ids it used, so "which version answered this conversation" is a join, not a copy.
- The database checks what the runtime relies on (`ops.agent_configuration_valid`): the send mode (never autonomous), the pack, the context length, the AI disclosure, the playbook stages' shape, and every fixed text present. `engine/frontDesk/configuration.ts` checks the full authoring shape first.
- Owner tool: `npm run front-desk -- config draft|publish|list|show`.
- **UI decision (option B for this milestone):** a settings screen in the CRM is the next step. It needs new browser acts under the OD-8a pinning, and no browser authority is added here.

### E. The prompt, and hallucination control

- **The context.** The prompt (`lead_triage` capability, prompt version `lead_triage.v3`, the unchanged output contract) is built only from the context `ops.record_inbound_screening` answers:
  - the screened text;
  - the earlier turns, at most 12 and as the policy sets: a contact's screened text, the replies the agent or a fixed text sent, and a marker for anything else, a person's reply included;
  - the published configuration;
  - the conversation's party kind and phase;
  - availability, only from the booking foundation (`ops.available_slots`) for the resource the policy names;
  - the next booked slot.

  Never the task's description.
- **Facts only from that context.** The model is told to state facts only from what it was given, to say plainly when it does not have one and offer a person, never to ask about an omission, never to confirm a booking or a payment, and never to claim to be a person or a professional.
- **The grounding check** (`engine/frontDesk/grounding.ts`) does not trust the model. Every price, time, date, link, e-mail address and long number in the reply must appear in what the run was given. An ungrounded reply is marked for a person (`needs_human_review`, flag `unclear`) before it is stored. Prose is the review's job.

### F. Generate is not send; three stages, the third not built

- Every reply, model-written, fixed or a person's, is a review item in the lead triage contract.
- A send is the separate `npm run messaging -- send` act after an accepted review (SI-50, unchanged).
- The operating policy's send mode is `staging` or `supervised`. **`autonomous` is not representable:** the table's check refuses it, and so does the authoring schema. Building it, for a low-risk scope only, is a later owner decision with its own ADR.

### G. A person can take over

- `ops.conversation_states.holder` is `agent` or `person`. Every change is recorded once in `ops.conversation_transitions` (append-only; it leaves only with its conversation).
- **Who moves a conversation to a person:** a request for a person, danger, or an opt-out, automatically. An operator can also take one over or release it (`npm run front-desk -- takeover|release`).
- **While a person holds it:** a new message is admitted and screened, but its run is cancelled with no model call and no review (`front_desk_held_for_person`).
- **A person's reply:** recorded with `npm run front-desk -- reply`, which opens an accepted review on the latest message waiting for one. `messaging send` then carries it, with every check. There is one reply per waiting message.
- **No browser authority** is added: the Company OS browser acts are unchanged.

### H. Memory without a second transcript store

The bounded context is read at run time from rows that already exist and already expire:
- screenings, whose text is redacted with its task's content by trigger;
- review items;
- outbound messages.

Nothing new keeps a body. A conversation's state holds no text.

### I. Jev stays shadow-first

- Jev's business route reads the screened text; lead intelligence reads only the triage enums and counts (unchanged).
- It is asked after settlement, and only about synthetic or test data; its answers act on nothing.
- **Promotion to deciding the route** is a later owner decision. It is measured on:
  - the correct intent, department and escalation;
  - the downstream outcome (`ops.decision_outcomes`, `human_override` included);
  - cost and latency.

  It is never measured on raw agreement alone.

### J. The minimum state, no duplicate truth

- A conversation's phase is `new`, `engaged` (a reply was sent) or `closed`.
- The commercial funnel stays in the CRM's deals (Phase 3B), and scheduling stays in the booking foundation (Phase 3A); the context reads the next booked slot from there.
- Payment status is never the model's to state: no payment provider is connected, and the playbook tells the agent a person confirms payment.

### K. What this does not open

- **Real data.** Q8 is unchanged: a real sender's message is `health`, OpenRouter can never be authorized for `health` or `person_text` (SI-78), and the run is refused before any model. Whether the screened text of a real message may become a separately authorizable class is a later owner decision.
- **The production WhatsApp gate.** Unchanged and CLOSED.
- **Out of this milestone, and recorded:**
  - autonomous sending;
  - creating a CRM lead for a new number. ADR 0021 W6 still holds: a reply goes only to a CRM contact, so receiving new leads needs either that act or a revised W6;
  - a payment provider;
  - Google Calendar;
  - follow-up text written by the model, and WhatsApp templates outside the 24-hour window;
  - the CRM settings screen;
  - ~~showing the reply draft in the browser. SI-52 keeps it out today, so a browser acceptance does not show what will be sent. Supervised production needs the reviewer to see the draft, and that is an owner decision to amend SI-52.~~ *(Decided by the owner on 2026-10-05: §L.)*

### L. The review shows what it accepts; a stale reply is never sent (owner decision, 2026-10-05)

The first supervised send on staging (record below) showed two gaps. The owner chose to close both before the next test (migration `20261012120000_front_desk_review_context.sql`).

- **The review shows the message and the reply.** `get_review` gains `conversation`, for a browser-decidable review of synthetic or test data only (any other review reads `unavailable`):
  - the front desk's screening of the message: its class, its disposition, the fixed text's key, and the **screened text**, which is exactly what a model and Jev read. Never the task's description: the raw message stays in the raw store;
  - the reply draft the send act would carry, until the task's content is redacted;
  - whether the contact wrote again since.

  The review page shows it above the decision, read only ("Mensagem e resposta"). Accepting still sends nothing. This amends SI-52 and SI-56: a reviewer must see what they accept.
- **A stale reply is never sent.** A reply answers the message it was drafted for. `ops.cos_review_superseded` is true when the contact wrote again in the same conversation (by the provider's timestamp, the admission instant breaking a tie). Then:
  - the send request refuses the review (`newer_message`) and records nothing;
  - the last gate before the provider call reads the conversation again and blocks the send on the record, so a message that arrives between the request and the call still stops it;
  - the review page warns with the same predicate.

  SI-81 is added.
- **What this does not change.** Q8, the screen, the send preconditions (SI-49) and at most one call (SI-50) are unchanged. No browser act is added: `get_review` already reached the read through its gate, so this is not an OD-8a migration.

## Integration and staging record (2026-10-04 and 2026-10-05)

- **Integrated.** PR #28, normal merge `26c14347` into `feature/clinical-phase-1` (parents `a2979573` and `428e6451`, tree equal to the reviewed head). `main` is unchanged at `a863e2a0`. Post-merge CI at the historical baseline: core jobs PASS, e2e exactly 9 failed and 1 skipped (the same ids), Prettier exactly the two baseline files.
- **Staging.** Migration 71 applied with the pinned CLI (dry run first, no seed). The staging front-desk agent's four configuration kinds are published as version 1, all synthetic (a fictional clinic, a synthetic price).
- **Staging pass (2026-10-04).** Signed inbound messages from the channel's registered test sender went through the local gateway and the real worker on OpenRouter:
  - an administrative question reached the model whole, and the draft stated only the knowledge's price and format;
  - a mixed message reached the model and Jev as the omission marker plus the scheduling request;
  - the sensitive word was found in `ops.tasks` (the raw store) and in no other table.
- **First supervised send (2026-10-05).** The owner accepted the administrative review in the browser at AAL2, wrote from the test device to the channel's number to open the provider's service window, and `messaging send` carried the reply once: status `sent`, the provider accepted, nothing resent, no privacy notice (none is recorded on staging). The number's status callbacks go to another app's webhook, which is not touched, so the row stays `sent`; the owner confirmed receipt on the device.
- **What the owner found.** The reply was out of context. It answered the simulated question, not the owner's own message, which never reached this system, because the number's inbound webhooks go to the other app. And the browser showed neither the message nor the draft (§K), so the acceptance was blind. §L answers both.

## Consequences

- SI-80 is added. The pipeline is proven end to end against a real database with the gateway's own login (`engine/domain/frontDeskPipeline.dbtest.ts`). There, a mixed message's sensitive clause is absent from:
  - the provider request;
  - the Jev request;
  - every table but the raw store.
- The owner's next inputs:
  - the knowledge, playbook and fixed texts (drafted from the planning page);
  - the privacy notice (ADR 0021);
  - the decisions listed in §K.
