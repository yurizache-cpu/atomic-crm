# ADR 0007 — Relationship to the chat-service launcher

**Status:** Accepted · **Date:** 2026-09-10
**Decided by:** delegated to the architect by the owner, 2026-09-10.

## Context

`harness.config.json:101-106` declares a `launcher` block:

```
"launcher": {
  "sessionDirEnv": "CHAT_SESSION_DIR",
  "turnSentinelDir": "/tmp/pty-sentinels",
  "postCheckoutScript": "/entrypoint-helpers/apply-app-variant.sh",
  "logsDir": "/chat-service/logs"
}
```

`.claude/rules/launcher-interface.md` names the consumer: *"CRM Builder's chat-service is the reference launcher"*, with four extension points and persona injection via `--append-system-prompt`. **None of that code is in this repository.**

An external product already drives this repo, and no part of the Phase-0 audit could determine what it is.

## Decision

**The Company OS supersedes CRM Builder's chat-service as the product. The `launcher` block is retained as inert development-harness configuration, and is NOT an integration constraint on the engine.**

The evidence settles this without needing to know what CRM Builder is:

1. `.claude/rules/launcher-interface.md` states the design intent directly — *"The harness core stays neutral: every launcher-specific fact is an extension point … each consuming hook is INERT when its point is unset"*, and *"a project with no managed launcher runs the harness with zero launcher coupling."*
2. All four extension points are development mechanics only: a session directory, PTY turn sentinels, a post-checkout script for the merger, and a log directory that earns a `bash-guard` redirect exemption. **None touches runtime business logic.**
3. Every reader of `CHAT_SESSION_DIR` is under `.claude/` — 20 files, all hooks, tests, scripts or rules. **Zero product code reads it** (verified by grep).

A configuration surface that only development tooling consumes, and that is inert by design, cannot constrain the architecture of the runtime.

## Alternatives

- **Design the worker API around chat-service.** Rejected: it would couple the engine to a system whose code is not in this repository and whose requirements are unknown.
- **Strip the `launcher` block and the launcher-aware hooks.** Rejected: pure churn. It costs nothing to keep, and removing it would break harness runs for anyone who *does* launch through a managed surface.

## Consequences

- Keep the block and the hooks exactly as they are.
- The Company OS is planned as the system of record. Nothing in the roadmap depends on chat-service.
- If the owner later wants CRM Builder to launch Company OS sessions, that is an **additive integration** against the worker's API — not a rearchitecture. Supersede this ADR then.
- The interim position below becomes the settled position.

## Position on `.claude/`

Treat `.claude/` as a **dev-time build system and pattern library**, not as the runtime orchestrator. Its identity comes from Claude Code hook stdin, its state is an ephemeral `/tmp` directory keyed by session id, and its unit of work is a git worktree — none of which can carry a production agent runtime.

Port the shapes it proves out; do not port the substrate:

| Pattern | Where | Caveat |
| --- | --- | --- |
| Maker-checker gate | `.claude/hooks/block-merger-without-review.mjs` | Exits 0 when it cannot identify a ticket — **fail-open**. Invert. |
| Circuit breaker | `.claude/hooks/circuit-breaker.mjs:27` (`ITERATION_LIMIT = 45`) | Per-subagent, file-backed under `/tmp`. |
| Model router | `harness.config.json:84-97` | Maps eight roles to opus/sonnet/haiku. |
| Capability manifest | `.claude/adapters/supabase/manifest.json` | The closest prior art to `CRMProvider` in the repo. |
