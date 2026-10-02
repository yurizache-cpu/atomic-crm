# Cost-first remote staging

**Status (2026-10-01): REMOTE SYNTHETIC STAGING WORKING.** Netlify frontend live and verified; Supabase Free staging with the 65 canonical migrations, no seed, Auth configured; AAL1 refused and AAL2 admitted in a real browser; the CRM and the Company OS usable on synthetic data; the real worker loop running locally against staging through its constrained role; no new recurring cost. **PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

## 1. The owner decision

The owner decided on 2026-09-29 to add no new recurring paid infrastructure until product validation. The decision has four parts:

- **Frontend:** a NEW site on the owner's existing, already paid Netlify account.
- **Database:** ONE new Supabase Free project for synthetic staging. It uses the organisation's last free slot.
- **Worker and gateway:** they run LOCALLY against that project.
- **Superseded and deferred:** the Cloudflare frontend plan is SUPERSEDED before deployment, and Fly.io is DEFERRED. Nothing was created on either.

PR #22's provider-neutral assets remain valid:

- the host contract and its verifier;
- the environment contract and start gate;
- the Dockerfile and the health endpoints;
- `fly.toml`.

A paid resource that becomes technically necessary stops the work at **OWNER COST APPROVAL REQUIRED**.

## 2. Systems that must not be touched

These systems are identified by id, never by a fuzzy name.

| System | Identity | Rule |
| --- | --- | --- |
| The owner's existing clinic application | Supabase project `prisma-clinico-online`, ref `mppoqkoyrmhdmaojgvyo` | **DO NOT TOUCH — EXISTING CLINIC SYSTEM.** No migration, Auth change, reuse or repurposing. |
| The owner's paused Supabase projects | STL, FITNESS, consultorio-yuri, recepcao-clinica | Untouched: no restore, no pause, no delete. |
| The owner's other Netlify sites | About 26 sites in team `yurizache`, including the public clinic sites | Untouched. Only the site below belongs to this CRM. |

## 3. What exists

| Resource | Identity | Cost |
| --- | --- | --- |
| Supabase project `atomic-crm-staging` | ref `erhrochojnugszkkoqrv`, region `sa-east-1`, organisation "app claude" (Free), created 2026-09-29 | US$0 (Free) |
| Netlify site `atomic-crm-staging` | id `78793ce9-0c80-41c6-af27-5c02449d1a94`, `https://atomic-crm-staging.netlify.app`, team `yurizache` | US$0 new (existing paid account) |

This project holds **synthetic data only**. It is never a production database, and no production project exists.

## 4. Frontend publish (Netlify)

The build carries only browser-safe values. The staging API URL and its publishable key are public by design. Never add a service-role key, a secret key, a database password, a model key or a WhatsApp secret.

```bash
VITE_SUPABASE_URL=https://erhrochojnugszkkoqrv.supabase.co VITE_SB_PUBLISHABLE_KEY=<the project's publishable key> npm run build
NETLIFY_UPLOAD_GRANT=<the upload URL the Netlify connector's deploy-site issues> VITE_SUPABASE_URL=… VITE_SB_PUBLISHABLE_KEY=… node scripts/publish-netlify.mjs --environment staging --site-id 78793ce9-0c80-41c6-af27-5c02449d1a94 --hostname atomic-crm-staging.netlify.app
```

`scripts/publish-netlify.mjs` (SI-77) runs these steps, in order, in one process:

1. It stages a copy of the build as `site/`, adds `_headers` (the declared set, `scripts/host-headers-file.mjs`) and `_redirects` (the SPA fallback), and places beside it a `netlify.toml` that publishes `site/` with no build command.
2. It runs the production preflight over exactly that `site/`.
3. It uploads only the staged directory with the pinned uploader `@netlify/mcp@1.15.1`. That release was read before use and is about ten months old; the current release was four days old and was not used.
4. It holds the live site's actual response to the host contract, and checks that the page loads this build's scripts (`scripts/live-release.mjs`).

No source file, environment file or key leaves the machine. **Build from a clean tree.** An untracked `public/r/` (a local `registry:build` output, ignored by git) puts the unpublished component registry into `dist/`, and the preflight refuses it (ADR 0008). The first attempt on 2026-09-29 was refused this way before anything was uploaded.

**Rollback:** Netlify › the site › Deploys › the last verified deploy › Publish deploy.

**Measured on 2026-09-29, deploy `6abbeabc66509a25a3b64a2b`:**

