// The Company OS operator API as a signed-in tenant member reaches it, for the
// Phase 2C driver-backed suites (companyOs*.dbtest.ts): over the real `pg`
// driver, as PostgREST would call it, with nothing but the read gates between
// the caller and ops.
//
// PostgREST verifies a JWT, switches to `authenticated` and sets
// `request.jwt.claims`; the company_os_api function then runs as
// ops_operator_api and enters ops only through its identity gate, which
// resolves the caller from those claims, a live auth session, an unbanned auth
// user and one active membership of an eligible tenant. readAsMember builds
// exactly that on an owner connection: a synthetic auth user and session, a
// membership granted through the owner service ops.grant_membership, then
// `set local role authenticated` and the claims. Everything is ROLLED BACK, so
// no principal or membership (which are immutable and never deleted) outlives
// the call, and the fixture's `delete from ops.tenants` keeps working.
//
// The HTTP path itself, with real GoTrue users, is supabase/tests/
// companyOsApiExposure.mjs. It lives in engine/domain because only there may
// code import the domain services and the database fixture together
// (eslint.config.js). All data is synthetic.

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  COMPANY_OS_OPERATION_NAMES,
  type CompanyOsOperation,
} from "../../../contracts/company-os-api/index.ts";
import type { TxClient, WorkerDatabase } from "../../db/types.ts";

/**
 * The Phase 2C read catalogue (brief §8 rows 1-15), taken from the contracts,
 * which companyOsContracts.dbtest.ts pins to pg_proc, so this helper can never
 * call a function the catalogue does not name. It never calls an act.
 */
export const COMPANY_OS_READS = COMPANY_OS_OPERATION_NAMES;

export type CompanyOsRead = CompanyOsOperation;

/** A PostgREST-style named argument: a pinned selector, enum, cursor or limit. */
const ARGUMENT_NAME = /^p_[a-z_]+$/;

export interface ApiOutput<T> {
  readonly fn: CompanyOsRead;
  /** The jsonb envelope exactly as the database rendered it. */
  readonly text: string;
  readonly value: T;
}

export interface MemberReads {
  /**
   * Calls one company_os_api read as the member. A refusal is not caught: the
   * whole read session fails, with the gate's own SQLSTATE and message.
   */
  read<T = Record<string, unknown>>(
    fn: CompanyOsRead,
    args?: Readonly<Record<string, unknown>>,
  ): Promise<ApiOutput<T>>;
}

export interface MemberIdentity {
  readonly authUserId: string;
  readonly sessionId: string;
  readonly email: string;
}

/** The synthetic member of one read session. Its address is invented. */
export const memberIdentity = (): MemberIdentity => {
  const authUserId = randomUUID();
  return {
    authUserId,
    sessionId: randomUUID(),
    email: `dbtest-cos-member-${authUserId.slice(0, 8)}@example.test`,
  };
};

class RolledBack<T> {
  constructor(readonly value: T) {}
}

/**
 * Signs `tx` in as a member of `tenantId`, exactly as PostgREST would call
 * company_os_api: a synthetic auth user and session, the local-CRM flag lent
 * to the tenant, a membership, then `authenticated` and the claims. The caller
 * owns the transaction and must roll it back.
 */
