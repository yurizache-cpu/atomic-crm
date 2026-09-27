# ADR 0020 — Real data at the model boundary (BASELINE Q8): a closed data classification, recorded provider evidence and one fail-closed gate

**Status:** Proposed — owner decision packet (2026-09-27). **Owner decisions D1–D10 given 2026-09-27 (§H) and implemented as the enforcement batch; the record awaits the owner's acceptance at the review checkpoint.** BASELINE Q8 stays OPEN for real data: no authorization is recorded, and real patient model traffic is still disabled.
**Implemented by:** `supabase/migrations/20261001120000_model_data_authorization.sql`, `npm run ops -- data-auth`, `engine/models/identifierRedaction.ts` and the minimised `lead_triage.v2` input (enforcement only; see [PHASE_Q8_ENFORCEMENT_REPORT.md](../PHASE_Q8_ENFORCEMENT_REPORT.md)). Content redaction and retention (D6, D7) are the next batch.
**Relates to:**
- [ADR 0016](0016-agent-runs-and-model-providers.md): agent runs and the provider boundary.
- [ADR 0017](0017-runtime-governance.md): owner-recorded versioned governance data; the pattern reused in §D.
- [ADR 0018](0018-whatsapp-transport-and-human-send.md): the WhatsApp real-data gate, preserved and NOT superseded (§F).
- [ADR 0015](0015-company-os-domain-core.md): the tenant is the only isolation boundary.
- BASELINE_REPORT §13 Q8; [DECISIONS.md](../DECISIONS.md) "Multi-tenant LGPD scope" and owner decision O.

## Context

Q8 asks when, and under what contract, real clinic data may cross the model-provider boundary. The model infrastructure already exists and is not rebuilt here: this record only makes the decision explicit and names the smallest gate that would enforce it.

## A. Current state

**Q8 is OPEN.** No real patient message body, clinical text, psychotherapy information or health data may reach a real LLM provider or a decision provider (owner review 2026-09-17; decision O).

**Already available, unchanged by this record:**
- the provider-neutral `ModelProvider` and the OpenAI Responses adapter over `fetch`: a closed request shape with no tools, metadata or user field, and `store: false` (ADR 0016);
- tier routing from deployment configuration;
- strict structured output, validated twice;
- the agent run itself: one bounded invocation, at most once, with ambiguous outcomes recorded `indeterminate` and no retry or fallback;
- price, spend-limit and kill-switch governance (ADR 0017);
- telemetry with allowlisted attributes (SI-60);
- mandatory human review, and no autonomous send.

**How Q8 is enforced today, precisely:**

1. **At ingress only.**
   - The synthetic ingress runs only when its flag is exactly `enabled`, and HTTP never reaches it (SI-44).
   - A production WhatsApp channel cannot be active (`communication_channels_q8_real_data_gate`, `ENABLE ALWAYS` triggers; SI-47).
   - A WhatsApp *test* channel still admits whatever its number receives. It rests on the owner's word that test numbers carry test data (ADR 0018, Consequences).
2. **On the decision path.** A shadow decision is requested only for a synthetic or WhatsApp-test origin (`20260925120000_decision_shadow.sql`).
3. **Not at the model boundary.**
   - What is sent: `ops.claim_agent_run` builds the prompt from the agent's name, role and description and the task's type, title and description.
   - What is checked: `ops.start_agent_run(provider, model, …)` checks the kill switch, the price and the spend limits, and nothing about the data.
   - The consequence: a task created directly (`ops.create_task` with the owner credential) with real text, followed by a requested run, would reach the configured provider.

   **Q8 is therefore held by the absence of a real ingress plus convention, not by a gate at the boundary itself.** §D closes that gap.

**Content stored today:**
- the inbound body in `ops.tasks.description`;
- the model output, including a reply draft, in `ops.agent_runs.result`, and the review derived from it;
- the sender's number as `contact_ref`;
- `ops.inbound_messages.body_fingerprint` and `ops.agent_runs.input_fingerprint`, both UNKEYED digests of content (SI-52).

No prompt text is stored as such.

## B. Proposed data classification

The classes are a closed, tenant-neutral vocabulary about sensitivity and provenance, not clinic vocabulary (CLAUDE.md rule 2). **A class is assigned by trusted server code from provenance, never read from a payload, the browser or content inspection.** Free text cannot be classified deterministically, and classifying it with a model would itself send it.

