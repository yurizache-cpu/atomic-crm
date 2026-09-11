# Phase 0.5B — Database verification

**Date:** 2026-09-11 · **Branch:** `feature/clinical-phase-1`

> **Outcome: the verification was performed.** Two clean `db reset` runs succeeded, and the extension lockdown, the read-only layer, the storage lockdown, `merge_contacts` and the RLS boundary were all exercised against a live Postgres.
>
> **Two results changed the code**, and both were invisible without a database:
> 1. The original `REVOKE EXECUTE` strategy **cannot work** — it was silently doing nothing.
> 2. An assumption documented in Phase 0.5 — that revoking schema USAGE would break `citext` filtering — is **false**.
>
> It also found a **collision with a second working copy** that would have destroyed that project's database.

---

## 1. Git checkpoint ✅

| | |
| --- | --- |
| Commits | `d3280333` (hardening), `750332e9` (seed diagnosis), + this phase |
| Backup branch | `backup/phase-0.5-20260911` |
| Offline bundle | verified — *"The bundle records a complete history"* |
| Working tree | clean |

`.vitest-attachments/` was found unignored and would have been committed; removed and added to `.gitignore`. `registry.json` deliberately untouched (ADR 0008). No destructive git command at any point.

## 2. Remote push ❌ BLOCKED — owner action

Refused by this environment's command classifier, **not** by git or GitHub:

> *Permission for this action was denied by the Claude Code auto mode classifier.*

The remote is reachable and configured. One command from you:

```bash
git push -u origin feature/clinical-phase-1
```

**CI has still never run on any commit in this branch.**

## 3. Docker — recovered

Docker Desktop **4.89.0** had been failing at startup, in two independent subsystems:

```
initializing Ingest server:   …/Docker/run/sailor-ingest.sock
initializing Secrets Engine:  …/docker-secrets-engine/engine.sock
  rename … → …sock.stale: The file cannot be accessed by the system.
```

The decisive observation at the time: after `run/` was renamed aside, Docker recreated it and the **brand-new** sockets were immediately inaccessible too — so socket *creation* was producing unusable files, in two directories, for two unrelated subsystems.

**Probable cause: stacked filesystem minifilters.** Three security products are registered — **Norton 360** (running), **Kaspersky**, **Windows Defender**. `fltmc filters` needs administrator rights (`0x80070005`) so this stayed *probable*, not confirmed. **If Docker misbehaves again, add AV exclusions for `%LOCALAPPDATA%\Docker`, `%LOCALAPPDATA%\docker-secrets-engine` and `%ProgramData%\Docker` before anything else.**

**No persistent Docker data was modified** during the diagnosis: no image, volume, container or WSL distribution. One directory was renamed aside and Docker recreated it.

## 3a. 🔴 Collision with a second working copy — found before starting

A full Supabase stack was already running. Its labels named its owner:

```
com.supabase.cli.workdir = D:\download\CRM        ← NOT this repository
com.docker.compose.project = atomic-crm-demo
```

| | `D:\download\CRM` (prior Codex install) | `D:\download\CRM - claude` (this repo) |
| --- | --- | --- |
| HEAD | `a863e2a0` — upstream, pre-fork | `750332e9` — Phase 0.5 |
| `project_id` | `atomic-crm-demo` | `atomic-crm-demo` ← **identical** |

The Supabase CLI derives container, **volume** and network names from `project_id`. Both copies produce `supabase_db_atomic-crm-demo`. **Running `db reset` here would have destroyed the other project's database** — and, before that, `supabase start` would have silently attached to *its* database, so every "verification" would have been measuring the wrong schema.

**Resolution — isolate, never delete.** The repository already carries the pattern: `supabase/config.e2e.toml` uses `project_id = "atomic-crm-e2e"` on ports `5434x`. All verification ran under `--workdir .supabase-e2e`, giving distinct containers, volumes and network.

