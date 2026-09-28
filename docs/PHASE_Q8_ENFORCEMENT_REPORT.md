# BASELINE Q8 — enforcement batch report

**Status:** implemented locally on `feature/q8-real-data-authorization` (from `feature/clinical-phase-1` at `156977dd`, after the ADR 0020 decision packet `0b4f66f3`); broad local validation green; **owner review checkpoint pending**. Not pushed, not merged.
**Decision record:** [ADR 0020](adr/0020-real-data-model-authorization.md), with the owner decisions D1–D10 of 2026-09-27 in its §H.
**Real patient model traffic: STILL DISABLED.** This batch builds the enforcement, not a production enablement.

## 1. The gap this closes

Q8 was held at ingress and by convention. `ops.start_agent_run` checked the kill switch, the price and the spend limits, and nothing about the data. So a task created directly with real text, followed by a requested run, would have reached the configured provider. The gate now sits at the model boundary itself, fails closed, and holds whatever the ingress does.

## 2. What was built

- **Classification:** `ops.tasks.data_class` is a closed vocabulary: `synthetic`, `test`, `operational`, `identifier`, `person_text`, `health`, `clinical_record`, `derived` and `unclassified`. It is set from provenance and immutable (SI-71).
- **Registered test senders (D8, owner review correction):** `ops.communication_test_senders`. **A test channel is not test data:** a person's message is `test` only from a sender the owner registered on a configured test channel.
- **Authorization:** `ops.model_data_authorizations` holds versioned, tenant-scoped owner data. It is RLS-forced with no grant, immutable except for one retirement, and never written by a migration.
- **The check:** `ops.model_data_authorized` is the one check, built on `ops.model_data_authorization_in_force`, with `ops.model_data_class_admissible` for the early refusal.
- **Where the gate runs:** in `ops.start_agent_run` (the authority), in `ops.request_agent_run` (early, on the record, with no job) and in `ops.start_shadow_decision`.
- **Run audit:** `ops.agent_runs.data_class` and `data_authorization_id`, plus the new database-only refusal code `data_not_authorized`.
- **Guard on every write path:** the run guard enforces the gate even on an owner's raw `UPDATE`.
- **Owner CLI:** `npm run ops -- data-auth list | record | retire`. SI-39 is extended with these two acts.
- **Minimisation:** the lead-triage input builder has a field allowlist and redacts structured identifiers (prompt version `lead_triage.v2`).
- **Invariants:** SI-70 (the gate) and SI-71 (immutable classification), both with SQL, driver-backed and static guards.

One forward migration: `supabase/migrations/20261001120000_model_data_authorization.sql`. It adds no dependency, no job kind, no worker capability and no browser function.

## 3. Where the authoritative deny happens

`ops.start_agent_run` runs lease-bound, as the worker's `SECURITY DEFINER` capability, in this order:

1. Kill switch: a stop answers `stopped`, writes nothing and holds the run. This is owner decision B, and it comes first.
2. Task and organisation state.
3. **The data gate:** `ops.model_data_authorized(tenant, task.data_class, run.capability, provider, model)`.
4. Route policy.
5. Price.
6. Spend reservation.

A miss sets the run to `cancelled` / `refused` / `data_not_authorized`. It records no provider fact, price or reservation, and there is no retry and no fallback to another provider. The worker commits that before any call and calls only on `running`, so the provider is never reached (proven by counting calls in `engine/domain/modelDataAuthorization.dbtest.ts`).

The run guard (`ops.guard_agent_run_update`, `ENABLE ALWAYS`) repeats the rule on **every** write path. A `pending → running` transition of data that is not exempt must carry the `data_authorization_id` that is in force for its exact binding. A synthetic, test or fake run must carry none. The authorization is then fixed on the run.