| Class | Examples here | External model (proposed) | Conditions | Content retention posture |
| --- | --- | --- | --- | --- |
| `synthetic` | fixtures, demos, the synthetic ingress | Allowed (today) | existing governance only | as today |
| `test` | WhatsApp test-channel content | Allowed as today (D8) | owner's word that it is test data (ADR 0018) | as today |
| `operational` | ids, stage codes, counts, instants, enums, capability names; no person's content | Allowed after an authorization (§D) | provider evidence recorded (§C) | metadata; normal retention |
| `identifier` | name, phone / `contact_ref`, email, CRM contact id, WhatsApp id | **Never sent** (proposed) | removed by minimisation; the run id links the answer back, so no identifier is needed | stays in the CRM and ledger; not in prompts |
| `person_text` | free text a lead or patient wrote (WhatsApp body, inbound email) | **Forbidden until D2 and D3** | if allowed: every §D condition, identifiers redacted, one capability, human review | content; limited retention (D6) |
| `health` | patient-provided text about symptoms or care; any `person_text` presumed health (D3) | **Forbidden until D2–D5** | as above, plus a recorded lawful-basis reference and the strictest provider bar (D4) | content; shortest retention (D6) |
| `clinical_record` | clinical notes, therapy-session content, psychotherapy records | **Forbidden** (proposed, whatever D2 says) | a separate future ADR | never leaves the clinical system |
| `derived` | model output about a person: classification, summary, draft, inferred mental state | Inherits its most sensitive input | re-sending it (to another model or Jev) is a new crossing of that class | same as its input's content |
| future `embedding` / memory | vectors or summaries for RAG | Inherits its source; not built | the RAG ADR must inherit this table | erasure must reach derived stores |

## C. External-provider evidence required before any authorization

Record each fact per provider, API product and model, from the provider's **current official documentation and the signed contract**, with the source, its version or date and who verified it. None may be assumed from memory or from a consumer product. Nothing is recorded yet, and no provider configuration changes.

1. **The API product actually used** (for OpenAI, the Responses API through a project key): the API terms apply, not consumer ChatGPT terms.
2. **Training:** whether submitted inputs and outputs are used to train, by default and contractually.
3. **Abuse-monitoring retention:** what is kept, for how long, and who may review it (human review of flagged content). `store: false` does not remove it (ADR 0016).
4. **Zero data retention:**
   - whether it is available to this organisation;
   - whether it is actually ENABLED for the organisation or project the key belongs to;
   - which endpoints and features it covers or excludes.
5. **Application-state storage:** the default of `store` and what it keeps, and any other request or response logging (for example dashboard logs).
6. **Processing and storage location**, and the data-residency options that exist.
7. **Subprocessors:** the current list and how changes are notified.
8. **The DPA:** whether one exists, the version signed, and the entity signed with.
9. **Deletion:** mechanics and timelines, including for retained abuse-monitoring data.
10. **Incident notification** terms.
11. **The model identity** the authorization binds to: exact model or snapshot name, as in `ops.model_prices`.
12. **Organisation and project settings** that change any of the above (project-level retention and data controls).

**For Jev** (the future DecisionPort provider), none of this exists: no API, authentication, DPA or data contract has been approved or verified. It stays unverified and outside every authorization.

## D. Proposed runtime enforcement (the smallest fail-closed gate)

1. **Classification at creation.** `ops.tasks.data_class` is a closed vocabulary set by the trusted creator and immutable afterwards:
   - the admission path derives `synthetic` or `test` from the source kind and the channel mode, the derivation the decision shadow already uses;
   - a direct `ops.create_task` must name a class, and anything unnamed is `unclassified`;
   - existing rows are backfilled from their admission, and otherwise set `unclassified`.
2. **Authorization as versioned owner data, the ADR 0017 pattern.** `ops.model_data_authorizations` is:
   - tenant-scoped, append-only and versioned, RLS-forced with no grant;
   - never a migration row (a static-guard finding, like prices);
   - recorded and retired only by an owner CLI act (`npm run ops -- data-auth record | retire | list`).

   Each version names exactly:
   - the tenant;
   - the data class;
   - the capability, which is the purpose;
   - the provider and the exact model;
   - the §C evidence fields and their verification date;
   - an opaque lawful-basis reference, pointing to the owner's legal record, not its content;
   - the content retention days for this class;
   - `expires_at`, which forces re-verification of the evidence;
   - the actor.
