// The Google Calendar boundary (Phase 3A.2): NOT CONNECTED.
//
// No authentication model is approved for this repository: no OAuth client,
// consent screen or redirect, no service account or domain-wide delegation, no
// rule for storing or encrypting a refresh token, and no data-processing
// contract for sending appointment times of a psychology clinic's patients to
// Google (LGPD). None is invented here. This adapter has the port's shape and
// its own kind, and every call fails as "not reached" before any network or
// credential is touched. The database cannot even configure a Google
// connection: ops.calendar_connections' provider gate admits only `fake`.
//
// What connecting it needs is recorded in docs/PHASE_3A_REPORT.md
// ("Google Calendar: what is missing"). The call would then go through the
// governed external call this job kind already runs under: the lease, the
// kill switch before the call, running recorded first, at most once, an
// ambiguous answer indeterminate, and the minimised request.

import {
  CalendarProviderUnavailableError,
  type CalendarPort,
} from "./calendarPort.ts";

export const GOOGLE_CALENDAR_NOT_CONNECTED = "google_calendar_not_connected";

export function createGoogleCalendarProvider(): CalendarPort {
  return Object.freeze({
    kind: "google",
    async createEvent(): Promise<string> {
      throw new CalendarProviderUnavailableError(GOOGLE_CALENDAR_NOT_CONNECTED);
    },
    async updateEvent(): Promise<void> {
      throw new CalendarProviderUnavailableError(GOOGLE_CALENDAR_NOT_CONNECTED);
    },
    async cancelEvent(): Promise<void> {
      throw new CalendarProviderUnavailableError(GOOGLE_CALENDAR_NOT_CONNECTED);
    },
  });
}
