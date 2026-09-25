// EventSummary (docs/PHASE_2C_BRIEF.md §9, §11): one ops.events row, with only
// the payload keys ops.cos_event_facts allows for its type.
//
// HOW THE FACTS ARE TYPED. `facts` is keyed by snake_case payload names, and
// its shape depends on `type`. A discriminated union cannot express it,
// because `type` is an open string: a migration can emit a type this contract
// has never heard of, and that event must still parse, with `{}` and
// `factsWithheld: true`. So `facts` is a union of the strict fact shapes, and a
// refinement then requires the ONE shape the event's type allows (EVENT_FACTS),
// `{}` for an unknown type, and `factsWithheld` exactly when the type is
// unknown. The result is strict per type: a `lead_triage.reviewed` event cannot
// carry an outbound id, and no event can carry a key outside its allowlist
// (`marked_by`, a body, a number) however its type is spelled.

import { z } from "zod";
import {
  ReasonCodeSchema,
  TimestampSchema,
  UuidSchema,
  cursorSchema,
  pageSchema,
  envelopedPageSchema,
  CURSOR_KINDS,
} from "./primitives.ts";
import {
  ChannelModeSchema,
  EventSourceSchema,
  EventSubjectTypeSchema,
  ReviewDecisionSchema,
} from "./vocabulary.ts";

/** The event types the migrations emit (ops.cos_event_known). */
export const KNOWN_EVENT_TYPES = [
  "company.created",
  "company.status_changed",
  "department.created",
  "department.status_changed",
  "agent.created",
  "agent.status_changed",
  "task.created",
  "task.assigned",
  "task.status_changed",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.execution_requested",
  "agent_run.requested",
  "agent_run.started",
  "agent_run.succeeded",
  "agent_run.failed",
  "agent_run.indeterminate",
  "agent_run.cancelled",
  "lead_triage.admitted",
  "lead_triage.review_pending",
  "lead_triage.reviewed",
  "communication.received",
  "communication.inbound_refused",
  "communication.inbound_held",
  "communication.channel_configured",
  "communication.outbound_authorized",
  "communication.outbound_attempted",
  "communication.outbound_blocked",
  "communication.outbound_sent",
  "communication.outbound_failed",
  "communication.outbound_indeterminate",
  "communication.delivery_updated",
  "follow_up.scheduled",
  "follow_up.due",
  "follow_up.completed",
  "follow_up.cancelled",
  "follow_up.superseded",
  "booking.created",
  "booking.rescheduled",
  "booking.cancelled",
  "calendar.sync_requested",
  "calendar.sync_completed",
  "calendar.sync_failed",
  "calendar.sync_indeterminate",
  "calendar.sync_skipped",
] as const;

export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];

export const isKnownEventType = (type: string): type is KnownEventType =>
  (KNOWN_EVENT_TYPES as readonly string[]).includes(type);

/** ops.events.type: dotted, at least two segments. */
export const EventTypeSchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

/** A status name as a payload carries it; anything else leaves as null. */
const StatusNameSchema = z.string().regex(/^[a-z_]{1,32}$/);

export const NoFactsSchema = z.strictObject({});

export const StatusChangeFactsSchema = z.strictObject({
  from_status: StatusNameSchema.nullable(),
  to_status: StatusNameSchema.nullable(),
});

export const ReviewedFactsSchema = z.strictObject({
  decision: ReviewDecisionSchema.nullable(),
});

export const InboundRefusalFactsSchema = z.strictObject({
  channel_id: UuidSchema.nullable(),
  reason: ReasonCodeSchema.nullable(),
});

export const ChannelConfiguredFactsSchema = z.strictObject({
  channel_id: UuidSchema.nullable(),
  mode: ChannelModeSchema.nullable(),
  active: z.boolean().nullable(),
});

export const OutboundAuthorizedFactsSchema = z.strictObject({
  outbound_message_id: UuidSchema.nullable(),
  review_item_id: UuidSchema.nullable(),
});

export const OutboundBlockedFactsSchema = z.strictObject({
  outbound_message_id: UuidSchema.nullable(),
  reason: ReasonCodeSchema.nullable(),
});

export const OutboundFactsSchema = z.strictObject({
  outbound_message_id: UuidSchema.nullable(),
});

export const DeliveryUpdatedFactsSchema = z.strictObject({
  outbound_message_id: UuidSchema.nullable(),
  status: StatusNameSchema.nullable(),
  previous: StatusNameSchema.nullable(),
});

/** Phase 3A: a follow-up's step, and why it was cancelled (null otherwise). */
export const FollowUpFactsSchema = z.strictObject({
  step: z.number().int().min(0).max(99).nullable(),
  reason: ReasonCodeSchema.nullable(),
});

export const BookingCancelledFactsSchema = z.strictObject({
  reason: ReasonCodeSchema.nullable(),
});

/** Phase 3A.2: the calendar operation, and why it ended without success. */
export const CalendarSyncFactsSchema = z.strictObject({
  operation: z.enum(["create", "update", "cancel"]).nullable(),
  error_code: ReasonCodeSchema.nullable(),
});

