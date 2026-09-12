// Phase 1A case G — concurrent leasing, with real concurrency.
//
// This cannot be a .sql file. One psql connection runs one transaction at a
// time, so a single-connection test can only prove that SKIP LOCKED parses. The
// property that matters — two workers racing for the same row, and exactly one
// winning without the other blocking — needs simultaneous connections, so this
// spawns them.
//
// Run by scripts/run-db-tests.mjs alongside the SQL suites. Exits non-zero on
// failure; prints nothing but its findings.

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONTAINER =
  process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_atomic-crm-e2e";
const SLUG = "phase1a-conc";

const psqlArgs = (sql) => [
  "exec",
  CONTAINER,
  "psql",
  "-U",
  "postgres",
  "-d",
  "postgres",
  "-q",
  "-t",
  "-A",
  "-v",
  "ON_ERROR_STOP=1",
  "-c",
  sql,
];

/** Run SQL and return trimmed stdout lines. Throws on a non-zero exit. */
const sql = (text) =>
  execFileSync("docker", psqlArgs(text), { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** Same, but asynchronous — used to put several workers in flight at once. */
const sqlAsync = async (text) => {
  const { stdout } = await execFileAsync("docker", psqlArgs(text), {
    encoding: "utf8",
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const cleanup = () => {
  sql(`
    delete from ops.job_events e using ops.tenants t
      where e.tenant_id = t.id and t.slug = '${SLUG}';
    delete from ops.jobs j using ops.tenants t
      where j.tenant_id = t.id and t.slug = '${SLUG}';
    delete from ops.tenants where slug = '${SLUG}';
  `);
};

/**
 * One worker, in its own connection and its own transaction. Returns the leased
 * job id, or "" when the queue had nothing left for it.
 */
const leaseOnce = (workerId) =>
  sqlAsync(
    `do $$ begin execute format('grant ops_worker to %I', current_user); end $$;
     begin;
     set local role ops_worker;
     select coalesce(id::text, '') from ops.lease_job('${workerId}', 60);
     commit;`,
  );

async function main() {
  cleanup();

  sql(
    `insert into ops.tenants (slug, name) values ('${SLUG}', 'Concurrency');`,
  );

  // ── G1: more workers than jobs ────────────────────────────────────────────
  // 12 workers race for 6 jobs. Exactly 6 leases, all distinct, and the six
  // that lose must come back empty rather than blocking or erroring.
  const JOBS = 6;
  const WORKERS = 12;
  sql(`
    select ops.enqueue_job(t.id, 'conc', '{}'::jsonb, 100, now(), 5, 'k' || g::text)
      from ops.tenants t, generate_series(1, ${JOBS}) g
     where t.slug = '${SLUG}';
  `);

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: WORKERS }, (_, i) => leaseOnce(`conc-worker-${i}`)),
  );
  const elapsed = Date.now() - started;

  const leased = results
    .map((lines) => lines[lines.length - 1] ?? "")
    .filter((id) => id.length > 0);
  const unique = new Set(leased);

  check(
    leased.length === JOBS,
    `G1: ${WORKERS} workers leased ${leased.length} jobs from a queue of ${JOBS}; expected exactly ${JOBS}`,
  );
  check(
    unique.size === leased.length,
    `G1: a job was leased twice — ${leased.length} leases but only ${unique.size} distinct ids. FOR UPDATE SKIP LOCKED is not doing its job.`,
  );

  // Every job must now be 'leased' with a distinct owner.
  const [leasedCount] = sql(`
    select count(*) from ops.jobs j join ops.tenants t on t.id = j.tenant_id
     where t.slug = '${SLUG}' and j.status = 'leased';
  `);
  check(
    Number(leasedCount) === JOBS,
    `G1: ${leasedCount} of ${JOBS} jobs are in status 'leased' after the race`,
  );

  const [ownerCount] = sql(`
    select count(distinct j.lease_owner) from ops.jobs j
      join ops.tenants t on t.id = j.tenant_id
     where t.slug = '${SLUG}' and j.status = 'leased';
  `);
  check(
    Number(ownerCount) === JOBS,
    `G1: ${JOBS} leased jobs share only ${ownerCount} distinct owners; two workers hold the same row`,
  );

  // Each leased job should have been attempted exactly once. A worker that
  // blocked and retried would show attempts > 1.
  const [overAttempted] = sql(`
    select count(*) from ops.jobs j join ops.tenants t on t.id = j.tenant_id
     where t.slug = '${SLUG}' and j.attempts <> 1;
  `);
  check(
    Number(overAttempted) === 0,
    `G1: ${overAttempted} jobs were attempted more than once; workers are contending rather than skipping`,
  );

  // ── G2: nothing left to lease ─────────────────────────────────────────────
  // With the queue drained, every worker must come back empty — not error, and
  // not steal a live lease from one of the winners above.
  const second = await Promise.all(
    Array.from({ length: 4 }, (_, i) => leaseOnce(`late-worker-${i}`)),
  );
  const stolen = second
    .map((lines) => lines[lines.length - 1] ?? "")
    .filter((id) => id.length > 0);
  check(
    stolen.length === 0,
    `G2: ${stolen.length} workers leased something from a drained queue — live leases are being stolen`,
  );

  const [ownersAfter] = sql(`
    select count(*) from ops.jobs j join ops.tenants t on t.id = j.tenant_id
     where t.slug = '${SLUG}' and j.lease_owner like 'late-worker-%';
  `);
  check(
    Number(ownersAfter) === 0,
    `G2: ${ownersAfter} jobs were reassigned to a late worker`,
  );

  // ── G3: a locked row must be SKIPPED, not waited on ───────────────────────
  // G1 and G2 do not distinguish SKIP LOCKED from a plain FOR UPDATE: without
  // it, workers serialise instead of double-leasing, so the end state is
  // identical and the mutation passes. (Measured — removing SKIP LOCKED left
  // this file green until this case existed.)
  //
  // The difference is observable only while a row is held: with SKIP LOCKED a
  // worker steps over it and takes the next one; without, it blocks. So hold
  // the head of the queue in one connection and give a second worker a short
  // statement_timeout. Stepping over is a fast success; blocking is a timeout.
  sql(`
    select ops.enqueue_job(t.id, 'conc', '{}'::jsonb, 10, now(), 5, 'head')
      from ops.tenants t where t.slug = '${SLUG}';
    select ops.enqueue_job(t.id, 'conc', '{}'::jsonb, 20, now(), 5, 'tail')
      from ops.tenants t where t.slug = '${SLUG}';
  `);

  const [headId] = sql(`
    select j.id::text from ops.jobs j join ops.tenants t on t.id = j.tenant_id
     where t.slug = '${SLUG}' and j.priority = 10;
  `);

  // Connection 1 takes the row lock and holds it. Deliberately not awaited.
  const holder = sqlAsync(`
    begin;
    select id from ops.jobs where id = '${headId}' for update;
    select pg_sleep(6);
    rollback;
  `).catch(() => undefined);

  // Give the holder time to actually acquire the lock before racing it.
  await new Promise((resolve) => setTimeout(resolve, 1200));

  let skipped = null;
  let blocked = false;
  try {
    const out = await sqlAsync(`
      set statement_timeout = '2s';
      begin;
      set local role ops_worker;
      select coalesce(id::text, '') from ops.lease_job('skip-prober', 60);
      commit;`);
    skipped = out[out.length - 1] ?? "";
  } catch {
    blocked = true;
  }

  check(
    !blocked,
    "G3: leasing blocked on a row another transaction held. FOR UPDATE SKIP LOCKED is not in the lease query, so one slow job stalls every worker.",
  );
  check(
    !blocked && skipped !== "" && skipped !== headId,
    `G3: expected the locked head of the queue to be skipped in favour of the next job; got ${skipped === "" ? "nothing" : skipped === headId ? "the locked row itself" : skipped}`,
  );

  await holder;

  cleanup();

  if (failures.length > 0) {
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  process.stdout.write(
    `  ${WORKERS} concurrent workers, ${JOBS} jobs: ${unique.size} distinct leases, no double-lease, ${elapsed}ms\n`,
  );
}

main().catch((error) => {
  try {
    cleanup();
  } catch {
    // The failure below is the useful one; a cleanup error would mask it.
  }
  console.error(`  ${error.message}`);
  process.exit(1);
});