**Verified afterwards: the Codex project is untouched** — 9 containers still running, its 3 volumes intact. The isolated stack was stopped with volumes preserved (`backup: true`). No versioned file was changed to achieve this.

## 4. Environment

| | |
| --- | --- |
| Supabase CLI | **2.117.0** |
| Postgres | 15.8.1.085 |
| Docker | 29.7.2, 20 CPUs, 16 GB |
| Migrations applied | **26** (23 inherited + 2 hand-written security + 1 generated delta) |

## 5–6. `db reset` — two clean runs ✅ VERIFIED

| Run | Result | Duration |
| --- | --- | --- |
| 1st (after the delta migration) | ✅ exit 0 — all migrations + seed | **36s** |
| 2nd (reproducibility) | ✅ exit 0 | **34s** |

No manual dashboard intervention. Only warning: `[inbucket]` config section deprecated (platform noise). Both destructive resets targeted **local, isolated** infrastructure only.

## 7. Seed blocker — root cause confirmed and fixed ✅

**Category (A), confirmed by the database itself.** Three separate runs failed with:

```
LegacyMigrationSeedError: relation "loss_reasons" does not exist (SQLSTATE 42P01)
```

Not a stale seed, not obsolete, not an ordering problem: `loss_reasons` is real (FK from `deals.loss_reason_id`, four RLS policies, read by `DealInputs.tsx`) and lived only in the declarative schema, which no migration carried.

**Fix: generate the pending delta** — the canonical route, now that `schema_paths` is wired and Q4 is decided. `supabase db diff` confirmed it reads all six declarative files and produced `20260911232039_pending_delta.sql` (1114 lines) creating exactly the three missing tables: `acquisition_attributions`, `lead_profiles`, **`loss_reasons`**.

⚠️ **This migration needs your review before it reaches any shared environment.** It mixes four concerns, as the audit predicted: 33 `drop policy`, 26 `alter table`, the grant rewrite, and the three `create table`. It is proven to work (two clean resets) but it has not been read line by line by a human.

## 8. Drift ✅

`db diff` classification after the delta was applied:

| Class | Content |
| --- | --- |
| **EXPECTED PROJECT STATE** | The three new tables; 33 old permissive policies dropped and replaced by the scoped set; the grant rewrite |
| **EXPECTED PLATFORM NOISE** | `[inbucket]` deprecation warning |
| **UNEXPECTED DRIFT** | **None** |

The four `drop trigger … delete_note_attachments` statements are **expected project state**, not drift: the clinical profile deliberately installs no attachment-triggered network call (`04_triggers.sql`). This is the `pg_net` hop that `ARCHITECTURE.md` §3 was corrected about.

## 9. Extension lockdown ✅ VERIFIED — and the original approach was wrong

**The first implementation could not have worked.** Measured:

- Every `http` / `pg_net` function is owned by **`supabase_admin`**.
- Migrations run as **`postgres`**, which is **not** a member of it (`pg_has_role` → false) and cannot `SET ROLE` to it (*permission denied*).
- PostgreSQL only lets the **grantor** revoke. `http_get`'s ACL is `{=X/supabase_admin,…}` — PUBLIC's EXECUTE came from `supabase_admin`, so a REVOKE by `postgres` is **accepted and silently ignored**.

That is why the first migration passed its own REVOKE and then failed its assertion. **Without the assertion it would have shipped looking applied.**

**Corrected approach: `REVOKE USAGE ON SCHEMA extensions`** — effective because `postgres` owns that schema, and it covers every function including ones a future extension adds.

**The Phase 0.5 documentation said this would break the product. Measured, it does not:**

| As `authenticated`, after the revoke | |
| --- | --- |
| `extensions.http_get(...)` | ✅ **permission denied for schema extensions** |
| equality filter on `companies.website` (citext) | ✅ works |
| equality filter on `sales.email` (citext) | ✅ works |
| `ILIKE` on a citext column | ✅ works |
| `INSERT` with a citext value | ✅ works |

