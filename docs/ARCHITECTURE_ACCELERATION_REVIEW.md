# Architecture acceleration review — open-source reuse gate before Phase 2A

| | |
| --- | --- |
| **Base** | `feature/clinical-phase-1` at `6aa52a32d7102bc4dfc8cf9fbdcd1a3b1a36e093` (Phase 1D.2 integrated, CI verified) |
| **Status** | **CLOSED 2026-09-17.** Owner decisions **I–O accepted** (§14) and the **OSS source-reuse policy approved as written** (§15), on the branch `feature/architecture-acceleration`. Also recorded in [DECISIONS.md](DECISIONS.md) and [ROADMAP.md](ROADMAP.md). |
| **Date** | 2026-09-17 |
| **Type** | Research and decision document. **No implementation code changes. Phase 2A is not started. Nothing was installed, cloned or run.** |
| **Question** | Which remaining Company OS capabilities should we build with Claude Code, and which should be accelerated with genuinely free, self-hostable open-source software? |
| **Method** | Four timeboxed read-only research passes against upstream sources only: the repository page, the raw `LICENSE` file at HEAD, official docs, release history. Every license below was read from the upstream file, not from a summary. Anything unverified is labelled as such. |
| **Policy applied** | The owner's: permissive (MIT / Apache-2.0 / BSD / PostgreSQL) preferred; AGPL/GPL flagged, never silent; source-available, fair-code and Enterprise-gated do **not** qualify as acceptable open source. "On GitHub" is not "open source". |

---

## 1. Executive conclusion

**Yes — the exact intended Company OS can be preserved while cutting remaining custom engineering, but the saving is much smaller than the candidate list suggests, and it comes from four or five narrow pieces of infrastructure rather than from any product.**

Three findings drive everything below.

1. **The expensive part of this product is the part no OSS gives us.** What remains to build is mostly *clinic business semantics wired into an existing governed runtime*: lead triage, follow-up, approval queues, the operator view, WhatsApp conversation state, the Company OS domain. Every orchestrator, workflow engine and agent framework we examined re-implements the *runtime* (queues, retries, schedules) — which Phases 1A–1D.1 already own, with tenancy, leases, idempotency, one kill switch and spend accounting that none of them offer. Adopting one would place work **outside** those guarantees.
2. **The genuinely free, genuinely commodity items are small and sit at the edges.** `pgvector` (PostgreSQL License), OpenTelemetry (Apache-2.0), Prometheus (Apache-2.0), Umami (MIT), Playwright (Apache-2.0, already here). Each is a thin, replaceable dependency with a one-file adapter. Together they remove perhaps 3–6 weeks of work we would otherwise do badly.
3. **The biggest single capability on the roadmap — WhatsApp — has no acceptable open-source answer.** Every OSS gateway reaches WhatsApp through unofficial, reverse-engineered WhatsApp Web access, risking a ban of the clinic's number, and the two best-shaped ones are additionally Enterprise-gated (WAHA Plus) or now require phone-home license activation (Evolution API ≥ 2.4.0). The official transport is a paid Meta SaaS whose integration surface is tiny: one HTTPS call out, one webhook in. **We build that adapter.**

**Net:** roughly **15–25%** less remaining custom engineering, concentrated in observability, analytics, vector search and browser automation. **Phase 2A takes no new dependency at all.**

The honest headline: this review's main value is not the list of things to adopt. It is the list of things we were at risk of adopting — n8n, Kestra, Trigger.dev, Chatwoot, Langfuse, an OSS WhatsApp gateway — each of which would have duplicated or undermined the governed runtime we just finished paying for.

---

## 2. Proprietary core — what stays ours, unconditionally

Unchanged by this review, and not up for substitution:

- the tenant/company security model, and tenant resolution from a live lease (ADR 0002, ADR 0012, SI-13/14/21);
- `Company`, `Department`, `Agent`, `Task`, `Event`, `AgentRun`, `Decision` — the Company OS domain (ADR 0015);
- the Company Engine: job leasing, the three-transaction shape, attempts, deferral, crash-safe re-lease;
- idempotency (`ops.create_task`, `ops.record_event`, tenant-scoped agent-run keys, SI-38);
- provider routing and the `ModelProvider` boundary (ADR 0016);
- authoritative spend accounting, price versions, budget and ceiling enforcement (ADR 0017, SI-35/36);
- the ONE kill switch and its lease-time evaluation (SI-31, SI-37);
- permission / risk / governance, human approval semantics, the owner/operator model and its bootstrap (SI-41);
- the audit event stream — one event per lifecycle change, in the same statement;
- organisational agent orchestration, and the eventual custom UX.

No external framework replaces any of these. Where an OSS product offers something similar, that similarity is the reason to keep it *outside* the boundary, not to move in.

---

## 3. Commodity work we should stop rebuilding

Concretely, five things — and only these — are not worth writing ourselves:

1. **Telemetry transport.** Emitting spans and metrics in a vendor-neutral format, and routing them. OpenTelemetry SDK + Collector: one env var and a YAML pipeline.
2. **Operational metric storage and alert evaluation.** Prometheus scrapes a text endpoint. Writing a metrics store is absurd; writing the endpoint is 30 lines.
3. **Vector similarity search.** `pgvector` inside the Postgres we already run. An index type and an operator — a custom implementation would be strictly worse.
4. **Website / funnel analytics.** Umami, if and when marketing attribution matters. The whole integration is one HTTP POST.
5. **Browser automation.** Playwright, already in the repository. We never write a browser driver; we write the permission layer around it.

