# Reception operations specification (Layer 1 — Operations)

**What this is:** the canonical specification of Layer 1: the **Reception Operations Engine** and its AI employee, the **Receptionist**. It describes the whole intended journey, what exists today, and what each missing piece must respect. Stable product semantics live here; implementation status per milestone lives in [CURRENT_STATE.md](CURRENT_STATE.md) and [ROADMAP.md](ROADMAP.md).

**Governing records:**
- [ADR 0024](adr/0024-three-layer-company-os-and-outcome-engine.md): the three layers and event-first collaboration;
- [ADR 0023](adr/0023-front-desk-agent.md): the front-desk agent, the screen, configuration, takeover and the clinical boundary;
- [ADR 0018](adr/0018-whatsapp-transport-and-human-send.md) and [ADR 0021](adr/0021-whatsapp-production-real-data-gate.md): WhatsApp;
- [ADR 0020](adr/0020-real-data-model-authorization.md): Q8;
- [ADR 0022](adr/0022-openrouter-gateway-and-jev-intelligence.md): OpenRouter and Jev.

Where this file and an Accepted ADR differ, the ADR wins.

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

---

## 1. Purpose and boundary

Reception runs the clinic's **administrative and commercial** journey for a person, from first contact to renewal:
- answering questions;
- triage;
- scheduling;
- payment requests;
- confirmations and reminders;
- rescheduling and cancellation;
- package administration;
- follow-up.

**Clinical boundary (ADR 0023, unchanged):**
- Reception never provides care. It never diagnoses, interprets symptoms or feelings, recommends treatment or gives psychological or medical advice.
- The psychologist conducts the first appointment and every session.
- Once a person becomes a patient, treatment conversation happens directly with the psychologist, outside this system. Administrative matters (scheduling, rescheduling, cancellation, payment administration, invoices, logistics) may stay with Reception.
- Health information never reaches a model through OpenRouter (ADR 0021 W1, SI-78); the front-desk screen removes it before any model (ADR 0023 §B, SI-80).

Engine names stay generic (ADR 0023 §A): the parties are **prospect** and **client**, the agent is a **front desk**. Lead, patient and recepção are tenant words.

## 2. The Reception Operations Engine and its channels

The business capability is the **Reception Operations Engine**: a set of deterministic workflows and state, with an AI employee that converses within them. Channels are adapters:

| Channel | Role | Today |
| --- | --- | --- |
| WhatsApp (Meta Cloud API) | Inbound messages and outbound replies, through the signed gateway | Exists for test channels; production gate CLOSED |
| Website / landing-page form | Lead entry with attribution and pre-filled triage | Planned |
| Booking page | Self-service slot choice against real availability | Planned |
| Future channels | Same engine, new adapters | Not planned yet |

Business logic never lives in a channel adapter. A channel delivers an inbound fact (admitted, refused or unrouted, SI-53) and carries an outbound act. Decisions are made by the engine.

## 3. What exists today

Mapped from the repository; the authoritative detail is in each ADR and report.

