# ADR 0004 — What is a principal

**Status:** Proposed · **Date:** 2026-09-10

## Context

`sales.user_id uuid not null` has a unique FK to `auth.users`. Every ownership column in the schema is `sales_id`. Roles are a two-value CHECK (`owner`, `operator`) plus `administrator` and `disabled` booleans; `is_admin()` requires `administrator AND role = 'owner' AND NOT disabled`. There is no non-human actor concept anywhere in the system.

## Decision

**An engine-owned `ops.principals` table with `kind in ('human','agent','service')`.** A `sales` row is created for an agent only when it must act *through* the CRM adapter, and that mapping is recorded explicitly.

## Alternatives

- **Agents as `sales` rows with real `auth.users` accounts.** Fits existing RLS with no new plumbing, but pollutes the human directory, inherits the two-value role CHECK, and makes "agent X acted on behalf of human Y" inexpressible.
- **Agents as a magic string in an actor column.** Rejected: unauditable.

## Consequences

- Delegation is first-class: audit rows record actor, on-behalf-of, and the authority relied on.
- An agent is **configuration + policy**, never a running process. When work exists an `agent_run` is created; when idle it costs nothing.
- Per-agent permissions, autonomy level, budget and memory policy hang off `principals`.
