# Company OS master blueprint

**What this is:** the stable north star of the repository: what we are building, for whom, how the whole company is meant to operate, and the principles that do not change. It is deliberately free of branch names, SHAs and PR status; those live in [CURRENT_STATE.md](CURRENT_STATE.md).

**Authority:** owner decision of 2026-10-05, recorded as [ADR 0024](adr/0024-three-layer-company-os-and-outcome-engine.md). If an Accepted ADR conflicts with a sentence here, **the ADR wins**: reconcile this document rather than silently violating the ADR.

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.** Nothing in this document authorizes real data, a provider, a channel or a send. Completing the roadmap is not a go-live decision.

---

## 1. What we are building

An **AI Company Operating System**. The clinic runs as a company whose routine work is done by **digital employees** (AI agents with defined roles), coordinated by the Company OS and directed by the owner.

It is **not**:
- a CRM;
- a WhatsApp bot;
- a chatbot;
- a collection of automations.

The CRM (a fork of Atomic CRM) is one replaceable adapter for contacts and deals. WhatsApp is one channel. Models are execution resources. The Company OS is the operating layer that owns:
- the organisation: tenants, companies, departments and agents;
- the work: tasks and jobs;
- the facts: events, outcomes and decisions;
- the governance: permissions, Q8, spend, stops and audit.

## 2. Who it is for, and how the owner works

- **First tenant:** an online psychology clinic in Brazil, under LGPD. The architecture stays tenant-aware. A later tenant (for example a 3D-printing business) must be able to use the same engine with its own vocabulary, configuration and data isolation.
- **The owner** acts as **CEO, operator and team leader**. The long-term experience is that the owner directs the company and handles decisions and exceptions, rather than performing every repetitive operational task.
- **Clinic vocabulary is configuration.** Lead, patient, psychologist, session and the clinic's prices are tenant data and specification text, never engine constants (CLAUDE.md rule 2, ADR 0013). Engine concepts stay generic: prospect and client (ADR 0023 §A), appointment, package, outcome.

## 3. The three layers

| Layer | Purpose | Primary AI employee | Canonical specification |
| --- | --- | --- | --- |
| **1. Operations** | Run the daily administrative operation: the lead and customer journey from first contact through booking, payment, sessions, packages and renewal | **Receptionist** | [RECEPTION_OPERATIONS_SPEC.md](RECEPTION_OPERATIONS_SPEC.md) |
| **2. Growth** | Understand where revenue comes from and improve acquisition: attribution, analytics, conversion feedback to ad platforms, funnel economics | **Growth / Ads Manager** (future) | [GROWTH_INTELLIGENCE_SPEC.md](GROWTH_INTELLIGENCE_SPEC.md) |
| **3. Management** | Let the owner manage the AI company: Command Center, Daily Brief, exceptions, approvals, KPIs, agent performance, costs, decision support | **Management / Chief-of-Staff capability** (future) | [MANAGEMENT_OS_SPEC.md](MANAGEMENT_OS_SPEC.md) |

**Dependency rule:**
- **Layer 2 consumes trusted Layer 1 outcomes.** Sophisticated acquisition optimisation is never built on unreliable conversion events.
- **Layer 3 is built incrementally.** Its intelligence grows as Layers 1 and 2 produce reliable structured data.

### Layer 1 in one paragraph

The **Reception Operations Engine** runs the administrative journey on any channel. A lead arrives (ad, landing page, website, WhatsApp) and is resolved to one identity with its attribution. Triage is completed from a form or a short conversation, and questions are answered from published knowledge. Slots come from a deterministic scheduling tool or a booking page. The booking is created, payment is requested, and payment is confirmed only by an authoritative settlement. The owner is informed. The first appointment is recorded (attended, no-show, cancelled), and the package decision and package purchase follow. Sessions run on a session ledger, with confirmations, reminders, rescheduling and renewal. Follow-ups are jobs, not memories. Only exceptions reach a person. The Receptionist never provides care.

### Layer 2 in one paragraph

**Reception produces business outcomes; Growth consumes them.** The **Outcome Engine** links each lead's acquisition attribution to its confirmed outcomes:
- first appointment booked, paid and attended;
- package purchased;
- package renewed.

Each outcome carries its value, so the business can compute real funnel economics (cost per paid first appointment, CAC, ROAS) and later feed ad platforms only the minimum authorized commercial signal. Health data never goes to advertising.

### Layer 3 in one paragraph

One **Owner Command Center** aggregates the company: state, KPIs, costs, agent performance, approvals and an **exception inbox** ("3 things need your attention"). A **Daily Brief** is computed from structured state, never guessed. The owner can ask questions ("why did conversion fall this week?") and get answers built from evidence across Reception, Growth, scheduling and payments. Cross-department analysis happens in bounded **Decision Rooms** that recommend; the owner decides.

## 4. AI employees

