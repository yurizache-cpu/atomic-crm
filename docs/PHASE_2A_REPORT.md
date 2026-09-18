# Phase 2A — synthetic lead triage pilot

| | |
| --- | --- |
| **Base** | `feature/clinical-phase-1` at `d2843913b7dc61dff67bfe30f7231593ba705176` |
| **Branch** | `feature/phase-2a-synthetic-triage` |
| **Date** | 2026-09-17 |
| **What it is** | The first end-to-end Company OS workflow: a synthetic inbound message becomes one task, one agent run, one advisory result and one human decision. |
| **Data** | **Synthetic only.** BASELINE Q8 is open and unchanged; no real message, patient or clinical text is used, and the database admits no other source kind (SI-44). |
| **New dependency** | **None.** `package.json` gains one script and no package. |

---

## 1. What exists now

```
synthetic delivery
   │  CommunicationPort.receive  — parses, refuses, adds no scope
   ▼
InboundMessage  (no tenant, no company, no agent: those come from configuration)
   │  ops.admit_inbound_message  — ONE transaction
   ├── ops.inbound_messages      the admission ledger (identity + fingerprint)
   ├── ops.create_task           type `lead_triage`, the body as its description
   ├── ops.assign_task           to the triage agent
   ├── ops.request_agent_run     capability `lead_triage`, standard route
   └── two facts                 communication.received, lead_triage.admitted
   ▼
ops.jobs  (kind `agent_run.execute` — the kind that already existed)
   │  the Phase 1D/1D.1 runtime: kill switch, price, spend limits, at-most-once
   ▼
ops.agent_runs → succeeded, with a result the DATABASE re-validated
   │  AFTER UPDATE trigger, in its own subtransaction (a failure never undoes
   │  the settlement; `triage recover` opens it later — §15)
   ▼
ops.review_items  pending
   │  npm run ops -- triage list | show | accept | reject | needs-edit
   ▼
a person decides, once, and the decision is final
```

Nothing continues past that arrow. Accepting records approval; it sends nothing
and writes nothing to the CRM, because neither path exists (§8).

## 2. Architecture, and what it deliberately reuses

The whole phase adds **one capability, two tables, three services and one
trigger**. Everything else is the engine built in Phases 1A–1D.1:

| Concern | Reused, unchanged |
| --- | --- |
| Execution | `ops.jobs`, the three-transaction lease, `agent_run.execute` — **no new job kind** |
| Model call | `ops.request_agent_run`, `claim_agent_run`, `start_agent_run`, `complete_agent_run`, the six worker capabilities, the `external_call` shape |
| Governance | the kill switch, versioned prices, spend limits, reservations, `indeterminate` semantics |
| Idempotency | `ops.create_task` and `ops.request_agent_run`'s tenant-scoped keys |
| Tenancy | composite keys, FORCE RLS, `ops.current_tenant_id()` from a live lease |
| Operator surface | `npm run ops`, its read-only-by-default transaction and its output rules |

The one change inside the runtime is that `engine/handlers/agentRunExecute.ts`
no longer names a single capability: it looks one up in
`engine/models/capabilityContracts.ts`, which maps a capability to its prompt
builder and its output contract. A capability the database offers and this map
lacks is refused as `capability_unsupported` and recorded — nothing is guessed
at, and nothing is called. A driver-backed test asserts the map and
`ops.agent_run_capabilities()` agree.

## 3. Schema

`supabase/migrations/20260917190000_lead_triage_pilot.sql`, and the pre-push
review's fix `supabase/migrations/20260918090000_lead_triage_review_recovery.sql`
(§15). Forward only; no sealed migration is touched.

**`ops.agent_run_capabilities()`** gains `('lead_triage', 'standard')`.

**`ops.agent_run_result_valid()`** gains the `lead_triage` branch: exactly eight
keys, three bounded enums, three bounded strings, a boolean, and at most five
flags with no repeats. It still refuses a `task_assessment` result for a
`lead_triage` run and vice versa — the migration asserts both directions.

