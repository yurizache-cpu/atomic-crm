// Phase 3A.2: the external calendar as an adapter, against a real Postgres,
// through the real `pg` driver and the real worker runtime, with the
// deterministic fake provider (supabase/migrations/20260928140000_calendar_sync.sql,
// engine/handlers/calendarSync.ts).
//
// What it proves:
//
//   * a connected company's booking create, reschedule and cancel are each
//     mirrored once, in order, with exactly the minimised request;
//   * an ambiguous call (a timeout, a server error) is indeterminate, stores no
//     event id, and is never called again, even when its job runs again;
//   * a worker that crashed after the call leaves `running`, and the next
//     attempt settles it indeterminate without calling;
//   * a refused call and an unconfigured worker fail cleanly, calling nothing
//     in the second case;
//   * the one kill switch holds calendar jobs, and a job_kind stop can name one;
//   * an update waits for its chain's create, and a company without a
//     connection stays local-only;
//   * no calendar outcome ever changes a booking.
//
// All data is synthetic; the fake opens no socket.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  UNCONFIGURED_CALENDAR_PORT,
  type CalendarPort,
} from "../calendar/calendarPort.ts";
import {
  createFakeCalendarProvider,
  fakeEventId,
  type FakeCalendarOutcome,
  type FakeCalendarProvider,
} from "../calendar/fakeCalendarProvider.ts";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { createCalendarSyncHandlers } from "../handlers/calendarSync.ts";
import { createRegistry } from "../worker/handlerRegistry.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import {
  resetFixtures,
  TENANT_A,
  TENANT_B,
} from "../worker/testSupport/dbFixture.ts";
import { makeJobDue, readJobLease } from "../worker/testSupport/jobLedger.ts";
import {
  addAvailabilityRule,
  cancelBooking,
  createBooking,
  defineBookingResource,
  defineBookingType,
  rescheduleBooking,
} from "./bookings.ts";
import { createCompany, createDepartment } from "./companyOs.ts";
import { clearExecutionStop, tripExecutionStop } from "./executionStops.ts";
import {
  closeAgentRunDatabases,
  openAgentRunDatabases,
} from "./testSupport/agentRunSessions.ts";

const SOURCE = "dbtest-calendar";
const WORKER = "dbtest-calendar";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let admin: Pool;
let owner: WorkerDatabase;
let worker: WorkerDatabase;

beforeAll(() => {
  ({ admin, owner, worker } = openAgentRunDatabases());
}, 60_000);

afterAll(() => closeAgentRunDatabases({ admin, owner, worker }));

const context = (tenantId: string) => ({
  tenantId,
  source: SOURCE,
  actor: "dbtest",
});
const asOwner = <T>(work: (tx: TxClient) => Promise<T>) =>
  owner.withTransaction(work);

interface Office {
  readonly companyId: string;
  readonly resourceId: string;
  readonly typeId: string;
}

async function createOffice(
  tenantId: string,
  connected: boolean,
): Promise<Office> {
  return asOwner(async (tx) => {
    const ctx = { tenantId, source: SOURCE };
    const sc = context(tenantId);
    const companyId = await createCompany(tx, ctx, {
      slug: "clinica",
      name: "Clínica sintética",
    });
    const departmentId = await createDepartment(tx, ctx, {
      companyId,
      slug: "atendimento",
      name: "Atendimento",
    });
    const resourceId = await defineBookingResource(tx, sc, {
      companyId,
      departmentId,
      key: "agenda-a",
      // A label that must never reach a calendar.
      label: "Dra. Sentinela Rótulo",
      kind: "professional",
    });
    const typeId = await defineBookingType(tx, sc, {
      companyId,
      key: "atendimento-inicial",
      label: "Tipo Sentinela Confidencial",
      durationMinutes: 50,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 10,
      slotStepMinutes: 60,
    });
    const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      await addAvailabilityRule(tx, sc, {
        resourceId,
        weekday,
        localStart: "09:00",
        localEnd: "12:00",
        timezone: "America/Sao_Paulo",
        effectiveFrom: yesterday,
      });
    }
    if (connected) {
      await tx.query(
        "select ops.configure_calendar_connection($1, $2, 'fake', 'Atendimento', true, 'dbtest')",
        [tenantId, companyId],
      );
    }
    return { companyId, resourceId, typeId };
  });
}

