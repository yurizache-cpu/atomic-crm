# ADR 0021 — Opening WhatsApp to real patients: the decisions the gate needs

**Status:** Accepted in part (2026-10-04). **W1 decided by the owner; W2 to W6 decided by owner delegation** ("apply the LGPD minimum that comparable systems apply, with a disclaimer"); W7 and W8 pending. See "Decisions recorded" below. **Nothing is opened by this record**: the production gate stays closed. There is no external counsel: the owner decides (owner, 2026-10-04). The repository records decisions and references, never legal analysis. **Date:** 2026-10-02.

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

## Context

[ADR 0018](0018-whatsapp-transport-and-human-send.md) owner amendment 1 (2026-09-21) says the production WhatsApp gate opens only through a NEW, owner-approved, Accepted ADR. A migration alone cannot open it. That ADR must settle four things:

- BASELINE Q8;
- the lawful basis for replying;
- how real WhatsApp consent and opt-in are represented;
- the retention and erasure of message bodies and phone identifiers.

This record is that ADR's proposal. It lays out the decisions and their exact technical shape, so that once the owner and counsel decide, the implementation is one batch with no further design.

**What already exists:**

- **The gate is closed.** `communication_channels_q8_real_data_gate` admits no active production channel (SI-47). Only an explicit test channel admits traffic.
- **The model boundary.** Free text a person writes is presumed `health` (ADR 0020 D3). A test channel is not test data (D8): only a registered test sender's message is `test`. A `health` task reaches no model without an owner-recorded authorization that carries every reference ADR 0020 §C and D4, D5 and D9 require. None exists.
- **AI working content is redacted.** The task description (the inbound body), the run results and the review copy of a `health` or `person_text` task are redacted in place 30 days after the flow's clock (ADR 0020 §I, SI-72).
- **What sending requires.** A person's explicit send act (`npm run messaging -- send`), checked twice:
  - inside Meta's 24-hour customer-service window;
  - exactly one CRM contact;
  - an opt-out flag that is false.

  Nothing resends (SI-49, SI-50). The opt-out flag is NOT consent (ADR 0018).
- **What is NOT covered today:** the sender's phone identifier (`contact_ref`) in `ops.inbound_messages`, `ops.conversations`, `ops.outbound_messages` and `ops.communication_test_senders` has no retention clock and no erasure act. Neither does any record of consent or opt-in.

## Decisions required

Each decision lists its options, the technical shape each one becomes, and a recommendation where a technical default is safe. The recommendation is never a legal conclusion.

### W1. BASELINE Q8 for real WhatsApp messages

May a real patient's message reach a model at all?

- **(a) No.** Real messages are triaged by a person only. The model sees synthetic and registered-test traffic only. Technically this is today's behaviour: a real message is `health`, with no authorization, so its run is `cancelled / data_not_authorized` and the message waits for a person.
- **(b) Yes, for lead triage only, under an ADR 0020 `health` authorization.** This needs every ADR 0020 §C fact for the exact provider, project and model, and the D4, D5 and D9 references:
  - the DPA;
  - training excluded;
  - zero data retention, or an owner-approved equivalent;
  - the transfer mechanism;
  - the lawful-basis reference.

**Recommendation:** go live with (a). Revisit (b) only after the provider evidence is recorded and counsel signs off. (a) loses no safety and needs no new code.

