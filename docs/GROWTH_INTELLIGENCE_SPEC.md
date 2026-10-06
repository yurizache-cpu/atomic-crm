# Growth intelligence specification (Layer 2 — Growth)

**What this is:** the canonical specification of Layer 2: attribution, the **Outcome Engine**, funnel economics, analytics, conversion feedback to ad platforms, and the future **Growth / Ads Manager**. Status per milestone lives in [CURRENT_STATE.md](CURRENT_STATE.md) and [ROADMAP.md](ROADMAP.md).

**Governing records:** [ADR 0024](adr/0024-three-layer-company-os-and-outcome-engine.md) (Reception produces outcomes, Growth consumes them), [ADR 0022](adr/0022-openrouter-gateway-and-jev-intelligence.md) §F (lead intelligence: operational signals only, never presented as a probability before calibration), [ADR 0020](adr/0020-real-data-model-authorization.md) (Q8), decision I in [DECISIONS.md](DECISIONS.md) (open-source-first: Umami approved for analytics). Where this file and an Accepted ADR differ, the ADR wins.

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.** No ad platform, analytics service or conversion upload is connected or authorized.

---

## 1. Purpose and principle

Understand where revenue comes from, and improve acquisition by teaching acquisition systems about **real business outcomes**, not clicks or messages.

**Reception produces business outcomes. Growth consumes them.**
- Reception (Layer 1) runs the journey and records the facts.
- The Outcome Engine turns authoritative facts into canonical outcomes attached to the lead's attribution.
- Growth reads outcomes, costs and attribution to measure, diagnose and recommend.
- Reception never owns the Google Ads integration, and Growth never infers revenue from messages or clicks.

**Dependency rule:** no sophisticated optimisation on unreliable conversion events. Growth is built after the Layer 1 outcomes it consumes are trustworthy.

## 2. Funnel events

The CRM and the Outcome Engine distinguish (catalogue: [DOMAIN_EVENT_CATALOG.md](DOMAIN_EVENT_CATALOG.md)):

| Funnel step | Event | Authority |
| --- | --- | --- |
| Lead | `lead_created` | Identity resolution at entry |
| Qualified | `triage_completed` | Required triage fields present |
| Booked | `first_appointment_booked` | Scheduling domain |
| Paid | `first_appointment_paid` | Payment settlement or authorized manual confirmation |
| Attended | `first_appointment_attended` | Appointment lifecycle record |
| Package | `package_purchased` | Payment settlement of a package |
| Renewal | `package_renewed` | Payment settlement of a renewal |
| Losses | `appointment_no_show`, `booking_cancelled`, `payment_failed`, `payment_refunded`, the CRM's lost opportunity | Their own authorities |

**A WhatsApp message is not a primary business conversion.** Neither is a click, a form view or a sent link.

## 3. The Outcome Engine

The central Layer 2 concept. It links:

```
acquisition -> lead -> funnel -> confirmed revenue -> later outcomes
```

Example:

```
Lead 123
  source = Google Ads, click attribution = <captured identifiers>
  -> first_appointment_paid   value = R$ <confirmed>
  -> package_purchased        value = R$ <confirmed>
  -> package_renewed          value = R$ <confirmed>
```

**What it records (conceptual; the schema is decided in its milestone):** one row per canonical outcome:
- tenant;
- the person reference (CRM contact, resolved identity);
- the outcome kind and its version;
- `occurred_at`;
- `value` and currency;
- the **source fact**: the payment settlement id, the booking id or the appointment record that proves it;
- the attribution snapshot reference;
- an idempotency key derived from the source fact, so each outcome exists once.

**Outcome authority:** outcomes come only from deterministic sources:
- payment settlement;
- the appointment lifecycle;
- the package lifecycle.

An LLM, Jev or a Decision Room never declares "this lead converted". A refund or a reversal is a new outcome that offsets, never an edit.

**Outcome kinds are tenant-aware.** The engine knows generic categories (lead, qualified, booked, first payment, service delivered, contract purchased, contract renewed, loss). The clinic's names (first appointment, package) are its configuration of those categories (CLAUDE.md rule 2).

