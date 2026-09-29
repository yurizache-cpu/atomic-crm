# Production deployment — runbook

**Status (2026-09-29): IMPLEMENTED IN THE REPOSITORY; NO ACCOUNT, DOMAIN OR DEPLOYMENT EXISTS YET.** The configuration below is written for the recommended hosting (docs/PRODUCTION_HOSTING_DECISION_PACKET.md §9: Cloudflare Workers static assets for the frontend, Fly.io `gru` for the worker and gateway, Supabase `sa-east-1`). Creating the accounts in §6 is the owner's acceptance of that recommendation. **PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.** Invariants: SI-76 (the contract), SI-77 (the runtime and the publish path).

## 1. Topology

| Part | Where | Public surface | Carries patient data |
| --- | --- | --- | --- |
| Frontend (static Vite build) | Cloudflare Workers static assets: Worker `clinic-crm-staging` / `clinic-crm-production`, one custom domain each, `workers.dev` and preview URLs off | the app's HTTPS origin, with the declared headers (`_headers`) | **no**: the bundle holds none, and the browser calls Supabase directly |
| Worker (`node engine/worker/main.ts`) | Fly.io app `FLY_APP`, process `worker`, region `gru` | **none** (no service; a private health check on :8080) | yes (task content, model calls) |
| WhatsApp gateway (`node engine/cli/whatsappGateway.ts`) | the same Fly app, process `gateway` | HTTPS `https://<FLY_APP>.fly.dev`: the webhook path and `/healthz` only | yes (inbound bodies) |
| Database, Auth, edge functions | Supabase, one project per environment, `sa-east-1` | the Supabase API | yes |

Staging and production never share a Worker, a Fly app, a Supabase project, a variable or a secret.

## 2. Environments (GitHub → Settings → Environments)

One GitHub Environment per target, `staging` and `production`. Production should require the owner's approval and allow only the integration branch.

| Name | Kind | Holds |
| --- | --- | --- |
| `APP_HOSTNAME` | variable | the frontend's hostname, such as `app.<domain>` (plain name, no `https://`) |
| `VITE_SUPABASE_URL` | variable | `https://<project-ref>.supabase.co` of THIS environment's project |
| `VITE_SB_PUBLISHABLE_KEY` | variable | that project's publishable key (browser-safe by design) |
| `SUPABASE_PROJECT_ID` | variable | that project's ref (used by the database deploy, Milestone 2) |
| `CLOUDFLARE_ACCOUNT_ID` | variable | the Cloudflare account id |
| `FLY_APP` | variable | the Fly app for this environment (globally unique name) |
| `CLOUDFLARE_API_TOKEN` | secret | a token limited to Workers on this account and zone |
| `FLY_API_TOKEN` | secret | a Fly organisation deploy token |
| `SUPABASE_ACCESS_TOKEN` | secret | a Supabase personal access token (Milestone 2) |
| `SUPABASE_DB_PASSWORD` | secret | that project's database password (Milestone 2) |

The runtime's own secrets (the two constrained database URLs, the WhatsApp app secret and verify token, a model provider key) are **Fly secrets of the app**, never GitHub variables and never in the image. Milestone 2 provisions the database logins and sets them without a person handling the passwords.

## 3. Deploying

GitHub → Actions → **🌐 Deploy hosted (staging or production)** → Run workflow → choose the environment. Nothing deploys on a push.

1. **Gate**: typecheck, lint, the three unit projects (the same gate as `deploy.yml`).
2. **Database gate**: the live-database suites on the same commit (`database.yml`, SI-40).
3. **Frontend**: `npm run build` with the environment's variables, then `scripts/publish-cloudflare.mjs`, which writes `_headers`, runs the production preflight (a blocking finding uploads nothing), uploads with the pinned Wrangler, and holds the live origin's actual response to the host contract (retrying while it propagates). A failure prints the rollback command.
4. **Runtime**: the pinned flyctl (checksum-verified), the app created if missing, `flyctl deploy --ha=false` with `DEPLOYMENT_ENVIRONMENT` stated; Fly waits for both processes' health checks; then the gateway's `/healthz` over HTTPS.

The start gate refuses a production process with a fake decision or calendar provider, synthetic ingress or a local database, and a staging or production process with a local database, before it reads a secret (`engine/runtime/deploymentEnvironment.ts`).

The hosted **database** is deployed only by `deploy.yml`'s gated job (migrations, functions, the development-key and function checks); Milestone 2 connects it to these environments.

## 4. Checking a live environment

```bash
npm run verify:production-host -- --url https://<APP_HOSTNAME>/ --supabase-url https://<ref>.supabase.co
npm run verify:hosted-supabase -- --url https://<ref>.supabase.co --database
```

