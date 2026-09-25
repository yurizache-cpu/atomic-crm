// Phase 3A.2: the booking foundation against a real Postgres, through the
// real `pg` driver (supabase/migrations/20260928130000_booking_foundation.sql).
//
// What it proves, each against the database rather than a mock:
//
//   * offered slots follow the rules' windows, the type's step, duration and
//     buffers, never lie in the past, and ignore the session time zone;
//   * local times resolve in each rule's own IANA zone, across daylight-saving
//     changes, exactly as PostgreSQL resolves them (a gap moves forward, a
//     repeated hour takes its later, standard-time occurrence);
//   * the exclusion constraint refuses an overlapping booking of a resource,
//     allows an adjacent one and the same time on another resource, and frees
//     time on cancellation and reschedule;
//   * racing bookings of one time: exactly one commits, under any number of
//     concurrent owners;
//   * a reschedule is atomic (a refused new time leaves the original booked),
//     replays by key, and two racing reschedules of one booking leave exactly
//     one booked successor;
//   * create, reschedule and cancel are idempotent; ranges are bounded; and one
//     tenant reaches nothing of another's.
//
// All data is synthetic: opaque references, no names, numbers or messages.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import {
  resetFixtures,
  TENANT_A,
  TENANT_B,
} from "../worker/testSupport/dbFixture.ts";
import {
  addAvailabilityRule,
  availableSlots,
  BOOKING_STATUS_TRANSITIONS,
  cancelBooking,
  createBooking,
  defineBookingResource,
  defineBookingType,
  rescheduleBooking,
  setSchedulingTimezone,
  type CreateBookingInput,
} from "./bookings.ts";
import { createCompany, createDepartment } from "./companyOs.ts";
import { CompanyOsError } from "./errors.ts";
import {
  closeAgentRunDatabases,
  openAgentRunDatabases,
} from "./testSupport/agentRunSessions.ts";

const SOURCE = "dbtest-bookings";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ZONE = "America/Sao_Paulo";

let admin: Pool;
let owner: WorkerDatabase;
let worker: WorkerDatabase;

beforeAll(() => {
  ({ admin, owner, worker } = openAgentRunDatabases());
}, 60_000);

afterAll(() => closeAgentRunDatabases({ admin, owner, worker }));

interface Office {
  readonly tenantId: string;
  readonly companyId: string;
  readonly departmentId: string;
  /** Two resources with the same windows. */
  readonly resourceId: string;
  readonly otherResourceId: string;
  /** 50 minutes, 10 minutes after, a start every hour. */
  readonly typeId: string;
}

const context = (tenantId: string) => ({
  tenantId,
  source: SOURCE,
  actor: "dbtest",
});

const asOwner = <T>(work: (tx: TxClient) => Promise<T>) =>
  owner.withTransaction(work);

/** Every weekday 09:00-12:00 in São Paulo, in effect from yesterday. */
async function createOffice(tenantId: string): Promise<Office> {
  return asOwner(async (tx) => {
    const ctx = { tenantId, source: SOURCE };
    const companyId = await createCompany(tx, ctx, {
      slug: "clinica",
      name: "Clínica sintética",
    });
    const departmentId = await createDepartment(tx, ctx, {
      companyId,
      slug: "atendimento",
      name: "Atendimento",
    });
    const sc = context(tenantId);
    await setSchedulingTimezone(tx, sc, ZONE);
    const resourceId = await defineBookingResource(tx, sc, {
      companyId,
      departmentId,
      key: "agenda-a",
      label: "Agenda A",
      kind: "professional",
    });
    const otherResourceId = await defineBookingResource(tx, sc, {
      companyId,
      departmentId,
      key: "agenda-b",
      label: "Agenda B",
      kind: "professional",
    });
    const typeId = await defineBookingType(tx, sc, {
      companyId,
      key: "atendimento-inicial",
      label: "Atendimento inicial",
      durationMinutes: 50,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 10,
      slotStepMinutes: 60,
    });
    const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    for (const resource of [resourceId, otherResourceId]) {
      for (let weekday = 1; weekday <= 7; weekday += 1) {
        await addAvailabilityRule(tx, sc, {
          resourceId: resource,
          weekday,
          localStart: "09:00",
          localEnd: "12:00",
          timezone: ZONE,
          effectiveFrom: yesterday,
        });
      }
    }
    return {
      tenantId,
      companyId,
      departmentId,
      resourceId,
      otherResourceId,
      typeId,
    };
  });
}

