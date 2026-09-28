// BASELINE Q8 model-data authorizations (ADR 0020 §D2; owner decisions D1-D10)
// as a narrow, typed owner boundary over ops.model_data_authorizations.
//
// WHAT ONE IS. One immutable version saying that data of ONE class may reach ONE
// provider and exact model for ONE capability (the purpose), for one tenant,
// between two instants, on the strength of evidence the owner verified. Absent,
// retired, expired or not yet valid, nothing but synthetic and test data (and the
// in-process fake provider) passes the gate at ops.start_agent_run.
//
// WHAT IT CARRIES. References, never content: pointers to the owner's records of
// the provider evidence, the contract, the DPA, zero data retention (store:false
// is not it), the verified retention behaviour, the international-transfer
// mechanism and the lawful basis. For person content (person_text, health) every
// one is required, training must be excluded and the AI working content's
// retention is at most 30 days (D4, D5, D6, D9); only the tenant that owns the
// local CRM can hold one (D1); and only a capability whose input is minimised
// (lead_triage) can be named. The database enforces all of it.
//
// RECORDING AND RETIRING are owner acts (`npm run ops -- data-auth record |
// retire`), never an environment variable and never the browser. Recording the
// same version again resolves to it; different values supersede the version in
// force, recorded on it. Each act validates before the database and calls
// exactly one function; the database still decides everything.

import type { TxClient } from "../db/types.ts";
import {
  isAuthorizableDataClass,
  type AuthorizableDataClass,
} from "./dataClasses.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";
import { parseIsoInstantMicros } from "./modelPrices.ts";

export interface ModelDataAuthorizationInput {
  readonly tenantId: string;
  readonly dataClass: AuthorizableDataClass;
  /** The purpose: one agent run capability. */
  readonly capability: string;
  readonly provider: string;
  /** The exact model or snapshot, as the price names it. */
  readonly model: string;
  /** ISO 8601 with seconds and an explicit offset. */
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly providerEvidenceRef: string;
  readonly evidenceVerifiedAt: string;
  readonly trainingExcluded: boolean;
  readonly contractRef?: string;
  readonly dpaRef?: string;
  readonly zeroRetentionRef?: string;
  readonly retentionEvidenceRef?: string;
  readonly transferMechanismRef?: string;
  readonly lawfulBasisRef?: string;
  readonly contentRetentionDays?: number;
}

export interface ModelDataAuthorizationAct {
  readonly actor: string;
}

export interface RetireModelDataAuthorizationAct {
  readonly reason: string;
  readonly actor: string;
}

export type ModelDataAuthorizationStatus =
  | "in_force"
  | "future"
  | "expired"
  | "retired";

export interface ModelDataAuthorizationRow {
  readonly id: string;
  readonly tenantId: string;
  readonly dataClass: string;
  readonly capability: string;
  readonly provider: string;
  readonly model: string;
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly providerEvidenceRef: string;
  readonly evidenceVerifiedAt: string;
  readonly trainingExcluded: boolean;
  readonly contractRef: string | null;
  readonly dpaRef: string | null;
  readonly zeroRetentionRef: string | null;
  readonly retentionEvidenceRef: string | null;
  readonly transferMechanismRef: string | null;
  readonly lawfulBasisRef: string | null;
  readonly contentRetentionDays: number | null;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly retiredAt: string | null;
  readonly retiredBy: string | null;
  /** How many runs relied on this version. */
  readonly runsRelied: number;
  readonly status: ModelDataAuthorizationStatus;
}

/** A list is bounded. */
export const MAX_LISTED_MODEL_DATA_AUTHORIZATIONS = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITY = /^[a-z][a-z0-9_]{0,63}$/;
const PROVIDER = /^[a-z][a-z0-9_]{0,31}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const REFERENCE = /^[\x21-\x7e]{1,200}$/;
const ACTOR = /^[a-z0-9][a-z0-9_.:@-]{0,127}$/;
const MAX_VALIDITY_MICROS = 366n * 86_400n * 1_000_000n;
const MAX_CONTENT_RETENTION_DAYS = 30;
const STATUSES: readonly ModelDataAuthorizationStatus[] = Object.freeze([
  "in_force",
  "future",
  "expired",
  "retired",
]);
/** The references person content requires (D4, D5, D9), by input field. */
const PERSON_CONTENT_REFERENCES = Object.freeze([
  "contractRef",
  "dpaRef",
  "zeroRetentionRef",
  "retentionEvidenceRef",
  "transferMechanismRef",
  "lawfulBasisRef",
] as const);

const invalid = (message: string): CompanyOsError =>
  new CompanyOsError("invalid_argument", message);