Everything else on the candidate list either duplicates the engine, fails the license policy, or is smaller to build than to integrate.

---

## 4. Build / Adopt / Integrate matrix

Recommendation is exactly one per capability. "Work saved" is the custom engineering avoided, in rough developer-days, not calendar time.

| Capability | Current status | Rec. | OSS candidate | License | Why | Integration cx | Operational cx | Work saved |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CRM contacts, companies, notes, tasks | Exists (Atomic CRM fork) | **BUILD** | Twenty | AGPL-3.0 + commercial files | Already working and already ours; Twenty is a *replacement*, not glue, and AGPL §13 would reach a hosted fork | — | — | 0 |
| Lead profiles, consent (`do_not_contact`) | Exists (SI-42) | **BUILD** | — | — | Clinic semantics, LGPD-bearing | — | — | 0 |
| Sales pipeline / stages | Exists (ADR 0013) | **BUILD** | — | — | Tenant vocabulary as data | — | — | 0 |
| WhatsApp transport | Not built | **BUILD** (adapter over paid Meta API) | Baileys / WPPConnect / WAHA / Evolution | MIT / LGPL-3.0 / Apache-2.0 + paid Plus / modified | Every OSS path is unofficial reverse-engineered access → ban risk to the clinic's number; two are additionally gated | Low (1 POST + 1 webhook) | Low | −3 to −5 (build) |
| Conversation inbox / history | Not built | **DEFER** (build minimal now) | Chatwoot | MIT + proprietary `enterprise/` | Real capability, but it would hold patient conversation content and ships the enterprise tree in the same image | High | High | 10–20 later |
| Lead triage, response drafting | Phase 2A | **BUILD** | — | — | The product itself | — | — | 0 |
| Follow-up, templates | Not built | **BUILD** | — | — | Business rules over our own scheduler | — | — | 0 |
| Scheduling / bookings / calendar sync | Not built | **REFERENCE** (build minimal) | cal.diy | MIT (renamed from cal.com) | A second Next.js monolith + second Postgres + second identity model, currently untagged since v6.2.0 (2026-03-01), to get one clinic's booking | Very high | High | ~10 if adopted, but costs more |
| Product / web analytics | Not built | **INTEGRATE SOON** | Umami | MIT | Clean MIT, one Postgres, adapter is one POST | Low | Low | 5–10 |
| Business & agent analytics | Partly (operator CLI) | **BUILD** | — | — | Reads our own authoritative tables | — | — | 0 |
| LLM tracing / prompt mgmt / evals | Not built | **DEFER** | Langfuse | MIT + `ee/` Enterprise | `ops.agent_runs` already owns correlation, usage and derived cost; Langfuse adds ClickHouse+Postgres+Redis+S3 to duplicate it | High | High | 5–15 later |
| Workflows / recurring jobs / webhooks | Engine exists | **BUILD** | Node-RED / Kestra / n8n / Trigger.dev | Apache-2.0 / Apache-2.0 / SUL / Apache-2.0 | Our `ops.jobs` already has leases, attempts, deferral, kill switch, spend gate; a flow inside them sits outside all of it | — | — | 0 (negative) |
| External SaaS integrations | Not built | **BUILD** | Activepieces / n8n connectors | MIT + `ee/` / SUL | Connector libraries only pay off at dozens of integrations; we have two or three | — | — | 0 now |
| Google Ads / Google Analytics | Not built | **BUILD** (thin adapters) | — | — | Vendor SDK + our adapter; no OSS middleman needed | Low | Low | 0 |
| Finance / cost accounting | Exists (ADR 0017) | **BUILD** | — | — | Authoritative spend is ours | — | — | 0 |
| Operator/staff notifications | Not built | **DEFER** | Gotify | MIT | Genuinely tiny and clean, but it pushes to devices running a Gotify client; email/WhatsApp-to-owner covers the first need | Low | Low | 2–4 later |
| Human approval queues | Not built | **BUILD** | — | — | Governance semantics — core | — | — | 0 |
| Audit logs | Exists (`ops.events`) | **BUILD** | — | — | Already immutable and in-transaction | — | — | 0 |
| Knowledge / RAG / embeddings / vector search | Not built | **INTEGRATE SOON** | pgvector | PostgreSQL License | No new service, no new isolation boundary, rides existing Postgres | Low | Very low | 5–10 |
| Dedicated vector DB | Not needed | **DEFER** | Qdrant | Apache-2.0 | Clean license, real capability — but a second stateful service before we have a first corpus | Medium | Medium | 0 now |
| Document ingestion / files / search | Not built | **BUILD** | — | — | Supabase Storage + our pipeline; Postgres FTS before anything exotic | — | — | 0 |
| Browser automation | Playwright (tests) | **INTEGRATE** (expand) | Playwright | Apache-2.0 | Already here; no field-of-use restriction; we add the governance, not the driver | Medium | Medium (heavy image) | 15–25 |
| Secrets management | Env vars + owner creds | **BUILD/DEFER** | (Vault etc. not reviewed) | — | Deployment-provider secrets suffice at this scale | — | — | 0 now |
| Monitoring / metrics | Not built | **INTEGRATE SOON** (metrics endpoint now, server later) | Prometheus | Apache-2.0 | Text endpoint = near-zero adoption and exit cost | Low | Low–Medium | 3–6 |
| Tracing / distributed observability | Not built | **INTEGRATE SOON** | OpenTelemetry SDK + Collector | Apache-2.0 | One swappable egress point for every future backend | Low | Low | 5–10 |
| Error tracking | Not built | **DEFER** | (Sentry self-hosted not reviewed; BSL concerns) | — | OTel logs + our event stream first | — | — | — |
| Dashboards | Operator CLI | **DEFER** | Grafana | **AGPL-3.0** (flagged) | Free build is fine for internal use, but it is a viewer needing a store; our own read-model is more useful first | Low | Medium | 3–5 later |
| Feature flags | Not built | **BUILD** | PostHog flags | MIT + `ee/` | A config table and a helper; PostHog is a seven-service stack | — | — | 0 |
| Authentication | Supabase Auth | **ADOPT** (in place) | — | — | Already adopted and working | — | — | — |
| RBAC / permissions | Owner/operator + RLS | **BUILD** | — | — | Core governance | — | — | 0 |
| Deployment operations | GitHub Actions + Supabase | **ADOPT** (in place) | — | — | Already adopted | — | — | — |
| API testing / dev tooling | — | **OPTIONAL** | Hoppscotch | MIT | Developer convenience only; never runtime | — | — | ~0 |
| Isometric company interface | Not started | **BUILD** | — | — | The differentiating UX | — | — | 0 |

