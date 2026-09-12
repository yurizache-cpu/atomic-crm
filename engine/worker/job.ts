// The job as the runtime sees it. A row of `ops.jobs`, handed back by
// `ops.lease_job()` and re-read by `ops.resume_lease()`.
//
// `tenant_id` is present because the runtime ASSERTS it against what the
// database says the tenant is — not because anything downstream is allowed to
// use it to choose a tenant. Handlers never receive it.

export interface LeasedJob {
  id: string;
  tenant_id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
}

/**
 * Payload is DATA, never AUTHORITY.
 *
 * This is the only place a payload is read, and it reads it as an opaque
 * record. Nothing here consults it for a tenant, a role, a table, a SQL
 * fragment or a function name — a payload field named `tenant_id` is a field
 * called `tenant_id` and means nothing to the runtime.
 */
export function payloadObject(payload: unknown): Record<string, unknown> {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return {};
  }
  return payload as Record<string, unknown>;
}

/** Reads a bounded integer out of a payload, or returns the fallback. */
export function payloadInteger(
  payload: unknown,
  key: string,
  fallback: number,
): number {
  const raw = payloadObject(payload)[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.trunc(raw);
}
