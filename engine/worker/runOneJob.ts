// The worker's one unit of work: lease, execute, settle — in that order, in one
// transaction.
//
// This module exists to make the ORDERING INVARIANT hard to get wrong, because
// getting it wrong is how tenancy leaks:
//
//     trusted leased row -> tenant established server-side -> execute -> settle
//
// and never
//
//     payload -> tenant
//
// It takes no database driver. `TxClient` is injected, so this is testable in
// plain Node and commits the project to no client library before ADR 0001 is
// accepted. The caller owns BEGIN/COMMIT: every statement below must run in one
// transaction, because the tenant context installed by `ops.lease_job()` is
// transaction-local and dies with it. That is the property, not a limitation.

/** The narrowest thing this module needs: something that can run SQL. */
export interface TxClient {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: TRow[] }>;
}

/** A row of `ops.jobs`, as handed back by `ops.lease_job()`. */
export interface LeasedJob {
  id: string;
  tenant_id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
}

/**
 * A unit of work. It receives the job and the SAME transaction, already scoped
 * to the job's tenant by RLS.
 *
 * It is deliberately NOT given the tenant id as something to pass around: the
 * tenant is ambient and enforced by the database, so a handler cannot widen it
 * by forgetting an argument or by trusting a field of the payload.
 */
export type JobHandler = (job: LeasedJob, tx: TxClient) => Promise<void>;

export type JobOutcome =
  /** The queue had nothing available. */
  | "idle"
  /** The handler ran and the job is settled. */
  | "succeeded"
  /** The handler threw; the job is queued again for another attempt. */
  | "retry"
  /** The handler threw and the job has no attempts left, or is unrunnable. */
  | "failed";

export interface RunOneJobResult {
  outcome: JobOutcome;
  jobId?: string;
  tenantId?: string;
  kind?: string;
  attempt?: number;
  error?: string;
}

export interface RunOneJobOptions {
  /** Identifies this worker to the lease. Must be stable for the process. */
  workerId: string;
  /** How long the lease is held. Longer than the slowest handler. */
  leaseSeconds?: number;
  /** Keyed by `ops.jobs.kind`. A kind with no handler is a permanent failure. */
  handlers: Readonly<Record<string, JobHandler>>;
}

const DEFAULT_LEASE_SECONDS = 60;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Leases one job and runs it to settlement. Returns rather than throws for
 * ordinary failures, so a worker loop does not need to distinguish "this job
 * failed" from "the database is gone".
 *
 * MUST be called inside a transaction the caller opened.
 */
export async function runOneJob(
  tx: TxClient,
  {
    workerId,
    leaseSeconds = DEFAULT_LEASE_SECONDS,
    handlers,
  }: RunOneJobOptions,
): Promise<RunOneJobResult> {
  if (!workerId.trim()) {
    throw new Error(
      "runOneJob requires a worker id: it is what binds the lease to this process, and ops.current_tenant_id() resolves the tenant through it.",
    );
  }

  // Drop to the least-privileged identity for the whole transaction. The worker
  // process may connect as a role that merely has membership in ops_worker —
  // exactly how PostgREST reaches `authenticated` — so this is what actually
  // puts RLS in force.
  await tx.query("set local role ops_worker");

  const leased = await tx.query<LeasedJob>(
    "select * from ops.lease_job($1, $2)",
    [workerId, leaseSeconds],
  );
  const job = leased.rows[0];
  if (!job?.id) return { outcome: "idle" };

  // The tenant is READ BACK from the database rather than taken from the row we
  // were handed. They should agree; asserting it is what turns a silent context
  // bug into a refusal. If `ops.lease_job` ever stops installing the context —
  // or something clears it — this is the line that notices.
  const context = await tx.query<{ tenant_id: string | null }>(
    "select ops.current_tenant_id() as tenant_id",
  );
  const activeTenant = context.rows[0]?.tenant_id ?? null;
  if (activeTenant !== job.tenant_id) {
    await tx.query("select ops.fail_job($1, $2, $3)", [
      job.id,
      `tenant context mismatch: lease says ${job.tenant_id}, session says ${activeTenant ?? "none"}`,
      null,
    ]);
    return {
      outcome: "failed",
      jobId: job.id,
      tenantId: job.tenant_id,
      kind: job.kind,
      attempt: job.attempts,
      error: "tenant context mismatch",
    };
  }

  const handler = handlers[job.kind];
  if (!handler) {
    // Unrunnable, and retrying cannot help. Recorded rather than dropped.
    await tx.query("select ops.fail_job($1, $2, $3)", [
      job.id,
      `no handler registered for kind "${job.kind}"`,
      null,
    ]);
    return {
      outcome: "failed",
      jobId: job.id,
      tenantId: job.tenant_id,
      kind: job.kind,
      attempt: job.attempts,
      error: `no handler for "${job.kind}"`,
    };
  }

  try {
    await handler(job, tx);
  } catch (error) {
    const detail = messageOf(error);
    await tx.query("select ops.fail_job($1, $2)", [job.id, detail]);
    // `ops.fail_job` requeues while attempts remain and retires the job
    // otherwise; report which happened rather than guessing.
    const willRetry = job.attempts < job.max_attempts;
    return {
      outcome: willRetry ? "retry" : "failed",
      jobId: job.id,
      tenantId: job.tenant_id,
      kind: job.kind,
      attempt: job.attempts,
      error: detail,
    };
  }

  await tx.query("select ops.complete_job($1)", [job.id]);
  return {
    outcome: "succeeded",
    jobId: job.id,
    tenantId: job.tenant_id,
    kind: job.kind,
    attempt: job.attempts,
  };
}