---

## 5. OSS shortlist

**ADOPT NOW (already in the repository; nothing new to install)**
- **Playwright** (Apache-2.0) — keep as the browser commodity layer, tests today.
- **Supabase / PostgreSQL** — the existing platform.

**INTEGRATE SOON (Phase 2B–2C, each behind one adapter)**
1. **pgvector** (PostgreSQL License) — when knowledge/RAG starts. Enable in a hand-written, statement-reviewed migration, in the `extensions` schema, never via unreviewed `db diff`.
2. **OpenTelemetry JS SDK + Collector** (Apache-2.0) — when observability starts. Emit OTLP; the Collector is the single swappable egress.
3. **Prometheus** (Apache-2.0) — expose `/metrics` from the worker as soon as there is a worker in production; the server itself can wait.
4. **Umami** (MIT) — when marketing attribution matters, not before.

**DEFER (revisit on a named trigger)**
- **Qdrant** (Apache-2.0) — only if pgvector stops scaling.
- **Gotify** (MIT) — only if staff need push alerts on phones.
- **Grafana** (AGPL-3.0, flagged) — only once Prometheus exists and the CLI is not enough.
- **Langfuse** (MIT core, `ee/` Enterprise) — only as an OTLP *exporter target*, never as the system of record.
- **Node-RED** (Apache-2.0) / **Kestra** (Apache-2.0) — only if a non-developer must author flows, and only at the edge. Kestra OSS has no multi-tenancy, RBAC or audit log (all Enterprise), which is precisely what this project treats as load-bearing.
- **Chatwoot** (MIT core + proprietary `enterprise/`) — only if a real multi-agent human inbox is needed, and only after Q8.

**REFERENCE ONLY (study, use no code)**
- **cal.diy** — booking domain model, availability rules, reschedule/cancel UX.
- **Twenty** (AGPL-3.0) — CRM UX patterns.
- **Trigger.dev** (Apache-2.0) — durable-execution ergonomics.
- **PostHog** (MIT + `ee/`) — analytics UX.
- **Arize Phoenix** (Elastic License 2.0) — its OTLP/OpenInference *shape* is the useful part; the code is not open source.

