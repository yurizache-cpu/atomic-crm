// calendar.create, calendar.update, calendar.cancel (Phase 3A.2): ONE external
// calendar action, through the CalendarPort, under the governed external-call
// shape every provider call uses. One implementation, three kinds, so each
// operation is its own low-cardinality telemetry operation and its own
// job_kind stop.
//
//   prepare  (TX2a, committed) start the sync the LEASE is bound to: the
//            database re-checks the stops and the connection, records
//            `running` BEFORE anything is called, and hands back the minimised
//            request, carrying the booking chain's CURRENT times. `stopped`
//            holds the job; `wait` (an earlier sync of the same booking chain
//            is not settled yet, so a chain's calls never overtake each other)
//            retries later with nothing recorded; anything else that is not a
//            start settles the job without calling anyone.
//   call     (no transaction, no capabilities) one call to the provider.
//   settle   (TX2b) store the outcome. A provider that was never reached, or
//            that refused and did not act, is `failed`. Every other failure (a
//            timeout, an abort, a 5xx, a lost connection, an unreadable
//            answer) is `indeterminate`: the provider may have acted, so
//            nothing asks it again, and a person resolves it.
//
// THE CALENDAR IS NOT AUTHORITATIVE: nothing here writes a booking, and the
// handler declares no post-settlement step. The request is exactly the strict
// CalendarEventRequestSchema: a generic title, two instants, a zone and an
// opaque reference.

import { z } from "zod";
import {
  CalendarEventRequestSchema,
  CalendarProviderUnavailableError,
  CalendarRequestRejectedError,
  EXTERNAL_EVENT_ID_PATTERN,
  type CalendarEventRequest,
  type CalendarPort,
} from "../calendar/calendarPort.ts";
import type { CalendarSyncSettlement } from "../worker/capabilities.ts";
import {
  PermanentError,
  SecurityError,
  TransientError,
} from "../worker/failures.ts";
import type {
  CallOutcome,
  ExternalCallHandlerDefinition,
  PrepareOutcome,
} from "../worker/handlerRegistry.ts";
import { payloadObject } from "../worker/job.ts";

export type CalendarOperation = "create" | "update" | "cancel";

export const CALENDAR_OPERATIONS: readonly CalendarOperation[] = Object.freeze([
  "create",
  "update",
  "cancel",
]);

export const CALENDAR_CREATE_KIND = "calendar.create";
export const CALENDAR_UPDATE_KIND = "calendar.update";
export const CALENDAR_CANCEL_KIND = "calendar.cancel";

const KIND_OF: Readonly<Record<CalendarOperation, string>> = Object.freeze({
  create: CALENDAR_CREATE_KIND,
  update: CALENDAR_UPDATE_KIND,
  cancel: CALENDAR_CANCEL_KIND,
});

/** The least lease a calendar call may start with. */
export const MIN_CALENDAR_CALL_BUDGET_MS = 2_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;

const startSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("settled"),
    status: z.string(),
    calendarSyncId: z.string().regex(UUID),
  }),
  z.object({
    action: z.literal("stopped"),
    calendarSyncId: z.string().regex(UUID),
  }),
  z.object({
    action: z.literal("wait"),
    calendarSyncId: z.string().regex(UUID),
  }),
  z.object({
    action: z.literal("start"),
    calendarSyncId: z.string().regex(UUID),
    operation: z.enum(["create", "update", "cancel"]),
    externalEventId: z.string().nullable(),
    request: z.unknown(),
  }),
]);

type PrepareCapability = "startCalendarSync";
type SettleCapability = "settleCalendarSync";

interface CalendarState {
  readonly calendarSyncId: string;
  readonly operation: CalendarOperation;
  /** The event an update or cancel changes; null for a create. */
  readonly eventId: string | null;
  /** null for a cancel, or when the database's request failed the strict schema. */
  readonly request: CalendarEventRequest | null;
}

export type CalendarSyncHandler = ExternalCallHandlerDefinition<
  PrepareCapability,
  SettleCapability,
  CalendarState,
  string | null
>;

const describe = (calendarSyncId: string, status: string): string =>
  `calendar_sync=${calendarSyncId} status=${status}`;

/** What the settlement records for a call that did not succeed. */
export function calendarFailureSettlement(
  error: unknown,
): CalendarSyncSettlement {
  if (
    error instanceof CalendarProviderUnavailableError ||
    error instanceof CalendarRequestRejectedError
  ) {
    // Never reached, or refused without acting: a clean failure.
    return {
      outcome: "failed",
      externalEventId: null,
      errorCode: REASON_CODE.test(error.code)
        ? error.code
        : "provider_rejected",
    };
  }
  // The provider may have received it and may have acted: unknown.
  const aborted =
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError");
  return {
    outcome: "indeterminate",
    externalEventId: null,
    errorCode: aborted ? "provider_timeout" : "provider_error",
  };
}

