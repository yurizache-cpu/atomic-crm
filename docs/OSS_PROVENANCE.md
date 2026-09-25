# Open-source provenance ledger

The ledger that [ARCHITECTURE_ACCELERATION_REVIEW.md](ARCHITECTURE_ACCELERATION_REVIEW.md) §15.3 requires from the first real adoption onwards. One entry per adopted component, with the twelve fields of §15.3 and, for each, what it holds, what it is sent, what credential it has and how it is removed (Phase 2E brief, stage 7). Created by Phase 2E.1 (2026-09-24), whose two official container images are the first adoption; the OpenTelemetry JS SDK followed the same day (§3).

Nothing here is copied source: the two images run unmodified as external services behind our own boundary (reuse mode B), and the SDK is used as unmodified packages behind TelemetryPort (reuse mode A). The Company OS owns every piece of state; an adopted component observes, it does not decide (§15.5).

## 1. Prometheus

| Field | Value |
| --- | --- |
| **Project** | Prometheus (CNCF), the monitoring server |
| **Repository** | https://github.com/prometheus/prometheus |
| **License** | Apache-2.0 for the repository (`LICENSE` at the tag, per the GitHub license API); the image label `org.opencontainers.image.licenses` reads "Apache License 2.0". Nothing is reused below the image. |
| **Upstream release/tag** | `v3.14.0` (2026-08-18), the latest stable minor on 2026-09-24; `v3.15.0` was still a release candidate |
| **Exact commit SHA** | `d7598b7141418fa35be2b5ec5d0fefb634199610` (annotated tag object `b0fe514e0dd48d35050bda4da9bd35aafcfd159b`) |
| **Image** | `prom/prometheus:v3.14.0@sha256:5ce7540c3c00ef4ab0c9d2c995c6a5b9c421f44b4a115d97a2c7af3b1c21cbb0`, the project's official image (label `org.opencontainers.image.source` = the repository above); it runs as `nobody` |
| **Reuse mode** | B, external service |
| **Files/packages reused** | The container image only. No source, no npm package. The worker's `/metrics` endpoint writes the text exposition format itself (`engine/telemetry/prometheusRegistry.ts`); no Prometheus code is copied, and `promtool check metrics` from this image validates its output. |
| **Local modifications** | None |
| **Required notices** | None shipped: the image is pulled, not redistributed |
| **Upstream remote** | Not a fork; no remote |
| **Update strategy** | Move the tag and the digest together in `deploy/observability/docker-compose.yml` after the release has aged (the repository's 21-day caution), re-run the stack check (docs/PHASE_2E_REPORT.md §7) and `engine/telemetry/observabilityDeployment.test.ts` |
| **Owner decision** | I–O (2026-09-17, "integrate soon"), decision P (2026-09-22, observability in Phase 2E), and the Phase 2E brief (2026-09-24) authorising official images only |
| **Files and config we own** | `deploy/observability/docker-compose.yml` (its service), `deploy/observability/prometheus.yml` |
| **State held externally** | Scraped samples in the named volume `prometheus-data`, kept 2 days. They are copies of the worker's counters; nothing reads them back. |
| **Credentials held** | None: no database credential, no scrape credential, no remote write |
| **Data sent to it** | The worker's `/metrics` text: counts, durations and gauges labelled only by job kind, outcome, operation, provider kind and policy version (`engine/telemetry/catalog.ts`). No tenant, job, run, review, contact or message id, and no content (SI-60). |
| **Removal path** | `docker compose -f deploy/observability/docker-compose.yml down -v`, and unset `METRICS_ENABLED`. Nothing in the Company OS depends on it: the screens read PostgreSQL. |

## 2. OpenTelemetry Collector (core distribution)

| Field | Value |
| --- | --- |
| **Project** | OpenTelemetry Collector (CNCF), core distribution `otelcol` |
| **Repository** | https://github.com/open-telemetry/opentelemetry-collector-releases (the distribution) and https://github.com/open-telemetry/opentelemetry-collector (the core components) |
| **License** | Apache-2.0 for both repositories (GitHub license API); the image label reads Apache-2.0. The core distribution carries no contrib component. |
| **Upstream release/tag** | `v0.160.0` (2026-09-02). `v0.161.0` (2026-09-16) was newer but younger than 21 days on 2026-09-24. |
| **Exact commit SHA** | Releases repository `5c31bfdc7e8a68aed5e173673c6946299a694ee6` (annotated tag object `e66c67e1d2b9246feeb5beff684c1460f5a96ecb`); core repository tag `v0.160.0` object `109e6fa5484444f9e4d64a08b0a250212bbdcffa` |
| **Image** | `otel/opentelemetry-collector:0.160.0@sha256:e495787f07dbe432ce763ebaf5bc3d113850e9eee2250ade7a3da6a882d0d69a`, the official core image (label `org.opencontainers.image.source` = the releases repository); it runs as uid `10001` |
| **Reuse mode** | B, external service |
| **Files/packages reused** | The container image only; its `otlp` receiver, `memory_limiter` and `batch` processors and `debug` exporter (all core components, `components` output measured) |
| **Local modifications** | None |
| **Required notices** | None shipped: the image is pulled, not redistributed |
| **Upstream remote** | Not a fork; no remote |
| **Update strategy** | As Prometheus: tag and digest together, after the release has aged, then the stack check and the static guard |
| **Owner decision** | I–O (2026-09-17), decision P (2026-09-22), the Phase 2E brief (2026-09-24) |
| **Files and config we own** | `deploy/observability/docker-compose.yml` (its service), `deploy/observability/otel-collector.yaml` |
| **State held externally** | None persisted: it prints what it receives to its own log and forwards nothing |
| **Credentials held** | None |
| **Data sent to it** | OTLP/HTTP spans from the worker (§3), only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set: span names and the allowlisted attributes of `engine/telemetry/catalog.ts` only (kinds, outcomes, policy version, and the internal tenant, job and run ids), never content (SI-60) |
| **Removal path** | Remove its service from the compose file and unset `OTEL_EXPORTER_OTLP_ENDPOINT`. It is the single egress: swapping the backend is a change to its exporter, here and nowhere else. |

## 3. OpenTelemetry JS SDK

| Field | Value |
| --- | --- |
| **Project** | OpenTelemetry JavaScript (CNCF): the API, the Node SDK and the OTLP/HTTP trace exporter |
| **Repository** | https://github.com/open-telemetry/opentelemetry-js |
| **License** | Apache-2.0 for the repository and for each of the three packages (npm metadata). The 50 packages the lockfile added are all Apache-2.0 (34), MIT (6) or BSD-3-Clause (10); none is copyleft or source-available. |
| **Upstream release/tag** | `api/v1.9.1` (2026-03-25); `experimental/v0.222.0` with the stable `v2.11.0` it pins (2026-08-31, 24 days old on adoption) |
| **Exact commit SHA** | `api/v1.9.1` → `7e74509a4d848e94b2970bb5262dd3e8efeed0a2`; `experimental/v0.222.0` and `v2.11.0` → `0b72a81636fa476e8f1f1afd2ae0c90a1362194c` |
| **Reuse mode** | A, package |
| **Files/packages reused** | Exactly three direct dependencies, pinned without a range in `package.json`: `@opentelemetry/api` 1.9.1, `@opentelemetry/sdk-node` 0.222.0, `@opentelemetry/exporter-trace-otlp-http` 0.222.0. The lockfile records each with its sha512 integrity. `sdk-node` brings its transitive tree, among it the gRPC, protobuf and Zipkin exporters and the instrumentation loader hooks, none of which is imported or enabled. |
| **Local modifications** | None |
| **Required notices** | None shipped: the packages are installed from the registry, not redistributed or bundled into the browser build |
| **Upstream remote** | Not a fork; no remote |
| **Update strategy** | Move the three pins together (the `experimental/` line pins its stable `v2.x`), after the release has aged 21 days, by editing `package.json` and a plain `npm install` run by the owner (the repository's dependency guard refuses an agent's install). Then re-run `engine/telemetry/openTelemetry.test.ts` and the stack check (docs/PHASE_2E_REPORT.md §7). |
| **Owner decision** | I–O (2026-09-17), decision P (2026-09-22), the Phase 2E brief (2026-09-24) authorising the packages subject to verification, and the owner's approval of 2026-09-24 of exactly these three pins, installed by the owner with a plain `npm install` |
| **Files and config we own** | `engine/telemetry/openTelemetry.ts` (the ONLY file that imports OpenTelemetry, pinned by `catalog.test.ts`), `engine/telemetry/fromEnv.ts` (`OTEL_EXPORTER_OTLP_ENDPOINT`) |
| **State held externally** | None: spans are batched in memory (at most 2,048) and exported; nothing persists |
| **Credentials held** | None by default. An operator may pass OTLP headers through the SDK's standard `OTEL_EXPORTER_OTLP_HEADERS`; nothing in this repository sets one, and an endpoint URL carrying a user or password is refused. |
| **Data sent** | OTLP/HTTP JSON spans to `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/traces`, only when that variable is set: the catalogue's span names and allowlisted attributes, after `guardTelemetry` (SI-60). The resource is `service.name` alone: no resource detection, so no host, process, user or environment attribute. |
| **Install scripts** | One in the added tree: `protobufjs` 7.6.6 `postinstall` (`scripts/postinstall.js`), which only compares version schemes in the parent `package.json` and warns; it makes no network call and writes nothing. |
| **Removal path** | Unset `OTEL_EXPORTER_OTLP_ENDPOINT` (the adapter is not even loaded without it); to remove the code, delete `openTelemetry.ts` and its branch in `fromEnv.ts`, then remove the three dependencies. TelemetryPort, the metrics and every caller stay unchanged. |

Not adopted: `@opentelemetry/exporter-prometheus` (the worker's `/metrics` is our own ~150-line writer, validated by `promtool`) and `@opentelemetry/semantic-conventions` as a direct dependency (only the string `service.name` is needed).
