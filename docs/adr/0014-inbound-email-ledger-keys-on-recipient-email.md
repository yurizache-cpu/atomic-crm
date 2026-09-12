# ADR 0014 — The inbound-email ledger keys on recipient email, not contact id

**Status:** **Accepted** · **Date:** 2026-09-11
**Decided by:** developer, implementing [docs/design/postmark-ingestion.md](../design/postmark-ingestion.md)

## Context

The approved ingestion design specifies a ledger table with

```
recipient_contact_id  bigint  null   -- null until resolved
unique (message_id, recipient_contact_id)
```

and a **claim-before-work** protocol: insert the row first, in `pending`, and let the unique index reject a duplicate. Only the request that wins the insert does the work. This is a compare-and-set, and it is the reason the ledger is a table rather than a log.

Implementing it literally does not work, for two independent reasons.

**1. The contact id does not exist at claim time.** Contact resolution happens inside `addNoteToContact` — it is part of *the work*. Claim-before-work means the claim strictly precedes the work, so at the moment of the claim there is no contact id to key on. Resolving the contact first in order to obtain a key would reintroduce exactly the window the CAS exists to close.

**2. A NULLable column in a unique index deduplicates nothing.** PostgreSQL compares NULLs as distinct, so `unique (message_id, recipient_contact_id)` permits an unbounded number of `(message_id, NULL)` rows. The rows that carry NULL are precisely the unresolved ones — the rows the index exists to protect. The constraint would look correct, apply cleanly, and silently never fire.

PostgreSQL 15's `NULLS NOT DISTINCT` does not rescue it either: it would collapse **every** unresolved recipient of one message into a single row, so a message to three recipients could only ever claim one of them.

## Decision

**The ledger's recipient identity is the recipient email address.**

- `recipient_email text not null default ''`, unique together with `message_id`.
- `recipient_contact_id` is **not** created. A column that could only ever be NULL is worse than no column: it invites code that reads it.
- The empty string is the recipient key for a failure that belongs to the whole delivery rather than to one recipient (unparseable body, missing required field, failed attachment upload). Not NULL, for the reason above.
- The address is lowercased before use, matching `extractMailContactData`, so casing cannot split one recipient into two claims.

The design's intent — one claim per message per recipient, enforced by a unique index, claimed before any work — is preserved exactly. Only the spelling of "recipient" changes, to the one identifier that exists when the claim is made.

## Consequences

- Triage joins the ledger to `contacts` by email rather than by id. `contacts.email_jsonb` already indexes that path, and the ledger holds the raw payload anyway, so nothing is lost.
- A contact merge or a corrected address does not rewrite history in the ledger. That is correct for an audit record: it states what arrived, not what the CRM later decided.
- Two recipients on one delivery that both carry no address share the single `(message_id, '')` row. The outcome is still `permanent` for both; only the record count differs. Postmark always supplies an address, so this is a defensive path.

## Alternatives rejected

- **Resolve the contact, then claim.** Reintroduces the select-then-insert race under concurrent delivery — the exact failure the design names.
- **`NULLS NOT DISTINCT`.** Allows one unresolved recipient per message; breaks recipient fan-out.
- **Ship `recipient_contact_id` and populate it after the work.** Would require `addNoteToContact` to return the contact id, changing a contract with 11 passing tests, to fill a column nothing reads. The email already identifies the recipient.
