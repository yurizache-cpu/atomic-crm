// The Phase 3A demonstration: a fictional clinic's agenda for the owner's
// Agenda screen, on a local database, run by the REAL worker loop.
//
//   npm run scheduling:demo
//
// with ADMIN_DATABASE_URL and OPS_WORKER_DATABASE_URL naming the same local
// database. LOCAL AND MANUAL ONLY, like lead-triage:demo; no CI job runs it.
// Run it once, on a freshly reset stack: it refuses while any job is queued or
// leased, because the worker loop leases the head of the whole queue.
//
// WHAT IT DOES, all synthetic (fictional agendas, opaque references such as
// lead:DEMO-001, no name, phone, email or message):
//   1. configures the tenant of the development seed's first active agent: the
//      scheduling zone America/Sao_Paulo, two fictional agendas, the booking
//      type "Atendimento inicial" (50 minutes, 10 minutes after), availability
//      every day 07:00-21:00, a SIMULATED calendar connection (the fake
//      provider; Google Calendar is not connected), and the demo follow-up
//      cadence of 3, 7 and 10 days (tenant data, not an engine constant);
//   2. books today's and the week's free slots through the real services,
//      cancels one and reschedules another;
//   3. schedules four follow-up plans whose first steps are already past due;
//   4. runs the worker loop until the queue drains: the governed follow-up
//      jobs mark those follow-ups due, and the calendar jobs mirror the
//      bookings to the fake calendar at their CURRENT times. The cancelled
//      booking is never mirrored. The moved booking's create is the fake's
//      third, which answers a scripted server error, so that sync is recorded
//      "incerta", nothing retries it, and its update is skipped;
//   5. completes one due follow-up and cancels another, as an operator would,
//      and schedules one more that is already due but, with the worker
//      stopped, waits for processing.
//
// NOTHING IS SENT. No message, model, decision service or real calendar is
// called; a due follow-up is operator work. Q8 stays open.

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { createFakeCalendarProvider } from "../calendar/fakeCalendarProvider.ts";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import {
  addAvailabilityRule,
  availableSlots,
  cancelBooking,
  createBooking,
  defineBookingResource,
  defineBookingType,
  rescheduleBooking,
  setSchedulingTimezone,
  type Slot,
} from "../domain/bookings.ts";
import { CompanyOsError } from "../domain/errors.ts";
import {
  cancelFollowUp,
  completeFollowUp,
  defineFollowUpPolicyVersion,
  scheduleFollowUpPlan,
} from "../domain/followUps.ts";
import type { SchedulingContext } from "../domain/schedulingCommon.ts";
import { createModelRouter } from "../models/router.ts";
import { createLogger } from "../worker/log.ts";
import { createHandlerRegistry } from "../worker/registry.ts";
import { runWorker } from "../worker/runWorker.ts";
import { loopbackDatabaseTarget } from "../worker/testSupport/localDatabase.ts";
import {
  ADMIN_DATABASE_URL,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  isEntryPoint,
  jsonLine,
} from "./cliOutput.ts";
import { queueIsBusy, readPlacement } from "./leadTriageDemo.ts";

const WORKER_DATABASE_URL = "OPS_WORKER_DATABASE_URL";
/** The demo's provenance label (allowlisted by ops.cos_event_source). */
const DEMO_SOURCE = "scheduling-demo";
const ZONE = "America/Sao_Paulo";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The demo cadence: 3, 7 and 10 days, as minutes. Tenant data. */
const DEMO_CADENCE = [72 * 60, 168 * 60, 240 * 60];
const POLICY = "cadencia-de-leads";
const MAX_WAIT_MS = 60_000;

const JOBS_LIVE_SQL =
  "select count(*)::int as n from ops.jobs where status in ('queued', 'leased') and available_at <= now()";
const DEPARTMENT_SQL =
  "select department_id from ops.agents where tenant_id = $1 and id = $2";

export interface SchedulingDemoDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly openDatabase: (connectionString: string) => WorkerDatabase;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** São Paulo's local date of an instant (UTC-3, no daylight saving since 2019). */
const localDate = (at: Date): string =>
  new Date(at.getTime() - 3 * HOUR).toISOString().slice(0, 10);

/** The instant a São Paulo local date starts. */
const dayStart = (date: string): Date => new Date(`${date}T00:00:00-03:00`);

interface Office {
  readonly companyId: string;
  readonly agendaA: string;
  readonly agendaB: string;
  readonly typeId: string;
}

