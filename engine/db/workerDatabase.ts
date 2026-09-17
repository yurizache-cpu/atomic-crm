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
//
// Every transaction is also bounded twice, both transaction-locally: by
// `statement_timeout` (a statement that runs too long) and by
// `idle_in_transaction_session_timeout` (a transaction the worker stops talking
// to). The second exists for the global spend lock (ADR 0017 §4): an agent
// run's start holds it until commit, so a worker that stalls there would stall
// every tenant's admission. The server ends such a session instead, the start
// rolls back uncommitted, and no call follows.

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
  /**
   * How long a transaction may sit idle, waiting on the worker, before the
   * server ends its session. A whole number of milliseconds, at least 1: zero
   * would switch the bound off, so it is refused rather than honoured.
   */
  idleInTransactionTimeoutMs?: number;
}

const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000;
/** The largest value a Postgres timeout setting accepts. */
const MAX_TIMEOUT_SETTING_MS = 2_147_483_647;

const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

const writeDiagnostic = (event: string, error: unknown): void => {
  process.stderr.write(
    `${JSON.stringify({ event, detail: toError(error).message })}\n`,
  );
};

interface SessionWatch {
  /** The error that makes this client unfit to return to the pool, if any. */
  readonly failure: () => Error | undefined;
  readonly poison: (error: unknown) => void;
  readonly detach: () => void;
}

/**
 * Keeps a server-side session failure on a CHECKED-OUT client an ordinary
 * failure instead of a crash.
 *
 * pg-pool removes its own 'error' listener from a client for as long as the
 * client is checked out. When the server ends the session in that window (the
 * idle-in-transaction timeout above, an administrator's terminate, a dropped
 * socket), `pg` emits 'error' on the client, whether or not a query is running.
 * Node throws an 'error' event nobody listens to, outside every promise, and
 * that kills the process, and every tenant's queue with it. This listener
 * records the error instead. The failed query (or the next one) still rejects,
 * so the caller sees the failure, and the client is released as poisoned, so
 * the pool discards it rather than handing out a dead connection.
 *
 * `detach` runs before the client is released: the pool re-attaches its own
 * listener on release, and the client must not carry this one back with it.
 */
function watchSession(client: PoolClient): SessionWatch {
  let failure: Error | undefined;
  const onError = (error: unknown) => {
    failure ??= toError(error);
    writeDiagnostic("worker.pool.session_error", error);
  };
  client.on("error", onError);
  return {
    failure: () => failure,
    poison: (error) => {
      failure ??= toError(error);
    },
    detach: () => {
      client.removeListener("error", onError);
    },
  };
}

/** Interpolated into SQL, so it is proven to be a bare, positive integer first. */
function timeoutSetting(value: number, name: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TIMEOUT_SETTING_MS
  ) {
    throw new Error(
      `createWorkerDatabase requires ${name} to be a whole number of milliseconds between 1 and ${MAX_TIMEOUT_SETTING_MS}.`,
    );
  }
  return value;
}

/**
 * Builds the adapter over a real `pg` Pool.
 *
 * `max` is small on purpose: a worker's concurrency is governed by how many
 * jobs it runs at once, not by how many sockets it can open.
 */
export function createWorkerDatabase(
  options: WorkerDatabaseOptions = {},
): WorkerDatabase {
  const {
    statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS,
    idleInTransactionTimeoutMs = DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    ...poolConfig
  } = options;
  const idleTimeout = timeoutSetting(
    idleInTransactionTimeoutMs,
    "idleInTransactionTimeoutMs",
  );
  const pool = new Pool({ max: 4, ...poolConfig });

  // An error on an IDLE connection is emitted on the pool, not on any caller's
  // promise. Without this listener Node treats it as unhandled and kills the
  // process — which is exactly the "database connection drops" case the worker
  // has to survive. A checked-out connection is covered by watchSession.
  pool.on("error", (error: unknown) => {
    writeDiagnostic("worker.pool.idle_error", error);
  });

  return {
    async withTransaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect();
      const session = watchSession(client);
      try {
        await client.query("begin");
        // Transaction-local, like everything else here: a wedged handler cannot
        // pin a connection forever, and a stalled worker cannot hold a lock
        // forever.
        await client.query(
          `set local statement_timeout = ${Number(statementTimeoutMs)}`,
        );
        await client.query(
          `set local idle_in_transaction_session_timeout = ${idleTimeout}`,
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
          session.poison(rollbackError);
        }
        throw error;
      } finally {
        session.detach();
        client.release(session.failure());
      }
    },

    async identity(): Promise<WorkerIdentity> {
      const client: PoolClient = await pool.connect();
      const session = watchSession(client);
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
        session.detach();
        client.release(session.failure());
      }
    },

    async close() {
      await pool.end();
    },
  };
}
