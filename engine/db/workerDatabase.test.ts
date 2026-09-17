// @vitest-environment node
import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerDatabase } from "./workerDatabase.ts";

// No database here: `pg` is replaced by a pool whose clients are plain event
// emitters, like the real ones. What these tests pin is what the adapter sends
// on every checkout and what it does when the server ends a session while the
// client is checked out. The idle-in-transaction timeout itself is proven end to
// end against a live Postgres by the driver-backed suites.

interface FakeClient extends EventEmitter {
  readonly statements: string[];
  readonly releasedWith: unknown[];
  /** How many 'error' listeners the client carried when it was released. */
  readonly errorListenersAtRelease: number[];
  queryable: boolean;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(error?: unknown): void;
}

const pg = vi.hoisted(() => ({
  pools: 0,
  clients: [] as FakeClient[],
  /** Answers a statement, or throws to fail it. */
  answer: (_client: FakeClient, _sql: string): unknown[] => [],
}));

vi.mock("pg", async () => {
  const { EventEmitter: Emitter } = await import("node:events");

  class Client extends Emitter {
    readonly statements: string[] = [];
    readonly releasedWith: unknown[] = [];
    readonly errorListenersAtRelease: number[] = [];
    queryable = true;

    async query(sql: string) {
      this.statements.push(sql);
      if (!this.queryable) {
        // What `pg` answers once its connection has failed.
        throw new Error(
          "Client has encountered a connection error and is not queryable",
        );
      }
      return { rows: pg.answer(this as unknown as FakeClient, sql) };
    }

    release(error?: unknown) {
      this.errorListenersAtRelease.push(this.listenerCount("error"));
      this.releasedWith.push(error);
    }
  }

  class Pool extends Emitter {
    constructor() {
      super();
      pg.pools += 1;
    }
    async connect() {
      const client = new Client() as unknown as FakeClient;
      pg.clients.push(client);
      return client;
    }
    async end() {}
  }

  return { Pool, default: { Pool } };
});

/** Ends the client's session the way `pg` reports it: an 'error' event, then a dead connection. */
const endSession = (client: FakeClient, message: string): Error => {
  const error = new Error(message);
  client.queryable = false;
  client.emit("error", error);
  return error;
};

const IDLE_TIMEOUT_MESSAGE =
  "terminating connection due to idle-in-transaction timeout";

const rejectionOf = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject");
};

beforeEach(() => {
  pg.pools = 0;
  pg.clients.length = 0;
  pg.answer = () => [];
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("every worker transaction is bounded before any work runs in it", () => {
  it("sets a statement timeout and an idle-in-transaction timeout, transaction-locally, before the work", async () => {
    // Arrange
    const db = createWorkerDatabase();

    // Act
    await db.withTransaction((tx) => tx.query("select 1"));

    // Assert
    expect(pg.clients[0].statements).toEqual([
      "begin",
      "set local statement_timeout = 30000",
      "set local idle_in_transaction_session_timeout = 10000",
      "select 1",
      "commit",
    ]);
  });

  it("uses the configured idle-in-transaction timeout", async () => {
    // Arrange
    const db = createWorkerDatabase({ idleInTransactionTimeoutMs: 2_500 });

    // Act
    await db.withTransaction(async () => undefined);

    // Assert
    expect(pg.clients[0].statements).toContain(
      "set local idle_in_transaction_session_timeout = 2500",
    );
  });

  it("refuses an idle-in-transaction timeout that would not bound anything, before opening a pool", () => {
    for (const idleInTransactionTimeoutMs of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2_147_483_648,
      "5000; drop table ops.jobs" as unknown as number,
    ]) {
      expect(() =>
        createWorkerDatabase({ idleInTransactionTimeoutMs }),
      ).toThrow(/idleInTransactionTimeoutMs/);
    }
    expect(pg.pools).toBe(0);
  });
});

describe("a session the server ends while its client is checked out is a failure, never a crash", () => {
  it("fails the transaction and discards the connection when the session ends between statements", async () => {
    // Arrange
    const db = createWorkerDatabase();
    let sessionError: Error | undefined;

    // Act
    const error = await rejectionOf(
      db.withTransaction(async (tx) => {
        await tx.query("select ops.claim_agent_run() as claim");
        // Without a listener, Node would throw this event out of the process.
        sessionError = endSession(pg.clients[0], IDLE_TIMEOUT_MESSAGE);
        await tx.query("select ops.start_agent_run($1, $2, $3, $4, $5)");
      }),
    );

    // Assert
    const client = pg.clients[0];
    expect(error.message).toMatch(/not queryable/);
    expect(client.statements).not.toContain("commit");
    expect(client.releasedWith).toEqual([sessionError]);
    expect(client.errorListenersAtRelease).toEqual([0]);
  });

  it("discards the connection when the session ends while a statement runs", async () => {
    // Arrange
    pg.answer = (client, sql) => {
      if (sql.startsWith("select ops.")) {
        endSession(
          client,
          "terminating connection due to administrator command",
        );
        throw new Error("Connection terminated unexpectedly");
      }
      return [];
    };
    const db = createWorkerDatabase();

    // Act
    const error = await rejectionOf(
      db.withTransaction((tx) => tx.query("select ops.lease_job($1, $2)")),
    );

    // Assert
    const client = pg.clients[0];
    expect(error.message).toBe("Connection terminated unexpectedly");
    expect(client.releasedWith).toHaveLength(1);
    expect((client.releasedWith[0] as Error).message).toMatch(
      /administrator command/,
    );
    expect(client.errorListenersAtRelease).toEqual([0]);
  });

  it("discards the connection when the session ends while the identity is read", async () => {
    // Arrange
    pg.answer = (client) => {
      endSession(client, "terminating connection due to administrator command");
      throw new Error("Connection terminated unexpectedly");
    };
    const db = createWorkerDatabase();

    // Act
    const error = await rejectionOf(db.identity());

    // Assert
    expect(error.message).toBe("Connection terminated unexpectedly");
    expect(pg.clients[0].releasedWith[0]).toBeInstanceOf(Error);
    expect(pg.clients[0].errorListenersAtRelease).toEqual([0]);
  });

  it("returns a healthy connection to the pool, carrying no listener of its own", async () => {
    // Arrange
    const db = createWorkerDatabase();

    // Act
    await db.withTransaction((tx) => tx.query("select 1"));
    await db.identity().catch(() => undefined);

    // Assert
    for (const client of pg.clients) {
      expect(client.releasedWith).toEqual([undefined]);
      expect(client.errorListenersAtRelease).toEqual([0]);
    }
  });

  it("discards a connection whose failed transaction could not be rolled back, and reports the original failure", async () => {
    // Arrange
    const rollbackFailure = new Error("rollback failed");
    pg.answer = (_client, sql) => {
      if (sql === "rollback") throw rollbackFailure;
      return [];
    };
    const db = createWorkerDatabase();
    const workFailure = new Error("handler failed");

    // Act
    const error = await rejectionOf(
      db.withTransaction(async () => {
        throw workFailure;
      }),
    );

    // Assert
    expect(error).toBe(workFailure);
    expect(pg.clients[0].releasedWith).toEqual([rollbackFailure]);
  });
});