const UTC = (column: string): string =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const LIST_SQL = `select a.id, a.tenant_id, a.data_class, a.capability, a.provider, a.model,
         ${UTC("a.valid_from")} as valid_from, ${UTC("a.expires_at")} as expires_at,
         a.provider_evidence_ref, ${UTC("a.evidence_verified_at")} as evidence_verified_at,
         a.training_excluded, a.contract_ref, a.dpa_ref, a.zero_retention_ref,
         a.retention_evidence_ref, a.transfer_mechanism_ref, a.lawful_basis_ref,
         a.content_retention_days, a.recorded_by, ${UTC("a.recorded_at")} as recorded_at,
         case when a.retired_at is null then null else ${UTC("a.retired_at")} end as retired_at,
         a.retired_by,
         (select count(*)::int from ops.agent_runs r
           where r.tenant_id = a.tenant_id and r.data_authorization_id = a.id) as runs_relied,
         case
           when a.retired_at is not null then 'retired'
           when a.valid_from > now() then 'future'
           when a.expires_at <= now() then 'expired'
           else 'in_force'
         end as status
    from ops.model_data_authorizations a
   where ($1::uuid is null or a.tenant_id = $1::uuid)
     and ($2::boolean or a.retired_at is null)
   order by a.tenant_id, a.data_class, a.capability, a.provider, a.model, a.recorded_at desc, a.id
   limit $3`;

interface ModelDataAuthorizationRecord {
  id: string;
  tenant_id: string;
  data_class: string;
  capability: string;
  provider: string;
  model: string;
  valid_from: string;
  expires_at: string;
  provider_evidence_ref: string;
  evidence_verified_at: string;
  training_excluded: boolean;
  contract_ref: string | null;
  dpa_ref: string | null;
  zero_retention_ref: string | null;
  retention_evidence_ref: string | null;
  transfer_mechanism_ref: string | null;
  lawful_basis_ref: string | null;
  content_retention_days: number | null;
  recorded_by: string;
  recorded_at: string;
  retired_at: string | null;
  retired_by: string | null;
  runs_relied: number;
  status: string;
}

function requireInstant(text: unknown, field: string): bigint {
  const micros = parseIsoInstantMicros(text);
  if (micros === null) {
    throw invalid(
      `${field} must be an ISO 8601 instant with seconds and an offset, such as 2026-10-01T00:00:00Z`,
    );
  }
  return micros;
}

function optionalReference(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !REFERENCE.test(value)) {
    throw invalid(
      `${field} must be an opaque reference of 1 to 200 printable characters with no spaces, never the record's content`,
    );
  }
  return value;
}

/** The eighteen positional arguments of ops.record_model_data_authorization. */
function recordParams(
  input: ModelDataAuthorizationInput,
  act: ModelDataAuthorizationAct,
): unknown[] {
  if (typeof input.tenantId !== "string" || !UUID.test(input.tenantId)) {
    throw new CompanyOsError("malformed_identifier", "tenantId is not a uuid");
  }
  if (!isAuthorizableDataClass(input.dataClass)) {
    throw invalid(
      "only operational, person_text or health data can be authorized; identifier, clinical_record, derived and unclassified never are, and synthetic and test need none",
    );
  }
  if (
    typeof input.capability !== "string" ||
    !CAPABILITY.test(input.capability)
  ) {
    throw invalid("capability is missing or malformed");
  }
  if (
    typeof input.provider !== "string" ||
    !PROVIDER.test(input.provider) ||
    input.provider === "fake"
  ) {
    throw invalid(
      "provider must be a real provider's name; the in-process fake needs no authorization",
    );
  }
  if (typeof input.model !== "string" || !MODEL.test(input.model)) {
    throw invalid("model is missing or malformed");
  }
  const from = requireInstant(input.validFrom, "validFrom");
  const until = requireInstant(input.expiresAt, "expiresAt");
  const verified = requireInstant(
    input.evidenceVerifiedAt,
    "evidenceVerifiedAt",
  );
  if (
    until <= from ||
    from < verified ||
    until - verified > MAX_VALIDITY_MICROS
  ) {
    throw invalid(
      "an authorization is valid from no earlier than its evidence was verified, and expires after that, within 366 days of the verification",
    );
  }
  const evidence = optionalReference(
    input.providerEvidenceRef,
    "providerEvidenceRef",
  );
  if (evidence === null) {
    throw invalid("providerEvidenceRef is required");
  }
  if (typeof input.trainingExcluded !== "boolean") {
    throw invalid("whether API data is excluded from training must be stated");
  }
  const references = PERSON_CONTENT_REFERENCES.map((field) =>
    optionalReference(input[field], field),
  );
  const days = input.contentRetentionDays;
  if (input.dataClass === "operational") {
    if (days !== undefined && days !== null) {
      throw invalid("operational data carries no content retention period");
    }
  } else {
    const missing = PERSON_CONTENT_REFERENCES.filter(
      (_, i) => references[i] === null,
    );
    if (missing.length > 0) {
      throw invalid(
        `person content needs every evidence reference; missing: ${missing.join(", ")}`,
      );
    }
    if (!input.trainingExcluded) {
      throw invalid("person content needs API data excluded from training");
    }
    if (
      typeof days !== "number" ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > MAX_CONTENT_RETENTION_DAYS
    ) {
      throw invalid(
        `person content needs a content retention period of 1 to ${MAX_CONTENT_RETENTION_DAYS} days`,
      );
    }
  }
  if (typeof act.actor !== "string" || !ACTOR.test(act.actor)) {
    throw invalid("actor is missing or malformed");
  }
  return [
    input.tenantId,
    input.dataClass,
    input.capability,
    input.provider,
    input.model,
    input.validFrom,
    input.expiresAt,
    evidence,
    input.evidenceVerifiedAt,
    input.trainingExcluded,
    ...references,
    input.dataClass === "operational" ? null : days,
    act.actor,
  ];
}

