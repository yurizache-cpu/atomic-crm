// The browser inbox (ADR 0026 §E, SI-87): one waiting conversation, read on
// explicit open into memory only (no-store), and the two acts on it, built by
// ops.read_conversation, ops.reply_to_conversation_as_member and
// ops.release_conversation_as_member
// (supabase/migrations/20261021120000_browser_inbox_acts.sql).
//
// DEFINITIONS, decided by the server and only formatted by the screen:
//   - a conversation is reached by any task of its own inbound messages; it is
//     shown only while it waits for a person (an open request for a person or
//     an open waiting message), on a test line, for synthetic or test data,
//     its number not erased; otherwise the answer is a state;
//   - `revision`: the conversation's count of admitted or refused messages,
//     the value an act must name; a newer message makes an act stale;
//   - `turns`: the 50 most recent, oldest first: what the contact wrote (its
//     own words, for its own synthetic or test task only), a message the
//     transport refused (its reason only), and every reply that left or may
//     have left, or a person's reply asked for here, with its delivery;
//   - `allowedActs` and `replyUnavailable`: what the acts would do now; each
//     act decides again under the conversation's lock.
//
// MINIMISED. No key carries the contact's number, a conversation id, a CRM
// reference, an actor or an event order; the one name is the first word of
// the contact's CRM first name. Every object is strict.

import { z } from "zod";
import {
  ENVELOPE_SHAPE,
  ReasonCodeSchema,
  TimestampSchema,
  UuidSchema,
  boundedTextSchema,
} from "./primitives.ts";
import {
  FIXED_MESSAGE_KEYS,
  RESPONSE_DRAFT_MAX_LENGTH,
  REVIEW_AUTHORS,
} from "./reviewConversation.ts";

/** The most turns an answer carries; `earlierTurns` says more exist. */
export const CONVERSATION_TURNS_SHOWN = 50;
/** An admitted message's bound (the admission's body_too_long). */
export const INBOUND_TEXT_MAX_LENGTH = 4000;
/** The first word of the contact's CRM first name, at most this long. */
export const FIRST_NAME_MAX_LENGTH = 40;
/** A person's reply: the review's own draft bound. */
export const REPLY_TEXT_MAX_LENGTH = RESPONSE_DRAFT_MAX_LENGTH;

/** Who holds the conversation (ops.conversation_states.holder). */
export const CONVERSATION_HOLDERS = ["agent", "person"] as const;
/** Why a turn shows no text. */
export const TURN_HIDDEN_REASONS = ["withheld", "erased"] as const;
/** Why a conversation is not shown. */
export const CONVERSATION_WITHHELD_REASONS = ["not_test", "erased"] as const;
/**
 * A reply's delivery: on its way (`queued`), held by a stop of its unit
 * (`held`), the provider's states, `uncertain` when the send may have left,
 * and `failed` or `blocked` when it did not.
 */
export const REPLY_DELIVERY_STATES = [
  "queued",
  "held",
  "sent",
  "delivered",
  "read",
  "uncertain",
  "failed",
  "blocked",
] as const;
/**
 * Why a person's reply cannot be asked for now: who holds it, the window, an
 * open opt-out, then the newest message's own state. The act decides again,
 * and may name another reason first.
 */
export const REPLY_UNAVAILABLE_REASONS = [
  "not_held",
  "window_closed",
  "opt_out_open",
  "nothing_to_answer",
  "content_erased",
  "reply_limit",
  "do_not_contact",
] as const;
/** The reply act's answers; only `queued` wrote anything. */
export const REPLY_OUTCOMES = [
  "queued",
  "already_recorded",
  "second_factor_required",
  "withheld",
  "not_held",
  "not_waiting",
  "stale",
  "not_sendable",
  "nothing_to_answer",
  "content_erased",
  "reply_limit",
] as const;
/** The release act's answers; only `released` wrote anything. */
export const RELEASE_OUTCOMES = [
  "released",
  "already_with_agent",
  "withheld",
  "not_waiting",
  "stale",
  "opt_out_open",
] as const;

export const ConversationRevisionSchema = z.int().min(0).max(2_147_483_647);

// A control character but the line break (U+0000 to U+0009, U+000B to U+001F,
// U+007F to U+009F), which the act refuses.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\x00-\x09\x0B-\x1F\x7F-\x9F]/;

/** A person's reply: 1 to 2000 code points, not blank, no control character but the line break. */
export const ReplyTextSchema = boundedTextSchema(REPLY_TEXT_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARACTER.test(value), {
    message: "no control character",
  })
  .refine((value) => /\S/.test(value), { message: "not blank" });

const hiddenMeansNoText = (
  turn: { text: string | null; hidden: string | null },
  ctx: z.RefinementCtx,
) => {
  if ((turn.text === null) !== (turn.hidden !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["hidden"],
      message: "a turn shows its text or says why not",
    });
  }
};

const InboundTurnSchema = z
  .strictObject({
    kind: z.literal("inbound"),
    at: TimestampSchema,
    text: boundedTextSchema(INBOUND_TEXT_MAX_LENGTH).nullable(),
    hidden: z.enum(TURN_HIDDEN_REASONS).nullable(),
  })
  .superRefine(hiddenMeansNoText);

const RefusedTurnSchema = z.strictObject({
  kind: z.literal("refused"),
  at: TimestampSchema,
  reason: ReasonCodeSchema,
});

const NOT_CLEAN = new Set(["failed", "blocked", "uncertain"]);

