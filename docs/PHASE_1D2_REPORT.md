# Phase 1D.2 — Pre-main safety closure

| | |
| --- | --- |
| **Branch** | `feature/pre-main-safety`, created from `feature/clinical-phase-1` at `c0c07c37` (the Phase 1D.1 merge, CI verified). ~~Local only: **not pushed**.~~ *(2026-09-17: pushed by the owner; remote HEAD `c00082fb`.)* |
| **Date** | 2026-09-17 |
| **Purpose** | Close pre-main safety debt before Phase 2A, and nothing else. Four findings an automated reviewer (Codex) raised on PR #1 were investigated and dispositioned. They sit in historical files outside the Phase 1D.1 diff, but any of them could block a merge or deploy to `main`. |
| **Out of scope, untouched** | Phase 2A, WhatsApp, lead triage, tools, UI, the agent runtime, CRM redesign, `main`, any deploy, and unrelated backlog. |
| **CI** | **VERIFIED** — [run 35247254334](https://github.com/yurizache-cpu/atomic-crm/actions/runs/35247254334) on `c00082fb` (§17). Every Phase 1D.2 path is green; the only reds are `e2e-test` and repository-wide Prettier, identical to the baseline [run 35220094426](https://github.com/yurizache-cpu/atomic-crm/actions/runs/35220094426) on `b4dee040`. |
| **Owner review** | 2026-09-17: the three implementation choices are **accepted** as owner decisions F, G and H (§16). |
| **Classification** | **READY FOR CI** (§15) |

## 1. Summary

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | Existing deals receive `pipeline_stage = 'new_lead'` whatever their stage | **CONFIRMED + FIXED** — `20260917180000` |
| 2 | Existing administrators get `role = 'operator'` and lose administration | **CONFIRMED + FIXED** — `20260917180200` and `20260917180300`, plus an explicit owner bootstrap |
| 3 | Existing contacts get no `lead_profiles` row | **CONFIRMED + FIXED** — `20260917180100` |
| 4 | `deploy-supabase` does not wait for the database suites | **CONFIRMED + FIXED** — `.github/workflows/database.yml`, called by `check.yml` and `deploy.yml` |

None was a false positive.

Findings 1–3 are in `supabase/migrations/20260911232039_pending_delta.sql`, which is sealed (`supabase/invariants/seal.json`), so every fix is a forward migration. All three are **latent**: the owner has confirmed no hosted project exists, and the development seed inserts no contacts, deals or users. Each would fire on the first upgrade of any database that holds CRM data from before that migration.

## 2. Method

1. **Research.** Four read-only research passes, one per finding, then a completeness critic that spot-checked citations and found five defects in the first drafts (§11).
2. **Reproduction on data.** A pre-upgrade database was built by resetting the isolated e2e stack to `20260911130000`, the migration just before `pending_delta`. The legacy fixture was loaded there, and the real chain was then applied with `supabase migration up`, as a deploy would.
3. **Consequences through the real role.** Each consequence was measured as `authenticated` through a JWT subject, never as a bypass role, with a positive control for every "false" result.
4. **Fixes and replay.** Fixes landed as forward migrations. The reproduction became a permanent, destructive upgrade replay (`npm run test:db:upgrade`), now part of the database gate.
5. **Mutation testing** of every new guard: owner path 15/15, upgrade replay 10/10, steady-state suite 3/3, deploy gate 68 + 1 (§9).
6. **Adversarial review.** Finding 4 was reviewed from three lenses: GitHub Actions semantics, bypass hunting and regressions (§6.4).

## 3. Finding 1 — deal pipeline backfill: CONFIRMED + FIXED

**Mechanism.** `pending_delta` does `add column pipeline_stage text not null default 'new_lead'`. Adding a column with a default fills that value into every existing row. The same file installs `synchronize_deal_pipeline()`, a BEFORE INSERT OR UPDATE trigger that copies `pipeline_stage` over `stage` on every write.

**Measured on the legacy fixture** (eight deals: `opportunity`, `proposal-sent`, `in-negociation`, `won`, `lost`, `delayed`, a custom `qualified`, and an empty stage):
- after the upgrade, every deal had `pipeline_stage = new_lead`, and `stage` still held the legacy value;
- the board, which groups by `pipeline_stage`, would show all eight in the first column;
- the operator then renamed two of their own deals, as an ordinary edit through `authenticated`. Both came back as `stage = new_lead` and `pipeline_stage = new_lead`, so their legacy stage was **destroyed**.

Research found more writers that trigger the same overwrite: a Kanban index shift, `unarchiveDeal`, `merge_contacts` rewriting `contact_ids`, and `DealCreate`'s index bump of every listed deal in the stage.

**Intended mapping: identity.** The evidence:
- the trigger's own insert rule, `coalesce(nullif(stage, ''), 'new_lead')`;
- ADR 0013 ("a code is already what the column stores");
- the importer and the FakeRest generator, which write `stage = pipeline_stage`.

No translation table exists, and one in a migration would break CLAUDE.md rule 2. Legacy codes are carried unchanged. The tenant's own Settings (`public.configuration.dealStages`) decide which columns exist.

**Fix — `20260917180000_backfill_legacy_deal_pipeline_stage.sql`.** Since `pending_delta`, the trigger keeps the two columns equal on every write, so a row where they differ has not been written since, and its `stage` is the surviving legacy value. The migration:
- updates exactly those rows to `coalesce(nullif(stage, ''), 'new_lead')`, in both columns;
- switches the trigger off for that one statement, so `updated_at` keeps its legacy value, then switches it back on;
- asserts that no row still disagrees and that the trigger is enabled.

Running it again changes nothing.

**Proof.** `upgrade_assertions.sql` §1 checks:
- each legacy deal's stage, both columns;
- the unchanged `updated_at`;
- every non-empty legacy stage is a configured board column;
- a post-upgrade rename keeps the stage;
- a new deal still defaults to `new_lead`, and an explicit `pipeline_stage` wins.

Mutations U1 (no backfill) and U2 (trigger left on) are both killed.

**Not recoverable, and residual:**
- A legacy deal edited after `pending_delta` ran and before this migration has lost its stage; only a backup restores it. On every real upgrade path the two migrations are pushed together, so that window does not open in practice.
- `stage_entered_at` keeps the upgrade time, because the true entry time was never recorded.
- An INSERT that sets only `stage`, or an UPDATE that changes only `stage`, still has its stage discarded, because the column default makes the trigger's derive-from-stage branch dead. No application path writes `stage` alone; recorded, not changed.
- If an upgraded instance never saved its own `dealStages` (configuration is `'{}'`), its legacy codes are not clinic columns. They fall into the first column with a blank label until an owner configures them. Upstream `won` and `lost` deals get no `lost_at` or `loss_reason_id`.
- Adjacent frontend defect found by research, not changed: `DealListContent.tsx:50-55`'s fallback destination has no `stage`, so a drop into an empty column may not persist.

## 4. Finding 2 — owner/admin provisioning: CONFIRMED + FIXED

**Mechanism.**
- Before `pending_delta`, `is_admin()` was `administrator = true`, and the first signup became administrator.
- `pending_delta` added `role text not null default 'operator'` and made `is_admin()` require `administrator AND role = 'owner' AND NOT disabled`. The default filled `operator` into every existing row.

**Measured on the fixture** (a first-signup administrator, an administrator promoted by the legacy `users` function, a disabled administrator, an operator, and a user whose metadata claims `administrator: true, role: owner`):
- after the upgrade, `is_admin()` was false for all five, called through `authenticated`. A positive control (the same probe after setting `role = 'owner'` by hand) returned true.
- the legacy administrator's Settings update matched **0 rows**.
- the rows were left half-state: `administrator = true` with `role = 'operator'`. `supabase/functions/users/index.ts:206` still authorises editing *other* users' auth email and ban state on that bare flag.

**A second fact, verified in source, that ruled out the obvious fix.** From `20240730075029_init_db.sql` (grants at 278–281, policies `with check (true)` at 424–438) until `20241104153231_sales_policies.sql` dropped them, **any authenticated user could update any `sales` row, including their own `administrator` flag**, and upstream signup was open. The legacy flag is therefore not trustworthy evidence of ownership. Promoting every legacy administrator automatically would infer ownership from historically user-editable data. The replay keeps that naive fix as mutation U6, and it is killed.

**Design chosen: fail closed, and let a person choose.** Requirement by requirement:
- **No silent loss.** An upgrade with an active legacy administrator and no active owner **halts** with an error naming the waiting rows (by id only).
- **No accidental second owner.** The bootstrap works only while no active owner exists, under a table lock, at READ COMMITTED.
- **No ownership inferred from untrusted input.** The upgrade reads neither metadata, email nor the legacy flag; a person names the user by auth id.
- **The authorization model is not weakened.** `is_admin()` is unchanged, and new tests now pin its `role` and `disabled` conditions, which no test pinned before.
- **Fresh production has an explicit safe owner path.** `public.bootstrap_owner`, with a runbook.

**Fix, part 1 — `20260917180200_owner_bootstrap.sql`:**
- `public.owner_provisioning_log`: RLS on, no policy, and no privilege for `anon`, `authenticated` or `service_role`.
- `public.bootstrap_owner(p_user_id uuid, p_actor text, p_reason text)`, SECURITY INVOKER, with EXECUTE revoked from PUBLIC, `anon`, `authenticated` and `service_role`. It:
  - refuses any isolation level above READ COMMITTED;
  - requires an actor and a reason;
  - takes `SHARE ROW EXCLUSIVE` on `sales`;
  - refuses if an active owner exists;
  - requires an enabled CRM row and a confirmed, unbanned, undeleted auth account;
  - sets `role` and `administrator` together, as the `users` function does;
  - writes a log row.
- End-state assertions on grants, SECURITY INVOKER and RLS.

**Fix, part 2 — `20260917180300_legacy_administrators_upgrade_guard.sql`:**
- It halts as described above.
- Once an active owner exists, every remaining `administrator AND role <> 'owner'` row becomes an operator. Each demotion is logged in the same statement, and demotion only ever removes privilege.
- It asserts that no half-state row remains.

It is a no-op on a fresh database, and running it again changes nothing.

**Measured CLI behaviour the design relies on.** `supabase migration up` commits each migration file in its own transaction: a probe file that raised left the earlier files applied and recorded. A halted upgrade therefore already holds the bootstrap function, and the person's act always has a way forward (mutation U9 proves the dependency).

**Declarative parity.** The table is in `01_tables.sql` and its RLS in `05_policies.sql`. The function is in `02_functions.sql`, verbatim from `supabase db dump`. The revokes are in `06_grants.sql`, after the blanket `service_role` grants (see §11 for the parity proof).

**Owner bootstrap requirement.** The runbook is [PERMISSIONS.md](PERMISSIONS.md) §3, "Owner bootstrap".
- **Fresh deployment:** add the user in the dashboard with the email confirmed, then, in the SQL editor, run `select public.bootstrap_owner('<auth user id>', '<who>', '<why>');`.
- **Upgrade:** the deploy halts; run the same statement for the chosen user, and deploy again.
- **Break glass:** if every owner is disabled, the statement works again.

**Proof:**
- `supabase/tests/owner_provisioning.sql` (new, in `test:db`) covers:
  - the privilege surface, by catalogue and through each role;
  - the REPEATABLE READ refusal;
  - refusal of unknown, unconfirmed, banned, deleted and disabled users, and of a missing actor or reason;
  - exactly one owner and one trimmed log row;
  - the lock held until commit;
  - a second bootstrap refused;
  - `is_admin()` false for a half-state row and for a disabled owner;
  - break glass;
  - metadata that claims ownership ignored by the signup trigger.
- 15/15 mutations killed.
- The upgrade replay rehearses the whole runbook: halt → halted-state assertions → bootstrap → resume → replay. Its assertions check exactly one owner (the chosen one), two recorded demotions, `is_admin()` per user, Settings writable by the owner only, and metadata ignored. Mutations U5–U9 are killed.
- `referenceData.mjs --without-seed` now also proves that a migrations-only database has no owner, administrator or log row.

**Residual (security-relevant, pre-existing, not part of Finding 2):**
- `users/index.ts:122-128` still creates `administrator = true` without `role` when it reuses an existing auth account.
- `users/index.ts:206` (the SECURITY.md "patchUser ordering" item) still trusts the bare flag.
- In-app promotions write no log row.
- `e2e/fixtures.ts` creates the same half state.

## 5. Finding 3 — lead profile backfill: CONFIRMED + FIXED

**Mechanism.** `lead_profiles` rows are created only by `AFTER INSERT` on `contacts`, so contacts that already existed get none. `authenticated` holds SELECT and UPDATE, but **no INSERT**, on `lead_profiles`.

**Measured on the fixture:**
- all legacy contacts had no profile, and `contacts_summary` showed every lead column as NULL, `do_not_contact` included;
- the operator's `update lead_profiles set do_not_contact = true` for their own contact matched **0 rows**, and an INSERT was refused with `permission denied`.

So an LGPD opt-out cannot be recorded for a legacy contact by any application path. The UI also promises that "the profile will be created on save", which is false for them.

**Fix — `20260917180100_backfill_legacy_lead_profiles.sql`.** It inserts one profile per contact without one: `NOT EXISTS` plus `ON CONFLICT (contact_id) DO NOTHING`, so an existing profile is never touched. Values:
- `acquired_at`: `first_seen`, as the trigger uses it. When that is empty, the earliest evidence the row carries (`last_seen` or its first note) is used rather than the upgrade time; `now()` is the last resort, as in the trigger.
- `last_interaction_at`: the later of `last_seen` and the latest note. The note trigger keeps it at the latest note date, and the legacy note→`last_seen` trigger only exists since `20260127140209` and never advanced an empty `last_seen`.
- everything else keeps its table default (`operational_status = 'active'`, `do_not_contact = false`).

A backfilled `acquired_at` is therefore a **derived** value, the earliest evidence the row already held, and not a recorded acquisition time; reports that use it for legacy contacts should say so (owner decision H).

It asserts that every contact has a profile and that `contact_id` is still unique. Profiles are keyed to their own contact and scoped through `can_access_contact`, so no ownership boundary can be crossed (`public.*` has no tenant column; the boundary is the `sales` owner).

**Proof.** `upgrade_assertions.sql` §3 checks:
- exactly one profile per contact;
- the exact expected values for five contacts, including one with no dates and two notes, and one with no `first_seen`;
- the operator can now record their own contact's opt-out, cannot change the administrator's, and sees exactly their two profiles.

The replay applies the migration twice with no change. Mutations U3 (no backfill) and U4 (trigger values copied literally, with no note dates and no evidence fallback) are killed. The new `supabase/tests/crm_data_invariants.sql` checks the invariant on whatever data the database holds, plus the triggers behind it (3/3 mutations killed).

**Residual:**
- Backfilled profiles start with `do_not_contact = false`: the legacy schema had no opt-out field, and an opt-out kept in notes or tags cannot be read by a migration. An owner should review legacy contacts after an upgrade.
- The SQL function `public.merge_contacts`, unlike the edge function, deletes the loser without folding its profile.
- The `LeadCommercialPanel` copy is misleading for legacy contacts.
- FakeRest creates no profile for contacts added at runtime.

## 6. Finding 4 — deploy database gate: CONFIRMED + FIXED

### 6.1 Proof from source
A push to `main` starts `✅ Check` and `🚀 Deploy` as two workflow runs, and `needs:` cannot name a job in another run.
- Before this phase, `deploy-supabase` had only `needs: gate`. That gate ran typecheck, ESLint and the unit projects.
- `test:db`, `test:db:engine`, the migrations-only replay with the reference data check, and the clean reconstruction existed only in `check.yml`'s `database` job.
- So `supabase link`, `db push`, `secrets set` and `functions deploy` could run before, or despite, a red database job for the same commit.

### 6.2 Design
**One source of truth:** `.github/workflows/database.yml`, triggered only by `workflow_call` and holding exactly one job. It keeps the existing job's steps and adds the upgrade replay:

`npm ci` → `supabase start` → `test:db` → `test:db:engine` → **`test:db:upgrade -- --workdir .`** → `db reset --no-seed` → `referenceData.mjs --without-seed` → `db reset` → `test:db`

It has no condition, no concurrency group, no secrets, and `contents: read`.

**Callers:**
- `check.yml`'s `database` job is now a call. The draft-PR condition stays on the caller.
- `deploy.yml` gains a `database` caller, and `deploy-supabase` now has `needs: [gate, database]`. Every other byte of `deploy.yml` is unchanged.
- A local `uses:` runs from the caller's commit, so the deploy is gated on the commit it ships, in the same run.
- If `database` fails, is cancelled or is skipped, `deploy-supabase` is skipped: it has no status-function condition.
- `deploy-doc` and `deploy-demo` touch no database and stay on `gate`.

**Rejected alternatives:**
- `workflow_run`: it runs the default-branch file, its `github.sha` differs from the tested head, and `Check`'s conclusion is always `failure` today because of the pre-existing e2e and Prettier reds.
- Copying the steps into `deploy.yml`: two definitions that would drift.
- A composite action: every step needs `shell:`, and it cannot set a timeout.

**Cost:** a push to `main` runs the suites twice, once per workflow, and `deploy-supabase` starts after a full stack run.

### 6.3 Static guard
`scripts/production-scope-database-gate.mjs` (574 lines) and `scripts/production-scope-workflow-reader.mjs` (246 lines) add the rule `deploy-without-database-gate`, run by `node scripts/production-scope.mjs`, the command `deploy-supabase` itself runs. It is line-based, with no YAML dependency, and has three parts:
- **(a) Every workflow.** Any job that can reach a hosted project must have no job-level `if:`, must directly need a plain call of the gate, must deploy the one tree it checked out, and must run only on `push` or `workflow_dispatch`. A job "can reach" one if it runs a hosted command (including respelled or unreadable ones, and through a local action or a make target), can read a secret other than the two Pages tokens, or runs on a machine GitHub does not host.
- **(b) `database.yml`.** It must be exactly the reviewed step list, and its `SUPABASE_DB_CONTAINER` must match `supabase/config.toml`.
- **(c) `check.yml`.** It must call the same file, keep its reviewed triggers and draft condition, and run no suite inline.

Any spelling the guard would have to guess at is refused: lone CR, NEL, U+2028, invisible characters, quoted or explicit keys, anchors, open quoted values, document markers and duplicate keys.

### 6.4 Adversarial review
- **Actions semantics:** the property holds (two minor gaps in the guard).
- **Regressions:** no regression (five minor findings).
- **Bypass hunting:** **one blocker and four majors**, fixed:
  - (blocker) a suite line hidden in a folded `name:`;
  - extra unchecked steps (for example `npm pkg set` turning every suite into a no-op);
  - a lone CR after a comment hiding a key or a whole job;
  - a deploy job checking out another commit, or a `workflow_run` trigger;
  - shell respellings of the CLI.

The fixer resolved 12 of 15 findings in full, 2 in part, and rejected 1 with a reason (§13). Each reported bypass is now a test; 68 guard mutants plus the command-line wiring mutant are all killed. The main thread split the reader out of the guard module (793 → 574 + 246 lines) without behaviour change; the four guard test files (129 tests) are green after the split.

### 6.5 Residual
The guard does not follow:
- an npm or node script called from a workflow;
- a third-party action's code;
- a credential held in a configuration variable.

Also outside this change:
- The makefile's `supabase-deploy` target, run by a person, is not gated by the live suites.
- `check.yml`'s database check is now reported as "🗄️ Database / 🗄️ Database security & reproducibility". If branch protection requires the old name, the owner must update it.

## 7. Migrations and workflow changes

| File | What |
| --- | --- |
| `supabase/migrations/20260917180000_backfill_legacy_deal_pipeline_stage.sql` | F1 identity backfill, trigger bypass for one statement, assertions |
| `supabase/migrations/20260917180100_backfill_legacy_lead_profiles.sql` | F3 idempotent profile backfill, assertions |
| `supabase/migrations/20260917180200_owner_bootstrap.sql` | F2 `owner_provisioning_log`, `bootstrap_owner`, revokes, assertions |
| `supabase/migrations/20260917180300_legacy_administrators_upgrade_guard.sql` | F2 halt / demote-and-log / assertion |
| `supabase/schemas/01_tables.sql`, `02_functions.sql`, `05_policies.sql`, `06_grants.sql` | Declarative parity for the table, function, RLS and revokes |
| `.github/workflows/database.yml` (new) | The one live-database gate, with the upgrade replay |
| `.github/workflows/check.yml` | Inline database job replaced by a call |
| `.github/workflows/deploy.yml` | `database` caller; `deploy-supabase` needs `[gate, database]` |
| `scripts/production-scope-database-gate.mjs`, `scripts/production-scope-workflow-reader.mjs` (new); `scripts/production-scope.mjs` | Static gate rule, wired into the repository check |
| `scripts/run-db-upgrade-test.mjs` (new); `package.json` | `npm run test:db:upgrade` |

No historical migration was edited, and the seal is unchanged. No dependency was added.

## 8. Regression tests

| Test | Where it runs | Covers |
| --- | --- | --- |
| `scripts/run-db-upgrade-test.mjs` + `supabase/tests/upgrade/{legacy_fixture,halted_assertions,operator_bootstrap,upgrade_assertions}.sql` | database gate (`test:db:upgrade`) | F1, F2, F3 on legacy data |
| `supabase/tests/owner_provisioning.sql` | `test:db` | F2 owner path, `is_admin()` conditions |
| `supabase/tests/crm_data_invariants.sql` | `test:db` | F3 and F1 steady state, and the triggers behind them |
| `supabase/tests/referenceData.mjs` (`--without-seed`) | database gate | No owner shipped by migrations |
| `scripts/test/run-db-upgrade-test.test.mjs` (17) | `claude` project (CI and deploy gate) | Which database the replay may reset; the fixture base; the only accepted halt; replay order |
| `scripts/test/production-scope-database-gate.test.mjs` (9 cases, each over many mutated copies of the real workflows) | `claude` project | F4 gate rule, including a command-line run |
| `supabase/tests/securityInvariants.test.ts` | `functions` project | SI-40, SI-41, SI-42 (new); SI-25 marker moved to `database.yml` |
| `supabase/schemaReproducibility.test.ts` | `functions` project | The four new migrations must `raise exception` |

**Each regression test fails on the old behaviour:**
- U0, the whole unfixed chain, fails the replay ("the upgrade did not stop at the owner guard").
- U1, U3 and U5 re-create each unfixed finding individually and are each killed (§9).
- For F4, `needs: gate` alone is refused by the guard test.

## 9. Upgrade-data proofs

**Fixture** (loaded at `20260911130000` and self-checked):
- 5 users, created through the real signup trigger: 3 legacy administrators (one of them disabled), 1 operator, and 1 user whose metadata claims ownership;
- 1 company;
- 5 contacts with known dates, 3 notes, and the "no dates" case;
- 8 deals in every upstream stage, plus a custom stage and an empty one, with `updated_at` pinned;
- the tenant's legacy `dealStages`.

**Clean run:** `PASS upgrade replay: legacy data kept its meaning.` (41 s).

**Upgrade replay mutations (10/10 killed):**

| Mutation | Killed by |
| --- | --- |
| U0 all four Phase 1D.2 migrations are no-ops (the unfixed chain) | the upgrade did not stop at the owner guard |
| U1 no deal backfill | legacy deals lost their stage (all eight listed) |
| U2 deal backfill fires the trigger | the legacy deal backfill rewrote `updated_at` |
| U3 no profile backfill | contacts without exactly one lead profile (all five) |
| U4 trigger values copied literally | backfilled lead profiles hold the wrong values |
| U5 no owner guard | the upgrade did not stop at the owner guard |
| U6 guard promotes every administrator (the naive fix) | the upgrade did not stop at the owner guard |
| U7 guard halts but never demotes | sales roles after the upgrade are wrong |
| U8 guard demotes without a record | `owner_provisioning_log` does not hold exactly the bootstrap and the two demotions |
| U9 no bootstrap migration | the upgrade halted without the bootstrap function |

**Owner path mutations (15/15 killed):**
- the lock removed;
- the active-owner check removed, or made to ignore `disabled`;
- the isolation check removed;
- the confirmation, ban or disabled-user check removed;
- the log row removed;
- only `role` set;
- `SECURITY DEFINER`;
- EXECUTE granted to `authenticated` or PUBLIC;
- the log readable by `service_role`;
- `is_admin()` without `role = 'owner'`, or without `disabled = false`.

**Steady-state mutations (3/3 killed):** the trigger disabled; a contact inserted without a profile; a deal whose columns disagree.

## 10. Security impact

- **Better.**
  - A hosted database deploy can no longer run ahead of, or despite, the live security suites (SI-40).
  - The owner bootstrap deadlock recorded since Phase 0.5 (R7, ROADMAP Phase 1) is closed by a person-only, recorded path (SI-41).
  - An upgrade can no longer leave half-state administrators, which kept the `users` function's cross-user edit path while losing real administration.
  - Every contact's opt-out is recordable (SI-42).
  - `is_admin()`'s `role` and `disabled` conditions are now pinned by tests.
- **New surface.** One backend-only table and one function, both unreachable by `anon`, `authenticated` and `service_role`: proven by catalogue, through each role, and by mutation.
- **Not weakened.**
  - No grant, policy or `is_admin()` change.
  - No trigger left disabled; the trigger bypass in `180000` is asserted re-enabled.
  - `session_replication_role` is never used.
  - The migration guard reports 0 findings, and the seal and declaration are unchanged.
- **Known and unchanged** (SECURITY.md §4): `users`/`patchUser` ordering, `delete_note_attachments`, committed development secrets, and no secret scanning in the local loop.

## 11. Database reset, replay and reproducibility

All runs are on the isolated e2e stack (`--workdir .supabase-e2e`, loopback-only per `check:local-exposure`), with the migration copies verified identical to `supabase/migrations`.

| Step | Result |
| --- | --- |
| Upgrade replay (`npm run test:db:upgrade`) | PASS (41 s) |
| Clean reset with the seed | OK (34 s), 40 migrations through `20260917180300` |
| `npm run test:db` | **13/13** (was 11: + `owner_provisioning.sql`, `crm_data_invariants.sql`) |
| `npm run test:db:engine` | **181/181** in 28 files (120 s) |
| Migrations-only replay (`db reset --no-seed`) + `referenceData.mjs --without-seed` | PASS, including no owner and no provisioning record; `test:db` 13/13 on it as well |
| Seeded replay (`db reset`) + `test:db` | 13/13 |
| Schema reproducibility (`supabase db diff`, inspected, never applied) | See below |

**Schema reproducibility.** The diff emits no statement that creates, drops or grants on `owner_provisioning_log`.
- Beside the long-known noise (it wants to drop the migration-only `ops` schema, install `pg_net` and recreate three views), it re-emits `CREATE OR REPLACE FUNCTION` for 12 `public` functions. `bootstrap_owner` is one of them; the other 11 were not changed by this phase, which is the known phantom function-body behaviour.
- **Negative controls:** removing the revokes from the declarative copy made the diff emit `grant … to service_role`, and removing the table made it emit `drop table "public"."owner_provisioning_log"`. The parity check is therefore real.

**Research corrections applied** (from the completeness critic): a top-level `WITH … UPDATE … INSERT` is unclassifiable by the migration guard, so it moved into a DO block. The runner's CLI-shaped message tripped the scope guard, and its workdir environment variable collided with the CLI's own and with a guard rule, so it became a `--workdir` flag. The declarative schema was missing the new objects, and SI numbers were allocated once.

## 12. Build and guards

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | 0 errors; the 64 warnings are all in an untracked, git-excluded worktree copy (`.claude/worktrees/`) |
| Prettier on every changed file | all formatted, and each was formatted at base too |
| `npm run build` | exit 0 |
| `npm run scan:build` | 18 files, 0 blocking, 0 advisory |
| `node scripts/production-scope.mjs` | OK, including "every hosted deploy gated on the live database suites" |
| `node scripts/dev-signing-key.mjs` | OK |
| Vitest, all three projects (excluding the stray worktree copy) | **129 files, 2175 passed, 2 skipped**: `functions` 54 / 1421 (was 1414), `claude` 45 / 520 (+1 skipped), `app` 30 / 234 (+1 skipped) |
| Migration invariants and seal | included in `functions`: 0 findings, seal unchanged |
| Security invariants | 49/49 (SI-40 to SI-42 added; the document and the code agree) |

Local runs of the `claude` project pick up an ignored, stale copy at `.claude/worktrees/loving-mendel-123ece/` (54 failures). It is not part of the repository, CI never sees it, and it was left untouched.

## 13. Remaining blockers to main

1. **CI has not run this branch.** The owner pushes it, and CI must show green:
   - the new `🗄️ Database` caller in `check.yml`, including the upgrade replay on CI's Supabase CLI, which `npx` resolves unpinned;
   - the unchanged pre-existing reds (`e2e-test`, repo-wide Prettier) identical to baseline run 35220094426.
2. **`deploy.yml`'s new job graph cannot be observed before a push to `main`.** It is proven by reading and by the guard, not by a run.
3. **Branch protection** (repository settings): update required-check names if they are pinned.
4. **Before any real deployment**, not introduced here:
   - the owner bootstrap is a manual first-deploy step (PERMISSIONS.md §3);
   - SECURITY.md's open items (`users`/`patchUser` ordering, `delete_note_attachments`, committed development secrets);
   - the `users` function half-state paths (§4 residual);
   - the ungated makefile deploy target.
5. ~~**Owner decisions this phase made within its brief, reversible if the owner disagrees:**~~ *(Accepted by the owner 2026-09-17 as decisions F, G and H, §16.)*
   - B-strict over auto-promotion (§4);
   - preserving `updated_at` in the deal backfill (§3);
   - the evidence-based `acquired_at` fallback (§5).
6. **Rejected in the F4 fix round, with reasons:**
   - `make X=$Y` stays unreadable, because an override can change what a recipe runs;
   - `echo` arguments are still scanned, because command substitution flattens into them.

## 14. Whether Phase 2A may begin

**Not yet.** Phase 2A (synthetic lead triage pilot) is accepted in direction, and nothing in this phase changes its scope. It waits for:
1. this branch's CI result;
2. its own brief.

BASELINE Q8 still stands: synthetic data only until the owner decides it.

## 15. Classification

**READY FOR CI.**

## 16. Owner review (2026-09-17)

The owner accepts the three implementation choices of this phase. Push and Phase 2A both still wait.

### F — Legacy administrator upgrade: ACCEPTED

Historical `administrator = true` rows are **never** promoted to owner automatically: that flag cannot be treated as trustworthy evidence of ownership. The intended production upgrade is a deliberate **two-step operational procedure**:

1. the migration chain reaches the owner guard (`20260917180300`);
2. if no active owner exists and legacy administrators need resolving, the upgrade **halts**;
3. an authorised person holding the database credential runs the documented `public.bootstrap_owner` procedure for the chosen user;
4. the migrations resume, by running the same deploy again;
5. the remaining legacy administrator rows become operators, and each change is recorded in `public.owner_provisioning_log`.

A production deployment can therefore intentionally stop at this migration and must be resumed after the explicit bootstrap. The runbook says so first: [PERMISSIONS.md §3](PERMISSIONS.md), "Owner bootstrap". Weakening this into automatic promotion is rejected; the upgrade replay keeps that shape as mutation U6, and it must stay killed.

### G — Deal `updated_at`: ACCEPTED

The legacy deal-stage repair preserves each deal's existing business `updated_at`. A migration that repairs a representation must not manufacture a false business-interaction timestamp. `upgrade_assertions.sql` 1b and mutation U2 hold this.

### H — Lead profile `acquired_at`: ACCEPTED

For a missing historical lead profile, `acquired_at` is derived from the earliest trustworthy evidence the contact already holds (`first_seen`, else the earlier of `last_seen` and its first note), not from the migration's execution time; `now()` remains only the last resort. The requirements stand, each with its proof:

| Requirement | Proof |
| --- | --- |
| Never overwrite an existing lead profile | `NOT EXISTS` + `ON CONFLICT DO NOTHING`; the replay applies the backfill twice and the values hold |
| Exactly one profile per applicable contact | `upgrade_assertions.sql` 3a, `crm_data_invariants.sql`, the unique `contact_id` asserted by the migration |
| Reruns stay idempotent | the replay's second application (step 6/7) |
| Tenant boundaries stay intact | each profile is keyed to its own contact and scoped through `can_access_contact`; `upgrade_assertions.sql` 3c (the operator sees and changes only their own) |
| A derived value is documented as derived | §5, [ARCHITECTURE.md](ARCHITECTURE.md) (lead profiles), and the migration header |

### Scope boundary and the production-readiness gate

Phase 1D.2 is **not** expanded to fix unrelated historical backlog. These stay recorded for the production-readiness gate. They do **not** block this phase's CI, but where they apply they **do** block, or are risks to, a future real production deployment:

- the `users` edge function: `patchUser` ordering and the half-state administrator paths (§4 residual; SECURITY.md §4);
- `delete_note_attachments` (SECURITY.md §4);
- committed development-secret debt (SECURITY.md §4);
- the makefile deploy path, which does not use the database gate (§6.5; SI-40 caveat).

BASELINE **Q8** is separate and unchanged: no real patient message body, clinical text, psychotherapy information or health data may reach an LLM provider until the owner decides it.

**Classification after the owner review:** READY FOR CI. ~~Not pushed.~~ *(Pushed and CI VERIFIED, §17.)* Phase 2A not started.

## 17. CI verification (2026-09-17)

**CI VERIFIED.** The owner pushed `feature/pre-main-safety`; the remote HEAD is `c00082fbb8f9b40ccd7287c27d5b5497702a4879`, the commit reviewed here. [run 35247254334](https://github.com/yurizache-cpu/atomic-crm/actions/runs/35247254334) (`✅ Check`, run number 24, push event) completed with the overall conclusion `failure`, as the baseline did, because of the two historical reds below. Counts were read from the job logs.

| Path | Job / step | Result |
| --- | --- | --- |
| Migrations `20260917180000`–`180300` | `🗄️ Database` → start, both resets | applied each time |
| `test:db` | `🔒 RLS, tenant isolation and grant surface` | **13/13**, `owner_provisioning.sql` and `crm_data_invariants.sql` included |
| `test:db:engine` | `⚙️ Worker runtime, pooling and concurrency` | **181/181** in 28 files |
| Upgrade replay | `⬆️ Upgrade replay over existing data` (`supabase_db_atomic-crm-demo`, `--workdir .`) | **PASS**: all 7 steps; the owner guard halted the upgrade, the bootstrap ran, the resume, the replay and the assertions passed |
| Migrations-only replay | `🌱 Production-like replay (migrations only)` | PASS |
| Reference data without the seed | `🔎 Reference data without the development data` | PASS, including no CRM owner or administrator and no owner provisioning record |
| `test:db` after a clean reconstruction | `♻️` + `🔒 Same guarantees after the reset` | **13/13** |
| Unit projects | `🔎 Test` | all projects: **129 files, 2175 passed, 2 skipped**; `functions` **54 / 1421**; `claude` **45 / 520 + 1 skipped**; `app` 30 / 234 + 1 skipped (by difference) |
| Security invariants | `functions` | **49/49** |
| Migration guard and seal; schema reproducibility; RLS suite coverage; owner-session seal | `functions` | 131, 16, 22, 2 — all passed |
| Deploy gate guard | `claude`: `production-scope-database-gate.test.mjs` | 9/9, including the committed tree and the command-line wiring |
| Production scope guard | `claude`: `production-scope.test.mjs` (39), `production-scope-functions` (15), `production-scope-remote` (14) | passed; the tracked tree is clean |
| Signing-key guard | `claude`: `dev-signing-key.test.mjs` | 64/64, including the tracked-tree run |
| Upgrade runner | `claude`: `run-db-upgrade-test.test.mjs` | 17/17 |
| Typecheck | `🏷️ Typecheck` | success |
| ESLint | `🔬 ESLint` and the lint action's ESLint check | success |
| Build and secret scan | `🔨 Build` | success; `scan:build` 16 files, 0 blocking, 0 advisory |
| Prettier on Phase 1D.2 files | lint action's Prettier check | no annotation on any Phase 1D.2 file (see below) |

**The four Codex findings stay covered in CI:** deal stages by the upgrade replay (§1 of its assertions) and `crm_data_invariants.sql`; owner provisioning by the replay's halt and bootstrap, `owner_provisioning.sql`, the no-owner reference check and SI-41; lead profiles by the replay (§3), `crm_data_invariants.sql` and SI-42; the deploy gate by `production-scope-database-gate.test.mjs`, SI-40 and the `🗄️ Database` caller itself.

**Reds, classified (no new regression):**
- `e2e-test` — **B, historical.** The same 9 failures as the baseline's e2e job, test by test: `adminAccountManagerFilter` (2 cases) and `onboarding`, `userAddingATask` on chromium and Mobile Chrome, and `bulkContactTags` on chromium; 1 skipped in both.
- Prettier — **B, historical.** "2 errors" in both runs, on the same two files, neither touched by this phase: `src/components/atomic-crm/dataImport/sampleCsv.test.ts` and `src/components/atomic-crm/providers/commons/canAccess.test.ts`.

**Not observable yet:** `deploy.yml` runs only on a push to `main`, so its new `database` caller and `deploy-supabase`'s `needs: [gate, database]` are proven by reading and by the guard, not by a run. The check that used to be named "🗄️ Database security & reproducibility" is now reported as "🗄️ Database / 🗄️ Database security & reproducibility".

**Classification:** Phase 1D.2 **CI VERIFIED**. Nothing is merged. The production-readiness gate (§16) and BASELINE Q8 stand. Phase 2A is not started; it waits only for its own brief.
