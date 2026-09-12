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

---

## Caveats that matter more than the table

- **SI-06 is an ACCEPTED RISK, not a satisfied invariant.** The edge functions run as `service_role` today. Both database suites assert that bypass **explicitly**, so a green RLS run can never be mistaken for worker isolation. Closing it is [ADR 0012](adr/0012-worker-tenant-context.md)'s integration work, and that ADR is still **Proposed**.
- **SI-11: RLS does not gate `TRUNCATE`.** Measured: as `anon`, `truncate public.lead_profiles` took it from 2 rows to 0 while every SELECT policy was in force. A grant is not made safe by RLS.
- **SI-02 is irreversible in one direction.** Reinstalling `pg_net` re-grants `anon` and `authenticated`, and no privilege change this project can make will close it again — the `net` schema is owned by `supabase_admin`, and only a grantor may revoke. Removal was the only containment available.
- **SI-03 is a decision, not a mechanism.** The AST validator and `SET TRANSACTION READ ONLY` are defence in depth. The actual boundary is not handing a model raw SQL.

---

## Running the guards

```bash
npx vitest run --config vitest.config.ts   # static guards + unit tests, no Docker
npm run test:db                            # live-database suites; FAILS if no database is reachable
```

`npm run test:db` deliberately fails rather than skipping when it cannot connect. A security suite that did not run has verified nothing, and a skip reads as a pass in every CI summary.

## Adding an invariant

Add it to `supabase/tests/securityInvariants.test.ts` **first** — that file is the source of truth — then add the row here. Point it at a guard that actually runs. The test fails if an enforcement point is missing, if its assertion has been renamed away, or if this document and the code disagree.
