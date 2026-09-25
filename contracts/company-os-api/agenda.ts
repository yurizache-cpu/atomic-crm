// The Agenda (Phase 3A): the overview's read-only scheduling section, built
// by ops.cos_agenda from authoritative rows (supabase/migrations/
// 20260928150000_agenda_read_model.sql).
//
// Deterministic in its rows and the overview's instant: every window is keyed
// on an appointment's start or a follow-up's due time in the tenant's
// scheduling zone. The browser partitions nothing and does no scheduling
// arithmetic; it formats what the server decided.
//
// Minimised: ids of the tenant's own rows, instants, states, reason codes and
// the owner's configuration labels. No subject reference, name, phone, email,
// message, actor label, idempotency key, provider event id or error text has a
// key here, and every object is strict.

import { z } from "zod";
import {
  CountSchema,
  NameSchema,
  ReasonCodeSchema,
  SlugSchema,
  TimestampSchema,
  UuidSchema,
} from "./primitives.ts";

export const BOOKING_STATUSES = ["booked", "cancelled", "rescheduled"] as const;
export const FOLLOW_UP_STATUSES = [
  "scheduled",
  "due",
  "completed",
  "cancelled",
  "superseded",
] as const;
export const CALENDAR_SYNC_STATUSES = [
  "pending",
  "running",
  "synced",
  "failed",
  "indeterminate",
  "skipped",
] as const;
/** Only the deterministic fake can be connected: real Google is not. */
export const CALENDAR_STATES = ["local_only", "simulated"] as const;

export const BookingStatusSchema = z.enum(BOOKING_STATUSES);
export const FollowUpStatusSchema = z.enum(FOLLOW_UP_STATUSES);
export const CalendarSyncStatusSchema = z.enum(CALENDAR_SYNC_STATUSES);

/** An IANA zone name, as the database accepts one. */
export const TimeZoneSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/);

const LabelledRefSchema = z.strictObject({ id: UuidSchema, label: NameSchema });

const before = (a: string, b: string) => Date.parse(a) < Date.parse(b);

export const BookingSummarySchema = z
  .strictObject({
    id: UuidSchema,
    startAt: TimestampSchema,
    endAt: TimestampSchema,
    timezone: TimeZoneSchema,
    status: BookingStatusSchema,
    resource: LabelledRefSchema,
    bookingType: LabelledRefSchema,
    rescheduledFromId: UuidSchema.nullable(),
    rescheduledTo: z
      .strictObject({ id: UuidSchema, startAt: TimestampSchema })
      .nullable(),
    cancelReason: ReasonCodeSchema.nullable(),
    taskId: UuidSchema.nullable(),
    calendarSync: CalendarSyncStatusSchema.nullable(),
  })
  .refine((b) => before(b.startAt, b.endAt), {
    message: "a booking ends after it starts",
  })
  .refine((b) => (b.cancelReason !== null) === (b.status === "cancelled"), {
    message: "a cancel reason exists exactly for a cancelled booking",
  })
  .refine(
    (b) => b.rescheduledTo === null || b.status === "rescheduled",
    "only a rescheduled booking has a successor",
  );

export const FollowUpSummarySchema = z
  .strictObject({
    id: UuidSchema,
    planId: UuidSchema,
    step: z.int().min(1).max(12),
    stepCount: z.int().min(1).max(12),
    dueAt: TimestampSchema,
    status: FollowUpStatusSchema,
    awaitingProcessing: z.boolean(),
    policy: z.strictObject({ key: SlugSchema, label: NameSchema }),
    taskId: UuidSchema.nullable(),
    closeReason: ReasonCodeSchema.nullable(),
  })
  .refine((f) => f.step <= f.stepCount, "a step is one of its cadence")
  .refine(
    (f) => !f.awaitingProcessing || f.status === "scheduled",
    "only a scheduled follow-up can await processing",
  );

export const AvailabilityPairSchema = z.strictObject({
  resource: LabelledRefSchema,
  bookingType: z.strictObject({
    id: UuidSchema,
    label: NameSchema,
    durationMinutes: z.int().min(5).max(720),
  }),
  nextSlots: z
    .array(z.strictObject({ startAt: TimestampSchema, endAt: TimestampSchema }))
    .max(5),
});

const everyStatus =
  <T extends { status: string }>(allowed: readonly string[]) =>
  (items: readonly T[]) =>
    items.every((item) => allowed.includes(item.status));

export const AgendaSchema = z.strictObject({
  timezone: TimeZoneSchema,
  timezoneConfigured: z.boolean(),
  /** The tenant's local date at the overview's instant, YYYY-MM-DD. */
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bookings: z.strictObject({
    todayBooked: CountSchema,
    next7DaysBooked: CountSchema,
    cancelledInWindow: CountSchema,
    rescheduledInWindow: CountSchema,
    // Overlapping booked bookings: the database forbids them, so always 0.
    conflicts: CountSchema,
    today: z.array(BookingSummarySchema).max(50),
    upcoming: z
      .array(BookingSummarySchema)
      .max(50)
      .refine(everyStatus(["booked"]), "upcoming lists booked bookings"),
    changes: z
      .array(BookingSummarySchema)
      .max(20)
      .refine(
        everyStatus(["cancelled", "rescheduled"]),
        "changes lists cancelled and rescheduled bookings",
      ),
  }),
  followUps: z
    .strictObject({
      due: CountSchema,
      overdue: CountSchema,
      dueToday: CountSchema,
      awaitingProcessing: CountSchema,
      scheduledNext7Days: CountSchema,
      closedRecently: CountSchema,
      needingAction: z
        .array(FollowUpSummarySchema)
        .max(50)
        .refine(everyStatus(["due"]), "needing action lists due follow-ups"),
      scheduled: z
        .array(FollowUpSummarySchema)
        .max(50)
        .refine(everyStatus(["scheduled"]), "scheduled lists scheduled ones"),
      recentlyClosed: z
        .array(FollowUpSummarySchema)
        .max(20)
        .refine(
          everyStatus(["completed", "cancelled"]),
          "recently closed lists completed and cancelled ones",
        ),
    })
    .refine((f) => f.overdue <= f.due, "an overdue follow-up is a due one"),
  availability: z.array(AvailabilityPairSchema).max(10),
  calendar: z.strictObject({
    state: z.enum(CALENDAR_STATES),
    upcomingSyncs: z.strictObject({
      pending: CountSchema,
      running: CountSchema,
      synced: CountSchema,
      failed: CountSchema,
      indeterminate: CountSchema,
      skipped: CountSchema,
    }),
  }),
});

export type Agenda = z.infer<typeof AgendaSchema>;
export type BookingSummary = z.infer<typeof BookingSummarySchema>;
export type FollowUpSummary = z.infer<typeof FollowUpSummarySchema>;
export type AvailabilityPair = z.infer<typeof AvailabilityPairSchema>;
