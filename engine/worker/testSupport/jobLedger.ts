// What the database holds about one job, for the kill switch suites: its lease
// columns and its lifecycle events, read on the fixture's admin pool (which
// dbFixture.ts refuses to open on any database that is not on this machine).

import type { Pool } from "pg";

export interface JobEventRow {
  readonly event: string;
  readonly workerId: string | null;
  readonly attempt: number | null;
  readonly detail: string | null;
}

/** The job's events, oldest first. */
export async function jobEvents(
  admin: Pool,
  jobId: string,
): Promise<JobEventRow[]> {
  const { rows } = await admin.query<{
    event: string;
    worker_id: string | null;
    attempt: number | null;
    detail: string | null;
  }>(
    `select event, worker_id, attempt, detail
       from ops.job_events where job_id = $1
      order by created_at, id`,
    [jobId],
  );
  return rows.map((row) => ({
    event: row.event,
    workerId: row.worker_id,
    attempt: row.attempt,
    detail: row.detail,
  }));
}

export interface JobLease {
  readonly status: string;
  readonly attempts: number;
  readonly leaseOwner: string | null;
  readonly leasedAt: Date | null;
  readonly leaseExpiresAt: Date | null;
  /** available_at as the database's text, so two reads compare exactly. */
  readonly availableAt: string;
  /** available_at minus updated_at, in seconds: the delay the last write set. */
  readonly delaySeconds: number;
  /** available_at minus the database's clock now, in seconds. */
  readonly dueInSeconds: number;
}

export async function readJobLease(
  admin: Pool,
  jobId: string,
): Promise<JobLease> {
  const { rows } = await admin.query<{
    status: string;
    attempts: number;
    lease_owner: string | null;
    leased_at: Date | null;
    lease_expires_at: Date | null;
    available_at: string;
    delay_seconds: string;
    due_in_seconds: string;
  }>(
    `select status, attempts, lease_owner, leased_at, lease_expires_at,
            available_at::text as available_at,
            extract(epoch from available_at - updated_at)::text as delay_seconds,
            extract(epoch from available_at - clock_timestamp())::text as due_in_seconds
       from ops.jobs where id = $1`,
    [jobId],
  );
  const row = rows[0];
  if (!row) throw new Error("the job under test does not exist");
  return {
    status: row.status,
    attempts: row.attempts,
    leaseOwner: row.lease_owner,
    leasedAt: row.leased_at,
    leaseExpiresAt: row.lease_expires_at,
    availableAt: row.available_at,
    delaySeconds: Number(row.delay_seconds),
    dueInSeconds: Number(row.due_in_seconds),
  };
}

/** Makes a job due now, as if its delay had passed. Owner only. */
export async function makeJobDue(admin: Pool, jobId: string): Promise<void> {
  const { rowCount } = await admin.query(
    "update ops.jobs set available_at = now() where id = $1 and status = 'queued'",
    [jobId],
  );
  if (rowCount !== 1) {
    throw new Error(
      "the job to make due is not queued; the case would prove nothing",
    );
  }
}
