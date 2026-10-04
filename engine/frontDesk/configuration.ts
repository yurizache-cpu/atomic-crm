// The front-desk agent's versioned configuration (ADR 0023 §D), as the owner
// authors it. The database stores each kind as one immutable version and
// checks what the runtime relies on (ops.agent_configuration_valid); this file
// is the full authoring shape, checked before a draft is written.
//
// Four kinds, matching what the owner reviews:
//   operating_policy  how the agent works: send mode, screening pack, scope,
//                     what it never does, how far back it reads, scheduling.
//   playbook          the stages of a conversation: objectives, required
//                     facts, transitions, forbidden behaviour, example phrasing.
//   knowledge         the facts the agent may state, by domain. Nothing else
//                     is a fact to it (ADR 0023 §E).
//   fixed_messages    the exact texts for the cases a model never writes.
//
// Content is tenant data: Portuguese here is the tenant's language, never a
// constant in engine logic.

import { z } from "zod";
import { SANITIZER_PACKS } from "./packs/healthPtBr.ts";

export const CONFIGURATION_KINDS = [
  "operating_policy",
  "playbook",
  "knowledge",
  "fixed_messages",
] as const;
export type ConfigurationKind = (typeof CONFIGURATION_KINDS)[number];

/** The fixed texts every published set holds (ops.fixed_message_keys()). */
export const FIXED_MESSAGE_KEYS = [
  "safety",
  "human_handoff_ack",
  "sensitive_only_prospect",
  "sensitive_only_client",
  "clarification",
  "out_of_scope",
  "service_unavailable",
  "opt_out_ack",
] as const;
export type FixedMessageKey = (typeof FIXED_MESSAGE_KEYS)[number];

// Control characters other than a line break.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0001-\u0009\u000B-\u001F\u007F]/u;
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) => !CONTROL.test(value),
      "no control characters but the line break",
    );
const key = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const domainKey = z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/);
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const operatingPolicySchema = z.strictObject({
  /** `autonomous` does not exist yet: the database refuses it too (ADR 0023 §F). */
  sendMode: z.enum(["staging", "supervised"]),
  sanitizerPack: z
    .string()
    .refine(
      (id) => Object.hasOwn(SANITIZER_PACKS, id),
      "an unknown screening pack",
    ),
  /** Earlier turns of the conversation the model may read, at most 12. */
  contextTurns: z.int().min(0).max(12),
  /** How the agent identifies itself as a virtual assistant. */
  aiDisclosure: text(300),
  /** What the agent handles. */
  scope: z.array(text(300)).min(1).max(20),
  /** What it never does. */
  prohibited: z.array(text(300)).max(30),
  /** What each party kind may be served with (a client's treatment never). */
  partyPolicy: z.strictObject({
    prospect: z.array(text(200)).max(20),
    client: z.array(text(200)).max(20),
  }),
  /** The booking resource and type availability is read from, when connected. */
  scheduling: z
    .strictObject({ resourceId: uuid, bookingTypeId: uuid })
    .optional(),
});

export const playbookSchema = z.strictObject({
  stages: z
    .array(
      z.strictObject({
        key,
        objective: text(500),
        requiredFacts: z.array(text(200)).max(10),
        transitions: z.array(key).max(10),
        forbidden: z.array(text(300)).max(10),
        examples: z.array(text(500)).max(5),
      }),
    )
    .min(1)
    .max(20),
});

const qa = z.strictObject({ q: text(300), a: text(1500) });
const knowledgeValue = z.union([
  text(2000),
  z.array(text(1000)).min(1).max(50),
  z.array(qa).min(1).max(60),
]);

export const knowledgeSchema = z.strictObject({
  domains: z
    .record(domainKey, knowledgeValue)
    .refine(
      (domains) => Object.keys(domains).length > 0,
      "at least one domain",
    ),
});

export const fixedMessagesSchema = z.strictObject({
  messages: z.strictObject(
    Object.fromEntries(
      FIXED_MESSAGE_KEYS.map((name) => [name, text(1000)]),
    ) as Record<FixedMessageKey, ReturnType<typeof text>>,
  ),
});

export const CONFIGURATION_SCHEMAS = {
  operating_policy: operatingPolicySchema,
  playbook: playbookSchema,
  knowledge: knowledgeSchema,
  fixed_messages: fixedMessagesSchema,
} as const;

export type OperatingPolicy = z.infer<typeof operatingPolicySchema>;
export type Playbook = z.infer<typeof playbookSchema>;
export type Knowledge = z.infer<typeof knowledgeSchema>;
export type FixedMessages = z.infer<typeof fixedMessagesSchema>;

/** The largest content a version may hold, as the database counts it. */
export const MAX_CONFIGURATION_BYTES = 60_000;

/**
 * Validates authored content for one kind. Returns the parsed content, or the
 * issue paths (never the values: the content is tenant text).
 */
export function validateConfiguration(
  kind: ConfigurationKind,
  content: unknown,
): { ok: true; content: unknown } | { ok: false; problems: string[] } {
  const parsed = CONFIGURATION_SCHEMAS[kind].safeParse(content);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`,
      ),
    };
  }
  if (
    Buffer.byteLength(JSON.stringify(parsed.data), "utf8") >
    MAX_CONFIGURATION_BYTES
  ) {
    return {
      ok: false,
      problems: [`(root): larger than ${MAX_CONFIGURATION_BYTES} bytes`],
    };
  }
  return { ok: true, content: parsed.data };
}
