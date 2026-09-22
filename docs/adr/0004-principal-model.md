# ADR 0004 — What is a principal

**Status:** Proposed · **Date:** 2026-09-10

## Context

`sales.user_id uuid not null` has a unique FK to `auth.users`. Every ownership column in the schema is `sales_id`. Roles are a two-value CHECK (`owner`, `operator`) plus `administrator` and `disabled` booleans; `is_admin()` requires `administrator AND role = 'owner' AND NOT disabled`. There is no non-human actor concept anywhere in the system.

## Decision

**An engine-owned `ops.principals` table with `kind in ('human','agent','service')`.** A `sales` row is created for an agent only when it must act *through* the CRM adapter, and that mapping is recorded explicitly.

## Alternatives

- **Agents as `sales` rows with real `auth.users` accounts.** Fits existing RLS with no new plumbing, but pollutes the human directory, inherits the two-value role CHECK, and makes "agent X acted on behalf of human Y" inexpressible.
- **Agents as a magic string in an actor column.** Rejected: unauditable.

## Consequences

- Delegation is first-class: audit rows record actor, on-behalf-of, and the authority relied on.
- An agent is **configuration + policy**, never a running process. When work exists an `agent_run` is created; when idle it costs nothing.
- Per-agent permissions, autonomy level, budget and memory policy hang off `principals`.

---

## Addendum 2026-09-12 — Phase 1C: `ops.agents` precedes `ops.principals`

Phase 1C created `ops.agents` as a standalone table of agent configuration and identity ([ADR 0015](0015-company-os-domain-core.md)), and `ops.tasks.assigned_agent_id` references it. No `ops.principals` table exists yet, and this ADR's decision is **not** superseded — it is deferred to the phase that first needs a non-agent actor (a human assignee, an approver) or per-principal permissions.

The intended mapping, recorded now so it is not decided by accident: **a shared key**. When principals land, an agent's principal row uses the agent's id, so no task, event or link is remapped. Making a task assignable to a human will then be a change to what `assigned_agent_id` may reference, not a new column on a table with immutable history.

---

## Addendum 2026-09-22 — Phase 2C: the human principal and tenant membership (owner-approved)

The owner's review of [PHASE_2C_BRIEF.md](../PHASE_2C_BRIEF.md) on 2026-09-22 approved this addendum (owner decision OD-3), together with [ADR 0019](0019-company-os-operator-surface.md), and the owner's final confirmation the same day settled its identity and tenancy rules. Phase 2C is the phase that first needs a non-agent actor: a person who observes the Company OS and makes two narrow acts from a browser. **Approved for implementation; not implemented.**

- **The principal is the auth user id.** The authoritative human identity is the stable Supabase Auth user id: the verified JWT `sub`, the value `auth.uid()` returns. **Same email ≠ same principal:** an email never selects, identifies or authorises a principal or a membership; changing an email never transfers a membership to another auth subject; a new auth user created with a former member's email holds nothing.
- **`ops.principals` lands for humans first.** Columns: `id`, `kind` (the check keeps `human`, `agent`, `service`), `issuer` (in Phase 2C always the fixed label `supabase_auth`), `subject` (the auth user id), `display_name`, `created_by`, `created_at`, `disabled_at`, `disabled_by`; unique `(issuer, subject)`. Only `human` rows are written in Phase 2C. The 2026-09-12 shared-key mapping for agents is unchanged: when agent principals land, an agent's principal row uses the agent's id.
- **`ops.tenant_memberships` binds tenant + auth user id (through the principal) + membership state and role.** Role `tenant_operator` (deliberately not the CRM's `operator`); a composite foreign key to the principal's `(id, kind)` with the kind checked to be `human`, so no agent or service principal can ever hold a membership; `granted_by`, `grant_reason`, `granted_at`; revocation once (`revoked_by`, `revoke_reason`, `revoked_at`), never a delete; at most one active membership per person in Phase 2C (a Phase 2C limit, not a property of the model). A principal's `(issuer, subject)` and `kind`, and a membership's principal, tenant, role and grant fields, are immutable (ENABLE ALWAYS guards), so a membership never points to another auth subject or tenant. The model is **tenant-generic**: no constraint, foreign key, trigger or column ties a membership to a particular kind of tenant.
- **The email at grant is detection only.** A SHA-256 of the auth user's email at grant time may be stored and compared by the owner CLI as a tamper or change alarm during the temporary coupling of Company OS identity to the CRM's Auth directory. It is **not an authorization boundary**: the browser path never reads an email, and no security property is claimed from it.
- **Membership is explicit and owner-provisioned.** Both tables have FORCE RLS, no policy and no grant. They are written only by `npm run ops -- membership grant|revoke` with the database-owner credential (`membership list` reads), which takes the auth user id, never an email. Company OS authority is **never derived** from the Atomic CRM owner or administrator state, and never from a browser-supplied tenant or company id.
- **Phase 2C eligibility: the local CRM-owning tenant only — a temporary policy, not core architecture.** Every Supabase Auth user is also an active CRM user of the tenant that owns the local CRM, so a member of any other tenant would gain the clinic's local CRM and write access to contacts that feed that tenant's WhatsApp contact policy. In Phase 2C, one eligibility predicate (`ops.membership_tenant_eligible`), called by the grant service and the resolver, therefore provisions and enables memberships only for that tenant. Lifting it needs an owner decision that also separates that tenant's Company OS identity from the clinic's CRM trust model, and no data migration (another identity domain also needs the resolver to bind the verified JWT `iss` to `ops.principals.issuer`); future tenants, including a non-CRM or independently isolated business, use the same model.
- **The tenant is derived on the server.** A browser caller's tenant comes only from its active, eligible membership, resolved from the verified PostgREST claims, a live session and an existing, unbanned auth user (ADR 0019 Decision 4). Its actor label is `principal:<uuid>`. The owner CLI refuses that prefix as a typed actor, in TypeScript; the SQL still accepts any well-formed label from the owner credential, so a `principal:` actor identifies a gate-resolved caller only on application paths.
- **CRM-admin account capture is a recorded prerequisite debt.** CRM administration cannot mint a member, but it can capture an existing member's login today (ADR 0019 Consequences). The owner accepts this only for local, synthetic and test Phase 2C; real data and any hosted operator surface are blocked until the `users` edge function's authority and ordering issues are fixed and tested, so that no CRM administrator, the active CRM owner included, can retarget or acquire another person's Company OS principal. `membership revoke`, not CRM disable, is the Company OS revocation.
- **Delegation and the authority relied on.** A human acts directly in Phase 2C; no on-behalf-of relation is recorded yet. The act rows keep the existing audit fields (the actor or reviewer label, and the source `company-os-ui`); the authority relied on, the membership, is not stored on the act row and is reconstructed from `principal:<uuid>` and the membership's grant and revoke history.
- **Final owner confirmation (2026-09-22):** the auth user id is the membership authority and an email never is; `email_at_grant` is detection only; the CRM-owning-tenant restriction is a temporary Phase 2C eligibility policy and the core membership model is tenant-generic; CRM-admin capture is accepted only for local, synthetic and test Phase 2C. It replaces two rules in this addendum's first, same-day, never-pushed text: the resolver no longer requires the auth user's email to match the one bound at grant, and the fixed refusal of a grant for any other tenant is now the temporary eligibility policy above.

**Status unchanged: Proposed.** This addendum approves the human half only, for Phase 2C. Accepting this record as a whole (agent and service principals, per-principal permissions, autonomy, budgets and memory policy) is a separate owner decision.