async function configure(
  tx: TxClient,
  context: SchedulingContext,
  companyId: string,
  departmentId: string,
): Promise<Office> {
  await setSchedulingTimezone(tx, context, ZONE);
  const agenda = (key: string, label: string) =>
    defineBookingResource(tx, context, {
      companyId,
      departmentId,
      key,
      label,
      kind: "professional",
    });
  const agendaA = await agenda("agenda-a", "Agenda Profissional A (fictícia)");
  const agendaB = await agenda("agenda-b", "Agenda Profissional B (fictícia)");
  const typeId = await defineBookingType(tx, context, {
    companyId,
    key: "atendimento-inicial",
    label: "Atendimento inicial",
    durationMinutes: 50,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 10,
    slotStepMinutes: 60,
  });
  const from = localDate(new Date(Date.now() - DAY));
  for (const resourceId of [agendaA, agendaB]) {
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      await addAvailabilityRule(tx, context, {
        resourceId,
        weekday,
        localStart: "07:00",
        localEnd: "21:00",
        timezone: ZONE,
        effectiveFrom: from,
      });
    }
  }
  // A SIMULATED calendar: the fake provider mirrors each booking change.
  await tx.query(
    "select ops.configure_calendar_connection($1, $2, 'fake', 'Atendimento', true, $3)",
    [context.tenantId, companyId, context.actor],
  );
  await defineFollowUpPolicyVersion(tx, context, {
    policyKey: POLICY,
    label: "Cadência de leads (demonstração)",
    stepOffsetsMinutes: DEMO_CADENCE,
  });
  return { companyId, agendaA, agendaB, typeId };
}

async function bookTheWeek(
  owner: WorkerDatabase,
  context: SchedulingContext,
  office: Office,
  run: string,
): Promise<{ readonly booked: number }> {
  const slots = (resourceId: string, daysAhead: number) =>
    owner.withTransaction((tx) =>
      availableSlots(tx, context.tenantId, {
        resourceId,
        bookingTypeId: office.typeId,
        from:
          daysAhead === 0
            ? new Date(Date.now() + 5 * MINUTE)
            : dayStart(localDate(new Date(Date.now() + daysAhead * DAY))),
        until: dayStart(
          localDate(new Date(Date.now() + (daysAhead + 1) * DAY)),
        ),
        limit: 20,
      }),
    );
  let count = 0;
  const book = async (resourceId: string, slot: Slot | undefined) => {
    if (slot === undefined) return null;
    count += 1;
    return owner.withTransaction((tx) =>
      createBooking(tx, context, {
        resourceId,
        bookingTypeId: office.typeId,
        startAt: new Date(slot.startAt),
        subject: { subjectRef: `lead:DEMO-${String(count).padStart(3, "0")}` },
        idempotencyKey: `${run}:booking:${count}`,
      }),
    );
  };
  // Mid-morning and afternoon slots look like a clinic's day.
  const pick = (list: readonly Slot[], hour: number) =>
    list.find((s) => new Date(s.startAt).getUTCHours() - 3 >= hour) ?? list[0];

  const todayA = await slots(office.agendaA, 0);
  const todayB = await slots(office.agendaB, 0);
  await book(office.agendaA, todayA[0]);
  const toCancel = await book(office.agendaA, todayA[1]);
  await book(office.agendaB, todayB[0]);
  const toMove = await book(office.agendaB, todayB[1]);
  await book(office.agendaA, pick(await slots(office.agendaA, 1), 9));
  await book(office.agendaB, pick(await slots(office.agendaB, 2), 10));
  await book(office.agendaA, pick(await slots(office.agendaA, 4), 14));

  if (toCancel !== null) {
    await owner.withTransaction((tx) =>
      cancelBooking(tx, context, toCancel.bookingId, "patient_request"),
    );
  }
  if (toMove !== null) {
    const target = pick(await slots(office.agendaB, 3), 15);
    if (target !== undefined) {
      await owner.withTransaction((tx) =>
        rescheduleBooking(
          tx,
          context,
          toMove.bookingId,
          new Date(target.startAt),
          `${run}:move:1`,
        ),
      );
    }
  }
  return { booked: count };
}

