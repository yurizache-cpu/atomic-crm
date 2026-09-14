// Real-driver probe for SI-27, started by ownerSessionPool.mjs as a main service
// in the local edge runtime. It imports supabase/functions/_shared/db.ts as it
// is in the repository: deno-postgres and Kysely wired exactly as merge_contacts
// uses them, through the same runAsUser path. The pool is private to db.ts, so
// ownerSessionPool.mjs appends one line exporting it as ownerPoolForProbe, which
// lets the probe read the pooled session between transactions. It writes nothing: every ops attempt must be
// refused, and each runs inside a savepoint that is rolled back.

import {
  CompiledQuery,
  ownerPoolForProbe as db,
  runAsUser,
} from "../_shared/db.ts";

type Row = Record<string, unknown>;

const USER = "00000000-0000-4000-8000-00000000c0de";
const OTHER = "00000000-0000-4000-8000-00000000beef";

const OPS_ATTEMPTS: Record<string, string> = {
  "select ops.tenants": "select count(*) from ops.tenants",
  "select ops.events": "select count(*) from ops.events",
  "insert ops.companies":
    "insert into ops.companies (tenant_id, slug, name) values (gen_random_uuid(), 'probe', 'Probe')",
  "update ops.tasks": "update ops.tasks set title = title",
  "delete ops.events": "delete from ops.events",
  "call ops.current_tenant_id": "select ops.current_tenant_id()",
  "call ops.lease_job": "select ops.lease_job('probe', 30)",
  "call ops.enqueue_job":
    "select ops.enqueue_job(gen_random_uuid(), 'probe', '{}'::jsonb, 0, now(), 1, 'probe')",
  "call ops.create_company":
    "select ops.create_company(gen_random_uuid(), 'probe', 'Probe', 'probe')",
};

const raw = (sql: string) => CompiledQuery.raw(sql);
const plain = (value: unknown): Row =>
  JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? String(v) : v)),
  );
const describeError = (error: unknown): string => {
  const fields = (error as { fields?: { code?: string; message?: string } })
    ?.fields;
  if (fields?.code) return `${fields.code} ${fields.message}`;
  const e = error as Error;
  return `${e?.name ?? "Error"}: ${e?.message ?? String(error)}`;
};
const outcome = async (promise: Promise<unknown>): Promise<Row> => {
  try {
    return { ok: true, value: plain(await promise) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
};

/** The pooled session as the next request would find it, outside any transaction. */
async function sessionState(label: string): Promise<Row> {
  const { rows } = await db.executeQuery<Row>(
    raw(`select pg_backend_pid() as pid,
                current_user::text as "currentUser",
                session_user::text as "sessionUser",
                current_setting('role') as role,
                coalesce(current_setting('request.jwt.claim.sub', true), '') as "claimSub",
                coalesce(current_setting('request.jwt.claims', true), '') as claims,
                coalesce(current_setting('app.worker_id', true), '') as "workerId",
                coalesce(current_setting('app.job_id', true), '') as "jobId",
                auth.uid()::text as uid,
                ops.current_tenant_id()::text as tenant,
                now() = statement_timestamp() as autocommit,
                (select count(*) from pg_prepared_statements)::int as prepared`),
  );
  return { label, ...plain(rows[0]) };
}

// deno-lint-ignore no-explicit-any
async function insideState(trx: any): Promise<Row> {
  const { rows } = await trx.executeQuery(
    raw(`select pg_backend_pid() as pid,
                current_user::text as "currentUser",
                session_user::text as "sessionUser",
                current_setting('role') as role,
                auth.uid()::text as uid`),
  );
  return plain(rows[0]);
}

// deno-lint-ignore no-explicit-any
async function attemptOps(trx: any): Promise<Row> {
  const results: Row = {};
  for (const [name, sql] of Object.entries(OPS_ATTEMPTS)) {
    await trx.executeQuery(raw("savepoint ops_attempt"));
    try {
      await trx.executeQuery(raw(sql));
      results[name] = "ALLOWED";
    } catch (error) {
      results[name] = describeError(error);
    }
    await trx.executeQuery(raw("rollback to savepoint ops_attempt"));
  }
  return results;
}

const callerOf = (userId: string) =>
  runAsUser(userId, async (trx) => {
    const { rows } = await trx.executeQuery<Row>(
      raw("select auth.uid()::text as uid, pg_backend_pid() as pid"),
    );
    return plain(rows[0]);
  });

async function measure(): Promise<Row> {
  const states: Row[] = [await sessionState("the start")];

  // A and B: the merge path, committed.
  const committed = await runAsUser(USER, async (trx) => {
    const before = await insideState(trx);
    const contact = await trx
      .selectFrom("contacts")
      .selectAll()
      .where("id", "=", -1)
      .executeTakeFirst();
    const attempts = await attemptOps(trx);
    const after = await insideState(trx);
    return { before, contactFound: contact !== undefined, attempts, after };
  });
  states.push(await sessionState("COMMIT"));

  // F and G: every way a merge fails.
  const thrown = await outcome(
    runAsUser(USER, async (trx) => {
      await insideState(trx);
      throw new Error("probe: client-side failure");
    }),
  );
  states.push(await sessionState("a thrown error and ROLLBACK"));

  const noResult = await outcome(
    runAsUser(USER, (trx) =>
      trx
        .selectFrom("contacts")
        .selectAll()
        .where("id", "=", -1)
        .executeTakeFirstOrThrow(),
    ),
  );
  states.push(await sessionState("a missing contact and ROLLBACK"));

  const databaseError = await outcome(
    runAsUser(USER, (trx) =>
      trx.executeQuery(raw("select count(*) from ops.tenants")),
    ),
  );
  states.push(await sessionState("a database error and ROLLBACK"));

  // Characterisation: the owner session can switch back.
  const resetRole = await outcome(
    runAsUser(USER, async (trx) => {
      await trx.executeQuery(raw("reset role"));
      const { rows } = await trx.executeQuery<Row>(
        raw('select current_user::text as "currentUser"'),
      );
      throw new Error(`probe: reset role gives ${rows[0].currentUser}`);
    }),
  );
  states.push(await sessionState("the characterisation"));

  // E: callers in turn, then at once, on the one pooled session.
  const sequential = [await callerOf(USER), await callerOf(OTHER)];
  states.push(await sessionState("two callers in turn"));
  const concurrent = await Promise.all([callerOf(USER), callerOf(OTHER)]);
  states.push(await sessionState("two callers at once"));

  return {
    user: USER,
    other: OTHER,
    committed: plain(committed),
    thrown,
    noResult,
    databaseError,
    resetRole,
    sequential,
    concurrent,
    states,
  };
}

let payload: string;
try {
  payload = JSON.stringify({ ok: true, result: await measure() });
} catch (error) {
  payload = JSON.stringify({ ok: false, error: describeError(error) });
}
try {
  await db.destroy();
} catch {
  // The measurement is already taken; a close failure changes nothing in it.
}
// eslint-disable-next-line no-console -- ownerSessionPool.mjs reads this line from the runtime log
console.log(`OWNER_SESSION_PROBE ${payload}`);
Deno.serve(
  () =>
    new Response(payload, { headers: { "content-type": "application/json" } }),
);
