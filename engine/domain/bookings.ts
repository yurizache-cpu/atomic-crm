// Phase 3A.2: the booking foundation's owner services and reads, over the
// functions of supabase/migrations/20260928130000_booking_foundation.sql.
//
// Everything here runs on the OWNER connection (the scheduling CLI, the
// synthetic demo, the driver-backed tests). No application role can execute
// these functions, and the browser has no counterpart: it only reads the
// Agenda projection, so it cannot book, reschedule or cancel.
//
// TIME. An authoritative instant is a JavaScript Date, sent as an ISO 8601
// instant; a local clock time exists only inside an availability rule,
// always with its IANA zone. Nothing here does calendar arithmetic: the
// database derives every end, buffer, occupied range and offered slot.

import type { TxClient } from "../db/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";
import {
  callResult,
  contextParams,
  optionalUuid,
  requireIdempotencyKey,
  requireReasonCode,
  requireUuid,
  statusToken,
  type SchedulingContext,
} from "./schedulingCommon.ts";

export type BookingStatus = "booked" | "cancelled" | "rescheduled";

export const BOOKING_STATUSES: readonly BookingStatus[] = Object.freeze([
  "booked",
  "cancelled",
  "rescheduled",
]);

/** ops.booking_status_transitions(), mirrored; a driver-backed test compares them. */
export const BOOKING_STATUS_TRANSITIONS: readonly (readonly [
  BookingStatus,
  BookingStatus,
])[] = Object.freeze([
  ["booked", "cancelled"],
  ["booked", "rescheduled"],
]);

/** The widest range ops.available_slots answers, and the most slots. */
export const MAX_SLOT_RANGE_DAYS = 31;
export const MAX_SLOTS = 500;

const LOCAL_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const LOCAL_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

export interface BookingResourceInput {
  readonly companyId: string;
  readonly departmentId: string;
  readonly key: string;
  readonly label: string;
  /** Tenant vocabulary, snake_case: professional, room, ... */
  readonly kind: string;
}

export interface BookingTypeInput {
  readonly companyId: string;
  readonly key: string;
  readonly label: string;
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  readonly slotStepMinutes: number;
}

export interface AvailabilityRuleInput {
  readonly resourceId: string;
  /** ISO weekday: 1 Monday .. 7 Sunday. */
  readonly weekday: number;
  /** Local wall-clock time, HH:MM, in `timezone`. */
  readonly localStart: string;
  readonly localEnd: string;
  /** An IANA zone name, e.g. America/Sao_Paulo. */
  readonly timezone: string;
  /** Local dates, YYYY-MM-DD, inclusive. */
  readonly effectiveFrom: string;
  readonly effectiveUntil?: string;
}

/** Who a booking is for: at least one; never a name, number or message. */
export interface BookingSubject {
  readonly taskId?: string;
  readonly conversationId?: string;
  readonly subjectRef?: string;
}

export interface CreateBookingInput {
  readonly resourceId: string;
  readonly bookingTypeId: string;
  readonly startAt: Date;
  readonly subject: BookingSubject;
  readonly idempotencyKey: string;
}

export interface BookingResult {
  readonly bookingId: string;
  /** False when this idempotency key already made this booking. */
  readonly created: boolean;
}

export interface RescheduleResult extends BookingResult {
  readonly rescheduledFromId: string;
}

export type CancelBookingOutcome = "cancelled" | "already_cancelled";

export interface Slot {
  readonly startAt: string;
  readonly endAt: string;
}

const requireInstant = (value: unknown, field: string): string => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new CompanyOsError("invalid_argument", `${field} is not an instant`);
  }
  return value.toISOString();
};

const asRecord = (value: unknown, fn: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${fn} answered outside its contract`);
  }
  return value as Record<string, unknown>;
};

const asId = (value: unknown, fn: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${fn} answered outside its contract`);
  }
  return value;
};

export async function setSchedulingTimezone(
  tx: TxClient,
  context: SchedulingContext,
  timezone: string,
): Promise<void> {
  const [tenantId, actor] = contextParams(context);
  await callResult(
    tx,
    "select ops.set_scheduling_timezone($1, $2, $3) as result",
    [tenantId, timezone, actor],
  );
}

