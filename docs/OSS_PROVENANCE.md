# Open-source provenance ledger

The ledger that [ARCHITECTURE_ACCELERATION_REVIEW.md](ARCHITECTURE_ACCELERATION_REVIEW.md) §15.3 requires from the first real adoption onwards. One entry per adopted component, with the twelve fields of §15.3 and, for each, what it holds, what it is sent, what credential it has and how it is removed (Phase 2E brief, stage 7). Created by Phase 2E.1 (2026-09-24), whose two official container images are the first adoption.

Nothing here is copied source: both components run unmodified as external services behind our own boundary (reuse mode B). The Company OS owns every piece of state; an adopted component observes, it does not decide (§15.5).

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
| **Data sent to it** | OTLP/HTTP spans, once the worker exports them (not in this build, §3): span names and the allowlisted attributes of `engine/telemetry/catalog.ts` only (kinds, outcomes, policy version, and the internal tenant, job and run ids), never content (SI-60) |
| **Removal path** | Remove its service from the compose file and unset `OTEL_EXPORTER_OTLP_ENDPOINT`. It is the single egress: swapping the backend is a change to its exporter, here and nowhere else. |

## 3. Authorised, verified, NOT adopted: the OpenTelemetry JS SDK

The Phase 2E brief authorised exactly five packages from https://github.com/open-telemetry/opentelemetry-js, subject to verification. The verification passed on 2026-09-24 (npm registry metadata):

| Package | Version | License | Published | Node engines |
| --- | --- | --- | --- | --- |
| `@opentelemetry/api` | 1.9.1 | Apache-2.0 | 2026-03-25 | >=8.0.0 |
| `@opentelemetry/sdk-node` | 0.222.0 | Apache-2.0 | 2026-08-31 | ^18.19.0 \|\| >=20.6.0 |
| `@opentelemetry/exporter-trace-otlp-http` | 0.222.0 | Apache-2.0 | 2026-08-31 | ^18.19.0 \|\| >=20.6.0 |
| `@opentelemetry/exporter-prometheus` | 0.222.0 | Apache-2.0 | 2026-08-31 | ^18.19.0 \|\| >=20.6.0 |
| `@opentelemetry/semantic-conventions` | 1.43.0 | Apache-2.0 | (not needed directly; transitive) | >=14 |

**They were not installed.** The install was refused by this repository's own dependency guard (`.claude/rules/dependency-safety.md`, the `npm install *` deny in `.claude/settings.json`), and routing around a permission guard is not an agent's call. The owner installs them, with the exact pins, when the OTLP adapter is written:

```bash
npm install --save-exact @opentelemetry/api@1.9.1 @opentelemetry/sdk-node@0.222.0 @opentelemetry/exporter-trace-otlp-http@0.222.0
```

`@opentelemetry/exporter-prometheus` is no longer needed: the worker's `/metrics` is our own ~150-line writer, validated by `promtool`. `@opentelemetry/sdk-node` pulls a large transitive tree (gRPC and protobuf exporters among it); an entry for the SDK is added here, with that tree recorded, at the moment it is adopted.
