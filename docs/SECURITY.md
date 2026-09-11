# Security

**Date:** 2026-09-11 (Phase 0.5). **Scope:** the fork as it exists — an Atomic CRM instance plus a harness. No engine, no agents, no integrations beyond inbound email.

This document describes the **actual** posture, including what is still open. It is not an aspiration; where something is designed but not built, it says so.

---

## 1. Principles

These are enforcement rules, not preferences. Each one exists because this repository violated it at least once.

1. **Anything enforced only by an LLM prompt is not a security boundary.** A model asked to behave is not a control.
2. **Anything enforced only by frontend code is not a security boundary.** The frontend hides menus; it does not protect data.
3. **Unknown operations fail closed.** An action nobody classified is denied, not allowed. `canAccess` used to end in `return true`; that is the shape to never ship again.
4. **External content is untrusted.** A WhatsApp message, an email, a CRM note or a web page may contain instructions. It is data, always.
5. **SQL execution is privileged.** Arbitrary SQL is the largest blast radius in the system and is not an agent capability.
6. **Browser automation is privileged.** Same reasoning; it inherits every authenticated session it can reach.
7. **Cross-tenant access is structurally prevented** — by the database, not by a `WHERE` clause someone has to remember.
8. **Autonomous actions are auditable.** Who, what, when, why, which tool, which evidence, what cost, what result.
9. **Destructive actions require explicit policy.**
10. **Secrets never enter model context** unless strictly necessary.

**Defence in depth is required, not preferred.** A single validator, however good, is one bug away from being no validator.

---

## 2. Trust boundaries

| Boundary | Enforced by | State |
| --- | --- | --- |
| Browser → `public.*` | PostgREST + RLS policies | In place; RLS rewritten to per-`sales_id` scoping, **unmigrated** |
| Browser → engine (`ops.*`) | Schema left out of the PostgREST allowlist | Designed ([ADR 0002](adr/0002-tenancy-model.md)); `ops` does not exist yet |
| MCP function → database | A superuser pool, downgraded per transaction | **Not a production trust boundary** — see [ADR 0011](adr/0011-mcp-trust-boundary.md) |
| Worker → tenant data | Scoped role + transaction-local GUC | Designed only ([ADR 0012](adr/0012-worker-tenant-context.md)); no worker exists |
| Frontend resource gating | `canAccess` | Deny-by-default since Phase 0.5; **UX only, never the boundary** |

The load-bearing correction of Phase 0.5: ADR 0002 claimed the engine would be "unreachable from any browser by construction". That was **false** — the MCP function holds a direct libpq superuser connection that ignores the PostgREST allowlist entirely. The claim is now narrowed to "unreachable *through PostgREST*", and the second channel is governed by ADR 0011.

---

## 3. What Phase 0.5 closed

### Arbitrary SQL (`validateSql`)

- **Was:** `WITH x AS (SELECT 1) DELETE FROM contacts` passed the read-only gate. The classifier walked a `WITH` node's CTE bindings but never the statement the `WITH` was attached to, so the collected types were `{with, select}`. **Reproduced against the pinned parser before changing anything.**
- **Now, two independent layers:**
  1. **Database-level.** `query` runs its transaction under `SET TRANSACTION READ ONLY`. Postgres itself rejects every write, so a validator bug is no longer a write primitive. The `readOnly` parameter **defaults to true**, so a future call site that forgets to declare intent gets the restrictive mode.
  2. **AST-level.** The classifier recurses into both halves of a `WITH` and caps recursion depth; unrecognised node shapes contribute their own type and therefore land outside the allow-list — it fails closed by construction.
- **Tests:** 7 adversarial cases (CTE attached to DELETE/UPDATE/INSERT, schema-qualified, nested, comment/whitespace-split, with RETURNING). Verified by mutation: reverting the fix fails exactly those 7.

### Frontend authorization (`canAccess`)