`ops.request_agent_run` refuses earlier: after the stop check, a class that no provider is authorized for, for this capability, is cancelled on the record with no job. The one exception is a request that pins the run to the in-process provider `fake` (the only pin): it needs no authorization and keeps its class, and the start refuses any other provider for that run as `route_provider_mismatch`, so switching the route to an external provider immediately needs the matching external authorization. The ingress checks (the synthetic flag, the closed production WhatsApp gate, the shadow's origin gate) stay as defence in depth; none of them is the authority.

## 4. Authorization semantics

A version matches only when **all** of these hold. There are no wildcards and no fallback:

- tenant, data class, capability (the purpose), provider and model are each equal to the run's;
- the version is not retired, and `valid_from <= now() < expires_at` on the database clock;
- for person content, the tenant owns the local CRM (D1).

**Exempt:** `synthetic` and `test` (their existing rules), and the in-process provider named exactly `fake`, from which nothing leaves the process. A deployed worker cannot select the fake (`routingConfig.ts`). **Absence denies.**

**Never authorizable:** `identifier`, `clinical_record`, `derived` (authorized as its source's class) and `unclassified`. A provider named `fake` is refused too, because it needs no authorization.

**Person content** (`person_text`, `health`) needs:

- the tenant that owns the local CRM (D1);
- a capability whose input is minimised (`ops.person_content_capabilities()`, today `lead_triage`), so no authorization can open a path that sends identifiers unredacted;
- every reference: contract coverage, DPA, zero data retention or an owner-approved equivalent, verified retention behaviour, the international-transfer mechanism and the lawful basis (D4, D5, D9);
- `training_excluded = true`;
- `content_retention_days` between 1 and 30 (D6).

**Every version needs:**

- a provider/project/model evidence reference and its verification instant;
- `valid_from >= evidence_verified_at`;
- `expires_at <= evidence_verified_at + 366 days`, which forces re-verification (the ADR 0017 price pattern).

**References are pointers:** 1 to 200 printable characters with no spaces. Prose such as "the patient agreed on the phone" is refused.

**Versioning:** recording the same values again returns the version in force. Different values supersede it: the old version is retired with `superseded`, on the record, under a per-binding lock. Retiring takes effect at the next start; a call already in flight cannot be recalled. A version in force is never deleted. A retired version that no run relied on is history the owner may delete; the runs' foreign key keeps any version that was relied on.

## 5. Data classification

A class comes **from provenance, assigned by trusted server code**, never from a payload, the browser or content inspection:

| Source | Class |
| --- | --- |
| Synthetic ingress (`source_kind = 'synthetic'`) | `synthetic` |
| WhatsApp message on an owner-configured **test** channel **from a registered test sender** (D8) | `test` |
| Any other free text a lead or patient wrote (D3), **an unknown sender on a test channel included** | `health` |
| `ops.create_task` naming a class (owner credential, trusted server code) | that class |
| `ops.create_task` naming none | `unclassified` (denied) |

- **Test channel != test data (D8):** a test number can be written to by anyone, so the channel alone proves nothing. The registration is owner data (`ops.register_test_sender`, `ops.retire_test_sender`): tied to one test channel, retired once, never a migration row, unreachable from the browser. The sender is the provider's signed attestation in the webhook, never a value in the message. Nothing reads the content to downgrade it.
- **Immutable:** an `ENABLE ALWAYS` trigger refuses any change of `ops.tasks.data_class`, the owner's included. The same idempotency key under another class is refused, never answered with a task of the wrong class.
- **The run's class:** an agent run takes its class from its task in the insert guard (the caller's value is ignored) and keeps it for life.
- **Backfill:**
  - an open admitted task took `synthetic` from the synthetic ingress, and `health` from WhatsApp, because no test sender can be registered before the migration;
  - a closed task is immutable, can never run again, and stays `unclassified`;
  - unfinished runs took their task's class;
  - finished runs recorded before this gate carry none.

## 6. Minimisation — NOT anonymisation

The lead-triage input builder (`engine/models/leadTriage.ts`, `lead_triage.v2`) now sends:

- the agent's labels;
- the message, redacted;
- never the task's title or type (a directly created task could carry a name or a number there; found by the automated PR review), its priority or its due date.

Before truncation it removes, deterministically (`engine/models/identifierRedaction.ts`):

- e-mail addresses → `[email]`;
- URLs (`http(s)://`, `www.`) → `[url]`;
- formatted CPF-shaped numbers (`ddd.ddd.ddd-dd`) → `[cpf]`;
- phone-shaped digit runs of 8 to 15 digits, possibly separated by spaces, dots, dashes or parentheses and led by `+` → `[phone]`. An unformatted 11-digit CPF goes as `[phone]`. A bare date is kept; an order number or an ISO date-time goes with the phone rule, because over-redaction is preferred.

**This is not anonymisation.** Names, addresses, relatives and identifying stories stay in the text, because no deterministic rule can find them. The data keeps its class, so health text with its phone numbers removed is still health, and what a model derives from it inherits that class. The same builder serves synthetic data, so the synthetic pilot now sees the minimised document too.

## 7. Audit

**What is recorded:**

- **The run:** its `data_class`, the `data_authorization_id` it relied on (NULL when exempt), provider, model, capability, tenant, and the database's timestamps (`created_at`, `started_at`, `completed_at`).
- **A refusal:** `error_code = data_not_authorized`, carried as a code by the existing lifecycle event `agent_run.cancelled`.
- **An authorization version:** who recorded it and when (database clock), and who retired it, when and why. A superseded version says `superseded`.
- **`data-auth list`:** each version's status (`in_force`, `future`, `expired`, `retired`) at the database's clock, and how many runs relied on it.

**What is never recorded:** no message body, prompt, model output or evidence content enters an event, a refusal or an authorization. References point to the owner's records. The suite checks that no event of the tenant carries the task body. Append-only audit semantics are unchanged.

## 8. Evidence

All local, on the isolated e2e stack, with synthetic data and fake evidence references only. The in-process fake provider is the only provider called.

**Focused, while implementing:**

- the new SQL suite `supabase/tests/model_data_authorization.sql` passes; it covers sections A to L: absent, unclassified and never-authorizable classes; purpose, class and tenant binding; exact provider and model; retired, expired and future versions; stop before gate; exempt classes and the fake; privileges; immutability; the record's bar; the raw write path; the shadow start; the admission;
- the new driver-backed suite `engine/domain/modelDataAuthorization.dbtest.ts`: 6/6, through the real worker loop with provider calls counted;
- unit tests:
  - `identifierRedaction.test.ts`, `leadTriage.test.ts` and `companyOs.test.ts`: 59/59;
  - `operator.test.ts` and `operatorArgs.test.ts`: 126/126;
  - `modelDataAuthorizations.test.ts` and `dataAuthCommand.test.ts`: 22/22;
- the security invariants: 78/78.

**Broad, once at the end:**

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | 0 errors (64 warnings, all in an unrelated `.claude/worktrees/` copy) |
| `npm run build` + `npm run scan:build` | exit 0; 20 files scanned, 0 blocking |
| `vitest --project functions` (engine units, security invariants, migration guards) | 94 files, 2190/2190 |
| `npm run test:db:upgrade` (migration replay over legacy data) | PASS |
| `supabase db reset` (clean) then `npm run test:db` | 22/22 suites |
| `npm run test:db:engine` | 53 files, 397/397 |
| `scripts/production-scope.mjs`, `scripts/dev-signing-key.mjs` | OK |

- **Not run:** the e2e suite and the `app` and `claude` projects (the batch touches neither `src/` nor `.claude/`). The historical baseline stays e2e 9 failed / 1 skipped and Prettier 2 errors.

**D8 correction (owner review, focused and affected suites only):** the Q8 SQL suite gains section M (registered sender on a test channel → `test`; an unknown sender on the same line → `health` even when the message claims to be a test; a lead on a line with no registration → `health`; a retired registration → `health`; registration only on a test line, only by the owner, never through the browser) and asserts that the in-process fake keeps a `health` task `health`. The driver-backed suite gains the same-task case (refused before any call for a real-looking provider, then run on the fake relying on no authorization, still `health`): 7/7. After the patch, with a clean reset: `test:db` 22/22 suites; `test:db:engine` 53 files, 398/398 (397 before, plus that case); security invariants and the migration guards 344/344 (invariants 78/78); typecheck exit 0; ESLint on the changed files clean. The fixtures that admit WhatsApp test traffic now register their synthetic senders.
- **Fixtures changed:** existing fixtures that ran unclassified tasks now declare `synthetic` (they are synthetic by construction). Pins updated as reviewed changes:
  - the `create_task` signature;
  - the reserved error codes;
  - the `owns_local_crm` reader list (one new reader, `ops.model_data_controller_tenant`);
  - the SI-38 test name;
  - the SI-39 act list.

## 9. Security

- **New invariants:** SI-70 (no model execution for protected or unclassified data without the exact active authorization; nothing but the owner's credential authorizes) and SI-71 (immutable, provenance-assigned classification). SI-39 is extended with `data-auth record` and `data-auth retire` (D10).
- **P0:** none. **P1:** none.
- **Found and fixed during the batch:**
  - the retention CHECK accepted NULL, which SQL's three-valued logic lets pass;
  - the redaction order could leave half an e-mail address after truncation;
  - a REVOKE named the operator-surface role outside the pinned OD-8a migrations, which the static guard refused.

## 10. Real-data status

**REAL PATIENT MODEL TRAFFIC: STILL DISABLED.** No authorization is recorded, no provider configuration changed, Jev is untouched, and the ADR 0018 WhatsApp production gate stays CLOSED and independent. External gates that remain, each outside the code:

- **Contract coverage:** the provider contract must explicitly cover the intended sensitive health-data processing, under a DPA. The generic DPA is not assumed sufficient.
- **Zero data retention and provider evidence:**
  - ZDR approved and enabled for the exact organisation and project, or an owner-approved equivalent (`store:false` is not ZDR);
  - no training on API data;
  - verified retention behaviour, including abuse-monitoring logs;
  - the exact provider, project and model, and endpoint compatibility.
- **Lawful basis:** the evidence behind a versioned reference compatible with explicit consent. Receiving a message is not consent.
- **International transfer:** a documented valid mechanism for the provider relationship and jurisdiction.
- **WhatsApp (ADR 0018), where applicable:**
  - a new Accepted ADR (lawful basis for replying, consent and opt-in, retention and erasure of bodies and numbers);
  - the live Meta test probe;
  - the PUBLIC CRM helper decision.

Only once those exist can one owner `data-auth record` name them, and even then only for `lead_triage`, only for the tenant that owns the local CRM and only for one exact provider and model.

## 11. Choices for the owner's review

1. **Person content is bound to minimising capabilities.** A health authorization can name only `lead_triage`, the one capability whose input is minimised. It is a structural reading of D2 ("explicitly authorized purposes such as lead triage"). Widening it needs a builder that minimises, and a reviewed change of `ops.person_content_capabilities()`.
2. **D1 is enforced structurally.** Person content can be authorized only for the tenant that owns the local CRM. A second tenant needs D1 reopened.
3. **The shadow start's purpose is the job kind,** which no authorization can name. Only synthetic, test or the in-process fake ever reaches a decision provider, so Jev cannot be authorized by this mechanism.
4. **Minimisation applies to synthetic data too** (`lead_triage.v2`), so there is one code path.
5. **A retired version is deletable only while no run relied on it,** following the spend-limit pattern.
6. **Legacy rows:** closed tasks stay `unclassified`, and runs finished before the gate carry no class.
7. **Resolved at the final review: in-process runs are pinned.** A request may pin a run to the in-process provider; it then needs no authorization, keeps its class and cannot start on any other provider. An unrelated authorization no longer plays any part in local fake tests.
8. **Resolved at the final review: the browser trusts the class, not the channel.** A review is browser-decidable, its advice shown in the browser and its decision-shadow input built only when its task is `synthetic` or `test`. A `health` review from a test line stays out of that scope even when a valid authorization let its run succeed.
9. **Registering a test sender is an owner SQL act** (`ops.register_test_sender`, `ops.retire_test_sender`), like the commercial bridge's configuration; no CLI command yet.

## 12. Next

- **The owner review checkpoint:** read ADR 0020 §H against this report, and accept or amend the record.
- **Not started:** the retention and redaction batch (D6, D7), registered test senders (D8), any OpenAI production authorization.
