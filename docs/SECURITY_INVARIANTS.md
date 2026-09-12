# Security invariants

**The executable list is [`supabase/tests/securityInvariants.test.ts`](../supabase/tests/securityInvariants.test.ts). This document is its index, and a test fails if the two drift.**

Read this before changing anything under `supabase/`, `src/components/atomic-crm/providers/`, or the MCP function. Each row names a property the system must hold and the guard that actually proves it — not a guideline.

---

## The rule that produced most of the others

> **DECLARATIVE SCHEMA != automatically trusted migration output.**

`supabase/schemas/*.sql` is a declaration of intent. `supabase db diff` turns it into a migration, and the migration is what reaches a database — **they are not the same thing, and the difference has been a live security hole three times**:

| Declared in the schema | Emitted by `db diff`? | What happened |
| --- | --- | --- |
| `with (security_invoker = on)` on views | **No** — reloptions are never emitted | Two views were recreated as owner-executing, and `anon` could read every contact record over plain HTTP |
| `alter default privileges … revoke … from anon` | **No** — not DDL it can emit | Three new tables were born with `GRANT ALL TO anon` |
| `update storage.buckets set public = false` | **No** — DML | The attachments bucket stayed public in every migrated database |

Every generated migration is reviewed before it is accepted. Run `supabase db diff` deliberately, read every statement, and add a hand-written migration for anything the generator cannot express — with a `raise exception` block asserting its own end state, because a migration that silently no-ops is worse than none: it looks applied.

**The current `db diff` output is not empty and must not be applied unreviewed.** It emits `create extension pg_net` and recreates three views without `security_invoker` — regressing SI-01 and SI-02 together.

---

## The invariants

| ID | Invariant | Proven by | Enforced in |
| --- | --- | --- | --- |
| SI-01 | Every view an application role can read applies the caller's RLS (security_invoker = on). | live database, migration assertion | `supabase/tests/rls_tenant_isolation.sql`, `migrations/20260911235000_…` |
| SI-02 | pg_net is absent. Its functions are granted to anon by supabase_admin and cannot be revoked by this project, so its presence alone is the failure. | live database, migration assertion | `supabase/tests/rls_tenant_isolation.sql`, `migrations/20260911235500_drop_pg_net.sql` |
| SI-03 | Arbitrary SQL is not a capability any agent receives. The MCP query/mutate path is development tooling, explicitly outside the production trust boundary. | unit test | [ADR 0011](adr/0011-mcp-trust-boundary.md), `supabase/functions/mcp/validateSql.test.ts` |
| SI-04 | Permission checks deny by default: an unknown resource is refused, never allowed. | unit test | `providers/commons/canAccess.ts` + its 24 tests |
| SI-05 | Missing tenant context reads zero rows, never all rows — for an absent JWT, an unknown user, a disabled user, and an unset worker GUC. | live database | `rls_tenant_isolation.sql`, `worker_tenant_context.sql` |
| SI-06 | service_role is a full RLS bypass and must not be the ordinary worker identity. The same applies to postgres, which also carries BYPASSRLS on Supabase. | live database | both database suites (asserted as a **capability**, not a protection) |
| SI-07 | The SQL read path is read-only in the database itself, not only in the parser. | unit test | `supabase/functions/mcp/index.ts` (`SET TRANSACTION READ ONLY`) |
| SI-08 | The attachments storage bucket is private. | migration assertion | `migrations/20260911120000_close_attachments_bucket.sql` |
| SI-09 | Merging contacts is conservative about consent: if either side opted out, the merged contact is opted out. Never winner-wins. | unit test | `merge_contacts/mergeLeadProfile.ts` + 12 tests |
| SI-10 | Inbound email ingestion is idempotent and fails closed: no unconditional 200, a durable record for every failure, and a synthetic key never reaches the ingest path. | unit test, migration assertion | `postmark/ingestionOutcome.ts`, `migrations/20260912090000_inbound_email_ledger.sql` |
| SI-11 | anon holds no privilege on any table or view in public, and authenticated holds no TRUNCATE, TRIGGER or REFERENCES anywhere. | live database, migration assertion | `rls_tenant_isolation.sql`, `migrations/20260911235000_…` |
| SI-12 | The declarative schema is not an automatically trusted migration. Generated output must be reviewed, and a generated migration that regresses security is rejected. | static guard | `supabase/tests/migrationInvariants.test.ts` + `supabase/invariants/` — replays every migration in order, with no Docker, and rejects a diff that regresses SI-01 / SI-02 / SI-11 |
| SI-13 | The engine worker holds no write verb anywhere in ops and no BYPASSRLS. Every job state transition goes through a SECURITY DEFINER function that verifies the lease first. | live database, migration assertion, static guard | `ops_execution_core.sql`, `migrations/20260912120000_…`, `invariants/parse.mjs` |
| SI-14 | Tenant context is derived from a live lease, never asserted by the worker, and dies with the transaction that holds it. | live database | `ops_execution_core.sql` (forgery cases + the COMMIT-leakage case), `engine/worker/runOneJob.ts` |
| SI-15 | The ops schema is unreachable by anon and authenticated, and is absent from the PostgREST allowlist. | migration assertion, static guard | `migrations/20260912120000_…`, `supabase/config.toml` |
| SI-16 | The worker PROCESS refuses to start unless its database identity is a non-superuser, non-BYPASSRLS role that can assume ops_worker. | live database, unit test | `engine/db/workerIdentity.ts`, `engine/worker/main.ts`, `scripts/provision-worker-role.mjs`, `pooling.dbtest.ts` |
| SI-17 | An unknown job kind fails closed and permanently. The runtime never dispatches on a name a payload supplies, and never loads code from one. | unit test, live database | `engine/worker/handlerRegistry.ts`, `handlerRegistry.test.ts`, `workerRuntime.dbtest.ts` |
| SI-18 | A capability reaching from ops into public takes its tenant from the live lease, refuses any tenant that does not own this deployment's CRM, and clamps its parameters to a hard floor. | live database, migration assertion | `migrations/20260912160000_…`, `engine/worker/capabilities.ts`, `workerRuntime.dbtest.ts` |
| SI-19 | No CRM record data (contacts, notes, lead profiles, email addresses, consent state) is written to durable browser storage. The React Query cache lives in memory only, a cache persisted by an earlier build is purged at startup, and logout clears it. | unit test | `root/CRM.security.test.tsx` (real `<CRM>` root, mobile and desktop trees), `authProvider.security.test.ts`, `eslint.config.js` (persister imports banned) |
| SI-20 | The committed development JWT signing key never leaves local tooling: no other tracked file carries its private or public component, only local and test configuration names it, every GitHub Pages publish scans what it ships, and every push to Supabase in deploy.yml or the makefile is preceded by a blocking check that refuses a project trusting the key. | static guard, unit test | `scripts/dev-signing-key.mjs` + its tests, `scripts/publish-pages.mjs`, `scripts/scan-build-artifacts.mjs`, `deploy.yml` and `makefile` (key check before every push) |

