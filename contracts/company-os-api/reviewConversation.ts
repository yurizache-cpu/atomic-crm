// What a review shows of its conversation (ADR 0023 §L, owner decision
// 2026-10-05, amending SI-52 and SI-56): the front desk's screening of the
// message, the reply draft the send act would carry, and whether the contact
// wrote again since. Only for a browser-decidable review of synthetic or test
// data; any other review reads `unavailable`.
//
// The screened text is what a model and Jev read, never the raw message: the
// task's description stays in the raw store. Read on the review's own open,
// held in browser memory only (no-store), like every other read.

import { z } from "zod";
import { boundedTextSchema } from "./primitives.ts";

/** The front desk's screening vocabulary (ops.inbound_screenings). */
export const SCREENING_MESSAGE_CLASSES = [
  "administrative",
  "mixed",
  "sensitive_only",
  "safety",
  "unknown",
] as const;

export const SCREENING_DISPOSITIONS = [
  "model",
  "fixed_reply",
  "held_for_person",
] as const;

/** The fixed texts a front desk carries (ops.fixed_message_keys()). */
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

/** The screened text's bound (inbound_screenings_input_length). */
export const SCREENED_MESSAGE_MAX_LENGTH = 4000;

/** The reply draft's bound (the lead_triage output contract). */
export const RESPONSE_DRAFT_MAX_LENGTH = 2000;

const ScreeningSchema = z
  .strictObject({
    messageClass: z.enum(SCREENING_MESSAGE_CLASSES),
    disposition: z.enum(SCREENING_DISPOSITIONS),
    fixedMessageKey: z.enum(FIXED_MESSAGE_KEYS).nullable(),
    // null: nothing of the message may be sent, or its text was redacted.
    screenedMessage: boundedTextSchema(SCREENED_MESSAGE_MAX_LENGTH).nullable(),
  })
  .superRefine((screening, ctx) => {
    if (
      (screening.disposition === "fixed_reply") !==
      (screening.fixedMessageKey !== null)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["fixedMessageKey"],
        message: "only a fixed reply names its fixed text",
      });
    }
    if (
      screening.screenedMessage !== null &&
      screening.messageClass !== "administrative" &&
      screening.messageClass !== "mixed"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["screenedMessage"],
        message: "only an administrative or mixed message keeps a text",
      });
    }
  });

export const ReviewConversationSchema = z.union([
  z.strictObject({ status: z.literal("unavailable") }),
  z
    .strictObject({
      status: z.literal("available"),
      // null: no front-desk screening recorded this message.
      screening: ScreeningSchema.nullable(),
      // null once the task's content is redacted.
      replyDraft: boundedTextSchema(RESPONSE_DRAFT_MAX_LENGTH).nullable(),
      contentRedacted: z.boolean(),
      // The contact wrote again after this message: the send refuses it.
      newerMessage: z.boolean(),
    })
    .superRefine((conversation, ctx) => {
      if (conversation.contentRedacted && conversation.replyDraft !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["replyDraft"],
          message: "a redacted review has no draft left",
        });
      }
    }),
]);

export type ReviewConversation = z.infer<typeof ReviewConversationSchema>;
export type ScreeningMessageClass = (typeof SCREENING_MESSAGE_CLASSES)[number];
export type ScreeningDisposition = (typeof SCREENING_DISPOSITIONS)[number];