**Relation to the CRM funnel:**
- The CRM's deals stay the one commercial pipeline (SI-66, SI-67).
- The Outcome Engine does not replace them. It records confirmed outcomes with value and attribution, and the commercial acts (convert, lose) stay the CRM's.
- Where both describe one fact, the implementation milestone defines which one derives from the other, never two independent writers.

## 4. Identity and attribution

- **Identity** is resolved deterministically by Layer 1 ([RECEPTION_OPERATIONS_SPEC.md](RECEPTION_OPERATIONS_SPEC.md) §5). Growth never merges identities.
- **Attribution** is captured at entry into the CRM's `acquisition_attributions`, which already holds source, medium, campaign and its id, ad group and its id, ad and its id, keyword, match type, landing page, UTM fields and gclid. First touch is preserved; later touches are added.
- **Click identifiers:** gclid exists as a column. Others (for example gbraid and wbraid) are added only after verifying current official Google documentation when this is implemented.

## 5. The Growth / Ads Manager (future AI employee)

Contract summary (full contract: [AGENT_CONTRACTS.md](AGENT_CONTRACTS.md)):
- **Consumes:**
  - attribution;
  - ad costs and campaign metadata;
  - Outcome Engine outcomes and revenue;
  - funnel metrics.
- **Produces:**
  - conversion-upload tasks;
  - diagnoses and recommendations;
  - anomalies;
  - experiment proposals.
- **Never reads:**
  - clinical content;
  - message text;
  - triage health fields.
- **Autonomy, staged:**
  1. analysis and recommendation only;
  2. uploads of owner-approved conversion types;
  3. prepared changes the owner approves.

  Autonomous campaign or budget changes are not allowed until an owner decision (workstream I).

## 6. Ad platform feedback

The goal: teach acquisition systems about real outcomes, not "the person clicked WhatsApp".

- **Candidate conversion signals:**
  - first appointment booked;
  - first appointment paid;
  - package purchased (and its value);
  - renewal value.
- **The primary optimisation event is configurable,** never hard-coded. **Initial recommendation:** evaluate `first_appointment_paid`. It is economically meaningful, close to acquisition and more frequent than a package purchase. As volume grows, evaluate value-based optimisation on deeper outcomes.
- **Implementation from current documentation only.** When the milestone starts, research Google's current official guidance and prefer the currently recommended mechanism for:
  - offline or enhanced conversions for leads;
  - conversion imports;
  - click identifiers;
  - first-party data;
  - the Data Manager API, if still current.

  Nothing is implemented from memory.
- **Before any upload: an owner and legal decision.** The business is a health service. Uploading a conversion tied to a click or to hashed contact data tells the platform that this person used a psychology service. The milestone must settle all of the following in writing (the owner decides; there is no external counsel):
  - which identifiers may be sent (a click id only, or hashed contact data);
  - the lawful basis and consent representation;
  - Google's current health-advertising policies for this category and region.

## 7. Attribution reconciliation and the upload lifecycle