An AI employee is an **agent with a contract**, not a model. The contract states:
- role, department and objective;
- capabilities and tools;
- read and write permissions;
- events consumed and produced;
- KPIs, budget and model pools;
- human escalation and approval requirements;
- data classes and retention constraints.

The canonical definition and the first contracts (Receptionist, Growth / Ads Manager, Analytics, Management / Chief of Staff) are in [AGENT_CONTRACTS.md](AGENT_CONTRACTS.md).

The model that executes a run is chosen per run from the agent's model pool, among the candidates Q8 authorizes (ADR 0022 §A, §D). Changing the model never changes the employee.

## 5. How employees collaborate

**Default: through structured facts, not conversation.**

```
employee
  -> typed EVENT / TASK / STATE CHANGE / DECISION   (recorded once, in ops)
  -> Company OS                                     (routing, governance, audit)
  -> the employees and surfaces that consume it
```

Example: Reception's payment confirmation produces `first_appointment_paid` once. The CRM funnel, Analytics, the Growth / Ads Manager and the owner's notification all consume that one event. Reception does not open a natural-language conversation with the Ads Manager.

- The event vocabulary is [DOMAIN_EVENT_CATALOG.md](DOMAIN_EVENT_CATALOG.md). It extends the existing `ops.events` model (ADR 0015 §7) and never creates a second store.
- Work that someone must do is a **task** (ADR 0015 §6), and execution is a job on the existing queue (ADR 0001, ADR 0016).
- Judgements are **structured decisions** in one ledger (`ops.structured_decisions`, ADR 0022 §E), shadow-first.
- **Decision Rooms** (bounded, owner-facing, recommendation-only) are the only place several capabilities contribute analyses to one question ([MANAGEMENT_OS_SPEC.md](MANAGEMENT_OS_SPEC.md) §7).

There are no autonomous agent councils, no voting swarms and no endless model-to-model conversations.

## 6. Source-of-truth matrix

| Domain fact | Authority | Today |
| --- | --- | --- |
| Lead / contact identity | CRM contact and its lead profile, resolved by deterministic identity rules | Exists (CRM `contacts`, `lead_profiles`); identity resolution across channels planned |
| Acquisition attribution | CRM `acquisition_attributions`, captured at entry | Table exists; capture at entry planned |
| Available slot | Scheduling domain (`ops.available_slots` over availability rules and bookings) | Exists (Phase 3A) |
| Booking | Scheduling domain (`ops.bookings`, overlap refused by an exclusion constraint) | Exists (Phase 3A); booking page planned |
| Calendar event and meeting link | The calendar provider's record, mirrored by the scheduling lifecycle | Provider-neutral port and a fake exist; Google Calendar not connected |
| Payment status | Payment provider settlement (webhook) or an explicit authorized manual confirmation | Planned; no provider connected |
| Session completion | Session lifecycle | Planned |
| Package balance | Package / session ledger | Planned |
| Opt-out (do not contact) | CRM lead profile `do_not_contact`, and recorded opt-out acts | Exists |
| Permission and send authority | Database policy: membership, capabilities, Q8, send eligibility, stops | Exists |
| WhatsApp delivery | Meta status callback | Exists (Phase 2B) |
| Model result | The agent run and its review item | Exists |
| Commercial stage | CRM deals and their stage-transition ledger | Exists (Phase 3B) |
| Ad spend and campaign data | The ads platform | Planned |
| Business conversion | Outcome Engine | Planned |
| Revenue | The confirmed payment ledger | Planned |

**An LLM, Jev or a Decision Room is never the authority for any row above.** They may read these facts (when Q8 allows) and recommend.

## 7. Non-negotiable principles

1. **An agent is not a model.** The Receptionist is an employee; Luna, Gemini, Claude and the others are execution resources. OpenRouter is the gateway, Jev supports decision and routing intelligence, and Q8 decides what is permitted (ADR 0022).
2. **Deterministic authority beats the LLM.** LLMs interpret, draft, classify, recommend and converse. They never decide the facts in §6 (CLAUDE.md rule 3).
3. **Event first.** Important business facts become typed events with minimal payloads. Downstream employees never parse chat history to discover what happened.
4. **Outcome first.** The business understands outcomes. A message is not success; success is a progressively deeper confirmed outcome: booked, paid, attended, package purchased, renewed.
5. **Human exception model.** Automation removes routine work. People handle exceptions, approvals, ambiguity, high-risk operations and strategy.
6. **Fail closed.** Every gate denies by default: security, data, model authorization, send eligibility (CLAUDE.md rule 4).
7. **Cost first.** No recurring paid infrastructure or expensive model until it provides measurable value ([COST_FIRST_STAGING.md](COST_FIRST_STAGING.md) §1).

And, unchanged from CLAUDE.md:
- the CRM is a replaceable adapter (rule 1);
- nothing in the engine is psychology-specific (rule 2);
- functionality first (rule 5).