export async function signInAsMember(
  tx: TxClient,
  tenantId: string,
  member: MemberIdentity,
): Promise<void> {
  // The auth user fires the CRM's signup trigger, which gives it a sales row:
  // the same path a real invitation takes, rolled back with everything else.
  await tx.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                             email_confirmed_at, created_at, updated_at,
                             raw_app_meta_data, raw_user_meta_data)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
             $2, '', now(), now(), now(), '{}',
             '{"first_name":"Synthetic","last_name":"Member"}')`,
    [member.authUserId, member.email],
  );
  await tx.query(
    `insert into auth.sessions (id, user_id, created_at, updated_at)
     values ($1, $2, now(), now())`,
    [member.sessionId, member.authUserId],
  );
  // The Phase 2C eligibility policy: the one tenant that owns the local CRM.
  // resetFixtures already gives it to TENANT_A; these touch no row then. Two
  // statements, because the unique index allows one holder at every step.
  await tx.query(
    "update ops.tenants set owns_local_crm = false where owns_local_crm and id <> $1",
    [tenantId],
  );
  await tx.query(
    "update ops.tenants set owns_local_crm = true where id = $1 and not owns_local_crm",
    [tenantId],
  );
  await tx.query(
    `select ops.grant_membership($1, $2, 'dbtest member', 'dbtest',
                                 'dbtest synthetic member of a rolled-back read session')`,
    [tenantId, member.authUserId],
  );
  // What PostgREST does with a verified JWT, in its order.
  await tx.query("set local role authenticated");
  await tx.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({
      iss: "dbtest",
      sub: member.authUserId,
      aud: "authenticated",
      role: "authenticated",
      email: member.email,
      session_id: member.sessionId,
      is_anonymous: false,
    }),
  ]);
}

/**
 * Runs `reads` as a signed-in member of `tenantId` inside ONE owner
 * transaction that is always rolled back, and resolves to what they returned.
 */
export async function readAsMember<T>(
  owner: WorkerDatabase,
  tenantId: string,
  reads: (member: MemberReads, identity: MemberIdentity) => Promise<T>,
): Promise<T> {
  const identity = memberIdentity();
  try {
    await owner.withTransaction(async (tx) => {
      await signInAsMember(tx, tenantId, identity);
      const member: MemberReads = {
        async read<R>(
          fn: CompanyOsRead,
          args: Readonly<Record<string, unknown>> = {},
        ): Promise<ApiOutput<R>> {
          if (!(COMPANY_OS_READS as readonly string[]).includes(fn)) {
            throw new Error(`${fn} is not a catalogued read`);
          }
          const names = Object.keys(args);
          for (const name of names) {
            if (!ARGUMENT_NAME.test(name)) {
              throw new Error(`${name} is not a named argument`);
            }
          }
          const named = names.map((name, i) => `${name} => $${i + 1}`);
          const { rows } = await tx.query<{ body: string }>(
            `select company_os_api.${fn}(${named.join(", ")})::text as body`,
            names.map((name) => args[name]),
          );
          const text = rows[0]?.body;
          if (typeof text !== "string") {
            throw new Error(`company_os_api.${fn} returned no envelope`);
          }
          return { fn, text, value: JSON.parse(text) as R };
        },
      };
      throw new RolledBack(await reads(member, identity));
    });
  } catch (outcome) {
    if (outcome instanceof RolledBack) return outcome.value as T;
    throw outcome;
  }
  throw new Error("the member read session committed; it must roll back");
}

export interface StopRef {
  readonly id: string;
  readonly scope: string;
  readonly origin: string;
}

export interface AgentEvidence {
  readonly workingRunIds: string[];
  readonly heldRunIds: string[];
  readonly queuedRunIds: string[];
  readonly staleRunIds: string[];
  readonly attentionRunIds: string[];
  readonly stop: StopRef | null;
  readonly inactiveUnit: "agent" | "department" | "company" | null;
}

export interface AgentSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly availability: "inactive" | "stopped" | "available";
  readonly activity: "working" | "stale" | "held" | "queued" | "idle";
  readonly attentionCount: number;
  readonly lastRunAt: string | null;
  readonly evidence: AgentEvidence;
}

export interface AgentList {
  readonly items: AgentSummary[];
}

/** The agent's summary in a list_agents answer, or a failed case. */
export function agentIn(list: AgentList, agentId: string): AgentSummary {
  const agent = list.items.find((item) => item.id === agentId);
  if (!agent) throw new Error(`list_agents does not report agent ${agentId}`);
  return agent;
}

interface EvidenceRow {
  id: string;
  agent_id: string;
  run_status: string;
  job_status: string | null;
  live: boolean | null;
  covering_stop: string | null;
  retried: boolean;
}

/** What each evidence list claims about every run id it carries. */
const EVIDENCE_RULES: ReadonlyArray<
  readonly [keyof AgentEvidence, string, (row: EvidenceRow) => boolean]
> = [
  [
    "workingRunIds",
    "running with a live lease",
    (r) => r.run_status === "running" && r.live === true,
  ],
  [
    "staleRunIds",
    "running without a live lease",
    (r) => r.run_status === "running" && r.live !== true,
  ],
  [
    "heldRunIds",
    "pending, its job queued under a covering stop",
    (r) =>
      r.run_status === "pending" &&
      r.job_status === "queued" &&
      r.covering_stop !== null,
  ],
  [
    "queuedRunIds",
    "pending, its job queued under no stop",
    (r) =>
      r.run_status === "pending" &&
      r.job_status === "queued" &&
      r.covering_stop === null,
  ],
  [
    "attentionRunIds",
    "stale, or indeterminate and never retried",
    (r) =>
      (r.run_status === "running" && r.live !== true) ||
      (r.run_status === "indeterminate" && !r.retried),
  ],
];

/**
 * Every evidence id an agent summary carries, checked against the database as
 * it is now: each run belongs to that agent in that tenant and is in the state
 * its list claims, and a stop is an active stop naming the tenant. Resolves to
 * the faults found; a truthful answer has none.
 */
export async function evidenceFaults(
  admin: Pool,
  tenantId: string,
  agents: readonly AgentSummary[],
): Promise<string[]> {
  const faults: string[] = [];
  for (const agent of agents) {
    const ids = EVIDENCE_RULES.flatMap(
      ([list]) => agent.evidence[list] as string[],
    );
    const { rows } = await admin.query<EvidenceRow>(
      `select r.id, r.agent_id, r.status as run_status, j.status as job_status,
              (j.status = 'leased' and j.lease_expires_at > clock_timestamp()
               and j.attempts = r.job_attempt) as live,
              ops.job_covering_stop(r.tenant_id, j.id, j.kind) as covering_stop,
              exists (select 1 from ops.agent_runs x where x.retry_of_run_id = r.id) as retried
         from ops.agent_runs r
         left join ops.jobs j on j.id = r.job_id
        where r.tenant_id = $1 and r.id = any($2::uuid[])`,
      [tenantId, ids],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const [list, claim, holds] of EVIDENCE_RULES) {
      for (const id of agent.evidence[list] as string[]) {
        const row = byId.get(id);
        if (!row) {
          faults.push(
            `${agent.name}: ${list} names ${id}, no run of the tenant`,
          );
        } else if (row.agent_id !== agent.id) {
          faults.push(
            `${agent.name}: ${list} names ${id}, another agent's run`,
          );
        } else if (!holds(row)) {
          faults.push(
            `${agent.name}: ${list} names ${id}, which is not ${claim} (${row.run_status}/${row.job_status ?? "-"})`,
          );
        }
      }
    }
    const stop = agent.evidence.stop;
    if (stop) {
      const { rows: stops } = await admin.query<{
        tenant_id: string | null;
        scope: string;
        origin: string;
        active: boolean;
      }>(
        `select tenant_id, scope, origin, cleared_at is null as active
           from ops.execution_stops where id = $1`,
        [stop.id],
      );
      const row = stops[0];
      if (
        !row ||
        row.tenant_id !== tenantId ||
        !row.active ||
        row.scope !== stop.scope ||
        row.origin !== stop.origin
      ) {
        faults.push(
          `${agent.name}: evidence.stop ${stop.id} is not an active ${stop.scope} stop naming the tenant`,
        );
      }
    }
  }
  return faults;
}

/** The forbidden values found in any output, as `<fn>: <label>`. */
export function leaks(
  outputs: readonly ApiOutput<unknown>[],
  forbidden: ReadonlyMap<string, string>,
): string[] {
  const found: string[] = [];
  for (const output of outputs) {
    for (const [label, value] of forbidden) {
      if (value !== "" && output.text.includes(value)) {
        found.push(`${output.fn}: ${label}`);
      }
    }
  }
  return found;
}
