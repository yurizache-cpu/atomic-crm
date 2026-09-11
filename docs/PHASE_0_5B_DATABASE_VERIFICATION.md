# Phase 0.5B — Database verification

**Date:** 2026-09-11 · **Branch:** `feature/clinical-phase-1` · **Checkpoint:** `d3280333`

> **Outcome: the database verification could NOT be performed.** Docker Desktop is broken on this machine for a reason unrelated to this repository, and every remediation available without administrator rights was attempted and failed. Nothing in §5–§13 below is verified; it is all still *implemented but not verified*.

---

## 1. Git checkpoint status ✅

| | |
| --- | --- |
| Commit | **`d3280333`** — `fix(security): Phase 0.5 foundation hardening` |
| Branch | `feature/clinical-phase-1` |
| Backup branch | `backup/phase-0.5-20260911` (same SHA) |
| Working tree | clean |
| Files in checkpoint | 69 |

Reviewed for noise before committing. One artefact found and removed: `.vitest-attachments/` (vitest browser-mode failure screenshots), now in `.gitignore` — it was not ignored, so it would have been committed. `registry.json` was deliberately left untouched, pending ADR 0008. No mass formatting; no destructive git command was run at any point.

An offline `git bundle` of all refs was also written to the session scratchpad and **verified** (*"The bundle records a complete history"*).

## 2. Remote backup / push status ❌ BLOCKED

**The push did not happen.** It was refused by this environment's command classifier, not by git and not by GitHub:

> *Permission for this action was denied by the Claude Code auto mode classifier.*

This is **not** an authentication or permission failure on the remote — the remote is reachable and configured (`origin → github.com/yurizache-cpu/atomic-crm.git`). It is a sandbox restriction on the agent.

**Owner action required — one command:**

```bash
git push -u origin feature/clinical-phase-1
```

Until then, all five commits exist only on this disk (plus the local bundle), and **CI has still never run on any of them**.

## 3. Docker status ❌ BLOCKED — broken, cause is outside this repository

`docker info` fails: `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`.

Docker Desktop **4.89.0 build 238018** starts, crashes during service initialisation, and exits. Two independent subsystems fail identically:

```
22:03:47  initializing Ingest server: listening on
          unix://…/Docker/run/sailor-ingest.sock: rename … → …sock.stale:
          The file cannot be accessed by the system.

22:09:21  initializing Secrets Engine: listening on
          unix://…/docker-secrets-engine/engine.sock: rename … → …sock.stale:
          The file cannot be accessed by the system.
```

**The decisive observation:** after the `run` directory was renamed aside, Docker **recreated it and the brand-new sockets were immediately inaccessible too** (`ls` shows `-?????????`, and `stat` fails). So these are not stale artefacts from a previous session — **socket creation itself is producing files the system then cannot access**, in two different directories, for two unrelated subsystems. Even Docker's own error-reporter pipe fails to clean up (`remove \\.\pipe\errorReporter`).

### Most likely root cause

**Filesystem-filter interference from stacked security software.** Three antivirus products are registered on this machine simultaneously:

- **Norton 360** (actively running — `NortonSvc`, `NortonUI`, `NortonUtilitiesSvc`)
- **Kaspersky**
- **Windows Defender**

Two third-party endpoint suites plus Defender each install filesystem minifilters. That is a known cause of exactly this signature: AF_UNIX socket files that are created but then cannot be opened, renamed or deleted by any user-space method. It explains why the failure follows the *subsystem*, not the *file*, and why it survived every cleanup.

**Confidence: probable, not confirmed.** `fltmc filters` — which would list the minifilters and settle it — requires administrator rights and returned `0x80070005 Access denied`. The session is **not** elevated (verified: `IsInRole(Administrator) → False`).

### Actions attempted, in order