const ReplyTurnSchema = z
  .strictObject({
    kind: z.literal("reply"),
    at: TimestampSchema,
    author: z.enum(REVIEW_AUTHORS),
    fixedKey: z.enum(FIXED_MESSAGE_KEYS).nullable(),
    automatic: z.boolean(),
    text: boundedTextSchema(RESPONSE_DRAFT_MAX_LENGTH).nullable(),
    hidden: z.enum(TURN_HIDDEN_REASONS).nullable(),
    delivery: z.enum(REPLY_DELIVERY_STATES),
    reason: ReasonCodeSchema.nullable(),
    withPrivacyNotice: z.boolean(),
  })
  .superRefine((turn, ctx) => {
    hiddenMeansNoText(turn, ctx);
    if (turn.fixedKey !== null && turn.author !== "fixed") {
      ctx.addIssue({
        code: "custom",
        path: ["fixedKey"],
        message: "only a fixed text names its key",
      });
    }
    if (turn.automatic && turn.author !== "fixed") {
      ctx.addIssue({
        code: "custom",
        path: ["automatic"],
        message: "only a fixed text leaves on its own",
      });
    }
    if (turn.reason !== null && !NOT_CLEAN.has(turn.delivery)) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "only a send that did not leave cleanly has a reason",
      });
    }
  });

export const ConversationTurnSchema = z.discriminatedUnion("kind", [
  InboundTurnSchema,
  RefusedTurnSchema,
  ReplyTurnSchema,
]);

const AvailableConversationSchema = z
  .strictObject({
    ...ENVELOPE_SHAPE,
    status: z.literal("available"),
    revision: ConversationRevisionSchema,
    holder: z.enum(CONVERSATION_HOLDERS),
    optOutOpen: z.boolean(),
    firstName: boundedTextSchema(FIRST_NAME_MAX_LENGTH).nullable(),
    lastMessageAt: TimestampSchema.nullable(),
    windowEndsAt: TimestampSchema.nullable(),
    allowedActs: z.strictObject({ reply: z.boolean(), release: z.boolean() }),
    replyUnavailable: z.enum(REPLY_UNAVAILABLE_REASONS).nullable(),
    earlierTurns: z.boolean(),
    turns: z.array(ConversationTurnSchema).max(CONVERSATION_TURNS_SHOWN),
  })
  .superRefine((c, ctx) => {
    if (c.allowedActs.reply !== (c.replyUnavailable === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["replyUnavailable"],
        message: "a reply is allowed exactly when nothing makes it unavailable",
      });
    }
    if (c.allowedActs.reply && (c.holder !== "person" || c.optOutOpen)) {
      ctx.addIssue({
        code: "custom",
        path: ["allowedActs", "reply"],
        message:
          "only a person's conversation without an open opt-out is answered",
      });
    }
    if (c.allowedActs.release !== (c.holder === "person" && !c.optOutOpen)) {
      ctx.addIssue({
        code: "custom",
        path: ["allowedActs", "release"],
        message: "a person's conversation without an open opt-out is released",
      });
    }
    if (c.earlierTurns && c.turns.length !== CONVERSATION_TURNS_SHOWN) {
      ctx.addIssue({
        code: "custom",
        path: ["earlierTurns"],
        message: "earlier turns exist only behind a full page",
      });
    }
  });

export const ConversationSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...ENVELOPE_SHAPE,
    status: z.literal("withheld"),
    reason: z.enum(CONVERSATION_WITHHELD_REASONS),
  }),
  z.strictObject({ ...ENVELOPE_SHAPE, status: z.literal("not_waiting") }),
  AvailableConversationSchema,
]);

export const ReplyToConversationInputSchema = z.strictObject({
  p_task_id: UuidSchema,
  p_text: ReplyTextSchema,
  p_expected_revision: ConversationRevisionSchema,
});

export const ReleaseConversationInputSchema = z.strictObject({
  p_task_id: UuidSchema,
  p_expected_revision: ConversationRevisionSchema,
});

export const ReplyToConversationResultSchema = z
  .strictObject({
    ...ENVELOPE_SHAPE,
    outcome: z.enum(REPLY_OUTCOMES),
    revision: ConversationRevisionSchema.nullable(),
    reason: ReasonCodeSchema.nullable(),
  })
  .superRefine((r, ctx) => {
    if ((r.reason !== null) !== (r.outcome === "not_sendable")) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "only a send the gates refuse names a reason",
      });
    }
    if (
      (r.revision === null) !==
      (r.outcome === "second_factor_required" || r.outcome === "withheld")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["revision"],
        message:
          "every outcome but a missing factor or a withheld conversation names the revision",
      });
    }
  });

export const ReleaseConversationResultSchema = z
  .strictObject({
    ...ENVELOPE_SHAPE,
    outcome: z.enum(RELEASE_OUTCOMES),
    revision: ConversationRevisionSchema.nullable(),
  })
  .superRefine((r, ctx) => {
    if ((r.revision === null) !== (r.outcome === "withheld")) {
      ctx.addIssue({
        code: "custom",
        path: ["revision"],
        message: "only a withheld conversation hides its revision",
      });
    }
  });

export type Conversation = z.infer<typeof ConversationSchema>;
export type AvailableConversation = z.infer<typeof AvailableConversationSchema>;
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;
export type ConversationHolder = (typeof CONVERSATION_HOLDERS)[number];
export type ReplyDeliveryState = (typeof REPLY_DELIVERY_STATES)[number];
export type ReplyUnavailableReason = (typeof REPLY_UNAVAILABLE_REASONS)[number];
export type ReplyOutcomeCode = (typeof REPLY_OUTCOMES)[number];
export type ReleaseOutcomeCode = (typeof RELEASE_OUTCOMES)[number];
export type ReplyToConversationResult = z.infer<
  typeof ReplyToConversationResultSchema
>;
export type ReleaseConversationResult = z.infer<
  typeof ReleaseConversationResultSchema
>;
