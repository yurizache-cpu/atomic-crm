// Company OS memberships (Phase 2C; brief §7.4, ADR 0019, the ADR 0004
// addendum): who may use the operator surface, and the owner's two acts on it.
//
// THE PRINCIPAL IS THE AUTH USER ID. A membership binds one tenant to one
// Supabase Auth user id (the verified JWT `sub`) through an explicit human
// principal. An email never selects, identifies or authorises anything here: no
// function below takes one and none returns one. The same email is not the same
// principal.
//
// THE ACTS are one owner service each, and what makes them safe lives there:
// ops.grant_membership accepts only an auth user that exists, is confirmed and
// is neither banned nor deleted, applies the Phase 2C eligibility policy (only
// the tenant that owns the local CRM), and keeps one active membership per
// person; ops.revoke_membership records a revocation once. A grant is immutable
// and no row is ever deleted. Revoking is the Company OS off-switch for one
// person, effective on that person's next call.
//
// THE EMAIL AT GRANT is detection only. The grant stores the SHA-256 of the
// auth user's lower-cased email; the listing compares it, IN SQL, with the hash
// of the current email and returns only the boolean emailChangedSinceGrant.
// Neither an email nor a hash ever reaches this process. A match proves nothing
// (a recovery followed by restoring the email matches too); the control is the
// user-management prerequisite (brief §14 item 2).
//
// NEVER RETURNED: an email or email hash, a grant or revoke reason, the
// granted_by or revoked_by label, an auth token or a connection string. Every
// refusal below is a fixed message that repeats nothing the owner typed.
//
// WHO CAN CALL THIS: a transaction running as the database owner, in practice
// `npm run ops -- membership …` (engine/cli/operator.ts). No application role
// holds any privilege on ops.principals or ops.tenant_memberships or can
// execute either service. Like companyOs.ts, each act validates before the
// database, never more loosely than it, and calls exactly one function.

import type { TxClient } from "../db/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";
import { readRows } from "./runtimeReadModelRuns.ts";

export type MembershipState = "active" | "revoked";

/** The one role Phase 2C grants; deliberately not the CRM's `operator`. */
export type MembershipRole = "tenant_operator";

export const MAX_DISPLAY_NAME_LENGTH = 200;
export const MAX_MEMBERSHIP_REASON_LENGTH = 500;
export const MAX_LISTED_MEMBERSHIPS = 200;
export const DEFAULT_LISTED_MEMBERSHIPS = 50;

export interface GrantMembershipInput {
  readonly tenantId: string;
  /** The Supabase Auth user id. Never an email. */
  readonly authUserId: string;
  /** An owner-typed label with no `@`: never an identifier, never an email. */
  readonly displayName: string;
}

export interface MembershipAct {
  /** Who acts: the granted_by / revoked_by format, never `system:` or `principal:`. */
  readonly actor: string;
  readonly reason: string;
}

export interface GrantedMembership {
  readonly principalId: string;
  readonly membershipId: string;
  /** False when this person already held this tenant's active membership. */
  readonly recorded: boolean;
}

export interface RevokedMembership {
  readonly membershipId: string;
  /** False when the membership was already revoked. */
  readonly revoked: boolean;
}

export interface MembershipRow {
  readonly id: string;
  readonly principalId: string;
  readonly authUserId: string;
  readonly tenantId: string;
  readonly role: MembershipRole;
  readonly state: MembershipState;
  readonly displayName: string;
  readonly grantedAt: string;
  readonly revokedAt: string | null;
  /** The detection signal: the auth user's email is not the one hashed at grant. */
  readonly emailChangedSinceGrant: boolean;
}

