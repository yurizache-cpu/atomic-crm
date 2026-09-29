# Production hosting — owner decision packet

**Status: OWNER HOSTING DECISION REQUIRED (2026-09-29): the frontend host and the worker/gateway runtime, as one decision (§9).** *(First written 2026-09-28; §9 added 2026-09-29 after the facts it needed were verified.)* No production host has been chosen, and none is chosen here. This packet states what the host must guarantee, compares three realistic candidates from their official documentation, and names the one decision the owner has to make. **OWNER ACTION REQUIRED** before any account, project, domain or payment exists. Nothing paid was created.

**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.** Choosing a host authorizes neither.

Companion: [PRODUCTION_HOSTING_GATE_B_REPORT.md](PRODUCTION_HOSTING_GATE_B_REPORT.md), which records the provider-neutral contract and commands already built, and the environment contract.

## 1. Has the owner already chosen a host?

No. The canonical records were checked, and none names one:

- `docs/DECISIONS.md` and every ADR: no hosting decision (the only hosting mentions are the WhatsApp gateway's TLS in ADR 0018 and platform read roles in ADR 0015).
- `docs/ROADMAP.md`: "hosting undecided; GitHub Pages cannot" (Gate A).
- `.github/workflows/deploy.yml`: the inherited upstream deploy publishes the build to GitHub Pages (`scripts/publish-pages.mjs`, a `gh-pages` branch of `DEPLOY_REPOSITORY`) and pushes the database and functions to a hosted Supabase project. That is upstream's mechanism, not an owner decision, and it is not treated as one.

**GitHub Pages is insufficient for the clinic, on two independent grounds:**

1. **It cannot send the required response headers.** Measured once on a public Pages site (`mozilla.github.io`) with this repository's own command: the response carried none of the five required headers (no Content-Security-Policy, Strict-Transport-Security, `X-Content-Type-Options`, `Referrer-Policy` or `Permissions-Policy`; 8 blocking findings in all, the eighth being that third-party page's own missing policy). The two Pages documentation pages read (the overview and the limits) do not describe custom response headers.
2. **Its terms.** GitHub's Pages limits page says Pages must not be used "to run your online business, e-commerce site, or any other website that is primarily directed at either facilitating commercial transactions or providing commercial software as a service (SaaS)", and that Pages sites "shouldn't be used for sensitive transactions like sending passwords". A clinic CRM behind a password is a commercial application.

## 2. Requirements (what the host must guarantee)

What is hosted: the **static Vite build only** (`dist/`, `base: "./"`, hash routing, a service worker, one `auth-callback.html`). No patient data, no server secret and no database lives on the host. The Company OS worker, the WhatsApp gateway and Supabase are separate services and a separate decision (§8).

| # | Requirement | Why |
| --- | --- | --- |
| R1 | Custom **response headers** on every asset, including `index.html` | The contract below cannot be met otherwise |
| R2 | `Strict-Transport-Security` of at least one year | A returning browser never uses http |
| R3 | `X-Content-Type-Options: nosniff` | No MIME sniffing of scripts |
| R4 | `Permissions-Policy` denying camera, microphone, geolocation | A page needs none |
| R5 | A **`Content-Security-Policy` response header** equal to the declared one, with **`frame-ancestors 'none'`** | A `<meta>` cannot carry `frame-ancestors`; clickjacking defence |
| R6 | HTTPS with a **custom domain** the clinic controls | The production origin and the auth redirect URLs name it |
| R7 | **SPA fallback** to `index.html` | Deep links and `/set-password` reach the app |
| R8 | Build-time `VITE_*` only; **no server secret** on the host | Only browser-safe variables exist (audited: seven) |
| R9 | **Preview / staging** deployments | Synthetic-only staging against a separate Supabase project |
| R10 | **Rollback** to a previous deployment | A bad release must be undone without a rebuild |
| R11 | **GitHub integration** or a CI deploy of a prebuilt directory | The deploy is gated on this repository's own checks |
| R12 | Serves a **static Vite build** unchanged | No framework port |
| R13 | Low cost, **no outage on a usage cap** | A low-volume clinic app |
| R14 | Low operational complexity | One owner, no platform team |

The declared header set (one source, `scripts/security-headers.mjs`) is printed for any host by `npm run production:headers -- --supabase-url <project url>`, and a deployed origin is held to it by `npm run verify:production-host`.

## 3. Candidates