let office: Office;
let officeB: Office;

beforeEach(async () => {
  await resetFixtures(admin);
  office = await createOffice(TENANT_A, true);
  officeB = await createOffice(TENANT_B, false);
});

/** A São Paulo wall-clock time some days ahead (UTC-3, no DST). */
const saoPaulo = (daysAhead: number, time: string): Date => {
  const date = new Date(Date.now() - 3 * 60 * MINUTE + daysAhead * DAY)
    .toISOString()
    .slice(0, 10);
  return new Date(`${date}T${time}:00-03:00`);
};

const book = (key: string, startAt: Date, tenantId = TENANT_A, o = office) =>
  asOwner((tx) =>
    createBooking(tx, context(tenantId), {
      resourceId: o.resourceId,
      bookingTypeId: o.typeId,
      startAt,
      subject: { subjectRef: `lead:SYN-${key}` },
      idempotencyKey: key,
    }),
  );

const fakeWith = (
  outcomes: Partial<
    Record<"create" | "update" | "cancel", FakeCalendarOutcome>
  > = {},
): FakeCalendarProvider =>
  createFakeCalendarProvider({
    script: (call) => outcomes[call.operation] ?? "ok",
  });

const run = (
  port: CalendarPort,
  overrides: Partial<Parameters<typeof runOneJob>[1]> = {},
) =>
  runOneJob(worker, {
    workerId: WORKER,
    registry: createRegistry(
      createCalendarSyncHandlers({ calendarPort: port }),
    ),
    ...overrides,
  });

interface SyncRow {
  id: string;
  operation: string;
  status: string;
  external_event_id: string | null;
  error_code: string | null;
  job_id: string;
}

async function syncs(): Promise<SyncRow[]> {
  const { rows } = await admin.query<SyncRow>(
    `select s.id, s.operation, s.status, s.external_event_id, s.error_code, s.job_id
       from ops.calendar_syncs s where s.tenant_id = $1
      order by s.requested_at, array_position(array['create', 'update', 'cancel'], s.operation)`,
    [TENANT_A],
  );
  return rows;
}

async function bookingStatus(id: string): Promise<string> {
  const { rows } = await admin.query<{ status: string }>(
    "select status from ops.bookings where id = $1",
    [id],
  );
  return rows[0].status;
}

