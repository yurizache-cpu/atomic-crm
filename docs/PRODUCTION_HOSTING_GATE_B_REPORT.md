# Production Hosting Gate B — report

**Status: PRODUCTION HOSTING GATE B — OWNER DECISION REQUIRED (2026-09-28).** The provider-independent work is implemented; the host is not chosen, so no provider-specific code, account, project or staging deployment exists. Read [PRODUCTION_HOSTING_DECISION_PACKET.md](PRODUCTION_HOSTING_DECISION_PACKET.md) for the decision.
**Built on** `feature/production-hosting-gate-b`, from `feature/clinical-phase-1` at `afcb7224` (Gate A complete: PR #19 and PR #20).
**Invariant:** SI-76.
**PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.** Nothing here authorizes either.

## 1. What this milestone is, and is not

Gate A left one repository-controlled fact unproven: "a host that actually sends the declared headers". This milestone turns that sentence into a contract, three commands and a structural guard, and finds out whether the owner has already chosen a host (they have not: decision packet §1).

It does **not** choose a host, create an account, project, domain or payment, deploy anything, create production data, enable real patient traffic, authorize a model, or start WhatsApp production, Jev, RAG or Calendar. It writes no provider-specific code.

## 2. The host security contract

What any production origin must send for the application page (declared once in `scripts/security-headers.mjs`; printed by `npm run production:headers`):

| Header | Contract | Blocking when |
| --- | --- | --- |
| `Content-Security-Policy` | Equal, directive for directive, to the declared policy for the configured API, `frame-ancestors 'none'` included; scripts from the origin only; connections to the origin and that API only; no `unsafe-eval`, wildcard, scheme or inline script source | missing, or any directive differs: an added third-party source (a cosmetic image host, say) is a difference. Several policies intersect, so one equal policy suffices |
| `Strict-Transport-Security` | `max-age` of at least 31,536,000 | missing, or below a year. No `includeSubDomains` is advisory (a custom-domain decision); `preload` is deliberately not declared |
| `X-Content-Type-Options` | `nosniff` | anything else |
| `Referrer-Policy` | `strict-origin-when-cross-origin` or stricter (`no-referrer`, `same-origin`, `strict-origin`) | missing or weaker |
| `Permissions-Policy` | denies `camera`, `microphone` and `geolocation` | any not denied |

Plus, on the response and the scripts the page loads: served over **https** on a **public** host; status 200; one policy `<meta>` and no inline script in the page; no local or development endpoint (`127.0.0.1`, `0.0.0.0`, `host.docker.internal`, local Supabase or dev-server ports, `@vite/client`, the demo backend); no credential class in any script (the build scan's own rules); and `http://` redirects to `https://` (advisory).

The contract preserves the existing restrictive CSP: it never weakens a directive to admit a cosmetic third-party resource. `style-src 'unsafe-inline'` stays the one documented exception (SI-75).

## 3. Environment separation

The minimum contract, enforced by `production-preflight` (build), `verify-hosted-supabase` (project) and the service checks (worker). Staging is the **same contract** with synthetic data only and a **separate** Supabase project; **no staging exemption exists**, multi-factor authentication is required there too, and a staging session enrols a synthetic user's authenticator.

| Surface | Production and staging must NOT | Enforced by |
| --- | --- | --- |
| Browser build | be a demo build (`VITE_IS_DEMO=true`); name a local, private, placeholder or non-https API; carry the key every local Supabase stack issues, a secret key, a non-anon JWT or a JWT from a local or demo stack; carry a `VITE_` variable named like a server secret or a model-provider credential; carry an unaudited `VITE_` variable unremarked | `auditClientEnvironment` |
| Built artifact | publish the component registry (`r/`, ADR 0008); name a local endpoint; carry a credential class; carry a page policy made for another API; lack a policy | `preflightFindings`, on top of the build scan |
| Hosted Supabase | hold a row in `ops.operator_assurance_exemption`; have applied the development seed; have migrations other than the repository's, missing or unknown; accept self-registration | `auditHostedSupabase` (read-only, `verify-hosted-supabase`) |
| Worker, gateway, operator commands | select a `fake` decision or calendar provider; enable synthetic ingress (`COMPANY_OS_SYNTHETIC_INGRESS`); name a local database (loopback, container host, or a local Supabase port) | `auditServiceEnvironment` (`production-preflight --services`) |
| Host | send fewer headers than §2, or serve over http | `verify-production-host` |

**The actual browser variables (audited against `src/`, both Vite configs and `deploy.yml`, not assumed).** Seven `VITE_` names exist, each meant for a browser: `VITE_SUPABASE_URL` and `VITE_SB_PUBLISHABLE_KEY` (public by design), `VITE_IS_DEMO`, `VITE_INBOUND_EMAIL`, `VITE_ATTACHMENTS_BUCKET`, `VITE_DISABLE_EMAIL_PASSWORD_AUTHENTICATION`, `VITE_GOOGLE_WORKPLACE_DOMAIN`. A test fails by name if the application, a Vite config or the deploy workflow starts reading an eighth without it being audited into the list. No `VITE_` variable is named like a secret. **Source maps** are published (`build.sourcemap: true`); that is not forbidden by any current policy (the source is public in the repository, and the build scan reads the maps), so it is an advisory, a decision and not a leak. Server-side secrets (`SERVICE_ROLE_KEY`, the database URLs, the worker credentials) are never `VITE_`-named, and the build scan refuses one that is.

## 4. Hosted Supabase readiness

Nothing was created and no hosted project was touched. What can be read, is read by `npm run verify:hosted-supabase`; what cannot is printed by it every time and never assumed.

| Requirement | Verified by | Owner or account action |
| --- | --- | --- |
| No assurance-exemption row | `--database`, read-only: the row count | none; the migrations never ship it (SI-74) |
| Migrations applied from canonical history, exactly | `--database`: applied versions against `supabase/migrations/` | `supabase db push` (the deploy job) |
| Seed never applied | `--database`: the seed's marks (its development tenant) | never run the seed on the project |
| Self-registration closed | the public auth settings endpoint | set in the dashboard or `supabase config push` |
| Email auto-confirm off (advisory) | the public auth settings endpoint | same |
| **TOTP MFA enabled** | **not verifiable from outside** | **OWNER ACTION:** enable it in the project's auth settings; prove it by enrolling a synthetic user on staging |
| **Site URL and redirect URLs explicit** | **not verifiable from outside** | **OWNER ACTION:** only the production origin (and the staging origin on staging) |
| Service-role and secret keys server-side only | the browser artifact is scanned; **custody is not verifiable** | **OWNER ACTION:** keep them in GitHub or worker secrets |
| Publishable key browser-safe | the build environment (`sb_publishable_` or an anon JWT; not the local key) | use the project's own publishable key |
| RLS and MFA authority preserved | Gate A's suites (`crm_assurance.sql`, `production_security.sql`), unchanged | none |

## 5. The commands

| Command | Reads | Exit |
| --- | --- | --- |
| `npm run production:preflight [-- --dist dist] [--services]` | the build environment and `dist/` | 0 pass, 1 a blocking finding, 2 could not check |
| `npm run verify:production-host -- --url <origin> --supabase-url <project url>` | the deployed origin's page, headers and same-origin scripts | same |
| `npm run verify:hosted-supabase -- --url <project url> [--database]` | the public auth settings; with `--database`, `ADMIN_DATABASE_URL` in a read-only session | same |
| `npm run production:headers -- --supabase-url <project url>` | nothing; prints the declared header set | 0 |

None prints a secret, a key, a URL or a connection string it judged: a finding names a rule and a place. None names a provider. `--local-self-test` (host and Supabase commands) lets a local address through, prints a banner and is never a sign-off. The production deploy job runs the preflight **unconditionally** after the build and before any database push, function deploy or publish (`.github/workflows/deploy.yml`); the demo job, which is expected to be a demo, does not.

## 6. Structural proof (SI-76)

| Property | Where it is held |
| --- | --- |
| Production builds carry the browser policy | SI-75 (the build scan) and `auditPageAgainstEnvironment`: the page policy must be the one declared for the configured API |
| The host contract requires the missing response headers | `auditResponseHeaders` (five headers, CSP equality) and `verify-production-host`, tested over real HTTP against a local stand-in; one mutation per rule was caught |
| Production configuration cannot include the local MFA exemption | `auditHostedSupabase` refuses a hosted project holding a row; SI-74 keeps it out of every migration |
| Production deployment cannot use the development seed | `auditHostedSupabase` refuses its marks; SI-25 and `production-scope` keep it off every remote path |
| Fake or test-only configuration cannot masquerade as production | `auditClientEnvironment` (demo, local URL, local key, placeholder host) and `auditServiceEnvironment` (fake providers, synthetic ingress, local database); the deploy job cannot publish without them |

## 7. Measured

- **Against a real GitHub Pages site (one request):** none of the five headers; 8 blocking findings. GitHub Pages fails this contract by design.
- **Against a local stand-in and `vite preview`:** the declared header set passes; a different API's policy, a missing header, and a local endpoint in a script each fail by name.
- **Against the real local Supabase project and database:** with the seed, the command refuses the exemption row and the seed's mark; on a migrations-only reset it passes (0 blocking; the local stack's email auto-confirm is the one advisory); without `--local-self-test` it refuses the local project and database.
- **Against a real production build with a synthetic hosted environment:** the preflight passes the environment and reports the source maps; it refuses the locally left-over `r/` registry directory, a demo environment and a mismatched API.
- **Mutation checks:** 6 mutants of the host contract and 8 of the environment contract, each caught by a named test.

## 8. Owner actions and what remains

- **OWNER HOSTING DECISION REQUIRED** (decision packet §7): the provider and plan, the account owner and an API token stored as a GitHub secret, the production and staging domains, `includeSubDomains`, and the staging policy. Until then no provider-specific code, and no staging deployment.
- **OWNER ACTIONS on the hosted Supabase project:** enable TOTP, set the site and redirect URLs, keep the secret keys server-side, `supabase db push` and never the seed.
- **After the host exists (engineering, about half a day):** the header file from `production:headers`, a deploy step of the prebuilt directory behind the preflight, a post-deploy `verify:production-host` gate, a synthetic-only staging project.
- **Still closed and unchanged:** ADR 0020 §C evidence, production WhatsApp (ADR 0018), real patient model traffic, the data-processing agreement, the LGPD basis and international transfer, the worker and gateway runtime (a separate decision).

## 9. Validation

Local, once at the end. No database or security migration changed, so the database and engine suites were not rerun.

- **New tests:** four files (`production-contract-host` 51, `production-contract-env` 36, `production-preflight` 17, `verify-production-host` 8). The scripts project passes 420 in 19 files; the `functions` project passes 2270 in 97 files, security invariants 83/83 with SI-76.
- **Mutation-checked:** 6 mutants of the host contract (the HSTS floor, the CSP comparison, the non-public host rule, `nosniff`, the registry rule, the page audit), 8 of the environment contract (demo, exemption row, fake provider, local key fingerprint, signup, https, the variable list, local database) and the deploy workflow ordering (the preflight moved below the database link fails by naming the remote step above it); each caught by a named test.
- **The production build, measured:** `npm run build` and the build scan: 0 blocking (19 files). `production:preflight` on that real artifact with a synthetic hosted environment: PASS, with the source maps as the one advisory; with a `fake` worker provider and `--services`: refused. The **demo** build is refused by the preflight (a published registry, the demo backend in a script, a page policy made for another API), so a demo artifact cannot pass as production even with a clean environment. The demo build and its scan: 0 blocking (14 files).
- Typecheck green; ESLint 0 errors; Prettier clean on every changed file in its LF form (the local checkout is CRLF); `production-scope` and the signing-key guard OK (the tests spell the deploy commands in pieces so the deploy-scope guards do not read a test as a deploy).
- The hosted-Supabase command was run against the real local project and database in both states: seeded, it refuses the exemption row and the seed's mark; migrations-only, it passes.
