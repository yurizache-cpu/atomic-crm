// The browser trip under concurrency and contention (S7.2; docs/PHASE_2C_BRIEF.md
// §9 row 17, the trip coordinates table; owner decision S0-B), over the real
// `pg` driver on separate connections.
//
// company_os_api.trip_stop reaches ops.trip_stop_in_tenant through its identity
// gate, which sets lock_timeout = '2s' and maps a lock timeout to the one
// retryable refusal, OS429. The callee always calls the AUTHORITATIVE
// ops.trip_execution_stop, which takes the kill-switch lock exclusively and
// answers an existing active stop at the same coordinates with that stop. So:
//
//   - two trips of the same target at once: the first records the stop, the
//     second waits on the kill-switch lock and then answers already_stopped
//     with the same stop; one row;
//   - the same principal tripping again later: already_stopped, same stop;
//   - a member's trip through the gate while another session holds the lock:
//     OS429 with the contract's fixed text after about the bound, nothing
//     created, and the holder undisturbed;
//   - no trip writes an event, a job, a run or an outbound row.
//
// The concurrency cases call the callee directly, as the gate does once the
// member is resolved (the identity cases are supabase/tests/company_os_api.sql,
// sections I and W, and the live probe). Every target is in tenant B, which no
// other suite holds a row lock on (companyOsStopLock.dbtest.ts, "A SHARED
// STACK"); the member's own session lends it the local-CRM flag inside a
// transaction that is always rolled back. All data is synthetic.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import {
  ADMIN_URL,
  TENANT_B,
  adminPool,
  assertTargetDatabase,
  cleanupFixtures,
  resetFixtures,
} from "../worker/testSupport/dbFixture.ts";
import {
  memberIdentity,
  signInAsMember,
} from "./testSupport/companyOsMember.ts";

const SOURCE = "dbtest-execution-stop";
const PRINCIPAL_A = "principal:00000000-0000-4000-8000-0000000000a1";
const PRINCIPAL_B = "principal:00000000-0000-4000-8000-0000000000b2";
const FIXED_REASON = "owner requested execution stop via Company OS";
const BOUND_MS = 2_000;
/** What a slow machine may add around the bound; it never shortens the wait. */
const SLACK_MS = 3_000;

let admin: Pool;
/** The racing and holding connections: apart from admin, which watches and reads. */
let racers: Pool;

beforeAll(async () => {
  admin = adminPool();
  racers = new Pool({
    connectionString: ADMIN_URL,
    max: 2,
    statement_timeout: 15_000,
  });
  await assertTargetDatabase(admin);
});

afterAll(async () => {
  await racers?.end();
  await cleanupFixtures(admin);
  await admin?.end();
});

beforeEach(async () => {
  await resetFixtures(admin);
});

/** A committed company, department and agent in tenant B. */
async function buildOffice(): Promise<{
  company: string;
  department: string;
  agent: string;
}> {
  const one = async (sql: string, params: unknown[]) =>
    (await admin.query<{ v: string }>(sql, params)).rows[0].v;
  const company = await one(
    "select ops.create_company($1, 'dbtest-stop-clinic', 'Clinic', $2) as v",
    [TENANT_B, SOURCE],
  );
  const department = await one(
    "select ops.create_department($1, $2, 'intake', 'Intake', $3) as v",
    [TENANT_B, company, SOURCE],
  );
  const agent = await one(
    `select ops.create_agent($1, $2, $3, 'stop-agent', 'Stop Agent',
                             'Synthetic role', $4, 'Synthetic agent a member stops.') as v`,
    [TENANT_B, company, department, SOURCE],
  );
  return { company, department, agent };
}

const TRIP = "select ops.trip_stop_in_tenant($1, $2, $3, $4)::text as body";

interface TripBody {
  readonly stopId: string;
  readonly outcome: "stopped" | "already_stopped";
}

async function trip(
  client: Pool | PoolClient,
  actor: string,
  scope: string,
  target: string | null,
): Promise<TripBody> {
  const { rows } = await client.query<{ body: string }>(TRIP, [
    TENANT_B,
    actor,
    scope,
    target,
  ]);
  return JSON.parse(rows[0].body) as TripBody;
}

/** The backend process of `client`, to watch it in pg_stat_activity. */
async function backendPid(client: PoolClient): Promise<number> {
  return (await client.query<{ pid: number }>("select pg_backend_pid() as pid"))
    .rows[0].pid;
}

/** Resolves once backend `pid` is waiting on a lock. */
async function untilBlocked(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await admin.query<{ waiting: boolean }>(
      "select coalesce(wait_event_type = 'Lock', false) as waiting from pg_stat_activity where pid = $1",
      [pid],
    );
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the second trip never waited on the kill-switch lock");
}