export async function defineBookingResource(
  tx: TxClient,
  context: SchedulingContext,
  input: BookingResourceInput,
): Promise<string> {
  const [tenantId, actor] = contextParams(context);
  return asId(
    await callResult(
      tx,
      "select ops.define_booking_resource($1, $2, $3, $4, $5, $6, $7) as result",
      [
        tenantId,
        requireUuid(input.companyId, "companyId"),
        requireUuid(input.departmentId, "departmentId"),
        input.key,
        input.label,
        input.kind,
        actor,
      ],
    ),
    "ops.define_booking_resource",
  );
}

export async function defineBookingType(
  tx: TxClient,
  context: SchedulingContext,
  input: BookingTypeInput,
): Promise<string> {
  const [tenantId, actor] = contextParams(context);
  return asId(
    await callResult(
      tx,
      "select ops.define_booking_type($1, $2, $3, $4, $5, $6, $7, $8, $9) as result",
      [
        tenantId,
        requireUuid(input.companyId, "companyId"),
        input.key,
        input.label,
        input.durationMinutes,
        input.bufferBeforeMinutes,
        input.bufferAfterMinutes,
        input.slotStepMinutes,
        actor,
      ],
    ),
    "ops.define_booking_type",
  );
}

export async function addAvailabilityRule(
  tx: TxClient,
  context: SchedulingContext,
  input: AvailabilityRuleInput,
): Promise<string> {
  const [tenantId, actor] = contextParams(context);
  for (const [field, value] of [
    ["localStart", input.localStart],
    ["localEnd", input.localEnd],
  ] as const) {
    if (!LOCAL_TIME.test(value)) {
      throw new CompanyOsError("invalid_argument", `${field} is not HH:MM`);
    }
  }
  for (const [field, value] of [
    ["effectiveFrom", input.effectiveFrom],
    ["effectiveUntil", input.effectiveUntil],
  ] as const) {
    if (value !== undefined && !LOCAL_DATE.test(value)) {
      throw new CompanyOsError(
        "invalid_argument",
        `${field} is not YYYY-MM-DD`,
      );
    }
  }
  return asId(
    await callResult(
      tx,
      "select ops.add_availability_rule($1, $2, $3, $4::time, $5::time, $6, $7::date, $8::date, $9) as result",
      [
        tenantId,
        requireUuid(input.resourceId, "resourceId"),
        input.weekday,
        input.localStart,
        input.localEnd,
        input.timezone,
        input.effectiveFrom,
        input.effectiveUntil ?? null,
        actor,
      ],
    ),
    "ops.add_availability_rule",
  );
}

/** The offered start times in [from, until): at most 31 days and 500 slots. */
export async function availableSlots(
  tx: TxClient,
  tenantId: string,
  query: {
    readonly resourceId: string;
    readonly bookingTypeId: string;
    readonly from: Date;
    readonly until: Date;
    readonly limit?: number;
  },
): Promise<Slot[]> {
  const params = [
    requireUuid(tenantId, "tenantId"),
    requireUuid(query.resourceId, "resourceId"),
    requireUuid(query.bookingTypeId, "bookingTypeId"),
    requireInstant(query.from, "from"),
    requireInstant(query.until, "until"),
    query.limit ?? 100,
  ];
  try {
    const { rows } = await tx.query<{ start_at: Date; end_at: Date }>(
      "select start_at, end_at from ops.available_slots($1, $2, $3, $4, $5, $6)",
      params,
    );
    return rows.map((row) => ({
      startAt: new Date(row.start_at).toISOString(),
      endAt: new Date(row.end_at).toISOString(),
    }));
  } catch (error) {
    throw toDomainError(error);
  }
}

export async function createBooking(
  tx: TxClient,
  context: SchedulingContext,
  input: CreateBookingInput,
): Promise<BookingResult> {
  const [tenantId, actor, source] = contextParams(context);
  const result = asRecord(
    await callResult(
      tx,
      "select ops.create_booking($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as result",
      [
        tenantId,
        requireUuid(input.resourceId, "resourceId"),
        requireUuid(input.bookingTypeId, "bookingTypeId"),
        requireInstant(input.startAt, "startAt"),
        optionalUuid(input.subject.taskId, "taskId"),
        optionalUuid(input.subject.conversationId, "conversationId"),
        input.subject.subjectRef ?? null,
        requireIdempotencyKey(input.idempotencyKey),
        actor,
        source,
      ],
    ),
    "ops.create_booking",
  );
  return {
    bookingId: asId(result.booking_id, "ops.create_booking"),
    created: result.created === true,
  };
}

