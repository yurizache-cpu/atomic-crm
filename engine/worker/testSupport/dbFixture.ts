// Shared setup for the `*.dbtest.ts` suites, which run against a REAL Postgres.
//
// These are not unit tests with a database attached. They exist because §5 of
// the Phase 1B brief is explicit that the SQL harness does not prove the
// application driver's pooling behaviour — so everything here goes through the
// same `pg` Pool and the same adapter the production worker uses.
//
// The worker connects as the role a deployment would create, provisioned by the
// real script rather than by a shortcut here: if `provision-worker-role.mjs`
// breaks, these suites must fail.

import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { createWorkerDatabase } from "../../db/workerDatabase.ts";
import type { WorkerDatabase } from "../../db/types.ts";
import {
  deleteFixtureGovernance,
  recordGovernance,
  type FixtureGovernance,
  type GovernanceOptions,
} from "./governanceFixture.ts";
import { assertLocalTestDatabases } from "./localDatabase.ts";

export {
  deleteFixtureGovernance,
  FIXTURE_GLOBAL_LIMIT_MICROS,
  FIXTURE_MODELS,
  FIXTURE_PROVIDER,
  FIXTURE_TENANT_LIMIT_MICROS,
  type FixtureGovernance,
  type GovernanceOptions,
} from "./governanceFixture.ts";

const DEFAULT_PORT = process.env.SUPABASE_DB_PORT ?? "54322";
const HOST = process.env.SUPABASE_DB_HOST ?? "127.0.0.1";
const DATABASE = process.env.SUPABASE_DB_NAME ?? "postgres";

/** Only ever used to build fixtures and to inspect results. Never by the runtime. */
export const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ??
  `postgresql://postgres:postgres@${HOST}:${DEFAULT_PORT}/${DATABASE}`;

export const WORKER_PASSWORD =
  process.env.OPS_WORKER_PASSWORD ?? "dbtest-worker-pw";

/**
 * `OPS_WORKER_DATABASE_URL` is also the PRODUCTION worker's variable, so a shell
 * that exports it for `npm run worker` would otherwise point these suites'
 * workers — which lease the head of the whole queue and answer agent runs with
 * canned model output — at that deployment, or at the other working copy's
 * stack. Checked when this module loads, before anything provisions, connects
 * or spawns a process.
 */
export const WORKER_URL =
  process.env.OPS_WORKER_DATABASE_URL ??
  `postgresql://ops_worker_login:${encodeURIComponent(WORKER_PASSWORD)}@${HOST}:${DEFAULT_PORT}/${DATABASE}`;

assertLocalTestDatabases(ADMIN_URL, WORKER_URL);

/**
 * Runs the real deployment script.
 *
 * Idempotent, so every suite may call it. If `provision-worker-role.mjs` breaks,
 * these suites must fail — that is the point of using it rather than a shortcut.
 *
 * Two paths, because `psql` is on PATH on a CI runner and generally is not on a
 * developer's Windows machine: set `SUPABASE_DB_CONTAINER` and the script goes
 * through `docker exec`; leave it unset and it uses `ADMIN_DATABASE_URL`.
 */