Every upload is a governed, idempotent workflow:
- **States:** `conversion_ready_for_upload` → `conversion_uploaded` | `conversion_upload_failed`, then `attribution_reconciled`.
- **Idempotency:** the exact business-event id (the outcome's source fact) is the upload key. The same conversion is never uploaded twice, and a retry is safe by construction.
- **Retries:** only where the platform's semantics make them safe. Ambiguous results are `indeterminate`, reconciled against the platform's report, never blindly re-sent (the ADR 0016 pattern).
- **Reconciliation:** a scheduled job compares uploaded outcomes with the platform's accepted conversions and raises exceptions for mismatches.

## 8. Growth metrics

All computed from outcomes, costs and attribution. **Revenue never includes unconfirmed payment.**

| Metric | Definition |
| --- | --- |
| Ad spend | From the ads platform, per campaign and period |
| Leads, CPL | Leads; spend / leads |
| Cost per booked appointment | Spend / `first_appointment_booked` |
| Cost per paid first appointment | Spend / `first_appointment_paid` |
| Cost per attended appointment | Spend / `first_appointment_attended` |
| CAC (package) | Spend / `package_purchased` |
| Funnel rates | Lead → booked, booked → paid, paid → attended, attended → package |
| Package revenue | Sum of confirmed package values |
| Attributed revenue | Confirmed revenue whose lead has the campaign's attribution |
| ROAS | Attributed confirmed revenue / spend |
| ROI | Only once a margin or cost model is defined |
| Renewal revenue | Sum of confirmed renewals |
| LTV | Later, once enough history exists |

## 9. Campaign quality and lead intelligence

- **Campaign quality** is measured downstream, by business value per unit of spend. Campaign A may bring cheap leads that rarely pay; campaign B, expensive leads with high package conversion. Growth optimises for **business value**, not the cheapest message.
- **Lead intelligence (Jev, shadow; ADR 0022 §F).** It may produce:
  - commercial readiness and engagement;
  - funnel priority and follow-up priority;
  - an administrative objection.

  It reads operational signals only (enums, counts, intervals), never text or health.
- **No uncalibrated probabilities.** A score is never shown as "87% probability of conversion". Outcomes are stored beside each score (`ops.decision_outcomes`) so calibration can happen later.

## 10. Analytics

- Website and landing-page analytics: **Umami**, approved by decision I (open-source-first, behind an adapter). Not integrated. Privacy-first configuration, no health content in page paths or events.
- Product and funnel analytics are computed in our database from events and outcomes. The Analytics capability ([AGENT_CONTRACTS.md](AGENT_CONTRACTS.md)) produces metrics, funnel summaries, attribution reports and trend detection, without duplicating operational authority.

## 11. Data protection constraints

Advertising and analytics feedback contains only the minimum authorized commercial and attribution information. **Never send:**
- symptoms;
- diagnoses;
- clinical notes;
- therapy content;
- medication;
- triage health fields;
- message text;
- any score or segment derived from health data.

Q8 governs any model that reads growth data. Health-derived variables are never used for commercial optimisation.

## 12. What exists today

| Capability | Status |
| --- | --- |
| Attribution columns per contact (`acquisition_attributions`) | ✅ Table exists; 🟡 nothing captures into it at entry yet |
| CRM commercial funnel (deals, stages, transition ledger, convert and lose acts, closing rate, source breakdown) | ✅ Exists (Phase 3B, SI-66 to SI-69) |
| Lead intelligence in shadow, with outcomes storable for calibration | ✅ Exists (ADR 0022 §F) |
| Cost per agent, model and provider (`ops.model_economics`) | ✅ Exists (AI cost, not ad spend) |
| Outcome Engine, payments, packages | ⬜ Planned |
| Ads platform spend import, conversion uploads | ⬜ Planned; 🚫 the upload needs the owner and legal decision in §6 |
| Umami | ⬜ Approved, not integrated |
| CPL, CAC, ROAS dashboards | ⬜ Planned (Phase 3B.1 deliberately did not build them) |

## 13. Implementation milestones (workstreams E and F)

- **E. Outcome and attribution foundation:**
  - identity resolution (with Layer 1);
  - attribution capture at entry;
  - the Outcome Engine;
  - conversion semantics;
  - revenue attribution.
- **F. Growth intelligence:**
  - ads and analytics connectors (verified against current documentation);
  - spend import;
  - qualified offline conversion feedback (after the §6 decision);
  - funnel economics dashboards (CPA, CAC, ROAS);
  - Growth / Ads Manager recommendations.

## 14. Definition of done (Layer 2)

- Every acquisition lead carries its attributable source when one exists.
- Downstream outcomes attach to the lead, and confirmed revenue attaches to the right funnel.
- Ad and analytics platforms receive only authorized commercial feedback.
- Conversion uploads are idempotent and reconciled.
- Dashboards show real funnel economics.
- Growth can distinguish cheap bad leads from expensive valuable leads.
