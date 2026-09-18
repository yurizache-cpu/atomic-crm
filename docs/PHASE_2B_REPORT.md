# Phase 2B — official WhatsApp transport and human-approved outbound

| | |
| --- | --- |
| **Base** | `feature/clinical-phase-1` at `1e582d43f7357838554b45a54c25710835a445df` |
| **Branch** | `feature/phase-2b-whatsapp-transport` |
| **Date** | Built 2026-09-18 |
| **Status** | **BUILT, committed locally in two commits (the implementation `04a6b87c` and the focused pre-push review fix, §17), NOT pushed.** Awaiting owner review. No CI run exists for it yet. `main` is untouched, and no deploy took place. [ADR 0018](adr/0018-whatsapp-transport-and-human-send.md) is Proposed, amended by the review. |
| **What it is** | The official Meta WhatsApp Cloud API in both directions. A signed delivery to a configured test number becomes one Phase 2A triage (one task, one run, one review). An accepted review can then be sent back, by a second and explicit operator act, at most once, with consent read afresh. |
| **Data** | **Test and synthetic only. BASELINE Q8 is OPEN and unchanged.** Only an active channel the owner configured `test` can create work or send. The real-data gate is closed: a production channel can exist only inactive, and a message to one is not acknowledged and leaves nothing (SI-47, SI-53). No real patient data was used, and no live Meta call was made (§13). |
| **New dependency** | **None.** `node:http`, `node:crypto`, `fetch` and the existing `zod`. No new OSS, SaaS or SDK. |

---

## 1. What exists now

```
Meta ──POST (X-Hub-Signature-256)──▶ npm run whatsapp:gateway   (node:http, loopback by default)
                                      │ 1. signature over the RAW bytes, constant time → else 401, nothing parsed
                                      │ 2. parse: text messages + statuses only; everything else ignored
                                      ▼ as ops_gateway_login → SET LOCAL ROLE ops_gateway
                     ops.receive_whatsapp_message(target, wamid, from, body, at)   DEFINER
                                      │ target → the ONE configured channel (tenant, company, agent)
                                      │   no ACTIVE TEST channel (unknown, paused, production: the
                                      │   Q8 gate is closed) or a paused unit → unrouted: 503, nothing
                                      │   stored, Meta delivers it again (SI-53)
                                      │   not text / no sender number / empty / >4000 chars / reused id
                                      │   → communication.inbound_refused (no content), 200
                                      │ ops.crm_contact_by_phone → found | not_found | ambiguous | unavailable
                                      │ conversation upsert (tenant, channel, contact)   last_inbound_at
                                      ▼ ops.admit_inbound_core — Phase 2A's admission, unchanged in shape
                     inbound ledger → task (body as description) → agent run → … → review (pending)
                                      │
                     npm run ops -- triage accept          ← records a decision; SENDS NOTHING
                                      │
                     npm run messaging -- send --review …  ← the ONLY way a message leaves
                                      │ TX1 ops.request_outbound_send   accepted review + eligibility → authorized
                                      │ TX2 ops.begin_outbound_send     eligibility AGAIN, kill-switch lock → sending (COMMIT)
                                      │     ONE POST graph.facebook.com/v25.0/{target}/messages
                                      │ TX3 ops.settle_outbound_send    sent | failed | indeterminate
                                      ▼
Meta ──POST statuses──▶ gateway ──▶ ops.receive_whatsapp_status   DEFINER, same channel only
                                      sent → delivered → read; failed; ignored / unmatched / unsupported
```

## 2. Scope delivered against the brief

| Brief item | Where | Status |
| --- | --- | --- |
| Official Meta Cloud API adapter, pinned version | `engine/communication/whatsapp/metaApi.ts`, `metaSender.ts` | Done, v25.0 (§3) |
| Webhook verification (handshake + HMAC) | `metaWebhook.ts`, `webhookGateway.ts`, `engine/cli/whatsappGateway.ts` | Done (SI-46) |
| Trusted target → tenant mapping, fail closed | `ops.communication_channels`, `ops.receive_whatsapp_message` | Done (SI-46) |
| Idempotent inbound ledger | Phase 2A's `ops.inbound_messages` via `ops.admit_inbound_core` | Done (SI-43, unchanged key) |
| Nothing acknowledged in silence | `ops.receive_whatsapp_message` answers admitted, refused on the record, or unrouted (503) | Done (SI-53, pre-push review §17) |
| Q8 gate from trusted configuration | channel `mode`; the closed real-data gate `communication_channels_q8_real_data_gate` (a production channel only inactive); two `ENABLE ALWAYS` triggers | Done (SI-47; tightened by the pre-push review, §17) |
| Read-only CRM ContactPolicy | `ops.crm_contact_by_phone` | Done (SI-48) |
| Fresh consent at send time | `ops.whatsapp_send_eligibility`, called at request AND at begin | Done (SI-49) |
| Acceptance does not send; explicit operator send | `npm run messaging -- send` | Done (SI-45 restated, SI-49) |
| Durable outbound state machine, at most once, ambiguity → indeterminate, no blind resend | `ops.outbound_messages` + guard trigger, `engine/domain/outboundSend.ts` | Done (SI-50) |
| Status callbacks, idempotent and tenant-bound | `ops.receive_whatsapp_status` | Done (SI-51) |
| Minimal conversation grouping | `ops.conversations` | Done (§6) |
| Content minimisation; no secrets or bodies in logs | throughout | Done (SI-52) |
| Operator CLI | `npm run messaging` | Done (§10) |
| Optional live Meta probe | — | **Not performed: no test credentials in this environment** (§13) |

## 3. Official documentation and the pinned version

Verified on **2026-09-18** from Meta's official developer documentation only. Meta has moved the WhatsApp docs to `developers.facebook.com/documentation/business-messaging/whatsapp/…`, and the old `/docs/whatsapp/…` URLs redirect. The browser served auto-translated pages, so the English originals were read.