export interface ListMembershipsOptions {
  readonly tenantId?: string;
  readonly limit?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The granted_by and revoked_by CHECKs, character for character. */
const ACTOR = /^[a-z0-9][a-z0-9_.:@-]{0,127}$/;
const SYSTEM_ACTOR_PREFIX = "system:";
const PRINCIPAL_ACTOR_PREFIX = "principal:";
// Every Unicode control and format character: a superset of the list the
// display-name and reason CHECKs refuse, because both reach CLI output.
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

/** Whether `value` is a uuid, the only way this module names a person, a tenant or a row. */
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

const requireUuid = (value: unknown, field: string): string => {
  if (!isUuid(value)) {
    throw new CompanyOsError("malformed_identifier", `${field} is not a uuid`);
  }
  return value;
};

/** 1 to `max` code points, with a visible character and no control or format character. */
const isLabelText = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  /\S/.test(value) &&
  [...value].length <= max &&
  !CONTROL_OR_FORMAT.test(value);

function requireActor(actor: unknown): string {
  if (typeof actor !== "string" || !ACTOR.test(actor)) {
    throw new CompanyOsError(
      "invalid_argument",
      "the actor is missing or malformed",
    );
  }
  if (actor.startsWith(SYSTEM_ACTOR_PREFIX)) {
    throw new CompanyOsError(
      "invalid_argument",
      "the actor prefix system: is reserved for automatic acts; a person names themselves",
    );
  }
  if (actor.startsWith(PRINCIPAL_ACTOR_PREFIX)) {
    throw new CompanyOsError(
      "invalid_argument",
      "the actor prefix principal: is reserved for a Company OS member the operator surface identified; a person at the owner CLI names themselves",
    );
  }
  return actor;
}

function requireReason(reason: unknown): string {
  if (!isLabelText(reason, MAX_MEMBERSHIP_REASON_LENGTH)) {
    throw new CompanyOsError(
      "invalid_argument",
      `reason must be 1 to ${MAX_MEMBERSHIP_REASON_LENGTH} characters, not blank, with no control or format character`,
    );
  }
  return reason;
}

function requireDisplayName(displayName: unknown): string {
  if (
    !isLabelText(displayName, MAX_DISPLAY_NAME_LENGTH) ||
    displayName.includes("@")
  ) {
    throw new CompanyOsError(
      "invalid_argument",
      `display name must be a label of 1 to ${MAX_DISPLAY_NAME_LENGTH} characters with no @ and no control or format character; it is never an email`,
    );
  }
  return displayName;
}

async function callJson(
  tx: TxClient,
  sql: string,
  params: readonly unknown[],
  fn: string,
): Promise<Record<string, unknown>> {
  let result: unknown;
  try {
    result = (await tx.query<{ result: unknown }>(sql, params)).rows[0]?.result;
  } catch (error) {
    throw toDomainError(error);
  }
  if (typeof result !== "object" || result === null) {
    throw new Error(`${fn} returned no answer`);
  }
  return result as Record<string, unknown>;
}

/**
 * Grants a Company OS membership of `input.tenantId` to the person with that
 * auth user id, creating their principal if they have none. Resolves with
 * `recorded: false` when they already hold that tenant's active membership.
 * `async`, so invalid input REJECTS the returned promise.
 */
export async function grantMembership(
  tx: TxClient,
  input: GrantMembershipInput,
  act: MembershipAct,
): Promise<GrantedMembership> {
  const params = [
    requireUuid(input.tenantId, "tenantId"),
    requireUuid(input.authUserId, "authUserId"),
    requireDisplayName(input.displayName),
    requireActor(act.actor),
    requireReason(act.reason),
  ] as const;
  const answer = await callJson(
    tx,
    "select ops.grant_membership($1, $2, $3, $4, $5) as result",
    params,
    "ops.grant_membership",
  );
  if (
    !isUuid(answer.principalId) ||
    !isUuid(answer.membershipId) ||
    typeof answer.recorded !== "boolean"
  ) {
    throw new Error("ops.grant_membership returned no membership");
  }
  return Object.freeze({
    principalId: answer.principalId,
    membershipId: answer.membershipId,
    recorded: answer.recorded,
  });
}

/** Revokes one membership. Resolves with `revoked: false` when it already was. */
export async function revokeMembership(
  tx: TxClient,
  membershipId: string,
  act: MembershipAct,
): Promise<RevokedMembership> {
  const params = [
    requireUuid(membershipId, "membershipId"),
    requireActor(act.actor),
    requireReason(act.reason),
  ] as const;
  const answer = await callJson(
    tx,
    "select ops.revoke_membership($1, $2, $3) as result",
    params,
    "ops.revoke_membership",
  );
  if (!isUuid(answer.membershipId) || typeof answer.revoked !== "boolean") {
    throw new Error("ops.revoke_membership returned no answer");
  }
  return Object.freeze({
    membershipId: answer.membershipId,
    revoked: answer.revoked,
  });
}

const UTC = (column: string): string =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * The ONLY expression that reads an email. It hashes the auth user's current
 * email exactly as ops.grant_membership hashed it at grant, compares the two
 * hashes and yields a boolean; an auth user that no longer exists, or has no
 * email, reads as changed.
 */
export const EMAIL_CHANGED_SINCE_GRANT = `(u.email is null
         or pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.lower(u.email), 'UTF8')), 'hex')
            is distinct from m.email_at_grant_sha256)`;

/** Every column a listing returns: no email, hash, reason, actor label or token. */
export const MEMBERSHIP_COLUMNS = `m.id, m.principal_id, p.subject as auth_user_id, m.tenant_id, m.role,
       p.display_name,
       ${UTC("m.granted_at")} as granted_at,
       ${UTC("m.revoked_at")} as revoked_at,
       ${EMAIL_CHANGED_SINCE_GRANT} as email_changed_since_grant`;

const LIST_SQL = `select ${MEMBERSHIP_COLUMNS}
    from ops.tenant_memberships m
    join ops.principals p on p.id = m.principal_id
    left join auth.users u on u.id = p.subject
   where ($1::uuid is null or m.tenant_id = $1::uuid)
   order by m.revoked_at is null desc, m.granted_at desc, m.id
   limit $2`;

interface MembershipRecord {
  readonly id: string;
  readonly principal_id: string;
  readonly auth_user_id: string;
  readonly tenant_id: string;
  readonly role: string;
  readonly display_name: string;
  readonly granted_at: string;
  readonly revoked_at: string | null;
  readonly email_changed_since_grant: boolean;
}

function boundedLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LISTED_MEMBERSHIPS;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_LISTED_MEMBERSHIPS
  ) {
    throw new CompanyOsError(
      "invalid_argument",
      `limit must be an integer between 1 and ${MAX_LISTED_MEMBERSHIPS}`,
    );
  }
  return value;
}