export function provisionWorkerRole(): void {
  const container = process.env.SUPABASE_DB_CONTAINER;
  execFileSync("node", ["scripts/provision-worker-role.mjs"], {
    env: {
      ...process.env,
      ADMIN_DATABASE_URL: ADMIN_URL,
      OPS_WORKER_PASSWORD: WORKER_PASSWORD,
      ...(container ? { SUPABASE_DB_CONTAINER: container } : {}),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

/** The migration that must be applied for any of these suites to mean anything. */
const REQUIRED_MIGRATION = "20260917120000";

/**
 * Refuses to run against the wrong database.
 *
 * This repository has TWO Supabase stacks on one machine: the default
 * `atomic-crm-demo` on 54322, which belongs to a second working copy, and the
 * isolated `atomic-crm-e2e` on 54342. The default port here is 54322 because
 * that is correct in CI, where only one stack exists — which means a developer
 * who forgets `SUPABASE_DB_PORT` points these suites at someone else's database.
 *
 * Without this check the symptom would be a confusing cascade of "relation
 * ops.jobs does not exist". With it, the first failure says what is wrong.
 */
export async function assertTargetDatabase(admin: Pool): Promise<void> {
  const { rows } = await admin.query<{ version: string | null }>(
    `select max(version) as version from supabase_migrations.schema_migrations`,
  );
  const applied = rows[0]?.version ?? "none";
  if (applied < REQUIRED_MIGRATION) {
    throw new Error(
      `Refusing to run: ${ADMIN_URL.replace(/:[^:@/]*@/, ":***@")} is at migration ${applied}, ` +
        `but ${REQUIRED_MIGRATION} (Phase 1D.1 runtime governance: prices, spend limits and the lease-time kill switch) is required. ` +
        "This is almost certainly the wrong stack — the isolated e2e stack is on port 54342 " +
        "(npx supabase start --workdir .supabase-e2e), and 54322 is the other working copy's " +
        "atomic-crm-demo. Set SUPABASE_DB_PORT.",
    );
  }
}

/**
 * The fixture's own connection. Never the runtime's.
 *
 * `statement_timeout` is not tuning: a fixture query that blocks on a row lock
 * held by an open worker transaction waits FOREVER, and Postgres reports
 * nothing — the worker side is waiting on the application, not on a lock, so
 * the deadlock detector has nothing to detect. That shape hung a 10-minute test
 * run to no purpose. A timeout turns it into a failing test with a legible
 * error, which is what a harness should do with a mistake in itself.
 */
export function adminPool(): Pool {
  return new Pool({
    connectionString: ADMIN_URL,
    max: 2,
    statement_timeout: 15_000,
  });
}

/**
 * The worker's database, over the real adapter.
 *
 * `max: 1` in the pooling suite is what makes connection REUSE certain rather
 * than likely: with one socket, the second transaction provably runs on the
 * connection the first one used.
 */
export function workerDatabase(max = 4): WorkerDatabase {
  return createWorkerDatabase({ connectionString: WORKER_URL, max });
}

export const TENANT_A = "a0000000-0000-4000-8000-00000000000a";
export const TENANT_B = "b0000000-0000-4000-8000-00000000000b";

/**
 * Removes every Company OS row of the given tenants, in foreign-key order.
 *
 * Every Company OS table references ops.tenants ON DELETE RESTRICT, and
 * ops.task_jobs references ops.jobs the same way — so ONE leftover company,
 * event or link would make the next suite's `delete from ops.tenants` (or
 * `delete from ops.jobs`) fail with 23503, and the single-fork engine run would
 * go red in a file that never touched the domain. Self-referencing rows (a
 * task's parent, a run's retry parent) go in one statement, which the foreign
 * key allows.
 *
 * Agent runs go FIRST: a run references its job, task, agent and the stop that
 * refused it, all ON DELETE RESTRICT. Execution stops go before the
 * organisation they target. An ACTIVE stop is never deleted (an ENABLE ALWAYS
 * trigger refuses it), so a stop a failed test left active is cleared first,
 * recorded on the row as dbtest cleanup, the way an owner clears one.
 *
 * The tenants' spend limits go after the runs (a budget refusal names its
 * limit) and before the companies and tenants they target. An ACTIVE limit is
 * never deleted either, so it is ended first, the way an owner retires one.
 */
export async function deleteCompanyOsRows(
  admin: Pool,
  tenantIds: readonly string[],
): Promise<void> {
  for (const statement of [
    // Phase 3A.1: open follow-up work is cancelled, never deleted (an ENABLE
    // ALWAYS trigger refuses it), so what a test left open is closed first, the
    // way an owner cancels it; the closed rows are then history the owner may
    // delete. Occurrences go before their plans, and both before the tasks,
    // conversations and jobs they reference.
    `select ops.cancel_follow_up_plan(p.tenant_id, p.id, 'dbtest_cleanup', 'dbtest', 'seed')
       from ops.follow_up_plans p
      where p.tenant_id = any($1::uuid[]) and p.status = 'active'`,
    `select ops.cancel_follow_up(f.tenant_id, f.id, 'dbtest_cleanup', 'dbtest', 'seed')
       from ops.follow_ups f
      where f.tenant_id = any($1::uuid[]) and f.status in ('scheduled', 'due')`,
    "delete from ops.follow_ups where tenant_id = any($1::uuid[])",
    "delete from ops.follow_up_plans where tenant_id = any($1::uuid[])",
    "delete from ops.follow_up_policy_versions where tenant_id = any($1::uuid[])",
    "delete from ops.follow_up_policies where tenant_id = any($1::uuid[])",
    // Phase 3A.2: a booked booking is cancelled, never deleted, the same way;
    // then the closed chain goes in one statement (a successor references its
    // predecessor), before the configuration and the units it references.
    `select ops.cancel_booking(b.tenant_id, b.id, 'dbtest_cleanup', 'dbtest', 'seed')
       from ops.bookings b
      where b.tenant_id = any($1::uuid[]) and b.status = 'booked'`,
    "delete from ops.bookings where tenant_id = any($1::uuid[])",
    "delete from ops.availability_rules where tenant_id = any($1::uuid[])",
    "delete from ops.booking_types where tenant_id = any($1::uuid[])",
    "delete from ops.booking_resources where tenant_id = any($1::uuid[])",
    "delete from ops.scheduling_settings where tenant_id = any($1::uuid[])",
    // Phase 2B's sends reference reviews, conversations and channels, and
    // Phase 2A's two tables reference companies and tasks, all with ON DELETE
    // RESTRICT, so they go before the runs whose settlement derived them.
    "delete from ops.outbound_messages where tenant_id = any($1::uuid[])",
    // Phase 2D.1's shadow decisions reference the reviews they evaluated.
    "delete from ops.decision_evaluations where tenant_id = any($1::uuid[])",
    "delete from ops.review_items where tenant_id = any($1::uuid[])",
    "delete from ops.inbound_messages where tenant_id = any($1::uuid[])",
    "delete from ops.conversations where tenant_id = any($1::uuid[])",
    "delete from ops.communication_channels where tenant_id = any($1::uuid[])",
    "delete from ops.agent_runs where tenant_id = any($1::uuid[])",
    "delete from ops.task_jobs where tenant_id = any($1::uuid[])",
    "delete from ops.events where tenant_id = any($1::uuid[])",
    `update ops.execution_stops
        set cleared_by = 'dbtest', cleared_reason = 'dbtest cleanup'
      where tenant_id = any($1::uuid[]) and cleared_at is null`,
    "delete from ops.execution_stops where tenant_id = any($1::uuid[])",
    `update ops.spend_limits
        set ended_by = 'dbtest', end_reason = 'dbtest cleanup'
      where tenant_id = any($1::uuid[]) and ended_at is null`,
    "delete from ops.spend_limits where tenant_id = any($1::uuid[])",
    "delete from ops.tasks where tenant_id = any($1::uuid[])",
    "delete from ops.agents where tenant_id = any($1::uuid[])",
    "delete from ops.departments where tenant_id = any($1::uuid[])",
    "delete from ops.companies where tenant_id = any($1::uuid[])",
  ]) {
    await admin.query(statement, [tenantIds]);
  }
}

/**
 * The tenant-less stops these suites create: a global stop or an all-tenant
 * job_kind stop whose reason starts with `dbtest`, and any stop the spend
 * ceiling sweep tripped (`system:spend_ceiling`, which a worker's reaper tick
 * trips on its own once a suite exhausts a ceiling). The ceiling's stops are
 * taken whatever their reason, because the database writes it: this fixture
 * already refuses any database that is not on this machine.
 */
const FIXTURE_STOPS = `(
     (scope in ('global', 'job_kind') and tenant_id is null and reason like 'dbtest%')
  or tripped_by = 'system:spend_ceiling')`;

/**
 * Removes the tenant-less execution stops these suites trip.
 *
 * Such a stop has no tenant, so deleteCompanyOsRows cannot reach it. Delete the
 * runs that name one first (they belong to a fixture tenant). Not optional: a
 * global stop left active holds every external job on this database, in every
 * later suite, and a kind stop holds every job of its kind.
 */
export async function deleteFixtureStops(admin: Pool): Promise<void> {
  await admin.query(
    `update ops.execution_stops
        set cleared_by = 'dbtest', cleared_reason = 'dbtest cleanup'
      where ${FIXTURE_STOPS} and cleared_at is null`,
  );
  await admin.query(`delete from ops.execution_stops where ${FIXTURE_STOPS}`);
}

/**
 * What a run needs to start (ADR 0017): a current price for its provider and
 * model, a global ceiling and its tenants' budgets, by default for TENANT_A and
 * TENANT_B. See recordGovernance for exactly what it records and retires.
 */
export function configureGovernance(
  admin: Pool,
  options: Partial<GovernanceOptions> = {},
): Promise<FixtureGovernance> {
  return recordGovernance(admin, {
    ...options,
    tenantIds: options.tenantIds ?? [TENANT_A, TENANT_B],
  });
}

/**
 * Creates the two tenants and clears anything a previous run left.
 *
 * Tenant A owns the local CRM; B deliberately does not, so "a tenant that may
 * not touch public.*" is a real case rather than a hypothetical one. Both get
 * the governance a run needs to start, whose ids it resolves to.
 */
export async function resetFixtures(admin: Pool): Promise<FixtureGovernance> {
  await assertTargetDatabase(admin);
  await deleteCompanyOsRows(admin, [TENANT_A, TENANT_B]);
  await deleteFixtureStops(admin);
  await deleteFixtureGovernance(admin);
  await admin.query(
    `delete from ops.job_events where tenant_id = any($1::uuid[])`,
    [[TENANT_A, TENANT_B]],
  );
  await admin.query(`delete from ops.jobs where tenant_id = any($1::uuid[])`, [
    [TENANT_A, TENANT_B],
  ]);
  await admin.query(
    `delete from ops.worker_instances where worker_id like 'dbtest-%'`,
  );
  await admin.query(`update ops.tenants set owns_local_crm = false`);
  await admin.query(
    `insert into ops.tenants (id, slug, name, owns_local_crm) values
       ($1, 'dbtest-a', 'DB test tenant A', true),
       ($2, 'dbtest-b', 'DB test tenant B', false)
     on conflict (id) do update
       set owns_local_crm = excluded.owns_local_crm, slug = excluded.slug`,
    [TENANT_A, TENANT_B],
  );
  return configureGovernance(admin);
}

/**
 * Removes everything these suites created. Call it from `afterAll`.
 *
 * Not optional hygiene. `ops.jobs` is shared, and the SQL suites in
 * `supabase/tests/` assert on counts across the WHOLE table — one leased row
 * left behind by a driver-backed suite made `jobLeasingConcurrency.mjs` report
 * "12 workers leased 11 jobs from a queue of 6". CI happens to reset the
 * database between the two, which would have hidden this; a local run does not.
 */
export async function cleanupFixtures(admin: Pool | undefined): Promise<void> {
  // `afterAll` runs even when `beforeAll` threw, and then there is no pool.
  // Without this the real failure (a database that could not be reached) was
  // buried under "Cannot read properties of undefined (reading 'query')".
  if (!admin) return;
  await deleteCompanyOsRows(admin, [TENANT_A, TENANT_B]);
  await deleteFixtureStops(admin);
  await deleteFixtureGovernance(admin);
  await admin.query(
    `delete from ops.job_events where tenant_id = any($1::uuid[])`,
    [[TENANT_A, TENANT_B]],
  );
  await admin.query(`delete from ops.jobs where tenant_id = any($1::uuid[])`, [
    [TENANT_A, TENANT_B],
  ]);
  await admin.query(
    `delete from ops.worker_instances where worker_id like 'dbtest-%'`,
  );
  await admin.query(`delete from ops.tenants where id = any($1::uuid[])`, [
    [TENANT_A, TENANT_B],
  ]);
  await clearLedger(admin);
}

/** Enqueues as service_role would: through the one function that may create work. */
export async function enqueue(
  admin: Pool,
  tenantId: string,
  kind: string,
  payload: Record<string, unknown> = {},
  options: { maxAttempts?: number; idempotencyKey?: string } = {},
): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `select ops.enqueue_job($1, $2, $3::jsonb, 100, now(), $4, $5) as id`,
    [
      tenantId,
      kind,
      JSON.stringify(payload),
      options.maxAttempts ?? 5,
      options.idempotencyKey ?? null,
    ],
  );
  return rows[0].id;
}

export interface JobRow {
  id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  last_error_class: string | null;
  available_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
}

export async function readJob(admin: Pool, id: string): Promise<JobRow> {
  const { rows } = await admin.query<JobRow>(
    `select id, status, attempts, max_attempts, last_error, last_error_class,
            available_at, lease_owner, lease_expires_at
       from ops.jobs where id = $1`,
    [id],
  );
  return rows[0];
}

/** Seeds resolved ledger rows old enough for the retention window to catch. */
export async function seedLedger(
  admin: Pool,
  rows: { ageDays: number; status: string; messageId: string }[],
): Promise<void> {
  for (const row of rows) {
    await admin.query(
      `insert into public.inbound_emails
         (message_id, recipient_email, status, attempts, payload, received_at, processed_at)
       values ($1, $2, $3, 1, '{}'::jsonb, now() - make_interval(days => $4), now())
       on conflict (message_id, recipient_email) do nothing`,
      [
        row.messageId,
        `${row.messageId}@dbtest.invalid`,
        row.status,
        row.ageDays,
      ],
    );
  }
}

export async function clearLedger(admin: Pool): Promise<void> {
  await admin.query(
    `delete from public.inbound_emails where message_id like 'dbtest-%'`,
  );
}

export async function countLedger(admin: Pool): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    `select count(*)::text as n from public.inbound_emails where message_id like 'dbtest-%'`,
  );
  return Number(rows[0].n);
}
