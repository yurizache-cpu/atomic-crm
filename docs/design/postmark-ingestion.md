# Design — Postmark inbound-email ingestion

**Status: DESIGN ONLY. Not implemented. Blocker for Phase 0.5 signoff.**
**Date:** 2026-09-11

A first implementation was produced in Phase 0.5 and **rejected** — see [PHASE_0_5_REPORT.md §2.4](../PHASE_0_5_REPORT.md). It shipped incomplete files, and its own control flow reintroduced a fail-open. This document keeps the parts that were sound so the redo starts from a reviewed design rather than from scratch.

---

## 1. Current failure behaviour (verified)

`supabase/functions/postmark/index.ts` calls `await addNoteToContact({…})` inside the recipients loop, **discards the returned value**, and then returns `new Response("OK")`.

`addNoteToContact` signals failure by *returning* a `Response`:

| Condition | Returns |
| --- | --- |
| Sales lookup failed | 500 |
| Sender has no active sales row | 403 |
| Contact/company creation failed | 500 |
| Note insert failed | 500 |

All four are swallowed. **Postmark sees HTTP 200**, never retries, and nothing durable records that a message was lost. An inbound email can vanish with no trace and no alert.

Two aggravating facts:

- **`MessageID` is never used.** Postmark supplies it on every request; the repo's only occurrences are a doc mention and a curl comment. There is no dedup, so a legitimate provider retry would create duplicate notes.
- The early guards (`index.ts:49-52, 88-92, 114-117`) return **403** on malformed input specifically to stop Postmark retrying. That is correct for permanently-invalid payloads and wrong for transient failures — but the code cannot currently tell them apart.

---

## 2. Desired semantics

The rule the current code gets backwards:

| Outcome | HTTP | Why |
| --- | --- | --- |
| Ingested, or already ingested (duplicate) | **200** | Success; a retry of an already-processed message must also be 200 |
| Permanently invalid (unparseable, no recipient, unknown sender) | **200** + durable failure record | Retrying cannot help. Returning non-2xx would create a retry storm for a message that will never succeed |
| Transient (database unreachable, insert failed, timeout) | **500** | The one case where Postmark *should* retry |
| Auth/signature rejected | **403** | Before any processing |

**Permanent failures return 200 and are recorded, not retried.** That is the distinction the current code is missing entirely, and it is why "return non-2xx on failure" is the wrong naive fix.

---

## 3. Idempotency

**Key: `MessageID`** from the Postmark payload — provider-supplied, stable across retries, unique per message. Nothing else in the payload is reliable.

A recipient fan-out means one message can produce several notes, so the unique key is **`(message_id, recipient_contact_id)`**, enforced by a unique index — not by a `SELECT`-then-`INSERT`, which races under concurrent delivery.

**Claim-before-work:** insert the ledger row first, in a `pending` state, and let the unique index reject a duplicate. If the insert conflicts, the message is already being handled or is done: return 200 without re-processing. Only the request that wins the insert does the work. This is a compare-and-set, and it is why the ledger is a table rather than a log.

---

## 4. Durable ingestion

There is no queue and no worker, and Phase 0.5 must not build one. The smallest mechanism that fits the current stack is **one table**:

```
inbound_emails
  message_id            text       not null
  recipient_contact_id  bigint     null      -- null until resolved
  status                text       not null  -- pending | ingested | failed_permanent | failed_transient
  attempts              int        not null default 0
  payload               jsonb      not null  -- the raw webhook body, for replay
  error                 text       null
  received_at           timestamptz not null default now()
  processed_at          timestamptz null
  unique (message_id, recipient_contact_id)
```

**The raw payload is stored.** Without it a failed ingest cannot be replayed, and replay is the only thing that makes "durable failure record" more than a log line.

⚠️ **This table is subject to the same rule as every other:** it must be created by a migration, not only in the declarative schema. It holds email content, so it needs RLS and a retention policy from day one — it is personal data under LGPD, and an unbounded store of inbound email is a liability, not an asset.

---

## 5. Retry behaviour

- **Only `failed_transient` is retried**, and only by Postmark's own retry — the function does not retry internally. In-function retries multiply load exactly when the database is already struggling.
- **No retry storms:** permanent failures return 200, so the provider stops.
- `attempts` is incremented per delivery so a message failing repeatedly is visible and can be capped.
- After a cap, a transient failure is reclassified `failed_permanent` and surfaced. Infinite retry is a decision, not a default.

---

## 6. Observability and failure states

Structured log per delivery: `message_id`, recipient count, per-recipient outcome, total duration, final HTTP status. One line per request, parseable.

The states are the queryable interface: `pending` older than N minutes means a request died mid-work; `failed_transient` with rising `attempts` means a dependency is down; any `failed_permanent` needs a human.

**What is deliberately NOT built here:** alerting, dashboards and an engine-level activity stream. Those belong to the observability phase.

---

## 7. Test plan

Matching the repository's existing `functions` project (Node, no database available today):

**Pure, runnable now:**

1. Outcome fold — a mixed set of per-recipient outcomes maps to the right HTTP status: all-ingested → 200; any-transient → 500; all-permanent → 200.
2. **The rejected implementation's bug, pinned:** a recipient whose result is `transient` must not be dropped by an early return for a *later* recipient. This is the regression test that matters most.
3. Classification — each known error maps to permanent vs transient.

**Needs a database (Docker-blocked):**

4. Duplicate delivery — the same `MessageID` twice creates exactly one note and returns 200 both times.
5. Concurrent duplicate delivery — two simultaneous requests, one note (proves the unique index, not the `SELECT`).
6. Transient failure — the row lands `failed_transient`, the response is 500, and a replay succeeds.
7. Permanently-invalid payload — 200, a `failed_permanent` row, **no** retry.
8. RLS — the ledger is not readable by `anon` or by an unrelated `authenticated` user.

---

## 8. Why this is still a blocker

Inbound email is **the only untrusted external channel that currently reaches the database**. It silently drops data today. Until items 1–8 exist, the repository cannot claim durable ingestion, and Phase 0.5 cannot be signed off on that point.

It is listed as **DEFERRED — not implemented** rather than fixed, because a rushed replacement is what produced the rejected attempt.
