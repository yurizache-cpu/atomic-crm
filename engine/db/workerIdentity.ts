// The boot gate on the worker's database identity.
//
// Separate from the adapter so it imports no driver: this is the rule, and the
// rule should be testable without a database or a connection library.
//
// WHY A GATE AT ALL. A deployment that points the worker at `postgres` or
// `service_role` does not fail. Every job runs, every query succeeds, every log
// line looks right — and RLS is off, because both roles carry BYPASSRLS
// (measured in Phase 1A: postgres is rolsuper = false, rolbypassrls = true). The
// failure is invisible at runtime and total in effect, which is precisely the
// shape that has to be caught at startup instead of in review.

export interface WorkerIdentity {
  user: string;
  isSuperuser: boolean;
  bypassesRls: boolean;
  isOpsWorkerMember: boolean;
}

/**
 * The role the worker assumes per transaction. It is NOT the role it connects
 * as: the login role is a MEMBER of this one, the same way PostgREST reaches
 * `authenticated`.
 */
export const WORKER_ROLE = "ops_worker";

/** Identities that are administrative whatever their attributes say today. */
export const FORBIDDEN_IDENTITIES: readonly string[] = Object.freeze([
  "postgres",
  "supabase_admin",
  "service_role",
]);

export class WorkerIdentityError extends Error {}

export const IDENTITY_SQL = `
  select
    current_user                             as "user",
    coalesce(r.rolsuper, false)              as "isSuperuser",
    coalesce(r.rolbypassrls, false)          as "bypassesRls",
    pg_has_role(current_user, $1, 'member')  as "isOpsWorkerMember"
  from pg_roles r
  where r.rolname = current_user
`;

export function assertWorkerIdentity(identity: WorkerIdentity): void {
  const problems: string[] = [];
  if (FORBIDDEN_IDENTITIES.includes(identity.user)) {
    problems.push(
      `connects as "${identity.user}", which is an administrative identity`,
    );
  }
  if (identity.isSuperuser) problems.push("is a SUPERUSER");
  if (identity.bypassesRls) {
    problems.push(
      "carries BYPASSRLS, so every policy in ops would be decorative",
    );
  }
  if (!identity.isOpsWorkerMember) {
    problems.push(
      `is not a member of ${WORKER_ROLE}, so it cannot assume the least-privileged role`,
    );
  }
  if (problems.length > 0) {
    throw new WorkerIdentityError(
      `Refusing to start: the worker's database identity ${problems.join("; ")}. ` +
        `Provision a dedicated LOGIN role that is a member of ${WORKER_ROLE} ` +
        "(scripts/provision-worker-role.mjs) and point OPS_WORKER_DATABASE_URL at it.",
    );
  }
}
