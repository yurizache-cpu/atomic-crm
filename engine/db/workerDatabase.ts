// The worker's database adapter. This is the ONLY module in the engine that
// imports a driver, so the runtime is coupled to `pg` in exactly one place.
//
// Three rules are enforced here rather than left to callers, because every one
// of them is a silent cross-tenant leak when it is forgotten:
//
//   1. A transaction gets its OWN checked-out client. `pool.query()` picks an
//      arbitrary connection per statement, so a multi-statement tenant-scoped
//      transaction run through it would scatter BEGIN, `set local`, the work and
//      COMMIT across different connections. That is not a slower path, it is a
//      broken one, and this module gives callers no way to express it.
//
//   2. The connection identity is CHECKED at startup — see workerIdentity.ts.
//
//   3. Nothing resets session state between checkouts. That is deliberate. The
//      isolation guarantee is that the tenant context is TRANSACTION-LOCAL, and
//      a `RESET ALL` here would hide whether that is actually true. If the
//      guarantee ever breaks, the pooling test must SEE it rather than be
//      protected from it by a reset nobody remembers is load-bearing.

import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { TxClient, WorkerDatabase } from "./types.ts";
import {
  IDENTITY_SQL,
  WORKER_ROLE,
  WorkerIdentityError,
  type WorkerIdentity,
} from "./workerIdentity.ts";

export type { TxClient, WorkerDatabase } from "./types.ts";
export {
  assertWorkerIdentity,
  WORKER_ROLE,
  WorkerIdentityError,
  type WorkerIdentity,
} from "./workerIdentity.ts";

export interface WorkerDatabaseOptions extends PoolConfig {
  /** Hard ceiling on how long one transaction may hold a connection. */
  statementTimeoutMs?: number;
}

const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Builds the adapter over a real `pg` Pool.
 *
 * `max` is small on purpose: a worker's concurrency is governed by how many
 * jobs it runs at once, not by how many sockets it can open.
 */
export function createWorkerDatabase(
  options: WorkerDatabaseOptions = {},
): WorkerDatabase {
  const { statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS, ...poolConfig } =
    options;
  const pool = new Pool({ max: 4, ...poolConfig });

  // An error on an IDLE connection is emitted on the pool, not on any caller's
  // promise. Without this listener Node treats it as unhandled and kills the
  // process — which is exactly the "database connection drops" case the worker
  // has to survive.
  pool.on("error", (error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        event: "worker.pool.idle_error",
        detail: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  });

  return {
    async withTransaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect();
      let poisoned: Error | undefined;
      try {
        await client.query("begin");
        // Transaction-local, like everything else here: a wedged handler cannot
        // pin a connection forever.
        await client.query(
          `set local statement_timeout = ${Number(statementTimeoutMs)}`,
        );
        const result = await fn({
          query: (sql, params) =>
            client.query(sql, params as unknown[]) as never,
        });
        await client.query("commit");
        return result;
      } catch (error) {
        try {
          await client.query("rollback");
        } catch (rollbackError) {
          // It could not even be rolled back, so it must not go back into the
          // pool carrying unknown state.
          poisoned =
            rollbackError instanceof Error
              ? rollbackError
              : new Error(String(rollbackError));
        }
        throw error;
      } finally {
        client.release(poisoned);
      }
    },

    async identity(): Promise<WorkerIdentity> {
      const client: PoolClient = await pool.connect();
      try {
        const { rows } = await client.query(IDENTITY_SQL, [WORKER_ROLE]);
        const row = rows[0];
        if (!row) {
          throw new WorkerIdentityError(
            "could not read the worker's database identity from pg_roles",
          );
        }
        return {
          user: String(row.user),
          isSuperuser: Boolean(row.isSuperuser),
          bypassesRls: Boolean(row.bypassesRls),
          isOpsWorkerMember: Boolean(row.isOpsWorkerMember),
        };
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}
