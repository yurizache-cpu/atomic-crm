// The waiting list (ADR 0026 §D): the overview's read-only list of the
// conversations that wait for a person now, built by ops.cos_waiting_list
// (supabase/migrations/20261020130000_waiting_list_read_model.sql).
//
// DEFINITIONS, decided by the server and only formatted by the screen:
//   - a conversation waits while it has an open request for a person or an
//     open waiting message; `kinds` names which, `counts` how many messages
//     each counted;
//   - oldest first, by `waitingSince` (the oldest open episode), at most 50
//     shown, `total` exact;
//   - `windowEndsAt`: the end of the 24 hours after the contact's last message,
//     inside which a person's reply can still reach the contact;
//   - `notification`: the state of the owner's notification about it, and
//     when that state was reached; a notification carried by a digest shows
//     the digest's state.
//
// MINIMISED. A conversation is the opaque reference of the task of its oldest
// open episode, its kinds, counts and instants. No text, number, name,
// conversation id or event order has a key, and every object is strict.

import { z } from "zod";
import { CountSchema, TimestampSchema, UuidSchema } from "./primitives.ts";

export const WAITING_KINDS = ["person_requested", "message_waiting"] as const;
export type WaitingKind = (typeof WAITING_KINDS)[number];

export const WAITING_NOTIFICATION_STATES = [
  "none",
  "pending",
  "sent",
  "delivered",
  "read",
  "failed",
  "indeterminate",
  "skipped",
  "blocked",
] as const;
export type WaitingNotificationState =
  (typeof WAITING_NOTIFICATION_STATES)[number];

/** The most items the overview shows; `total` counts them all. */
export const WAITING_LIST_SHOWN = 50;

export const WaitingListItemSchema = z.strictObject({
  ref: UuidSchema,
  kinds: z.array(z.enum(WAITING_KINDS)).min(1).max(2),
  counts: z.partialRecord(z.enum(WAITING_KINDS), CountSchema),
  waitingSince: TimestampSchema,
  lastMessageAt: TimestampSchema.nullable(),
  windowEndsAt: TimestampSchema.nullable(),
  notification: z.strictObject({
    state: z.enum(WAITING_NOTIFICATION_STATES),
    at: TimestampSchema.nullable(),
  }),
});

export const WaitingListSchema = z.strictObject({
  total: CountSchema,
  items: z.array(WaitingListItemSchema).max(WAITING_LIST_SHOWN),
});

export type WaitingListItem = z.infer<typeof WaitingListItemSchema>;
export type WaitingList = z.infer<typeof WaitingListSchema>;
