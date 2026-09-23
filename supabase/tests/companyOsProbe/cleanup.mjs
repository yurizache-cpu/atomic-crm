// Serialisation and cleanup for the Company OS Data API probe
// (supabase/tests/companyOsApiExposure.mjs, FIXTURE and CONCURRENCY).
//
// Nothing here disables a trigger, and nothing deletes a principal or a
// membership: the ENABLE ALWAYS guards on ops.principals and
// ops.tenant_memberships (brief §7.4) refuse both, the owner included, and the
// probe respects them. Identities are retired through the supported paths
// instead: a membership is revoked through the owner service
// ops.revoke_membership, a principal is disabled once (the one change its guard
// allows), and the synthetic auth user behind it is deleted.

import { spawn } from "node:child_process";
import {
  ACTOR,
  CONTAINER,
  DISPLAY_PREFIX,
  EMAIL_DOMAIN,
  EMAIL_PREFIX,
  IN_PROBE_TENANTS,
  PRICE,
  PROBE_SLUGS,
  SLUG_B,
  TENANT_A_NAME,
  TENANT_B_NAME,
  UUID,
  check,
  failures,
  psql,
} from "./common.mjs";
import { LENT_BY } from "./fixture.mjs";

/** The session-level advisory lock every probe run holds while it runs. */
const LOCK = "hashtextextended('cos-probe:company_os_api exposure probe', 0)";
/** How long a run waits for another run's lock before it fails. */
const LOCK_WAIT = "300s";
const LOCKED = "cos-probe-lock-held";

/** Probe principals: the probe's display prefix, and no membership elsewhere. */
const PROBE_PRINCIPALS = `(
  select p.id from ops.principals p
   where p.display_name like '${DISPLAY_PREFIX}%'
     and not exists (select 1 from ops.tenant_memberships m
                      where m.principal_id = p.id and m.tenant_id not in ${IN_PROBE_TENANTS}))`;
/** The four identity guards, which must stay ENABLE ALWAYS. */
const IDENTITY_GUARDS = `('principals_guard_change', 'principals_refuse_truncate',
  'tenant_memberships_guard_change', 'tenant_memberships_refuse_truncate')`;

/**
 * Holds the probe's advisory lock in a psql session of its own until
 * `release`. A second run waits (at most LOCK_WAIT) for the first to finish,
 * so two runs never share the probe tenants or the local-CRM flag. If this
 * process dies, its session ends and the lock goes with it.
 */