---

## Caveats that matter more than the table

- **SI-06 is an ACCEPTED RISK, not a satisfied invariant.** The edge functions run as `service_role` today. Both database suites assert that bypass **explicitly**, so a green RLS run can never be mistaken for worker isolation. Closing it is [ADR 0012](adr/0012-worker-tenant-context.md)'s integration work, and that ADR is still **Proposed**.
- **SI-11: RLS does not gate `TRUNCATE`.** Measured: as `anon`, `truncate public.lead_profiles` took it from 2 rows to 0 while every SELECT policy was in force. A grant is not made safe by RLS.
- **SI-02 is irreversible in one direction.** Reinstalling `pg_net` re-grants `anon` and `authenticated`, and no privilege change this project can make will close it again — the `net` schema is owned by `supabase_admin`, and only a grantor may revoke. Removal was the only containment available.
- **SI-14 is bounded, and the bound matters.** GUCs are readable and writable by any role, so no GUC-transport design is unforgeable against a fully malicious worker *process*; against one, the bound is `ops_worker`'s grants. What binding tenancy to a live lease *does* defend against is a worker bug that forgets the context, a worker that takes the tenant from the **payload**, and — from Phase 1B — LLM output reaching the tenant decision. The payload is the untrusted surface; tenancy is now unreachable from it.
- **SI-13 and SI-15 do not make the worker trusted.** They make it *small*: it reads, it calls three lease-checking functions, and it can reach nothing in `public`.
- **SI-16 is why a deployment mistake is loud.** `ops_worker` is NOLOGIN and carries no credential, so a real deployment must create a login role (`scripts/provision-worker-role.mjs`). That role is NOINHERIT and holds nothing directly: it reaches every privilege by assuming `ops_worker` for one transaction. Delete that `set local role` and the worker fails with "permission denied for schema ops" instead of quietly running with whatever the login role happened to carry.
- **SI-18 is the shape every later capability must copy.** The handler receives a capability, never a database client — it cannot name the rows, cannot choose the tenant, and cannot widen the window. This is the earliest form of the Tool Gateway; it is deliberately not that yet.
- **SI-03 is a decision, not a mechanism.** The AST validator and `SET TRANSACTION READ ONLY` are defence in depth. The actual boundary is not handing a model raw SQL.
- **SI-19 removed a feature, not just a leak.** Upstream's mobile "offline mode" was a React Query persister writing every viewed record to `localStorage` for 24 hours. No product document for this tenant asks for offline access, so it was removed rather than allow-listed. A screen already open still survives a dropped connection; nothing survives the tab. The legacy key is purged at startup because nothing else would ever expire it. **Not covered:** list filters the user types (ra-core's store keeps them until logout, SEC-1BS-13), and a cache someone might add inside the Supabase provider, which the storage test does not render.
- **SI-20 makes the publish scan, rather than checking that a scan runs.** Its first shape checked that a CI step scanned before each publish, and an adversarial review broke it within the hour: `make`, npm scripts, `--dist` and Pages actions all published unscanned. Every GitHub Pages publish now goes through `scripts/publish-pages.mjs`, and any other invocation of gh-pages is a violation.
- **SI-20 cannot see the dashboard.** No Supabase CLI command uploads signing keys, so the only way a hosted project comes to trust the development key is a person importing it. The repository rules cannot observe that; the deploy-time check asks the project's own JWKS endpoint instead, for the same ref `supabase link` uses, and treats "could not ask" as a failure. It runs per deploy, not continuously.

---

## Running the guards

```bash
npx vitest run --config vitest.config.ts   # static guards + unit tests, no Docker
npm run test:db                            # live-database suites; FAILS if no database is reachable
```

`npm run test:db` deliberately fails rather than skipping when it cannot connect. A security suite that did not run has verified nothing, and a skip reads as a pass in every CI summary.

## Adding an invariant

Add it to `supabase/tests/securityInvariants.test.ts` **first** — that file is the source of truth — then add the row here. Point it at a guard that actually runs. The test fails if an enforcement point is missing, if its assertion has been renamed away, or if this document and the code disagree.
