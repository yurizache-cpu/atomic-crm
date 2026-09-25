# Phase 2E.1 + 2E.2 — Observability foundation and operational intelligence: implementation report

| | |
| --- | --- |
| **Status** | **IMPLEMENTED; OWNER VISUAL REVIEW PASS (2026-09-24); OTLP WORKER EXPORT VERIFIED.** Local commits on `feature/phase-2e-observability`, not pushed, no PR. The owner approved Saúde operacional and then the three OpenTelemetry pins; the real worker's spans reach the local Collector (§7). Next: the owner's final confirmation and the single remote integration cycle (push, PR, merge into `feature/clinical-phase-1`). |
| **Base** | `feature/clinical-phase-1` at `b3d67c8fa0e0f4d7810accc9c82306d302c65c4a`, the PR #11 merge that integrated 2D.2 + 2D.3. Post-merge CI Check #68 (run 36051184957): Build, Test, Typecheck, ESLint and Database security & reproducibility passed; only the historical e2e baseline (9 failed, 1 skipped) and the Prettier baseline (`sampleCsv.test.ts`, `canAccess.test.ts`) are red, so the overall workflow is red. `main` unchanged at `a863e2a0`. |
| **Branch** | `feature/phase-2e-observability` |
| **Governing records** | Decisions I–O (2026-09-17: OpenTelemetry and Prometheus "integrate soon"), decision P (2026-09-22: observability in Phase 2E), [ARCHITECTURE_ACCELERATION_REVIEW.md](ARCHITECTURE_ACCELERATION_REVIEW.md) §15 (reuse policy), the Phase 2E brief (2026-09-24). |
| **Data** | Synthetic and test data only. BASELINE Q8 OPEN. No real patient data; no production deploy. |

## 0. Position