3. **One check, `ops.model_data_authorized(tenant, class, capability, provider, model)`,** answers the current matching authorization or nothing. `synthetic` and `test` pass without an authorization (today's behaviour). The in-process `fake` provider always passes, because nothing leaves the process.
4. **Where the check runs:**
   - **`ops.start_agent_run`**, the authoritative point: lease-bound, after the kill-switch check and before the price and spend reservation. A miss records the run `cancelled` / `data_not_authorized`, with no provider call and no retry.
   - **`ops.request_agent_run`**: an early refusal on the record when no authorization of any provider covers the class and capability (the decision E pattern).
   - **The decision-shadow start**, with the same function. Its existing origin gate stays as defence in depth.
5. **Interaction with the kill switch:**
   - a stop is checked first and HOLDS a run (ADR 0017 B);
   - a missing or retired authorization REFUSES it, because it is not transient;
   - retiring an authorization takes effect at the next start, and a call already in flight cannot be recalled.
6. **Absence means DENY** for every class except `synthetic` and `test`.
   - Nothing in the browser, `company_os_api`, a payload or an environment variable can authorize.
   - A worker setting only chooses a provider and a model, and it passes only if the database holds a matching authorization.
7. **Audit.** Every authorization version is immutable history. Every run records its `data_class` and the `data_authorization_id` it relied on, and a refusal records its category. Events carry codes and ids, never content.
8. **Minimisation,** for any non-synthetic class, in the capability's input builder:
   - a per-capability field allowlist: no agent or task metadata beyond what the capability needs, and a constant title (already true since Phase 2A);
   - deterministic redaction of structured identifiers in the free text (phone numbers, email addresses, CPF-shaped numbers, URLs);
   - the existing request-size bound.

   **Personal names inside free text cannot be removed deterministically.** Whether that residue is acceptable is D3/D4. There is no generic anonymisation system.
9. **Retention,** content kept separate from metadata:

   | What | Kind | Proposed posture |
   | --- | --- | --- |
   | Task description, `agent_runs.result`, review content | Content | Redacted in place when the class's retention ends or on erasure (D6, D7) |
   | Run row, cost, status, events, act logs | Metadata | Stay |
   | Unkeyed fingerprints | Content-derived | Nulled or re-keyed with a tenant secret (D7) |
   | The prompt at the provider | Provider-side | Governed by §C, never by us |

   The authoritative audit rows are never deleted to achieve erasure.

## E. Owner decisions required

Q8 closes only when each is answered and this ADR is accepted. Legal choices are the owner's, with counsel; the repository records references to them, not legal analysis.

1. **D1 — Roles.** The model provider acts on the clinic's instructions in every option.
   - **(a)** The clinic is the controller and operates Company OS itself (today's single tenant, `owns_local_crm`).
   - **(b)** The platform operator is a separate processor for each tenant, which needs a tenant–platform agreement.
   - **(c)** Other.

   *Consequence:* (a) suffices for tenant one; (b) is required before a second tenant.
2. **D2 — Which classes may ever reach an external model in the MVP.**
   - **(a)** None beyond `synthetic` and `test`: Q8 closed as "not now".
   - **(b)** Also `operational`.
   - **(c)** Also `person_text` / `health`, for exactly one capability (lead triage).

   `clinical_record` stays forbidden in every option. *Default-safe:* (a). *MVP-unlocking minimum:* (c).
3. **D3 — Presumption for free text a lead or patient writes.**
   - **(a)** Presumed `health`.
   - **(b)** `person_text` unless marked.

   *Consequence:* (a) applies the strictest bar to every real triage, and (b) needs a legal basis for the presumption itself. *Default-safe:* (a).
4. **D4 — Lawful basis for sending (presumed) health text to a provider.**
   - **(a)** Explicit, specific consent captured and recorded before processing. No consent is represented today (SI-49), so this adds capture and withdrawal.
   - **(b)** A non-consent legal hypothesis selected by counsel, with a DPIA (RIPD).
   - **(c)** None: D2 stays (a) or (b).
5. **D5 — The provider bar for `health`.**
   - **(a)** Zero data retention enabled for the key's organisation or project, no training, and a signed DPA.
   - **(b)** Standard API retention with a DPA.
   - **(c)** Other.

   *Default-safe:* (a).
6. **D6 — Content retention.** Days kept after the review is decided, for `health` and `person_text` content in tasks, results and reviews: **(a)** a fixed period (owner sets N), **(b)** until the conversation closes plus N, or **(c)** other.
7. **D7 — Erasure model.**
   - **(a)** Redact content in place and keep the content-free audit rows; fingerprints nulled or re-keyed.
   - **(b)** Hard delete, which conflicts with the append-only audit.
   - **(c)** Per-subject key crypto-shredding, which is heavier.

   *Default-safe:* (a).
8. **D8 — WhatsApp test channels.**
   - **(a)** Keep `test` on the owner's word (today).
   - **(b)** Also restrict a test channel to registered test sender numbers.
9. **D9 — International transfer.** The provider may process outside Brazil.
   - **(a)** Require a residency option, where one exists.
   - **(b)** Accept, with the transfer mechanism counsel documents.
   - **(c)** Prohibit.
10. **D10 — Who authorizes.**
    - **(a)** The owner alone, by CLI act (like prices and limits).
    - **(b)** The owner plus a second person, for `health`.

    Never the browser, in either option.

## F. What this record does NOT authorize

- No production enablement and no real patient model call.
- No provider configuration change and no zero-data-retention request.
- No Jev connection or Jev data contract.
- **No WhatsApp production enablement.** ADR 0018 amendment 1 still requires its own new Accepted ADR (the lawful basis for replying, consent and opt-in representation, retention and erasure of bodies and numbers). Amendment 2 still requires the live Meta probe first, and amendment 3 still requires a separate decision on the PUBLIC CRM helper grants. Closing Q8 does not open that gate.
- No RAG, pgvector, memory or embeddings.

## G. Implementation after owner approval (one batch)

1. **One forward migration:**
   - `ops.tasks.data_class` with its backfill and an immutability trigger;
   - `ops.model_data_authorizations` with its guards;
   - `ops.model_data_authorized`;
   - the gate in `start_agent_run`, `request_agent_run` and the decision-shadow start;
   - `data_class` and `data_authorization_id` on `ops.agent_runs`, and the `data_not_authorized` category.
2. **The owner CLI:** `ops -- data-auth list | record | retire`.
3. **Minimisation in the lead-triage input builder:** the allowlist and structured-identifier redaction.
4. **SI-70 (the gate) and SI-71 (immutable classification),** with a SQL suite and driver-backed cases, all on the fake provider:
   - absent → refused;
   - retired → refused at start;
   - a stop holds before the gate refuses;
   - `synthetic` and `fake` unaffected;
   - nothing from the browser authorizes.
5. **Deferred to a following batch:** content redaction and retention per D6 and D7.

Real use then needs, in order: the §C evidence verified; one owner `data-auth record`; and, for WhatsApp, the separate ADR and the live Meta probe.

## H. Owner decisions (2026-09-27) and how the enforcement batch implements them

The owner answered §E for this implementation. Legal and provider evidence stay the owner's, with counsel; the repository records references, never legal analysis.

| # | Owner decision | Implemented as |
| --- | --- | --- |
| D1 | (a) for tenant one: the clinic is the controller operating Company OS for itself. No multi-tenant processor-contract machinery; reopen before a second external tenant. | Person content (`person_text`, `health`) can be authorized only for the tenant that owns the local CRM (`ops.model_data_controller_tenant`, checked at recording and at every match). |
| D2 | The architecture may authorize `operational`, `person_text` and `health`, only for explicitly authorized purposes such as lead triage. Never direct identifiers as model input, never `clinical_record`. `synthetic` and `test` keep their rules. Technically authorizable health does NOT authorize real health traffic. | The authorization's class is closed to those three; the purpose is one capability; person content only for a capability whose input is minimised (`lead_triage`). No authorization is recorded. |
| D3 | (a) free text a lead or patient wrote is presumed `health`; no semantic downgrade. | The admission derives `health` for any free text that is neither synthetic nor from a test channel; nothing inspects content. |
| D4 | An explicit, versioned authorization reference compatible with specific consent; receiving a message is not consent; real health traffic stays denied until the lawful-basis evidence exists; another basis only by an explicit owner/legal decision. | `lawful_basis_ref` is required for person content, as an opaque reference; nothing records one. |
| D5 | For health: the contract covers the processing, a DPA, API data not used for training, zero data retention enabled (or an owner-approved equivalent; `store:false` is not it), exact provider/project/model evidence, retention behaviour verified. No OpenAI production access in this batch. | Every one is a required reference or `training_excluded = true` on a person-content authorization, bound to one provider and exact model; no provider configuration changed. |
| D6 | AI working content: 30 days after the review that completes the flow. Not clinical-record retention. Redaction is a later batch. | `content_retention_days` between 1 and 30 on every person-content authorization; enforcement is the next batch. |
| D7 | (a) redact content in place, keep non-content audit evidence; never hard-delete audit history. | Next batch. This one deletes nothing and keeps every version and run row. |
| D8 | Test channels must eventually require registered test senders; production WhatsApp unchanged; ADR 0018 stays an independent gate. | Not built (not needed for the gate); the admission classes a test channel's text `test`. ADR 0018 unchanged. |
| D9 | A documented international-transfer mechanism for real sensitive data; until it exists, deny; the generic DPA is not assumed to satisfy it. | `transfer_mechanism_ref` is required for person content; none is recorded. |
| D10 | (a) owner-only CLI act; every record and retire auditable; no browser authority. | `npm run ops -- data-auth` (`list`, `record`, `retire`); SI-39 extended; immutable versions retired once, on the record; no `company_os_api` function reaches the table. |

