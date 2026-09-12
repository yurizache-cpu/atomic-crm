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

const DEFAULT_PORT = process.env.SUPABASE_DB_PORT ?? "54322";
const HOST = process.env.SUPABASE_DB_HOST ?? "127.0.0.1";
const DATABASE = process.env.SUPABASE_DB_NAME ?? "postgres";

/** Only ever used to build fixtures and to inspect results. Never by the runtime. */
export const ADMIN_URL =
  process.env.ADMIN_DATABASE_URL ??
  `postgresql://postgres:postgres@${HOST}:${DEFAULT_PORT}/${DATABASE}`;

export const WORKER_PASSWORD =
  process.env.OPS_WORKER_PASSWORD ?? "dbtest-worker-pw";

export const WORKER_URL =
  process.env.OPS_WORKER_DATABASE_URL ??
  `postgresql://ops_worker_login:${encodeURIComponent(WORKER_PASSWORD)}@${HOST}:${DEFAULT_PORT}/${DATABASE}`;

/**
 * Runs the real deployment script.
 *
 * Idempotent, so every suite may call it. Uses a direct admin connection rather
 * than `docker exec`, so the same call works locally and on a CI runner.
 */
export function provisionWorkerRole(): void {
  execFileSync("node", ["scripts/provision-worker-role.mjs"], {
    env: {
      ...process.env,
      ADMIN_DATABASE_URL: ADMIN_URL,
      OPS_WORKER_PASSWORD: WORKER_PASSWORD,
      SUPABASE_DB_CONTAINER: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

export function adminPool(): Pool {
  return new Pool({ connectionString: ADMIN_URL, max: 2 });
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
 * Creates the two tenants and clears anything a previous run left.
 *
 * Tenant A owns the local CRM; B deliberately does not, so "a tenant that may
 * not touch public.*" is a real case rather than a hypothetical one.
 */
export async function resetFixtures(admin: Pool): Promise<void> {
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
