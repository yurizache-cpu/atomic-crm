# ADR 0009 — Governance envelope: autonomy, risk, maker–checker–approver

**Status:** Proposed · **Date:** 2026-09-11

## Context

The brief's safety-critical half — autonomy levels 0–4, a `LOW|MEDIUM|HIGH|CRITICAL` risk taxonomy, maker→checker→approver, confidence-based routing, the human approval queue — exists only as prose in `ARCHITECTURE.md` §6. `DECISIONS.md` states this repository's own rule: *"Anything structural — a new pattern, a new dependency, a deliberate departure from convention, a non-obvious schema choice — gets an ADR."* The eight existing ADRs cover substrate, tenancy, identifiers, principals, `ra-core`, schema workflow, launcher and fork posture. **None covers the part of the system whose job is to prevent harm.**

That matters because this layer is the one a future session is most likely to erode under deadline pressure, one plausible shortcut at a time — and because two of its defaults were, until 2026-09-11, specified in a way that fails open:

- The risk engine had **no stated default for an action matching no rule**. The natural implementation of "evaluate against configurable rules" returns nothing and falls through to permissive. This repository already ships that exact shape: `providers/commons/canAccess.ts` ends in `return true`.
- **Confidence is self-reported by the maker**, and the routing table (`≥0.90` normal flow) let a maker emitting `0.95` route itself past its own checker for everything risk rated LOW or MEDIUM. "Risk overrides confidence" only rescued HIGH and CRITICAL.

Both are recorded here so that closing them is a decision with a rationale rather than an implementation detail someone can reopen.

## Decision

1. **Risk is data, evaluated by deterministic code.** The taxonomy lives in `ops.risk_policies` as seeded, versioned rows; `packages/policy` ships the *evaluator*, never the rules. The "inherently high/critical" list is tenant-shaped — *touching clinical data* means nothing to a 3D-printing tenant — and hardcoding it would repeat the `deals` CHECK mistake in the component that is hardest to change safely.
2. **An action matching no rule evaluates to `CRITICAL` and is refused.** Unmatched means unclassified, and "an unclassified action was attempted" is a visible event that earns a rule. Fail-closed applies to the risk engine before it applies to anything the risk engine guards.
3. **Whether a checker is required is decided by risk and autonomy level — never by the maker.** Self-reported confidence may only *escalate* review; it can never skip it. Confidence is recorded on `agent_runs` and calibrated against outcomes, so a miscalibrated agent is detected as a defect rather than trusted indefinitely.
4. **A checker is a different principal from the maker**, enforced in code, not convention.
5. **Every stage writes an audit row** — proposal, evidence, review, risk verdict, approval, execution, result — and the chain is reconstructable end to end.
6. **LOW-risk actions execute unasked and are merely visible.** Approval fatigue is a failure of the control, not of the owner: if the owner is asked about something trivial, the risk policy has a bug and gets a ticket.
7. **Human override exists at every autonomy level**, including 4.

## Alternatives

- **Model-evaluated risk.** Rejected outright. Risk classification is exactly the kind of rule-shaped judgement deterministic code does reliably and cheaply, and putting the gate inside the thing being gated defeats it.
- **Risk levels as a CHECK constraint / TypeScript enum.** Rejected for the tenant rules; accepted only for the four engine-owned level names themselves, which are genuinely engine vocabulary.
- **Permissive default with an allowlist of dangerous actions.** Rejected — it is the `canAccess` shape, and it fails silently in exactly the case nobody anticipated, which is the case that matters.
- **Trust calibrated confidence once measured.** Deferred, not rejected: revisit only with real calibration data, and never for HIGH or CRITICAL.

## Consequences

- Reviewers and the approval queue need a stable evidence snapshot: an approval is granted against specific evidence and must not be silently reusable for a changed proposal.
- A CRITICAL-by-default engine will be noisy on day one. That noise is the backlog of unwritten rules, and it is the intended cost — tuning happens by adding rules, never by changing the default.
- `ops.risk_policies` becomes tenant configuration with its own change-control and audit requirements; a policy row change is the rollback mechanism for a bad ruleset, which is the main argument for it being data.
- Phase 5 acceptance must include a fail-closed test per gate — in particular, that an unmatched action is refused rather than permitted.
