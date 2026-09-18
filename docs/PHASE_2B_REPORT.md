# Phase 2B — official WhatsApp transport and human-approved outbound

| | |
| --- | --- |
| **Base** | `feature/clinical-phase-1` at `1e582d43f7357838554b45a54c25710835a445df` |
| **Branch** | `feature/phase-2b-whatsapp-transport` |
| **Date** | Built 2026-09-18 |
| **Status** | **BUILT, committed locally, NOT pushed.** Awaiting owner review. No CI run exists for it yet. `main` is untouched, and no deploy took place. [ADR 0018](adr/0018-whatsapp-transport-and-human-send.md) is Proposed. |
| **What it is** | The official Meta WhatsApp Cloud API in both directions. A signed delivery to a configured test number becomes one Phase 2A triage (one task, one run, one review). An accepted review can then be sent back, by a second and explicit operator act, at most once, with consent read afresh. |
| **Data** | **Test and synthetic only. BASELINE Q8 is OPEN and unchanged.** Only a channel the owner configured `test` can create work or send. A production channel's message is held as a fact with no content (SI-47). No real patient data was used, and no live Meta call was made (§13). |
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
                                      │   unknown/inactive → OS404 (acknowledged, nothing stored)
                                      │   production channel → communication.inbound_held, no content (Q8)
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
| Q8 gate from trusted configuration | channel `mode`, two `ENABLE ALWAYS` triggers | Done (SI-47) |
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
| Latest Graph API version is v26.0 (2026-07-29). **v25.0 is supported until 2028-07-29.** Expired versions are silently rerouted to the next oldest version. | [Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog), [versioning](https://developers.facebook.com/docs/graph-api/guides/versioning) | `META_GRAPH_API_VERSION` |
| The WhatsApp Message API reference documents v23.0, v24.0 and **v25.0**. Its examples and OpenAPI spec use v25.0. | [Message API reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api) | the pin |
| Handshake: `GET ?hub.mode=subscribe&hub.challenge=…&hub.verify_token=…`. Answer 200 with the challenge only when the token matches. | [Create a webhook endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint) | `answerSubscription` |
| `X-Hub-Signature-256: sha256=<hex>` is the HMAC-SHA256 of the POST body under the **app secret**. | same; [Messenger webhooks](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks) for the escaping note | `isAuthenticWebhook` |
| Answer 200. Otherwise Meta retries for up to **7 days**, and duplicates are possible. Payloads can reach **3 MB**. Up to 1000 updates per request. | [Webhooks overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview), create-webhook-endpoint | gateway answers, `WEBHOOK_MAX_BODY_BYTES` |
| Inbound text shape: `entry[].changes[].value.{metadata.phone_number_id, messages[].{from,id,timestamp,type,text.body}}`. | [messages webhook reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages), [text](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/text) | `parseWebhook` |
| Since April 2026, a user with a username may have no `from`. Business-scoped user ids arrive as `from_user_id`. | [Business-scoped user IDs](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/) | such messages are ignored, not guessed (§14) |
| Status values `sent`, `delivered`, `read`, `failed`, `played`. `errors[]` appears on failure. `biz_opaque_callback_data` is echoed only when it was set on the send. One message can be both `delivered` and `failed` (multiple devices). | [status webhook reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status), [support](https://developers.facebook.com/documentation/business-messaging/whatsapp/support) | `ops.receive_whatsapp_status` |
| Send: `POST https://graph.facebook.com/<version>/<PHONE_NUMBER_ID>/messages`, Bearer token, body `{messaging_product:"whatsapp", recipient_type:"individual", to:"+…", type:"text", text:{preview_url, body}}`. The body is at most **4096** characters. The success response carries `messages[0].id`, and it "does not indicate successful delivery". | [Send messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages), [text messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/text-messages) | `metaSender.ts` |
| `biz_opaque_callback_data` allows up to **512** characters (since 2024-01-26). | [WhatsApp changelog](https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog) | the correlation |
| **No idempotency key** and no duplicate-send protection is documented for `/messages`. | send, text, error-code and throughput pages, and the v25.0 OpenAPI spec (absence) | at-most-once (SI-50) |
| A user's message opens a **24-hour customer-service window**. After it closes, only templates may be sent, and "the user must have opted in". | [Send messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages) | eligibility rule (SI-49) |
| Error codes: 131047 (window closed), 131026 (undeliverable), 131048 / 131056 / 130429 / 80007 (rate limits), 190 (token), 131005 (permission), 100 / 131008 / 131009 (parameters), 368 (policy), 133010 (not registered), 131000 (unknown). Build on `code`, not HTTP status or titles. | [Error codes](https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes), [throughput](https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput), [about the platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform) | `metaSender.ts` error classes |

**Selected version: v25.0.** It is the newest version the WhatsApp reference itself documents, with the longest remaining support. The version is a reviewed constant, never an environment variable. The upgrade strategy is in `metaApi.ts`: read both changelogs, change the constant in a reviewed commit, re-run the adapter tests and, with test credentials, the live probe.

**UNVERIFIED on any current Meta page, and therefore the first thing a live probe must settle:**

1. **Where `biz_opaque_callback_data` goes in a send request.** The field is documented as accepted on free-form messages, and it is echoed in statuses. But its position in the request body is not shown, and the v25.0 OpenAPI `TextMessage` schema does not declare it. The adapter sends it at the top level.
   - If Meta refuses that with a 400, every send is recorded **`failed`** with code 100 or 131009, and is never resent. That is the safe direction, but it would make sending unusable until the placement is corrected.
2. **Which HTTP status each error code arrives with.** Classification therefore keys on the error code (Meta's advice). A 4xx other than 408 is a rejection; a 5xx and a 408 are ambiguous.
3. **Whether webhooks are ordered.** No guarantee is documented. Status reconciliation ranks states instead of trusting arrival order.

## 4. Architecture, and what it deliberately reuses

- **Two ports, one per direction** (`engine/communication/types.ts`).
  - Inbound envelopes still carry no tenant.
  - `OutboundTransport` executes one send the database already authorized. It decides nothing, never retries, and never throws.
  - The Phase 2A `CommunicationPort` still has no send method.
- **A new gateway process and role** ([ADR 0018](adr/0018-whatsapp-transport-and-human-send.md) §1).
  - `ops_gateway`: NOLOGIN, USAGE on `ops`, EXECUTE on exactly two functions, no table.
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
| `ops.receive_whatsapp_message(text, text, text, text, timestamptz)` | **DEFINER**, empty search path | `ops_gateway` only | Admit one message on the channel the target names, or hold it (production). |
| `ops.receive_whatsapp_status(text, text, text, timestamptz, text, text, text)` | **DEFINER**, empty search path | `ops_gateway` only | Reconcile one status on that channel's sends. |
| `ops.configure_whatsapp_channel` | INVOKER | no application role | Owner: create or update a channel. Another tenant's target raises OS409. |
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
- **What is read.** Only `type: "text"` messages with a digits-only `from`, plus statuses. Media, reactions, system messages, username-only senders and blank bodies are counted as ignored and never guessed at. Timestamps are clamped to "not later than now".
- **The tenant.** It comes only from `metadata.phone_number_id` → the one active channel with that target. Nothing else in the payload is consulted; a delivery that names a tenant, company or `synthetic: true` changes nothing (tested).
- **Idempotency.** A redelivery, sequential or concurrent, converges on the one ledger row, task and run. The same message id with a different message raises OS409 and creates nothing.
- **Answers to Meta.**

  | Outcome | HTTP answer | Why |
  | --- | --- | --- |
  | admitted, replayed or held | 200 | processed |
  | unknown target, validation failure or conflict (`OS40x`, SQLSTATE classes 22 and 23) | 200, counted as refused | a permanent refusal would otherwise be redelivered for 7 days |
  | anything else | 500 | Meta delivers again, and the redelivery converges |

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

**The eligibility rule** (`ops.whatsapp_send_eligibility`). It is read at the request and again in `begin`, immediately before the call, holding the kill-switch lock shared. It refuses with a reason, in this order:

| Reason | Meaning |
| --- | --- |
| `conversation_not_found` | no such conversation in this tenant |
| `channel_inactive` | the channel was deactivated |
| `q8_production_channel` | not a test channel |
| `execution_stopped` | a global, tenant or company stop covers it |
| `crm_unavailable` | this tenant does not own the CRM |
| `contact_not_found` / `contact_ambiguous` | not exactly one CRM contact for the number |
| `consent_unknown` | the contact has no lead profile, so no recorded opt-out state |
| `do_not_contact` | opted out |
| `outside_service_window` | the contact's last message is more than 24 hours old |

**The basis for a reply** is the contact's own message within 24 hours, together with a recorded, false opt-out. `do_not_contact = false` alone is never sufficient. Whether that basis is lawful under LGPD for the clinic is **an owner decision (§15)**.

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
  | 4xx other than 408 | `failed`, with a code and class, never the provider's text |
  | 5xx, 408, timeout, network error, refused redirect, 2xx without an id, oversize answer, or a transport exception | `indeterminate` |

- **Crashes.**
  - Before `begin`: the send stays `authorized`, and the next `send` resumes it and calls once.
  - After `begin`: it stays `sending`. A rerun makes no call.
  - `npm run messaging -- outbound mark-indeterminate` settles it only when it is older than 5 minutes; a status callback can settle it too.
  - If the settle transaction itself fails, the tool reports `settlementRecorded: false` and the send stays `sending`.
- **No resend.** No command, service or timer resends. There is no `retry` or `resend` subcommand (tested).

## 9. Status reconciliation (SI-51)

`ops.receive_whatsapp_status` maps the target to its channel (active or not). It then finds the send by:

- (tenant, channel, provider message id); or
- when the send's outcome is unknown (`sending` or `indeterminate`), by the correlation this system sent in `biz_opaque_callback_data`, **and only if the recipient equals the conversation's contact**.

It applies the provider's own ranking: `sent` < `delivered` < `read`. `failed` is accepted from `sending`, `indeterminate` or `sent`, and delivery evidence after a failure wins.

- **Answers.** `updated`, or `ignored` (a duplicate or older news), `unmatched` (unknown to this channel) or `unsupported` (`played`, or any undocumented value). Nothing but `updated` is stored.
- **One fact per step.** Each step records one `communication.delivery_updated` event under an idempotency key, so a redelivered status is one fact.
- **Tenant-bound.** A target cannot reach another channel's, and so another tenant's, send (SQL F2 and driver-backed).

## 10. Operator surface

| Command | What it does |
| --- | --- |
| `npm run gateway:provision` | Create `ops_gateway_login` (needs `ADMIN_DATABASE_URL`, `OPS_GATEWAY_PASSWORD`). |
| `npm run whatsapp:gateway` | Run the gateway (`OPS_GATEWAY_DATABASE_URL`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`; optional `WHATSAPP_GATEWAY_HOST` default `127.0.0.1`, `…_PORT` default 8787, `…_PATH` default `/webhooks/whatsapp`). TLS and the public name belong to a reverse proxy or tunnel. |
| `npm run messaging -- channels list \| channels set …` | List or configure channels (`--mode test\|production`, `--inactive`). |
| `npm run messaging -- send --review … --tenant … --operator …` | The only send (`WHATSAPP_ACCESS_TOKEN`, read by `send` only). |
| `npm run messaging -- outbound list \| outbound show` | Ids, statuses, reasons and error classes, never text or recipient. `show` adds `eligibleNow`, read fresh. |
| `npm run messaging -- outbound mark-indeterminate` | Settle a send left `sending` by a crash, after 5 minutes. |

No secret is printed. Errors carrying a connection string are reported by SQLSTATE only, and a missing variable is named, never its value (tested).

## 11. Content and retention inventory (SI-52)

| Data | Stored in | Why | Retention / erasure |
| --- | --- | --- | --- |
| Inbound message body | `ops.tasks.description` | the agent run's prompt is built from the task (Phase 2A) | **none defined**: owner decision before Q8 |
| Sender's WhatsApp id (a phone number) | `ops.inbound_messages.contact_ref`, `ops.conversations.contact_ref` | reply target, 24-hour rule, CRM match | **none defined** |
| Body fingerprint | `ops.inbound_messages.body_fingerprint` (SHA-256, `inbound.v2`) | conflict detection | as the ledger row |
| CRM reference | `ops.inbound_messages.crm_contact_ref` (`crm:contact:<id>`) | audit of what admission saw | as the ledger row |
| Reply draft | `ops.review_items.proposed.response_draft` (Phase 2A) | read at send time, never copied | as the review |
| Send record | `ops.outbound_messages`: ids, states, provider id, error code and class | at-most-once, audit | no text, no recipient |
| Events | `communication.*`: ids, states, reasons, resolution | audit | never a body, draft, number or secret (tested) |
| Gateway logs | stdout, one JSON line per event | operations | counts and outcomes only (tested) |
| Raw webhook payloads | **not stored** | Meta suggests storing every payload; not done, deliberately (minimisation) | — |
| Production channel messages | **not stored** (a held fact only) | BASELINE Q8 | cannot be recovered later |

## 12. Tests

All local, on the e2e stack (`atomic-crm-e2e`, ports 5434x). **No CI run exists yet: the branch is not pushed.**

| Gate | Result |
| --- | --- |
| `npm run test:db` | **15/15 suites**. New: `whatsapp_transport.sql`, sections A–G: roles attempted one by one, RLS forced, the DEFINER and search-path pin, trusted mapping, Q8 triggers, CRM adapter answers and no-write, the send state machine, status scope, no send trigger. Updated: `company_domain_core.sql` A1/A4/A5 and the Data API exposure probe's presence checks. |
| `npm run test:db:engine` | **236/236 in 32 files** (Phase 2A: 205 in 30). New: `whatsappInbound.dbtest.ts` 11 and `whatsappOutbound.dbtest.ts` 20. They run the real gateway handler and store over `ops_gateway_login`, a real worker run, and a counting fake transport. |
| `functions` unit project | **1625/1625 in 65 files.** New or changed: `metaWebhook.test.ts` 11, `metaSender.test.ts` 13, `webhookGateway.test.ts` 8, `engine/cli/whatsappGateway.test.ts` 5, `engine/cli/messaging.test.ts` 5, `migrationInvariants.test.ts` 136 (+5), `securityInvariants.test.ts` 59 (+7). |
| Security invariants | **59/59**: SI-46 to SI-52 added; SI-21, SI-44 and SI-45 restated. |
| Upgrade replay (`npm run test:db:upgrade`) | **PASS**: legacy data keeps its meaning through every migration, `20260918150000` included. |
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

1. **The correlation's placement is unverified** (§3). If Meta refuses it, sends fail definitively, which is safe but unusable, until it is fixed.
2. **No retry of any send.** `failed` and `indeterminate` are final except for provider evidence. Replying again needs a new review.
3. **Senders without a phone number** (BSUID or username only) are ignored. Supporting them needs a contact key other than the number, and a CRM match that does not exist.
4. **Media, templates, interactive messages and reactions are not handled.** A reply outside the 24-hour window would need a template, which does not exist here.
5. **The CRM match is exact on digits, and scans `public.contacts`.** Fine for a pilot; an indexed normalised phone column would be a CRM schema change, deliberately not made.
6. **An unknown sender's review cannot be accepted** (do-not-contact at admission), so a first-contact enquiry from a number not in the CRM can be triaged but never answered through this path.
7. **The opt-out check and the call are not atomic with the CRM.** An opt-out recorded in the seconds between `begin` and the provider's answer is not seen by that send.
8. **The 24-hour window is measured on this system's clock**, from when the contact's message was recorded. A send near the edge may be refused by Meta (131047) and is recorded `failed`.
9. **A send honours global, tenant and company stops only.** Department, agent and job-kind stops do not cover it: a send has no job, and it is not an agent's act.
10. **The gateway has no rate limit** of its own beyond body bounds and timeouts. TLS, the public host and network filtering are not provided.
11. **A held production message is lost for good.** Meta will not redeliver an acknowledged message.
12. **Phase 2A limitations carried over:** the production-readiness gate from Phase 1D.2 (`users` / `patchUser`, `delete_note_attachments`, development-secret debt, the makefile deploy path), and `supabase_read_only_user` (BYPASSRLS) can read every `ops` table, including the new ones.

## 15. Owner decisions this phase records and does not make

1. **BASELINE Q8** — unchanged and open. A test channel's messages still reach the configured model provider exactly as synthetic ones do. Only test numbers carrying test data may be connected.
2. **The lawful basis for a reply.** Is a service reply, within 24 hours, to a contact who wrote first and has not opted out, a lawful basis under LGPD for this clinic? Meta's policy also says the user "must have opted in". The CRM records no affirmative opt-in.
3. **Retention and erasure** of message bodies (`ops.tasks.description`), phone numbers (`contact_ref`) and drafts.
4. **Whether an unknown number may ever be answered**, or whether a contact must first be created by a person in the CRM (today: never answered).
5. **Hosting of the gateway:** TLS termination, public name, network filtering and secret storage.
6. **ADR 0018:** accept, amend or reject.

## 16. Next

Phase 2C (the operator surface) is **not started**. Before any real patient message:

- Q8 decided;
- the owner decisions in §15 made;
- the live test-number probe run and §3's unverified items settled.