(`--database` needs `ADMIN_DATABASE_URL`, the owner credential, and reads in a read-only session.) Worker and gateway health: the Fly dashboard's checks, or `flyctl checks list --app <FLY_APP>`; logs carry counts and outcomes only (`flyctl logs --app <FLY_APP>`).

## 5. Rollback and stopping

- **Frontend:** `npx --yes wrangler@4.129.1 rollback --name clinic-crm-<environment>` (the version list: `npx --yes wrangler@4.129.1 versions list --name clinic-crm-<environment>`), or Cloudflare dashboard → Workers → the Worker → Deployments → Rollback. The previous 100 versions are eligible.
- **Runtime:** `flyctl releases --app <FLY_APP> --image` lists the images; `flyctl deploy --app <FLY_APP> --image <previous image> --ha=false` puts one back. A job in flight when a worker stops is recovered by its lease expiring (the reaper), never run twice.
- **Stop all model and outbound activity (the kill switch):** `npm run execution-stop -- trip --scope global --reason "<why>" --actor "<who>"` with `ADMIN_DATABASE_URL`, or, from the Company OS, a stop at tenant scope. A stop holds work; it is cleared only by a person (`execution-stop clear`).
- **Stop the worker process entirely:** `flyctl scale count worker=0 --app <FLY_APP>` (and `worker=1` to resume).
- **Close the WhatsApp webhook:** `flyctl scale count gateway=0 --app <FLY_APP>`; Meta keeps undelivered messages and retries (SI-53).

## 6. Owner actions to create the environments

Done by the owner, never by an agent; no secret value is ever typed into a chat. Doing them accepts the recommended hosting. Staging alone first is fine.

1. **Validate the two tools** (dependency policy): Wrangler `4.129.1` (Cloudflare's CLI, published 2026-09-07) and flyctl `0.4.100` (Fly.io's CLI, published 2026-09-07).
2. **Cloudflare:** create a free account; add the clinic's domain as a site on the Free plan and switch the domain's nameservers at its registrar to the two Cloudflare shows (wait for "Active"); create an API token from the "Edit Cloudflare Workers" template, limited to this account and this zone; note the account id.
3. **Fly.io:** create an account and add a card; pick two globally unique app names (such as `<clinic>-runtime-staging`, `<clinic>-runtime-production`); create an organisation deploy token.
4. **Supabase:** a production project on a Pro organisation (from US$25/month, daily backups, no idle pause) and a staging project in a separate free organisation, both in São Paulo (`sa-east-1`), each with its own strong database password kept in a password manager; a personal access token. Leave Auth settings as created (Milestone 2 applies them from the repository); never run the development seed against either.
5. **GitHub:** create the environments `staging` and `production` with the variables and secrets of §2 (production: required reviewer = the owner, deployment branch `feature/clinical-phase-1`).

**Needed before production go-live, not now:** a custom SMTP sender for Supabase Auth (the built-in sender reaches only the Supabase team's own addresses, two messages an hour, and is not meant for production), so that staff invitations arrive.

## 7. Validation (local, 2026-09-29)

- **Runtime image, run for real** against the local stack: with the image's default (production) it refuses a local database and, separately, a fake decision provider, naming the variable only; in `local` it runs the worker (health `200 ok` after the first poll) and the gateway (health `200`, an unsigned webhook `401`); both stop cleanly on SIGTERM (exit 0). The image holds `engine/` without tests, production dependencies and `package.json`, runs as `node`, and defaults to production.
- **Tests:** `engine/runtime` (the start gate, including real child processes that refuse before opening anything, and the health endpoint over a real socket), the gateway liveness path, the loop's poll signal, and `scripts/test/deploy-hosted.test.mjs` (the Worker configuration, the headers file, the publish ORDER with an injected upload and origin, and static checks of the workflow, image and Fly configuration). The `functions` project passes 2299 in 99 files (security invariants with SI-77) and the scripts tests 454 in 20 files.
- **Mutation-checked, each caught by name:** a fake provider allowed in production; staging skipping the local-database rule; a misspelt environment read as local; the worker or the gateway skipping the gate (or the gateway reading a secret first); failed polls refreshing health; the upload before the preflight; no live verification; `workers.dev` left on; extra header rules tolerated; the image running as root; a build context that is not an allowlist.
- **Builds:** the production build scans 0 blocking and passes the preflight with its generated `_headers`; a headers file made for another API is refused; the demo build scans 0 blocking. Typecheck and ESLint clean; the production-scope and signing-key guards pass (the new workflow's deploy jobs satisfy SI-40).
- **Not run here:** Wrangler and flyctl (no account; pinned and awaiting the owner's validation), and any hosted deploy.