let office: Office;
let officeB: Office;

beforeEach(async () => {
  await resetFixtures(admin);
  office = await createOffice(TENANT_A);
  officeB = await createOffice(TENANT_B);
});

/** A local São Paulo date some days ahead, as YYYY-MM-DD (no DST since 2019). */
const localDate = (daysAhead: number): string => {
  const shifted = new Date(Date.now() - 3 * 60 * MINUTE + daysAhead * DAY);
  return shifted.toISOString().slice(0, 10);
};

/** The instant of a São Paulo wall-clock time (UTC-3) on a local date. */
const saoPaulo = (date: string, time: string): Date =>
  new Date(`${date}T${time}:00-03:00`);

const book = (
  input: Partial<CreateBookingInput> & { readonly startAt: Date },
  key: string,
  tenantId = TENANT_A,
) =>
  asOwner((tx) =>
    createBooking(tx, context(tenantId), {
      resourceId: office.resourceId,
      bookingTypeId: office.typeId,
      subject: { subjectRef: `lead:SYN-${key}` },
      idempotencyKey: key,
      ...input,
    }),
  );

const slotsOn = (date: string, resourceId = office.resourceId) =>
  asOwner((tx) =>
    availableSlots(tx, TENANT_A, {
      resourceId,
      bookingTypeId: office.typeId,
      from: saoPaulo(date, "00:00"),
      until: saoPaulo(date, "23:59"),
    }),
  );

const localTimes = (slots: readonly { startAt: string }[]) =>
  slots.map((s) =>
    new Date(new Date(s.startAt).getTime() - 3 * 60 * MINUTE)
      .toISOString()
      .slice(11, 16),
  );

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to be refused");
};

async function bookedCount(resourceId = office.resourceId): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    "select count(*)::int as n from ops.bookings where resource_id = $1 and status = 'booked'",
    [resourceId],
  );
  return rows[0].n;
}