- The verifier found 0 blocking and 0 advisory findings.
- The live response carries the declared CSP, Permissions-Policy, Referrer-Policy and `nosniff`.
- HSTS is `max-age=31536000; includeSubDomains; preload`: Netlify adds `preload`, which is stronger than the contract.
- A plain `http://` request gets a 301 to HTTPS.
- `netlify.toml` is not served (404).
- `r/registry.json` answers only with the application page (the SPA fallback); no registry is published.
- The one preflight advisory: five source maps are published. The source is public in the repository, so this is a decision, not a leak.

## 5. Supabase staging bootstrap

**Done on 2026-10-01. No database password was used or seen.** The Supabase CLI was logged in from the owner's dashboard session through the CLI's own device flow; the CLI needs a real console, which `winpty` from Git for Windows provides. Every step named the project explicitly (`erhrochojnugszkkoqrv`); `prisma-clinico-online` was never addressed.

1. **Signing key:** `node scripts/dev-signing-key.mjs --project-ref erhrochojnugszkkoqrv` passes: the hosted project does not trust the development key (SI-20). It still passes after the Auth push.
2. **Migrations, never the seed:** `supabase db push`, with no `--include-seed`.
   - Its temporary login role (`cli_login_postgres`, NOINHERIT, acting as `postgres`) applied 61 files.
   - The four OD-8a files refuse that role on purpose: their `session_user` must be `postgres`. Each was applied as `postgres`/`postgres` through the management API with `supabase db query --linked --file <file>`, which runs one atomic transaction (measured).
   - Each was then recorded with `supabase migration repair --status applied <version> --linked`, and the push resumed.
3. **PostgreSQL 17:** the project runs 17.6, where those four files could not apply as written. See PHASE_2C_REPORT.md §3.2 and SI-54 on the automatic creator membership of PostgreSQL 16+. The repository now pins and tests 17.
4. **Auth and API:** `supabase config push`, using the `[remotes.staging]` override in `supabase/config.toml`. Each section's diff was read before it was accepted. The push set:
   - the Company OS RPC schema exposed (and not `storage`);
   - the site URL and the one redirect URL on the Netlify origin;
   - self-registration closed;
   - the email provider kept on, and email confirmation kept on;
   - TOTP enrolment and verification on, which was already the hosted default.

   The Free plan refuses custom email templates without custom SMTP, so staging keeps Supabase's own.

**Verified (read-only, 2026-10-01):**

- **Migrations:** 65 applied, and their version list hashes equal to the repository's.
- **No seed and no data:** no seed mark, no tenant, no `ops.operator_assurance_exemption` row, no model-data authorization, no channel, no user.
- **Row security:** RLS is on for every `public` and `ops` table.
- **Function privileges:** `anon` and PUBLIC execute no `public` function; `authenticated` executes exactly the six row-security helpers.
- **AAL2:** `public.current_sales_id()`, `public.is_admin()` and `ops.operator_scope()` require it.
- **Retention:** the ledger and its capability exist.
- **Ownership and exposure:**
  - `ops_operator_api` holds only the automatic creator row;
  - nothing is owned by the CLI's login role;
  - the attachments bucket is private, and realtime publishes nothing.
- **Hosted verifier:** `npm run verify:hosted-supabase` reports 0 blocking and 0 advisory findings.
- **With the publishable key alone:**
  - CRM tables answer 401;
  - `company_os_api` answers 401;
  - `ops` is not exposed (406);
  - sign-up answers `signup_disabled`.

## 6. Remote browser test (2026-10-01)

The owner created their staging account in the dashboard: email and password, auto-confirmed. They signed in on the Netlify site and enrolled TOTP through the CRM's own second-factor flow. Creating accounts on a hosted system is the owner's act, never the assistant's. Then, through the connector, as recorded owner acts:

- `public.bootstrap_owner` made that account the CRM owner (`sales_id` 1, logged in `public.owner_provisioning_log`).
- One synthetic onboarding transaction created:
  - the loss reasons;
  - the tenant `staging-clinic`, which owns this CRM;
  - one company, three departments and two agents;
  - the owner's Company OS membership;
  - six fictional contacts (`example.com` addresses), whose lead profiles came from the database's own trigger.

  It inserted no MFA exemption row.

**Measured in the owner's browser session:**

