# Permissions

**Date:** 2026-09-11 (Phase 0.5). Describes the permission model **as it exists**, and marks clearly what is designed but not built.

---

## 1. The layers, and which one is authoritative

| Layer | What it does | Is it a security boundary? |
| --- | --- | --- |
| `canAccess` (frontend) | Hides resources a role may not use | **No.** UX only. It runs in the browser. |
| PostgREST grants (`06_grants.sql`) | Which roles may touch which tables at all | **Yes** |
| RLS policies (`05_policies.sql`) | Which *rows* a principal may see and change | **Yes — the authoritative one** |
| Edge function checks | Per-endpoint authorization | Yes, where implemented |
| MCP function | — | **Explicitly not** ([ADR 0011](adr/0011-mcp-trust-boundary.md)) |

**The rule:** if a permission is not expressed in RLS or a grant, it is not enforced. Anything the frontend alone prevents is a convenience.

---

## 2. Database roles

| Role | Grants |
| --- | --- |
| `anon` | Revoked. Default privileges also revoke tables, sequences and function execute. |
| `authenticated` | `usage` on `public`; per-table grants; row visibility then narrowed by RLS |
| `service_role` | `all` on all tables/sequences/functions — used by edge functions only, never reachable from a browser |
| `postgres` | Superuser. **The MCP function's pool defaults to it** — see the open risk in [SECURITY.md](SECURITY.md) |

Default privileges revoke from `anon`/`authenticated` for future objects, so a newly created table is not accidentally world-readable. That is the correct deny-by-default shape and it should be preserved.

---

## 3. Application roles

Two, on `public.sales`:

- **`owner`** — administrative authority. `is_admin()` in `supabase/schemas/` requires `role = 'owner'` and `disabled = false`.
- **`operator`** — ordinary user. The `handle_new_user` trigger assigns this.

⚠️ **Two contradictory models are live at once**, and any work here must say which it targets:

| | `supabase/schemas/` (declarative, unmigrated) | `supabase/migrations/` (what a real database has) |
| --- | --- | --- |
| `is_admin()` | `role = 'owner' and disabled = false` | `administrator = true` — no role, no disabled check |
| First signup | `operator`, not admin | **administrator = TRUE** |
| Net effect | **No owner can ever be created** — every `is_admin()` policy is unreachable, so tag creation and settings writes are dead | A working admin exists |

The declarative model is the intended one and it has a bootstrap deadlock: signup is disabled in three places, `authenticated` has no INSERT on `sales`, the invite endpoint requires an existing owner, and the first-user bootstrap UI was deleted. Closing that needs a deliberate, audited provisioning path — it is Phase 1 security work, not a quick fix.

---

## 4. Row scoping today

`public.*` is scoped by **`sales_id`** — a per-*user* column — through SECURITY DEFINER helpers (`02_functions.sql`): `current_sales_id()`, `is_active_sales_user()`, `can_manage_sales_id()`, `can_access_contact()`, `can_access_deal()`, plus the inherited `is_admin()`.

Two consequences that matter:

1. **There is no tenant axis.** `sales_id` answers "which user", never "which company". `public.companies` means *CRM customer account*, not tenant. Multi-tenancy is [ADR 0002](adr/0002-tenancy-model.md) and does not exist.
2. **Every helper resolves through `auth.uid()`**, i.e. an end-user JWT claim. That is fine for a browser session and **cannot work for a background worker**, which holds no JWT — the reason for [ADR 0012](adr/0012-worker-tenant-context.md).

No table uses `force row level security`, so the table owner bypasses every policy.

---

## 5. Frontend gating (`canAccess`)

Changed in Phase 0.5 from a deny-list ending in `return true` to an **explicit allow-list**.

- `admin` → everything.
- `sales` and `configuration` → denied to non-admins (explicit denials, kept so intent survives an allow-list edit).
- Any other resource → allowed **only if listed**: `companies`, `companies_summary`, `contacts`, `contacts_summary`, `contact_notes`, `deals`, `deal_notes`, `tags`, `tasks`, `lead_profiles`, `acquisition_attributions`, `loss_reasons`.
- **Anything else → denied.**

Why it mattered: the old default granted access to every resource nobody had thought of — including every engine resource the Company OS will add (`ops_agents`, `ops_approvals`, `ops_audit_log`, cost tables). A gate whose default is "yes" grants access to things that do not exist yet. 24 tests now pin this, including those future names.

**Adding a resource to the app means adding it here deliberately.** Forgetting denies access, which is visible and safe.

---

## 6. Designed, not built

- **Tenant scoping for the engine** — scoped non-superuser role + transaction-local `app.tenant_id` GUC, read by one SECURITY DEFINER helper, with NULL matching no rows. [ADR 0012](adr/0012-worker-tenant-context.md).
- **Autonomy levels 0–4**, risk `LOW|MEDIUM|HIGH|CRITICAL` as seeded data, maker→checker→approver, and **unmatched action → CRITICAL → refused**. [ADR 0009](adr/0009-governance-envelope.md).
- **Kill switch** with global/company/department/agent/integration scopes, deny-wins, fail-closed on an unreadable switch. [ADR 0010](adr/0010-cost-control-and-kill-switch.md).

None of these exists in code. They are recorded so the first phase that needs them builds them rather than rediscovering the requirement.

---

## 7. Verification status

The `canAccess` behaviour is **verified by tests that run today**. Everything in sections 2–4 is **unverified** — it depends on a database, and Docker is not running here. In particular, no test has ever asserted an RLS outcome: that remains the largest test gap in the repository.
