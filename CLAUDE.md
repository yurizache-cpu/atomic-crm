@AGENTS.md

# AI Company OS

Read this before doing anything. The repository is the project memory; conversation history is not.

| | |
| --- | --- |
| **What this is** | An AI Company OS being built **on top of** a fork of [Atomic CRM](https://github.com/marmelab/atomic-crm). Companies, departments, AI employees, workflows, events, tasks, decisions, reviews, approvals, permissions, risk policy, cost accounting and audit trails as first-class data. |
| **First tenant** | An online psychology clinic (Brazil, LGPD). A later tenant may be a 3D-printing business. |
| **Current phase** | **Phase 0 complete** (audit + documentation). Phase 0.5 not started. **No engine code exists yet.** |
| **Start here** | [docs/BASELINE_REPORT.md](docs/BASELINE_REPORT.md) → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) → [docs/ROADMAP.md](docs/ROADMAP.md) → [docs/DECISIONS.md](docs/DECISIONS.md) |

## The five rules that override convenience

1. **Atomic CRM is a replaceable adapter, not the foundation.** Business logic must never depend on Atomic CRM internals — no `ra-core` types, no PostgREST filter syntax (`field@ilike`, `tags@cs`), no view names (`contacts_summary`), no JSONB email/phone shapes, no bigint FKs into `public.*` from engine code.
2. **Nothing in the engine may be psychology-specific.** Tenant vocabulary — pipeline stages, department names, task types, loss reasons — is **data**, never DDL and never a prompt constant. The nine-value CHECK constraint on `deals` (`supabase/schemas/01_tables.sql:86-96`) is the mistake to not repeat.
3. **Deterministic code owns anything code can do reliably.** Arithmetic, permission checks, risk evaluation, budget checks, CRUD, state transitions, threshold detection. LLMs own language, interpretation, classification where rules are insufficient, analysis and recommendation.
4. **Fail closed.** Every gate denies by default. This repo's existing gates fail *open* — `providers/commons/canAccess.ts` ends in `return true`, and the harness approval hook exits 0 when it cannot identify a ticket. Port those shapes, invert the defaults.
5. **Functionality first.** Phase 1 UI is deliberately ugly: tables and cards. No animations, avatars, isometric environments or cosmetic refactors. Architecture, reliability, data integrity, security, observability, cost efficiency.

## Known issues — the working tree is currently broken

Verified 2026-09-10. Do not mistake any of these for something you introduced.

- **`npm run typecheck` fails (5 errors)** and **`npm run lint` fails (2 errors)**. All attributable to uncommitted work on `feature/clinical-phase-1`.
- **`npm run build` does not typecheck.** `tsconfig.json` is solution-style (`"files": []`), so the bare `tsc` in the build script compiles nothing. **`npm run typecheck` is the only real gate.**
- **The schema rewrite reaches no database.** All 7 files in `supabase/schemas/` are modified with **zero** migrations, and `supabase/config.toml` has no `[db.migrations] schema_paths`, so the declarative workflow `AGENTS.md:33` documents is not wired to the CLI.
- **A deployed instance is locked out.** `authProvider.ts:61` selects `sales.role`, a column in no migration → PostgREST 42703 on every login.
- **No code path can create the first owner.** `is_admin()` requires `role='owner'`; the trigger hardcodes `operator`; signup is off; `authenticated` has no INSERT on `sales`; the bootstrap UI was deleted.
- **`supabase db reset` fails** — `seed.sql:105` inserts into `loss_reasons`, which no migration creates. The e2e suite is red for this and two other reasons.
- **`deploy.yml` is not gated on `check.yml`.** A red build deploys to production.
- **47 unit tests fail** in the `claude` project (`.claude/hooks/test/*.mjs`) — Windows worktree/symlink incompatibilities in dev tooling. **Zero failures in `app` and `functions`.**
- **`make` is not installed on this machine, and `.husky/pre-commit` line 1 is `make registry-gen`.** Husky aborts with `pre-commit script failed (code 127)` and `npx lint-staged` never runs, so **no commit succeeds without `--no-verify`**. Verified empirically. Fix the hook (use `npm run registry:gen`, or drop the step per [ADR 0008](docs/adr/0008-fork-posture.md)) rather than normalising `--no-verify`. Use `npm run` / `npx` directly, never `make`.

## Commands

```bash
npm run typecheck                       # the ONLY real type gate
npm run lint
npx vitest run --config vitest.config.ts            # all three projects
npx vitest run --config vitest.config.ts --project app
npx playwright install                  # required once; browser-mode tests are blocked without it
npm run dev                             # against Supabase
npm run dev:demo                        # against FakeRest, no backend
```