**Owner decision (2026-10-04): no health information is ever fed to AI through OpenRouter.** ~~Real patient messages are triaged by people: option (a).~~ *(Owner correction, 2026-10-04: that clause was a wrong reading of the owner's words. An AI receptionist answers leads, and a message is screened locally so that health content never reaches a model; see [ADR 0023](0023-front-desk-agent.md).)* Nothing changes in the code, which already holds it:
- a message from any number that is not a registered test sender is `health` (ADR 0020 D3, D8);
- `ops.model_data_authorizations` refuses gateway `openrouter` for `person_text` and `health` (ADR 0022 §D, SI-78);
- without an authorization, the run is `cancelled / data_not_authorized` before any call, and the message waits for a person.

A route to any other model provider for protected data would need a new owner decision and a new ADR.

### W2. The lawful basis for processing and replying

For a person who writes first about care, counsel decides the LGPD basis:

- for the reply itself;
- for keeping the message and the number;
- if W1(b), for model processing of what is presumed health data.

The system represents the answer as an opaque `lawful_basis_ref` (a document reference and its version), required wherever person content is processed under an authorization (ADR 0020 D4). ~~Owner and counsel decide; nothing is recommended here.~~ **The owner decides (there is no external counsel, owner 2026-10-04); nothing is recommended here.** With W1 decided as (a), model processing of real messages is out of scope.

### W3. How consent and opt-in are represented

Today the only consent-related field is the CRM's opt-out flag, `lead_profiles.do_not_contact`.

- **(a) A per-contact, per-channel consent record.** It carries the purpose, the text shown and its version, when, how (the message or the form), the evidence reference, and the revocation. It is append-only, and a revocation is a new row. `ops.whatsapp_send_eligibility` would require an active record for the purpose of the send, in addition to the opt-out flag being false. Only a person or a verified form creates it, never the model.
- **(b) No consent record.** Rely on the lawful basis W2 settles. The opt-out flag stays the only gate.

**Recommendation:** (a) if counsel's basis is consent for any part of the flow. It is the only shape that makes "who agreed to what, when" answerable. Meta's own opt-in policy for business-initiated messages applies separately: replies inside the 24-hour window are the only sends this system makes today.

### W4. Retention and erasure of message bodies

The inbound body is the task's description, and the D6/D7 lifecycle already redacts it 30 days after the flow's clock. The outbound body is not stored (SI-52).

- **(a) Keep the D6/D7 lifecycle as is:** at most 30 days after the flow's anchor, owner erasure on request (`npm run ops -- retention erase`).
- **(b) A shorter period** for WhatsApp bodies, any number of days from 1 to 30.

**Recommendation:** (a), unless counsel requires shorter. No new code either way: the period is data.

### W5. Retention and erasure of phone identifiers

`contact_ref` (the E.164 number) has no clock today.

- **(a) Keep while the CRM contact is active, plus N months**, then pseudonymise in place: replace the number with a keyed hash, which keeps matching for a returning sender without keeping the number.
- **(b) Erase on request**, through a new owner act per contact, recorded like `retention erase`.
- **(c) Both.**

**Recommendation:** (c). It needs one migration (a ledger and the job on the existing queue, the D6/D7 pattern) and one owner act. N is the owner's and counsel's.

### W6. May the clinic reply to an unknown number?

Today a send requires exactly one CRM contact.

- **(a) No.** A person first creates or links the CRM contact, which is the step that records W3.
- **(b) Yes**, inside the 24-hour window.

**Recommendation:** (a). It keeps the human step where consent is recorded, and it is today's behaviour.

### W7. A production webhook endpoint (always on, public HTTPS)

The local gateway with a temporary tunnel serves the Meta test probe only.

- **(a) Fly.io `gru`**, the existing `fly.toml`, about US$6 to 11 a month: **OWNER COST APPROVAL REQUIRED — REMOTE RUNTIME**.
- **(b) A serverless function on the existing Netlify account:** no new vendor. It needs a new deploy path, its own review and the gateway's secrets in the host's environment.

**Recommendation:** decide after the probe. (a) reuses reviewed assets; (b) costs nothing new but is new code.

### W8. Meta account actions for production

These are owner actions, not code:

- business verification;
- the display name;
- a production phone number;
- a permanent system-user token, scoped to the one WhatsApp account, in a secret store and never in the repository.

## What this record does NOT do

- It opens nothing.
- It records no authorization, consent or basis.
- It changes no provider configuration.
- It approves no production channel.
- It replaces no counsel's analysis.

The ADR 0018 amendment 2 Meta live probe remains mandatory before any production enablement, and it is run on a test number with synthetic content only.

## Decisions recorded (2026-10-04)

W1 is the owner's own. W2 to W6 were delegated: the owner asked for the minimum that systems of this kind apply, with a disclaimer, and these are the common market practice for a health service answering on WhatsApp. They record a practice, not a legal opinion.

| Item | Decision | How the system holds it |
| --- | --- | --- |
| W1 | No health information is ever fed to AI through OpenRouter. ~~People triage real messages.~~ (Owner correction: an AI receptionist answers leads behind a local screen, [ADR 0023](0023-front-desk-agent.md).) | Unchanged Q8 (SI-78); the screen is SI-80. |
| W2 | Replying and keeping the contact: procedures preliminary to a contract at the person's request (LGPD art. 7 V). Health content a person shares: health protection by a health service (art. 11 II f). Legal or regulatory duties: art. 7 II and art. 11 II a. Consent only for marketing, which the system does not send. | The basis is an opaque `lawful_basis_ref` on the tenant's privacy notice (owner data). |
| W3 | (b): no consent record now, because no part of the flow rests on consent. A marketing send would need (a) first. | The opt-out flag stays the gate (SI-49). |
| W4 | (a): the D6/D7 lifecycle, at most 30 days. | Unchanged code (SI-72). |
| W5 | (c), with a tombstone instead of a keyed hash: the number is erased 12 months after the sender's last message, or at once on the owner's act; a returning sender opens a new conversation. | Migration `20261010120000_whatsapp_privacy_and_identifier_retention.sql`, `npm run ops -- identifiers` (SI-79). |
| Notice | The disclaimer the owner asked for: the first reply of a conversation carries the tenant's privacy notice (a short text with the link to the full notice), and every reply carries it until one carrying that version is delivered or read; the send records the version. A provider's redelivery of an old message never restores an erased number. | Same migration; `npm run messaging -- notice record` (SI-79). |
| W6 | (a): no reply to a number outside the CRM. | Unchanged code (SI-49). |
| W7 | Recommended: a function on the existing Netlify account (no new recurring cost); not built. | Pending. |
| W8 | Owner actions in Meta's console. | Pending. |

**What still stands between this record and a production channel:**
- ~~**A reply a person writes.** With W1, a real message produces no AI draft, and today the send path only sends an accepted review's draft. Production needs a way for a person to write the reply; it is built with W7.~~ *(Superseded by ADR 0023: the AI receptionist drafts, a person reviews, and a person's own reply exists for a conversation the person holds.)*
- **W7** (the always-on webhook endpoint) and **W8** (business verification, display name, the production number, a permanent token in a secret store).
- **The notice itself:** the owner publishes the full notice and records its URL, its short text and the basis reference.
- **Then** a reviewed migration may open the production gate for exactly the channel the owner names, requiring a current privacy notice for its tenant (SI-47 amended).

## After the decisions

*(2026-10-04: the batch below was built as recorded above: W3 is (b), so no consent ledger; W5 and the notice by migration `20261010120000`.)*

There is one batch, behind its own review, and the owner's Accepted status on this record precedes it:

- W3(a): the consent ledger and its eligibility check;
- W5: the identifier clock and the erasure act;
- W6: unchanged, if (a).

Then a reviewed migration may open the production gate for exactly the channel the owner names (SI-47 amended). ~~If W1 stays (a), real messages are triaged by people only.~~ *(Superseded by ADR 0023.)*
