# ADR 0024 — Three-layer AI Company OS, event-first employee collaboration and the Outcome Engine

**Status:** Accepted (owner decision, 2026-10-05; recorded 2026-10-06 in the Company OS master blueprint milestone). **Date:** 2026-10-06.

**Expands, does not supersede:** [ADR 0015](0015-company-os-domain-core.md) (domain core), [ADR 0020](0020-real-data-model-authorization.md) (Q8), [ADR 0021](0021-whatsapp-production-real-data-gate.md) (WhatsApp production gate), [ADR 0022](0022-openrouter-gateway-and-jev-intelligence.md) (OpenRouter and Jev), [ADR 0023](0023-front-desk-agent.md) (the front-desk agent). Every Accepted decision in those records stands. Where this record and one of them seem to disagree, the earlier Accepted record wins until a later ADR says otherwise, and this record is the one to reconcile.

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.** This record authorizes no data, no provider, no channel and no send.

## Context

The repository has grown milestone by milestone: a Company OS domain core (tenants, companies, departments, agents, tasks, events), an agent runtime with governance, a WhatsApp transport, an operator surface, a decision layer (Jev), scheduling and follow-up foundations, a commercial funnel, Q8 enforcement and retention, an OpenRouter gateway and an AI receptionist. Each milestone has its own ADR and report. What no record states is the whole: what the system is for, how its parts fit, which part owns which fact, and in which order the rest is built.

On 2026-10-05 the owner stated the whole. The product is an **AI Company Operating System for the clinic**: the clinic runs as a company with digital employees, and the owner acts as its CEO, operator and team leader, directing the company and handling decisions and exceptions rather than performing every repetitive task. It is not a CRM, a WhatsApp bot, a chatbot or a set of automations.

Without a record, three failure modes are likely: a future session designs one enormous receptionist prompt that owns business truth; growth features are built on unreliable conversion signals (a message, a click); and agents are wired to talk to each other freely, which is expensive, unauditable and impossible to govern.

## Decisions

### 1. Three layers

The company is organised in three layers. Each has a canonical specification.

| Layer | Purpose | Primary AI employee | Specification |
| --- | --- | --- | --- |
| 1. Operations | Run the clinic's daily administrative operation: the lead and customer journey from first contact to renewal | Receptionist | [RECEPTION_OPERATIONS_SPEC.md](../RECEPTION_OPERATIONS_SPEC.md) |
| 2. Growth | Understand where revenue comes from and improve acquisition | Growth / Ads Manager | [GROWTH_INTELLIGENCE_SPEC.md](../GROWTH_INTELLIGENCE_SPEC.md) |
| 3. Management | Let the owner manage the AI company: state, KPIs, exceptions, approvals, costs, decisions | Management / Chief-of-Staff capability | [MANAGEMENT_OS_SPEC.md](../MANAGEMENT_OS_SPEC.md) |

The north star is [COMPANY_OS_MASTER_BLUEPRINT.md](../COMPANY_OS_MASTER_BLUEPRINT.md).

### 2. An AI employee is an agent with a contract, not a model

ADR 0022 §A stands: an agent is defined by data, and the model is chosen per run among the candidates Q8 authorizes. This record widens the definition into the **Agent Contract** ([AGENT_CONTRACTS.md](../AGENT_CONTRACTS.md)): role, department, objective, capabilities, tools, read and write permissions, events consumed and produced, KPIs, budget, model pools, human escalation, approval requirements, data classes and retention constraints. Nothing records `employee = model`.

### 3. Collaboration is event-first

Employees collaborate primarily through **events, tasks, state and decisions**, not free-form conversation:

```
employee -> typed event / task / outcome -> Company OS -> the employees that consume it
```

An important business fact is recorded once, as a typed event with a minimal payload, and every consumer reads that event. A consumer never parses another employee's chat history to learn what happened. The canonical vocabulary is [DOMAIN_EVENT_CATALOG.md](../DOMAIN_EVENT_CATALOG.md). It extends the existing `ops.events` model (ADR 0015 §7) and does not create a second event store.

### 4. Bounded Decision Rooms, never agent swarms

Free-form multi-agent analysis is allowed only as a **bounded management capability**, the Decision Room ([MANAGEMENT_OS_SPEC.md](../MANAGEMENT_OS_SPEC.md) §7):
- a deterministic trigger (a KPI rule) or an owner request opens it;
- Company OS asks named capabilities for structured analyses over minimised data;
- one synthesis produces hypotheses, evidence, confidence and recommended actions;
- the owner decides.

It sits outside every execution path, has a budget and a round limit, and acts on nothing. There are no autonomous agent councils, no voting swarms and no endless model-to-model conversations. ADR 0022 §E ("no councils, voting or chained models: one structured decision, then one executor") stands for execution routing and is unchanged.

### 5. Deterministic sources of truth

LLMs (and Jev) may interpret, draft, classify, recommend and converse. They are **never** the authority for:
- payment confirmation;
- calendar availability;
- appointment existence;
- package balance;
- session completion;
- conversion value;
- opt-out;
- permissions;
- send authority.

