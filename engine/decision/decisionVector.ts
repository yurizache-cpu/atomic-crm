// The DecisionPort's two contracts (Phase 2D.1, shadow mode): what a decision
// provider may read, and what it must answer. Both are strict: an unknown key,
// value or version is refused, never coerced.
//
// The database holds the authoritative copies. ops.decision_input_for_review
// builds the input from structured, vocabulary-checked values only, and
// ops.decision_vector_valid checks a vector again before it is stored
// (supabase/migrations/20260925120000_decision_shadow.sql). A driver-backed
// test keeps the two in step (engine/domain/decisionShadow.dbtest.ts).

import { z } from "zod";

export const DECISION_INPUT_VERSION = "decision_input.v1";
export const DECISION_VECTOR_VERSION = "decision_vector.v1";
/** The one subject 2D.1 evaluates. */
export const DECISION_SUBJECT = "lead_triage.review";

export const RECOMMENDATIONS = [
  "accept",
  "needs_edit",
  "reject",
  "abstain",
] as const;
export const CAUTION_LEVELS = ["low", "medium", "high"] as const;
export const DECISION_PROVIDER_KINDS = ["fake", "jev"] as const;

/**
 * The allowlisted input. Structured enums and booleans only: no message body,
 * reply draft, summary, free-text next action, phone number, email, name,
 * auth identity, CRM note, tenant or record id. A value outside its
 * vocabulary arrives as null (the database drops it) and is passed on as null.
 */
export const DecisionInputSchema = z.strictObject({
  version: z.literal(DECISION_INPUT_VERSION),
  subject: z.literal(DECISION_SUBJECT),
  sourceClass: z.enum(["synthetic", "whatsapp_test"]),
  contactPolicy: z.enum(["contactable", "do_not_contact"]),
  triage: z.strictObject({
    outcome: z.enum(["triaged", "needs_input", "out_of_scope"]).nullable(),
    intent: z
      .enum(["book_appointment", "pricing", "information", "support", "other"])
      .nullable(),
    priority: z.enum(["low", "normal", "high"]).nullable(),
    flags: z
      .array(
        z.enum([
          "possible_crisis",
          "minor",
          "out_of_scope",
          "already_a_patient",
          "spam",
          "unclear",
        ]),
      )
      .max(6),
    needsHumanReview: z.boolean().nullable(),
  }),
});

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export const DecisionProviderIdentitySchema = z.strictObject({
  kind: z.enum(DECISION_PROVIDER_KINDS),
  id: z.string().regex(NAME),
  version: z.string().regex(NAME),
});

/**
 * A provider's answer. Advisory: stable reason codes, never prose, never a
 * chain of thought. `confidence` is a bounded number (finite, 0 to 1).
 */
export const DecisionVectorSchema = z.strictObject({
  version: z.literal(DECISION_VECTOR_VERSION),
  mode: z.literal("shadow"),
  recommendation: z.enum(RECOMMENDATIONS),
  confidence: z.number().finite().min(0).max(1),
  caution: z.enum(CAUTION_LEVELS),
  reasonCodes: z
    .array(z.string().regex(REASON_CODE))
    .min(1)
    .max(8)
    .refine((codes) => new Set(codes).size === codes.length, {
      message: "reason codes are unique",
    }),
  provider: DecisionProviderIdentitySchema,
  inputFingerprint: z.string().regex(FINGERPRINT),
  evaluatedAt: z.string().regex(TIMESTAMP),
});

export type DecisionInput = z.infer<typeof DecisionInputSchema>;
export type DecisionVector = z.infer<typeof DecisionVectorSchema>;
export type DecisionProviderIdentity = z.infer<
  typeof DecisionProviderIdentitySchema
>;
export type Recommendation = (typeof RECOMMENDATIONS)[number];
