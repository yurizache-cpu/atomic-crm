// Shared plumbing for the Phase 3A scheduling services (followUps.ts,
// bookings.ts): the owner-scope checks every call makes before anything reaches
// the database, and the one way a service call's refusal becomes a typed
// CompanyOsError. The database still decides everything; these checks only
// refuse a malformed call without a round trip.

import type { TxClient } from "../db/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE = /^[a-z][a-z0-9_.:-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** Who acts and on whose behalf: the tenant scope and the fact's provenance. */
export interface SchedulingContext {
  readonly tenantId: string;
  /** The event source, e.g. `operator-cli`. */
  readonly source: string;
  /** The actor label recorded on the row, e.g. `owner`. */
  readonly actor: string;
}

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new CompanyOsError("malformed_identifier", `${field} is not a uuid`);
  }
  return value;
}

export function optionalUuid(value: unknown, field: string): string | null {
  return value === undefined || value === null
    ? null
    : requireUuid(value, field);
}

export function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    throw new CompanyOsError(
      "invalid_argument",
      "idempotencyKey must be 1 to 200 printable ASCII characters",
    );
  }
  return value;
}

export function requireReasonCode(value: unknown): string {
  if (typeof value !== "string" || !REASON_CODE.test(value)) {
    throw new CompanyOsError(
      "invalid_argument",
      "a reason is a snake_case code, never free text",
    );
  }
  return value;
}

/** The context as the services' (tenant, actor, source) parameters. */
export function contextParams(
  context: SchedulingContext,
): readonly [string, string, string] {
  if (context.tenantId === undefined || context.tenantId === "") {
    throw new CompanyOsError("missing_tenant_scope", "no tenant scope");
  }
  const tenantId = requireUuid(context.tenantId, "tenantId");
  if (!SOURCE.test(context.source ?? "")) {
    throw new CompanyOsError(
      "invalid_argument",
      "source is missing or malformed",
    );
  }
  const actor = (context.actor ?? "").trim();
  if (actor.length < 1 || [...actor].length > 200) {
    throw new CompanyOsError(
      "invalid_argument",
      "an actor label is 1 to 200 characters",
    );
  }
  return [tenantId, context.actor, context.source];
}

/** One service call's single `result` column, with a domain refusal typed. */
export async function callResult(
  tx: TxClient,
  sql: string,
  params: readonly unknown[],
): Promise<unknown> {
  try {
    const { rows } = await tx.query<{ result: unknown }>(sql, params);
    return rows[0]?.result;
  } catch (error) {
    throw toDomainError(error);
  }
}

/** A status token a service answered with; anything else is a contract break. */
export function statusToken<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fn: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${fn} answered outside its contract`);
  }
  return value as T;
}
