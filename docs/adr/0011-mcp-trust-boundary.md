# ADR 0011 — The MCP function is not part of the production trust boundary

**Status:** **Accepted** · **Date:** 2026-09-11
**Decided by:** owner, Phase 0.5 brief (Q12)

## Context

`supabase/functions/mcp/index.ts` exposes two tools — `query` (arbitrary SELECT) and `mutate` (arbitrary INSERT/UPDATE/DELETE) — to any holder of a signature-valid Supabase JWT. Verified properties of the current implementation:

- The pool connects with `SUPABASE_DB_URL`, defaulting to `postgresql://postgres:postgres@db:5432/postgres` — **superuser** (`index.ts:22-25`).
- `query`/`mutate` downgrade to `authenticated` per transaction via `set_config('role', …, true)`, so RLS *is* enforced on those two paths. `get_schema` does **not** downgrade, and returns the full public schema map on the raw connection.
- `jwtVerify` is called with `{ issuer }` and no audience check, so any token this project issued is accepted.
- The read-only gate was bypassable: a CTE attached to DML (`WITH x AS (SELECT 1) DELETE FROM contacts`) collected `{with, select}` and passed. **Reproduced 2026-09-11**; fixed in the same change as this ADR.
- A plain `SELECT extensions.http_get(…)` is a legal read-only statement, giving outbound HTTP from inside the database — an SSRF/exfiltration path that no amount of RLS constrains.

The consequence that forces this decision: [ADR 0002](0002-tenancy-model.md) claimed the engine would be "unreachable from any browser by construction" because `ops` is off the PostgREST allowlist. A raw libpq superuser connection makes that claim false. One component therefore invalidates the isolation story of the whole platform.

## Decision

**The MCP function as it exists is development/admin tooling. It is explicitly NOT part of the production trust boundary, and no production browser, end user, or AI agent may reach arbitrary SQL through it.**

Concretely, for Phase 0.5:

1. **Defence in depth on the read path, immediately.** `query` now runs its transaction under `SET TRANSACTION READ ONLY`, so Postgres itself rejects every write regardless of what the validator allowed. The AST validator is a second layer, not the only barrier — a validator bug must not be a write primitive. *(Implemented.)*
2. **The AST validator walks both halves of a `WITH`** — the CTE bindings and the statement the `WITH` is attached to — and fails closed on any node shape it does not recognise. *(Implemented, with adversarial tests.)*
3. **No AI agent receives arbitrary SQL execution.** This is a standing rule, not a configuration: agents get typed, explicit tools. Arbitrary SQL is the largest blast radius in the system and is structurally incompatible with a replaceable CRM adapter.
4. **`ops` must not exist while this function can reach it unrestricted.** Before the engine schema lands, the function is removed, restricted to a non-superuser role that has no rights on `ops`, or gated to non-production environments.

## Alternatives

- **Keep it and rely on the validator.** Rejected. It makes an application-level parser the only thing between a caller and the data, which violates the project's own principle that a boundary enforced in one layer of application code is not a boundary.
- **Delete it now.** Not chosen for Phase 0.5 only because it is genuinely useful development tooling and removing it is not required to close the holes found. The decision above constrains it; a later phase may still delete it.
- **Build the full Tool Gateway now.** Out of scope: it is Phase-1 engine work, and the remediation above does not need it.

## Consequences

- ADR 0002's isolation claim is narrowed to "unreachable through PostgREST" and its test obligation doubles: both channels must be exercised.
- The long-term direction is a **Tool Gateway** — explicit operations, least privilege, tenant scope, permission checks, risk classification, approval policy, audit log, structured inputs, and no arbitrary SQL. This ADR does not build it; it records that arbitrary SQL is not the interface agents get.
- `SET TRANSACTION READ ONLY` does **not** constrain side effects that are not database writes. A network-capable function called from a SELECT is stopped by revoking EXECUTE, not here — see the extensions hardening in `06_grants.sql`.
- Outstanding and not fixed by this ADR: the missing audience check on `jwtVerify`, `get_schema` running without a role downgrade, `x-forwarded-host` trusted when building OAuth metadata, and full SQL statements (with personal data) logged verbatim.