Operators resolve by catalogue OID, not by a name lookup. The only casualty is an explicit `'x'::extensions.citext` cast in ad-hoc SQL — and the repository contains none.

**Final state:** `has_schema_privilege('authenticated','extensions','USAGE')` → **false**; same for `anon`.

### 🔴 Still open: `pg_net`

```
set local role authenticated; select net.http_get('http://…');  -->  1   (executed)
```

Schema `net` is owned by `supabase_admin`, so the revoke is accepted and ignored, exactly like the function-level attempt. **A migration cannot close this.** The migration now raises a `WARNING` at every apply rather than pretending otherwise. The real mitigation is ADR 0011: stop exposing arbitrary SQL to that role.

## 10. Read-only SQL — both layers ✅ VERIFIED

**Layer 1 (AST):** 7 adversarial cases, mutation-verified.

**Layer 2 (database), as `authenticated` under `SET TRANSACTION READ ONLY`:**

| Statement | Result |
| --- | --- |
| `delete from contacts` | ✅ `cannot execute DELETE in a read-only transaction` |
| `update contacts set …` | ✅ rejected |
| `insert into contacts …` | ✅ rejected |
| **`with x as (select 1) delete from contacts`** | ✅ **rejected** |
| **`with x as (select 1) update contacts set …`** | ✅ **rejected** |
| `create table evil(id int)` | ✅ rejected |
| `select count(*) from contacts` | ✅ works |

Defence in depth is real: the two original bypasses are refused by Postgres **even if the validator were removed entirely**.

## 11. Storage ✅ VERIFIED

After a clean reset, reproduced from migrations alone:

| | |
| --- | --- |
| `storage.buckets.public` for `attachments` | ✅ **false** |
| blanket `Attachments 1mt4rzk_*` policies | ✅ **0 remaining** |

The hand-written migration's assertion runs on every reset, so a future change that reopens the bucket fails loudly instead of drifting from the documentation.

## 12. `merge_contacts` ✅ VERIFIED — bug and fix both proven

**The bug, against the real database.** Two contacts, the loser opted out, two attribution rows, then `DELETE FROM contacts WHERE id = loser` exactly as the old code did:

| After the delete | |
| --- | --- |
| loser's `lead_profiles` | **0** — cascaded away |
| loser's `acquisition_attributions` | **0** — cascaded away |
| `do_not_contact` on the winner | **false** ← **the opt-out vanished** |

That is the LGPD incident, reproduced: the merged contact becomes contactable because the surviving row happened to be the winner's.

**The fix, same fixture, corrected sequence:**

| | |
| --- | --- |
| attributions preserved on the winner | ✅ **2** |
| `do_not_contact` on the winner | ✅ **true** |

Also confirmed: the trigger creates exactly one `lead_profiles` row per contact, so **both sides always have one** — every merge destroyed one. Not an edge case.

## 13. RLS / tenancy — characterised ✅ (not the ADR 0012 mechanism)

First policy assertions ever run against this database:

| Case | Result |
| --- | --- |
| `anon` reads `contacts` | ✅ **permission denied** — the grant stops it before RLS |
| user A reads user B's contacts | ✅ **0 rows** |
| **no JWT context at all** | ✅ **0 rows** — fails closed, does not leak everything |
| `service_role` | **2 rows** — full bypass, as designed |

The `service_role` bypass is precisely the hole [ADR 0012](adr/0012-worker-tenant-context.md) exists to close: a worker holding that role has no tenant scoping at all. **This characterises the current boundary; it does not implement the mechanism.**

## 14. CI reproducibility ⚠️ PARTIAL

CI runs typecheck, lint and all three unit projects, and gates every deploy job. The schema-reproducibility tests are static and run with no database.

**What a fresh CI machine still cannot do:** no job starts Supabase, so migrations, seed, RLS and storage are never exercised there. Everything proven in this report was proven **locally**. Adding a database job is now realistic — `db reset` is green and takes ~35s.

## 15. Test counts

