# ADR 0018 — The WhatsApp transport: a signed gateway with its own role, a Q8 gate on the channel, and a send that only a person starts

**Status:** Proposed (2026-09-18, Phase 2B) · **Date:** 2026-09-18
**Implemented by:** `supabase/migrations/20260918150000_whatsapp_transport.sql`, `engine/communication/whatsapp/`, `engine/cli/whatsappGateway.ts`, `engine/cli/messaging.ts`, `engine/domain/whatsappGatewayStore.ts`, `engine/domain/outboundMessages.ts`, `engine/domain/outboundSend.ts`, `scripts/provision-gateway-role.mjs`

## Context

Owner decision J (2026-09-17) puts the patient channel on the official Meta WhatsApp Cloud API behind our own `CommunicationPort`. Phase 2A proved the path with synthetic messages and no action: accepting a review performs nothing, because no outbound transport exists (SI-45). Phase 2B adds the transport in both directions while BASELINE Q8 stays open. That creates four problems the repository has not met before:

- **An internet-facing ingress.** Meta calls a public HTTPS endpoint. Nothing served over HTTP has ever reached `ops` (SI-44). The worker's identity (SI-14) is bound to a lease, and a webhook has none.
- **A tenant chosen by a delivery.** A payload names a phone number id. Whatever maps that id to a tenant decides where content lands.
- **Real content while Q8 is open.** A real WhatsApp number can carry anything a person types. The owner's brief requires test data only.
- **An action with no undo.** A sent message cannot be recalled, and Meta documents no idempotency key for sending. So a retry after an ambiguous call can send the message twice.

## Decision

### 1. A dedicated gateway role and process, not the worker and not an edge function

`ops_gateway` is a new NOLOGIN group role. It gets USAGE on `ops` and EXECUTE on exactly two SECURITY DEFINER functions: `ops.receive_whatsapp_message` and `ops.receive_whatsapp_status`. It holds no table. The gateway process (`npm run whatsapp:gateway`) logs in as `ops_gateway_login`, which is NOINHERIT and created by `npm run gateway:provision`. It refuses to start on a superuser, a BYPASSRLS role, or a role that is not a member of `ops_gateway`.

- **Not the worker.** The worker's authority comes from a lease on one job. A webhook delivery belongs to no job, and giving the worker an HTTP surface would merge two trust boundaries.
- **Not an edge function.** SI-03 keeps edge functions a reviewed allowlist that imports nothing outside `supabase/functions`. The gateway reuses the engine's parser and store, and runs as a narrow role rather than the edge runtime's pooled `postgres`.
- **The static migration guard scrutinises the role exactly like `ops_worker`.** A table grant, a schema-wide grant or a default privilege to it is refused before it applies.

### 2. Authenticity first, then trusted configuration picks the tenant

The gateway verifies `X-Hub-Signature-256` over the raw bytes with the app secret, in constant time, before parsing anything. The subscription handshake answers only the configured verify token.

- **The mapping.** `ops.communication_channels` maps one provider target (Meta's phone number id) to one tenant, company and triage agent. The target is unique across tenants and immutable once configured.
- **Nothing else in the payload chooses scope.** An unknown or inactive target admits nothing (SI-46).

### 3. Q8 is a property of the channel, enforced in the database

Every channel is `test` or `production`, and only the owner sets it (`npm run messaging -- channels set`).

- **While Q8 is open,** a message to a production channel is acknowledged to Meta and recorded as a held fact with no body, no sender and no ledger row. A transport admission row, a send, or the start of a send on a non-test channel is refused by `ENABLE ALWAYS` triggers.
- **A payload field never decides it.** A payload field such as `synthetic: true` never classifies anything.
- **Opening the gate is a reviewed migration after the owner decides Q8** (SI-47).

### 4. A send is a second, explicit human act, checked afresh, at most once

Accepting a review still performs nothing. `npm run messaging -- send --review …` is the only way a message leaves.

- **Request.** It calls `ops.request_outbound_send`, which requires an accepted review from a WhatsApp admission and the eligibility rule.
- **Begin.** `ops.begin_outbound_send` re-checks the rule under the kill-switch lock and commits `sending`.
- **One call.** The operator process then makes exactly one provider call.
- **Settle.** `ops.settle_outbound_send` records `sent`, `failed` or `indeterminate`.

The eligibility rule (SI-49) requires all of the following:

- the contact wrote within the last 24 hours (Meta's customer-service window);
- the read-only CRM adapter resolves the number to exactly one contact whose opt-out is recorded and false;
- the channel is an active test channel;
- no execution stop covers the send.

`do_not_contact = false` is never the basis on its own.

Ambiguity follows ADR 0016's owner amendment: a 5xx, a timeout, a lost connection, an unreadable answer or a transport exception is `indeterminate`. Nothing resends: no command, no service, no timer (SI-50). Provider status callbacks move a send forward only inside its channel's tenant, and match an unknown outcome only by the correlation this system sent AND the conversation's recipient (SI-51).

**Why the operator process, not a worker job.** A send is a person's act, made once, and its outcome belongs in front of that person. A job would add a queue, a retry policy and a lease to an action whose whole point is that it is never retried. The shape is the same three-transaction external-call shape the worker uses: a durable start before the call, then settlement. It reuses the same kill-switch lock. No new job kind or worker capability exists.

### 5. Conversations group; tasks stay the unit of work

`ops.conversations` groups messages by (tenant, channel, contact). Each inbound message still becomes its own task and its own agent run, as in Phase 2A. No prompt concatenates messages, and no task merges another. The conversation holds `last_inbound_at`, which the 24-hour rule reads.

## Consequences

- **A new internet-facing process and a fifth application role.** Pinned in `company_domain_core.sql` A4/A5 and attacked in `whatsapp_transport.sql` A.
- **The owner's configuration is load-bearing.** The owner sets which number belongs to which tenant, and whether it is test. Getting either wrong is a configuration error, not something a delivery can exploit.
- **At most once, not exactly once.** A `failed` or `indeterminate` send ends that review's path; replying again needs a new review.
- **Test channels still reach a model provider.** A test channel's message reaches an agent run exactly as a synthetic one does. Q8 therefore rests, for test channels, on the owner using test numbers with test data.
- **Owner decisions this ADR records and does not make:**
  - whether a service reply to a contact who wrote first is a lawful basis under LGPD;
  - the retention and erasure of message bodies and phone numbers;
  - TLS termination and hosting for the gateway;
  - everything Q8 covers.

## Alternatives rejected

- **Unofficial gateways** (Evolution API, WAHA, Baileys, WPPConnect, browser automation) — rejected by owner decision J and the Phase 2B brief.
- **Send on acceptance** — refused by the brief: a decision and an action stay two acts.
- **Automatic retry of a failed or indeterminate send** — refused: no provider idempotency exists, and a duplicate message to a patient is worse than a missing one.
- **Tenant from a payload field or a URL segment** — anyone who can reach the URL controls both.
- **A generic outbound job kind** — a queue and retry policy for an act that must never retry; see Decision 4.
