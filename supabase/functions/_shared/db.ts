import type {
  DatabaseConnection,
  Driver,
  QueryResult,
} from "https://esm.sh/kysely@0.27.2";
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type Generated,
  type Transaction,
} from "https://esm.sh/kysely@0.27.2";

export { CompiledQuery };
import type { PoolClient } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";

// Database schema types
export interface ContactsTable {
  id: Generated<number>;
  first_name: string | null;
  last_name: string | null;
  gender: string | null;
  title: string | null;
  email_jsonb: unknown | null; // JSONB array
  phone_jsonb: unknown | null; // JSONB array
  background: string | null;
  avatar: unknown | null; // JSONB
  first_seen: Date | null;
  last_seen: Date | null;
  has_newsletter: boolean | null;
  status: string | null;
  tags: number[] | null;
  company_id: number | null;
  sales_id: number | null;
  linkedin_url: string | null;
}

interface TasksTable {
  id: Generated<number>;
  contact_id: number;
  type: string | null;
  text: string | null;
  due_date: Date;
  done_date: Date | null;
  sales_id: number | null;
}

interface ContactNotesTable {
  id: Generated<number>;
  contact_id: number;
  text: string | null;
  date: Date | null;
  sales_id: number | null;
  status: string | null;
  attachments: unknown[] | null; // JSONB array
}

interface DealsTable {
  id: Generated<number>;
  name: string;
  company_id: number | null;
  contact_ids: number[];
  category: string | null;
  stage: string;
  description: string | null;
  amount: number | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  expected_closing_date: Date | null;
  sales_id: number | null;
  index: number | null;
}

interface Database {
  contacts: ContactsTable;
  tasks: TasksTable;
  contact_notes: ContactNotesTable;
  deals: DealsTable;
}

// Deno Postgres Driver for Kysely
class DenoPostgresDriver implements Driver {
  private pool: Pool;
  private connections = new WeakMap<PoolClient, DatabaseConnection>();

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async init(): Promise<void> {
    // Connection pool is already initialized
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    const client = await this.pool.connect();
    let connection = this.connections.get(client);

    if (!connection) {
      connection = new DenoPostgresConnection(client);
      this.connections.set(client, connection);
    }

    return connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    (connection as DenoPostgresConnection).release();
  }

  async destroy(): Promise<void> {
    await this.pool.end();
  }
}

class DenoPostgresConnection implements DatabaseConnection {
  private client: PoolClient;

  constructor(client: PoolClient) {
    this.client = client;
  }

  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    const result = await this.client.queryObject<O>({
      text: compiledQuery.sql,
      args: compiledQuery.parameters as unknown[],
    });

    if (
      result.command === "INSERT" ||
      result.command === "UPDATE" ||
      result.command === "DELETE"
    ) {
      return {
        numAffectedRows: BigInt(result.rowCount ?? 0),
        rows: result.rows ?? [],
      };
    }

    return {
      rows: result.rows ?? [],
    };
  }

  streamQuery<O>(
    _compiledQuery: CompiledQuery,
    _chunkSize?: number,
  ): AsyncIterableIterator<QueryResult<O>> {
    throw new Error("Deno Postgres driver does not support streaming");
  }

  release() {
    this.client.release();
  }
}

// Create connection pool
// Use SUPABASE_DB_URL if available (production), otherwise fall back to local dev connection string
const connectionString =
  Deno.env.get("SUPABASE_DB_URL") ||
  "postgresql://postgres:postgres@db:5432/postgres";

const pool = new Pool(connectionString, 1); // Single connection for edge functions

// The Kysely instance over the owner pool. Module-private: runAsUser is the
// only way a function uses it (SI-27).
const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DenoPostgresDriver(pool),
    createIntrospector: (db: Kysely<any>) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

/**
 * Runs `work` in one transaction as `authenticated`, with the verified caller's
 * id as the RLS identity. The pool logs in as the database owner, so this is how
 * a function uses it (ADR 0002). SET LOCAL ROLE and the local set_config end
 * with the transaction, on COMMIT and ROLLBACK alike, and the id travels as a
 * bound parameter, never inside the SQL text.
 *
 * The role switch is not a privilege boundary: the owner session could switch
 * back. What keeps it out of `ops` is that every statement sent here is fixed
 * code in this file and in merge_contacts/index.ts, both sealed by
 * supabase/tests/ownerSessionSeal.test.ts, and that `authenticated` holds
 * nothing in `ops` (SI-27).
 */
export function runAsUser<T>(
  userId: string,
  work: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await trx.executeQuery(CompiledQuery.raw("SET LOCAL ROLE authenticated"));
    await trx.executeQuery(
      CompiledQuery.raw(
        "SELECT set_config('request.jwt.claim.sub', $1, true)",
        [userId],
      ),
    );
    return await work(trx);
  });
}
