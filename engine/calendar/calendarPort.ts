// The CalendarPort (Phase 3A.2): the provider-neutral boundary between the
// Company Engine and an external calendar.
//
// THE CALENDAR IS NOT AUTHORITATIVE. The Company OS's own bookings are settled
// in PostgreSQL before any calendar is asked anything, and nothing a calendar
// answers changes a booking. The port only MIRRORS a booking change: it is
// called by the worker with data only, outside any transaction, at most once
// per sync (engine/handlers/calendarSync.ts), and the database stores the
// outcome after checking it again.
//
// MINIMISED BY CONSTRUCTION. A request carries exactly a generic title the
// owner configured (by default "Atendimento"), the start and end instants, the
// IANA zone and an opaque reference (the sync's id). There is no field for a
// description, an attendee, a location, a name, a phone, an email, a note, a
// message, model output, triage text, a resource or a booking-type label:
// CalendarEventRequestSchema is strict, so an extra key is refused before a
// provider sees it.
//
// Providers: the deterministic fake (fakeCalendarProvider.ts) and the Google
// Calendar boundary (googleCalendarProvider.ts), which is NOT CONNECTED: no
// authentication or data-processing contract is approved, so it calls nothing.

import { z } from "zod";

const INSTANT = z.iso.datetime({ precision: 6 });

/** One calendar event, exactly as a provider may receive it. */
export const CalendarEventRequestSchema = z.strictObject({
  title: z
    .string()
    .min(1)
    .max(40)
    // No control characters: a title is one short, generic line.
    .regex(/^[^\p{Cc}]+$/u),
  startAt: INSTANT,
  endAt: INSTANT,
  timeZone: z.string().regex(/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/),
  reference: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
});

export type CalendarEventRequest = z.infer<typeof CalendarEventRequestSchema>;

/** A provider's event id, as the database accepts it. */
export const EXTERNAL_EVENT_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,255}$/;

export type CalendarProviderKind = "fake" | "google" | "none";

export interface CalendarCallOptions {
  readonly signal: AbortSignal;
}

export interface CalendarPort {
  /** Recorded on the sync when it starts; must match the company's connection. */
  readonly kind: CalendarProviderKind;
  /** Creates an event; resolves to the provider's event id. */
  createEvent(
    request: CalendarEventRequest,
    options: CalendarCallOptions,
  ): Promise<string>;
  /** Moves an existing event to the request's times. */
  updateEvent(
    eventId: string,
    request: CalendarEventRequest,
    options: CalendarCallOptions,
  ): Promise<void>;
  /** Cancels an existing event. */
  cancelEvent(eventId: string, options: CalendarCallOptions): Promise<void>;
}

/**
 * The provider REFUSED the request and did not act on it (a definitive
 * answer, e.g. a validation or permission refusal). The sync settles `failed`.
 * Every other failure (a timeout, an abort, a 5xx, a lost connection, an
 * unreadable answer) is AMBIGUOUS: the sync settles `indeterminate`, and
 * nothing retries it.
 */
export class CalendarRequestRejectedError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`calendar request rejected: ${code}`);
    this.name = "CalendarRequestRejectedError";
    this.code = code;
  }
}

/** The provider was NOT reached: nothing was asked. The sync settles `failed`. */
export class CalendarProviderUnavailableError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`calendar provider unavailable: ${code}`);
    this.name = "CalendarProviderUnavailableError";
    this.code = code;
  }
}

/** The port a worker has when no calendar provider is configured. */
export const UNCONFIGURED_CALENDAR_PORT: CalendarPort = Object.freeze({
  kind: "none",
  async createEvent(): Promise<string> {
    throw new CalendarProviderUnavailableError("provider_not_configured");
  },
  async updateEvent(): Promise<void> {
    throw new CalendarProviderUnavailableError("provider_not_configured");
  },
  async cancelEvent(): Promise<void> {
    throw new CalendarProviderUnavailableError("provider_not_configured");
  },
});