export async function holdProbeLock() {
  const session = spawn(
    "docker",
    [
      "exec",
      "-i",
      CONTAINER,
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      "postgres",
    ].concat(["-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"]),
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let out = "";
  let err = "";
  session.stdout.setEncoding("utf8");
  session.stderr.setEncoding("utf8");
  const exited = new Promise((resolve) => session.on("close", resolve));
  await new Promise((resolve, reject) => {
    session.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes(LOCKED)) resolve();
    });
    session.stderr.on("data", (chunk) => {
      err += chunk;
    });
    session.on("error", reject);
    exited.then(() => {
      const line = err.split("\n").find((l) => /ERROR/.test(l));
      reject(
        new Error(
          `could not take the probe lock within ${LOCK_WAIT}: ${line?.trim() ?? "psql exited"}`,
        ),
      );
    });
    session.stdin.write(
      `set application_name = 'cos-probe lock';
       set lock_timeout = '${LOCK_WAIT}';
       select pg_advisory_lock(${LOCK});
       select '${LOCKED}';\n`,
    );
  });
  return {
    async release() {
      session.stdin.end(`select pg_advisory_unlock(${LOCK});\n`);
      const timer = setTimeout(() => session.kill(), 10_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

/** Revokes every active probe membership and disables every probe principal. */
export function retireProbeIdentities() {
  psql(
    `begin;
     select ops.revoke_membership(m.id, '${ACTOR}', 'probe cleanup')
       from ops.tenant_memberships m
      where m.revoked_at is null
        and (m.tenant_id in ${IN_PROBE_TENANTS} or m.principal_id in ${PROBE_PRINCIPALS});
     update ops.principals set disabled_at = now(), disabled_by = '${ACTOR}'
      where disabled_at is null and id in ${PROBE_PRINCIPALS};
     commit;`,
  );
}

/**
 * Gives the local-CRM flag back: no probe tenant keeps it, and the tenant the
 * record in tenant B's name names gets it back unless another tenant took the
 * flag meanwhile. The record is removed only once the flag is back with that
 * tenant (or when there was none). Otherwise, when another tenant holds the
 * flag or the lender is gone, the record STAYS and this throws with the exact
 * recovery: the start-of-run sweep then stops every run, and the end-of-run
 * cleanup reports it, until a person decides who keeps the flag. A record is
 * never discarded in silence. Resolves to the lender, or undefined.
 */
export function restoreLocalCrmFlag() {
  const [name] = psql(`select name from ops.tenants where slug = '${SLUG_B}';`);
  const at = name?.indexOf(LENT_BY) ?? -1;
  const lender = at === -1 ? undefined : name.slice(at + LENT_BY.length);
  if (lender !== undefined && !UUID.test(lender)) {
    throw new Error("tenant B carries an unreadable local-CRM flag record");
  }
  const lines = psql(
    `begin;
     update ops.tenants set owns_local_crm = false where slug in ${PROBE_SLUGS} and owns_local_crm;
     ${
       lender
         ? `update ops.tenants set owns_local_crm = true
             where id = :'lender' and not exists (select 1 from ops.tenants where owns_local_crm);`
         : ""
     }
     update ops.tenants set name = '${TENANT_B_NAME}'
      where slug = '${SLUG_B}' and name <> '${TENANT_B_NAME}'
        ${lender ? `and exists (select 1 from ops.tenants where id = :'lender' and owns_local_crm)` : ""};
     select 'holder=' || coalesce((select id::text from ops.tenants where owns_local_crm), 'none');
     commit;`,
    lender ? { lender } : {},
  );
  const holder = lines
    .find((line) => line.startsWith("holder="))
    ?.slice("holder=".length);
  if (lender !== undefined && holder !== lender) {
    const now =
      holder === undefined || holder === "none"
        ? "no tenant holds it now (the lender no longer takes it back)"
        : `tenant ${holder} holds it now`;
    throw new Error(
      `the local-CRM flag was lent by tenant ${lender}, but ${now}, so the probe cannot give it back; ` +
        `the record stays in the name of tenant ${SLUG_B}, and every run stops here until a person ` +
        `decides, as the database owner, then runs the probe again. To give the flag back: ` +
        `update ops.tenants set owns_local_crm = false where owns_local_crm; ` +
        `update ops.tenants set owns_local_crm = true where id = '${lender}'; ` +
        `(the next run's sweep then removes the record). To leave the flag where it is instead: ` +
        `update ops.tenants set name = '${TENANT_B_NAME}' where slug = '${SLUG_B}';`,
    );
  }
  return lender;
}

/**
 * Removes every per-run row of the two probe tenants, in foreign-key order,
 * and the probe's price row: never the tenants, a principal or a membership.
 * An active stop is cleared first, through the owner service
 * ops.clear_execution_stop, because its guard refuses to delete it; its events
 * go with the others.
 */
export function removeProbeRows() {
  const inProbe = IN_PROBE_TENANTS;
  psql(
    `begin;
     set local lock_timeout = '10s';
     select ops.clear_execution_stop(s.id, 'probe cleanup', '${ACTOR}')
       from ops.execution_stops s
      where s.tenant_id in ${inProbe} and s.cleared_at is null;
     delete from ops.outbound_messages where tenant_id in ${inProbe};
     delete from ops.review_items where tenant_id in ${inProbe};
     delete from ops.inbound_messages where tenant_id in ${inProbe};
     delete from ops.conversations where tenant_id in ${inProbe};
     delete from ops.communication_channels where tenant_id in ${inProbe};
     delete from ops.agent_runs where tenant_id in ${inProbe};
     delete from ops.task_jobs where tenant_id in ${inProbe};
     delete from ops.events where tenant_id in ${inProbe};
     delete from ops.execution_stops where tenant_id in ${inProbe};
     update ops.spend_limits set ended_by = '${ACTOR}', end_reason = 'probe cleanup'
      where tenant_id in ${inProbe} and ended_at is null;
     delete from ops.spend_limits where tenant_id in ${inProbe};
     delete from ops.tasks where tenant_id in ${inProbe};
     delete from ops.agents where tenant_id in ${inProbe};
     delete from ops.departments where tenant_id in ${inProbe};
     delete from ops.companies where tenant_id in ${inProbe};
     delete from ops.job_events where tenant_id in ${inProbe};
     delete from ops.jobs where tenant_id in ${inProbe};
     delete from ops.model_prices p
      where p.provider = '${PRICE.provider}'
        and not exists (select 1 from ops.agent_runs r where r.price_id = p.id);
     commit;`,
  );
}

/** The probe's auth users: their CRM sales rows first, which block the delete. */
export async function removeProbeUsers(admin, knownIds = []) {
  const leftover = psql(
    `select id from auth.users where email like '${EMAIL_PREFIX}%${EMAIL_DOMAIN}';`,
  );
  const userIds = [...new Set([...knownIds, ...leftover])].filter((id) =>
    UUID.test(id),
  );
  if (userIds.length === 0) return;
  // Every id matched UUID above, so the array literal carries nothing else.
  psql(
    `delete from public.sales where user_id = any('{${userIds.join(",")}}'::uuid[]);`,
  );
  for (const id of userIds) {
    const deleted = await admin.auth.admin.deleteUser(id);
    if (deleted.error && !/not found/i.test(deleted.error.message)) {
      throw new Error(`admin deleteUser failed: ${deleted.error.message}`);
    }
  }
}

/**
 * What an interrupted run left, removed before anything else, strictly: a step
 * that fails stops the run, so a stranded flag record is never overwritten.
 */
export async function sweepLeftovers(admin) {
  retireProbeIdentities();
  restoreLocalCrmFlag();
  removeProbeRows();
  await removeProbeUsers(admin);
}

/** The end state a run must leave, the local-CRM flag back with its lender. */
function verifyCleanup(lender) {
  const [state] = psql(`
    select (select count(*) from ops.tenant_memberships
             where revoked_at is null and tenant_id in ${IN_PROBE_TENANTS})
        || ',' || (select count(*) from ops.principals
                    where disabled_at is null and display_name like '${DISPLAY_PREFIX}%')
        || ',' || (select count(*) from ops.tenants
                    where slug in ${PROBE_SLUGS} and (owns_local_crm or name not in ('${TENANT_B_NAME}', '${TENANT_A_NAME}')))
        || ',' || ((select count(*) from ops.companies where tenant_id in ${IN_PROBE_TENANTS})
                 + (select count(*) from ops.events where tenant_id in ${IN_PROBE_TENANTS})
                 + (select count(*) from ops.agent_runs where tenant_id in ${IN_PROBE_TENANTS})
                 + (select count(*) from ops.jobs where tenant_id in ${IN_PROBE_TENANTS})
                 + (select count(*) from ops.execution_stops where tenant_id in ${IN_PROBE_TENANTS}))
        || ',' || (select count(*) from ops.model_prices where provider = '${PRICE.provider}')
        || ',' || (select count(*) from auth.users where email like '${EMAIL_PREFIX}%${EMAIL_DOMAIN}')
        || ',' || (select count(*) from pg_trigger where tgname in ${IDENTITY_GUARDS} and tgenabled = 'A');`);
  check(
    state === "0,0,0,0,0,0,4",
    `cleanup left an active membership, an enabled principal, a flag or record on a probe tenant, a per-run row, the price, an auth user, or an identity guard not ENABLE ALWAYS (${state}, expected 0,0,0,0,0,0,4)`,
  );
  if (lender) {
    const [holds] = psql(
      "select owns_local_crm from ops.tenants where id = :'lender';",
      { lender },
    );
    check(
      holds === "t",
      "cleanup could not give the local-CRM flag back to the tenant that held it (another tenant took it during the run)",
    );
  }
}

/**
 * The end of a run: each step on its own, so one that fails never skips the
 * others; the flag goes back even when the auth API is down. Each failure is
 * recorded, and the next run's leftover sweep finishes the job.
 */
export async function cleanup(admin, createdUsers, lender) {
  const steps = [
    ["retire the probe's identities", () => retireProbeIdentities()],
    ["give the local-CRM flag back", () => restoreLocalCrmFlag()],
    ["remove the probe's rows", () => removeProbeRows()],
    [
      "remove the probe's auth users",
      () => removeProbeUsers(admin, createdUsers),
    ],
    ["verify the cleanup", () => verifyCleanup(lender)],
  ];
  for (const [what, step] of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(`cleanup could not ${what}: ${error.message}`);
    }
  }
}
