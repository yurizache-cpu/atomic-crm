// BASELINE Q8's closed data classification (ADR 0020 §B), mirrored from
// ops.data_classes() and ops.model_authorizable_data_classes()
// (supabase/migrations/20261001120000_model_data_authorization.sql).
//
// A class is about sensitivity and provenance, never tenant vocabulary. It is
// assigned by trusted server code from where the data came from, never read from
// a payload, the browser or the content, and a task's class is fixed at creation.
// The database is the authority: these lists only let a caller fail fast.

export const DATA_CLASSES = Object.freeze([
  "synthetic",
  "test",
  "operational",
  "identifier",
  "person_text",
  "health",
  "clinical_record",
  "derived",
  "unclassified",
] as const);

export type DataClass = (typeof DATA_CLASSES)[number];

/**
 * What an owner may ever authorize for an external model (owner decision D2).
 * identifier and clinical_record never are; derived is authorized as its
 * source's class; synthetic and test need no authorization.
 */
export const MODEL_AUTHORIZABLE_DATA_CLASSES = Object.freeze([
  "operational",
  "person_text",
  "health",
] as const);

export type AuthorizableDataClass =
  (typeof MODEL_AUTHORIZABLE_DATA_CLASSES)[number];

export const isDataClass = (value: unknown): value is DataClass =>
  typeof value === "string" &&
  (DATA_CLASSES as readonly string[]).includes(value);

export const isAuthorizableDataClass = (
  value: unknown,
): value is AuthorizableDataClass =>
  typeof value === "string" &&
  (MODEL_AUTHORIZABLE_DATA_CLASSES as readonly string[]).includes(value);