**REJECT (do not adopt under the owner's policy)**
- **n8n** — Sustainable Use License: source-available, with a clause forbidding offering it to third parties commercially.
- **Evolution API** — Apache-2.0 *plus* branding/attribution conditions backed by a commercial-license threat, and from v2.4.0 a mandatory phone-home activation that returns `503 LICENSE_REQUIRED` until licensed.
- **WAHA Plus** — multi-session and production features live in a closed paid image. (WAHA *Core*, Apache-2.0, is genuinely free but single-session.)
- **Arize Phoenix** — Elastic License 2.0 is not OSI open source.
- **Unofficial WhatsApp gateways for the production patient channel** (Baileys MIT, WPPConnect LGPL-3.0) — the licenses are usable; the *ban risk* to the clinic's number is the disqualifier.
- **Hoppscotch as runtime architecture** — it is an API client, not infrastructure. Fine as a developer tool.

---

## 6. License audit (verified upstream, 2026-09-17)

| Project | Repo | License at HEAD | Relevant dirs / packages | Commercial / Enterprise exceptions | Policy |
| --- | --- | --- | --- | --- | --- |
| pgvector | `pgvector/pgvector` | **PostgreSQL License** (BSD-2 derived), single LICENSE | whole extension | none | ✅ fits |
| OpenTelemetry Collector | `open-telemetry/opentelemetry-collector` | **Apache-2.0** (LICENSE at `main`) | collector core; contrib is a separate repo (not fetched) | none (CNCF) | ✅ fits |
| OpenTelemetry JS | `open-telemetry/opentelemetry-js` | **Apache-2.0** per repo metadata (*file text unverified*) | SDK packages | none | ✅ fits |
| Prometheus | `prometheus/prometheus` | **Apache-2.0** (LICENSE at `main`) | whole server | none | ✅ fits |
| Umami | `umami-software/umami` | **MIT**, single LICENSE, no `ee/` | whole app | Umami Cloud is a separate hosted service | ✅ fits |
| Playwright | `microsoft/playwright` | **Apache-2.0** | whole toolkit | none | ✅ fits (browser binaries are separately licensed upstream projects — *unverified*) |
| Gotify | `gotify/server` | **MIT** (GitHub reports "Other" — a detection artefact; text is unmodified MIT; logo is CC BY 4.0) | whole server | none | ✅ fits |
| Qdrant | `qdrant/qdrant` | **Apache-2.0** | engine | Cloud/control plane are separate products, not in-repo | ✅ fits |
| cal.diy | `calcom/cal.diy` | **MIT** — the `cal.com` repo was **renamed and relicensed**; enterprise code removed, not gated (`packages/features/ee/` 404s) | whole app | Teams/Orgs/Insights/Workflows/SSO no longer exist in the code | ✅ fits (see §14) |
| Node-RED | `node-red/node-red` | **Apache-2.0** | whole runtime | FlowFuse is a separate company/product | ✅ fits |
| Kestra (OSS) | `kestra-io/kestra` | **Apache-2.0**, verified: one LICENSE, no `ee/` | OSS edition | EE (separate distribution): multi-tenancy, RBAC, SSO, audit logs, worker groups, secrets managers, alt backends | ✅ fits, ⚠️ OSS has no tenancy/RBAC/audit |
| Trigger.dev | `triggerdotdev/trigger.dev` | **Apache-2.0** (per-package files *unverified*) | whole platform | Cloud-only: warm starts, autoscaling, checkpoints | ✅ fits |
| Hoppscotch | `hoppscotch/hoppscotch` | **MIT**, no `ee/` package | whole app | SSO is Enterprise (separate, non-public); recent release artefacts drifting enterprise-ward | ✅ fits (dev tool only) |
| Langfuse | `langfuse/langfuse` | **MIT** + `ee/`, `web/src/ee/`, `worker/src/ee/` under the Langfuse Enterprise License | MIT core covers tracing, prompts, evals, datasets, no volume limit | EE key needed for: project RBAC, protected prompt labels, retention policies, audit logs, data masking, UI customisation, SCIM, org/instance APIs | ⚠️ mixed — MIT core qualifies, `ee/` does not |
| PostHog | `PostHog/posthog` | **MIT** + `ee/` under the PostHog Enterprise License | MIT core covers capture, dashboards, flags | `ee/` needs a paid seat licence; **all paid-plan features are Cloud-only**; self-hosting officially unsupported | ⚠️ mixed; 7-service stack |
| Grafana | `grafana/grafana` | **AGPL-3.0-only**, with Apache-2.0 carve-outs (`packages/grafana-data`, `-runtime`, `-ui`, `-e2e-selectors`, `packaging/`, `kinds/`, `pkg/kinds*`, `pkg/registry/schemas/`, `grafana-mixin/`, …) | free build usable self-hosted | Grafana Enterprise is a separate keyed distribution: SAML, RBAC, data-source permissions, reporting, auditing, caching | 🚩 copyleft — flagged |
| Twenty | `twentyhq/twenty` | **AGPL-3.0** + `/* @license Enterprise */` files commercial + MIT SDK packages + an AGPL §7 "Application Exception" for API/webhook/SDK-only integrations | CRM core | enterprise-marked files (e.g. record sharing) | 🚩 copyleft — flagged |
| Activepieces | `activepieces/activepieces` | **MIT** except `packages/ee/` and `packages/server/api/src/app/ee` under the Activepieces Enterprise license | MIT engine + connectors | paid subscription for `ee/`; the prebuilt image ships `ee` code | ⚠️ needs a build boundary |
| Chatwoot | `chatwoot/chatwoot` | **MIT** except `enterprise/` under the Chatwoot Enterprise license | MIT inbox/channels/API | paid subscription for `enterprise/`; shipped image includes that tree | ⚠️ needs a build boundary |
| n8n | `n8n-io/n8n` | **Sustainable Use License** (source-available "fair-code") + `LICENSE_EE.md` for `.ee.` files | — | internal use only; no commercial provision to third parties; `.ee` needs a key | ❌ fails policy |
| Arize Phoenix | `Arize-ai/phoenix` | **Elastic License 2.0**; `packages/phoenix-otel` is Apache-2.0 | — | ELv2 forbids providing it as a hosted/managed service | ❌ fails policy |
| Evolution API | `EvolutionAPI/evolution-api` | **Apache-2.0 + added conditions** (logo/copyright must stay; visible "powered by" notice required; otherwise a commercial license "may" be required) | — | from v2.4.0 every instance must activate against the vendor's licensing server (`503 LICENSE_REQUIRED`) | ❌ fails policy |
| WAHA | `devlikeapro/waha` | **Apache-2.0** for Core (branch `core`) | Core only | WAHA Plus is a closed paid image; multi-session is Plus | ❌ fails policy (for our use) |
| Baileys | `WhiskeySockets/Baileys` | **MIT** | whole SDK | none commercially | ✅ license fits, ❌ ban risk |
| WPPConnect | `wppconnect-team/wppconnect` | **LGPL-3.0-or-later** | whole SDK | none commercially | 🚩 copyleft + ban risk |
| WhatsApp Cloud API | Meta (no repo) | **Proprietary, paid SaaS** | — | entire product | ❌ not OSS — but recommended transport (§8) |

Maintenance snapshot (2026-09-17): actively released within the last ~6 weeks — pgvector (v0.8.6, 2026-07-29), OTel Collector (v0.161.0, 2026-09-14), Prometheus (3.13.3, 2026-09-07), Umami (v3.4.0, 2026-09-17), Playwright (v1.63.0, 2026-09-04), Gotify (v3.1.1, 2026-09-15), Qdrant (v1.19.1, 2026-09-03), Node-RED (5.0.7, 2026-09-08), Kestra (v2.0.2, 2026-09-15). **cal.diy is the exception: commits are current but the last tagged release is v6.2.0 (2026-03-01), so self-hosting it today means tracking a branch.**

---

## 7. Architecture — adapter topology and source of truth

```
                         COMPANY OS  (ours)
                                |
        +-----------------------+------------------------+
        |                       |                        |
  COMPANY ENGINE           CRM ADAPTER              CUSTOM UX
  ops.* (ours)          public.* (Atomic fork)       (ours)
  tenancy, jobs,               |                        |
  agent runs, spend,           |                        |
  stops, events                |                        |
        |                      |                        |
        +----------- ADAPTER LAYER (ours, thin) --------+
                               |
   +----------+----------+-----+-----+----------+-------------+
   |          |          |           |          |             |
Communication Vector   Telemetry   Metrics   Browser      Analytics
 Adapter      Adapter   Adapter    Adapter   Adapter       Adapter
   |          |          |           |          |             |
WhatsApp    pgvector    OTel      Prometheus Playwright     Umami
Cloud API   (in our     Collector  (scrape)   (our perms)   (later)
(+ Postmark) Postgres)  (Apache)   (Apache)   (Apache)      (MIT)
 [paid SaaS] [PG lic.]
```

Rules that keep this replaceable:

- **One port per capability**, named and owned by us: `CommunicationPort`, `VectorSearchPort`, `TelemetryPort`, `MetricsPort`, `BrowserPort`, `AnalyticsPort`, `NotificationPort`. No vendor symbol appears outside its adapter module.
- **No OSS product holds Company OS state.** They observe, index or transport; they never decide.
- **Nothing external gets a credential to the clinical database.** Edge tools call our API; they are not given `ops` access.
- **Everything external is behind the kill switch** by construction: the call is made by a worker job, so `ops.execution_stops` and the spend gate apply.

**Source of truth, per integration**

| Integration | Authoritative owner | External ID mapping | Sync direction | Idempotency | Conflicts | Retention / deletion | Tenant boundary | Failure mode | Exit path |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| WhatsApp Cloud API | **Ours** (message ledger, tasks) | Meta `message_id` → our ledger row | inbound webhook → us; outbound us → Meta | unique `(message_id, recipient)`, claim-before-work (the Postmark pattern, ADR 0014) | last write wins on delivery status only | our retention policy; Meta holds its own copy | one WABA per tenant; ledger rows carry `tenant_id` | webhook 5xx → Meta retries; outbound failure → job retry then `indeterminate` | swap the adapter; ledger is ours |
| pgvector | **Ours** (same database) | none — same rows | n/a | insert is transactional with the source row | n/a | deleted with its row | same RLS as its table | index unavailable → degrade to no semantic search | `DROP INDEX`; data stays |
| OpenTelemetry | **Ours** (events remain authoritative) | `trace_id`/`span_id` alongside our `correlation_id` | one-way export | exporter-level dedup only | telemetry is lossy by design | short (days) | attributes must never carry patient content | collector down → drop spans, never block a job | remove the exporter env var |
| Prometheus | **Ours** | none | pull (scrape) | n/a | n/a | short | metrics are aggregate only, never per-patient | scrape failure = no data, no impact | delete the endpoint |
| Umami | Umami (traffic only) | anonymous site IDs | one-way from the browser/server | event-level, best effort | n/a | its own retention | no CRM ids, no patient data ever sent | outage = no analytics | drop the script + adapter |
| Playwright | **Ours** | n/a | n/a | job-level idempotency key | n/a | artefacts deleted after use | runs in our worker under our permissions | job failure like any other | replace with another driver behind `BrowserPort` |

---

## 8. Privacy and data flow (Q8 unchanged)

**BASELINE Q8 stays open. Nothing in this review changes it.** No real patient message body, clinical text, psychotherapy information or health data may reach a new external LLM or SaaS because an integration exists. Phase 2A stays synthetic-only.

Per candidate, what would touch personal data:

- **WhatsApp (any transport)** — carries patient message content by definition. This is the sharpest LGPD decision on the roadmap. Meta's Cloud API means Meta processes message content (it already does, as the platform operator). An OSS gateway self-hosted by us keeps the content on our infrastructure but reaches WhatsApp through unofficial access. **Neither option is a compliance conclusion**; both need a data-processing decision by the owner, separate from Q8.
- **Chatwoot** — would store full patient conversations in a second database. Defer until after Q8, and treat adoption as a data-protection decision, not a build-vs-buy one.
- **Langfuse / any LLM tracing** — traces contain prompts, i.e. potentially patient text. If it is ever adopted, redaction must happen **before** export, and the trace store must be self-hosted.
- **Umami** — must never receive a CRM id, contact id, phone number or any identifier that links back to a patient. Aggregate traffic only.
- **OpenTelemetry** — same rule: span attributes carry ids we already treat as internal (`tenant_id`, `job_id`, `run_id`), never message bodies or names.
- **pgvector** — embeddings of clinical text are derived personal data and stay inside our Postgres, under the same RLS. Embedding *generation* is an LLM call, so Q8 applies to it in full.

Does self-hosting help? It materially improves *data control options* — fewer processors, content on infrastructure we govern, deletion we can actually execute. It does **not** by itself establish LGPD compliance, and this document makes no legal claim.

---

## 9. Revised roadmap (future work only — completed phases unchanged)

Phases 0.5 → 1D.2 are complete and untouched.

| Step | Scope | New dependencies |
| --- | --- | --- |
| **Now** | This review; owner decisions in §14 | none |
| **Phase 2A** — synthetic lead triage pilot | Exactly the accepted brief. Verified ingress → idempotent task → `lead_triage` → agent run → structured advisory → human review → operator queue | **none** |
| **Phase 2B** — WhatsApp transport (synthetic) | `CommunicationPort`; Cloud API adapter; inbound webhook with signature verification; message ledger with claim-before-work idempotency; still no model-initiated sending | Meta Cloud API (paid SaaS, not OSS) |
| **Phase 2C** — operator surface and approvals | Approval queue, operator read-model, minimal notifications (email first), the first real UI slice | none |
| **Phase 2D** — observability | OTLP emission from engine + worker; `/metrics`; Collector in the deployment | **OTel (Apache-2.0)**, optional **Prometheus** |
| **Phase 3A** — follow-up and scheduling | Follow-up rules on our scheduler; minimal booking model; Google Calendar sync via its own API | none (cal.diy as reference) |
| **Phase 3B** — knowledge / RAG | `VectorSearchPort`; `pgvector` enabled by a hand-written migration; ingestion pipeline; retrieval gated by Q8 | **pgvector (PostgreSQL License)** |
| **Phase 3C** — growth: Google Ads, attribution, site analytics | Ads adapter; **Umami** if attribution needs it | **Umami (MIT)** |
| **Phase 4** — browser tools | `BrowserPort` over Playwright inside a governed job kind, permissioned and stopped by the kill switch | Playwright (already present) |
| **Later** | Isometric UX; dashboards (Grafana, flagged AGPL); dedicated vector DB (Qdrant) if pgvector is outgrown; inbox (Chatwoot) only if multi-agent human support is real | as decided then |

*(2026-09-22, dated note; the table above is left as the historical record. Its sequencing is superseded by decision P (see §14, decision N, and [DECISIONS.md](DECISIONS.md)), and the Phase 2C row's "Approval queue" and "minimal notifications (email first)" wording predates ADR 0019: the screen is the Reviews / Decision Queue, never a send-approval queue, and notifications are deferred (OD-13). See [PHASE_2C_BRIEF.md](PHASE_2C_BRIEF.md).)*

Sequencing rule added by this review: **a dependency enters only in the phase that needs it**, never "while we are in there".

---

## 10. Phase 2A impact

**Nothing in the accepted Phase 2A brief changes.**

- No OSS component should enter Phase 2A. Every candidate that looked relevant — a workflow engine for the flow, a tracing tool for the agent run, an inbox for the message — is either duplicated by the engine we already have, or blocked by Q8, or both.
- Phase 2A is faster and cleaner using the Company Engine directly: `ops.request_agent_run`, the `external_call` handler shape, the existing spend/stop gates, `ops.create_task` with an idempotency key, and the operator CLI for visibility.
- The only forward-looking discipline to adopt *now*, at zero cost: when 2A writes its ingress, put it behind the `CommunicationPort` shape that Phase 2B will implement for WhatsApp, so the transport is swappable from the first line.
- Explicitly **not** in 2A: OTel, Prometheus, pgvector, Umami, any gateway, any inbox.

---

## 11. Engineering and token savings (ranges, not precision)

| | Estimate |
| --- | --- |
| Remaining custom work, previous approach (build everything to the full vision) | ~**160–260** developer-days |
| Remaining custom work, after this strategy | ~**130–200** developer-days |
| Engineering reduction | ~**15–25%** |
| Token reduction on the affected work | ~**10–20%** overall; **50–80%** on the four capabilities we integrate instead of build |
| Calendar-time reduction | ~**2–5 weeks** across the remaining roadmap |

Where the saving actually comes from, largest first:

1. **Browser automation** (~15–25 days) — writing and maintaining a driver was never sensible; Playwright was already the answer.
2. **Vector search** (~5–10 days) — `pgvector` versus hand-rolled similarity.
3. **Observability** (~8–16 days combined) — OTel + Prometheus versus a custom metrics/tracing story.
4. **Web analytics** (~5–10 days) — Umami versus building funnels.

Where the saving is **zero or negative**, and this is the important half: workflow engines, agent frameworks, LLM tracing platforms, CRM replacements and WhatsApp gateways. Each would add a second runtime, a second datastore, a second credential store and a second upgrade treadmill around a core that already does the governed part better.

---

## 12. Things we should still vibe-code with Claude Code

Explicitly ours to build, because no acceptable OSS beats them at our scale:

1. **The WhatsApp adapter** — one outbound HTTPS client, one inbound webhook with signature verification, one idempotent message ledger. Smaller than any gateway's configuration.
2. **Lead triage, response drafting, follow-up rules and templates** — the product.
3. **The approval queue and operator surface** — governance semantics; every generic "human in the loop" tool would sit outside our risk model.
4. **Minimal scheduling** — availability, book, reschedule, cancel, plus Google Calendar sync via its own API. A few tables and rules versus a second monolith.
5. **Notifications** — start with email/WhatsApp-to-owner through the same `CommunicationPort`; a `NotificationPort` with one adapter beats installing a push server.
6. **Agent, model and business analytics** — read-models over `ops.agent_runs`, `ops.events` and the CRM; our data is already authoritative and richer than an external tool's copy.
7. **Feature flags** — a config table and a helper.
8. **External SaaS glue** (Google Ads, Analytics, Calendar) — a scheduled job kind plus an outbound HTTP handler reusing `engine/worker/externalCall.ts`'s shape, inheriting the lease, the stop check, the spend gate and the audit trail.
9. **Document ingestion and search** — Supabase Storage plus Postgres FTS, before anything exotic.
10. **The isometric company interface** — the differentiator; nothing off the shelf.

---

## 13. Exit strategy per adopted/integrated component

| Component | How we remove it |
| --- | --- |
| **pgvector** | `DROP INDEX` / drop the column; rows and RLS are untouched. Behind `VectorSearchPort`, swapping to Qdrant is one adapter. |
| **OpenTelemetry** | Unset the exporter endpoint. Spans stop; nothing else changes. The Collector is config, not code. |
| **Prometheus** | Stop scraping; optionally delete the `/metrics` endpoint. Text over HTTP — no lock-in. |
| **Umami** | Remove the script tag and the adapter's POST. Historical traffic data is disposable by definition. |
| **Playwright** | `BrowserPort` has one method per operation; another driver implements the same port. |
| **WhatsApp Cloud API** (not OSS) | `CommunicationPort` with the ledger owned by us; a different transport implements the same port. Message history stays in our database. |
| **Gotify / Grafana / Qdrant / Langfuse** (if ever adopted) | Each sits behind a port with our data authoritative; removal is deleting an adapter and a container. None is allowed to hold state we cannot rebuild. |

The rule that makes every row above true: **no external system is ever the system of record for Company OS state.**

---

## 14. Owner decisions I–O — ACCEPTED 2026-09-17

The seven decisions this review asked for were accepted by the owner on 2026-09-17 and are recorded as owner decisions **I to O** in [DECISIONS.md](DECISIONS.md) and [ROADMAP.md](ROADMAP.md). The letters continue the existing sequence: A–E belong to ADR 0017's owner-review addendum, F–H to Phase 1D.2.

| # | Question asked | Accepted as |
| --- | --- | --- |
| **I** | The open-source-first rule | Confirmed as stated. A mature capability that exists as genuinely free, self-hostable OSS is integrated behind one of our adapters; everything else is built with Claude Code. Source-available, fair-code and Enterprise-gated software does not qualify. |
| **J** | WhatsApp transport | The official Meta Cloud API (paid, not OSS) behind our own `CommunicationPort`, explicitly rejecting the unofficial gateways because a banned number is a patient-channel outage. A **cost and data-processing** decision, not a licensing one, and separate from Q8. |
| **K** | cal.diy | Reference only, despite the rename and MIT relicensing of the former `calcom/cal.com`. Revisited only if scheduling grows beyond one clinic. |
| **L** | AGPL posture | Grafana is allowed only as an internal, unmodified, self-hosted viewer if we ever need it; Twenty is reference only. No AGPL/GPL/LGPL code enters proprietary Company OS source without explicit owner review of that specific dependency and use (§15.1). |
| **M** | Chatwoot / patient conversation store | Deferred. An omnichannel inbox is **not** a Phase 2 goal, and conversation state stays authoritative in our database. |
| **N** | Observability timing | Phase 2D, after the first real flow exists. |
| **O** | Q8 | Remains **OPEN**. This review assumed so and changes nothing about it: no real patient message body, clinical text, psychotherapy information or health data reaches a real LLM provider until the owner decides it. |

*(2026-09-22, dated note: decision N above remains the historical record. Decision P supersedes its sequencing only: observability moves from Phase 2D to Phase 2E, observability and intelligence; the observability requirement and the OpenTelemetry and Prometheus direction (the integrate-soon adoption table, §4, and the shortlist, §5) are unchanged; Phase 2D is now the decision engine and Jev, shadow mode first. See [DECISIONS.md](DECISIONS.md), decision P.)*

Two consequences are worth restating, because they are the ones that turn into work: **J makes the WhatsApp adapter ours to build** — one HTTPS call out, one webhook in, the ledger in our database — and **M keeps conversation state out of any adopted product**, which is the same boundary §15.5 draws for source reuse.

---

## 15. OSS source reuse policy (owner decision 2026-09-17 — ACCEPTED as written)

**Once a component is APPROVED for implementation, cloning and reusing its upstream repository is allowed when that materially accelerates the work.** The "do not clone candidates" restriction applies to architecture and research reviews like this one — where dozens of repositories would be cloned merely to look at them — not to an approved implementation phase.

**In an approved implementation phase Claude may:** clone the upstream repository; read its whole tree, history, tags and releases; run it locally in an isolated environment; modify its source where the license permits; fork it when long-lived modifications are needed; extract appropriately licensed modules; build adapters around it; customise or remove behaviour; and maintain a patched version.

**The objective:** do not rebuild work that already exists when reusing its source is faster *and* safer.

### 15.1 License gate, before any source is copied or modified

1. Read the repository's **current** LICENSE at the commit being used.
2. Identify the license of the **exact files or packages** being reused — not the repository average.
3. Identify Enterprise/commercial directories (`ee/`, `enterprise/`, `packages/ee/`, license-marked files).
4. Confirm our intended use *and modification* is compatible with that license.
5. Preserve every required copyright and license notice.
6. Record the upstream repository, tag/commit and license (§15.3).
7. **Never import code from a differently licensed Enterprise directory**, even when the repository root is permissive.

Easy to reuse: MIT, Apache-2.0, BSD, PostgreSQL License and similarly permissive OSI licenses. **GPL / LGPL / AGPL code is not incorporated into proprietary Company OS source without explicit owner review of that specific dependency and use.** A public repository is not a license; the exact source being reused must carry an acceptable one.

### 15.2 Reuse modes — choose the cheapest maintainable one

| Mode | Use when | Notes for this project |
| --- | --- | --- |
| **A — Package** | The upstream library alone solves it | Adding an npm dependency is still gated: `.claude/rules/dependency-safety.md` denies new-package installs by permission, and the owner validates the specific package first. Cloning a repository does not bypass that gate. |
| **B — External service** | The product is a whole application | **Preferred for anything large.** It runs as its own container behind one of our adapters, holds no Company OS state and gets no credential to the clinical database. |
| **C — Fork** | We need persistent modifications to the application | Fork on GitHub, keep upstream history and an `upstream` remote, so security patches can be merged. |
| **D — Source extraction** | A small, clearly licensed module is simpler than the whole app | Record provenance and license beside the code. New engine code stays **outside** `src/components/`, which `registry.json` republishes publicly (ADR 0008). |
| **E — Reference only** | Adopting costs more than it saves | Study it, build our narrower version. This is what §5 recommends for cal.diy, Twenty, Trigger.dev and PostHog. |

**Fork is not the default** *(owner clarification, 2026-09-17)*. The mode follows the shape of the thing, not a preference: a library or package → **A**; a large standalone application → **B**, an external service behind an adapter; substantial persistent source modifications → **C**; a small, clearly permissive reusable module → **D**; adoption more expensive than implementation → **E**. Cloning or downloading an approved repository is explicitly allowed and encouraged during implementation whenever it materially reduces engineering work — **the objective is not to avoid forks.** The objective is the lowest **total implementation + maintenance + upgrade + exit cost**, which is also why §13 requires a removal path for every adopted component.

### 15.3 Version pinning and provenance

Never integrate against a moving target. Production dependencies take a tagged stable release, or a commit that was explicitly reviewed — cal.diy's lack of a tagged release since v6.2.0 (2026-03-01) is exactly the situation this rule exists to prevent.

The first real adoption creates the provenance ledger, `docs/OSS_PROVENANCE.md`. **No placeholder is created before then**: an empty ledger records nothing and goes stale. Each entry records:

- **project** — the component's name
- **repository** — upstream URL
- **license** — for the repository, and separately for the exact paths reused
- **upstream release/tag** — the selected version
- **exact commit SHA** — what we actually build against
- **reuse mode** — A package, B external service, C fork, D source extraction, E reference only (§15.2)
- **files/packages reused** — the precise surface, not "the repo"
- **local modifications** — what we changed and why
- **required notices** — the copyright and licence notices we must keep, and where they live
- **upstream remote** — the remote that lets security patches be merged back into a fork
- **update strategy** — how and when the pin moves
- **owner decision** — the decision that approved this adoption, by letter and date

### 15.4 Supply chain, proportional to risk

Before an approved component reaches production: read install and build scripts; look for unexpected network or telemetry behaviour and whether it phones home (Evolution API's licence activation is the worked example of why); check authentication defaults; scan dependencies; pin versions and image digests; identify required secrets; run containers without unnecessary privileges; disable optional telemetry. Prototyping gets proportional review, not a full audit — but anything that reaches patient data or production credentials gets the full one.

### 15.5 The boundary still holds

Forking or heavily modifying an OSS project never transfers ownership of Company OS state. Tenants, companies, departments, agents, agent runs, tasks, decisions, governance, permissions, budgets and kill switches stay authoritative in our database unless a new ADR says otherwise. An adopted product observes, transports or indexes; it does not decide.

### 15.6 The question to ask at implementation time

Does approved OSS already cover 70–90% of the requirement? Would cloning or forking save more time than adapting costs? Can it sit behind one adapter? Is the license compatible for the exact files used? Can we update or replace it later? **All yes → reuse the repository. Any no → build the narrower feature with Claude Code.**

---

**Classification: CLOSED.** Owner decisions **I–O are ACCEPTED** (§14, 2026-09-17) and the source-reuse policy in §15 is **APPROVED as written**, with the clarification that fork is not the default and external-service-behind-an-adapter is the default for a large application. No code changed, no dependency was added, nothing was cloned, downloaded, installed or run, and Phase 2A is not started. §15 governs approved implementation phases; it never licensed this review to clone anything.