| Fact the code depends on | Source (official) | Used in |
| --- | --- | --- |
| The newest Graph API version is v26.0 (released 2026-07-29). **v25.0 was released 2026-02-18 and is supported until 2028-07-29.** Expired versions are silently rerouted to the next oldest version. | [Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog), [versioning](https://developers.facebook.com/docs/graph-api/guides/versioning) | `META_GRAPH_API_VERSION` |
| The WhatsApp Cloud API send-messages and text-messages guides call `graph.facebook.com/v25.0` in their request examples, and give v25.0 as the example API version (re-verified in the pre-push review). The Message API reference's version selector (v23.0-v25.0) and its OpenAPI download were observed on the first pass only: both are rendered by JavaScript and could not be re-read. | [Send messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages), [text messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/text-messages), [Message API reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api) | the pin |
| Handshake: `GET ?hub.mode=subscribe&hub.challenge=…&hub.verify_token=…`. Answer 200 with the challenge only when the token matches. | [Create a webhook endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint) | `answerSubscription` |
| `X-Hub-Signature-256: sha256=<hex>` is the HMAC-SHA256 of the POST body under the **app secret**. | same; [Messenger webhooks](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks) for the escaping note | `isAuthenticWebhook` |
| Answer 200. Otherwise Meta retries with decreasing frequency for up to **7 days**, with no 4xx/5xx distinction, to every app subscribed to the account, and duplicates are possible. Nothing is documented about disabling a webhook after persistent failures. Payloads can reach **3 MB**. Up to 1000 updates per request. | [Webhooks overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview), create-webhook-endpoint | gateway answers (SI-53), `WEBHOOK_MAX_BODY_BYTES` |
| A subscribed app receives the webhooks of EVERY number on the WhatsApp Business Account, unless a number or the account has its own callback override (lookup order: number, account, app). | [Webhook overrides](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override) | keep test numbers on an account with no real number (SI-47) |
| Inbound text shape: `entry[].changes[].value.{metadata.phone_number_id, messages[].{from,id,timestamp,type,text.body}}`. | [messages webhook reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages), [text](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text) | `parseWebhook` |
| Since April 2026, a user with a username may have no `from`. Business-scoped user ids arrive as `from_user_id`. | [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/) | refused on the record (`no_sender_number`), never guessed (§6) |
| Status values `sent`, `delivered`, `read`, `failed`, `played`. `errors[]` appears on failure. `biz_opaque_callback_data` is echoed only when it was set on the send. One message can be both `delivered` and `failed` (multiple devices). | [status webhook reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status), [support](https://developers.facebook.com/documentation/business-messaging/whatsapp/support) | `ops.receive_whatsapp_status` |
| Send: `POST https://graph.facebook.com/<version>/<PHONE_NUMBER_ID>/messages`, Bearer token, body `{messaging_product:"whatsapp", recipient_type:"individual", to:"+…", type:"text", text:{preview_url, body}}`. The body is at most **4096** characters. The success response carries `messages[0].id`, and it "does not indicate successful delivery". | [Send messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages), [text messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/text-messages) | `metaSender.ts` |
| `biz_opaque_callback_data` allows up to **512** characters (since 2024-01-26), and was added to free-form messages (2023-11-14). Read on the first pass; the changelog answered HTTP 400/500 on every variant in the pre-push review. The status reference describes it only as a property "in the send message request", echoed on every status when set. | [WhatsApp changelog](https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog), [status webhook reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status) | the correlation |
| **No idempotency key** and no duplicate-send protection is documented for `/messages`. | send, text, error-code and throughput pages, and the v25.0 OpenAPI spec (absence) | at-most-once (SI-50) |
| A user's message opens a **24-hour customer-service window**. After it closes, only templates may be sent, and "the user must have opted in". | [Send messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages) | eligibility rule (SI-49) |
| Error codes: 131047 (window closed), 131026 (undeliverable), 131048 / 131056 / 130429 / 80007 (rate limits), 190 (token), 131005 (permission), 100 / 131008 / 131009 (parameters), 368 (policy), 133010 (not registered), 131000 (unknown). Build on `code`, not HTTP status or titles. | [Error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes), [throughput](https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput), [about the platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform) | `metaSender.ts` error classes |

**Selected version: v25.0, because Meta's WhatsApp Cloud API documentation targets it in its own request examples, and it is supported until 2028-07-29.** It is NOT the newest Graph API version: v26.0 exists (2026-07-29), and the WhatsApp message contract has not been verified against it, so the adapter does not move to it yet. The version is a reviewed constant, never an environment variable. The upgrade strategy is in `metaApi.ts`: read both changelogs, change the constant in a reviewed commit, re-run the adapter tests and, with test credentials, the live probe.

**UNVERIFIED on any current Meta page, and therefore the first thing a live probe must settle:**

1. **Where `biz_opaque_callback_data` goes in a send request. Still UNVERIFIED after the pre-push review re-checked every current page.** Its position in the request body is shown nowhere, and the Message API reference's request schema (`BaseMessageProperties`: `messaging_product`, `recipient_type`, `to`, `type`, `context`) does not list it. The adapter sends it at the top level, as an assumption.
   - If Meta refuses that with a 400, every send is recorded **`failed`** with code 100 or 131009, and is never resent. That is the safe direction, but it would make sending unusable until the placement is corrected.
   - If Meta silently ignores it, statuses carry no correlation, and a send whose outcome is unknown can be resolved only through its provider message id, which exists only when a response was read. An indeterminate send is therefore NOT always recoverable.
2. **Which HTTP status each error code arrives with.** Classification therefore keys on the error code (Meta's advice). A 4xx other than 408 is a rejection; a 5xx and a 408 are ambiguous.
3. **Whether webhooks are ordered.** No guarantee is documented. Status reconciliation ranks states instead of trusting arrival order.

## 4. Architecture, and what it deliberately reuses

- **Two ports, one per direction** (`engine/communication/types.ts`).
  - Inbound envelopes still carry no tenant.
  - `OutboundTransport` executes one send the database already authorized. It decides nothing, never retries, and never throws.
  - The Phase 2A `CommunicationPort` still has no send method.
- **A new gateway process and role** ([ADR 0018](adr/0018-whatsapp-transport-and-human-send.md) §1).
  - `ops_gateway`: NOLOGIN, USAGE on `ops`, EXECUTE on exactly two functions, no table, no CREATE anywhere. Outside `ops` it holds only what PUBLIC holds: the CRM's row-level-security helpers, which answer booleans or ids for `auth.uid()`, and trigger functions that cannot be called directly (pinned by `whatsapp_transport.sql` K3; §17).
  - `ops_gateway_login`: NOINHERIT, created by `npm run gateway:provision` (`scripts/provision-gateway-role.mjs` reuses the worker's provisioning SQL).
  - The process refuses a superuser, a BYPASSRLS role, or a non-member.
- **Admission reuses Phase 2A.** `ops.admit_inbound_message` was split into a shared `ops.admit_inbound_core`, which both the synthetic service and the WhatsApp function call.
  - The identity key is unchanged: (tenant, source kind, external message id). The fingerprint is `inbound.v2`, injective over source kind, contact and body.
  - Replays, conflicts, the constant task title, the triage capability, the run and the review are exactly Phase 2A's.
- **The send runs in the operator's process, not in a worker job** (ADR 0018 §4). It uses the same three-transaction external-call shape, and the kill-switch lock the worker uses. No job kind, worker capability or `CAPABILITY_NAMES` entry was added.
- **Nothing in `public.*` is written.** The CRM is read by one INVOKER function, and only for the tenant that owns the deployment's CRM.

## 5. Schema — `20260918150000_whatsapp_transport.sql` (forward only)

| Object | What it is |
| --- | --- |
| `ops_gateway` role | NOLOGIN group role for the webhook gateway. It holds no table. |
| `ops.communication_channels` | Maps a provider target to one tenant, company and agent. `provider = 'meta_whatsapp'`, `mode` is `test` or `production`, plus `active`. The target is unique per provider across tenants. Tenant, company, provider and target are immutable (`ENABLE ALWAYS` guard). |
| `ops.conversations` | (tenant, channel, contact_ref) grouping, with `last_inbound_at`. Its identity is immutable. |
| `ops.inbound_messages` (extended) | Adds `channel_id`, `conversation_id`, `contact_resolution` and `crm_contact_ref`. `source_kind` may now be `whatsapp`. A shape CHECK requires a WhatsApp row to name its channel and conversation, and forbids a synthetic row from naming one. The new columns are frozen by the existing guard. **Q8 trigger** `inbound_messages_q8_gate` (`ENABLE ALWAYS`): a non-synthetic row is refused unless its channel is `test`, and that includes the owner's own insert. |
| `ops.outbound_messages` | One send per accepted review. Ids, status, the two eligibility snapshots (ids and states only), the provider message id (set once, unique per tenant), a sanitised error code and class, and timestamps. **No text and no recipient.** Guard trigger `outbound_messages_guard` (`ENABLE ALWAYS`): born `authorized` on a test channel; identity immutable; the state machine in §8; `sending` only on an active test channel. |

| Function | Security | Executable by | Purpose |
| --- | --- | --- | --- |
| `ops.receive_whatsapp_message(text, text, text, text, timestamptz)` | **DEFINER**, empty search path | `ops_gateway` only | Admit one message on the active test channel the target names, refuse it on the record, or answer `unrouted` (§6). Redefined by `20260918170000`. |
| `ops.receive_whatsapp_status(text, text, text, timestamptz, text, text, text)` | **DEFINER**, empty search path | `ops_gateway` only | Reconcile one status on that channel's sends. |
| `ops.configure_whatsapp_channel` | INVOKER | no application role | Owner: create or update a channel. Another tenant's target raises OS409; a live production channel raises OS403 (the closed real-data gate). |
| `ops.crm_contact_by_phone` | INVOKER, stable | no application role | The read-only CRM adapter (§7). |
| `ops.whatsapp_send_eligibility` | INVOKER | no application role | The fresh eligibility rule (§8). |
| `ops.request_outbound_send`, `ops.begin_outbound_send`, `ops.settle_outbound_send`, `ops.mark_outbound_indeterminate` | INVOKER | no application role | The owner's send services. |
| `ops.admit_inbound_core` | INVOKER | no application role | The shared admission. |
| `ops.admit_inbound_message` | INVOKER | no application role | Redefined: synthetic only, and delegates to the core. |

**Why two new DEFINERs are justified.** The gateway is internet-facing and must hold no table. Each DEFINER takes a provider target, which is not a tenant, and resolves the ONE configured channel from it. It acts only inside that channel's tenant, and it never takes a tenant, task, run or send id from the caller.

Both DEFINERs are pinned in three places:

- the migration's own end-state assertions;
- `company_domain_core.sql` A4 (EXECUTE surface) and A5 (DEFINER allowlist);
- `whatsapp_transport.sql` A3 and A5.

The static migration guard now knows `ops_gateway`. A table grant, a schema-wide grant or a default privilege to it is refused before it applies (5 new cases in `migrationInvariants.test.ts`).

## 6. Inbound semantics

- **Authenticity.** The HMAC is checked over the exact bytes received, before JSON parsing, with `timingSafeEqual`. A missing, malformed or wrong signature answers 401, and nothing is parsed or stored. The verify token is compared in constant time.
- **The body bound.** The gateway reads at most 3 MiB + 256 KiB (Meta's 3 MB plus headroom). Beyond that it answers **413** and discards the rest.
  - *Found and fixed while writing the server test:* the first version destroyed the socket on overflow, so Meta would have seen a reset rather than a 413.
  - Request and header timeouts are 30 s and 10 s.
- **What is read.** Every message Meta names with an id is handed to the database: a `text` message with its body; any other type (media, a voice note, a reaction) with none; a sender known only by username with no number. The parser bounds nothing; the database decides, in characters. Only an element with no usable message id is counted as ignored. Timestamps are clamped to "not later than now", by the gateway and again by the database's clock.
- **The tenant.** It comes only from `metadata.phone_number_id` → the one active channel with that target. Nothing else in the payload is consulted; a delivery that names a tenant, company or `synthetic: true` changes nothing (tested).
- **Idempotency.** A redelivery, sequential or concurrent, converges on the one ledger row, task and run. The same message id with a different message is refused on the record (`admission_refused`) and creates nothing else.
- **Answers to Meta** (SI-53: acknowledged only once it became work or a durable, content-free fact).

  | Outcome | HTTP answer | Why |
  | --- | --- | --- |
  | admitted or replayed | 200 | the work exists |
  | refused on the record: content that is not text, no sender number, an empty body, a body over 4000 characters, a reused message id | 200 | a `communication.inbound_refused` fact exists (channel, conversation, reason; no content), once per message id |
  | unrouted: an unknown, inactive or production target, or a paused company, department or agent | 503 | not ours to acknowledge; nothing stored; Meta delivers it again, and a re-activated channel or unit admits it |
  | a malformed target or message id (a typed OS400 before any channel) | 200 | cannot be tied to anything; Meta does not send one |
  | anything else, a 22xxx or 23xxx included | 500 | takes precedence over 503; Meta delivers again, and the redelivery converges |

- **Conversation model.** One conversation per (tenant, channel, contact). Every message is still its own task and its own run; nothing is concatenated or merged. `last_inbound_at` only moves forward, and the 24-hour rule reads it. The same WhatsApp id gets a separate conversation in each tenant.

## 7. ContactPolicy — the read-only CRM adapter (SI-48)

`ops.crm_contact_by_phone(tenant, whatsapp_id)`:

- **Answers.** `unavailable` unless the tenant is the one that owns this deployment's CRM (`owns_local_crm`). Then `not_found`, `ambiguous` (more than one contact) or `found`. A `found` answer carries `crm_contact_ref = 'crm:contact:<id>'` and `do_not_contact` (null when the contact has no lead profile).
- **Matching.** Exact on digits: a stored number reduced to digits must equal the WhatsApp id. No country code is guessed.
- **No writes.** An unknown sender creates no contact. The function contains no DML (asserted by `whatsapp_transport.sql` D7), and the inbound suite hashes the CRM before and after.
- **Consent semantics.** The CRM's only consent field is `lead_profiles.do_not_contact`, an **opt-out** that defaults to false. The adapter reports it and never calls it consent.
  - **At admission** (for the review decision, as in Phase 2A): do-not-contact unless the contact is `found` with a recorded `false`. So an unknown, ambiguous or unavailable contact's review cannot be accepted.
  - **At send time**, the rule in §8 is read afresh.

## 8. Outbound semantics

**The explicit act.** `npm run messaging -- send --review <id> --tenant <id> --operator <label>`, with `WHATSAPP_ACCESS_TOKEN` in the environment. Accepting a review sends nothing, and no trigger or job turns a decision into a send (`whatsapp_transport.sql` G1). A review that is `rejected`, `needs_edit` or `pending` cannot be sent.

**The eligibility rule** (`ops.whatsapp_send_eligibility`). It is read at the request and again in `begin`, immediately before the call, holding the kill-switch lock shared. It refuses with a reason, in this order (the Q8 reason first since the pre-push review):

| Reason | Meaning |
| --- | --- |
| `conversation_not_found` | no such conversation in this tenant |
| `q8_production_channel` | not a test channel |
| `channel_inactive` | the channel was deactivated |
| `execution_stopped` | a global, tenant or company stop covers it |
| `crm_unavailable` | this tenant does not own the CRM |
| `contact_not_found` / `contact_ambiguous` | not exactly one CRM contact for the number |
| `consent_unknown` | the contact has no lead profile (every contact gets one by trigger, so this is a fail-closed backstop, not a live safeguard) |
| `do_not_contact` | opted out |
| `outside_service_window` | the contact's last message is more than 24 hours old |

**These are preconditions, not a lawful basis or affirmative consent.** Meta's 24-hour window is a provider messaging constraint, and `do_not_contact = false` is only the CRM's default for every contact: the CRM records no consent at all. Whether a reply is lawful under LGPD for the clinic, and how consent must be represented, are **owner decisions (§15)**; until they are made, production replies are impossible (SI-47) and the rule runs on test channels only.

**The state machine** (`outbound_messages_guard`):

```
authorized ──▶ sending ──▶ sent ──▶ delivered ──▶ read
    │  ▲          │  │        └──▶ failed ──▶ delivered | read   (delivery evidence wins)
    ▼  │          │  └──▶ failed
 blocked          └──▶ indeterminate ──▶ sent | delivered | read | failed   (provider evidence only)
```

- **One send per review** (unique `review_item_id`). A repeated request answers with the same send. Concurrent operators produce one call (tested with three).
- **`blocked`.** The re-check refused between request and call. A later request, once eligible, re-authorizes it. That is the only way back, and it is from a state where no call was made.
- **At most once.** `sending` commits before the call, and the call is made only by the process whose `begin` moved it there. `sending`, `sent`, `failed` and `indeterminate` can never return to `authorized` or `sending`.
- **Ambiguity** (ADR 0016's owner amendment, restated for sends):

  | Provider answer | Recorded as |
  | --- | --- |
  | 2xx with a message id | `sent` |
  | 4xx other than 408, with a specific error code | `failed`, with a code and class, never the provider's text |
  | 5xx, 408, timeout, network error, refused redirect, 2xx without an id, oversize answer, a transport exception, or Meta's generic codes 1, 2, 131000, 131016 even in a 4xx | `indeterminate` |

- **Crashes.**
  - Before `begin`: the send stays `authorized`, and the next `send` resumes it and calls once.
  - After `begin`: it stays `sending`. A rerun makes no call.
  - `npm run messaging -- outbound mark-indeterminate` settles it only when it is older than 5 minutes; a status callback can settle it too.
  - If the settle transaction itself fails, the send stays `sending`; the tool prints `settlementRecorded: false` with the provider's outcome and message id, so that evidence is not lost, and exits 1.
- **No resend.** No command, service or timer resends. There is no `retry` or `resend` subcommand (tested).

## 9. Status reconciliation (SI-51)

`ops.receive_whatsapp_status` maps the target to its channel (active or not). It then finds the send by:

- (tenant, channel, provider message id); or
- when the send's outcome is unknown (`sending` or `indeterminate`), by the correlation this system sent in `biz_opaque_callback_data`, **and only if the recipient equals the conversation's contact**.

It applies the provider's own ranking: `sent` < `delivered` < `read`. `failed` is accepted from `sending`, `indeterminate` or `sent`, and delivery evidence after an ASYNCHRONOUS failure wins: Meta documents that one message can be reported both delivered and failed (several devices), and delivered means at least one device received it. A send the provider refused SYNCHRONOUSLY has no provider message id and is not `sending`, so no callback can reach it: it is final.

- **Answers.** `updated`, or `ignored` (a duplicate or older news), `unmatched` (unknown to this channel) or `unsupported` (`played`, or any undocumented value). Nothing but `updated` is stored.
- **One fact per step.** Each step records one `communication.delivery_updated` event under an idempotency key, so a redelivered status is one fact.
- **Tenant-bound, and channel-bound.** A target cannot reach another channel's send, in another tenant or in the same one; a correlation is honoured only through its own channel and with its own conversation's recipient, never with another send's or with none (SQL F2, J1-J3, and driver-backed).

## 10. Operator surface

| Command | What it does |
| --- | --- |
| `npm run gateway:provision` | Create `ops_gateway_login` (needs `ADMIN_DATABASE_URL`, `OPS_GATEWAY_PASSWORD`). |
| `npm run whatsapp:gateway` | Run the gateway (`OPS_GATEWAY_DATABASE_URL`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`; optional `WHATSAPP_GATEWAY_HOST` default `127.0.0.1`, `…_PORT` default 8787, `…_PATH` default `/webhooks/whatsapp`). TLS and the public name belong to a reverse proxy or tunnel. |
| `npm run messaging -- channels list \| channels set …` | List or configure channels (`--mode test\|production`, `--inactive`). `--mode production` is refused without `--inactive`: the real-data gate is closed. |
| `npm run messaging -- send --review … --tenant … --operator …` | The only send (`WHATSAPP_ACCESS_TOKEN`, read by `send` only). |
| `npm run messaging -- outbound list \| outbound show` | Ids, statuses, reasons and error classes, never text or recipient. `show` adds `eligibleNow`, read fresh. |
| `npm run messaging -- outbound mark-indeterminate` | Settle a send left `sending` by a crash, after 5 minutes. |

No secret is printed. Errors carrying a connection string are reported by SQLSTATE only, and a missing variable is named, never its value (tested).

## 11. Content and retention inventory (SI-52)

| Data | Stored in | Why | Retention / erasure |
| --- | --- | --- | --- |
| Inbound message body | `ops.tasks.description` | the agent run's prompt is built from the task (Phase 2A) | **none defined**: owner decision before Q8 |
| Sender's WhatsApp id (a phone number) | `ops.inbound_messages.contact_ref`, `ops.conversations.contact_ref` | reply target, 24-hour rule, CRM match | **none defined** |
| Body fingerprint | `ops.inbound_messages.body_fingerprint` (unsalted SHA-256 over `inbound.v2`, kind, number, body) | conflict detection | as the ledger row; it can confirm a guessed short message and outlives an erasure of the description |
| CRM reference | `ops.inbound_messages.crm_contact_ref` (`crm:contact:<id>`) | audit of what admission saw | as the ledger row |
| Reply draft | `ops.agent_runs.result` (the model's stored output) and `ops.review_items.proposed.response_draft` (Phase 2A) | read at send time, never copied further | **none defined** |
| Send record | `ops.outbound_messages`: ids, states, provider id, error code and class | at-most-once, audit | no text, no recipient |
| Events | `communication.*`: ids, states, reasons, resolution | audit | never a body, draft, number or secret (tested) |
| Gateway logs | stdout, one JSON line per event | operations | counts and outcomes only (tested) |
| Raw webhook payloads | **not stored** | Meta suggests storing every payload; not done, deliberately (minimisation) | — |
| Refused messages | a `communication.inbound_refused` fact: channel, conversation, reason | acknowledged only on the record (SI-53) | as the events |
| Unrouted messages (production, paused, unknown targets) | **not stored, not acknowledged** | BASELINE Q8; SI-53 | Meta keeps it for up to 7 days; a re-activated test channel or unit admits it |

## 12. Tests

All local, on the e2e stack (`atomic-crm-e2e`, ports 5434x). **No CI run exists yet: the branch is not pushed.**

| Gate | Result |
| --- | --- |
| `npm run test:db` | **15/15 suites** (after a clean reset with both Phase 2B migrations). `whatsapp_transport.sql` sections A–K: roles attempted one by one, RLS forced, the DEFINER and search-path pin, trusted mapping, Q8 triggers, CRM adapter answers and no-write, the send state machine (E5: production send impossible), status scope, no send trigger, H the closed real-data gate, I acknowledgement (refusals on the record, clock skew, paused units), J status collisions, K the gateway's reach beyond `ops`. Updated: `company_domain_core.sql` A1/A4/A5 and the Data API exposure probe's presence checks. |
| `npm run test:db:engine` | **240/240 in 32 files** (Phase 2A: 205 in 30). `whatsappInbound.dbtest.ts` 15 and `whatsappOutbound.dbtest.ts` 20. They run the real gateway handler and store over `ops_gateway_login`, a real worker run, and a counting fake transport. |
| `functions` unit project | **1638/1638 in 65 files.** New or changed: `metaWebhook.test.ts` 13, `metaSender.test.ts` 14, `webhookGateway.test.ts` 10, `engine/cli/whatsappGateway.test.ts` 5, `engine/cli/messaging.test.ts` 8, `migrationInvariants.test.ts` 139 (+8), `securityInvariants.test.ts` 60 (+8). |
| Security invariants | **60/60**: SI-46 to SI-53 added; SI-21, SI-44 and SI-45 restated; SI-46, SI-47, SI-49 to SI-52 restated again by the pre-push review. |
| Upgrade replay (`npm run test:db:upgrade`) | **PASS**: legacy data keeps its meaning through every migration, `20260918150000` and `20260918170000` included. |
| Typecheck, ESLint, build, `scan:build`, production scope, signing key | Green. ESLint: 0 errors, and 0 warnings in any Phase 2B file. |
| `scripts/test` guards | Green: dev-signing-key 64, local-exposure 34, production-scope 39 + 9 + 15 + 14, publish-pages 8, registry 10, scan-build-artifacts 35. |
| Prettier | Every changed file is formatted. |

**Mutation checks: each guard was broken on purpose, and the named assertion went red.**

| Mutation | Caught by |
| --- | --- |
| Q8 admission trigger disabled | SQL C2 |
| `SELECT` on `ops.conversations` granted to `ops_gateway` | SQL A2 |
| `request_outbound_send` granted to `ops_gateway` | SQL A3 |
| Outbound guard trigger disabled | SQL E1 |
| Channel identity guard disabled | SQL B2 |
| RLS not forced on `ops.outbound_messages` | SQL A1 |
| `receive_whatsapp_message` granted to `ops_worker` | SQL A3 |
| A trigger that begins a send on a review update | SQL G1 |
| `begin_outbound_send` skipping the fresh re-check | driver: "blocks a send whose consent changes between the request and the call" |
| Status-by-correlation ignoring the recipient | driver: "resolves an indeterminate send only when the correlation AND the recipient match" |
| *(pre-push review)* the real-data gate constraint dropped | SQL H2 |
| *(pre-push review)* `configure_whatsapp_channel` as first shipped (no OS403) | the gate's CHECK, raised inside SQL H1 |
| *(pre-push review)* `receive_whatsapp_message` as first shipped (held, OS404, silent refusals) | SQL B3 |
| *(pre-push review)* `whatsapp_send_eligibility` as first shipped (`channel_inactive` first) | SQL E5 |
| *(pre-push review)* `SELECT` on `ops.jobs` granted to `ops_gateway` | SQL K1 |
| *(pre-push review)* `CREATE` on schema `ops` granted to `ops_gateway` | SQL K1 |
| *(pre-push review)* a new PUBLIC-executable SECURITY DEFINER in `public` | SQL K3 |

Each driver mutation's case was then re-run unmutated and passed.

**Known local-only reds, not caused by this phase:**

- the `claude` project collects a stray `.claude/worktrees/loving-mendel-123ece` checkout (not tracked);
- `scripts/test/run-db-upgrade-test.test.mjs` fails to collect on Windows (hashbang/CRLF).

CI runs both green. The accepted CI baseline reds are unchanged: e2e 9 failed / 1 skipped, and Prettier on `sampleCsv.test.ts` and `canAccess.test.ts`.

## 13. Live Meta test probe — NOT PERFORMED

No Meta test credentials exist in this environment: no app secret, verify token, access token or test phone number id. So no live call was made, and nothing in this phase needs one to pass. The probe, when the owner provides a Meta **test** number and test recipients:

1. `npm run gateway:provision`, then `npm run messaging -- channels set --mode test …` with the test number's phone number id.
2. Run `npm run whatsapp:gateway` behind a TLS tunnel. Subscribe the webhook: the handshake must answer the challenge.
3. From a registered test recipient, send a synthetic text. Expect one admission, one task and one run on the fake or configured provider (Q8: synthetic text only), then one pending review.
4. `npm run ops -- triage accept`, then `npm run messaging -- send`. Expect `sent` with a `wamid`, then `delivered` and `read` statuses.
5. **Settle §3's first unverified item.** A 400 naming `biz_opaque_callback_data` means its placement must change before any further send.

## 14. Known limitations

1. **The correlation's placement is unverified** (§3). If Meta refuses it, sends fail definitively, which is safe but unusable, until it is fixed. If Meta ignores it, an indeterminate send whose response was lost cannot be resolved by a callback.
2. **No retry of any send.** `failed` and `indeterminate` are final except for provider evidence. Replying again needs a new review.
3. **Senders without a phone number** (BSUID or username only) are refused on the record, not admitted. Supporting them needs a contact key other than the number, and a CRM match that does not exist.
4. **Media, templates, interactive messages and reactions are not handled.** They are refused on the record (`unsupported_content`), never admitted. A reply outside the 24-hour window would need a template, which does not exist here.
5. **The CRM match is exact on digits, and scans `public.contacts`.** Fine for a pilot; an indexed normalised phone column would be a CRM schema change, deliberately not made.
6. **An unknown sender's review cannot be accepted** (do-not-contact at admission), so a first-contact enquiry from a number not in the CRM can be triaged but never answered through this path.
7. **The opt-out check and the call are not atomic with the CRM.** An opt-out recorded in the seconds between `begin` and the provider's answer is not seen by that send.
8. **The 24-hour window is measured from the contact's last message as this database recorded it** (Meta's timestamp, never later than the database's clock). A send near the edge may be refused by Meta (131047) and is recorded `failed`.
9. **A send honours global, tenant and company stops only.** Department, agent and job-kind stops do not cover it: a send has no job, and it is not an agent's act.
10. **The gateway has no rate limit** of its own beyond body bounds and timeouts. TLS, the public host and network filtering are not provided.
11. **An unrouted message is visible only in the gateway's log** (`gateway.unrouted`, with the business's own number id): with no tenant there is nowhere durable to record it. Meta retries it for up to 7 days, to every subscribed app, and then drops it.
13. **The verify token travels in the handshake's query string** (Meta's protocol), so an access log in front of the gateway records it: scrub query strings on the webhook path, or rotate the token after subscribing.
14. **An authenticated body that is not a WhatsApp notification is answered 400**, so Meta retries it for 7 days. Only Meta can sign one, and none is expected.
15. **A channel deactivated in the instant after a send's pre-call check does not stop that call**, the kill switch's own semantics (ADR 0017).
16. **Phase 2A limitations carried over:** the production-readiness gate from Phase 1D.2 (`users` / `patchUser`, `delete_note_attachments`, development-secret debt, the makefile deploy path), and `supabase_read_only_user` (BYPASSRLS) can read every `ops` table, including the new ones.

## 15. Owner decisions this phase records and does not make

1. **BASELINE Q8** — unchanged and open. A test channel's messages still reach the configured model provider exactly as synthetic ones do. Only test numbers carrying test data may be connected.
2. **The lawful basis for a reply, and how consent is represented.** Is a service reply to a contact who wrote first, and has not opted out, lawful under LGPD for this clinic? Meta's 24-hour window is a messaging constraint, not an answer, and Meta's policy also says the user "must have opted in". The CRM records no affirmative opt-in, and its opt-out flag is false by default. Production replies stay impossible until this is decided and the real-data gate is opened by a reviewed migration.
3. **Retention and erasure** of message bodies (`ops.tasks.description`), phone numbers (`contact_ref`) and drafts.
4. **Whether an unknown number may ever be answered**, or whether a contact must first be created by a person in the CRM (today: never answered).
5. **Hosting of the gateway:** TLS termination, public name, network filtering, secret storage, and the WhatsApp Business Account layout (test numbers on an account with no real number).
6. **ADR 0018:** accept, amend or reject.

## 16. Next

Phase 2C (the operator surface) is **not started**. Before any real patient message:

- Q8 decided;
- the owner decisions in §15 made;
- the live test-number probe run and §3's unverified items settled.

## 17. Focused pre-push review (2026-09-18)

A narrow final review of the unpushed implementation (`04a6b87c`, base `1e582d43`), before any push. Four read-only reviewers worked in parallel:

- Q8 and consent;
- privilege surface and content minimisation;
- webhook acknowledgement, at-most-once and status reconciliation;
- Meta's official documentation.

Each finding was then reproduced by the main thread before anything was fixed. The fix is ONE further commit on top of `04a6b87c`, which is unchanged.

### 17.1 Findings

| Id | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| R-1 | **P1** | A production channel could be made live by every path: the configure service, an owner INSERT, flipping an active test channel's mode, re-activating an inactive one. Each message to it was acknowledged 200 and recorded as `held` with no content, so Meta never delivered it again and it was lost for good. | **Fixed:** the closed real-data gate (17.2 item 1). |
| R-2 | **P1** | An unknown or inactive target (OS404, a permanent class) was acknowledged 200 with nothing durable, including a test channel an owner paused. | **Fixed:** unrouted, answered 503, nothing stored (item 2). |
| R-3 | **P1** | An inactive company, department or triage agent turned every test-channel message into OS409, acknowledged 200 with nothing durable. | **Fixed:** checked before admission; unrouted (item 2). |
| R-4 | **P1** | The parser silently dropped genuine messages. It applied the OUTBOUND 4096 limit, in UTF-16 units, to inbound bodies, and it dropped every media type, voice note, username-only sender and blank body as `ignored`. All were acknowledged 200. | **Fixed:** every keyed message reaches the database (item 3). |
| R-5 | **P1** | A body of 4001–4096 characters passed the parser and was refused by admission (OS400), then acknowledged 200 with no record. | **Fixed:** refused on the record (item 3). |
| R-6 | **P1** | A gateway clock more than a minute ahead of the database's refused a message permanently (OS400), and it was acknowledged. | **Fixed:** clamped to the database's clock (item 4). |
| R-7 | P2 | A reused message id with another body was "recorded as refused" only in a log line. | **Fixed:** refused on the record (`admission_refused`). |
| R-8 | P2 | The eligibility rule answered `channel_inactive` before `q8_production_channel`. Under the new CHECK the Q8 reason would have become unreachable. | **Fixed:** Q8 first. |
| R-9 | P2 | Docs and SI-49 called Meta's 24-hour window "the basis for a reply", and called the default-false opt-out "recorded". | **Fixed:** they are preconditions, not a lawful basis or consent (SI-49 restated). |
| R-10 | P2 | When settlement failed after an accepted call, the provider message id was discarded, and the CLI exited 0. | **Fixed:** the report carries the outcome and the id, and the CLI exits 1. |
| R-11 | P2 | `messaging send` printed a server message on a connection-phase failure. `cliOutput.ts`'s rule reports those by code alone, because they can name the role or the database. | **Fixed:** the phase is tracked (`opened`). |
| R-12 | P2 | Meta's generic error codes (1, 2, 131000, 131016) in a 4xx were recorded `failed`, a claim that nothing was sent that Meta does not make. | **Fixed:** `indeterminate`. |
| R-13 | P2 | SI-52 said the draft "stays in its review"; it is also in `ops.agent_runs.result`. The body fingerprint's erasure property was undocumented. | **Fixed:** SI-52 and §11 restated. |
| R-14 | P2 | Version wording implied v25.0 was the newest version. Two version facts, the Message API selector and the OpenAPI download, could not be re-read (they are rendered by JavaScript). | **Fixed:** §3, `metaApi.ts` (17.4). |
| R-15 | P2 | `metaSender.ts` claimed Meta places `biz_opaque_callback_data` at the top level. No current page says so. | **Fixed:** marked UNVERIFIED (17.4). |
| R-16 | P3 | Like every role since the CRM's first migration, `ops_gateway` (and its login) can execute through PUBLIC the CRM's row-level-security helpers. These are read-only booleans or ids that answer for `auth.uid()`, a claim a session can forge through `request.jwt.claims`. It can also call trigger functions, which cannot run by direct call. Pre-existing; the same holds for `ops_worker`. | **Pinned, not fixed** (scope): `whatsapp_transport.sql` K3 fails by name on any new one. |
| R-17 | P3 | The live suites did not attempt a gateway grant on `ops.jobs` / `ops.tenants`, or CREATE on `ops`. The static guard and the migration's own assertion did. | **Fixed** in the suite: K1 iterates every `ops` relation. |
| R-18 | P3 | An authenticated body that is not a WhatsApp notification is answered 400, so Meta retries it for 7 days. | Documented (§14). |
| R-19 | P3 | `readBody` never settles if a client aborts mid-body without an `error` event. | Not changed; the server's request timeout bounds it. |

No P0: tenant isolation, secret handling and at-most-once held under every attack.

### 17.2 The fix

`supabase/migrations/20260918170000_whatsapp_q8_gate_and_acknowledgement.sql` (forward only) and the engine changes:

1. **The closed real-data gate, with no enabled value.**
   - `communication_channels_q8_real_data_gate CHECK (mode = 'test' or not active)`, validated and asserted by the migration.
   - `ops.configure_whatsapp_channel` raises OS403 first, and so does the messaging CLI (`--mode production` needs `--inactive`).
   - Dropping the constraint is a static-guard finding (`constraint-dropped`, `supabase/invariants/rules.mjs`, +3 guard cases), which only an owner-approved override can silence.
   - No flag, setting, table or environment variable opens it.
2. **Unrouted is not acknowledged.**
   - `ops.receive_whatsapp_message` answers `{state: unrouted}` unless the target is an ACTIVE TEST channel whose company, department and agent are active.
   - The gateway answers 503 (500 takes precedence) and logs `gateway.unrouted` with the business's own number id.
   - Nothing is stored. A paused channel or unit admits the message when Meta delivers it again.
   - The `held` answer is gone.
3. **Refused on the record.**
   - A routed message that cannot become work (`unsupported_content`, `no_sender_number`, `empty_body`, `body_too_long`, `admission_refused`) is acknowledged only with a `communication.inbound_refused` fact: channel, conversation, reason, once per message id.
   - The parser now hands on every keyed message and bounds nothing.
   - The store treats only a typed OS400–OS409 as permanent; every 22xxx/23xxx is now transient, so a repeating failure repeats in the log.
4. **received_at clamped** to the database's clock.
5. **Eligibility names the Q8 gate first.**
6. **Outbound evidence and error hygiene:** R-10, R-11 and R-12 above.

### 17.3 Answers

| Question | Answer |
| --- | --- |
| Production channel activatable while Q8 is closed | **NO** (CHECK, service, CLI; SQL H1–H2, dbtest) |
| Real message silently acknowledged and lost while Q8 is closed | **NO** (SI-53; SQL C1, I; dbtests) |
| Gateway privilege surface safe | **YES**, with R-16 recorded (pre-existing PUBLIC helpers) |
| Webhook signature verified before parse | **YES** |
| Transient gateway failure ACK-safe | **YES** (500, never 200; 22xxx/23xxx now transient too) |
| Duplicate inbound converges | **YES** |
| Duplicate provider send possible | **NO** |
| Crash after the provider call can auto-resend | **NO** |
| Accepted review automatically sends | **NO** |
| Fresh consent re-checked | **YES**, at request and at begin: preconditions, not a lawful basis |
| Production consent semantics resolved | **NO** (owner decision) |
| Production outbound enabled | **NO** |
| `biz_opaque_callback_data` placement officially verified | **NO**: UNVERIFIED until the live probe |
| Provider-message-id reconciliation verified | **YES** against the documented status shape, in tests; not against live Meta traffic |
| Content and log minimisation safe | **YES** |
| CRM mutation possible | **NO** |

### 17.4 Meta documentation, re-checked

- **Version.** The newest Graph API version is v26.0 (2026-07-29). v25.0 was released 2026-02-18 and is available until 2028-07-29. The WhatsApp send and text guides use v25.0 in their request examples. The adapter stays on v25.0 for that reason, not because v25.0 is the newest; the WhatsApp contract has not been verified against v26.0.
- **The correlation field.** `biz_opaque_callback_data`'s placement in a send is shown on no current page, and the Message API request schema does not list it. It stays at the top level as an assumption.
  - A rejection records `failed` and never resends.
  - A silent ignore leaves an indeterminate send resolvable only by its provider message id.
- **Webhook delivery.** Meta retries any non-200 for up to 7 days, with no 4xx/5xx distinction, to every subscribed app. Nothing documents disabling a webhook.
- **Account-wide delivery.** Every number on a subscribed account delivers to the app's callback unless it has an override, so test numbers must live on an account with no real number.

### 17.5 ADR 0018

**Exact proposed decision** (Proposed, amended to the final implementation, not Accepted):

1. a dedicated gateway role (`ops_gateway`: no table, exactly two target-bound DEFINER functions) and process, not the worker and not an edge function;
2. authenticity over the raw bytes first; the tenant only from an owner-configured provider target; a message acknowledged only once admitted or refused on the record, and an unrouted one answered non-2xx and stored nowhere;
3. Q8 on the channel: a closed real-data gate with no enabled value (a production channel only inactive), with `ENABLE ALWAYS` triggers behind it, opened only by a reviewed migration after the owner decides Q8, the lawful basis and consent;
4. a send only by a second, explicit operator act, with its preconditions (test channel, no stop, one CRM contact with a false opt-out flag, Meta's 24-hour window) checked afresh at request and before the one call. The send is at most once: ambiguity, Meta's generic codes included, is `indeterminate`, and nothing resends. Status callbacks are channel-bound;
5. conversations group; every message stays its own task.

**Recommended disposition: ACCEPT WITH AMENDMENT.** The architecture is sound and the text matches the code. The owner addendum should record three things:

- (a) opening the real-data gate requires an Accepted ADR, not only a migration, as dropping an `ops` trigger does;
- (b) the live test-number probe, run on a WhatsApp Business Account holding no real number, must settle the correlation's placement before any send beyond the probe itself;
- (c) R-16, the CRM's PUBLIC row-level-security helpers, is scheduled for its own decision, since it reaches every role.

### 17.6 Evidence (local, after the fix; not CI)

- `test:db` 15/15, after a clean reset with both Phase 2B migrations;
- `test:db:engine` 240/240 in 32 files;
- `functions` 1638/1638 in 65 files;
- security invariants 60/60;
- migration guard 139/139;
- upgrade replay PASS;
- typecheck, ESLint (0 errors, none in this change), build, `scan:build`, production scope and signing key green;
- mutations, each caught by its named assertion (§12): seven of the fix, ten of the implementation, and a CLI mutation restoring the old phase-blind failure path.
