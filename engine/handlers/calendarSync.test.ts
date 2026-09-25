// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CalendarProviderUnavailableError,
  CalendarRequestRejectedError,
} from "../calendar/calendarPort.ts";
import { createFakeCalendarProvider } from "../calendar/fakeCalendarProvider.ts";
import type { CalendarSyncSettlement } from "../worker/capabilities.ts";
import {
  PermanentError,
  SecurityError,
  TransientError,
} from "../worker/failures.ts";
import type { LeasedJob } from "../worker/job.ts";
import {
  calendarFailureSettlement,
  CALENDAR_CREATE_KIND,
  createCalendarSyncHandlers,
} from "./calendarSync.ts";

// The calendar handlers' own decisions (Phase 3A.2): how an outcome is
// classified, what a prepare answer is allowed to mean, and that a request the
// database built is re-checked before a provider sees it. The at-most-once
// path through the real runtime and database is engine/domain/
// calendarSync.dbtest.ts.

const SYNC = "5b2c9d1e-3f4a-4b5c-8d6e-7f8091a2b3c4";
const job: LeasedJob = {
  id: "00000000-0000-4000-8000-000000000011",
  tenant_id: "00000000-0000-4000-8000-000000000012",
  kind: CALENDAR_CREATE_KIND,
  payload: { calendar_sync_id: SYNC },
  attempts: 1,
  max_attempts: 5,
};
const budget = { callBudgetMs: 30_000, remainingMs: () => 30_000 };
const REQUEST = {
  title: "Atendimento",
  startAt: "2026-10-05T12:00:00.000000Z",
  endAt: "2026-10-05T12:50:00.000000Z",
  timeZone: "America/Sao_Paulo",
  reference: SYNC,
};

const [createHandler] = createCalendarSyncHandlers({
  calendarPort: createFakeCalendarProvider(),
});

const prepareWith = (answer: unknown, payload: unknown = job.payload) =>
  createHandler.prepare(
    { ...job, payload },
    { startCalendarSync: async () => answer },
    budget,
  );

describe("the calendar handlers classify every outcome", () => {
  it("fails cleanly only when the provider was not reached or refused without acting", () => {
    expect(
      calendarFailureSettlement(
        new CalendarProviderUnavailableError("provider_not_configured"),
      ),
    ).toEqual({
      outcome: "failed",
      externalEventId: null,
      errorCode: "provider_not_configured",
    });
    expect(
      calendarFailureSettlement(
        new CalendarRequestRejectedError("event_not_found"),
      ).outcome,
    ).toBe("failed");
  });

  it("treats every other failure as indeterminate: it may have acted, so nothing asks again", () => {
    const cases: [unknown, string][] = [
      [new DOMException("deadline", "TimeoutError"), "provider_timeout"],
      [new DOMException("stop", "AbortError"), "provider_timeout"],
      [new Error("502 Bad Gateway"), "provider_error"],
      [new TypeError("fetch failed"), "provider_error"],
      ["a string thrown", "provider_error"],
    ];
    for (const [error, code] of cases) {
      const settlement: CalendarSyncSettlement =
        calendarFailureSettlement(error);
      expect(settlement).toEqual({
        outcome: "indeterminate",
        externalEventId: null,
        errorCode: code,
      });
    }
  });

  it("stores an event id only for a readable one, and is indeterminate otherwise", async () => {
    const settled: CalendarSyncSettlement[] = [];
    const settleCapability = {
      settleCalendarSync: async (s: CalendarSyncSettlement) => {
        settled.push(s);
        return s.outcome;
      },
    };
    const state = {
      calendarSyncId: SYNC,
      operation: "create" as const,
      eventId: null,
      request: REQUEST,
    };
    await createHandler.settle(
      state,
      { ok: true, value: "fake-abc", durationMs: 1 },
      settleCapability,
    );
    await createHandler.settle(
      state,
      { ok: true, value: "id with spaces", durationMs: 1 },
      settleCapability,
    );
    expect(settled).toEqual([
      { outcome: "synced", externalEventId: "fake-abc", errorCode: null },
      {
        outcome: "indeterminate",
        externalEventId: null,
        errorCode: "provider_answer_unreadable",
      },
    ]);
  });
});

describe("a calendar prepare means only what the database answered", () => {
  it("holds on a stop, retries on wait, and settles anything that is not a start", async () => {
    expect(
      await prepareWith({ action: "stopped", calendarSyncId: SYNC }),
    ).toEqual({ kind: "held" });
    await expect(
      prepareWith({ action: "wait", calendarSyncId: SYNC }),
    ).rejects.toBeInstanceOf(TransientError);
    expect(
      await prepareWith({
        action: "settled",
        status: "indeterminate",
        calendarSyncId: SYNC,
      }),
    ).toEqual({
      kind: "settled",
      detail: `calendar_sync=${SYNC} status=indeterminate`,
    });
  });

  it("refuses a job whose payload names no sync or another sync than its lease", async () => {
    await expect(
      prepareWith({ action: "stopped", calendarSyncId: SYNC }, {}),
    ).rejects.toBeInstanceOf(PermanentError);
    await expect(
      prepareWith({
        action: "stopped",
        calendarSyncId: "00000000-0000-4000-8000-0000000000ff",
      }),
    ).rejects.toBeInstanceOf(SecurityError);
    await expect(
      prepareWith({ action: "delete_everything" }),
    ).rejects.toBeInstanceOf(PermanentError);
  });

  it("re-checks the database's request, and a request that fails it reaches no provider", async () => {
    const fake = createFakeCalendarProvider();
    const [handler] = createCalendarSyncHandlers({ calendarPort: fake });
    const prepared = await handler.prepare(
      job,
      {
        startCalendarSync: async () => ({
          action: "start",
          calendarSyncId: SYNC,
          operation: "create",
          externalEventId: null,
          request: { ...REQUEST, description: "never sent" },
        }),
      },
      budget,
    );
    expect(prepared.kind).toBe("call");
    if (prepared.kind !== "call") return;
    await expect(
      handler.call(prepared.state, {
        signal: new AbortController().signal,
        deadline: Date.now() + 1_000,
      }),
    ).rejects.toBeInstanceOf(CalendarProviderUnavailableError);
    expect(fake.calls).toHaveLength(0);
  });

  it("starts no call on a lease too short to finish one", async () => {
    await expect(
      createHandler.prepare(
        job,
        {
          startCalendarSync: async () => ({
            action: "start",
            calendarSyncId: SYNC,
            operation: "create",
            externalEventId: null,
            request: REQUEST,
          }),
        },
        { callBudgetMs: 500, remainingMs: () => 500 },
      ),
    ).rejects.toBeInstanceOf(TransientError);
  });
});