function createCalendarSyncHandler(
  operation: CalendarOperation,
  calendarPort: CalendarPort,
): CalendarSyncHandler {
  const kind = KIND_OF[operation];
  const handler: CalendarSyncHandler = {
    kind,
    shape: "external_call",
    prepareCapabilities: Object.freeze<PrepareCapability[]>([
      "startCalendarSync",
    ]),
    settleCapabilities: Object.freeze<SettleCapability[]>([
      "settleCalendarSync",
    ]),

    async prepare(
      job,
      capabilities,
      budget,
    ): Promise<PrepareOutcome<CalendarState>> {
      const named = payloadObject(job.payload).calendar_sync_id;
      if (typeof named !== "string" || !UUID.test(named)) {
        throw new PermanentError(
          "the job names no calendar sync; nothing was started",
        );
      }
      const parsed = startSchema.safeParse(
        await capabilities.startCalendarSync(calendarPort.kind),
      );
      if (!parsed.success) {
        throw new PermanentError(
          "ops.start_calendar_sync returned a shape this handler does not accept",
        );
      }
      const start = parsed.data;
      // A job whose lease is bound to another sync is forged or mis-routed.
      if (start.calendarSyncId !== named) {
        throw new SecurityError(
          "the job's calendar_sync_id does not name the sync its lease is bound to",
        );
      }
      if (start.action === "stopped") return { kind: "held" };
      if (start.action === "wait") {
        throw new TransientError(
          "the booking's calendar event is not created yet; nothing was started",
        );
      }
      if (start.action === "settled") {
        return { kind: "settled", detail: describe(named, start.status) };
      }
      if (start.operation !== operation) {
        throw new SecurityError(
          "the sync's operation is not this job kind's; nothing was called",
        );
      }
      // `running` commits only with this prepare transaction: a lease too
      // short to call throws, so the start rolls back and nothing is called.
      if (budget.remainingMs() < MIN_CALENDAR_CALL_BUDGET_MS) {
        throw new TransientError(
          "lease too short to call the calendar; nothing was started",
        );
      }
      const request =
        operation === "cancel"
          ? null
          : CalendarEventRequestSchema.safeParse(start.request);
      const eventId =
        start.externalEventId !== null &&
        EXTERNAL_EVENT_ID_PATTERN.test(start.externalEventId)
          ? start.externalEventId
          : null;
      return {
        kind: "call",
        providerKind: calendarPort.kind,
        state: Object.freeze({
          calendarSyncId: named,
          operation,
          eventId,
          request: request?.success ? request.data : null,
        }),
      };
    },

    async call(state, context) {
      const options = { signal: context.signal };
      if (state.operation === "create") {
        if (state.request === null) {
          throw new CalendarProviderUnavailableError("request_rejected");
        }
        return calendarPort.createEvent(state.request, options);
      }
      if (state.eventId === null) {
        throw new CalendarProviderUnavailableError("request_rejected");
      }
      if (state.operation === "update") {
        if (state.request === null) {
          throw new CalendarProviderUnavailableError("request_rejected");
        }
        await calendarPort.updateEvent(state.eventId, state.request, options);
        return null;
      }
      await calendarPort.cancelEvent(state.eventId, options);
      return null;
    },

    async settle(
      state,
      outcome: CallOutcome<string | null>,
      capabilities,
    ): Promise<string> {
      let settlement: CalendarSyncSettlement;
      if (!outcome.ok) {
        settlement = calendarFailureSettlement(outcome.error);
      } else if (state.operation !== "create") {
        settlement = {
          outcome: "synced",
          externalEventId: null,
          errorCode: null,
        };
      } else if (
        typeof outcome.value === "string" &&
        EXTERNAL_EVENT_ID_PATTERN.test(outcome.value)
      ) {
        settlement = {
          outcome: "synced",
          externalEventId: outcome.value,
          errorCode: null,
        };
      } else {
        // It may have created an event we cannot name: unknown, never retried.
        settlement = {
          outcome: "indeterminate",
          externalEventId: null,
          errorCode: "provider_answer_unreadable",
        };
      }
      const status = await capabilities.settleCalendarSync(settlement);
      if (status === "not_running") {
        throw new PermanentError(
          "the calendar sync was not this attempt's to settle",
        );
      }
      return describe(state.calendarSyncId, status);
    },
  };
  return Object.freeze(handler);
}

/** The three calendar handlers, all through one port. */
export function createCalendarSyncHandlers(dependencies: {
  readonly calendarPort: CalendarPort;
}): readonly CalendarSyncHandler[] {
  return CALENDAR_OPERATIONS.map((operation) =>
    createCalendarSyncHandler(operation, dependencies.calendarPort),
  );
}