/** Tenant B's stops, and everything a trip must never write. */
async function tenantState() {
  const { rows } = await admin.query<{
    stops: {
      id: string;
      scope: string;
      department_id: string | null;
      tripped_by: string;
      origin: string;
      reason: string;
    }[];
    events: number;
    jobs: number;
    runs: number;
    outbound: number;
  }>(
    `select coalesce((select jsonb_agg(jsonb_build_object(
                        'id', s.id, 'scope', s.scope, 'department_id', s.department_id,
                        'tripped_by', s.tripped_by, 'origin', s.origin, 'reason', s.reason)
                        order by s.tripped_at, s.id)
                        from ops.execution_stops s
                       where s.tenant_id = $1 and s.cleared_at is null), '[]'::jsonb) as stops,
            (select count(*)::int from ops.events e where e.tenant_id = $1) as events,
            (select count(*)::int from ops.jobs j where j.tenant_id = $1) as jobs,
            (select count(*)::int from ops.agent_runs r where r.tenant_id = $1) as runs,
            (select count(*)::int from ops.outbound_messages o where o.tenant_id = $1) as outbound`,
    [TENANT_B],
  );
  return rows[0];
}

describe("the browser trip under concurrency", () => {
  it("two members tripping the same target at once record one stop: one stopped, one already_stopped", async () => {
    const { department } = await buildOffice();
    const before = await tenantState();
    const c1 = await racers.connect();
    const c2 = await racers.connect();
    try {
      await c1.query("begin");
      const first = await trip(c1, PRINCIPAL_A, "department", department);
      expect(first.outcome).toBe("stopped");

      const pid2 = await backendPid(c2);
      await c2.query("begin");
      const pending = trip(c2, PRINCIPAL_B, "department", department);
      await untilBlocked(pid2);
      await c1.query("commit");
      const second = await pending;
      await c2.query("commit");

      expect(second).toMatchObject({
        outcome: "already_stopped",
        stopId: first.stopId,
      });
    } finally {
      await c1.query("rollback").catch(() => undefined);
      await c2.query("rollback").catch(() => undefined);
      c1.release();
      c2.release();
    }

    const after = await tenantState();
    expect(after.stops).toHaveLength(before.stops.length + 1);
    expect(after.stops.filter((s) => s.department_id === department)).toEqual([
      expect.objectContaining({
        scope: "department",
        tripped_by: PRINCIPAL_A,
        origin: "owner",
        reason: FIXED_REASON,
      }),
    ]);
    expect(after).toMatchObject({
      events: before.events,
      jobs: before.jobs,
      runs: before.runs,
      outbound: before.outbound,
    });
  });

  it("answers the same principal's later trip of the same target as already_stopped, on the same stop", async () => {
    const { agent } = await buildOffice();

    const first = await trip(admin, PRINCIPAL_A, "agent", agent);
    const again = await trip(admin, PRINCIPAL_A, "agent", agent);

    expect(first.outcome).toBe("stopped");
    expect(again).toMatchObject({
      outcome: "already_stopped",
      stopId: first.stopId,
    });
    const { stops } = await tenantState();
    expect(stops.filter((s) => s.id === first.stopId)).toHaveLength(1);
  });

  it("a member's trip under contention answers OS429 within about the bound and creates nothing", async () => {
    const { company } = await buildOffice();
    const before = await tenantState();
    const holder = await racers.connect();
    const member = await racers.connect();
    try {
      await holder.query("begin");
      await holder.query(
        "select pg_advisory_xact_lock(ops.execution_stop_lock_key())",
      );

      await member.query("begin");
      // Tenant B: its own row is the member's, so only the kill-switch lock
      // can hold the trip.
      await signInAsMember(member, TENANT_B, memberIdentity());
      const started = performance.now();
      const refusal = await member
        .query("select company_os_api.trip_stop('company', $1)", [company])
        .then(
          () => null,
          (error: {
            code?: string;
            message?: string;
            detail?: string;
            hint?: string;
          }) => error,
        );
      const waited = performance.now() - started;

      expect(refusal).toMatchObject({
        code: "OS429",
        message: "company_os_api.trip_stop: could not be completed yet; retry",
      });
      expect(refusal?.detail ?? "").toBe("");
      expect(refusal?.hint ?? "").toBe("");
      expect(waited).toBeGreaterThanOrEqual(BOUND_MS - 100);
      expect(waited).toBeLessThan(BOUND_MS + SLACK_MS);
      // The holder is undisturbed: its transaction still holds the lock.
      const { rows } = await holder.query<{ ok: number }>("select 1 as ok");
      expect(rows[0].ok).toBe(1);
    } finally {
      await member.query("rollback").catch(() => undefined);
      await holder.query("rollback").catch(() => undefined);
      member.release();
      holder.release();
    }

    expect(await tenantState()).toEqual(before);
  });
});