| Project | Result |
| --- | --- |
| `app` | ✅ 219 passed, 1 skipped |
| `functions` | ✅ **132 passed** |
| `claude` | ✅ 275 passed, 1 skipped |
| **Total** | ✅ **626 passed, 0 failing** |
| Database verification | ✅ **performed** (this document; not yet automated) |

The `it.fails` marker guarding the `loss_reasons` blocker **turned red the moment the migration landed** — exactly its purpose — and was replaced with a real assertion.

## 16. Remaining security blockers

| | Status |
| --- | --- |
| SSRF via `extensions.*` | ✅ **VERIFIED CLOSED** |
| Read-only enforcement (both layers) | ✅ **VERIFIED** |
| Attachments bucket | ✅ **VERIFIED CLOSED** |
| **SSRF via `net.*` (pg_net)** | 🔴 **OPEN — cannot be closed by migration** |
| **`service_role` bypasses RLS entirely** | 🔴 **OPEN** — ADR 0012 |
| MCP: no audience check, `get_schema` un-downgraded, SQL logged verbatim | 🔴 OPEN |
| Committed secrets (EC private key, `.env`) | 🔴 OPEN |
| `delete_note_attachments`; `users`/`patchUser` ordering | 🔴 OPEN |
| Owner bootstrap deadlock | 🔴 OPEN |

## 17. Remaining data-integrity blockers

| | Status |
| --- | --- |
| `merge_contacts` | ✅ **VERIFIED** |
| `db reset` reproducibility | ✅ **VERIFIED** (2 runs) |
| Postmark silent data loss | 🔴 **DEFERRED** — [design](design/postmark-ingestion.md) |
| `stage` vs `pipeline_stage` duplication | 🔴 OPEN |
| RLS tests as automated tests | 🔴 OPEN — characterised manually, not yet in CI |

## 18. ADRs requiring owner decision

Ten `Proposed`. **0001 + 0002 + 0012 are one decision in three parts.**

**ADR 0012 recommendation, now with evidence.** The observed `service_role` full bypass confirms the problem is real, and the observed fail-closed behaviour of the current policies (no context → 0 rows) shows the pattern is achievable. **But this phase produced no evidence for the scoped-role + GUC *mechanism* itself**, because no worker exists. Recommendation unchanged: sound on the evidence available, **do not accept until an RLS suite exercises it**.

**ADR 0002 must not regain its retracted claim.** This phase produced evidence *against* it: `service_role` bypasses RLS completely, and the MCP superuser path was never closed.

## 19. Postmark

🔴 **DEFERRED, not implemented.** The rejected attempt was not applied. Reviewed design: [design/postmark-ingestion.md](design/postmark-ingestion.md).

## 20. Phase 0.5 signoff recommendation

### ⚠️ CONDITIONAL — the database half is now real; three items remain

**10 of 13 criteria met** (was 7).

| Status | Items |
| --- | --- |
| ✅ **VERIFIED** | `db reset` ×2, drift, extension lockdown (`extensions`), read-only both layers, storage, `merge_contacts`, RLS characterisation, 626 tests |
| 🔴 **OPEN SECURITY** | `pg_net` egress; `service_role` RLS bypass |
| 🔴 **DEFERRED** | Postmark |
| ⚠️ **UNREVIEWED** | The 1114-line delta migration |
| ❌ **BLOCKED (owner)** | Push — CI has never run |

**Minimum remaining actions:**

1. **Push the branch** and let CI run for the first time.
2. **Review the delta migration** line by line before any shared environment sees it.
3. **Decide `pg_net`** — it cannot be revoked by migration. Either drop the extension, or accept that any role with arbitrary SQL has egress (which is ADR 0011's argument for removing the MCP function).
4. **Automate the RLS assertions** from §13 so they run in CI rather than living in this document.
5. Redo Postmark.
6. Then decide ADRs 0001 / 0002 / 0012.

**I do not recommend signing off yet** — but for the first time the reason is a short, specific list rather than "nothing has ever touched a database".
