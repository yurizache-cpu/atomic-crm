# Architecture Decision Records

Index of ADRs under [`docs/adr/`](adr/). Each records context, decision, alternatives and consequences, so that a future session does not casually reverse a deliberate choice.

**Reconciled 2026-09-11 (Phase 0.5, Workstream K).** Every record was re-read against the implementation. One contained a materially false security claim and has been corrected; three decisions the owner made in the Phase 0.5 brief are now `Accepted`; the rest remain `Proposed` and still await approval.

> 🔴 **Approving the remainder is a scheduled task, not a formality.** ADRs 0001 and 0002 carry *very high* reversal cost and are implemented in Phases 2 and 3. Building on an unapproved ADR converts a reversible choice into an accident.

| # | Decision | Status | Reversal cost |
| --- | --- | --- | --- |
| [0001](adr/0001-runtime-execution-substrate.md) | Runtime execution substrate — Postgres queue + always-on worker | Proposed | **Very high** — rewrites every tool call |
| [0002](adr/0002-tenancy-model.md) | Tenancy — `tenant_id` + RLS in a new `ops` schema, off the PostgREST allowlist | Proposed ⚠️ **corrected** | **Very high** — retrofitting tenancy touches everything |
| [0003](adr/0003-identifier-strategy.md) | UUID engine PKs; no FK into `public.*` | Proposed | High — one bigint FK welds the CRM to the core |
| [0004](adr/0004-principal-model.md) | Engine-owned `principals` (human / agent / service) | Proposed | High — determines whether agent actions are auditable at all |
| [0005](adr/0005-ra-core-boundary.md) | `ra-core` never crosses into the engine | Proposed | High — unwinding `RaRecord` later is a full rewrite |
| [0006](adr/0006-declarative-schema-workflow.md) | Make the declarative schema workflow actually wired | Proposed | Low to fix now, **catastrophic to leave** |
| [0007](adr/0007-launcher-relationship.md) | Company OS supersedes the chat-service launcher; its config is inert dev tooling | **Accepted** | Low — re-integrating later is additive |
| [0008](adr/0008-fork-posture.md) | Hard-fork; stop publishing the registry | Proposed | Medium — cherry-picking upstream fixes becomes manual |
| [0009](adr/0009-governance-envelope.md) | Governance envelope — risk as data, fail-closed default, confidence escalates but never skips review | Proposed | High — a gate retrofitted after agents act is a gate nobody trusts |
| [0010](adr/0010-cost-control-and-kill-switch.md) | Cost ledger in-transaction, per-agent budgets, **fleet-wide kill switch** (scopes + semantics added in Phase 0.5) | Proposed | Low to build now, **unbounded to omit** |
| [0011](adr/0011-mcp-trust-boundary.md) | The MCP function is **not** part of the production trust boundary; no agent gets arbitrary SQL | **Accepted** (owner, Q12) | Low — it constrains a component rather than shaping the engine |
| [0012](adr/0012-worker-tenant-context.md) | Worker tenancy — scoped non-superuser role + transaction-local `app.tenant_id` GUC | Proposed — **mechanism verified 2026-09-11**, integration unbuilt | **Very high** — it is the mechanism ADR 0002 depends on |
| [0013](adr/0013-pipeline-stages-are-configuration.md) | Pipeline stages are tenant configuration, not schema semantics | **Accepted** (owner, Q4) | Low **now**, high once migrated — which is why it was done before the first migration |
| [0014](adr/0014-inbound-email-ledger-keys-on-recipient-email.md) | The inbound-email ledger keys on `(message_id, recipient_email)`, not `recipient_contact_id` | **Accepted** | Low — one table, one unique index |

### What changed in the reconciliation

- **0002 carried a false claim** and it was load-bearing: *"The engine is unreachable from any browser by construction."* The PostgREST allowlist governs one channel; the MCP function holds a direct libpq **superuser** connection that ignores it. The claim is retracted in place, narrowed to "unreachable *through PostgREST*", and the second channel is now governed by 0011. Its RLS-helper guidance was also wrong for the engine (`auth.uid()`-based, and the worker has no JWT) and now points at 0012. **0002 cannot be accepted until 0012 is.**
- **Nothing was marked `Accepted` on architectural merit alone.** 0011 and 0013 are `Accepted` because the owner decided them verbatim in the Phase 0.5 brief (Q12, Q4); 0007 was delegated earlier. Everything else stays `Proposed`.
- **0012 is `Proposed`, not `Accepted`**, deliberately: the owner decided the *principle* (`auth.uid()` tenancy is unacceptable for workers), but the *mechanism* — scoped role plus transaction-local GUC — is this document's proposal and carries very high reversal cost.
- **No ADR is `Superseded` or `Rejected`.** Recorded explicitly so the absence reads as a finding rather than an oversight.

## How to use this

- Read the relevant ADR **before** changing anything it covers.
- To reverse one, write a new ADR that supersedes it. Do not edit the original except to set `Status: Superseded by NNNN` — or, as with 0002, to strike a claim that is demonstrably false, in place and dated.
- Anything structural — a new pattern, a new dependency, a deliberate departure from convention, a non-obvious schema choice — gets an ADR. Naming and file-layout micro-choices do not.

## Decisions deliberately NOT made yet

These are recorded so they are not settled by accident:

- **Where does engine code live?** No `apps/`/`packages/`/`services/` exists, so the `ra-core` boundary ADR 0005 requires to be *mechanical* is currently a convention (Q13). Options and a recommendation: [proposals/0001-repository-structure.md](proposals/0001-repository-structure.md). **No migration in Phase 0.5.**
- **Does the MCP function survive at all, and when is it removed or downgraded?** 0011 constrains it; it does not decide its fate. It must be settled **before `ops` exists**.
- **Is inbound email (Postmark) in scope?** The only untrusted external channel currently reaching the database.
- **Documentation and UI language**, and where tenant vocabulary lives (`docs/project-context.json` does not exist yet).
- **Must the engine be emulated by the FakeRest provider?** This roughly doubles or halves the cost of every engine table.
- **Multi-tenant LGPD scope** — per-tenant legal basis, retention, DPA/DPIA, and whether the platform operator becomes a processor for its tenants.

~~Is the psychology pipeline tenant configuration or engine schema?~~ ✅ Decided — ADR 0013.
~~How does the worker obtain tenant context?~~ ✅ Principle decided, mechanism proposed — ADR 0012.

See [BASELINE_REPORT.md §13](BASELINE_REPORT.md#13-open-questions) for the full list with evidence.