Inverted from a deny-list ending in `return true` to an explicit allow-list. Unknown resource → denied, for every action and every role. 24 tests, including every future engine resource name (`ops_agents`, `ops_audit_log`, …) which the old code allowed. **This is a UX gate, not a security boundary** — RLS is.

### Storage

The `attachments` bucket was documented as closed and was **open in every migrated database**. `07_storage.sql` expresses the intent as DML, which `db diff` can never emit. Fixed with a hand-written migration that closes the bucket, drops the three blanket `authenticated` policies, and **asserts the end state**, so a `db reset` fails loudly if it is ever reopened.

### Harness gates (fail-open → enforced)

- `validate-on-stop` **validated nothing on Windows** — its worktree filter compared git-reported POSIX paths against `join()`-built ones and matched nothing, which the caller read as "nothing to validate".
- `cleanup-worktree` **deleted live worktrees with uncommitted work**, because the guard in front of a recursive `rmSync` failed the same way.
- `restrict-documentator-write` degenerated to deny-everything (fails safe, but broke the agent).
- `check-config-sync` and `pending-deploys` never executed their CLI block, so the config-sync gate and the orchestrator's migration gate **exited 0 without running**.
- The `claude` test project now runs in CI — it never did, which is how all of the above shipped.

---

## 4. Known-open risks

Ranked by what an attacker or an accident reaches first.

| Risk | Status |
| --- | --- |
| **`SELECT extensions.http_get(…)`** — SSRF/exfiltration from inside the database via a legal read-only statement. `SET TRANSACTION READ ONLY` does not stop it (it is not a database write). | Workstream D; needs `REVOKE EXECUTE` and a live database to verify |
| **`merge_contacts` destroys `do_not_contact`** and all acquisition attribution — the new FKs cascade and the function re-points only `tasks` and `contact_notes`. LGPD-relevant. | Workstream E |
| **Postmark webhook returns 200 on every ingestion failure** — no retry, no durable record, silent data loss. | Workstream F |
| **MCP `jwtVerify` has no audience check** — any token this project issued is accepted (confused deputy). | Open |
| **MCP `get_schema` runs without the role downgrade** on the superuser connection. | Open |
| **MCP logs full SQL statements** including names, emails and note text — an uncontrolled secondary store of personal data under LGPD. | Open |
| **`x-forwarded-host` is trusted** when building OAuth metadata and the 401 challenge. | Open |
| **Secrets are committed by design** — `.gitignore` un-ignores `supabase/functions/.env`; an EC private signing key is tracked in `supabase/signing_keys.json`; `.env.development` and `.env.e2e` match no ignore pattern at all. | Open; needs rotation, which is its own change |
| **`delete_note_attachments`** lets any authenticated user delete any file via the service role. | Open |
| **`users`/`patchUser` ordering** mutates auth email and ban state before the owner check. | Open |
| **Two contradictory auth models** — `schemas/` has an unreachable owner bootstrap; `migrations/` makes the first signup an administrator. | Open |
| **No secret scanning** anywhere in CI or the local loop. | Open |

---

## 5. Threat model for what comes next

When agents exist, the assumptions change. Recorded now so the design accounts for them:

- **An agent is an untrusted caller with credentials.** It may be steered by content it reads. Every capability it holds must be enforced outside it.
- **Prompt injection is an expected input, not an incident.** A CRM note or an inbound email is attacker-controlled text that an agent will read.
- **The blast radius of a tool is its worst call, not its intended one.** Arbitrary SQL and unrestricted browser automation both fail that test, which is why neither is an agent capability.
- **Cost is a safety property.** Unbounded spend is an availability incident; see the kill switch in [ADR 0010](adr/0010-cost-control-and-kill-switch.md).

---

## 6. Verification status

Everything above that touches the database is **unverified**, because Docker is not running in this environment. Specifically unproven: the RLS policies, the grants, the storage assertion, and any claim about what a migrated database actually contains. See the BLOCKED section of [PHASE_0_5_REPORT.md](PHASE_0_5_REPORT.md).

Application-layer and harness claims **are** verified by tests that run today.