export async function runSchedulingDemo(
  dependencies: SchedulingDemoDependencies,
): Promise<number> {
  const { env, stdout, stderr, openDatabase } = dependencies;
  const adminUrl = env[ADMIN_DATABASE_URL];
  const workerUrl = env[WORKER_DATABASE_URL];
  const ownerTarget = adminUrl ? loopbackDatabaseTarget(adminUrl) : undefined;
  const workerTarget = workerUrl
    ? loopbackDatabaseTarget(workerUrl)
    : undefined;
  if (!ownerTarget || !workerTarget || ownerTarget !== workerTarget) {
    stderr(
      jsonLine({
        error: "configuration",
        message: `${ADMIN_DATABASE_URL} and ${WORKER_DATABASE_URL} must both name the same database on this machine`,
      }),
    );
    return EXIT_USAGE;
  }

  const owner = openDatabase(adminUrl as string);
  const db = openDatabase(workerUrl as string);
  const controller = new AbortController();
  try {
    if (await owner.withTransaction(queueIsBusy)) {
      stderr(
        jsonLine({
          error: "queue_busy",
          message:
            "a job is queued or leased on this database; the demonstration's worker would lease it",
        }),
      );
      return EXIT_REFUSED;
    }
    const placement = await owner.withTransaction(readPlacement);
    const departmentId = await owner.withTransaction(async (tx) => {
      const { rows } = await tx.query<{ department_id: string }>(
        DEPARTMENT_SQL,
        [placement.tenantId, placement.agentId],
      );
      return rows[0]?.department_id as string;
    });
    const context: SchedulingContext = {
      tenantId: placement.tenantId,
      source: DEMO_SOURCE,
      actor: "scheduling-demo",
    };
    const run = `scheduling-demo:${randomUUID().slice(0, 8)}`;

    // 1. Configuration: tenant data, idempotent.
    const office = await owner.withTransaction((tx) =>
      configure(tx, context, placement.companyId, departmentId),
    );
    stdout(jsonLine({ step: "configured", timezone: ZONE }));

    // 2. The week's bookings, through the real services.
    const { booked } = await bookTheWeek(owner, context, office, run);
    stdout(jsonLine({ step: "booked", bookings: booked }));

    // 3. Follow-up plans whose first steps are already due.
    const plan = (ref: string, anchorAt: Date) =>
      owner.withTransaction((tx) =>
        scheduleFollowUpPlan(tx, context, {
          companyId: placement.companyId,
          departmentId,
          policyKey: POLICY,
          anchorAt,
          subject: { subjectRef: `lead:${ref}` },
          idempotencyKey: `${run}:plan:${ref}`,
        }),
      );
    const now = Date.now();
    const overdue = await plan("DEMO-101", new Date(now - 8 * DAY));
    await plan("DEMO-102", new Date(now - 3 * DAY + 2 * HOUR));
    await plan("DEMO-103", new Date(now - 3 * DAY - HOUR));
    const replied = await plan("DEMO-104", new Date(now - 4 * DAY));
    stdout(jsonLine({ step: "follow_ups_scheduled", plans: 4 }));

    // 4. The real worker loop: governed follow-up jobs and calendar syncs.
    let creates = 0;
    const calendar = createFakeCalendarProvider({
      script: (call) =>
        call.operation === "create" && ++creates === 3 ? "server_error" : "ok",
    });
    const worker = runWorker({
      workerId: `scheduling-demo-${hostname()}-${process.pid}`,
      db,
      registry: createHandlerRegistry({
        modelRouter: createModelRouter({
          routes: new Map(),
          providers: new Map(),
        }),
        calendarPort: calendar,
      }),
      signal: controller.signal,
      pollIntervalMs: 200,
      reapIntervalMs: 2_000,
      heartbeatIntervalMs: 5_000,
      log: createLogger(() => {}),
    });
    const startedAt = Date.now();
    for (;;) {
      await sleep(1_000);
      const { rows } = await owner.withTransaction((tx) =>
        tx.query<{ n: number }>(JOBS_LIVE_SQL, []),
      );
      if (Number(rows[0]?.n ?? 0) === 0 || Date.now() - startedAt > MAX_WAIT_MS)
        break;
    }
    controller.abort();
    await worker;
    stdout(jsonLine({ step: "worked", calendarCalls: calendar.calls.length }));

    // 5. An operator's acts, and one follow-up left waiting for the worker.
    const firstStep = async (planId: string) => {
      const { rows } = await owner.withTransaction((tx) =>
        tx.query<{ id: string }>(
          "select id from ops.follow_ups where plan_id = $1 and step_number = 1",
          [planId],
        ),
      );
      return rows[0].id;
    };
    await owner.withTransaction(async (tx) =>
      completeFollowUp(tx, context, await firstStep(overdue.planId)),
    );
    await owner.withTransaction(async (tx) =>
      cancelFollowUp(
        tx,
        context,
        await firstStep(replied.planId),
        "lead_replied",
      ),
    );
    await plan("DEMO-105", new Date(Date.now() - 3 * DAY - 5 * MINUTE));

    const summary = await owner.withTransaction(async (tx) => {
      const { rows } = await tx.query<{ agenda: Record<string, unknown> }>(
        "select ops.cos_agenda($1, now()) as agenda",
        [placement.tenantId],
      );
      const agenda = rows[0].agenda as {
        bookings: Record<string, unknown>;
        followUps: Record<string, unknown>;
        calendar: Record<string, unknown>;
      };
      return {
        todayBooked: agenda.bookings.todayBooked,
        next7DaysBooked: agenda.bookings.next7DaysBooked,
        followUpsDue: agenda.followUps.due,
        followUpsOverdue: agenda.followUps.overdue,
        followUpsAwaitingProcessing: agenda.followUps.awaitingProcessing,
        calendar: agenda.calendar,
      };
    });
    stdout(
      jsonLine({
        step: "summary",
        ...summary,
        messagesSent: 0,
        note: "a due follow-up is operator work; nothing was sent, and Google Calendar is not connected",
      }),
    );
    return EXIT_OK;
  } catch (error) {
    stderr(
      jsonLine({
        error: error instanceof CompanyOsError ? error.code : "unexpected",
        message:
          error instanceof Error ? error.message : "the demonstration failed",
      }),
    );
    return EXIT_REFUSED;
  } finally {
    controller.abort();
    await db.close();
    await owner.close();
  }
}

if (await isEntryPoint(import.meta.url)) {
  process.exitCode = await runSchedulingDemo({
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    openDatabase: (connectionString) =>
      createWorkerDatabase({ connectionString, max: 4 }),
  });
}
