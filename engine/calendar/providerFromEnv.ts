// Which CalendarPort a worker runs with, from CALENDAR_PROVIDER. Backend only
// (never VITE_). Mirroring bookings to a calendar is opt-in per worker:
//
//   unset   -> none: a queued calendar job settles `failed`,
//              provider_not_configured, without calling anything;
//   fake    -> the deterministic fake provider (tests, synthetic demo);
//   google  -> the Google Calendar boundary, which is NOT CONNECTED and calls
//              nothing (and the database cannot configure a Google connection).
//
// Anything else refuses to start: a misspelt provider is not "off".

import {
  UNCONFIGURED_CALENDAR_PORT,
  type CalendarPort,
} from "./calendarPort.ts";
import { createFakeCalendarProvider } from "./fakeCalendarProvider.ts";
import { createGoogleCalendarProvider } from "./googleCalendarProvider.ts";

export function calendarPortFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): CalendarPort {
  const raw = env.CALENDAR_PROVIDER;
  if (raw === undefined || raw === "") return UNCONFIGURED_CALENDAR_PORT;
  if (raw === "fake") return createFakeCalendarProvider();
  if (raw === "google") return createGoogleCalendarProvider();
  throw new Error(
    'CALENDAR_PROVIDER must be unset, "fake" or "google"; refusing to start',
  );
}