| Action | Result |
| --- | --- |
| `docker info`, wait 400s | Daemon never came up |
| Started Docker Desktop, waited | Process starts then exits |
| Renamed the six stale socket files | **All six failed** — "cannot be accessed by the system" |
| `wsl --shutdown` (non-destructive; only distro is `docker-desktop`, already Stopped) | No change |
| Deleted sockets via `[System.IO.File]::Delete` with the `\\?\` extended-length prefix, `Remove-Item -Force`, and `cmd del /f /q` | **All three methods failed on all six files** |
| Renamed the whole `run` directory aside | ✅ Succeeded — directory preserved as `run.orphaned-20260911` |
| Restarted Docker with a clean `run` | Failed again; **new** sockets immediately inaccessible |
| Inspected Docker Desktop logs, WSL state, services, AV products | Evidence above |

**Persistent Docker data modified: NONE.** No image, volume, container, WSL distribution or Supabase data was touched. No `prune`, no factory reset, no reinstall. The only filesystem change is one directory renamed aside (`run` → `run.orphaned-20260911`), which is reversible and which Docker has already recreated.

### Next remediation options, by data-loss risk

| Option | What it involves | Data-loss risk |
| --- | --- | --- |
| **1. Add AV exclusions, then reboot** *(recommended first)* | In Norton 360 **and** Kaspersky, exclude `%LOCALAPPDATA%\Docker`, `%LOCALAPPDATA%\docker-secrets-engine`, `%ProgramData%\Docker` and `%LOCALAPPDATA%\Programs\DockerDesktop`. Reboot. | **None.** Fully reversible, touches no Docker data |
| **2. Reboot first, then retry** | A reboot clears kernel-held handles and re-initialises minifilters. Cheapest test of whether the state is merely wedged. | **None** |
| **3. Remove one third-party AV** | Running Norton **and** Kaspersky together is the underlying misconfiguration; two real-time engines fighting over the same filter stack is unsupported by both vendors. | **None to Docker.** Requires owner decision — it changes the machine's security posture |
| **4. Elevated diagnosis** | Run `fltmc filters` as administrator to confirm which minifilter is attached before changing anything. | **None** — read-only, and it converts "probable" into "confirmed" |

**Not attempted and not recommended without your approval:** Docker factory reset, reinstall, or deleting `%LOCALAPPDATA%\Docker` wholesale. Each would destroy local images, volumes and any Supabase container state.

## 4. Supabase CLI / environment

| | |
| --- | --- |
| Supabase CLI | 2.117.0 (per repo docs; **not exercised** — requires Docker) |
| Node / npm | v22.23.1 / 10.9.8 |
| OS | Windows 11 Pro, build 26200 |
| WSL | installed; default distro `docker-desktop`, version 2, state **Stopped** |
| Docker CLI / daemon | 29.7.2 / **unavailable** |

## 5–6. `db reset` (first and second run) ❌ BLOCKED

Not run. Requires Docker.

## 7. Seed issue — root cause and fix ✅ DIAGNOSED (fix requires Docker)

**Investigated before changing anything, as instructed. The answer is category (A): the table should exist and a migration is genuinely missing** — but the smallest correct fix is *not* the obvious one.

Evidence:

- `loss_reasons` **must** exist — `deals.loss_reason_id` has a FK to it, it carries four RLS policies, `DealInputs.tsx` reads it, and ADR 0013 cites it as the reference-row pattern to follow. It is not obsolete (rules out B and C).
- It **is** defined, at `supabase/schemas/01_tables.sql:188`.
- It is in **zero** migrations — and so are the other two tables the fork added. Ordering is not the issue (rules out D).

So the seed is not stale: it is the *first thing to touch* a schema rewrite that no migration carries. **The correct fix is to generate the pending migration** (`supabase db diff`), which needs Docker. Creating the table by hand to satisfy the seed was explicitly forbidden, and would have been wrong anyway — it would hide the real gap behind a green reset.

**Scope confirmed narrow:** of the tables the seed writes to, `loss_reasons` is the **only** one no migration creates. `favicons_excluded_domains` does have one.

### Regression coverage added ✅

`supabase/schemaReproducibility.test.ts` — static analysis of the SQL, so it runs in CI with no database:

- **every table the seed writes to is created by a migration** — marked `it.fails`, because the blocker exists today. The suite therefore stays green while the blocker is real and turns **red the moment the migration lands**, forcing the marker to be removed rather than quietly forgotten.
- **the only unmigrated seeded table is the one we know about** — pins the blast radius, so a *second* missing table fails immediately instead of hiding behind the known one.
- **no tenant vocabulary in CHECK constraints** (ADR 0013 guard).
- **the storage lockdown lives in a migration, not only in the DML-only declarative file.**
- **both hand-written security migrations ship a `raise exception` assertion** — a migration that silently no-ops is worse than none, because it looks applied.

*(This test caught a false positive in its own first draft: the regex missed `create table "public"."x"` spelling. Fixed, and worth recording — the check is only as good as its parsing.)*

## 8. `db diff` / drift ❌ BLOCKED

Not run. Requires Docker. Note `[db.migrations] schema_paths` was wired in Phase 0.5 but **has never been exercised**, so it is unknown whether the CLI reads it as intended or what the first diff emits.

## 9. Extension lockdown ❌ NOT VERIFIED

`20260911130000_revoke_network_extension_privileges.sql` exists and ends in an assertion, but has never been applied. The SSRF path (`SELECT extensions.http_get(…)`) is **closed in intent only**.

## 10. Read-only SQL — layer 1 ✅ VERIFIED · layer 2 ❌ NOT VERIFIED

- **Layer 1 (application/AST): verified.** 7 adversarial cases pass — CTE attached to DELETE/UPDATE/INSERT, schema-qualified, nested, comment/whitespace-split, with RETURNING. **Mutation-verified:** reverting the fix fails exactly those 7.
- **Layer 2 (database): not verified.** `SET TRANSACTION READ ONLY` is in the code path and has never executed against Postgres.

## 11. Storage ❌ NOT VERIFIED

Migration and assertion written; never applied. The bucket's real state is still the migrated default: **public**.

## 12. `merge_contacts` — rule ✅ VERIFIED · database ❌ NOT VERIFIED

The consent rule is extracted to a pure function with 12 tests: `OR` across all four combinations, null/undefined cannot clear an opt-out, and **symmetric** — merge direction cannot change consent. The transaction changes (re-pointing `acquisition_attributions`, folding the profiles) are **untested against a database**, and cannot be until the tables exist in a migration.

## 13. RLS / tenant tests ❌ NOT WRITTEN — deliberately

Still **zero** policy assertions exist in the repository. They were not written in this phase because they cannot be executed: a test that has never run is not evidence, and adding a suite of unverifiable assertions would be the same anti-pattern this phase exists to correct. The specification is in [PERMISSIONS.md](PERMISSIONS.md) §4 and [ADR 0012](adr/0012-worker-tenant-context.md); writing them is the **first task** once Docker works.

## 14. CI reproducibility ⚠️ PARTIAL

CI runs typecheck, lint and all three unit projects, and every deploy job is gated on them. The new schema-reproducibility tests are static, so they run on a fresh CI machine with no database.

**Machine-local assumptions that still block full reproducibility:**

1. No CI job starts Supabase, so no migration/seed/RLS verification happens in CI.
2. `supabase db reset` is red at `seed.sql` (§7), so such a job would fail today.
3. The e2e stack has the same dependency and the same blocker.

## 15. Test counts

| Project | Result |
| --- | --- |
| `app` | ✅ 219 passed, 1 skipped (27 files) |
| `functions` | ✅ 132 passed, **1 expected-fail** (6 files) |
| `claude` | ✅ 275 passed, 1 skipped (35 files) |
| **Total** | ✅ **626 passed, 0 unexpected failures** |
| Database-specific | ❌ **0 — none could run** |
| typecheck / lint | ✅ pass |

Up from 621: +5 from the schema-reproducibility suite. The *expected fail* is the tracked `loss_reasons` blocker, not a regression.

## 16. Remaining security blockers

| | Status |
| --- | --- |
| SSRF via `extensions.http_get` | **IMPLEMENTED BUT NOT VERIFIED** |
| `SET TRANSACTION READ ONLY` | **IMPLEMENTED BUT NOT VERIFIED** |
| Attachments bucket | **IMPLEMENTED BUT NOT VERIFIED** — still public in reality |
| RLS / tenant isolation | **OPEN** — never asserted, by any test, ever |
| MCP: no audience check, `get_schema` un-downgraded, SQL logged verbatim | **OPEN** |
| Committed secrets (EC private key, `.env` files) | **OPEN** |
| `delete_note_attachments`, `users`/`patchUser` ordering | **OPEN** |
| Owner bootstrap deadlock | **OPEN** |

## 17. Remaining data-integrity blockers

| | Status |
| --- | --- |
| `merge_contacts` against a real database | **IMPLEMENTED BUT NOT VERIFIED** |
| Postmark silent data loss | **DEFERRED** — design in [design/postmark-ingestion.md](design/postmark-ingestion.md) |
| `db reset` reproducibility | **BLOCKED** — needs the pending migration |
| `stage` vs `pipeline_stage` duplication | **OPEN** |

## 18. ADRs requiring owner decision

Ten `Proposed`. Three are one decision in three parts and must be taken together: **0001** (worker), **0002** (tenancy), **0012** (tenancy mechanism). **0002 cannot be accepted before 0012.** Its false "unreachable by construction" claim remains retracted — and this phase produced **no** evidence to restore it, because the MCP superuser path was never exercised.

**Recommendation for 0012, unchanged and explicitly not strengthened:** the scoped-role + transaction-local GUC design is still the right one on the evidence available, but this phase produced **zero** database evidence. Do not accept it on the strength of characterisation tests that never ran. Hold until the RLS suite exists.

## 19. Postmark

**DEFERRED, not implemented.** The rejected attempt is not applied. A reviewed design — current failure behaviour, the 200-vs-500 rule, `MessageID` idempotency with claim-before-work, the ledger table, retry policy, observability, and an 8-case test plan split into runnable-now and Docker-blocked — is in [design/postmark-ingestion.md](design/postmark-ingestion.md).

## 20. Phase 0.5 signoff recommendation

### ❌ DO NOT SIGN OFF

**7 of 13 criteria met** (up from 6; the seed root cause is diagnosed and guarded, but not fixed).

The reason is unchanged and now sharper: **every database-level guarantee is still `IMPLEMENTED BUT NOT VERIFIED`.** This phase existed specifically to convert them into verified guarantees, and the environment prevented it. Declaring the foundation trustworthy on the strength of code that has never met a database would repeat precisely the error the Phase-0 audit found in the Phase-0 documents.

**Minimum remaining actions, in order:**

1. **Owner:** fix Docker (§3, option 1 or 2), and `git push -u origin feature/clinical-phase-1`.
2. Generate and review the pending migration → `db reset` green → the `it.fails` marker in `schemaReproducibility.test.ts` goes red and is removed.
3. Apply both hand-written security migrations; their assertions either pass or fail loudly.
4. Verify §9–§12 against the live database.
5. Write the first RLS suite — cross-tenant read and write denied, and **unset tenant context matching no rows rather than all rows**.
6. Redo Postmark per the design.
7. Then, and only then, decide ADRs 0001 / 0002 / 0012.