- **AAL1 is refused, AAL2 admitted.** After the password sign-in and before TOTP, `configuration` answered 406: no row is visible at AAL1. After the factor's challenge and verify, the same request answered 200. The database held one session at `aal2` and one verified TOTP factor.
- **The CRM:** the six synthetic contacts list. The avatar falls back to initials, with no Gravatar.
- **The Company OS:** the overview opens on "Synthetic staging clinic" under "Ambiente de teste · somente dados sintéticos ou de teste · Q8 em aberto". Every `company_os_api` call answered 200.
- **Network:** the page reaches exactly two origins, itself and the Supabase project.
- **The upstream beacon:** the first measurement showed an upstream Atomic CRM usage beacon (an image from `atomic-crm-telemetry.marmelab.com`) on every load. The CSP blocked every attempt, so nothing was sent. `src/App.tsx` now renders `<CRM disableTelemetry />`, a Gate A.1 test pinned in SI-73 refuses its return, and after republishing the beacon is gone.
- **The service worker:** the app's service worker keeps serving the previous build until a later load activates the new one. The publish command's live check fetches without it, so it verifies the new build at once; a browser may show the old one for one reload.

## 7. Company OS on staging, runtime local (2026-10-01)

**Constrained roles.** `ops_worker_login` and `ops_gateway_login` were provisioned by the repository's own provisioning SQL, with SCRAM-SHA-256 verifiers in place of the passwords. The passwords were generated straight into the local secrets file and never printed; only the verifiers went to the database. Both roles are LOGIN, NOINHERIT and without BYPASSRLS, each a member of its NOLOGIN role only.

**Connection.** Through Supabase's IPv4 session pooler (`aws-0-sa-east-1.pooler.supabase.com:5432`, user `<role>.<ref>`), with `sslmode=verify-full`. The trust anchor is Supabase's root, "Supabase Root 2021 CA" (SHA-256 `807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`), read from the pooler's own chain, whose leaf is `*.pooler.supabase.com`. Compare it with the dashboard's "SSL Configuration" certificate before production.

**Commands:**

```bash
node scripts/with-staging.mjs --as worker -- npm run staging:fake-worker
```

- `scripts/with-staging.mjs` hands the child ONE role's URL, removes every other database URL, and sets `DEPLOYMENT_ENVIRONMENT=staging`.
- `npm run staging:fake-worker` is the real worker loop with the scripted lead-triage provider; the deployable worker refuses the fake provider by design. It refuses every environment but staging.

**Governance, as owner acts:**

- the scripted model's price;
- the AI budget: a global daily ceiling and a tenant daily budget of US$0.16 each, about US$4.80 a month, inside the owner's US$5 cap.

**The synthetic end-to-end run:**

- **Admission:** one synthetic message became one `lead_triage` task with data class `synthetic`, one run and one job.
- **The local worker** (as `ops_worker_login`, with `DECISION_SHADOW_PROVIDER=fake`) worked two jobs:
  - the run **succeeded**, charged 1 micro-dollar, with no data authorization involved;
  - its review opened;
  - `decision_shadow.v2` recommended accept at 0.82, with human review required.
- **Audit:** 15 lifecycle events.
- **Retention:** no retention clock, correctly: D6/D7 retention applies to `health` and `person_text` content only. It is exercised on staging with the WhatsApp test probe.
- **Not yet performed on staging:** the human decision in the browser. The review stays pending and nothing was sent (0 outbound messages). The decision path is covered by the SQL and driver-backed suites and the earlier local owner tests.

## 8. Costs

- **New recurring cost:** US$0. The Netlify site is on the existing paid account; Supabase is the Free plan.
- **Model spend:** 1 micro-dollar, on the scripted provider.
- **Avoided:** Cloudflare, Fly.io, Supabase Pro, custom SMTP and a model account.

## 9. Is a remote runtime needed yet?

**No.** Everything validated so far ran with the worker on this machine.

The next validation that needs something reachable from the internet is the Meta test probe (ADR 0018 amendment 2), because the gateway must receive Meta's webhook over HTTPS. Two options, in order:

1. a free tunnel to the local gateway for the duration of the probe;
2. only if that is refused or insufficient, **OWNER COST APPROVAL REQUIRED — REMOTE RUNTIME**, reusing `fly.toml`.

A real model run with synthetic content needs a model account and its key in the local secrets file. That is an owner action and a spend inside the US$5 cap.

## 10. Requirements recorded for go-live (not needed for staging)

- **Custom SMTP.** Supabase's default sender reaches only the project's team members, about two messages an hour. Real invitations need a custom SMTP provider.
- **Production database.** A second Free project is not taken while staging uses the last free slot. Go-live stops at **OWNER PRODUCTION DATABASE DECISION REQUIRED**.
- **Remote runtime.** The worker and gateway run locally until a 24/7 worker or a public webhook is truly needed. That point stops at **OWNER COST APPROVAL REQUIRED — REMOTE RUNTIME**.
