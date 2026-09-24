// A fake WorkerDatabase for the runtime's unit tests: it numbers transactions
// the way runOneJob opens them, records every statement, and answers the ops
// functions the runtime calls. Shared by runOneJob.test.ts and the Phase 2E.1
// telemetry tests, so both exercise the same fake.

import type { TxClient, WorkerDatabase } from "../../db/types.ts";
import type { LeasedJob } from "../job.ts";

export const JOB: LeasedJob = {
  id: "11111111-1111-1111-1111-111111111111",
  tenant_id: "aaaaaaaa-0000-0000-0000-000000000001",
  kind: "probe",
  payload: { hello: "world" },
  attempts: 1,
  max_attempts: 5,
};

export interface Recorded {
  tx: number;
  sql: string;
  params?: readonly unknown[];
}

export interface FakeOptions {
  leased?: LeasedJob | null;
  /** Rows ops.resume_lease returns, per call. Missing entries mean "the job". */
  resume?: (LeasedJob | null)[];
  contextTenant?: string | null;
  completeReturns?: boolean;
  settleReturns?: string;
  /** Throw from withTransaction on the Nth transaction (1-based). */
  failTransaction?: number;
  /**
   * What the prepare transaction's resume reports as lease_remaining_ms. A
   * string by default, because that is how `pg` returns a bigint; `null`
   * omits the column.
   */
  leaseRemainingMs?: string | number | null;
  /** Rows ops.job_execution_stop() answers. Default: one row, no stop. */
  stopCheck?: readonly unknown[];
  /** Rows ops.defer_job() answers. Default: one row naming STOP_ID. */
  deferral?: readonly unknown[];
  /** A statement fragment whose query raises, as a failing function does. */
  failStatement?: string;
}

export const STOP_ID = "5e0c1d2a-7b3f-4c8d-9e1f-2a3b4c5d6e7f";

export const fakeDb = (options: FakeOptions = {}) => {
  const calls: Recorded[] = [];
  /** Transactions that reached COMMIT, in order. */
  const committed: number[] = [];
  const rolledBack: number[] = [];
  let transaction = 0;
  let resumeCall = 0;
  /** Transactions begun and not yet committed or rolled back. */
  let open = 0;

  const leased = options.leased === undefined ? JOB : options.leased;
  const contextTenant =
    options.contextTenant === undefined
      ? (leased?.tenant_id ?? null)
      : options.contextTenant;

  const db: WorkerDatabase = {
    async withTransaction(fn) {
      transaction += 1;
      const mine = transaction;
      if (options.failTransaction === mine) {
        rolledBack.push(mine);
        throw Object.assign(new Error("connection terminated"), {
          code: "08006",
        });
      }
      const tx: TxClient = {
        async query(sql, params) {
          calls.push({ tx: mine, sql, params });
          if (options.failStatement && sql.includes(options.failStatement)) {
            throw Object.assign(new Error("function raised an exception"), {
              code: "42501",
            });
          }
          if (sql.includes("ops.lease_job")) {
            return { rows: leased ? [leased] : [] } as never;
          }
          if (sql.includes("ops.job_execution_stop")) {
            return {
              rows: [...(options.stopCheck ?? [{ stop_id: null }])],
            } as never;
          }
          if (sql.includes("ops.defer_job")) {
            return {
              rows: [...(options.deferral ?? [{ stop_id: STOP_ID }])],
            } as never;
          }
          if (sql.includes("ops.resume_lease")) {
            const configured = options.resume?.[resumeCall];
            resumeCall += 1;
            const row = configured === undefined ? leased : configured;
            if (!row) return { rows: [] } as never;
            const reportsRemaining =
              sql.includes("lease_remaining_ms") &&
              options.leaseRemainingMs !== null;
            return {
              rows: [
                reportsRemaining
                  ? {
                      ...row,
                      lease_remaining_ms: options.leaseRemainingMs ?? "30000",
                    }
                  : row,
              ],
            } as never;
          }
          if (sql.includes("ops.current_tenant_id")) {
            return { rows: [{ tenant_id: contextTenant }] } as never;
          }
          if (sql.includes("ops.complete_job")) {
            return {
              rows: [{ ok: options.completeReturns ?? true }],
            } as never;
          }
          if (sql.includes("ops.settle_job_failure")) {
            return {
              rows: [{ result: options.settleReturns ?? "retry" }],
            } as never;
          }
          return { rows: [] } as never;
        },
      };
      open += 1;
      try {
        const result = await fn(tx);
        committed.push(mine);
        return result;
      } catch (error) {
        rolledBack.push(mine);
        throw error;
      } finally {
        open -= 1;
      }
    },
    async identity() {
      throw new Error("not used");
    },
    async close() {},
  };

  return {
    db,
    calls,
    committed,
    rolledBack,
    openTransactions: () => open,
    sqlIn: (n: number) => calls.filter((c) => c.tx === n).map((c) => c.sql),
  };
};
