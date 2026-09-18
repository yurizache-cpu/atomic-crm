// What runs AFTER an external call's settlement committed.
//
// TX2b settles the call's outcome and completes the job in ONE transaction, and
// commits. Anything downstream of that settlement (today, opening the human
// review of a lead triage answer) runs here, each step in a transaction of its
// OWN, strictly after that commit. So nothing a step does or suffers can reach
// the settlement: not an error, not a lock wait, not a statement timeout, not a
// cancellation, not the worker dying before the step starts. A subtransaction
// inside the settlement cannot promise that, because PL/pgSQL's `when others`
// lets QUERY_CANCELED (57014) through, and the settlement's rollback with it
// (docs/PHASE_2A_REPORT.md §16).
//
// A step is RUNTIME SQL, like completing a job, never a capability: the lease
// ended with TX2b, so no tenant context is left to grant one in. The runtime
// names the job by the worker id and job id it already holds, and the database
// reads the tenant and the run from the completed job, refusing a job this
// worker did not complete. A handler only declares WHICH steps follow its
// settlement, from the fixed list below. It supplies nothing else.
//
// Best effort, by design. A failed step is logged with its name and SQLSTATE,
// never a message (a message can quote a row), and is left to its own
// recovery. It never fails the attempt and never reaches TX3, so it never
// schedules a retry, and the settled call cannot be made again.

import type { WorkerDatabase } from "../db/types.ts";
import { assumeWorkerRole } from "./attempt.ts";
import type { LeasedJob } from "./job.ts";
import type { WorkerLogger } from "./log.ts";

/** The complete set of post-settlement steps. Adding one is a review event. */
export type AfterSettlementStep = "openRunReview";

/**
 * One statement per step, bound to ($1 worker id, $2 job id) and nothing else.
 * `openRunReview` opens the review of the run the job settled, when there is one
 * to open. Its recovery is ops.open_missing_reviews (`npm run ops -- triage recover`).
 */
const STEP_SQL: ReadonlyMap<string, string> = new Map([
  ["openRunReview", "select ops.open_review_for_settled_job($1, $2)"],
]);

/** A SQLSTATE and nothing else. Anything that is not one reads "unknown". */
const sqlstateOf = (error: unknown): string => {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
    ? code
    : "unknown";
};

export interface AfterSettlementScope {
  readonly db: WorkerDatabase;
  readonly workerId: string;
  /** The job TX2b completed. Only its ids are used. */
  readonly job: LeasedJob;
  readonly log: WorkerLogger;
}

/**
 * Runs `steps` in order, each in its own transaction, once the settlement has
 * committed. Never throws: a failed step is logged, and the next one still
 * runs. A name outside the fixed list runs no SQL and is logged as refused.
 */
export async function runAfterSettlement(
  { db, workerId, job, log }: AfterSettlementScope,
  steps: readonly AfterSettlementStep[],
): Promise<void> {
  for (const step of steps) {
    const fields = {
      workerId,
      jobId: job.id,
      tenantId: job.tenant_id,
      kind: job.kind,
      attempt: job.attempts,
    };
    const sql = STEP_SQL.get(step);
    if (sql === undefined) {
      log("job.after_settlement_failed", {
        ...fields,
        detail: "unknown step refused",
      });
      continue;
    }
    try {
      await db.withTransaction(async (tx) => {
        await assumeWorkerRole(tx);
        await tx.query(sql, [workerId, job.id]);
      });
    } catch (error) {
      log("job.after_settlement_failed", {
        ...fields,
        detail: `${step} sqlstate=${sqlstateOf(error)}`,
      });
    }
  }
}
