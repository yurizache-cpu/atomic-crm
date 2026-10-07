# Cost-first remote staging

**Status (2026-10-02): INTEGRATED by PR #23 (normal merge `6da21fbd` into `feature/clinical-phase-1`).** **(2026-10-01) REMOTE SYNTHETIC STAGING WORKING.** Netlify frontend live and verified; Supabase Free staging with the 65 canonical migrations, no seed, Auth configured; AAL1 refused and AAL2 admitted in a real browser; the CRM and the Company OS usable on synthetic data; the real worker loop running locally against staging through its constrained role; no new recurring cost. **PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

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

## 11. Meta test probe (2026-10-02): COMPLETE except two unobservable items

This is ADR 0018 amendment 2's live probe, run on Meta's test number only, with synthetic text the owner typed. Nothing touched the owner's real numbers, and nothing touched the owner's earlier WhatsApp app ("whats Claude"), whose webhook points at the paused project `recepcao-clinica`.

**Setup:**
- **The owner's Meta business.** It is verified and has three WhatsApp accounts:
  - the real clinic number;
  - a WhatsApp Business app number;
  - Meta's test account, with the test number `+1 555-640-2728`.
- **The app.** The developer app "Webhook" (`1340639637877252`) stayed in development mode.
- **The gateway.** It ran locally through `scripts/with-staging.mjs --as gateway` (role `ops_gateway_login`). It was reached through an account-free `cloudflared` quick tunnel (release 2026.9.0, checksum verified), which the owner opened.
- **The secrets.** The app secret, the verify token and a temporary access token were held only in `%USERPROFILE%\.atomic-crm\staging.env`.
- **The staging test channel.** Owner acts through the connector:
  - one test channel mapping the test number's phone number id to `staging-clinic` and `reception-agent`;
  - the owner's phone registered as a test sender (`ops.register_test_sender`).
- **The owner-only act launcher.** The acts ran through a scratch launcher that builds an owner `ADMIN_DATABASE_URL` from the local file (pooler, verify-full). It was not added to the repository: `with-staging.mjs` deliberately never builds an owner URL.

**Verified:**

| ADR 0018 amendment 2 item | Result |
|---|---|
| Webhook verification | **PASS.** Meta's handshake was accepted with the right verify token. A wrong token answered 403 and an unsigned POST answered 401, both through the tunnel. |
| Signature behaviour | **PASS.** Meta's own signed sample and the owner's real messages were accepted by the `X-Hub-Signature-256` check over the raw bytes. |
| Webhook payload format | **PASS.** Meta subscribed the `messages` field at **v26.0**; the send pin stays at Graph v25.0. The v26.0 payload adds `contacts[].user_id` and `messages[].from_user_id` (the business-scoped user id, BSUID), and the parser accepted them. |
| Real inbound from the test recipient | **PASS.** It arrived even in development mode, once the app was subscribed to the test account (`POST /<test WABA>/subscribed_apps`, owner-approved). Before that, the test account delivered only to "whats Claude" and Meta's own dashboard app. |
| Brazilian sender format | The owner's mobile arrived as 13 digits, with the leading 9. |
| Q8 classification | The registered test sender's message became a `test` task: ADR 0020 D8 working end to end. |
| Contact policy | **PASS, fail-closed.** The first message arrived before the owner existed as a CRM contact, so it was admitted `do_not_contact`. Its review could not be accepted, and creating the contact afterwards did not change that. The second message, after the contact existed, was accepted. |
| Send request compatibility | **BLOCKED.** Eligibility passed. The outbound row committed `sending` before the one call, Meta answered error **131005** (access denied), and the row settled `failed` and was not resent (SI-50). Meta's own dashboard "Send message" failed the same way from both of the owner's apps. The token had both WhatsApp permissions and no account restriction, and the owner had full access to the test account. |
| Provider message id; status callback format; `biz_opaque_callback_data` placement | **NOT YET VERIFIED.** All three need one successful send. |

### Second run, the same day: the send works

- **The token.** The owner created a system user, `atomic-crm`, with access to two things only: the app "Webhook" and two WhatsApp accounts, the test account and the future clinic number. It holds no access to "whats Claude".
  - The existing system user "Employee" was not used, because it also reaches the owner's earlier app.
  - Its token is a `SYSTEM_USER` token for "Webhook", expiring 2026-12-01.
  - The first token generated carried only `whatsapp_business_management`, and the token was regenerated with `whatsapp_business_messaging` too. A send needs both.
- **The number.** By owner decision (DECISIONS.md, "Meta probe on the future clinic number"), the send ran on **+55 27 9XXXX-7402 (masked; the full number is kept in the external evidence log)**. The owner states it is not the clinic's current number but its intended future one.
  - It was subscribed to "Webhook" only for the test and unsubscribed right after; it delivers to "whats Claude" alone again.
  - The staging test channel maps its phone number id, and the owner is registered as its test sender.
- **The verify token was rotated before this run.** When the origin was down, `cloudflared` had logged a failed handshake's full URL, query string included, in the owner's terminal.