Those facts come from deterministic state and tools. The source-of-truth matrix is in the master blueprint §6. This restates CLAUDE.md rule 3 at company scale.

### 6. The Outcome Engine

The business is measured by **outcomes**, not messages. A WhatsApp message, a click or a sent link is never a conversion.

The **Outcome Engine** links acquisition to confirmed value:

```
acquisition -> lead -> funnel -> confirmed revenue -> later outcomes
```

It records each canonical outcome once, from its authoritative source:
- a payment settlement;
- the appointment lifecycle;
- the package lifecycle.

Each outcome carries its value, its time, the source fact and the attribution of the lead it belongs to. An LLM never declares that a lead converted. The engine is specified in [GROWTH_INTELLIGENCE_SPEC.md](../GROWTH_INTELLIGENCE_SPEC.md) §3. It is planned and does not exist yet.

### 7. Reception produces outcomes; Growth consumes them

The Receptionist (Layer 1) runs the journey and produces commercial outcome events. The Growth / Ads Manager (Layer 2) consumes them through the Outcome Engine. Reception does not own the Google Ads integration, and Growth does not infer revenue from messages or clicks. Layer 2 is built only on trusted Layer 1 outcomes.

### 8. The owner manages exceptions and strategy

Routine work happens automatically or semi-automatically. What reaches the owner is explicit and scarce:
- exceptions;
- approvals;
- ambiguity;
- high-risk operations;
- strategy.

It reaches the owner through one Command Center with an exception inbox and a Daily Brief built from structured state. The goal is not an automation percentage; it is the owner's attention spent only where it is asked for.

### 9. Reception is a channel-independent engine

The business capability is the **Reception Operations Engine**. WhatsApp, the website form and the booking page are channels. Business logic never lives in a channel adapter. ADR 0018 (the transport), ADR 0021 (the production gate) and ADR 0023 (the screen, configuration, takeover and clinical boundary) stand. In particular, the clinical boundary stands: Reception never provides care, and a patient's treatment conversation happens with the psychologist directly, outside the system.

### 10. Everything already decided stays decided

- **Q8 (ADR 0020)** remains the model and data authority. No employee, conversation or Decision Room can bypass it. OpenRouter can never be authorized for `person_text` or `health` (SI-78). The owner's rule stands: no health information is fed to AI through OpenRouter.
- **Jev (ADR 0022)** stays shadow-first until measured on outcomes, not on agreement.
- **The front-desk screen and the clinical boundary (ADR 0023)** stand.
- **Fail closed, cost first and the production gates** stand.
- **Tenant vocabulary is data** (CLAUDE.md rule 2, ADR 0013). The clinic's words (patient, psychologist, session) belong to tenant configuration and specifications. Engine concepts stay generic: appointment, package and outcome are service-business terms; a later tenant maps its own outcomes through configuration.

## Alternatives rejected

- **One enormous receptionist prompt** that holds the journey, the prices and the agenda: it makes the model the source of truth and cannot be audited or tested.
- **Reception as the Google Ads integration:** couples an operational employee to an acquisition platform and invites sending conversation content to advertising.
- **Agents talking freely to coordinate:** expensive, non-deterministic, unauditable, and a data-leak path around Q8.
- **Conversion = a WhatsApp message or a click:** optimises acquisition for the cheapest conversation, not for paying customers.
- **A second event bus or store:** `ops.events` with typed, minimised payloads already gives one ordered, tenant-scoped, audited record.

## Consequences

- The canonical project memory is a small set of files: [COMPANY_OS_MASTER_BLUEPRINT.md](../COMPANY_OS_MASTER_BLUEPRINT.md), [CURRENT_STATE.md](../CURRENT_STATE.md), the three layer specifications, [DOMAIN_EVENT_CATALOG.md](../DOMAIN_EVENT_CATALOG.md) and [AGENT_CONTRACTS.md](../AGENT_CONTRACTS.md). Phase reports remain evidence, not boot memory. CLAUDE.md carries a fresh-session boot sequence and a maintenance rule.
- [ROADMAP.md](../ROADMAP.md) gains a long-term program map: workstreams A to J, each mapped to what exists. Implementation continues milestone by milestone; this record builds nothing.
- New business facts are added as catalogued events first, then as features. A feature that needs a fact no event records adds the event to the catalog in its own milestone.
- Google Ads, a payment provider, Google Calendar and the Command Center are planned, not authorized: each needs its own milestone, and the external ones need the owner's decisions recorded in their specifications.

## What this record does NOT do

- It authorizes no real data, no provider and no channel, and it opens no production gate.
- It does not change any database object, any security invariant ([SECURITY_INVARIANTS.md](../SECURITY_INVARIANTS.md)) or any Accepted ADR.
- It does not choose a payment provider, an ads integration mechanism or a calendar provider. Each is verified against current official documentation when its milestone starts.
