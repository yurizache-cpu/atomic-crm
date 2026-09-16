// Two-session support for the driver-backed suites: a transaction a test can
// hold open across awaits, and probes that prove what another backend is doing
// about a lock.
//
// The proofs one connection cannot make all have the same shape: transaction A
// holds something, B arrives, and the case is what B does — wait, skip, or
// decide on what A committed. `withTransaction(async (tx) => ...)` cannot be
// paused from outside, so a session runs its steps from a queue inside ONE
// transaction on ONE checked-out connection, and ends only when the test says
// commit or rollback. A wait is never assumed from a sleep: `waitUntilBlocked`
// reads it from pg_stat_activity while the waiting call is still unsettled.

import type { Pool } from "pg";
import type { TxClient, WorkerDatabase } from "../../db/types.ts";

export interface TransactionSession {
  /** The backend pid of the session's connection, once its transaction has begun. */
  readonly pid: Promise<number>;
  /** Runs one step inside the open transaction. Steps run in the order they were given. */
  run<T>(step: (tx: TxClient) => Promise<T>): Promise<T>;
  /**
   * Commits or rolls back, and releases the connection. The first call decides;
   * later calls only wait for it, so a `finally` may always end a session. End
   * a session that holds a lock BEFORE one that is waiting for it: a queued end
   * runs only after the step in progress returns.
   */
  end(outcome: "commit" | "rollback"): Promise<void>;
}

type Command =
  | {
      readonly kind: "step";
      readonly step: (tx: TxClient) => Promise<unknown>;
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: unknown) => void;
    }
  | { readonly kind: "end"; readonly outcome: "commit" | "rollback" };

const ROLLBACK = Symbol("rollback");

export function openSession(db: WorkerDatabase): TransactionSession {
  const queue: Command[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let failure: { readonly error: unknown } | undefined;

  const push = (command: Command): void => {
    queue.push(command);
    wake?.();
    wake = undefined;
  };
  const next = async (): Promise<Command> => {
    while (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    return queue.shift() as Command;
  };

  let resolvePid!: (pid: number) => void;
  let rejectPid!: (error: unknown) => void;
  const pid = new Promise<number>((resolve, reject) => {
    resolvePid = resolve;
    rejectPid = reject;
  });
  pid.catch(() => undefined);

  const done = db
    .withTransaction(async (tx) => {
      const { rows } = await tx.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      resolvePid(rows[0].pid);
      for (;;) {
        const command = await next();
        if (command.kind === "end") {
          if (command.outcome === "rollback") throw ROLLBACK;
          return;
        }
        try {
          command.resolve(await command.step(tx));
        } catch (error) {
          command.reject(error);
        }
      }
    })
    .catch((error: unknown) => {
      if (error === ROLLBACK) return;
      // The transaction itself failed (begin, commit, a lost connection): no
      // queued step will ever run, so none may be left waiting forever.
      failure = { error };
      rejectPid(error);
      for (const command of queue.splice(0)) {
        if (command.kind === "step") command.reject(error);
      }
      throw error;
    });
  done.catch(() => undefined);

  return {
    pid,
    run<T>(step: (tx: TxClient) => Promise<T>): Promise<T> {
      if (failure) return Promise.reject(failure.error);
      if (ended) {
        return Promise.reject(new Error("the session has already ended"));
      }
      return new Promise<T>((resolve, reject) => {
        push({
          kind: "step",
          step,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
      });
    },
    async end(outcome: "commit" | "rollback"): Promise<void> {
      if (!ended) {
        ended = true;
        push({ kind: "end", outcome });
      }
      await done;
    },
  };
}

export interface LockWait {
  readonly waitEventType: string;
  readonly waitEvent: string;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resolves once backend `pid` is seen in pg_stat_activity waiting on a
 * heavyweight lock — on the wait event `waitEvent` when one is given — while
 * `pending`, the call that backend is running, has not settled.
 *
 * Rejects when the call settles first, or when no such wait is seen in time. A
 * call that never waited proves nothing about the lock it was meant to meet, so
 * that is a failed case, not a fast one.
 */
export async function waitUntilBlocked(
  admin: Pool,
  pid: number,
  pending: Promise<unknown>,
  waitEvent?: string,
  timeoutMs = 10_000,
): Promise<LockWait> {
  let settled = false;
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const wanted = waitEvent ? ` (${waitEvent})` : "";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await admin.query<{
      wait_event_type: string | null;
      wait_event: string | null;
    }>(
      "select wait_event_type, wait_event from pg_stat_activity where pid = $1",
      [pid],
    );
    const row = rows[0];
    if (
      row?.wait_event_type === "Lock" &&
      (waitEvent === undefined || row.wait_event === waitEvent)
    ) {
      return {
        waitEventType: row.wait_event_type,
        waitEvent: row.wait_event ?? "",
      };
    }
    const seen = `${row?.wait_event_type ?? "-"}/${row?.wait_event ?? "-"}`;
    if (settled) {
      throw new Error(
        `the call finished before backend ${pid} was seen waiting on a lock${wanted}; last seen ${seen}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `backend ${pid} was not seen waiting on a lock${wanted} within ${timeoutMs} ms; last seen ${seen}`,
      );
    }
    await sleep(25);
  }
}

/**
 * Holds a row lock on an admin connection of its own while `body` runs, then
 * rolls back. Refuses a lock statement that locked no row: a case whose lock
 * was never taken would pass for the wrong reason.
 */
export async function whileRowLocked<T>(
  admin: Pool,
  lockSql: string,
  params: readonly unknown[],
  body: () => Promise<T>,
): Promise<T> {
  const client = await admin.connect();
  try {
    await client.query("begin");
    const { rowCount } = await client.query(lockSql, [...params]);
    if (rowCount !== 1) {
      throw new Error(
        "the row to lock does not exist; the case would prove nothing",
      );
    }
    return await body();
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

/**
 * True when another transaction holds a lock on the row that FOR UPDATE
 * conflicts with (a share lock included), measured without waiting for it.
 */
export async function isRowLocked(
  admin: Pool,
  table: "ops.jobs" | "ops.agent_runs",
  id: string,
): Promise<boolean> {
  const client = await admin.connect();
  try {
    await client.query("begin");
    const { rowCount } = await client.query(
      `select 1 from ${table} where id = $1 for update nowait`,
      [id],
    );
    if (rowCount !== 1) {
      throw new Error(
        `${table} has no row ${id}; the probe would prove nothing`,
      );
    }
    return false;
  } catch (error) {
    if ((error as { code?: unknown }).code === "55P03") return true;
    throw error;
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}