**`ops.inbound_messages`** — the admission ledger, and nothing more:
`(tenant_id, source_kind, external_message_id)` unique; `contact_ref`;
`do_not_contact`; `body_fingerprint` (sha256 of a jsonb array of source kind,
sender and body — injective since the fix); `received_at`; the `task_id` and
`agent_run_id` it became. **It holds no message body.**

**Where the body lives, stated plainly.** `ops.tasks.description` holds the
synthetic inbound body, because that is what `ops.claim_agent_run()` builds the
prompt from — one copy, in the row the runtime already bounds, fingerprints and
share-locks. It is traced and absent from every other place (§15, Target D).
**Real-message retention and minimisation must be revisited before Phase 2B and
before Q8 is resolved:** a real body in a task description is health data in a
general-purpose work table, and erasure, retention and access must reach it.

**`ops.review_items`** — one advisory result awaiting a person: the run it came
from (unique), the result as it was when the run succeeded, the consent state
carried from the admission, a status, a reviewer, a note and two timestamps.

Both tables: RLS enabled and forced, **no policy and no grant** — no application
role holds anything on either, and the operator reads them as the owner.

## 4. Ingress semantics

- **Transport.** `CommunicationPort` has exactly one method, `receive`. There is
  no `send`, and a unit test asserts the port's key set.
- **Off by default.** `createSyntheticCommunicationPort` throws unless
  `COMPANY_OS_SYNTHETIC_INGRESS` is exactly `enabled`. `true`, `1`, `yes`, `on`,
  `ENABLED` and a padded ` enabled ` all leave it off, each with its own test.
- **No network surface.** No edge function, HTTP route or webhook reaches it.
  The only callers are a local CLI and the test suite.
- **Tenancy is not in the envelope.** `InboundMessage` carries no tenant,
  company or agent; a delivery naming one is refused as an unknown field. The
  scope comes from `CommunicationTarget`, built from trusted configuration.
- **Consent is not the envelope's to state** (fixed in the pre-push review). The
  delivery has no consent field and one that tries is refused; consent comes
  from a `ContactPolicy` the caller trusts — in Phase 2A a synthetic fixture
  built from trusted configuration (`syntheticContactPolicy.ts`). Only an
  explicit "eligible" makes a contact contactable; unknown contacts, a policy
  that answers anything but `false`, and an omitted database argument are all
  do-not-contact. **Phase 2B must replace the synthetic policy with a read-only
  CRM lookup** of `lead_profiles.do_not_contact`, behind the same interface.
- **Bounds.** Printable-ASCII ids and contact references up to 200 characters, a
  body of 1–4000 characters that is not all whitespace, `received_at` not in the
  future.