## 8. Model and data governance

- **Q8 (ADR 0020)** is the model and data authority: a closed data classification assigned from provenance, and one fail-closed gate before any model call. No employee, conversation or Decision Room bypasses it.
- **The owner's rule (ADR 0021 W1):** no health information is fed to AI through OpenRouter. OpenRouter can never be authorized for `person_text` or `health` (SI-78).
- **The front-desk screen (ADR 0023 §B):** every inbound message of a front-desk agent is screened locally before any model or Jev. Only clauses a reviewed pack recognises as administrative or benign leave the process.
- **OpenRouter (ADR 0022):** provider-neutral inside, one exact model per call, no silent fallback, data collection denied, cost and provider recorded per call.
- **Jev (ADR 0022):** structured decisions (intent, routing, lead intelligence, model-route advice), shadow-first, promoted only on measured outcomes.
- **Clinical boundary (ADR 0023):** no employee provides care. A patient's treatment conversation is with the psychologist directly, outside the system.
- **Advertising boundary:** nothing health-related ever leaves for an ad platform ([GROWTH_INTELLIGENCE_SPEC.md](GROWTH_INTELLIGENCE_SPEC.md) §11).
- **Retention (ADR 0020 §I, ADR 0021 W4/W5):** AI working content and identifiers expire on the recorded clocks.

## 9. Reliability

Every workflow must have:
- **idempotency** on every external input and every external action (a redelivery is a lookup, never a second effect);
- **retries only where safe:** an ambiguous external call is `indeterminate` and is never retried by the system (ADR 0016, SI-50);
- **no double processing** of a payment, a booking or a conversion upload;
- **concurrency-safe booking:** overlap refused by the database, holds with expiry;
- **reconciliation jobs** for every external system of record (payment provider, calendar, ad platform);
- **stuck-work recovery:** lease expiry, stale-run settlement, recovery commands;
- **explicit terminal states:** no workflow ends in an implicit limbo;
- **an exception** for anything that cannot resolve itself ([MANAGEMENT_OS_SPEC.md](MANAGEMENT_OS_SPEC.md) §4).

## 10. Observability

Track operational health without putting sensitive content in logs, metrics or traces (SI-60, SI-61):
- workflow success, failure and indeterminate rates;
- queue depth and latency;
- model cost and latency per agent, capability, model and provider;
- send and delivery status;
- booking errors and conflicts;
- payment reconciliation results;
- conversion upload results.

## 11. What not to build

- One enormous receptionist prompt that holds the journey, the facts and the agenda.
- LLMs owning business truth (payments, availability, bookings, package balances, conversions).
- A WhatsApp message counted as a conversion.
- A sent meeting link counted as a completed session.
- A receipt image alone confirming a payment.
- Reception as the Google Ads integration.
- Health data, or anything derived from it, sent to an ads platform.
- An uncalibrated score presented as a probability ("87% likely to convert").
- Agent swarms, councils or endless agent-to-agent chat.
- Duplicate sources of truth (a second commercial store, a second transcript store, a second event bus).
- `agent = model` hard-coded anywhere.
- Real-patient traffic activated by accident: every production gate stays explicit.
- Recurring paid infrastructure added because it may be useful later.

## 12. Definition of done

- **Layer 1.** A synthetic or supervised journey reliably does the following, all reflected in the CRM, events and audit, without the owner copying state between systems:
  - lead arrives, identity resolved, attribution stored;
  - triage complete, questions handled;
  - real slot selected, booking created;
  - payment requested, payment confirmed;
  - owner informed;
  - first appointment lifecycle, package outcome;
  - session lifecycle, reminders and rescheduling;
  - renewal and follow-up.
- **Layer 2:**
  - every acquisition lead carries its attributable source when one exists;
  - downstream outcomes and confirmed revenue attach to the right lead and funnel;
  - ad platforms receive only authorized commercial feedback, uploaded idempotently and reconciled;
  - dashboards show real funnel economics;
  - Growth can tell cheap bad leads from expensive valuable ones.
- **Layer 3.** One Command Center shows company state, KPIs, exceptions, approvals, agent performance, costs and recommendations. The owner can query the business without aggregating tools by hand.

## 13. How this document is maintained

- This file changes only when the product or architecture changes, together with an ADR.
- Current status, branches, PRs and next actions live in [CURRENT_STATE.md](CURRENT_STATE.md).
- Sequencing and status per workstream live in [ROADMAP.md](ROADMAP.md) (the long-term program map).
- Detail lives in the three layer specifications, [DOMAIN_EVENT_CATALOG.md](DOMAIN_EVENT_CATALOG.md) and [AGENT_CONTRACTS.md](AGENT_CONTRACTS.md).
- Implementation evidence lives in the milestone reports. Decisions live in the ADRs and [DECISIONS.md](DECISIONS.md).
