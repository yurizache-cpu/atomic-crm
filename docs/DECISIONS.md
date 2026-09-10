# Architecture Decision Records

Index of ADRs under [`docs/adr/`](adr/). Each records context, decision, alternatives and consequences, so that a future session does not casually reverse a deliberate choice.

**All records below are `Proposed` and await owner approval, except 0007 which is `OPEN` and blocked on the owner.** Nothing here has been implemented.

| # | Decision | Status | Reversal cost |
| --- | --- | --- | --- |
| [0001](adr/0001-runtime-execution-substrate.md) | Runtime execution substrate — Postgres queue + always-on worker | Proposed | **Very high** — rewrites every tool call |
| [0002](adr/0002-tenancy-model.md) | Tenancy — `tenant_id` + RLS in a new `ops` schema, off the PostgREST allowlist | Proposed | **Very high** — retrofitting tenancy touches everything |
| [0003](adr/0003-identifier-strategy.md) | UUID engine PKs; no FK into `public.*` | Proposed | High — one bigint FK welds the CRM to the core |
| [0004](adr/0004-principal-model.md) | Engine-owned `principals` (human / agent / service) | Proposed | High — determines whether agent actions are auditable at all |
| [0005](adr/0005-ra-core-boundary.md) | `ra-core` never crosses into the engine | Proposed | High — unwinding `RaRecord` later is a full rewrite |
| [0006](adr/0006-declarative-schema-workflow.md) | Make the declarative schema workflow actually wired | Proposed | Low to fix now, **catastrophic to leave** |
| [0007](adr/0007-launcher-relationship.md) | Company OS supersedes the chat-service launcher; its config is inert dev tooling | **Accepted** | Low — re-integrating later is additive |
| [0008](adr/0008-fork-posture.md) | Hard-fork; stop publishing the registry | Proposed | Medium — cherry-picking upstream fixes becomes manual |

## How to use this

- Read the relevant ADR **before** changing anything it covers.
- To reverse one, write a new ADR that supersedes it. Do not edit the original except to set `Status: Superseded by NNNN`.
- Anything structural — a new pattern, a new dependency, a deliberate departure from convention, a non-obvious schema choice — gets an ADR. Naming and file-layout micro-choices do not.

## Decisions deliberately NOT made yet

These are recorded so they are not settled by accident:

- **Is the psychology pipeline tenant configuration or engine schema?** Today it is a nine-value CHECK constraint on the shared `deals` table.
- **Do the MCP `query` / `mutate` arbitrary-SQL tools survive?** They are the fastest agent-to-data path and the largest blast radius, and they are structurally incompatible with a replaceable CRM.
- **Is inbound email (Postmark) in scope?** The only untrusted external channel currently reaching the database.
- **Documentation and UI language**, and where tenant vocabulary lives (`docs/project-context.json` does not exist yet).
- **Must the engine be emulated by the FakeRest provider?** This roughly doubles or halves the cost of every engine table.

See [BASELINE_REPORT.md §13](BASELINE_REPORT.md#13-open-questions) for the full list with evidence.