Three, chosen because each is a mainstream static host with a GitHub integration that can plausibly meet R1–R14. Every mutable claim below was read from the vendor's own documentation on 2026-09-28; a cell that says "not read" was not, and is decided by measuring the deployed origin. Cloudflare Pages is not a candidate on its own: Cloudflare's Pages documentation says "Start new projects with Workers", so the Cloudflare candidate is **Workers with static assets**.

| Requirement | **A. Cloudflare Workers (static assets)** | **B. Netlify** | **C. Vercel** |
| --- | --- | --- | --- |
| R1 custom headers | `_headers` file in the asset directory; 100 rules, 2,000 characters a line; **static-asset responses only** | `_headers` file or `netlify.toml` `[[headers]]`; **files Netlify serves only** (not proxied or function responses) | `headers` in `vercel.json` |
| R2 HSTS | Settable through `_headers` (not among the docs' examples: **measure it**); Cloudflare also has a zone-level HSTS setting (not read) | **Not sent automatically**; set in `_headers` or `netlify.toml` (documented) | **Applied automatically** on `.vercel.app` and custom domains; modifiable in the headers configuration |
| R3 nosniff | Documented example | Not a restricted header | Listed as configurable |
| R4 Permissions-Policy | Documented example | Not a restricted header | Custom headers in `vercel.json` (Permissions-Policy not named on the page read: **measure it**) |
| R5 CSP + frame-ancestors | CSP documented as settable; `frame-ancestors` is a CSP directive | Documented as settable | CSP listed as configurable |
| R6 HTTPS / custom domain | HTTPS on the workers.dev address; custom domain **not read** | Automatic HTTPS on the default and custom domains (Let's Encrypt) | HTTPS certificates automatic on every deployment URL and custom domain |
| R7 SPA fallback | `assets.not_found_handling = "single-page-application"` | `/*  /index.html  200` in `_redirects` or `netlify.toml` | `rewrites: [{ "source": "/(.*)", "destination": "/index.html" }]` |
| R8 env variables | Build-time (dashboard build settings or the CI that builds); nothing server-side is needed | Build-time; same | Build-time; same |
| R9 previews | Workers Builds creates a Preview per non-production branch; the URL is posted on the pull request | Deploy Previews and branch deploys, **0 credits** | Preview deployments (not read in detail) |
| R10 rollback | `wrangler rollback` or the dashboard, to any of the **100 most recent versions**, immediate | "Publish deploy" on any earlier deploy: instantaneous, no rebuild | **Instant Rollback**: Pro any eligible deployment, **Hobby only the previous one** |
| R11 GitHub | Workers Builds connects a GitHub repository; or `wrangler` from Actions | Native GitHub integration | Native GitHub integration (not read in detail) |
| R12 Vite static | Yes (`assets.directory = ./dist/`) | Yes | Yes |
| R13 cost | Requests to static assets are **free and unlimited**; the Workers Paid plan is a $5 a month minimum. The free plan's commercial-use terms: **not read** | **Free: 300 credits a month, a hard cap: when they are used up all projects are paused** and visitors see "Site not available". A production deploy costs 15 credits, bandwidth 20 credits a GB, requests 2 credits per 10,000. Personal $9, Pro $20 a month; whether Free allows commercial use: **not stated on the pricing page** | **Hobby is free but "restricts users to non-commercial, personal use only"**. Pro: **$20 per developer seat a month** (Pro also lifts the rollback and deployment limits) |
| R14 complexity | A Wrangler config plus `_headers`; a newer, code-oriented platform (more concepts than a plain static host) | The simplest of the three for a static site | Simple; the plan constraint is the decision |

## 4. Trade-offs

- **All three can carry the header contract**; the differences are cost, outage risk and terms, not capability. The contract is enforced by measuring the deployed origin (`verify:production-host`), not by trusting a documentation page, so a host that mis-sends a header fails the check whatever its documentation says.
- **Cloudflare Workers (static assets).** The lowest and steadiest cost (static requests are free and unlimited, with no usage cap that switches a clinic's app off). Headers and SPA fallback are two small files. The costs: more moving parts than a plain static host (a Wrangler configuration), the header for HSTS is not among the examples in its documentation (it is measured before it is trusted), and the free plan's commercial-use terms were not read (the $5 a month paid plan removes the doubt).
- **Netlify.** The simplest to operate, with previews that cost nothing. The costs: HSTS is never automatic (it is one line, and it is the contract's), and, decisively, **the Free plan's hard credit cap pauses every project when it is used up**: an outage for a clinic, with no overage purchase possible on Free. A paid plan avoids it.
- **Vercel.** HSTS is automatic and rollback is polished. The Hobby plan is **not for commercial use**, so a clinic needs Pro at $20 per developer seat a month: the highest recurring cost of the three for a static file server.

**Preferred technical fit: A, Cloudflare Workers (static assets)**, for the steadiest cost and the absence of a usage cap that becomes an outage, on the condition that the owner reads its terms for a commercial clinic and accepts the $5 a month plan if they require it. **Runner-up: B, Netlify on a paid plan**, if the owner prefers the simplest platform over the lowest cost. This is a technical fit, not a decision: the provider, the plan and the account are the owner's.

## 5. Migration effort from today

Roughly half a day of engineering **after** the decision, none before it:

1. **Owner:** create the account and an API token, and the production and staging projects; choose the domain (§6).
2. **Engineering:** one provider configuration (the header file written from `npm run production:headers`, and the SPA setting), one deploy step that publishes the prebuilt `dist/` behind `scripts/production-preflight.mjs` (as `scripts/publish-pages.mjs` runs the build scan in the same command), and a post-deploy `verify:production-host` gate in the workflow. `deploy.yml`'s GitHub Pages publish is replaced for production; the demo may keep it.
3. **Owner:** the DNS record for the domain; the Supabase redirect URLs (§6 of the report).

## 6. What is already provider-independent (Gate B, built)

- **The contract:** the header set, the CSP equality rule, HSTS, `nosniff`, the referrer policy, the permissions policy (`scripts/security-headers.mjs`, `scripts/production-contract-host.mjs`).
- **`npm run production:preflight`:** refuses a build that is a demo, points at a local or placeholder API, carries the local stack's key, a privileged or model-provider `VITE_` variable, a local endpoint, a published registry, a credential class, or a page policy made for another API. Wired into the production deploy job after the build and before any push or publish.
- **`npm run verify:production-host -- --url … --supabase-url …`:** reads a deployed origin's actual response and its scripts and holds them to the contract; exit 0, 1 or 2 (2 is "could not look", never a pass).
- **`npm run verify:hosted-supabase`:** the hosted project's public auth settings and, read-only with the owner credential, its exemption row, seed marks and migrations; and it prints what it cannot see.
- **`npm run production:headers`:** the header set, for any host's configuration.
- **SI-76**, and the environment contract for production and staging (report §3).

## 7. The exact owner decision needed

1. **Choose the production host:** A (Cloudflare Workers static assets), B (Netlify, paid plan) or C (Vercel Pro), or another that meets R1–R14. Until then no provider-specific code is written.
2. **Confirm the plan and the terms** for a commercial clinic (A: the Workers Free terms or the $5 a month plan; B: Personal or Pro; C: Pro).
3. **Who owns the account** (the clinic or the developer), and **OWNER ACTION REQUIRED**: create it, an API token limited to the project, and store the token as a GitHub secret. No account, login or payment is made by engineering.
4. **The production domain and a staging domain**, and whether HSTS should carry `includeSubDomains` for it (the contract's advisory; the declared header has it). `preload` is deliberately not declared: it is close to irreversible.
5. **Staging policy:** a **separate Supabase project**, synthetic data only, the production contract unchanged (multi-factor required, no exemption), no production WhatsApp, no model authorization. Confirm.

## 8. Outside this decision

The Company OS **worker** and the **WhatsApp gateway** are long-running Node processes with database credentials and TLS needs (ADR 0018 §gateway); they need a runtime that is not a static host, and the hosted **Supabase project** (plan, region, backups, the data-processing agreement, LGPD basis, international transfer) is a legal and account decision. Neither is decided or started here.

## 9. The recommendation to decide (2026-09-29)

Two facts verified on 2026-09-29 settle what §4 left open:

- **Cloudflare's Self-Serve Subscription Agreement has no non-commercial restriction** on self-serve or free services (unlike Vercel Hobby). It does bar using the services to store or transmit "protected health information" without Cloudflare's written consent (§2.2.1(i)). **The static frontend is outside that clause by construction:** the bundle holds no patient data, and the browser talks to the Supabase API directly (`connect-src` names only the Supabase origin), never through Cloudflare. The API must therefore never be proxied through a Cloudflare zone.
- **The same clause, and the product's shape, rule Cloudflare out for the worker and the WhatsApp gateway.** They carry message bodies, and Cloudflare Containers are started on demand and put to sleep when idle, not an always-on queue worker.

| Component | Recommended | Plan | Expected monthly cost | Why |
| --- | --- | --- | --- | --- |
| Frontend (static build) | **Cloudflare Workers static assets** | Workers Free (static-asset requests are free and unlimited); Workers Paid (US$5) only if a limit is ever reached | **US$0** (plus the domain, which the clinic may already own) | Headers file, SPA fallback, 100-version rollback, a separate Worker per environment (`--env staging`), no usage cap that becomes an outage, no commercial restriction |
| Worker + WhatsApp gateway (long-running Node) | **Fly.io, region `gru` (São Paulo)** | Pay as you go; two always-on `shared-cpu-1x` machines (worker: no public port; gateway: public HTTPS for Meta's webhook only) | **about US$6–11** (US$3.14 per 256 MB machine in `gru`, about US$5.15 at 512 MB; a dedicated IPv4 at US$2 only if ever needed) | Always-on machines, per-process health checks and restart policy, private worker, secrets store, São Paulo region next to Supabase `sa-east-1`, deploys the same container image anywhere else later |
| Database and Auth | Supabase, region **`sa-east-1` (São Paulo)**, a production and a separate staging project | decided at Milestone 2 | confirmed at Milestone 2 | Co-located with the runtime; production and staging never share data |

Alternatives, only where material: **Netlify on a paid plan** (US$9–20) if the owner prefers not to move the domain's DNS to Cloudflare; **Render** (about US$14 for a background worker and a web service) if the owner prefers a dashboard-only runtime, at the cost of no Brazilian region.

**What accepting implies (owner actions, listed now so nothing surprises later; asked for only after the decision):**

1. The clinic's domain becomes a zone on a free Cloudflare account (its nameservers move to Cloudflare; existing DNS records are imported). A Worker custom domain requires an active Cloudflare zone.
2. A Cloudflare API token limited to Workers, saved as the GitHub Actions secret `CLOUDFLARE_API_TOKEN` (with `CLOUDFLARE_ACCOUNT_ID`).
3. A Fly.io organisation with a card on file, and a deploy token saved as the GitHub Actions secret `FLY_API_TOKEN`.
4. At Milestone 2: the two Supabase projects in `sa-east-1`.

**Data-processing agreements** with each infrastructure provider (Cloudflare, Fly.io, Supabase) are a legal item for real data (LGPD processors), checked at the production-readiness review; they do not block a synthetic staging.

## Sources (official documentation, read 2026-09-28)

- GitHub Pages limits: <https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits>
- Cloudflare: Pages status <https://developers.cloudflare.com/pages/>; Workers static assets headers <https://developers.cloudflare.com/workers/static-assets/headers/>, SPA <https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/>; pricing <https://developers.cloudflare.com/workers/platform/pricing/>; rollbacks <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/>; Workers Builds <https://developers.cloudflare.com/workers/ci-cd/builds/>
- Netlify: headers <https://docs.netlify.com/manage/routing/headers/>; HTTPS and HSTS <https://docs.netlify.com/manage/domains/secure-domains-with-https/https-ssl/>; rewrites <https://docs.netlify.com/manage/routing/redirects/rewrites-proxies/>; deploys and rollbacks <https://docs.netlify.com/deploy/manage-deploys/manage-deploys-overview/>; plans <https://www.netlify.com/pricing/>; credits <https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/>
- Cloudflare Self-Serve Subscription Agreement <https://www.cloudflare.com/terms/>; Workers custom domains <https://developers.cloudflare.com/workers/configuration/routing/custom-domains/>; Wrangler environments <https://developers.cloudflare.com/workers/wrangler/environments/>; Containers <https://developers.cloudflare.com/containers/> (read 2026-09-29)
- Fly.io pricing <https://fly.io/pricing/>, regions <https://docs.fly.io/reference/regions/>, fly.toml reference <https://docs.fly.io/reference/configuration/>, billing <https://docs.fly.io/about/billing/> (read 2026-09-29)
- Vercel: headers <https://vercel.com/docs/headers>, `vercel.json` <https://vercel.com/docs/project-configuration/vercel-json>; CDN security and HSTS <https://vercel.com/docs/cdn-security>; Hobby plan and Pro price <https://vercel.com/docs/plans/hobby>; Instant Rollback <https://vercel.com/docs/instant-rollback>