describe("a connected company's bookings are mirrored once each, minimised", () => {
  it("mirrors a create, a reschedule and a cancel, in order, with exactly the minimised request", async () => {
    // Arrange
    const fake = fakeWith();
    const booked = await book("mirror", saoPaulo(3, "09:00"));
    expect((await run(fake)).outcome).toBe("succeeded");
    const moved = await asOwner((tx) =>
      rescheduleBooking(
        tx,
        context(TENANT_A),
        booked.bookingId,
        saoPaulo(3, "11:00"),
        "mv",
      ),
    );
    expect((await run(fake)).outcome).toBe("succeeded");
    await asOwner((tx) =>
      cancelBooking(tx, context(TENANT_A), moved.bookingId, "patient_request"),
    );
    expect((await run(fake)).outcome).toBe("succeeded");
    expect((await run(fake)).outcome).toBe("idle");

    // Assert: three calls, one per change, on one event.
    const rows = await syncs();
    expect(rows.map((r) => [r.operation, r.status])).toEqual([
      ["create", "synced"],
      ["update", "synced"],
      ["cancel", "synced"],
    ]);
    const eventId = fakeEventId(rows[0].id);
    expect(rows.map((r) => r.external_event_id)).toEqual([
      eventId,
      eventId,
      eventId,
    ]);
    expect(fake.calls.map((c) => [c.operation, c.eventId])).toEqual([
      ["create", null],
      ["update", eventId],
      ["cancel", eventId],
    ]);
    // Exactly the minimised keys; nothing of the subject, resource or type.
    const created = fake.calls[0].request;
    expect(Object.keys(created ?? {}).sort()).toEqual([
      "endAt",
      "reference",
      "startAt",
      "timeZone",
      "title",
    ]);
    expect(created).toMatchObject({
      title: "Atendimento",
      startAt: saoPaulo(3, "09:00").toISOString().replace("Z", "000Z"),
      timeZone: "America/Sao_Paulo",
      reference: rows[0].id,
    });
    const wire = JSON.stringify(fake.calls);
    for (const sentinel of ["Sentinela", "SYN-mirror", "lead:", "Dra."]) {
      expect(wire).not.toContain(sentinel);
    }
    expect(fake.events.size).toBe(0);
  });

  it("requests nothing for a company without a connection: it stays local-only", async () => {
    await book("local", saoPaulo(3, "10:00"), TENANT_B, officeB);
    const { rows } = await admin.query<{ n: number }>(
      `select (select count(*) from ops.calendar_syncs where tenant_id = $1)
            + (select count(*) from ops.jobs where tenant_id = $1) as n`,
      [TENANT_B],
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});

describe("an external calendar call is made at most once", () => {
  it("records an ambiguous server error as indeterminate, stores no event id, and never calls again", async () => {
    // Arrange
    const fake = fakeWith({ create: "server_error" });
    const booked = await book("ambiguous", saoPaulo(3, "09:00"));

    // Act
    await run(fake);
    const [sync] = await syncs();
    // The owner puts the job back on the queue: a replay.
    await admin.query(
      "update ops.jobs set status = 'queued', available_at = now(), completed_at = null where id = $1",
      [sync.job_id],
    );
    const replay = await run(fake);

    // Assert
    expect(sync).toMatchObject({
      status: "indeterminate",
      external_event_id: null,
      error_code: "provider_error",
    });
    expect(replay.detail).toContain("status=indeterminate");
    expect(fake.calls).toHaveLength(1);
    expect(await bookingStatus(booked.bookingId)).toBe("booked");
  });

  it("records a call that outlived its deadline as indeterminate", async () => {
    const fake = fakeWith({ create: "timeout" });
    await book("slow", saoPaulo(3, "10:00"));
    // A 13 s lease with a 10 s safety margin leaves the call about 3 s.
    const outcome = await run(fake, { leaseSeconds: 13 });
    expect(outcome.outcome).toBe("succeeded");
    const [sync] = await syncs();
    expect(sync).toMatchObject({
      status: "indeterminate",
      external_event_id: null,
      error_code: "provider_timeout",
    });
    expect(fake.calls).toHaveLength(1);
  }, 30_000);

  it("settles a call a crashed worker never recorded as indeterminate, without calling again", async () => {
    // Arrange: the worker dies between the call and its settlement.
    const fake = fakeWith();
    await book("crash", saoPaulo(3, "11:00"));
    await expect(
      run(fake, {
        onCallFinished: async () => {
          throw new Error("the worker process died");
        },
      }),
    ).rejects.toThrow("the worker process died");
    const [running] = await syncs();
    expect(running.status).toBe("running");
    await admin.query(
      "update ops.jobs set lease_expires_at = now() - interval '1 second' where id = $1",
      [running.job_id],
    );

    // Act: the reaper returns the job; the next attempt finds `running`.
    const next = await run(fake);

    // Assert
    expect(next.detail).toContain("status=indeterminate");
    const [settled] = await syncs();
    expect(settled).toMatchObject({
      status: "indeterminate",
      error_code: "execution_interrupted",
      external_event_id: null,
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("fails cleanly when the provider refuses, and calls nothing without a configured provider", async () => {
    await book("refused", saoPaulo(4, "09:00"));
    await run(fakeWith({ create: "rejected" }));
    await book("unconfigured", saoPaulo(4, "10:00"));
    await run(UNCONFIGURED_CALENDAR_PORT);
    const rows = await syncs();
    expect(
      rows.map((r) => [r.status, r.error_code, r.external_event_id]),
    ).toEqual([
      ["failed", "provider_rejected", null],
      ["failed", "provider_not_configured", null],
    ]);
  });
});

describe("calendar jobs obey the one kill switch and their chain", () => {
  it("is held by a job_kind stop on calendar.create, consuming no attempt, and syncs once cleared", async () => {
    const fake = fakeWith();
    await book("stopped", saoPaulo(4, "11:00"));
    const stopId = await asOwner((tx) =>
      tripExecutionStop(
        tx,
        { scope: "job_kind", tenantId: TENANT_A, jobKind: "calendar.create" },
        { reason: "dbtest calendar drill", actor: "dbtest" },
      ),
    );
    expect((await run(fake)).outcome).toBe("idle");
    const [held] = await syncs();
    expect(held.status).toBe("pending");
    expect((await readJobLease(admin, held.job_id)).attempts).toBe(0);
    await asOwner((tx) =>
      clearExecutionStop(tx, stopId, {
        reason: "dbtest drill over",
        actor: "dbtest",
      }),
    );
    await run(fake);
    expect((await syncs())[0].status).toBe("synced");
    expect(fake.calls).toHaveLength(1);
  });

  it("makes an update wait for its chain's create, recording nothing, then mirrors both in order", async () => {
    // Arrange: the create's job is not due yet; the update's is.
    const fake = fakeWith();
    const booked = await book("chain", saoPaulo(5, "09:00"));
    await asOwner((tx) =>
      rescheduleBooking(
        tx,
        context(TENANT_A),
        booked.bookingId,
        saoPaulo(5, "10:00"),
        "mv-chain",
      ),
    );
    const [create, update] = await syncs();
    await admin.query(
      "update ops.jobs set available_at = now() + interval '1 hour' where id = $1",
      [create.job_id],
    );

    // Act
    const waited = await run(fake);

    // Assert
    expect(waited.outcome).toBe("retry");
    expect((await syncs())[1].status).toBe("pending");
    expect(fake.calls).toHaveLength(0);

    await makeJobDue(admin, create.job_id);
    await run(fake);
    await makeJobDue(admin, update.job_id);
    await run(fake);
    expect((await syncs()).map((r) => r.status)).toEqual(["synced", "synced"]);
    expect(fake.calls.map((c) => c.operation)).toEqual(["create", "update"]);
  });

  it("stops waiting on its job's last attempt: the update fails, calling nothing, never left pending", async () => {
    // Arrange: the create is not due; the update's job has one attempt.
    const fake = fakeWith();
    const booked = await book("last-attempt", saoPaulo(5, "11:00"));
    await asOwner((tx) =>
      rescheduleBooking(
        tx,
        context(TENANT_A),
        booked.bookingId,
        saoPaulo(6, "11:00"),
        "mv-last",
      ),
    );
    const [create, update] = await syncs();
    await admin.query(
      "update ops.jobs set available_at = now() + interval '1 hour' where id = $1",
      [create.job_id],
    );
    await admin.query("update ops.jobs set max_attempts = 1 where id = $1", [
      update.job_id,
    ]);

    // Act
    const outcome = await run(fake);

    // Assert
    expect(outcome.detail).toContain("status=failed");
    expect((await syncs())[1]).toMatchObject({
      status: "failed",
      error_code: "earlier_sync_not_settled",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("creates the event at the booking's current time when it was moved while the create waited", async () => {
    // Arrange: the booking is moved before its create has run.
    const fake = fakeWith();
    const booked = await book("moved-early", saoPaulo(6, "09:00"));
    await asOwner((tx) =>
      rescheduleBooking(
        tx,
        context(TENANT_A),
        booked.bookingId,
        saoPaulo(6, "11:00"),
        "mv-early",
      ),
    );
    // Act: the create, then the update behind it.
    await run(fake);
    await run(fake);

    // Assert: both calls carry the booking as it is now.
    const now = saoPaulo(6, "11:00").toISOString().replace("Z", "000Z");
    expect(fake.calls.map((c) => [c.operation, c.request?.startAt])).toEqual([
      ["create", now],
      ["update", now],
    ]);
    expect((await syncs()).map((r) => r.status)).toEqual(["synced", "synced"]);
  });

  it("creates no event for a booking cancelled before its create ran", async () => {
    const fake = fakeWith();
    const booked = await book("cancelled-early", saoPaulo(6, "10:00"));
    await asOwner((tx) =>
      cancelBooking(tx, context(TENANT_A), booked.bookingId, "patient_request"),
    );
    await run(fake);
    await run(fake);
    expect(
      (await syncs()).map((r) => [r.operation, r.status, r.error_code]),
    ).toEqual([
      ["create", "skipped", "booking_not_booked"],
      ["cancel", "skipped", "no_confirmed_event"],
    ]);
    expect(fake.calls).toHaveLength(0);
  });

  it("runs a chain's syncs in the order they were requested: a later update waits for an earlier one", async () => {
    // Arrange: created and mirrored, then moved twice; the first move's job
    // is not due yet, the second's is.
    const fake = fakeWith();
    const booked = await book("moved-twice", saoPaulo(7, "09:00"));
    await run(fake);
    const first = await asOwner((tx) =>
      rescheduleBooking(
        tx,
        context(TENANT_A),
        booked.bookingId,
        saoPaulo(7, "10:00"),
        "mv-1st",
      ),
    );
    await asOwner((tx) =>
      rescheduleBooking(
        tx,
        context(TENANT_A),
        first.bookingId,
        saoPaulo(7, "11:00"),
        "mv-2nd",
      ),
    );
    const [, earlier, later] = await syncs();
    await admin.query(
      "update ops.jobs set available_at = now() + interval '1 hour' where id = $1",
      [earlier.job_id],
    );

    // Act
    const waited = await run(fake);
    await makeJobDue(admin, earlier.job_id);
    await run(fake);
    await makeJobDue(admin, later.job_id);
    await run(fake);

    // Assert: the later update waited, then both reached the provider in
    // order, each carrying the booking's current time.
    expect(waited.outcome).toBe("retry");
    const latest = saoPaulo(7, "11:00").toISOString().replace("Z", "000Z");
    expect(fake.calls.map((c) => [c.operation, c.request?.startAt])).toEqual([
      ["create", saoPaulo(7, "09:00").toISOString().replace("Z", "000Z")],
      ["update", latest],
      ["update", latest],
    ]);
    expect((await syncs()).map((r) => r.status)).toEqual([
      "synced",
      "synced",
      "synced",
    ]);
  });

  it("settles an update and a cancel as failed without a call on a worker with no calendar provider", async () => {
    // Arrange: mirrored once, then moved and cancelled.
    const booked = await book("no-provider", saoPaulo(8, "09:00"));
    await run(fakeWith());
    const moved = await asOwner((tx) =>
      rescheduleBooking(
        tx,
        context(TENANT_A),
        booked.bookingId,
        saoPaulo(8, "10:00"),
        "mv-np",
      ),
    );
    await asOwner((tx) =>
      cancelBooking(tx, context(TENANT_A), moved.bookingId, "patient_request"),
    );

    // Act: a worker with no provider takes both.
    const update = await run(UNCONFIGURED_CALENDAR_PORT);
    const cancel = await run(UNCONFIGURED_CALENDAR_PORT);

    // Assert: each job completed, each sync settled, nothing left pending.
    expect([update.outcome, cancel.outcome]).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(
      (await syncs())
        .slice(1)
        .map((r) => [r.operation, r.status, r.error_code]),
    ).toEqual([
      ["update", "failed", "provider_not_configured"],
      ["cancel", "failed", "provider_not_configured"],
    ]);
  });

  it("skips an update whose chain has no confirmed event, calling nothing", async () => {
    const fake = fakeWith({ create: "rejected" });
    const booked = await book("no-event", saoPaulo(5, "11:00"));
    await run(fake);
    await asOwner((tx) =>
      rescheduleBooking(
        tx,
        context(TENANT_A),
        booked.bookingId,
        saoPaulo(6, "09:00"),
        "mv-none",
      ),
    );
    await run(fake);
    const rows = await syncs();
    expect(rows.map((r) => [r.operation, r.status, r.error_code])).toEqual([
      ["create", "failed", "provider_rejected"],
      ["update", "skipped", "no_confirmed_event"],
    ]);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("the calendar gate", () => {
  it("refuses a real provider kind: only the deterministic fake can be connected", async () => {
    const error = await asOwner((tx) =>
      tx.query(
        "select ops.configure_calendar_connection($1, $2, 'google', 'Atendimento', true, 'dbtest')",
        [TENANT_B, officeB.companyId],
      ),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "23514" });
  });
});
