// The database port, free of any driver.
//
// Kept separate so that the runtime, the handlers and their tests depend on the
// SHAPE of a database and never on `pg`. Only `workerDatabase.ts` imports the
// driver.

import type { WorkerIdentity } from "./workerIdentity.ts";

/** The narrowest thing the runtime needs: something that can run SQL. */
export interface TxClient {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: TRow[] }>;
}

/** What the worker runtime is allowed to ask of a database. */
export interface WorkerDatabase {
  /**
   * Runs `fn` inside one transaction on one checked-out connection.
   * Commits on return, rolls back on throw, always releases the connection.
   */
  withTransaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
  /** Identity this pool actually connects as. Read once, at startup. */
  identity(): Promise<WorkerIdentity>;
  close(): Promise<void>;
}