| ADR 0018 amendment 2 item | Result |
|---|---|
| Send request compatibility | **PASS.** Graph v25.0, a `text` message with `recipient_type: individual`, `preview_url: false` and `biz_opaque_callback_data` in the request body. Meta accepted it. Eligibility passed, the row committed `sending` before the one call, and it settled `sent`. The reply reached the owner's phone. |
| Provider message id | **PASS.** A `wamid.…` id, recorded on the outbound row. |
| Status callback format | **PASS.** Two signed v26.0 status callbacks parsed. One was a no-op for the row already `sent`; none of the gateway's delivery counters records it. The other moved the row to `delivered`, matched by the provider message id. |
| `read` status | **NOT OBSERVABLE.** The owner keeps read receipts off. |
| `biz_opaque_callback_data` | **Accepted in the send body.** Whether Meta echoes it on the status callback is not observable here: the gateway logs no payload (SI-52), and the match used the provider message id. It matters only for a send whose answer was lost, and it stays UNVERIFIED. |

The earlier 131005 was the user token, not the code: the same request went through with the system user token. The probe's evidence log is kept outside the repository; this section is its record.

**Left in place:**
- the "Webhook" app's subscription to the test account (not to the future clinic number);
- its callback URL, which points at a closed tunnel and is replaced on the next run;
- the system user `atomic-crm` and its token in `%USERPROFILE%\.atomic-crm\staging.env`;
- staging contact 7 "Yuri (teste)";
- the two staging test channels (the test number and the future clinic number) and their test-sender rows.

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

## 12. WhatsApp through the model layer (2026-10-03): resumed

PR #24 (ADR 0022) is integrated, and WhatsApp needs no gateway change to use it:
- **Classification:** a registered test device's message is `test` data.
- **Routing:** the triage agent's profile maps `lead_triage` to `reception_low_cost`; the database lists the authorized candidates; the worker in gateway mode calls the first one on OpenRouter.
- **Audit and shadow:** the provider and the cost are recorded, and the three Jev decisions follow in shadow.
- **Refusal:** any other number is `health`, and Q8 refuses it before any model or decision.

`engine/domain/whatsappGatewayRouting.dbtest.ts` proves both paths through the gateway's own login and the real worker runtime.

**The live staging pass, when the owner is ready:**
1. **The owner** starts a fresh `cloudflared` quick tunnel. The verify token is rotated in `%USERPROFILE%\.atomic-crm\staging.env`, and the owner pastes the tunnel URL and the token into the "Webhook" app's callback in Meta.
2. **The gateway:** `node scripts/with-staging.mjs --as gateway --pass WHATSAPP_APP_SECRET --pass WHATSAPP_VERIFY_TOKEN -- npm run whatsapp:gateway`.
3. **The owner** sends a message from the registered test device to the Meta test number. No real patient content is used.
   - **The device must be a CRM contact on staging, with the opt-out recorded false.** A reply reaches only such a contact (ADR 0021 W6), and once ADR 0025 Part A is integrated a front-desk agent holds every message from any other number before any model (A3), listing it as `contact_unresolved` in `npm run front-desk -- exceptions`.
4. **The worker:** `AGENT_MODEL_GATEWAY=openrouter STRUCTURED_DECISIONS_GATEWAY=openrouter node scripts/with-staging.mjs --as worker --pass OPENROUTER_API_KEY -- npm run staging:gateway-worker`.
5. **Verify:** the `test` class, the pool and candidates, the model served, the provider and the cost, the three Jev decisions, and the pending review. Nothing is sent unless the owner accepts the review and runs `npm run messaging -- send`.

**The live pass, 2026-10-03: PASS.**
- **Webhook:** a fresh quick tunnel and a rotated verify token. The gateway was up before Meta was touched, so no failed handshake could be logged. Meta's verification was accepted.
- **The message:** the owner sent "oi" from the registered test device to the Meta test number. One delivery was admitted: class `test`, the staging contact found, not do-not-contact.
- **The run:**
  - agent `reception-agent`, capability `lead_triage`;
  - Q8 candidates Luna, Qwen and Haiku in `reception_low_cost`;
  - `openai/gpt-6-luna` requested and served, provider `OpenAI` from the documented metadata;
  - 842 in / 167 out tokens, 11.9 s;
  - **168 micro-dollars**, equal to OpenRouter's reported cost.
- **The triage:** intent `other`, priority low, outcome `needs_input` (a bare greeting says nothing). The review is pending for a person.
- **Jev, in shadow:** intent `unknown` and department `no_action` (0.59), human escalation 0.30; lead intelligence's next action `human_review`; model advice Qwen. Three calls on the pinned build, 93 micro-dollars, each equal to OpenRouter's report.
- **Nothing was sent:** no outbound message, no data authorization. The gateway was stopped afterwards.
- **The browser decision (2026-10-03): DONE.** The owner opened that review on the Netlify site, signed in with password and TOTP (AAL2), and chose Aceitar → Confirmar. The review is `accepted`, recorded under the owner's own principal (`auth.uid()`), and the page and the database both show that no message was sent.
  - This closes the step left open on 2026-10-01: a person deciding a staging review in a real browser.
  - A gap observed on that page: "Inteligência de decisão" shows only the 2D shadow engine (off on staging). The ADR 0022 Jev decisions for the same task are stored but not yet shown there. That is a candidate UI follow-up. *(Implemented on 2026-10-03 on `feature/jev-review-insight`, ADR 0022 §I.1: a section "Decisões estruturadas" on the review page. Not yet on staging.)*

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**
