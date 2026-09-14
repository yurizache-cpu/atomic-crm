# Architecture Decision Records

Index of ADRs under [`docs/adr/`](adr/). Each records context, decision, alternatives and consequences, so that a future session does not casually reverse a deliberate choice.

**Reconciled 2026-09-11 (Phase 0.5, Workstream K).** Every record was re-read against the implementation. One contained a materially false security claim and has been corrected; three decisions the owner made in the Phase 0.5 brief are now `Accepted`; the rest remain `Proposed` and still await approval. **Update 2026-09-13:** the owner has since accepted 0012 (2026-09-12) and 0015 (2026-09-13), each with an addendum. 0002 and 0003 were reconciled with both on 2026-09-13 and remain `Proposed`; see their rows. **Later 2026-09-13:** the owner accepted 0003 as reconciled; 0002 stays Proposed (see its row). **Final 2026-09-13:** the owner accepted 0002 under the final pre-1D acceptance bar (SI-27; local evidence, CI pending).

> 🔴 **Approving the remainder is a scheduled task, not a formality.** ADRs 0001 and 0002 carry *very high* reversal cost and are implemented in Phases 2 and 3. *(2026-09-13: both are already implemented in part, by Phases 1A–1C, while still Proposed. Their review is overdue, not upcoming.)* Building on an unapproved ADR converts a reversible choice into an accident.

| # | Decision | Status | Reversal cost |
| --- | --- | --- | --- |
| [0001](adr/0001-runtime-execution-substrate.md) | Runtime execution substrate — Postgres queue + always-on worker | Proposed | **Very high** — rewrites every tool call |
| [0002](adr/0002-tenancy-model.md) | Tenancy — tenant is the only isolation boundary; `tenant_id` + FORCE RLS on tenant-data `ops` tables, tenant from a live lease, privilege and composite-key isolation for the Company OS; `ops` off the Data API | **Accepted 2026-09-13** under the owner's final pre-1D acceptance bar ⚠️ **corrected** 2026-09-11. The MCP channel is closed by removal and kept out (SI-03), hosted functions are checked before every deploy, and the `merge_contacts` owner-session pool is measured unable to reach `ops` or carry state (SI-27). Local evidence; CI pending | **Very high** — retrofitting tenancy touches everything |
| [0003](adr/0003-identifier-strategy.md) | Server-generated UUID keys on engine entity tables; no FK into `public.*`; tenant-scoped CRM references; key-based idempotency | **Accepted 2026-09-13** — as reconciled; global monotonic identifiers (`events.seq`, `job_events.id`, any future sequence) are internal only | High — one bigint FK welds the CRM to the core |
| [0004](adr/0004-principal-model.md) | Engine-owned `principals` (human / agent / service) | Proposed | High — determines whether agent actions are auditable at all |
| [0005](adr/0005-ra-core-boundary.md) | `ra-core` never crosses into the engine | Proposed | High — unwinding `RaRecord` later is a full rewrite |
| [0006](adr/0006-declarative-schema-workflow.md) | Make the declarative schema workflow actually wired | Proposed | Low to fix now, **catastrophic to leave** |
| [0007](adr/0007-launcher-relationship.md) | Company OS supersedes the chat-service launcher; its config is inert dev tooling | **Accepted** | Low — re-integrating later is additive |
| [0008](adr/0008-fork-posture.md) | Hard-fork; stop publishing the registry | Proposed | Medium — cherry-picking upstream fixes becomes manual |
| [0009](adr/0009-governance-envelope.md) | Governance envelope — risk as data, fail-closed default, confidence escalates but never skips review | Proposed | High — a gate retrofitted after agents act is a gate nobody trusts |
| [0010](adr/0010-cost-control-and-kill-switch.md) | Cost ledger in-transaction, per-agent budgets, **fleet-wide kill switch** (scopes + semantics added in Phase 0.5) | Proposed | Low to build now, **unbounded to omit** |
| [0011](adr/0011-mcp-trust-boundary.md) | The MCP function is **not** part of the production trust boundary; no agent gets arbitrary SQL. **Removed 2026-09-13** and kept out of the committed deploy paths (SI-03) | **Accepted** (owner, Q12; removal addendum 2026-09-13) | Low — it constrains a component rather than shaping the engine |
| [0012](adr/0012-worker-tenant-context.md) | Worker tenancy — scoped non-superuser role, tenant resolved from a **live lease** | **Accepted 2026-09-12** — with the Phase 1A addendum; the original pure-GUC design is superseded | **Very high** — it is the mechanism ADR 0002 depends on |
| [0013](adr/0013-pipeline-stages-are-configuration.md) | Pipeline stages are tenant configuration, not schema semantics | **Accepted** (owner, Q4) | Low **now**, high once migrated — which is why it was done before the first migration |
| [0014](adr/0014-inbound-email-ledger-keys-on-recipient-email.md) | The inbound-email ledger keys on `(message_id, recipient_email)`, not `recipient_contact_id` | **Accepted** | Low — one table, one unique index |
| [0015](adr/0015-company-os-domain-core.md) | Company OS domain core — companies, departments, agents, tasks and events in `ops`; composite-key integrity; backend-only SECURITY INVOKER services; lifecycle events derived by triggers; a task→job bridge with an empty allowlist | **Accepted 2026-09-13** — with the owner addendum: tenant is the only isolation boundary, businesses needing independent data isolation are separate tenants, global monotonic identifiers (`events.seq`, `job_events.id`, any future sequence) internal only, minimised event payloads, neither `postgres` (the database owner) nor `service_role` is ever an ordinary agent or worker identity | High — the organisational model every agent will operate on |