describe("availability is deterministic arithmetic over the rules", () => {
  it("offers each window's steps whose appointment fits, with the type's duration", async () => {
    const date = localDate(2);
    const slots = await slotsOn(date);
    expect(localTimes(slots)).toEqual(["09:00", "10:00", "11:00"]);
    for (const slot of slots) {
      expect(
        new Date(slot.endAt).getTime() - new Date(slot.startAt).getTime(),
      ).toBe(50 * MINUTE);
    }
  });

  it("answers the same slots whatever the session time zone", async () => {
    const date = localDate(2);
    const inZone = (zone: string) =>
      asOwner(async (tx) => {
        await tx.query(`set local time zone '${zone}'`);
        return availableSlots(tx, TENANT_A, {
          resourceId: office.resourceId,
          bookingTypeId: office.typeId,
          from: saoPaulo(date, "00:00"),
          until: saoPaulo(date, "23:59"),
        });
      });
    const tokyo = await inZone("Asia/Tokyo");
    expect(await inZone("UTC")).toEqual(tokyo);
    expect(await inZone("Pacific/Honolulu")).toEqual(tokyo);
  });

  it("never offers a slot in the past", async () => {
    const slots = await asOwner((tx) =>
      availableSlots(tx, TENANT_A, {
        resourceId: office.resourceId,
        bookingTypeId: office.typeId,
        from: new Date(Date.now() - 3 * DAY),
        until: new Date(Date.now() + DAY),
      }),
    );
    for (const slot of slots) {
      expect(new Date(slot.startAt).getTime()).toBeGreaterThan(
        Date.now() - MINUTE,
      );
    }
  });

  it("refuses an unbounded range or limit", async () => {
    const from = new Date();
    for (const query of [
      { until: new Date(from.getTime() + 32 * DAY), limit: 10 },
      { until: from, limit: 10 },
      { until: new Date(from.getTime() + DAY), limit: 501 },
      { until: new Date(from.getTime() + DAY), limit: 0 },
    ]) {
      const error = await rejection(
        asOwner((tx) =>
          availableSlots(tx, TENANT_A, {
            resourceId: office.resourceId,
            bookingTypeId: office.typeId,
            from,
            ...query,
          }),
        ),
      );
      expect(error).toMatchObject({ code: "invalid_argument" });
    }
  });

  it("resolves local windows in their own zone across daylight-saving changes, as PostgreSQL does", async () => {
    // Arrange: a New York resource open 09:00-12:00 on Mondays and 01:00-05:00
    // on Sundays. 2026-11-01 (a Sunday) ends daylight saving; 2027-03-14 (a
    // Sunday) starts it.
    const newYork = await asOwner(async (tx) => {
      const sc = context(TENANT_A);
      const id = await defineBookingResource(tx, sc, {
        companyId: office.companyId,
        departmentId: office.departmentId,
        key: "agenda-ny",
        label: "Agenda NY",
        kind: "room",
      });
      for (const [weekday, localStart, localEnd] of [
        [1, "09:00", "12:00"],
        [7, "01:00", "05:00"],
      ] as const) {
        await addAvailabilityRule(tx, sc, {
          resourceId: id,
          weekday,
          localStart,
          localEnd,
          timezone: "America/New_York",
          effectiveFrom: "2026-01-01",
        });
      }
      return id;
    });
    const utcSlots = async (from: string, until: string) =>
      (
        await asOwner((tx) =>
          availableSlots(tx, TENANT_A, {
            resourceId: newYork,
            bookingTypeId: office.typeId,
            from: new Date(from),
            until: new Date(until),
          }),
        )
      ).map((s) => s.startAt);

    // Act / Assert: 09:00 local is 13:00Z in daylight time and 14:00Z after.
    expect(
      await utcSlots("2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z"),
    ).toEqual([
      "2026-10-26T13:00:00.000Z",
      "2026-10-26T14:00:00.000Z",
      "2026-10-26T15:00:00.000Z",
    ]);
    expect(
      await utcSlots("2026-11-02T00:00:00Z", "2026-11-03T00:00:00Z"),
    ).toEqual([
      "2026-11-02T14:00:00.000Z",
      "2026-11-02T15:00:00.000Z",
      "2026-11-02T16:00:00.000Z",
    ]);
    // The repeated 01:00 resolves to its later (standard-time) occurrence:
    // 06:00Z to 10:00Z, four hours, four slots.
    expect(
      await utcSlots("2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z"),
    ).toEqual([
      "2026-11-01T06:00:00.000Z",
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T08:00:00.000Z",
      "2026-11-01T09:00:00.000Z",
    ]);
    // The skipped hour: 01:00 EST (06:00Z) to 05:00 EDT (09:00Z) is three
    // hours, so three slots, stepped in absolute minutes.
    expect(
      await utcSlots("2027-03-14T00:00:00Z", "2027-03-15T00:00:00Z"),
    ).toEqual([
      "2027-03-14T06:00:00.000Z",
      "2027-03-14T07:00:00.000Z",
      "2027-03-14T08:00:00.000Z",
    ]);
  });
});