/** Moves a booked booking to a new start, atomically; the same key replays. */
export async function rescheduleBooking(
  tx: TxClient,
  context: SchedulingContext,
  bookingId: string,
  newStartAt: Date,
  idempotencyKey: string,
): Promise<RescheduleResult> {
  const [tenantId, actor, source] = contextParams(context);
  const result = asRecord(
    await callResult(
      tx,
      "select ops.reschedule_booking($1, $2, $3, $4, $5, $6) as result",
      [
        tenantId,
        requireUuid(bookingId, "bookingId"),
        requireInstant(newStartAt, "newStartAt"),
        requireIdempotencyKey(idempotencyKey),
        actor,
        source,
      ],
    ),
    "ops.reschedule_booking",
  );
  return {
    bookingId: asId(result.booking_id, "ops.reschedule_booking"),
    rescheduledFromId: asId(
      result.rescheduled_from_id,
      "ops.reschedule_booking",
    ),
    created: result.created === true,
  };
}

/** Cancels a booked booking with a reason code, freeing its time. A repeat is harmless. */
export async function cancelBooking(
  tx: TxClient,
  context: SchedulingContext,
  bookingId: string,
  reason: string,
): Promise<CancelBookingOutcome> {
  const [tenantId, actor, source] = contextParams(context);
  return statusToken(
    await callResult(
      tx,
      "select ops.cancel_booking($1, $2, $3, $4, $5) as result",
      [
        tenantId,
        requireUuid(bookingId, "bookingId"),
        requireReasonCode(reason),
        actor,
        source,
      ],
    ),
    ["cancelled", "already_cancelled"] as const,
    "ops.cancel_booking",
  );
}

/** One booking as the operator's list shows it: ids, instants and states only. */
export interface BookingRow {
  readonly id: string;
  readonly tenantId: string;
  readonly resourceId: string;
  readonly bookingTypeId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly timezone: string;
  readonly status: BookingStatus;
  readonly rescheduledFromId: string | null;
  readonly taskId: string | null;
  readonly cancelReason: string | null;
}

export const MAX_LISTED_BOOKINGS = 200;

/**
 * Bookings by start time from `from` (default: now), soonest first. No subject
 * reference, actor label or configuration label is read.
 */
export async function listBookings(
  tx: TxClient,
  options: {
    readonly tenantId?: string;
    readonly status?: BookingStatus;
    readonly from?: Date;
    readonly limit?: number;
  } = {},
): Promise<BookingRow[]> {
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? 50), 1),
    MAX_LISTED_BOOKINGS,
  );
  const { rows } = await tx.query<{
    id: string;
    tenant_id: string;
    resource_id: string;
    booking_type_id: string;
    start_at: Date;
    end_at: Date;
    timezone: string;
    status: BookingStatus;
    rescheduled_from_id: string | null;
    task_id: string | null;
    cancel_reason: string | null;
  }>(
    `select b.id, b.tenant_id, b.resource_id, b.booking_type_id, b.start_at, b.end_at, b.timezone,
            b.status, b.rescheduled_from_id, b.task_id, b.cancel_reason
       from ops.bookings b
      where ($1::uuid is null or b.tenant_id = $1::uuid)
        and ($2::text is null or b.status = $2::text)
        and b.start_at >= coalesce($3::timestamptz, now())
      order by b.start_at, b.id
      limit $4`,
    [
      optionalUuid(options.tenantId, "tenantId"),
      options.status ?? null,
      options.from ? requireInstant(options.from, "from") : null,
      limit,
    ],
  );
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    resourceId: row.resource_id,
    bookingTypeId: row.booking_type_id,
    startAt: new Date(row.start_at).toISOString(),
    endAt: new Date(row.end_at).toISOString(),
    timezone: row.timezone,
    status: row.status,
    rescheduledFromId: row.rescheduled_from_id,
    taskId: row.task_id,
    cancelReason: row.cancel_reason,
  }));
}