- **Idempotency, three deep on one identity**: the ledger's unique key,
  `create_task`'s key, `request_agent_run`'s key — all derived from the same
  `inbound:<kind>:<sha256 of the id>`. A redelivery is a **lookup**: it answers
  with the task and run the message already became and runs nothing else, so it
  converges whatever has happened to the task or the agent since. Two concurrent
  deliveries converge (the loser waits on the winner's row, measured). The same
  id with a different body or a different sender is refused (`OS409`), and
  nothing is created.
- **The task title is a constant** (`Lead triage`): the title reaches the prompt
  and every listing, and the sender's reference stays in the ledger.

## 5. Review semantics

- A review item is **derived**, never written by the worker or the ingress: an
  `AFTER UPDATE` trigger on `ops.agent_runs` opens it (through
  `ops.open_review_for_run`) when a `lead_triage` run settles `succeeded`. A run
  that fails, is refused, or answers outside its contract opens nothing.
- **The settlement never waits on the queue** (fixed in the pre-push review).
  The derivation runs in its own subtransaction: if it fails, the run still
  commits `succeeded` with its result, the job completes, and nothing can call
  the provider again. `npm run ops -- triage recover` (`ops.open_missing_reviews`)
  opens the missing review from the stored result, once.
- One review per run (`review_items_run_key`), and a finished run cannot be
  settled again, so a second review is unreachable from both directions.
- `pending → accepted | rejected | needs_edit`, once. The same person recording
  the same decision again is a no-op (`recorded: false`), not a second fact. Any
  other change is refused, by the function and by the guard trigger.
- **Consent.** Accepting is refused unless the admission's trusted source said
  the lead may be contacted; rejecting is always available. The consent is found
  by **task**, so a retry of the run (or any later run on the task) inherits it,
  and a `lead_triage` run on a task no admission created is do-not-contact.
  Phase 2A sends nothing, so this closes the loophole *before* the transport that
  could exploit it exists.
- `needs_human_review` from the model is recorded and never trusted: every
  successful run is reviewed regardless.

## 6. The agent

`lead_triage`, standard route, prompt version `lead_triage.v1`. Commercial
intake triage of one message — not clinical work. The instructions forbid
diagnosis, naming or suggesting a condition, psychological or medical advice,
and clinical risk assessment, and give it one escalation lever: the
`possible_crisis` flag, which means "a person should look now" and is explicitly
not an assessment. The draft reply is a draft, written in the message's own
language, promising nothing.

Output (strict, validated three times — provider JSON schema, zod, database):
`outcome`, `summary`, `intent`, `priority`, `recommended_next_action`,
`response_draft`, `needs_human_review`, `flags`.

## 7. Governance is inherited, not re-implemented

The ingress never calls a provider. The only path is
`task → request_agent_run → job → runtime → externalCall → provider`, so the
pilot inherits every gate, and the driver-backed suite proves it rather than
asserting it:

| Gate | Observed |
| --- | --- |
| Kill switch, before admission | the run is `cancelled` / `execution_stopped`, **no job**, no provider call, no review |
| Spend limits | a budget too small refuses the start; provider calls stay at 0; no review |
| Output contract | a valid-JSON answer to the wrong contract → run `failed`, `result` null, **no review** |
| Provider failure | `indeterminate`, no review, no retry of the call |
| Redelivery | three deliveries, one provider call |
| Missing configuration | without a price, ceiling and budget the run is refused — observed live in the demo |

## 8. CRM and outbound boundary

- **No outbound transport exists.** `CommunicationPort` has no `send`; no code
  path in the repository can emit a message.
- **No CRM write path exists.** The worker holds six capabilities
  (`CAPABILITY_NAMES`, pinned by a test); none touches `public.*`. The pilot adds
  none. The end-to-end test counts `public.contacts` before and after and asserts
  it is unchanged.
- The pilot uses a **synthetic contact reference**, not a CRM key, so it also
  adds no FK from the engine into `public.*` (CLAUDE.md rule 1). Wiring a real
  contact, read-only and behind a port, is Phase 2B's work.

## 9. Operator surface

`npm run ops` gains six subcommands, following the tool's conventions exactly
(flags, never positionals; read-only transaction for reads; the decision is the
subcommand, so there is no `--decision` to mistype):

```
npm run ops -- triage list [--tenant <uuid>] [--status <status>] [--limit <n>]
npm run ops -- triage show --id <uuid> [--tenant <uuid>]
npm run ops -- triage accept|reject|needs-edit --id <uuid> --tenant <uuid> --reviewer <label> [--note <text>]
npm run ops -- triage recover [--tenant <uuid>] [--limit <n>]
```

`triage recover` (pre-push review) opens the review of any succeeded
`lead_triage` run that has none — the case where opening it failed as the run
settled. It derives it from the stored result and opens nothing twice.

A listing never returns the advice; `show` does. Neither prints a connection
string, a key or a prompt. An item another tenant owns prints nothing at all.

## 10. Tests

After the pre-push review's fix (§15):

| Suite | Result |
| --- | --- |
| `supabase/tests/lead_triage_pilot.sql` (new; sections A–H) | 14 SQL suites pass in `npm run test:db` (was 13) |
| `supabase/tests/opsDataApiExposure.mjs` (Phase 2A presence checks added) | pass — REST and GraphQL, 5 credentials, 17 relations, 104 functions |
| `engine/domain/leadTriagePilot.dbtest.ts` (new, 20 cases) | `npm run test:db:engine` **202 pass** (was 181; +20 here, +1 capability mirror) |
| `engine/communication/syntheticIngress.test.ts` / `syntheticContactPolicy.test.ts` (new) | 33 / 6 |
| `engine/models/leadTriage.test.ts` (new) | 29 |
| `engine/domain/leadIntake.test.ts` / `reviewQueue.test.ts` (new) | 26 / 27 |
| `engine/cli` (extended) | 202 |
| Security invariants (SI-43, SI-44, SI-45 added) | 52 |
| `functions` unit project | 1563 |
| Upgrade replay (`npm run test:db:upgrade`), both Phase 2A migrations in the chain | pass |
| Typecheck, ESLint (0 errors), build, secret scan, production scope, signing key | green |

What the SQL suite proves: admission identity and conflict, tenant and company
scoping, the tenant-scoped nature of the identity, malformed input as typed
refusals that store nothing, the immutability of an admission and of a decision,
the consent refusal, and that no application role can reach either table or
either service. What the driver-backed suite proves: the whole path with a real
worker and counted provider calls.

## 11. Demonstration

```bash
COMPANY_OS_SYNTHETIC_INGRESS=enabled npm run lead-triage:demo
```

Local and manual only (no CI job runs it), fake provider only — there is no
`--live`, because Q8 is open. It refuses to start while any job is queued or
leased, and while the two connection strings do not name the same local
database. Observed output, 2026-09-17:

```
{"step":"ingress","accepted":true,"sourceKind":"synthetic","externalMessageId":"demo-…","inboundMessageId":"…","providerCalls":0}
{"step":"work","taskId":"…","agentRunId":"…","capability":"lead_triage"}
{"step":"executed","status":"succeeded","modelRoute":"standard","provider":"fake","model":"fake-model-1","promptVersion":"lead_triage.v1","inputTokens":120,"outputTokens":60,"errorCode":null,"providerCalls":1}
{"step":"triage","advice":{…outcome, summary, intent, priority, next action, draft, flags…}}
{"step":"review","reviewItemId":"…","status":"pending","doNotContact":false}
{"step":"decision","reviewItemId":"…","status":"accepted","recorded":true,"reviewer":"demo operator","reviewedAt":"…"}
{"step":"audit","events":["communication.received","lead_triage.admitted","lead_triage.review_pending","lead_triage.reviewed"]}
{"step":"boundary","outboundMessagesSent":0,"crmRowsWritten":0,"transportsAvailable":["synthetic"],"note":"accepting a draft records approval and performs no action"}
```

The first run of the demonstration on an unconfigured database printed
`"status":"cancelled","errorCode":"spend_ceiling_unconfigured","providerCalls":0`
— the fail-closed governance of ADR 0017 working, unprompted. The demo now
configures a synthetic price and a 1 USD ceiling and budget where none is
active, exactly as `agent-runtime:smoke` does.

## 12. Privacy and Q8

**Q8 remains OPEN and is unchanged by this phase.** Everything here is
synthetic, and that is enforced rather than promised: the database admits only
`source_kind = 'synthetic'`, and the transport does not exist unless a person
turned it on in that process (SI-44). No real provider was called: the demo has
no live mode, and the environment has no provider configured.

What Phase 2B must answer before a real message arrives: the lawful basis and
retention period per data class, erasure that reaches the task description and
any derived summary, the processor roles per tenant, and the provider's
retention and zero-data-retention status. The message body living in
`ops.tasks.description` is the row an erasure request must reach; it is one row
per message, by design, so that it can be.

## 13. Known limitations

1. **No conversation model.** One message, one task. A second message from the
   same person is a second, unrelated admission. Threading is Phase 2B's, and
   deliberately not guessed at now.
2. **The contact is synthetic, and so is its consent source.** Consent comes
   from a trusted synthetic fixture (`syntheticContactPolicy.ts`); nothing reads
   `public.lead_profiles.do_not_contact` yet. The policy boundary is proven (a
   delivery cannot state consent, and an accepted decision is refused for a
   blocked lead), the CRM lookup is not built — **Phase 2B replaces the fixture
   with a read-only CRM lookup behind the same `ContactPolicy` interface.**
2a. **Consent is a snapshot taken at admission.** A later opt-out does not reach
   a message already admitted, and a redelivery is a lookup that does not
   re-ask. Harmless in Phase 2A because accepting performs no action; the
   acting side in Phase 2B must read consent again at the moment it acts.
2b. **A message admitted while a stop is active, or before prices and limits
   exist, is linked to a CANCELLED run** (ADR 0017 decision E: refused and
   recorded, no job). No review ever opens for it, and a redelivery returns the
   same cancelled run. Recovery is an explicit retry of that run
   (`request_agent_run` with `retry_of_run_id`), which inherits the lead's
   recorded consent. The admission result does not report the run's status;
   `npm run ops -- runs` does.
3. **`needs_edit` records intent, not an edit.** There is no edited draft to
   store, because there is nothing to send it to.
4. **The operator surface is a CLI.** No UI, by instruction.
5. **The review queue has no assignment, no SLA and no notification.** A person
   runs `triage list`.
6. **Deletion.** Neither new table has a delete guard: no application role can
   reach them at all, and the owner can delete a row exactly as it can delete an
   event or a task. Inventing a stricter rule only here would protect the
   pilot's rows more than the events the whole Company OS is audited by.
7. **Production-readiness gate (unchanged, from Phase 1D.2):** `users` /
   `patchUser` half-state administrators, `delete_note_attachments`, committed
   development-secret debt, and the makefile deploy path without the database
   gate.
8. **Found in review, deliberately not changed (P3):** `inbound_messages.agent_run_id`
   and `review_items.agent_run_id` carry no foreign key to `ops.agent_runs`; the
   `communication.*` and `lead_triage.*` facts are recorded through
   `ops.record_event`, so the owner could pre-record one (the settlement no
   longer depends on it, and recovery would surface the conflict);
   `emit_agent_run_event` includes the outcome in a run's event only for
   `needs_input`; and the pre-existing `supabase_read_only_user` (BYPASSRLS,
   `pg_read_all_data`) can read the new tables and `ops.tasks.description`, as it
   already could read every `ops` table.

## 14. What Phase 2B is expected to add

- The official **WhatsApp Cloud API** transport behind this same
  `CommunicationPort` (owner decision J), with its own `source_kind`, its own
  migration and its own webhook — and Q8 answered before it carries a real
  message.
- **Outbound**, with the consent gate on the acting side: what an `accepted`
  decision authorises must be decided explicitly at that point.
- A **real contact**, read-only, behind a CRM port — never a foreign key from
  the engine into `public.*`.
- Threading, if a second message from the same person must join the first.

## 15. Focused pre-push review (2026-09-18)

A narrow review of the Phase 2A diff only (`d2843913..35ea6c03`), by two
independent read-only reviewers — database surface; transaction semantics — and
live measurement. Every fix below is in ONE fix commit on top of the untouched
implementation commit, and every behavioural fix was proven red before it and
green after it.

**P1 — a review-queue failure discarded a paid answer (Target B).** The review
item was opened by a trigger in the same statement that settles the run, in the
transaction AFTER the provider call. Measured on the unfixed schema with the
queue forced to fail: the provider was called once (at-most-once held), but the
settlement rolled back, the run was left `running` (`expected 'running' to be
'succeeded'`), its next lease settled it `indeterminate`, and the valid answer
was lost with no recovery. **Fix:** the derivation (`ops.open_review_for_run`)
runs in its own subtransaction; a failure warns, the settlement commits with its
result, the job completes, and `npm run ops -- triage recover`
(`ops.open_missing_reviews`) derives the review later, once.

**P1 — consent could be supplied by the untrusted envelope (Target C).** The
synthetic delivery carried `do_not_contact` and the admission recorded it.
**Fix:** the envelope has no consent field and a delivery that tries is refused;
consent comes from a trusted `ContactPolicy` (a synthetic fixture now, a
read-only CRM lookup in Phase 2B); only an explicit "eligible" is eligible.
Proven: payload says eligible, trusted source says blocked → blocked is recorded
and acceptance is refused.

**P1 — consent failed open for a run the admission did not create** (found by
BOTH reviewers independently). The derivation looked the admission up by RUN and
defaulted to eligible, so a retry of a blocked lead's run — the very recovery
path an operator would use — opened an acceptable review. **Fix:** consent is
found by TASK (a retry inherits it), and a task no admission created is
do-not-contact. Both cases were red on the unfixed schema.

**P2, fixed (narrow):**
- A replay called `assign_task` and `request_agent_run` again, and converged
  only while the task was open and the agent active. A replay is now a lookup.
- Because a replay is now checked only by the payload fingerprint, the
  fingerprint was made injective (a jsonb array; the `|`-joined form could
  collide on a contact reference containing `|`).
- An external id of 174–200 characters passed every check and failed at the
  last statement; the idempotency keys now carry a hash of the id.
- The `communication.received` fact carried the payload fingerprint — a
  guessable hash of a short message and a known sender, in an append-only table.
  Removed; the ledger keeps it.
- The task title embedded the sender's reference (a phone number in Phase 2B),
  which reaches the prompt and every listing. It is now a constant.
- The database defaulted an omitted consent argument to eligible; it is now
  do-not-contact.

**P3, fixed because they were tests that could not fail or files that could not
be reviewed:** two privilege assertions compared `information_schema`'s grantee
with lowercase `'public'` (it reports `'PUBLIC'`), so a grant to PUBLIC could not
trip them — replaced by `has_table_privilege`; a literal NUL byte made
`leadTriage.test.ts` a binary file to git; `btrim` let an all-whitespace body
through at the database; the exposure probe had no presence check for the new
objects; SI-44 named no guard for its "no HTTP route" claim.

**New proofs.** G5 switches to each application role and attempts every pilot
service and table, accepting only a refusal AT THE DOOR (the schema, the
function or the table itself). Three mutants re-opening a door — an entry grant
to `anon`, a table grant to `PUBLIC`, an execute grant to `service_role` — are
each caught by name (G5, G1, G2). Concurrency is measured with two real
connections: two simultaneous deliveries converge on one task and one run; two
simultaneous conflicting decisions record exactly one (`OS409` for the second,
one `lead_triage.reviewed` fact).

**Measured, and not a problem.** No application role holds any privilege on the
new tables or functions, no default ACL exists on `ops`, `anon` and
`authenticated` have no `USAGE` on `ops`, and `service_role`'s `USAGE` is Phase
1A's (`20260912120000:540`) and reaches nothing new. Over HTTP, 16 targeted
probes (`anon` and `service_role`; REST with and without the `ops` profile, RPC,
GraphQL introspection) found no path (`PGRST106`, `PGRST202`, `PGRST205`, no
GraphQL type). Every new function is `SECURITY INVOKER` with `search_path=""`;
the trigger runs as the owner only because `ops.complete_agent_run` does, and
the worker controls nothing in the review but the already-validated result. The
inbound body is absent from every event (lifecycle facts included), every job
payload, every raised message and every listing — asserted by a test.

**Recorded, not changed:** §13 items 2a, 2b and 8.

---

**Classification: PHASE 2A IMPLEMENTATION COMPLETE — READY FOR REVIEW.** No
production deploy, no push, `main` untouched, and no new dependency.
