// The deterministic calendar provider (Phase 3A.2), for the tests and the
// synthetic owner demo. It is not a calendar: it keeps the events it was asked
// to create in memory, names each after the request's opaque reference, and
// never opens a socket. The Company OS shows a fake connection as "Simulado".
//
// A script decides each call's outcome, so the tests and the demo can make a
// call succeed, be refused, time out or fail ambiguously on purpose:
//   ok            the call succeeds;
//   rejected      the provider refuses and did not act (the sync fails);
//   timeout       the call never answers until its signal aborts (ambiguous);
//   server_error  the provider answers a 5xx-like error (ambiguous).
// The two ambiguous outcomes may have acted: the sync settles indeterminate,
// and nothing asks again.

import { createHash } from "node:crypto";
import {
  CalendarRequestRejectedError,
  type CalendarCallOptions,
  type CalendarEventRequest,
  type CalendarPort,
} from "./calendarPort.ts";

export type FakeCalendarOutcome =
  | "ok"
  | "rejected"
  | "timeout"
  | "server_error";

export type FakeCalendarOperation = "create" | "update" | "cancel";

export interface FakeCalendarCall {
  readonly operation: FakeCalendarOperation;
  readonly eventId: string | null;
  /** The request exactly as the provider received it; null for a cancel. */
  readonly request: CalendarEventRequest | null;
}

export interface FakeCalendarProvider extends CalendarPort {
  /** Every call made, in order: what a real provider would have received. */
  readonly calls: readonly FakeCalendarCall[];
  /** The events that exist, by id, after the calls that succeeded. */
  readonly events: ReadonlyMap<string, CalendarEventRequest>;
}

export interface FakeCalendarOptions {
  /** Decides each call's outcome. Default: every call succeeds. */
  readonly script?: (call: FakeCalendarCall) => FakeCalendarOutcome;
}

/** The fake's event id for a reference: stable, and not the reference itself. */
export const fakeEventId = (reference: string): string =>
  "fake-" + createHash("sha256").update(reference).digest("hex").slice(0, 24);

class FakeCalendarServerError extends Error {
  constructor() {
    super("fake calendar: server error");
    this.name = "FakeCalendarServerError";
  }
}

/** Resolves never, rejecting when the signal aborts: a call that times out. */
const hang = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    const abort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });

export function createFakeCalendarProvider(
  options: FakeCalendarOptions = {},
): FakeCalendarProvider {
  const calls: FakeCalendarCall[] = [];
  const events = new Map<string, CalendarEventRequest>();
  const script = options.script ?? (() => "ok");

  async function answer(
    call: FakeCalendarCall,
    { signal }: CalendarCallOptions,
  ): Promise<void> {
    calls.push(call);
    const outcome = script(call);
    if (outcome === "rejected") {
      throw new CalendarRequestRejectedError("provider_rejected");
    }
    if (outcome === "timeout") {
      await hang(signal);
    }
    if (outcome === "server_error") {
      throw new FakeCalendarServerError();
    }
  }

  return {
    kind: "fake",
    calls,
    events,
    async createEvent(request, callOptions) {
      const eventId = fakeEventId(request.reference);
      await answer(
        { operation: "create", eventId: null, request },
        callOptions,
      );
      events.set(eventId, request);
      return eventId;
    },
    async updateEvent(eventId, request, callOptions) {
      await answer({ operation: "update", eventId, request }, callOptions);
      if (!events.has(eventId)) {
        // A real provider answers 404 for an event it does not hold.
        throw new CalendarRequestRejectedError("event_not_found");
      }
      events.set(eventId, request);
    },
    async cancelEvent(eventId, callOptions) {
      await answer(
        { operation: "cancel", eventId, request: null },
        callOptions,
      );
      events.delete(eventId);
    },
  };
}