/** Records one authorization version and resolves to its id; the same version again resolves to the same id. */
export async function recordModelDataAuthorization(
  tx: TxClient,
  input: ModelDataAuthorizationInput,
  act: ModelDataAuthorizationAct,
): Promise<string> {
  const params = recordParams(input, act);
  let id: unknown;
  try {
    const { rows } = await tx.query<{ result: unknown }>(
      "select ops.record_model_data_authorization($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) as result",
      params,
    );
    id = rows[0]?.result;
  } catch (error) {
    throw toDomainError(error);
  }
  if (typeof id !== "string") {
    throw new Error("the database returned no data authorization id");
  }
  return id;
}

/** Retires one version; resolves to false when it was already retired. */
export async function retireModelDataAuthorization(
  tx: TxClient,
  authorizationId: string,
  act: RetireModelDataAuthorizationAct,
): Promise<boolean> {
  if (typeof authorizationId !== "string" || !UUID.test(authorizationId)) {
    throw new CompanyOsError("malformed_identifier", "id is not a uuid");
  }
  if (
    typeof act.reason !== "string" ||
    !/\S/.test(act.reason) ||
    act.reason.length > 500
  ) {
    throw invalid("reason must be 1 to 500 characters and not blank");
  }
  if (typeof act.actor !== "string" || !ACTOR.test(act.actor)) {
    throw invalid("actor is missing or malformed");
  }
  try {
    const { rows } = await tx.query<{ result: boolean }>(
      "select ops.retire_model_data_authorization($1, $2, $3) as result",
      [authorizationId, act.reason, act.actor],
    );
    return rows[0]?.result === true;
  } catch (error) {
    throw toDomainError(error);
  }
}

function toRow(
  record: ModelDataAuthorizationRecord,
): ModelDataAuthorizationRow {
  if (!STATUSES.includes(record.status as ModelDataAuthorizationStatus)) {
    throw new Error(
      "ops.model_data_authorizations produced a row with an unknown status",
    );
  }
  return {
    id: record.id,
    tenantId: record.tenant_id,
    dataClass: record.data_class,
    capability: record.capability,
    provider: record.provider,
    model: record.model,
    validFrom: record.valid_from,
    expiresAt: record.expires_at,
    providerEvidenceRef: record.provider_evidence_ref,
    evidenceVerifiedAt: record.evidence_verified_at,
    trainingExcluded: record.training_excluded,
    contractRef: record.contract_ref,
    dpaRef: record.dpa_ref,
    zeroRetentionRef: record.zero_retention_ref,
    retentionEvidenceRef: record.retention_evidence_ref,
    transferMechanismRef: record.transfer_mechanism_ref,
    lawfulBasisRef: record.lawful_basis_ref,
    contentRetentionDays: record.content_retention_days,
    recordedBy: record.recorded_by,
    recordedAt: record.recorded_at,
    retiredAt: record.retired_at,
    retiredBy: record.retired_by,
    runsRelied: record.runs_relied,
    status: record.status as ModelDataAuthorizationStatus,
  };
}

/**
 * Authorization versions, at most MAX_LISTED_MODEL_DATA_AUTHORIZATIONS: those
 * not retired, unless `includeHistory` adds the retired ones. Status is the
 * database's, at its own now().
 */
export async function listModelDataAuthorizations(
  tx: TxClient,
  options: {
    readonly tenantId?: string;
    readonly includeHistory?: boolean;
  } = {},
): Promise<readonly ModelDataAuthorizationRow[]> {
  const tenantId = options.tenantId ?? null;
  if (tenantId !== null && !UUID.test(tenantId)) {
    throw new CompanyOsError("malformed_identifier", "tenantId is not a uuid");
  }
  const includeHistory = options.includeHistory ?? false;
  if (typeof includeHistory !== "boolean") {
    throw invalid("includeHistory must be a boolean");
  }
  let records: ModelDataAuthorizationRecord[];
  try {
    ({ rows: records } = await tx.query<ModelDataAuthorizationRecord>(
      LIST_SQL,
      [tenantId, includeHistory, MAX_LISTED_MODEL_DATA_AUTHORIZATIONS],
    ));
  } catch (error) {
    throw toDomainError(error);
  }
  return records.map(toRow);
}
