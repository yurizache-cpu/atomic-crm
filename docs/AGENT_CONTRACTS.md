# Agent contracts

**What this is:** the canonical definition of an AI employee in the Company OS, and the intended boundaries of the first employees. Governing records:
- [ADR 0024](adr/0024-three-layer-company-os-and-outcome-engine.md): an AI employee is an agent with a contract;
- [ADR 0022](adr/0022-openrouter-gateway-and-jev-intelligence.md) §A, §G: an agent is not a model; the agent profile;
- [ADR 0015](adr/0015-company-os-domain-core.md) §5: agents are configuration;
- [ADR 0020](adr/0020-real-data-model-authorization.md): Q8;
- [ADR 0023](adr/0023-front-desk-agent.md): the front-desk agent.

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

---

## 1. What an AI employee is

An AI employee is **an agent with a contract**, held by the database:
- **identity:** an `ops.agents` row (name, role) in a department of a company of one tenant;
- **profile:** a versioned `ops.agent_profiles` row (objective, capabilities, tools, data classes, escalation and review policy, a daily cost ceiling, a time zone, a model pool per capability), enforced at every run start (`agent_not_permitted`, `agent_budget_exhausted`; ADR 0022 §G);
- **configuration:** for the front desk, the four versioned kinds (operating policy, playbook, knowledge, fixed messages; ADR 0023 §D);
- **contract:** the fields below. Some are stored today, the rest are this specification until their milestone stores them.

**It is not a model.** The model that executes a run is chosen per run from the capability's pool, among the candidates Q8 authorizes, by a deterministic router (Jev advises in shadow). Nothing records `employee = model`. Changing models never changes the employee's contract.

**It has no authority of its own.** Every act goes through a database capability with its own checks (Q8, permissions, stops, spend, send eligibility). Arbitrary SQL is never available (ADR 0011). Future tools are explicit, allowlisted capabilities.

## 2. The contract fields