| | |
| --- | --- |
| Phase 2D decision-engine core | **INTEGRATED** (PR #10, PR #11) |
| Real Jev | **PENDING A VERIFIED PROVIDER CONTRACT.** There is no approved or verified Jev API, SDK, auth, pricing or data-processing contract; DecisionPort stays the boundary for a future provider. This does not block 2E, and nothing here touches it. |
| Phase 2E | **STARTED**: 2E.1 observability foundation, 2E.2 operational intelligence |
| OpenTelemetry | **Collector: adopted** (official image, local stack). **SDK: INSTALLED** (api 1.9.1, sdk-node and exporter-trace-otlp-http 0.222.0, owner-installed). **OTLP worker export: VERIFIED**: the real worker's spans reached the Collector (§7). |
| Prometheus | **Adopted** (official image, local stack). The worker serves `GET /metrics` with our own exposition writer, validated by `promtool`. |
| Authoritative system | Company Engine / PostgreSQL |
| Telemetry authority | **NONE** |
| Browser mutable RPCs | **2** (`decide_review`, `trip_stop`); no company_os_api function added (still 17) |
| Q8 | **OPEN** |

## 1. What this batch is

The Company OS becomes observable without gaining or losing any authority.

- **2E.1**: a provider-neutral telemetry boundary, the governed runtime instrumented through it, a private Prometheus endpoint in the worker, and a local, pinned Collector + Prometheus stack.
- **2E.2**: an exact, tenant-scoped operational read model built from PostgreSQL, and the owner's read-only screen **Saúde operacional**.

The owner can now answer from the Company OS: whether the engine is working (work runs, nothing is past its lease, the queue drains), whether work is backing up (ready and scheduled jobs, the oldest ready job's age), whether jobs fail, whether external calls end uncertain, whether agent runs and shadow decisions succeed, whether stops block work, and what it costs. None of it comes from telemetry, so it stays correct with the observability stack offline.

## 2. Telemetry foundation (2E.1)

- **`engine/telemetry/telemetryPort.ts`**: `TelemetryPort` (span, counter, histogram, gauge). `NOOP_TELEMETRY` is the default: nothing is recorded, no socket is opened and no request leaves. `guardTelemetry()` is the ONE boundary every caller passes before any adapter: it drops a span or metric the catalogue does not declare, sanitises every attribute and label, and contains every failure, so a broken exporter degrades to "nothing recorded".
- **`engine/telemetry/catalog.ts`**: the allowlist (SI-60). 5 span names, 13 span attributes, 9 metrics with their labels. Every value is a closed enum (job kind, outcome, operation, provider kind, failure class), a fixed pattern (`decision_shadow.vN`) or a lowercase uuid. The tenant, job and run ids are **span-only** and are never a Prometheus label. An undeclared attribute is dropped, and a rejected label value becomes `other`, so a series count is bounded by the catalogue. The "structured operational event" of the brief is the existing worker log (`engine/worker/log.ts`: one JSON line per event, fixed fields); it gains three `telemetry.*` events with fixed text.
- **Settlement observations.** Handlers do not import telemetry. An external-call handler's `settle` may return `{ detail, observation }`, where the observation is a closed-vocabulary fact (`agent_run` status and run id; `decision_evaluation` status and policy version). The runtime records it only AFTER the settle transaction commits, so a settlement that rolled back counts nothing, and neither does a replay that finds the run already settled. A `call` prepare may name its provider kind.

## 3. OSS adoption, and how the OpenTelemetry SDK was installed

- **Adopted** (reuse mode B, external services; [OSS_PROVENANCE.md](OSS_PROVENANCE.md), created by this phase as the first real adoption):
  - `otel/opentelemetry-collector:0.160.0@sha256:e495787f…` (Apache-2.0; 0.161.0 was younger than 21 days);
  - `prom/prometheus:v3.14.0@sha256:5ce7540c…` (Apache-2.0).
- **SDK: authorised, verified, then INSTALLED by the owner.** On 2026-09-24 the brief's packages checked out as official (`open-telemetry/opentelemetry-js`), Apache-2.0 and Node >=20.6-compatible (Node here: 22.23.1): `@opentelemetry/api` 1.9.1 (published 2026-03-25), `@opentelemetry/sdk-node`, `exporter-trace-otlp-http` and `exporter-prometheus`, all 0.222.0 (published 2026-08-31, 24 days old). The install was **refused by this repository's own dependency guard** (`.claude/rules/dependency-safety.md`, the `npm install *` deny in `.claude/settings.json`). Routing around a permission guard is not an agent's decision, so the first milestone shipped without it.
  - **Then (owner approval, 2026-09-24):** the owner approved exactly `@opentelemetry/api@1.9.1`, `@opentelemetry/sdk-node@0.222.0` and `@opentelemetry/exporter-trace-otlp-http@0.222.0`, as a repository change: the three pins were written to `package.json`, and the owner ran the plain install (`npm.cmd install`) because the guard also refuses an agent's argument-free `npm install`. The guard and `.claude/settings.json` are unchanged. The lockfile added 50 packages (Apache-2.0, MIT, BSD-3-Clause; one benign install script), recorded in [OSS_PROVENANCE.md](OSS_PROVENANCE.md) §3.
  - **The adapter:** `engine/telemetry/openTelemetry.ts`, the only file that imports OpenTelemetry (pinned by `catalog.test.ts`). It builds its own tracer provider with no resource detection (the resource is `service.name: company-os-worker` alone), no auto-instrumentation, no global registration and no context manager. A span's parent is passed explicitly. Spans go through a bounded batch processor (at most 2,048 queued, 5 s export timeout) to `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/traces` over OTLP/HTTP JSON. Shutdown flushes within 3 s and never throws.
  - **Opt-in:** without the variable the adapter is not even loaded (no network traffic, no error). An endpoint that is not a plain http(s) URL, or carries credentials, is refused with fixed text. An SDK that fails to start degrades to the no-op. Spans and the Prometheus registry are fed through `combineTelemetry`, each adapter contained on its own.

- **Prometheus without the SDK's exporter.** The acceleration review planned the worker endpoint as "about 30 lines". It is `engine/telemetry/prometheusRegistry.ts`, an in-memory registry rendering text format 0.0.4. It is not a metrics database, and `promtool check metrics` (from the pinned image) accepts its output.

## 4. Instrumentation

| Path | Span(s) | Metrics |
| --- | --- | --- |
| Worker: lease → outcome | `company_os.job.execute` (kind, attempt, tenant id, job id, outcome, failure class) | `company_os_jobs_total{job_kind,outcome}`, `company_os_job_duration_seconds{job_kind}`, `company_os_worker_active_jobs` |
| External call prepare (TX2a): stop checks, spend reservation | `company_os.governance.check` | (none) |
| The provider call (AgentRun, decision shadow) | `company_os.provider.call` (operation, provider kind, call outcome) | `company_os_external_calls_total{operation,outcome}`, `company_os_provider_duration_seconds{provider_kind,operation}`, `company_os_agent_run_duration_seconds` |
| Settlement (TX2b): outcome, spend settlement | `company_os.settlement` | `company_os_agent_runs_total{outcome}`, `company_os_decision_evaluations_total{outcome,policy_version}` after commit |
| Reaper tick | (none) | `company_os_worker_queue_depth`. The runs the reaper settles are NOT counted: its one number mixes indeterminate (stale running) and failed (orphaned pending) settlements, and only the database knows which (final review, P2). |
| WhatsApp send (operator CLI) | `company_os.whatsapp.send` | `company_os_external_calls_total{operation="whatsapp.send"}`, provider duration |

- **What is not instrumented.** No SQL query is spanned and no React action is traced.
- **The WhatsApp CLI path.** It is instrumented through the port, but the CLI is short-lived and has no exporter in this build, so it passes the no-op.
- **Cost.** It is NOT a Prometheus metric: the worker does not know the charged amount the database derives. Integer-micros cost lives in the read model (§6).
- **What a failure outcome means.** `company_os_external_calls_total` counts how the call itself ended (ok, error, timeout, cancelled); the business outcome (indeterminate and so on) is the settlement's.
- **Queue depth** needs one new worker capability, `ops.worker_queue_depth()` (migration `20260927120000_worker_queue_depth.sql`):
  - it is argument-free and STABLE, answers one count of ready jobs across the deployment, and is executable by `ops_worker` only (pinned in `company_domain_core.sql` A4/A5);
  - the worker already leases from every tenant, so the count reveals nothing new to it;
  - it is read on the reaper tick only when metrics are on, in its own contained transaction.

## 5. The metrics endpoint and the local stack

- **The worker listener** (`engine/telemetry/metricsServer.ts`, `fromEnv.ts`):
  - It runs in the SAME process, and only with `METRICS_ENABLED=true` and an explicit `METRICS_PORT`.
  - It binds `METRICS_HOST`, default `127.0.0.1`, and serves `GET /metrics` only: 404 elsewhere, 405 for other methods, `no-store` and `nosniff` headers.
  - Any problem (a bad variable, a port in use) turns metrics OFF, logged with fixed text naming the variable, never its value, and never stops or changes the worker.
- **`deploy/observability/`** holds the compose file, `otel-collector.yaml` and `prometheus.yml`:
  - it runs on its own network, never the Supabase network;
  - it holds no credentials and no environment, and ports are published on `127.0.0.1` only;
  - root filesystems are read-only, every capability is dropped and `no-new-privileges` is set;
  - Prometheus keeps 2 days of data, and the Collector only prints what it receives (debug exporter), forwarding nothing.
  - On Docker Desktop a container reaches the worker's loopback listener as `host.docker.internal` (measured), so the worker never listens on all interfaces.
  - Nothing needs the stack: the app, the worker and every test run without it.
- **`engine/telemetry/observabilityDeployment.test.ts`** pins all of it: loopback-only ports, digest-pinned official images, no credential or database network, a Collector that forwards nothing, and no `/metrics`, `METRICS_*` or `OTEL_EXPORTER` anywhere in the browser application's inputs. A mutant publishing Prometheus on `0.0.0.0` was caught.

## 6. Operational intelligence (2E.2)

- **The projection:** `ops.cos_operational_health(tenant, as_of, today)` (migration `20260927130000_operational_health.sql`, forward only).
  - It is returned by the EXISTING `overview` read as `operationalHealth`. No company_os_api function was added, so the catalogue stays at 17 with exactly two acts.
  - Tenant-scoped rows only: `ops.jobs`, `ops.agent_runs`, `ops.decision_evaluations`, `ops.outbound_messages`.
  - STABLE and SECURITY INVOKER, executable by no application role.
- **What it carries:**
  - **Queue:** ready (queued and due), scheduled (queued for later: backoff or a deferral), running (live lease), past-lease (the reaper returns them on its tick), the oldest ready job's time, and jobs that succeeded or failed in the last 24 h; also per job kind, adding up exactly.
  - **Agent runs:** created in the last 24 h, by status.
  - **Latency:** the provider latency of succeeded runs, always with the sample size. A median appears only from 5 samples and a p95 only from 20 (`percentile_disc`, deterministic), never from one or two observations.
  - **Shadow decisions:** requested in the last 24 h, by outcome (completed, abstained, invalid, failed, indeterminate, refused), and those pending now.
  - **WhatsApp sends:** created in the last 24 h, by status.
  - **Spend:** charged today (the tenant's budget day), in the last 24 h and in the last 7 days, keyed on `started_at` exactly as the spend limits count it, so "today" equals the budget's `spend_status` (T1b asserts it); and what running calls hold reserved now, whenever they were requested. All in exact integer micros via `ops.cos_money`.
- **What it never carries:** an id of any kind (T1b asserts it), a name, text or error, a score, a percentage or an SLA.
- **Contract:** `contracts/company-os-api/health.ts`, strict. A percentile must agree with its sample size, the per-kind rows must add up to the totals, and no shorter spend window may hold more than the last 7 days.
- **Screen:** Saúde operacional (`/company-os/health`, group Operação), read-only, polled every 15 s. Once the answer is older than two polling intervals every value reads "Desconhecido".
  - **Headline cards:** Na fila, Em execução, Falhas recentes, Resultado incerto, Revisões pendentes, Pausas ativas, Custo hoje.
  - **"Precisa de atenção"** lists only concrete states: a job past its lease, an agent run needing attention, an uncertain send still open, a shadow decision that ended uncertain, an active stop (or the platform blocking new runs), and failures in the last 24 h. Each is a link to its proof. With none of them, it says "Nada exige atenção agora."
  - **No judged age.** There is no approved threshold, so the oldest wait is shown as it is, never judged.
  - **Detail sections:** Fila e execuções (with Detalhes técnicos: per job kind), Agentes, Chamadas externas, Decisões em sombra, Governança, Custos.
  - **Owner language:** "Trabalho em execução", "Resultado incerto", "Execução que precisa de atenção", "Chamada externa".

## 7. Evidence (local)

| Suite | Result |
| --- | --- |
| `functions` (engine and supabase unit and static) | 2096/2096 (86 files), including the new telemetry tests: allowlist and sentinels, guarded boundary, Prometheus text, listener, configuration, worker facade, runtime isolation, and deployment guards |
| security invariants | 68/68 (SI-60 and SI-61 added; SI-56 gains T1b) |
| `app` | 460 passed, 1 skipped (the known skip); Company OS subset 213/213 with the new screen, its route in every cross-screen sweep (read-only controls, storage, error states) |
| `test:db` | 18/18. `company_os_api.sql` pins the new key paths and callee; the T1 differential proves tenant B's queue, spend, stops and run outcomes never reach tenant A; T1b recomputes a busy tenant's section from its own rows and finds no identifier. `company_domain_core.sql` pins the new worker function. |
| `test:db:engine` | 323/323 in 45 files, including `runtimeTelemetry.dbtest.ts` (real handler: counters equal the recorded settlement, a crash replay counts nothing twice and makes no second call, a throwing exporter changes no row) and the re-recorded Company OS responses |
| `test:db:upgrade` | PASS (legacy data kept its meaning) |
| typecheck, ESLint (every changed file), Prettier (every changed file), build, `scan:build`, production scope, signing key, script guards (166) | green |
| `promtool check metrics` (prom/prometheus v3.14.0) on the worker's exposition | exit 0, no lint finding |
| Stack: Prometheus scraping the real worker | during `npm run observability:demo`: `up` 1; `company_os_jobs_total` 6 agent runs + 5 decisions succeeded; `company_os_agent_runs_total` succeeded 5, indeterminate 1; `company_os_decision_evaluations_total{completed,decision_shadow.v2}` 5; queue depth peaked at 5. Every figure equals PostgreSQL's, and no series carries a tenant, job or run id. |
| **Stack: REAL WORKER SPANS RECEIVED (primary proof)** | `npm run observability:demo` with `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` ran the real worker loop. The Collector received **44 worker-produced spans**, 11 each of `company_os.job.execute`, `company_os.governance.check`, `company_os.provider.call` and `company_os.settlement`, one trace per job with the children parented to `job.execute`. The attribute keys were exactly the allowlisted `company_os.*` set, and the resource was `service.name: company-os-worker` alone. The uncertain run read `provider.call` Error and `agent_run.outcome: indeterminate`. The demo's synthetic message, advice, contact and draft text, and any SQL or password text, appear nowhere in the Collector's output. Prometheus scraped the same run (`up` 1, counters equal to PostgreSQL). |
| Stack: the Collector, historical manual probe | before the SDK was installed, a hand-sent OTLP/HTTP span answered 200 and appeared in the Collector's log. It proved the Collector's pipeline, not the worker, and is superseded by the row above. |
| OTLP adapter tests (`engine/telemetry/openTelemetry.test.ts`) | 4: the span tree, the allowlisted attributes and a `service.name`-only resource, with no sentinel content; the OTLP JSON body on the wire, captured by a local fake Collector, carries no sentinel and no host or process attribute; with a Collector that is down, the same job runs to the same outcome, through the same statements, with one provider call; a Collector that never answers still leaves shutdown within its bound |

## 8. Review (one focused pass)

One read-only reviewer covered the branch. It found **no P0 and no P1**. It checked:

- the allowlist and the guarded boundary (closed sets, span-only ids, stateless regexes, every adapter call contained and sanitised);
- the bounded Prometheus series;
- the runtime's statement order and transaction boundaries (unchanged), observations recorded after commit only, the replay path counting nothing, and no retry or second call;
- the queue-depth function's grants and pins, and the projection's tenant filter in every CTE;
- that `read_overview` is otherwise identical;
- the percentile gating, and the contract refinements holding for any valid SQL output;
- the catalogue still at 17 functions with two acts;
- the stack's pins, loopback ports, lack of credentials and read-only settings;
- no dependency added, the demo's fake-only providers, and SI-60/SI-61 matching their guards.

Every finding it raised is settled in the review-fix commit:

| Severity | Finding | Disposition |
| --- | --- | --- |
| P2 | The reaper's settled count was added to `company_os_agent_runs_total{indeterminate}`, but `ops.settle_stale_agent_runs()` also settles orphaned pending runs as `failed` | Fixed: telemetry no longer counts reaper settlements; the test pins that a reaper settlement never increases the counter |
| P3 | The spend windows were keyed on `created_at`, the budget day on `started_at` (a run held by a stop can start the next day) | Fixed: keyed on `started_at`; the reservation is every running run's; T1b checks "today" against `ops.spend_status()` |
| P3 | The compose comment implied a Linux container reaches a loopback-bound listener through `host-gateway` | Fixed: the comment says Docker Desktop only, and on Linux to bind the docker bridge address, never `0.0.0.0` |

After the fixes: telemetry and worker unit tests 328/328; `test:db` 18/18 (from a clean reset); `test:db:engine` 323/323 (the recordings are unchanged); `test:db:upgrade` PASS.

## 9. Authority, unchanged

Telemetry decides nothing: the no-op is the default, a throwing exporter changes no statement, transaction, outcome, retry or provider call (unit and driver-backed proofs), and nothing reads a metric or a span back. The operational screen reads PostgreSQL. The browser still has exactly two mutable RPCs and cannot clear a stop, send, write the CRM or open Q8. No real provider, patient text or production data is involved.

## 10. Carried forward (not fixed here)

- P3 copy (owner review, not changed): "Concluídos nas últimas 24 h" in Fila e execuções could become "Trabalhos concluídos nas últimas 24 h", to tell jobs from agent runs.
- Decision-calibration recomputation cost at future scale (2D.3); the same applies to `cos_operational_health`, which is recomputed on every overview read. It is indexed by tenant and bounded by the 24 h and 7-day windows, but at scale it may want a materialised summary.
- S7.1 `communication_status` refresh; the already-recorded review copy; the stop projection's partial-read issue; the 500-agent stop-target cap; old-worker deployment coordination (stop 2D.1 workers before the 2D.2 migration).
- `company_os_agent_runs_total` counts only settlements this worker recorded after a provider call. Runs settled by the reaper or at a later attempt's claim (a crashed attempt's run) are counted by the database (Saúde operacional), not by the metric. Splitting `ops.settle_stale_agent_runs()`'s answer by outcome would let the metric count them too.
- On a Linux Docker host, the local stack needs `METRICS_HOST` set to the docker bridge gateway address, because Docker Desktop's loopback proxying does not exist there.

## 11. Owner demo

Local and synthetic only.

1. `docker compose -f deploy/observability/docker-compose.yml up -d`
2. `COMPANY_OS_SYNTHETIC_INGRESS=enabled METRICS_ENABLED=true METRICS_PORT=9464 OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 npm run observability:demo` with `ADMIN_DATABASE_URL` and `OPS_WORKER_DATABASE_URL` on the e2e stack. The worker's spans appear in `docker logs company-os-observability-otel-collector-1`.
3. The demo admits six fictitious leads and runs them through the real worker loop, the fake providers and the real metrics listener:
   - five succeed, each opening a pending review and one shadow evaluation;
   - one meets a scripted provider 5xx and is recorded **indeterminate**, and nothing retries it.
4. Then open **Saúde operacional**.

## 12. What this batch does not do

It connects no Jev and adds no Model Router, Judge, autonomous decision or autonomous WhatsApp. It adds no scheduling, follow-up, RAG, pgvector, Google Ads, Umami, browser automation, Grafana, Langfuse, alerting or notification platform, and no proprietary monitoring. It adds no browser mutation, no company_os_api function, no job kind and no npm dependency. It opens nothing of Q8.
