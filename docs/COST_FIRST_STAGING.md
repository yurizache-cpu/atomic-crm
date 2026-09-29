# Cost-first remote staging

**Status (2026-09-29): IN PROGRESS.** The frontend is live on Netlify and verified. The Supabase staging project exists but is EMPTY: its migrations wait for the owner's Supabase CLI login. **PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

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

**Pending: OWNER ACTION REQUIRED — SUPABASE (CLI login).** The CLI on this machine is not logged in. The migrations cannot be applied through the connector: it records its own version for each migration, so the history would not match the repository's files.

After the owner's `npx --yes supabase@2.117.0 login`, the bootstrap runs in this order:

1. **Link:** `supabase link --project-ref erhrochojnugszkkoqrv`.
2. **Signing-key check:** confirm the hosted project does not trust the development signing key (SI-20).
3. **Migrations:** `supabase db push` with the repository's canonical migrations only. **NEVER the seed** (SI-25).
4. **Auth configuration:**
   - site URL and redirect URLs point to the Netlify site;
   - TOTP enrolment and verification are on;
   - self-registration is off;
   - the Company OS API schema is exposed.
5. **Verification:**
   - the applied migrations equal the repository's;
   - no seed mark is present;
   - `ops.operator_assurance_exemption` is empty;
   - the helper ACLs of Gate A hold, and RLS is on;
   - the CRM and Company OS AAL2 roots are in place;
   - the retention schema is present;
   - no model-data authorization row exists.

## 6. Requirements recorded for go-live (not needed for staging)

- **Custom SMTP.** Supabase's default sender reaches only the project's team members, about two messages an hour. Real invitations need a custom SMTP provider.
- **Production database.** A second Free project is not taken while staging uses the last free slot. Go-live stops at **OWNER PRODUCTION DATABASE DECISION REQUIRED**.
- **Remote runtime.** The worker and gateway run locally until a 24/7 worker or a public webhook is truly needed. That point stops at **OWNER COST APPROVAL REQUIRED — REMOTE RUNTIME**.
