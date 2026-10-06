# Management OS specification (Layer 3 — Management)

**What this is:** the canonical specification of Layer 3: how the owner manages the AI company. It covers the Owner Command Center, the exception and approval inbox, the Daily Brief, owner questions over structured state, KPIs and agent performance, costs, governance, and bounded **Decision Rooms**. Status per milestone lives in [CURRENT_STATE.md](CURRENT_STATE.md) and [ROADMAP.md](ROADMAP.md).

**Governing records:**
- [ADR 0024](adr/0024-three-layer-company-os-and-outcome-engine.md): owner as CEO and operator; bounded Decision Rooms;
- [ADR 0019](adr/0019-company-os-operator-surface.md): the operator surface, its function-only API, membership and narrow browser acts;
- [ADR 0022](adr/0022-openrouter-gateway-and-jev-intelligence.md): Jev, model economics;
- [ADR 0017](adr/0017-runtime-governance.md) and [ADR 0010](adr/0010-cost-control-and-kill-switch.md): spend limits and the kill switch;
- [ADR 0020](adr/0020-real-data-model-authorization.md): Q8.

Where this file and an Accepted ADR differ, the ADR wins.

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

---

## 1. Purpose

**"The owner manages exceptions and strategy."** The owner should not have to watch WhatsApp, ads, the calendar, the CRM and payments separately. Layer 3 aggregates the company into one place, raises only what needs the owner, and answers the owner's questions from evidence.

## 2. What exists today

The Company OS operator surface (`src/company-os/`, ADR 0019) is the foundation of the Command Center:

| Surface | What it shows | Status |
| --- | --- | --- |
| Overview | Tenant-scoped company state | ✅ Exists |
| Tasks, runs, activity | Work, agent runs and events | ✅ Exists |
| Reviews | Pending reviews with the Jev shadow decisions; decide (accept, reject, needs edit) | ✅ Exists (one browser act), with the screened message and the reply draft for synthetic or test data (ADR 0023 §L) |
| Decisões → Inteligência | Shadow agreement counts per policy and provider version, never accuracy | ✅ Exists |
| Saúde operacional | Queue, executions, failures, uncertain results, reviews, stops, cost; "Precisa de atenção" from concrete states | ✅ Exists |
| Agenda | Bookings and follow-ups | ✅ Exists (read-only) |
| Funil comercial | The CRM funnel from deals, with four narrow commercial acts | ✅ Exists |
| Costs, agents, communications, stops | Spend, agent profiles, channels and messages, execution stops (trip only) | ✅ Exists |
| Membership and session assurance | Explicit membership keyed to the auth user; AAL2 for Company OS and CRM data | ✅ Exists (Gate A) |
| Exception inbox, Daily Brief, owner questions, Decision Rooms, notifications | | ⬜ Planned |

Every browser act is a narrow, fixed-argument `company_os_api` function under the OD-8a pinning (ADR 0019). A new act in this layer follows the same pattern, with its own review.

## 3. The Owner Command Center

One place that shows:
- **company state:** today's leads, bookings, payments, sessions and packages;
- **KPIs** per layer and per employee;
- **exceptions** and **approvals** (§4);
- **agent performance:** throughput, review outcomes, human takeover, cost (§9);
- **costs:** AI spend against limits, and ad spend once Layer 2 exists;
- **recommendations** from employees and Decision Rooms (§7).

The Command Center evolves from the existing operator surface: the same module, function-only API and membership. Real state only: every number comes from a database projection, never from a model.

## 4. The owner task and exception inbox

The central workload-reduction feature. Instead of watching everything, the owner sees "**3 things need your attention**".

**One queue** for:
- approvals (a review to decide, a renewal message to approve, a conversion type to enable);
- exceptions (below);
- recommendations awaiting a decision;
- escalations and human takeovers;
- system failures (indeterminate sends, failed syncs, stuck work);
- decisions (Decision Room conclusions).

**Exception taxonomy (first set):**
- an unknown question;
- a message the screen blocked or held;
- a payment inconsistency;
- a booking conflict;
- a failed or indeterminate send;
- a person asking for a human;
- an ambiguous identity;
- a low-confidence Jev route;
- a provider outage;
- a reconciliation mismatch (payment, calendar, conversion upload).

**Each item has:**
- a type and a subject reference;
- a priority, structured first and Jev-assisted in shadow;
- an owner;
- a due time;
- a resolution with who and when.

`exception_raised` and `exception_resolved` record it; nothing is closed silently.

**Today's partial pieces:**
- the review queue;
- Saúde operacional's "Precisa de atenção";
- stops;
- `npm run ops -- indeterminate`.

The inbox unifies them without moving their authority.

## 5. The Daily Brief

A major desired feature. Example:

```
Today:
- 7 new leads
- 4 triages completed
- 3 paid first appointments
- 1 waiting for payment
- 2 follow-ups overdue
- 1 package ending
- 2 reschedule requests
- ad spend R$ X
- paid-first-appointment revenue R$ Y
- package revenue R$ Z
- 3 exceptions need you
```

