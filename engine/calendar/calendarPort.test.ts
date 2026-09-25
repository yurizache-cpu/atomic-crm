// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CalendarEventRequestSchema,
  CalendarProviderUnavailableError,
  CalendarRequestRejectedError,
  UNCONFIGURED_CALENDAR_PORT,
  type CalendarEventRequest,
} from "./calendarPort.ts";
import {
  createFakeCalendarProvider,
  fakeEventId,
} from "./fakeCalendarProvider.ts";
import {
  createGoogleCalendarProvider,
  GOOGLE_CALENDAR_NOT_CONNECTED,
} from "./googleCalendarProvider.ts";
import { calendarPortFromEnv } from "./providerFromEnv.ts";

// The CalendarPort contract (Phase 3A.2): what a provider may receive, how the
// deterministic fake answers, and that the Google boundary reaches nothing.
// engine/domain/calendarSync.dbtest.ts proves the same port through the real
// worker runtime and database.

const REQUEST: CalendarEventRequest = Object.freeze({
  title: "Atendimento",
  startAt: "2026-10-05T12:00:00.000000Z",
  endAt: "2026-10-05T12:50:00.000000Z",
  timeZone: "America/Sao_Paulo",
  reference: "3f0b8c2e-1d4a-4c6b-9e2f-7a8b9c0d1e2f",
});

const signal = () => new AbortController().signal;

describe("a calendar request is minimised by its schema", () => {
  it("accepts exactly a title, two instants, a zone and an opaque reference", () => {
    expect(CalendarEventRequestSchema.parse(REQUEST)).toEqual(REQUEST);
  });

  it("refuses any other field a provider could carry content in", () => {
    for (const extra of [
      { description: "Primeira consulta de ansiedade" },
      { attendees: ["paciente@example.test"] },
      { location: "Consultório 2" },
      { summary: "Atendimento" },
      { notes: "texto clínico" },
    ]) {
      expect(
        CalendarEventRequestSchema.safeParse({ ...REQUEST, ...extra }).success,
      ).toBe(false);
    }
  });

  it("refuses a long or multi-line title and a non-uuid reference", () => {
    for (const bad of [
      { title: "x".repeat(41) },
      { title: "Atendimento\nnome do paciente" },
      { title: "" },
      { reference: "lead:SYN-0001" },
      { startAt: "2026-10-05 09:00" },
    ]) {
      expect(
        CalendarEventRequestSchema.safeParse({ ...REQUEST, ...bad }).success,
      ).toBe(false);
    }
  });
});

describe("the deterministic fake provider", () => {
  it("names an event after the reference, deterministically, and not as the reference itself", async () => {
    const fake = createFakeCalendarProvider();
    const id = await fake.createEvent(REQUEST, { signal: signal() });
    expect(id).toBe(fakeEventId(REQUEST.reference));
    expect(id).not.toContain(REQUEST.reference);
    expect(fakeEventId(REQUEST.reference)).toBe(id);
    expect(fake.events.get(id)).toEqual(REQUEST);
  });

  it("moves and cancels an event it holds, and refuses one it does not", async () => {
    const fake = createFakeCalendarProvider();
    const id = await fake.createEvent(REQUEST, { signal: signal() });
    const moved = { ...REQUEST, startAt: "2026-10-05T14:00:00.000000Z" };
    await fake.updateEvent(id, moved, { signal: signal() });
    expect(fake.events.get(id)).toEqual(moved);
    await fake.cancelEvent(id, { signal: signal() });
    expect(fake.events.size).toBe(0);
    await expect(
      fake.updateEvent("fake-unknown", moved, { signal: signal() }),
    ).rejects.toBeInstanceOf(CalendarRequestRejectedError);
    expect(fake.calls.map((c) => c.operation)).toEqual([
      "create",
      "update",
      "cancel",
      "update",
    ]);
  });

  it("follows its script: a refusal, a server error, and a timeout that ends only with its signal", async () => {
    const outcomes = ["rejected", "server_error", "timeout"] as const;
    let next = 0;
    const fake = createFakeCalendarProvider({
      script: () => outcomes[next++],
    });
    await expect(
      fake.createEvent(REQUEST, { signal: signal() }),
    ).rejects.toBeInstanceOf(CalendarRequestRejectedError);
    await expect(
      fake.createEvent(REQUEST, { signal: signal() }),
    ).rejects.toThrow("server error");
    const controller = new AbortController();
    const hanging = fake.createEvent(REQUEST, { signal: controller.signal });
    controller.abort(new DOMException("deadline", "TimeoutError"));
    await expect(hanging).rejects.toMatchObject({ name: "TimeoutError" });
    // No event exists for a call that did not succeed.
    expect(fake.events.size).toBe(0);
  });
});

describe("the Google Calendar boundary is not connected", () => {
  it("fails every call as not reached, before any network or credential", async () => {
    const google = createGoogleCalendarProvider();
    expect(google.kind).toBe("google");
    for (const call of [
      () => google.createEvent(REQUEST, { signal: signal() }),
      () => google.updateEvent("x", REQUEST, { signal: signal() }),
      () => google.cancelEvent("x", { signal: signal() }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        name: "CalendarProviderUnavailableError",
        code: GOOGLE_CALENDAR_NOT_CONNECTED,
      });
    }
  });

  it("has no unconfigured provider that calls anything either", async () => {
    await expect(
      UNCONFIGURED_CALENDAR_PORT.createEvent(REQUEST, { signal: signal() }),
    ).rejects.toBeInstanceOf(CalendarProviderUnavailableError);
  });
});

describe("a worker's calendar provider comes from CALENDAR_PROVIDER", () => {
  it("is off when unset, the fake or the unconnected Google boundary when named, and refuses anything else", () => {
    expect(calendarPortFromEnv({}).kind).toBe("none");
    expect(calendarPortFromEnv({ CALENDAR_PROVIDER: "" }).kind).toBe("none");
    expect(calendarPortFromEnv({ CALENDAR_PROVIDER: "fake" }).kind).toBe(
      "fake",
    );
    expect(calendarPortFromEnv({ CALENDAR_PROVIDER: "google" }).kind).toBe(
      "google",
    );
    for (const value of ["Fake", "gcal", "true", "outlook"]) {
      expect(() => calendarPortFromEnv({ CALENDAR_PROVIDER: value })).toThrow(
        "refusing to start",
      );
    }
  });
});