### What changed in the reconciliation

- **0002 carried a false claim** and it was load-bearing: *"The engine is unreachable from any browser by construction."* The PostgREST allowlist governs one channel; the MCP function holds a direct libpq ~~**superuser**~~ `postgres` connection *(corrected 2026-09-13: `rolsuper=false`, `rolbypassrls=true`)* that ignores it. The claim is retracted in place, narrowed to "unreachable *through PostgREST*", and the second channel is now governed by 0011. Its RLS-helper guidance was also wrong for the engine (`auth.uid()`-based, and the worker has no JWT) and now points at 0012. **0002 cannot be accepted until 0012 is.** *(2026-09-13: 0012 is accepted, so that precondition is met. 0002 now waits on the MCP channel: ADR 0011 item 4 discharged, and a test through that channel; see its 2026-09-13 addendum.)* *(Later 2026-09-13: the MCP channel is closed; 0002 now waits on a test of the `merge_contacts` owner-session pool and on CI.)* *(Final 2026-09-13: the owner-session pool is measured unable to reach `ops`, and 0002 is accepted.)*
- **Nothing was marked `Accepted` on architectural merit alone.** 0011 and 0013 are `Accepted` because the owner decided them verbatim in the Phase 0.5 brief (Q12, Q4); 0007 was delegated earlier. Everything else stays `Proposed`.
- **0012 is `Accepted` as of 2026-09-12**, and what was accepted matters: the owner accepted the **Phase 1A addendum**, not the ADR as originally written. Tenancy is bound to a live lease, not to a GUC the worker writes — measured, a worker can set any GUC, so the original item 4 would have made "which tenant am I" an assertion by the worker. A Phase 1B addendum then corrected the transaction boundary: the lease commits on its own, because a single-transaction lease leaves a crashed worker no trace and makes a crashing job a poison pill.
- **No ADR is `Superseded` or `Rejected`.** Recorded explicitly so the absence reads as a finding rather than an oversight.

## How to use this

- Read the relevant ADR **before** changing anything it covers.
- To reverse one, write a new ADR that supersedes it. Do not edit the original except to set `Status: Superseded by NNNN` — or, as with 0002, to strike a claim that is demonstrably false, in place and dated.
- Anything structural — a new pattern, a new dependency, a deliberate departure from convention, a non-obvious schema choice — gets an ADR. Naming and file-layout micro-choices do not.

## Decisions deliberately NOT made yet

These are recorded so they are not settled by accident:

- **Where does engine code live?** No `apps/`/`packages/`/`services/` exists, so the `ra-core` boundary ADR 0005 requires to be *mechanical* is currently a convention (Q13). Options and a recommendation: [proposals/0001-repository-structure.md](proposals/0001-repository-structure.md). **No migration in Phase 0.5.**
- **Does the MCP function survive at all, and when is it removed or downgraded?** 0011 constrains it; it does not decide its fate. It must be settled **before `ops` exists**. *(2026-09-13: **not settled before `ops` existed.** `ops` was created in Phase 1A while the function kept its `postgres` pool and stayed in `deploy.yml`. ADR 0011 item 4 is undischarged, and it now blocks accepting ADR 0002.)* **Decided 2026-09-13 (owner):** it does not survive as a production channel. The function is removed, `scripts/production-scope.mjs` keeps it out of the committed deploy paths (SI-03), and the future interface is an explicit Tool Gateway with allowlisted operations.
- **Is inbound email (Postmark) in scope?** The only untrusted external channel currently reaching the database.
- **Documentation and UI language**, and where tenant vocabulary lives (`docs/project-context.json` does not exist yet).
- **Must the engine be emulated by the FakeRest provider?** This roughly doubles or halves the cost of every engine table.
- **Multi-tenant LGPD scope** — per-tenant legal basis, retention, DPA/DPIA, and whether the platform operator becomes a processor for its tenants. *(2026-09-13: still open. ADR 0015's owner addendum bears on it (businesses needing independent data isolation are separate tenants, and minimised event payloads), but per-tenant legal basis, retention, DPA/DPIA and the processor role remain undecided.)*
- **How does a hosted tenant get its loss reasons?** *(added 2026-09-13, owner)* Loss reasons are tenant vocabulary (CLAUDE.md rule 2, ADR 0013), so no migration creates them. A hosted project has none until an explicit onboarding path provisions a tenant's own, and until then a hosted deal cannot be marked lost. Global reference data a production database needs, such as `favicons_excluded_domains`, ships in migrations (20260913120000).

~~Is the psychology pipeline tenant configuration or engine schema?~~ ✅ Decided — ADR 0013.
~~How does the worker obtain tenant context?~~ ✅ Decided — ADR 0012, accepted 2026-09-12: the tenant is resolved from a live lease.

See [BASELINE_REPORT.md §13](BASELINE_REPORT.md#13-open-questions) for the full list with evidence.