// Built field by field: whatever else a row carried is never passed on.
function toMembershipRow(record: MembershipRecord): MembershipRow {
  if (record.role !== "tenant_operator") {
    throw new Error("ops.tenant_memberships returned an unknown role");
  }
  if (typeof record.email_changed_since_grant !== "boolean") {
    throw new Error("the membership listing returned no email-change signal");
  }
  return Object.freeze({
    id: record.id,
    principalId: record.principal_id,
    authUserId: record.auth_user_id,
    tenantId: record.tenant_id,
    role: record.role,
    state: record.revoked_at === null ? "active" : "revoked",
    displayName: record.display_name,
    grantedAt: record.granted_at,
    revokedAt: record.revoked_at,
    emailChangedSinceGrant: record.email_changed_since_grant,
  });
}

/** Active memberships first, newest grant first within each group. */
export async function listMemberships(
  tx: TxClient,
  options: ListMembershipsOptions = {},
): Promise<readonly MembershipRow[]> {
  const tenantId =
    options.tenantId === undefined
      ? null
      : requireUuid(options.tenantId, "tenantId");
  const records = await readRows<MembershipRecord>(tx, LIST_SQL, [
    tenantId,
    boundedLimit(options.limit),
  ]);
  return Object.freeze(records.map(toMembershipRow));
}