describe("the database refuses a conflicting booking, and frees time it no longer holds", () => {
  it("refuses an overlapping booking, allows an adjacent one and the same time on another resource", async () => {
    // Arrange
    const date = localDate(3);
    await book({ startAt: saoPaulo(date, "09:00") }, "first");

    // Act / Assert
    expect(
      await rejection(book({ startAt: saoPaulo(date, "09:30") }, "overlap")),
    ).toMatchObject({ code: "invalid_state" });
    // 09:00-09:50 plus its 10-minute buffer holds until 10:00; 10:00 is free.
    expect(
      (await book({ startAt: saoPaulo(date, "10:00") }, "adjacent")).created,
    ).toBe(true);
    expect(
      (
        await book(
          {
            startAt: saoPaulo(date, "09:00"),
            resourceId: office.otherResourceId,
          },
          "other-resource",
        )
      ).created,
    ).toBe(true);
    expect(localTimes(await slotsOn(date))).toEqual(["11:00"]);
  });

  it("frees a cancelled booking's time, and refuses a raw overlapping insert even from the owner", async () => {
    // Arrange
    const date = localDate(3);
    const first = await book({ startAt: saoPaulo(date, "10:00") }, "cancel-me");

    // Act
    expect(
      await asOwner((tx) =>
        cancelBooking(
          tx,
          context(TENANT_A),
          first.bookingId,
          "patient_request",
        ),
      ),
    ).toBe("cancelled");
    expect(
      await asOwner((tx) =>
        cancelBooking(
          tx,
          context(TENANT_A),
          first.bookingId,
          "patient_request",
        ),
      ),
    ).toBe("already_cancelled");

    // Assert
    expect(localTimes(await slotsOn(date))).toEqual([
      "09:00",
      "10:00",
      "11:00",
    ]);
    await book({ startAt: saoPaulo(date, "10:00") }, "rebook");
    const raw = await rejection(
      admin.query(
        `insert into ops.bookings (tenant_id, company_id, department_id, resource_id, resource_slot_key,
                                   booking_type_id, start_at, end_at, buffer_before_minutes, buffer_after_minutes,
                                   occupied, timezone, subject_ref, source, idempotency_key, request_fingerprint,
                                   created_by)
         select $1, company_id, department_id, id, slot_key, $2, $3, $3, 0, 0, tstzrange($3, $3, '[]'),
                'America/Sao_Paulo', 'lead:SYN-raw', 'seed', 'raw-key', repeat('0', 64), 'dbtest'
           from ops.booking_resources where id = $4`,
        [TENANT_A, office.typeId, saoPaulo(date, "10:20"), office.resourceId],
      ),
    );
    expect(raw).toMatchObject({ code: "23P01" });
  });

  it("refuses a booking outside the resource's availability or in the past", async () => {
    const date = localDate(3);
    for (const startAt of [
      saoPaulo(date, "08:00"),
      saoPaulo(date, "11:30"),
      new Date(Date.now() - MINUTE),
    ]) {
      expect(
        await rejection(book({ startAt }, `outside-${startAt.getTime()}`)),
      ).toMatchObject({ code: "invalid_state" });
    }
  });

  it("lets exactly one of many owners racing for one time commit", async () => {
    // Arrange
    const startAt = saoPaulo(localDate(4), "11:00");

    // Act
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => book({ startAt }, `race-${i}`)),
    );

    // Assert
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(5);
    for (const failure of lost) {
      expect((failure as PromiseRejectedResult).reason).toMatchObject({
        code: "invalid_state",
      });
    }
    expect(await bookedCount()).toBe(1);
  });
});