Environment here: Windows 11, Node v22.23.1, npm 10.9.8, Docker 29.7.2, Supabase CLI 2.117.0. Docker and `node_modules` are both working — a prior audit that recorded them as blocked is out of date.

## What NOT to do

- **Do not hand-edit anything in `supabase/migrations/`.** Reconcile via a new generated migration.
- **Do not run `supabase db diff` casually.** The next diff emits one migration mixing the clinic pipeline, the 43-policy rewrite, the grants and the storage change. Packaging it is Phase 0.5 work, not a side effect.
- **Do not reformat `supabase/schemas/02_functions.sql`.** Function bodies must match `npx supabase db dump --local --schema public` exactly or every future diff emits phantom changes.
- **Do not repurpose `public.companies` or `company_id`** — they mean *CRM customer account*, not tenant. Introduce a distinct name.
- **Do not extend `public.tasks`** for engine work; `contact_id` is `not null` and it is a live CRM feature with e2e coverage.
- **Do not treat `activity_log` as an audit log.** It is a `UNION ALL` view over `created_at` columns that can only emit `<entity>.created`; a deleted row erases its own history.
- **Do not adopt `CrmDataProvider` as the CRM port.** It is `ReturnType<typeof getDataProviderWithCustomMethods>` — the Supabase implementation's own type — and both providers reach it only through an unsafe cast. Write the port by hand.
- **Do not refactor `.claude/`.** 30+ hooks depend on each other's `/tmp` state and git topology. Study it for patterns; leave it alone.
- **Do not rewrite `supabase/functions/mcp/validateSql.ts`.** It is incomplete but it is the only guard between a model and `DROP TABLE`. Extend it and its tests.
- **Do not enable the attachments bucket, Supabase realtime publications, or `[auth.oauth_server]`.** Each was deliberately closed.
- **Do not edit `docs/product/*.md`.** Untracked prior art in Portuguese, kept as a dated record. Supersede with a note instead.
- **Do not modify `src/components/admin/` or `src/components/ui/`.** They are inbound shadcn-registry content (`registry.json` lists 214 `atomic-crm` files and **zero** from those directories). `AGENTS.md` says otherwise; `docs/product/07-upstream-strategy.md` wins — see [ADR 0008](docs/adr/0008-fork-posture.md).
- **Do not commit secrets.** `.gitignore:42` deliberately un-ignores `supabase/functions/.env`; an EC private signing key is already tracked in `supabase/signing_keys.json`. Never let a provider key follow that path.

## Conventions

- **English** for source, docs, agent prompts, config keys and default config values (`.claude/rules/english-only.md`). Tenant-language vocabulary belongs in data, not code.
- New engine code goes **outside** `src/components/` — every file added under `src/components/atomic-crm/` is republished publicly via `registry.json` on every push to `main`.
- Structured, schema-validated outputs for every agent. Never parse prose. (Resolve the `zod` v4-app / v3-edge split before sharing schemas.)
- Every external action is idempotent. Every important action writes an audit row.
- Before a large change, read the relevant doc in `docs/`. After a large change, update it.
- Use targeted file inspection. Do not re-read the whole repository; that is what these documents are for.

---


# Agent Workflow

Code-change requests can run through the **agent harness**: subagents (planner, developer, quality-reviewer, merger, documentator) implementing the change via a deterministic foreground pipeline in git worktrees. **Opt-in, off by default;** otherwise the main thread implements the change itself.

**Dispatch rule (top-level session only).** Only on an opt-in (see "Opting in") does the top-level session dispatch the `orchestrator` and relay its result; never route or implement it yourself then. Pass your `<session_dir>` in the prompt (it namespaces worktrees/branches). A subagent NEVER dispatches an orchestrator (`block-nested-orchestrator` enforces it). The orchestrator owns all routing (SIMPLE/COMPLEX, plus SETUP/MEMORY/ROLLBACK-CONFLICT/RECOVERY, dispatch templates, waves, promotion, migration round) and drives the team to a terminal point. Each agent's last line is an output contract (`.claude/rules/agent-output-format.md`).