| Capability | Status | Where |
| --- | --- | --- |
| Signed WhatsApp gateway, channels, conversations, test-sender registration | ✅ Exists | ADR 0018, ADR 0021; `engine/communication/whatsapp/` |
| Exactly-once admission of an inbound message as a task | ✅ Exists | SI-43, SI-44; `ops.admit_inbound_core` |
| Local screen before any model; reviewed packs | ✅ Exists (pack v4: how leads ask for a person, with configured names) | ADR 0023 §B, §C; `engine/frontDesk/messageSanitizer.ts` |
| Versioned configuration: operating policy, playbook, knowledge, fixed messages | ✅ Exists | ADR 0023 §D; `npm run front-desk -- config …` |
| Conversation state: party kind, phase, holder; append-only transitions | ✅ Exists | ADR 0023 §G, §J |
| Human takeover, release and a person's reply | ✅ Exists (owner CLI) | ADR 0023 §G |
| Bounded context: screened turns, configuration, availability, next booking | ✅ Exists | ADR 0023 §E, §H |
| Reply drafting under the lead triage contract, grounding check | ✅ Exists (prompt `lead_triage.v4`) | ADR 0023 §E; `engine/frontDesk/prompt.ts`, `grounding.ts` |
| Review queue; supervised send as a separate act; at most once | ✅ Exists | ADR 0018 §4, SI-49, SI-50 |
| The review shows the screened message and the draft; a stale reply is never sent | ✅ Exists (PR #29) | ADR 0023 §L, SI-81 |
| Privacy notice on the first reply; identifier retention clock | ✅ Exists | ADR 0021 W4/W5, SI-79 |
| Follow-up engine (cadences, plans, due jobs; a due follow-up is operator work) | ✅ Exists | Phase 3A, SI-62 |
| Booking foundation (resources, types, weekly rules, bookings, no overlap, reschedule, cancel) | ✅ Exists | Phase 3A, SI-63 |
| Calendar sync lifecycle (provider-neutral port, fake provider) | 🟡 Partial: Google Calendar not connected | Phase 3A, SI-64 |
| Agenda, funnel, health and review screens (read-only plus narrow acts) | ✅ Exists | ADR 0019; `src/company-os/` |
| Commercial funnel on CRM deals; four narrow commercial acts; stage-transition ledger | ✅ Exists | Phase 3B, SI-66 to SI-69 |
| CRM contact policy for WhatsApp (read-only lookup by phone) | ✅ Exists | SI-48 |
| Acquisition attribution table (UTM, gclid, campaign, landing page) | 🟡 Table exists; nothing captures into it at entry | CRM `acquisition_attributions` |
| Jev shadow decisions on the review (business route, lead intelligence, model route) | ✅ Exists, shadow only | ADR 0022 §E, §F |
| Exception queue: danger, a request for a person, an opt-out, a missing fixed text, a message waiting with a person, a contact no reply can reach, a failed or uncertain send; a message no reply can reach gets no model | 🟡 Built on `feature/lead-journey-core`, Proposed for the owner's review | ADR 0025 Part A, SI-82; `npm run front-desk -- exceptions` |
| Creating a CRM lead for a new WhatsApp number | 🚫 Blocked by ADR 0021 W6 (replies only to CRM contacts) | Needs an owner decision (ADR 0025 B1) |
| Structured triage questionnaire, booking page, holds, payments, packages, session ledger, reminders, renewal, waitlist, exception inbox screen | ⬜ Planned | §7 to §19; ADR 0025 Part B |
| Autonomous sending | ⬜ Planned; not representable today (ADR 0023 §F) | A later owner decision and ADR |

## 4. The journey

```
lead entry (ad / landing page / website / WhatsApp)
  -> identity resolved (one person) + attribution captured
  -> triage: pre-filled (form) or conversational (5-6 short questions)
  -> questions answered from published knowledge
  -> slots offered from the scheduling tool, or the booking page
  -> booking created  [first_appointment_booked]
  -> awaiting_first_appointment_payment: payment requested
  -> payment confirmed by settlement or authorized manual confirmation  [first_appointment_paid]
  -> owner notified
  -> appointment confirmation (T-24h) / reminders / link at session time
  -> first appointment: attended | no-show | cancelled  [first_appointment_attended]
  -> package decision pending (the psychologist decides clinically; Reception follows up administratively)
  -> package purchased  [package_purchased]
  -> sessions: scheduled -> completed (package ledger consumed) | cancelled | no-show
  -> renewal due  [package_renewal_due] -> renewed  [package_renewed]
  -> follow-ups, next best action, exceptions throughout
```

Every arrow is a deterministic state change with a typed event ([DOMAIN_EVENT_CATALOG.md](DOMAIN_EVENT_CATALOG.md)). The model writes language inside this journey. It never moves the journey by itself.

## 5. Lead entry and identity resolution

**On entry, create or resolve exactly one canonical person.** The same person must not become separate records for a form, WhatsApp, a booking and a payment.

**Identity Resolution** is a deterministic engine capability:
- **Evidence:** normalised phone (E.164 digits), normalised email, the form submission id, the booking's contact fields, the payment's payer reference and the click identifier captured at entry.
- **Rules:** exact match on a strong identifier (phone or email) resolves automatically. Anything weaker or conflicting raises a merge candidate.
- **Merge controls:** a merge is an explicit, recorded act by a person (the CRM's `merge_contacts` path, which already keeps consent as an OR, never winner-wins). A merge is never silent and never decided by an LLM.
- **Ambiguity is an exception:** two contacts match, or a payment cannot be tied to one person. It goes to the exception queue, never to a guess. The WhatsApp contact policy already answers `ambiguous` and refuses to reply in that case (SI-48).

**Known constraint:** ADR 0021 W6 says a reply goes only to an existing CRM contact. Receiving new leads on WhatsApp therefore needs either a lead-creation act for a new number or a revised W6. That is an owner decision, recorded as a dependency of workstream A.

## 6. Attribution at entry

When available, preserve on the resolved person:
- channel and source;
- campaign, ad group and ad identifiers;
- landing page;
- UTM parameters;
- the Google click identifiers supported when this is implemented (gclid today; others only after verifying current official Google documentation);
- form and source metadata.

**Where:** the CRM's `acquisition_attributions` already has these columns (source, medium, campaign and its id, ad group and its id, ad and its id, keyword, match type, landing page, the five UTM fields, gclid). Capture at entry is planned. First touch is kept; later touches are added, never overwritten.

**Never:** clinical or health information in attribution. Attribution is commercial metadata only ([GROWTH_INTELLIGENCE_SPEC.md](GROWTH_INTELLIGENCE_SPEC.md) §4, §11).

## 7. Triage

Two paths, one structured result:
- **Path A, pre-filled.** The lead comes from a form that already collected the required fields. Reception must not ask them again.
- **Path B, conversational.** When fields are missing, the Receptionist asks the configured short triage, about 5 to 6 concise questions, one at a time.

Rules:
- **Triage fields are structured CRM data**, stored as fields, not only as chat messages. The question set is versioned configuration (a new kind or a playbook stage; decided in the implementation milestone).
- **Each field has a data class.** A field that carries health content (for example the intake form's "what brings you" sentence, its duration and its intensity rating) is `health`. It stays in the clinic's system and never reaches a model, Jev or an ad platform. Pack `health_pt_br.v2` removes the intake form's demand sentence before any model.
- **Collect only what the administrative journey needs.** No unnecessary sensitive information.
- `triage_completed` is a deterministic event once the required fields are present, not a model's opinion.

Note on names: the existing capability `lead_triage` is the AI reading one message and drafting a reply. It is not this questionnaire. Implementation must keep the two distinct.

## 8. The reception conversation

The Receptionist answers within administrative and commercial scope, using only:
- the screened message context (never the raw message);
- the published knowledge (the only facts it may state);
- the conversation playbook (stages, objectives, forbidden behaviour, tone examples);
- deterministic system state (party kind, phase, next booking, availability, payment state when it exists);
- authorized tools (none yet; every future tool is a recorded capability, never arbitrary SQL, ADR 0011).

Rules:
- Every reply is a review item. A send is a separate act after acceptance (ADR 0023 §F).
- A reply stating a price, time, date, link or number it was not given is marked for a person (the grounding check).
- Small talk and questions about the assistant are answered simply. Asking for a person, danger and opt-out are handled deterministically with fixed messages and a person (ADR 0023 §B, §G).
- The voice is configuration (persona name, locale, tone examples), never engine text (prompt `lead_triage.v4`).

The persona's naturalness is tested on real model candidates with synthetic conversations ([CURRENT_STATE.md](CURRENT_STATE.md) records the latest choice).

## 9. Scheduling

**The AI never invents availability.** Slots come from the scheduling tool: `ops.available_slots` over weekly availability rules, booking types and existing bookings.

Target interaction: "I have Tuesday at 18:30 and Thursday at 19:30. You can also see all available times here: [booking link]."

- **Booking page (planned).** A page where the lead:
  - sees an appropriate time window of real availability;
  - chooses a slot;
  - confirms identity (resolved with §5);
  - books.

  It is a channel adapter over the same scheduling domain, beautiful and mobile-first, with no logic of its own.
- **Slot hold (planned).** Two people must not confirm the same time. The database already refuses overlapping booked bookings (an exclusion constraint). A hold adds a short-lived reservation with an expiry, so a page or a conversation can offer a slot without double-booking it while the person finishes.
- **Booking event.** A successful booking emits `booking.created` (exists). For a person's first appointment, the Outcome Engine records `first_appointment_booked`. Reception learns it from the event and never asks "did you manage to book?".
- **Rescheduling and cancellation** are atomic and idempotent today (Phase 3A). A refused new time leaves the original booked.
- **Calendar and meeting link.** The calendar event and the meeting link are created or resolved early in the scheduling lifecycle (at confirmation, not at T-5min). The authoritative event id and link reference are stored, and the link is only **sent** close to the appointment by policy. Late creation would turn a provider outage into a missed session. Google Calendar and Meet are not connected (no approved authentication, token storage or data-processing contract). The provider-neutral port and its at-most-once sync lifecycle exist.

## 10. Payment

After booking, the person's state is conceptually `awaiting_first_appointment_payment`.

- **Request.** Reception sends the payment instructions the owner approved: Pix instructions, a payment link, or other owner-approved guidance. The request is a state change and an event (`payment_requested`), not just a sentence in a message.
- **Authority.** Payment is confirmed only by:
  - a payment provider's settlement webhook, verified and idempotent; or
  - an explicit, authorized manual confirmation by a person, recorded with who and when.

  **The LLM never confirms payment.**
- **Payment proof.** A person may send a receipt when the workflow asks for one. Extraction from the image may assist (amount, date, payee), where Q8 and the owner's rules allow; images are health-adjacent content and the owner's rule bars sending them to AI through OpenRouter. **A receipt image is never authoritative settlement.** At most it raises a "please confirm" task for a person, or matches a provider settlement.
- **Confirmed.** On authoritative confirmation, `payment_confirmed` is recorded, and for the first appointment the Outcome Engine records `first_appointment_paid`. Then:
  - the booking becomes confirmed;
  - the CRM funnel advances (a commercial act, Phase 3B);
  - revenue is recorded on the payment ledger;
  - the owner may be notified;
  - Growth and Analytics consume the outcome.
- **Failure and refund** are their own events (`payment_failed`, `payment_refunded`) and reverse the commercial facts deterministically.

No payment provider is chosen or connected. Choosing one is an owner decision with its own milestone.

## 11. Owner notification

Reception can notify the owner of operational events:

```
New paid first appointment
Lead: <display name or reference>
Date: <appointment time>
Source: Google Ads
Triage: complete
Payment: confirmed
```

- Built from structured state, never from conversation text.
- No unnecessary sensitive content: no triage health fields, no message content.
- Which events notify, and through which channel, is owner configuration. Notifications are a Layer 3 surface ([MANAGEMENT_OS_SPEC.md](MANAGEMENT_OS_SPEC.md)).

## 12. First appointment lifecycle and no-show

After the appointment time, a deterministic outcome is recorded:
- attended;
- no-show;
- cancelled (with who cancelled and when, against the cancellation rule);
- follow-up pending.

The authority is the psychologist's record or an authorized act, never inference from a sent link.

**No-show workflow (configurable, never improvised by the model):**
- mark the no-show;
- notify Reception;
- a recovery follow-up;
- a reschedule offer;
- the owner's payment policy for no-shows.

## 13. Package decision, packages and patient transition

- **Decision.** After the first appointment: `first_appointment_completed` → `package_decision_pending`. Any clinical recommendation belongs to the psychologist and the owner. Reception performs only the approved administrative and commercial follow-up.
- **Packages are domain objects**, never inferred from links sent:

  | Field | Meaning |
  | --- | --- |
  | `sessions_purchased` | Sessions bought |
  | `sessions_scheduled` | Booked, not yet held |
  | `sessions_completed` | Held: consumed by `session_completed` only |
  | `sessions_cancelled` | Cancelled under the rule |
  | `sessions_remaining` | Purchased minus consumed |
  | `purchase_value` | Confirmed value |
  | `status` | Active, completed, expired, refunded |

- **Purchase.** On payment confirmation: `package_purchased`, with the confirmed value (a deeper commercial outcome).
- **Patient transition.** Once treatment is contracted, the person is a client (the tenant says patient). Party kind already derives `client` deterministically from the CRM (ADR 0023 §A). Treatment conversation moves to the psychologist directly. Administrative matters may stay with Reception.

## 14. Appointment confirmation, reminders and the session lifecycle

All cadences are configuration. The owner's examples below are defaults to configure, never engine constants.

- **Confirmation (example T-24h):** a confirmation request with three actions: CONFIRM, RESCHEDULE, CANCEL. RESCHEDULE consults real availability (§9). Outside WhatsApp's 24-hour customer-service window, a message needs an approved template (Meta), which is part of the production Meta actions (ADR 0021 W8).
- **Reminders (example T-5h).**
- **Session link (example T-5min):** send the stored meeting link (§9). The link is sent late and created early.
- **Session completion:** package consumption happens only on an authoritative `session_completed`, never on "link sent".
- Sessions: `session_scheduled`, `session_completed`, `session_cancelled` (and no-show as in §12).

## 15. Renewal

When `sessions_remaining` reaches the configured threshold: `package_renewal_due`. Reception can:
- alert the owner;
- prepare the renewal message;
- send it according to the configured approval mode.

The initial policy requires owner approval. A low-risk renewal flow may later become autonomous, only by an owner decision.

## 16. Waitlist and cancellation backfill (later optimisation)

When a desirable time opens, eligible waiting leads may be offered the slot by policy, to improve utilisation. Not MVP-critical.

## 17. Follow-up engine

Follow-ups are **workflow jobs**, never something an LLM is asked to remember. The engine exists (Phase 3A):
- versioned cadences;
- one plan per subject;
- due occurrences as governed jobs (`follow_up.due`);
- a due follow-up is operator work, never a send.

A follow-up stores:
- its due time;
- its reason;
- the policy and version.

A send respects:
- `do_not_contact`;
- WhatsApp rules (the 24-hour window, templates);
- the send window;
- consent and policy;
- the owner's cadence.

The model writes the content only when appropriate, and the content passes the same review and send path.

## 18. Next best action

For each active lead or client, derive one `next_best_action` deterministically from state first:
- complete triage;
- answer a question;
- offer slots;
- wait for payment;
- payment follow-up;
- appointment reminder;
- package follow-up;
- renewal;
- human exception.

Jev may advise in shadow (`lead_intelligence` already asks for the next best administrative or commercial action, ADR 0022 §F) and is compared with the deterministic choice and the outcome. The CRM's existing "next action" (`deals.next_action_at`, Phase 3B.2) is the commercial date. The two are reconciled in the implementation milestone, without a second store.

## 19. Exception queue (Reception's side)

Only unresolved exceptions reach a person. Reception raises `exception_raised` for:
- an unknown question;
- a message the screen blocked or held;
- a payment inconsistency;
- a booking conflict;
- a failed or indeterminate send;
- a lead asking for a person;
- an ambiguous identity;
- a low-confidence Jev route (shadow);
- a provider outage.

Each exception has a type, a subject, a priority and a resolution. The inbox and its UX are Layer 3 ([MANAGEMENT_OS_SPEC.md](MANAGEMENT_OS_SPEC.md) §4).

**Built (ADR 0025 Part A, Proposed for the owner's review):**
- `ops.exceptions`, raised by the database where the fact is decided:
  - from the screening: danger, a request for a person, an opt-out, a missing fixed text, a message waiting with a person, and a contact no reply can reach (`contact_unresolved` with its reason, `do_not_contact`);
  - from a send's state, after its settlement: failed, uncertain.
- Deduplicated while open; resolved by a release, by evidence, or by a person's act; recorded as `exception.raised` and `exception.resolved`.
- An ambiguous identity is `contact_unresolved` with reason `ambiguous`.
- **Not yet:** the unknown question, payment inconsistencies, booking conflicts, a low-confidence Jev route, and a provider outage.

## 20. Send modes and channel rules

- **Send mode** (operating policy): `staging` or `supervised` today. `autonomous` is not representable (ADR 0023 §F). It becomes possible only for an owner-approved low-risk scope, with its own ADR (workstream I).
- **Every send:**
  - is preceded by an accepted review;
  - is checked afresh against the 24-hour window, a single CRM contact, opt-out, an active test channel and no stop (SI-49);
  - happens at most once (SI-50);
  - is never sent when the contact wrote again after the reviewed message (ADR 0023 §L, SI-81).
- **Production WhatsApp** stays CLOSED until ADR 0021's remaining decisions (W7 hosting, W8 Meta actions) and the owner's go-live.

## 21. Data and model constraints

- Q8 decides what may reach which model. A real sender's message is `health` and is refused before any model.
- The owner's rule: no health information to AI through OpenRouter.
- Events carry ids, states, enums, amounts and instants, never message text (SI-52).
- AI working content and identifiers expire on their recorded clocks (ADR 0020 §I, SI-72, SI-79).
- Commercial optimisation never uses health or suffering variables (ADR 0022 §F).

## 22. Reception KPIs

| KPI | Definition (all from events, per period) |
| --- | --- |
| New leads | `lead_created` |
| Speed to first response | First outbound reply instant minus the first inbound instant, median and p90 |
| Triage completion rate | `triage_completed` / leads that started triage |
| Booking rate | `first_appointment_booked` / leads |
| Booked → paid | `first_appointment_paid` / `first_appointment_booked` |
| Paid → attended | `first_appointment_attended` / `first_appointment_paid` |
| Attended → package | `package_purchased` / `first_appointment_attended` |
| Human takeover rate | Conversations a person took over / conversations |
| Follow-up recovery rate | Follow-ups followed by a reply or a booking / follow-ups due |
| No-show rate | `appointment_no_show` / appointments due |
| Response cost and model cost | Charged cost per reply and per agent (`ops.model_economics`) |
| Unresolved exceptions | Open exceptions, by age |

Never optimise commercial behaviour with health or suffering variables.

## 23. Implementation milestones (workstreams A to D)

The order and status are in [ROADMAP.md](ROADMAP.md) (long-term program map). In short:
- **A. Reception operations core:** finish the receptionist foundation (screen, knowledge, playbook, fixed messages, conversation state, takeover), the CRM lead journey, lead creation for new numbers (needs the W6 decision), structured triage, and the core events and outcomes.
- **B. Scheduling:** authoritative availability in the conversation, the booking page, holds, rescheduling and cancellation through the conversation, Calendar and Meet (needs the provider decision).
- **C. Payments and revenue:** the payment request, settlement (needs the provider decision), manual authorized confirmation, owner notification, package sales, payment events and the revenue ledger.
- **D. Session and package lifecycle:** the package ledger, session completion, confirmations and reminders (templates need W8), no-show, renewal and follow-up content.

## 24. Definition of done (Layer 1)

A synthetic or supervised journey reliably does the following, all reflected in the CRM, events and audit, without the owner copying state between systems:
- lead arrives, identity resolved, attribution stored;
- triage complete, questions handled;
- real slot selected, booking created;
- payment requested, payment confirmed;
- owner informed;
- first appointment lifecycle, package outcome;
- session lifecycle, reminders and rescheduling;
- renewal and follow-up.