describe("a reschedule is atomic, idempotent and safe under concurrency", () => {
  it("moves a booking to a free time as a chain, and replays by key", async () => {
    // Arrange
    const date = localDate(5);
    const first = await book({ startAt: saoPaulo(date, "09:00") }, "move-me");
    const ctx = context(TENANT_A);

    // Act
    const moved = await asOwner((tx) =>
      rescheduleBooking(
        tx,
        ctx,
        first.bookingId,
        saoPaulo(date, "11:00"),
        "mv-1",
      ),
    );
    const replay = await asOwner((tx) =>
      rescheduleBooking(
        tx,
        ctx,
        first.bookingId,
        saoPaulo(date, "11:00"),
        "mv-1",
      ),
    );

    // Assert
    expect(moved).toMatchObject({
      rescheduledFromId: first.bookingId,
      created: true,
    });
    expect(replay).toEqual({ ...moved, created: false });
    const { rows } = await admin.query<{ id: string; status: string }>(
      "select id, status from ops.bookings where resource_id = $1 order by start_at",
      [office.resourceId],
    );
    expect(rows).toEqual([
      { id: first.bookingId, status: "rescheduled" },
      { id: moved.bookingId, status: "booked" },
    ]);
    expect(localTimes(await slotsOn(date))).toEqual(["09:00", "10:00"]);
  });

  it("leaves the original booked, and nothing else, when the new time is taken", async () => {
    // Arrange
    const date = localDate(5);
    const first = await book({ startAt: saoPaulo(date, "09:00") }, "stay");
    await book({ startAt: saoPaulo(date, "10:00") }, "blocker");

    // Act
    const error = await rejection(
      asOwner((tx) =>
        rescheduleBooking(
          tx,
          context(TENANT_A),
          first.bookingId,
          saoPaulo(date, "10:00"),
          "mv-x",
        ),
      ),
    );

    // Assert
    expect(error).toMatchObject({ code: "invalid_state" });
    const { rows } = await admin.query<{ status: string; n: number }>(
      `select status, count(*)::int as n from ops.bookings
        where resource_id = $1 group by status`,
      [office.resourceId],
    );
    expect(rows).toEqual([{ status: "booked", n: 2 }]);
    const { rows: original } = await admin.query<{ status: string }>(
      "select status from ops.bookings where id = $1",
      [first.bookingId],
    );
    expect(original[0].status).toBe("booked");
  });

  it("can move a booking into its own former time range", async () => {
    const date = localDate(5);
    const first = await book({ startAt: saoPaulo(date, "10:00") }, "shift");
    const shifted = await asOwner((tx) =>
      rescheduleBooking(
        tx,
        context(TENANT_A),
        first.bookingId,
        saoPaulo(date, "10:30"),
        "mv-shift",
      ),
    );
    expect(shifted.created).toBe(true);
    expect(await bookedCount()).toBe(1);
  });

  it("leaves exactly one booked successor when two reschedules of one booking race", async () => {
    // Arrange
    const date = localDate(6);
    const first = await book({ startAt: saoPaulo(date, "09:00") }, "contested");
    const ctx = context(TENANT_A);

    // Act
    const results = await Promise.allSettled([
      asOwner((tx) =>
        rescheduleBooking(
          tx,
          ctx,
          first.bookingId,
          saoPaulo(date, "10:00"),
          "mv-a",
        ),
      ),
      asOwner((tx) =>
        rescheduleBooking(
          tx,
          ctx,
          first.bookingId,
          saoPaulo(date, "11:00"),
          "mv-b",
        ),
      ),
    ]);

    // Assert
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    expect(refused?.reason).toBeInstanceOf(CompanyOsError);
    expect((refused?.reason as CompanyOsError).code).toBe("invalid_state");
    expect(await bookedCount()).toBe(1);
    const { rows } = await admin.query<{ n: number }>(
      "select count(*)::int as n from ops.bookings where rescheduled_from_id = $1",
      [first.bookingId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("refuses to move or cancel a closed booking, and never deletes a booked one", async () => {
    const date = localDate(6);
    const first = await book({ startAt: saoPaulo(date, "09:00") }, "closed");
    const ctx = context(TENANT_A);
    const moved = await asOwner((tx) =>
      rescheduleBooking(
        tx,
        ctx,
        first.bookingId,
        saoPaulo(date, "11:00"),
        "mv-closed",
      ),
    );
    for (const attempt of [
      () =>
        asOwner((tx) =>
          cancelBooking(tx, ctx, first.bookingId, "patient_request"),
        ),
      () =>
        asOwner((tx) =>
          rescheduleBooking(
            tx,
            ctx,
            first.bookingId,
            saoPaulo(date, "10:00"),
            "mv-again",
          ),
        ),
    ]) {
      expect(await rejection(attempt())).toMatchObject({
        code: "invalid_state",
      });
    }
    expect(
      await rejection(
        admin.query("delete from ops.bookings where id = $1", [
          moved.bookingId,
        ]),
      ),
    ).toMatchObject({ code: "OS409" });
    expect(
      await rejection(
        admin.query(
          "update ops.bookings set start_at = start_at + interval '1 hour' where id = $1",
          [moved.bookingId],
        ),
      ),
    ).toMatchObject({ code: "OS409" });
  });
});

describe("bookings are idempotent and tenant-scoped", () => {
  it("returns the same booking for the same request under one key, and refuses a different one", async () => {
    const startAt = saoPaulo(localDate(7), "09:00");
    const first = await book({ startAt }, "same");
    expect(await book({ startAt }, "same")).toEqual({
      bookingId: first.bookingId,
      created: false,
    });
    expect(
      await rejection(
        book({ startAt: saoPaulo(localDate(7), "10:00") }, "same"),
      ),
    ).toMatchObject({ code: "invalid_state" });
    expect(await bookedCount()).toBe(1);
  });

  it("mirrors the database's booking state machine exactly", async () => {
    const { rows } = await admin.query<{
      from_status: string;
      to_status: string;
    }>("select from_status, to_status from ops.booking_status_transitions()");
    expect(rows.map((r) => [r.from_status, r.to_status])).toEqual(
      BOOKING_STATUS_TRANSITIONS.map(([a, b]) => [a, b]),
    );
  });

  it("answers not found for another tenant's resource, type and booking", async () => {
    // Arrange
    const startAt = saoPaulo(localDate(7), "11:00");
    const mine = await book({ startAt }, "tenant-a");
    const ctxB = context(TENANT_B);

    // Act / Assert
    for (const attempt of [
      () =>
        asOwner((tx) =>
          createBooking(tx, ctxB, {
            resourceId: office.resourceId,
            bookingTypeId: office.typeId,
            startAt: saoPaulo(localDate(7), "09:00"),
            subject: { subjectRef: "lead:SYN-B" },
            idempotencyKey: "b-on-a",
          }),
        ),
      () =>
        asOwner((tx) =>
          cancelBooking(tx, ctxB, mine.bookingId, "patient_request"),
        ),
      () =>
        asOwner((tx) =>
          rescheduleBooking(
            tx,
            ctxB,
            mine.bookingId,
            saoPaulo(localDate(7), "09:00"),
            "b-mv",
          ),
        ),
      () =>
        asOwner((tx) =>
          availableSlots(tx, TENANT_B, {
            resourceId: office.resourceId,
            bookingTypeId: office.typeId,
            from: new Date(),
            until: new Date(Date.now() + DAY),
          }),
        ),
      // Tenant B's type with tenant A's resource: not in the resource's company.
      () =>
        asOwner((tx) =>
          createBooking(tx, context(TENANT_A), {
            resourceId: office.resourceId,
            bookingTypeId: officeB.typeId,
            startAt: saoPaulo(localDate(7), "09:00"),
            subject: { subjectRef: "lead:SYN-X" },
            idempotencyKey: "cross-type",
          }),
        ),
    ]) {
      expect(await rejection(attempt())).toMatchObject({ code: "not_found" });
    }
    const { rows } = await admin.query<{ status: string }>(
      "select status from ops.bookings where id = $1",
      [mine.bookingId],
    );
    expect(rows[0].status).toBe("booked");
  });
});