Rules:
- **Every line is a structured query** over events, outcomes and state (`daily_brief_generated` records the snapshot), never a model's guess.
- A model may phrase or summarise **only aggregated, non-identifying, non-health figures**, under Q8. The numbers are computed first.
- Delivery (in the Command Center first; later a notification channel the owner chooses) is configuration.

## 6. Owner questions (company chat)

The owner should eventually ask:
- "What happened this week?"
- "Why did conversion fall?"
- "Which campaigns bring paying clients?"
- "Which leads need attention?"
- "How is Reception performing?"
- "Where am I losing money?"

Design:
- **Answers query structured business state** through a fixed set of read-only, tenant-scoped analytical tools over events, outcomes, funnel, costs and KPIs. They never query raw message content or arbitrary SQL (ADR 0011).
- **Answers cite their evidence:** which metrics, which period, which comparison. When the data cannot answer, the answer says so.
- **Q8 applies** to any model that phrases the answer: only aggregated operational data, never health or message text.
- Deeper "why" questions may open a Decision Room (§7).

## 7. Decision Rooms (bounded)

The only place several capabilities contribute to one question. Never an agent swarm.

- **Trigger:** a deterministic rule (for example "cost per paid first appointment rose 40% this week") or an owner request.
- **Structured requests:**
  - Company OS asks named capabilities (Growth, Reception, Analytics) for structured analyses over minimised data;
  - each answer has a fixed shape (findings, evidence references, confidence);
  - they are answered once, with no back-and-forth.
- **Synthesis:** one strong model synthesises the analyses into:
  - hypotheses;
  - evidence;
  - confidence;
  - recommended actions.
- **The owner decides.** The room acts on nothing: a recommended action becomes a task or an approval request only through the owner.
- **Bounds:** a budget, a fixed number of requests, a time limit, Q8 on every model call, and an audit record (`decision_room` requests and results in the structured-decision ledger or its successor).
- **Not allowed:**
  - autonomous councils;
  - voting swarms by default;
  - endless model-to-model conversation;
  - a room in any execution path.

## 8. Approvals and governance

- **Approval requirements are part of each Agent Contract** ([AGENT_CONTRACTS.md](AGENT_CONTRACTS.md)). `approval_requested` and `approval_decided` record them. The existing review decision is the first approval kind.
- **Existing governance stays the authority:**
  - membership and AAL2;
  - Q8 data authorizations (owner CLI);
  - versioned model prices and spend limits (global, tenant, company, per-agent ceiling);
  - the kill switch (trip from the browser; clear only by the owner);
  - retention and erasure.
- **Owner instructions** to employees become configuration versions (policy, playbook, knowledge, fixed messages, contracts), never free-form prompts that bypass review.

## 9. KPIs, agent performance and costs

- Per employee: the KPIs in its contract (Reception KPIs: [RECEPTION_OPERATIONS_SPEC.md](RECEPTION_OPERATIONS_SPEC.md) §22; Growth metrics: [GROWTH_INTELLIGENCE_SPEC.md](GROWTH_INTELLIGENCE_SPEC.md) §8).
- Agent performance:
  - throughput and success, failure and indeterminate rates;
  - review outcomes (accepted, rejected, needs edit);
  - human takeover;
  - grounding flags;
  - exception counts;
  - latency;
  - cost per outcome.
- Jev quality: agreement with deterministic routes and, more importantly, with measured outcomes (ADR 0023 §I). Never raw agreement alone.
- Costs: AI spend per agent, capability, model and provider (`ops.model_economics`), against the limits. Ad spend once Layer 2 exists.

## 10. Data and model constraints

- Everything in the Command Center is tenant-scoped, minimised and behind AAL2 (Gate A).
- No browser projection returns raw message bodies (SI-52). ADR 0023 §L makes the review's screened text and reply draft the one deliberate exception, for synthetic and test data.
- Models used in this layer (brief phrasing, owner questions, Decision Room synthesis) read only aggregated operational data authorized by Q8, through OpenRouter's authorized pools. Never health data.

## 11. Implementation milestones (workstreams G and H)

- **G. Management OS:**
  - the exception inbox (unify reviews, health attention, stops and indeterminate work);
  - the Daily Brief from structured queries;
  - agent KPI surfaces;
  - owner notifications;
  - owner questions over analytical tools.
- **H. Structured agent collaboration:**
  - shared events and tasks across employees;
  - bounded Decision Rooms;
  - cross-agent analysis;
  - recommendations;
  - owner approvals.

Layer 3 can grow incrementally. Its value grows as Layers 1 and 2 produce reliable data.

## 12. Definition of done (Layer 3)

The owner has one Command Center showing company state, KPIs, exceptions, approvals, agent performance, costs and recommendations, and can query the business without manually aggregating tools.