**"Launched" is NOT "done".** The dispatch is meant to block, but some runtimes (interactive Claude Code / the VS Code extension) return immediately with `Async agent launched … agentId: <id>` and deliver the result later as a `task-notification`. That ack means dispatched, not finished: do NOT fill the silence by implementing the feature yourself or re-dispatching (that duplicates the developer's work). While it runs, only surface progress, then relay the final report. On completion, before relaying, check `<session_dir>/needs-recovery` (written by `completion-invariant` when the orchestrator stopped with APPROVED-but-unmerged work): if present, dispatch a FRESH `orchestrator` with `<intent>recovery</intent>` and the same `<session_dir>` (never `SendMessage` the old one), wait, then relay.

**Resuming after a restart.** Closing the VS Code window / editor (or rebooting) between two harness steps kills the orchestrator's background process, but Claude Code reuses the SAME session id when you reopen the conversation, so the harness namespace (`<session_dir>`, `session/<short>` branch, worktrees) is unchanged. The gate pauses (plan gate, migration gate) are the exposed windows: the orchestrator has ended its turn and this thread is idle awaiting you, so a `task-notification` for the old (now dead) process will never arrive. Two things make resume work: (1) `cleanup-session` no longer deletes an in-flight session's state on a clean close, and (2) the `session-bootstrap` SessionStart hook detects in-flight state for the current session and injects a `<harness_resume>` banner naming the phase. When you see that banner (or the user asks to continue an interrupted harness), dispatch a FRESH `orchestrator` with `<intent>recovery</intent>` and the same `<session_dir>` (from the banner / the earlier turns), wait, then relay. NEVER `SendMessage` the previous orchestrator (it is dead) and never re-implement the work yourself. This is keyed on the current session id only, so a second concurrent window (its own session id) is never offered another session's work.

**PD-ASK round-trip (migration confirmation).** The orchestrator may end its turn asking *"apply the database migration now?"* (it does not under `gate=none`, which auto-applies; see "Gate level"). Relay it to the user; do NOT `SendMessage` the old orchestrator to relay the answer (relayed approvals carry no user authority, so it loops re-asking). On the reply:
- **Approved**: FIRST write `<session_dir>/migration-approval.json` = `{"kind":"migration-approval","session_id":"<id>","question":"<asked>","answer":"<user's verbatim reply>","approved_at":"<ISO-8601>","via":"AskUserQuestion"}` (the durable audit trail). THEN dispatch a FRESH `orchestrator` whose prompt begins `<intent>apply-migration</intent>`, states the approval, references that record, and passes the same `<session_dir>`. The built-in security warning on a relayed approval is expected.
- **Wants changes**: dispatch a fresh `orchestrator` with the new request.

While a fresh dispatch runs, don't start a parallel plan B; wait, then relay.

**Gate level.** A request may carry `gate=none|migration|plan|waves` (default **`plan`**); ALWAYS pass an explicit `GATE: <level>` line (the orchestrator also fails closed to `plan` on a missing/unknown value). There are two independent pause points: the **plan gate** (after planning) and the **migration gate** (before applying the deploy-time migration).
- `none`: fully autonomous. No plan pause, and it applies the migration itself with no confirmation.
- `migration`: pauses after planning for ticket review, and stops to confirm before the migration (same stops as `plan`; a named alias that states the migration stop explicitly).
- `plan` (default): pauses after planning for ticket review, and stops at the migration.
- `waves`: pauses after planning, after each wave, and at the migration.

On the web-chat surface (CRM Builder, `<mode>` tag present) the "save to your data?" confirmation is surface-owned and always shown regardless of gate; `none` auto-apply is a developer-surface behavior. On a plan pause, so the user reviews the REAL tickets (not just your prose summary) on ANY surface (desktop app, CLI, editor), **read the ticket JSONs from `<session_dir>/tickets/` and present each ticket's key fields inline** in the chat: id, title, `acceptance_criteria`, `files_to_modify`, `dependencies`. This inline rendering is the part that must ALWAYS be present (it does not depend on any editor layout). Additionally, offer an openable reference when you can: if a `.harness-session` symlink exists at the workspace root (the `link-session-workspace` hook maintains it in a VS Code multi-root workspace), link `[tickets](.harness-session/tickets/)`; otherwise just give the absolute `<session_dir>/tickets/` path. On approval dispatch a FRESH `orchestrator` with `<intent>execute-plan</intent>` and the same `<session_dir>` (never `SendMessage`); on "wants changes" dispatch a fresh one. CRM Builder's launcher sets `gate=none`.

## Opting in

Off by default. `#harness` (or "use the agent team" / "with the harness") routes through the orchestrator; "harness for this session" keeps it on all session.

**Grill vague requests first.** For a vague or broad `#harness` request, run `Skill({skill: "grill-me"})` in the main thread BEFORE dispatching (the planner never questions; `gate=plan` only reacts after a plan). Fold the answers into the dispatch prompt. Skip when the request is already precise.

`#technical-harness` is the same opt-in for a real developer: it appends a `PERSONA: technical` line (see `orchestrator.md` -> "`PERSONA: technical`"), which (1) uses the full technical register (file paths, `TASK-XXX`, git terms, `database`/`migration`/`Supabase`), (2) reports the mechanical truth (per-ticket status, branches, SHAs, verdicts, ADR paths), (3) stops at `session/<id>` (no promotion, no migration round; you promote and migrate yourself), and (4) appends every step to `<session_dir>/harness-progress.log`.

**Live progress (technical runs).** The report lands only at the end (possibly as a `task-notification`), so surface a live view WITHOUT flooding the chat with a raw log tail. The `render-status` SubagentStop hook renders `.harness/<SESSION_SHORT_ID>/{STATUS.md,TICKETS.md,status.json,session.diff}` (gitignored, per-session, cleaned at SessionEnd) from the live session state after every agent stop. **It does not exist until the first agent stops**, so during initial planning there is no board yet: do NOT present its path at dispatch (a link then is dead: "Couldn't read this file"). Relay it only from the plan-gate pause onward, once the files exist; at dispatch, just say the board will be available once planning completes. `STATUS.md` lists tickets (status + review verdict), live worktrees, a changed-files summary, and recent activity, updating itself as agents finish; `TICKETS.md` is the readable plan; `session.diff` is the actual code the harness changed (the extension does not surface the `/tmp` worktree diffs, so this file is how the user reads them). **Give a path that resolves in the user's client - always the ABSOLUTE path.** The board lives at `<repo>/.harness/<SESSION_SHORT_ID>/`. A bare relative `.harness/...` fails with "outside the working directory" on both the desktop app and a multi-root VS Code workspace, because the client resolves it from the workspace root, not the repo subfolder. So ALWAYS give the absolute path (`<repo>/.harness/<SESSION_SHORT_ID>/STATUS.md`): the desktop app's file pane opens arbitrary absolute paths, and it is the universal fallback. Markdown relative links to `.harness/...` (and to the `.harness-session/` symlink) are unreliable in the VS Code extension - observed: clicking does nothing - so do NOT rely on them. Give the ABSOLUTE path (the desktop file pane opens it, and it copy-pastes cleanly everywhere), and to put openable ticket CONTENT in the chat, `Read` the JSON: a `Read` renders a clickable file card that actually opens, which the plan-gate inline render already does. An opt-in compact statusline is available (`.claude/scripts/harness-statusline.mjs`; wire it in your own `settings.local.json`, see its header) - not committed, since it would override a personal statusline. It is **CLI-only** (the terminal statusline); it does NOT render in the VS Code extension or the desktop app, so on those surfaces use the board or the Monitor feed below. Dispatch the orchestrator with `run_in_background: true`. Prefer the board; for a live in-chat feed on ANY surface (extension / desktop / CLI), a `Monitor({command: "tail -n +1 -F <session_dir>/harness-progress.log", ...})` streams each NEW log line as a chat notification the moment it is written - now including the `[validate:TASK-XXX] typecheck…` / `… checks passed` step lines the `validate-on-stop` hook appends, so the minutes-long silent stretches between milestones (a developer's typecheck / lint / vitest / e2e) are visible instead of going dark. It is a line feed, not a rendered board, and is auto-rate-limited if the log is too chatty, so keep the log at milestone/step granularity. The authoritative end signal is the `task-notification`, not the log: on it, `TaskStop` any monitor, relay the report, and run `/harness-diff` on the session branch it stopped on.

## Agents

orchestrator (routes the harness, dispatched by the main thread), planner, developer, quality-reviewer, merger, documentator. Models: **planner** and **quality-reviewer** on opus, the rest on sonnet/haiku (see each `.claude/agents/*.md`). The web-chat variant is this orchestrator with a non-technical persona injected via `--append-system-prompt` (CRM Builder).

The **developer** is one agent, no modes: it implements a `TICKET_FILE` (COMPLEX wave, peer-reviewed, ADRs for structural decisions, never SQL during tickets) or an inline `CHANGE_REQUEST` (SIMPLE, on the shared `<base>/simple` worktree; refuses `FAILED: out of scope, needs COMPLEX flow` if it needs a breakdown). Two session ops reach it as dispatch-loaded skills on `<base>/simple`: `writing-migrations` and `resolving-rollback-conflicts`. It applies the **Ponytail** ladder (full mode) on every change (baked into `developer.md`; the quality-reviewer enforces it on the diff). Ponytail is also in-repo as `.claude/skills/ponytail*` / `/ponytail*` for interactive use (these do not affect the dev agents). An optional `test-writer` runs only when a ticket sets `separate_test_writer: true`.

## Rules & hooks

Mechanics live in `.claude/rules/` (worktree-scope, agent-output-format, validation-commands, lsp-usage, security-triggers, dependency-safety, launcher-interface). Project facts (validation steps, roles, deploy adapter, app smoke, launcher extension points) live in `harness.config.json`. Hooks in `.claude/settings.json` / `.claude/hooks/` are `.mjs` ES modules.