| Field | Meaning | Where it lives today |
| --- | --- | --- |
| `role` | The employee's job title | `ops.agents.role` |
| `department` | Organisational placement | `ops.agents.department_id` |
| `objective` | What the employee is for, in one statement | `ops.agent_profiles.objective` |
| `capabilities` | What it may run (`lead_triage`, …) | `ops.agent_profiles` capabilities; enforced at run start |
| `tools` | Callable actions | `ops.agent_profiles` tools, **empty today** (enforced) |
| `read_permissions` | Data it may read | Database capabilities and projections; the context the database builds (ADR 0023 §E). Specification here |
| `write_permissions` | State it may change | Lease-bound worker capabilities only (no table grants; the worker never holds a client). Specification here |
| `events_consumed` | Facts it reacts to | Specification ([DOMAIN_EVENT_CATALOG.md](DOMAIN_EVENT_CATALOG.md)) |
| `events_produced` | Facts it records (never a business fact from a model's output) | Specification |
| `KPIs` | How it is measured | Specification (per layer) |
| `budget` | Daily cost ceiling, plus the global, tenant and company limits | `ops.agent_profiles` ceiling; `ops.spend_limits` |
| `model_pools` | Pool per capability | `ops.agent_profiles` capability pools; `ops.model_pools` |
| `human_escalation` | When a person takes over | Profile escalation policy; front-desk rules (person request, danger, opt-out; ADR 0023 §G) |
| `approval_requirements` | What needs a person's approval | Profile review policy (human review always required today); send mode (`staging`, `supervised`; never `autonomous`, ADR 0023 §F) |
| `data_classes` | Classes it may process | `ops.agent_profiles` data classes, checked with Q8 at run start (SI-70, SI-71) |
| `retention_constraints` | How long its working content lives | The content-retention clocks (ADR 0020 §I, SI-72) and identifier retention (ADR 0021 W5, SI-79) |

**Changing a contract** is an owner act that creates a new profile or configuration version (`npm run models -- profile record`, `npm run front-desk -- config draft|publish`). A version is never edited. A future settings screen adds browser acts under the OD-8a pinning (ADR 0019).

## 3. The Receptionist (Layer 1) — exists

| Field | Contract |
| --- | --- |
| Role, department | Receptionist, front desk (tenant words: recepção, recepcionista) |
| Objective | Run the administrative and commercial journey of leads and clients, from first contact to renewal, within the clinical boundary |
| Capabilities | `lead_triage` today (reply drafting with triage fields); planned: structured triage, scheduling, payment requests, follow-up content, renewal preparation |
| Tools | None today. Planned, as allowlisted capabilities: slot lookup and booking (holds), payment request, follow-up scheduling, owner notification |
| Read | The screened message and screened turns, the published configuration, availability, the next booking, and payment and package state when they exist. **Never** the raw message, health fields, or other conversations |
| Write | Review items (drafts), triage fields, scheduling and payment requests through their capabilities. **Never** payment confirmation, availability, attendance, package balance or conversions |
| Consumes | Inbound message events; booking, payment and session administration events; follow-up due events |
| Produces | Lead state and triage events, scheduling-workflow events, payment requests, follow-ups, operational outcome triggers, exceptions |
| KPIs | [RECEPTION_OPERATIONS_SPEC.md](RECEPTION_OPERATIONS_SPEC.md) §22 |
| Budget | A small daily ceiling (staging: 500,000 micro-dollars) under the tenant and global limits |
| Model pools | `reception_low_cost` (staging: Gemini 3.8 Flash rank 1 and GPT-6 Luna rank 2 since 2026-10-06; Haiku 4.5 rank 3) |
| Escalation | A request for a person, danger or an opt-out (deterministic), an ungrounded fact, an unknown question, an ambiguous identity |
| Approval | Every reply reviewed by a person today; send mode `supervised`. Autonomy only by a later owner decision with its own ADR |
| Data classes | `synthetic` and `test` today. A real sender's message is `health` and is refused before any model (Q8, ADR 0021 W1) |
| Retention | AI working content on the D6/D7 clocks; phone identifiers 12 months after the last message |

## 4. The Growth / Ads Manager (Layer 2) — planned

| Field | Contract |
| --- | --- |
| Objective | Improve acquisition by business value: more paying clients per real spend |
| Consumes | Attribution, ad costs and campaign metadata, Outcome Engine outcomes and revenue, funnel metrics |
| Produces | Conversion-upload tasks, diagnoses and recommendations, anomalies, experiment proposals |
| Must not read | Clinical content, message text, triage health fields, conversation transcripts |
| Tools (future) | Spend import, conversion upload of owner-enabled types (idempotent, reconciled), campaign reads. Write actions on campaigns and budgets only after an owner decision (workstream I) |
| Approval | Recommendations by default; an upload type is enabled by the owner; any campaign change requires approval |
| Data classes | `operational` only (ids, amounts, counts, instants, campaign metadata) |
| KPIs | Cost per paid first appointment, CAC, ROAS, funnel rates by campaign, upload success and reconciliation |

## 5. Analytics (capability, possibly an agent) — planned

| Field | Contract |
| --- | --- |
| Objective | Turn events and outcomes into metrics, funnel summaries, attribution reports and trend detection |
| Consumes | Minimised events and outcomes |
| Produces | Metrics and summaries for the Command Center, the Daily Brief and Decision Rooms |
| Authority | None operational: it never changes a booking, a payment, an outcome or a funnel stage |
| Model use | Mostly deterministic queries. A model may phrase aggregated, non-identifying figures, under Q8 |

## 6. Management / Chief-of-Staff (Layer 3) — planned

| Field | Contract |
| --- | --- |
| Objective | Keep the owner informed and in control with minimal attention |
| Consumes | KPIs, exceptions, employee outputs, decision requests, costs |
| Produces | The Daily Brief, structured management summaries, the prioritised exception inbox, Decision Room requests and syntheses |
| Authority | None beyond the owner's: it never bypasses permissions, Q8, approvals or stops, and it acts only through tasks and approvals the owner decides |
| Model use | Phrasing and synthesis over aggregated operational data only; bounded Decision Rooms ([MANAGEMENT_OS_SPEC.md](MANAGEMENT_OS_SPEC.md) §7) |

## 7. Shared services (not employees)

- **Jev, the structured decision layer** (ADR 0022 §E, §F): business routing, model-route advice and lead intelligence, shadow-first, one ledger. It serves employees and the owner. It is not an employee and owns no business fact.
- **The model gateway (OpenRouter)**, the deterministic router, Q8, spend governance, the kill switch, the screen and the grounding check are infrastructure every employee runs through.

## 8. How employees collaborate

Through the catalogued events, tasks, state and decisions ([DOMAIN_EVENT_CATALOG.md](DOMAIN_EVENT_CATALOG.md)), never through free-form conversation. Cross-employee analysis happens only in a bounded Decision Room that the owner or a deterministic rule opens. See the master blueprint §5.