/** The one facts shape each known type may carry (ops.cos_event_facts). */
export const EVENT_FACTS: { readonly [T in KnownEventType]: z.ZodType } = {
  "company.created": NoFactsSchema,
  "company.status_changed": StatusChangeFactsSchema,
  "department.created": NoFactsSchema,
  "department.status_changed": StatusChangeFactsSchema,
  "agent.created": NoFactsSchema,
  "agent.status_changed": StatusChangeFactsSchema,
  "task.created": NoFactsSchema,
  "task.assigned": StatusChangeFactsSchema,
  "task.status_changed": StatusChangeFactsSchema,
  "task.completed": StatusChangeFactsSchema,
  "task.failed": StatusChangeFactsSchema,
  "task.cancelled": StatusChangeFactsSchema,
  "task.execution_requested": NoFactsSchema,
  "agent_run.requested": NoFactsSchema,
  "agent_run.started": StatusChangeFactsSchema,
  "agent_run.succeeded": StatusChangeFactsSchema,
  "agent_run.failed": StatusChangeFactsSchema,
  "agent_run.indeterminate": StatusChangeFactsSchema,
  "agent_run.cancelled": StatusChangeFactsSchema,
  "lead_triage.admitted": NoFactsSchema,
  "lead_triage.review_pending": NoFactsSchema,
  "lead_triage.reviewed": ReviewedFactsSchema,
  "communication.received": NoFactsSchema,
  "communication.inbound_refused": InboundRefusalFactsSchema,
  "communication.inbound_held": InboundRefusalFactsSchema,
  "communication.channel_configured": ChannelConfiguredFactsSchema,
  "communication.outbound_authorized": OutboundAuthorizedFactsSchema,
  "communication.outbound_attempted": OutboundFactsSchema,
  "communication.outbound_blocked": OutboundBlockedFactsSchema,
  "communication.outbound_sent": OutboundFactsSchema,
  "communication.outbound_failed": OutboundFactsSchema,
  "communication.outbound_indeterminate": OutboundFactsSchema,
  "communication.delivery_updated": DeliveryUpdatedFactsSchema,
  "follow_up.scheduled": FollowUpFactsSchema,
  "follow_up.due": FollowUpFactsSchema,
  "follow_up.completed": FollowUpFactsSchema,
  "follow_up.cancelled": FollowUpFactsSchema,
  "follow_up.superseded": FollowUpFactsSchema,
  "booking.created": NoFactsSchema,
  "booking.rescheduled": NoFactsSchema,
  "booking.cancelled": BookingCancelledFactsSchema,
  "calendar.sync_requested": CalendarSyncFactsSchema,
  "calendar.sync_completed": CalendarSyncFactsSchema,
  "calendar.sync_failed": CalendarSyncFactsSchema,
  "calendar.sync_indeterminate": CalendarSyncFactsSchema,
  "calendar.sync_skipped": CalendarSyncFactsSchema,
};

const EventFactsSchema = z.union([
  NoFactsSchema,
  StatusChangeFactsSchema,
  ReviewedFactsSchema,
  InboundRefusalFactsSchema,
  ChannelConfiguredFactsSchema,
  OutboundAuthorizedFactsSchema,
  OutboundBlockedFactsSchema,
  OutboundFactsSchema,
  DeliveryUpdatedFactsSchema,
  FollowUpFactsSchema,
  BookingCancelledFactsSchema,
  CalendarSyncFactsSchema,
]);

export const EventSummarySchema = z
  .strictObject({
    id: UuidSchema,
    type: EventTypeSchema,
    source: EventSourceSchema,
    subjectType: EventSubjectTypeSchema.nullable(),
    subjectId: UuidSchema.nullable(),
    causationId: UuidSchema.nullable(),
    createdAt: TimestampSchema,
    facts: EventFactsSchema,
    factsWithheld: z.boolean(),
  })
  .superRefine((event, ctx) => {
    const known = isKnownEventType(event.type);
    if (event.factsWithheld === known) {
      ctx.addIssue({
        code: "custom",
        path: ["factsWithheld"],
        message: "factsWithheld must be true exactly for an unknown type",
      });
    }
    const allowed = known
      ? EVENT_FACTS[event.type as KnownEventType]
      : NoFactsSchema;
    if (!allowed.safeParse(event.facts).success) {
      ctx.addIssue({
        code: "custom",
        path: ["facts"],
        message: "facts do not match the allowlist of the event's type",
      });
    }
    if (event.subjectType === null && event.subjectId !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["subjectId"],
        message: "an event with no subject type names no subject",
      });
    }
  });

/** The task's first page inside TaskDetail: `{ items, nextCursor }`. */
export const EventPageSchema = pageSchema(
  CURSOR_KINDS.events,
  EventSummarySchema,
);

/** list_events. */
export const EventListSchema = envelopedPageSchema(
  CURSOR_KINDS.events,
  EventSummarySchema,
);

export const EventCursorSchema = cursorSchema(CURSOR_KINDS.events);

export type EventSummary = z.infer<typeof EventSummarySchema>;
export type EventList = z.infer<typeof EventListSchema>;
