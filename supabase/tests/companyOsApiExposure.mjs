// The Company OS operator API over the real Data API, with REAL signed-in users
// (Phase 2C; docs/PHASE_2C_BRIEF.md §15 "Data API probe", §16 items marked P;
// owner decision S0-C).
//
// supabase/tests/company_os_api.sql proves the gates inside one rolled-back
// transaction, with claims it sets by hand. What only a request can show is
// what PostgREST, Kong and GoTrue do with a real session. This probe creates
// real GoTrue users through the local admin API, mints their sessions with an
// admin magic link (password login stays disabled on these stacks and is not
// enabled for tests, S0-C), grants memberships through the owner service, and
// then sends requests, raw and through supabase-js, exactly as a browser would:
//
//   * a member resolves, through supabase-js and through fetch, and reads every
//     catalogued function successfully, get_run on a planted run included;
//     every successful answer carries `Cache-Control: no-store`; no answer
//     carries an Auth email, its hash, the display name, a task title or body,
//     an agent's role or description, a run's stored result (reply draft,
//     summary, next action), keys, fingerprints, correlation or provider ids,
//     a job's id, lease owner, raw error or step detail, a price row, a raw
//     actor label (the PR #6 fixtures A to C: an email-like reviewer,
//     tripped_by, cleared_by and requested_by, and a channel's configured_by),
//     a provider target, a contact reference, a caller-supplied event source,
//     or anything of the other tenant;
//   * a foreign id answers exactly like a random one, for each selector with a
//     tenant B id of the same kind (agent, task, run, review) and of other
//     kinds, and for the list filters and a cursor naming a tenant B row;
//   * the live catalogue equals this probe's CATALOGUE exactly, both in the
//     member's company_os_api OpenAPI document and in pg_proc: a new exposed
//     function fails the probe until it has an entry, and so a matrix;
//   * a signed-in non-member, a revoked member, a member of a tenant outside
//     the Phase 2C eligibility policy and a new user holding a former member's
//     email are each refused OS403, byte for byte identically, for every
//     function and for well-typed arguments that name real rows;
//   * no key (anon), the publishable key and the anon JWT are refused 401 42501
//     at the schema, and the service_role JWT and the secret key 403 42501: the
//     most privileged Data API role cannot run an operator function either;
//   * `ops` answers 406 PGRST106 by profile for every credential, a signed-in
//     member included, across the whole live ops catalogue for the member;
//   * a tenant, company, actor or reviewer argument, or any other extra key,
//     matches no function (404 PGRST202), and neither browser act exists
//     (decide_review, trip_stop: 404 PGRST202) before S8;
//   * GraphQL introspection with a member's JWT reflects nothing of
//     company_os_api or ops, and the anonymous OpenAPI document lists no
//     company_os_api function;
//   * an admin email change keeps the principal, its tenant and its live
//     sessions: an email never selects a principal;
//   * after POST /auth/v1/logout the old access token is refused OS401 on the
//     next call, while the member's other session still resolves.
//
// FIXTURE (companyOsProbe/fixture.mjs). PostgREST sees only committed rows,
// so this probe commits them, each piece in one owner transaction. It reuses
// TWO PERSISTENT probe tenants, found by their fixed slugs `cos-probe-a` and
// `cos-probe-b` on every run and created on first use: a membership references
// its tenant and is never deleted, so a probe tenant can never be deleted
// either. Tenant A becomes, for the run, the one tenant that owns the local
// CRM; tenant B is not eligible and holds the membership that proves it. Per
// run, it plants in A a small organisation, one succeeded lead_triage run
// (born pending through an owner insert, moved through its states under the
// run guard, its job born succeeded so no worker can lease it, priced by the
// probe's own price row), the review opened from that run's stored result, a
// synthetic lead admitted through ops.admit_inbound_message whose own run is
// refused at the request with no job (tenant A has no budget), a second run on
// that task that succeeded the same way, the review the runtime path opens
// from it (ops.open_review_for_run, carrying the admission's consent), decided
// through the owner service ops.record_review_decision as the CLI records one
// (legacy fixture A), an active and a cleared stop (B), and an inactive test
// channel carrying one authorized, never sent, send on that review (C); and in
// B an organisation with a task, a pending run and a pending review of its
// own. Auth users are created under @example.test with a per-run suffix.
//
// CLEANUP (companyOsProbe/cleanup.mjs). The probe never disables a trigger
// and never deletes a principal or a membership: the ENABLE ALWAYS guards on
// ops.principals and ops.tenant_memberships (brief §7.4, §16) refuse both,
// and the probe respects them. At the end it revokes every probe membership
// through ops.revoke_membership, disables every probe principal once (the one
// change its guard allows), deletes every per-run row of the two tenants and
// the price row, and deletes the synthetic auth users (their CRM sales rows
// first). WHAT REMAINS on the stack after a run is the two probe tenants and
// the revoked memberships and disabled principals of synthetic identities
// whose auth users no longer exist; none can resolve. Each cleanup step runs
// on its own, so one failure never skips another, and a final check verifies
// the end state, the four identity guards still ENABLE ALWAYS included.
//
// THE LOCAL-CRM FLAG. The run takes `owns_local_crm` for tenant A and records
// the tenant that held it in tenant B's name, in the same transaction; the
// give-back reads that record, returns the flag unless another tenant took it
// meanwhile, and removes the record only once the flag is back. A run that was
// killed leaves the record, and the next run's leftover sweep gives the flag
// back before anything else. When the flag cannot go back (another tenant
// holds it, or the lender is gone), the record is NEVER discarded: it stays,
// and the sweep of every later run stops with the recovery, word for word
// (cleanup.mjs, restoreLocalCrmFlag): as the database owner, either give the
// flag back to the lender (clear it where it is, set it on the lender) or
// accept where it is (restore tenant B's name to its sentinel), then rerun.
//
// CONCURRENCY. Every run holds a session-level advisory lock, taken by a psql
// session of its own before anything is read or written and released at the
// very end (a killed run's session ends, and the lock with it). A second run
// waits up to 300 s for the first, so two runs never share the probe tenants,
// the flag or the leftover sweep, and the sweep at the start can remove all
// that the probe owns. The lock scopes PROBE RUNS ONLY: no other suite takes
// it, so it serialises nothing else, and this probe can disturb other suites
// and be disturbed by them. It commits the owns_local_crm move for its run
// (PostgREST sees only committed rows, and the eligibility policy needs the
// flag), so for the length of a run a concurrent suite whose own tenant must
// own the local CRM (the engine dbtests, whose resetFixtures puts the flag on
// dbtest-a; the membership and Company OS dbtests that grant through it) can
// see its members refused by the eligibility policy, and a suite that takes
// the flag back makes this probe fail with a refusal (and, at the give-back,
// with the recovery above); neither passes wrongly. The SQL suites that take
// the flag inside their own transaction (company_os_api.sql,
// whatsapp_transport.sql) only wait for the probe's short flag transactions.
// The probe also trips and clears stops of its own tenant A, each holding the
// kill-switch lock exclusively for an instant, and commits rows and events in
// its two tenants. Run it when no engine dbtest is running.
//
// It prints no key, token or password: keys come from `supabase status` at
// runtime and stay in memory. It fails closed: a stack it cannot find, a key it
// cannot read, a lock it cannot take or a fixture it cannot build is a
// FAILURE, never a skip. All data is synthetic office-operations text.
//
// Run by scripts/run-db-tests.mjs, like every script suite in this directory
// (the helpers in companyOsProbe/ are not suites). SUPABASE_DB_CONTAINER picks
// the stack (default: the isolated e2e stack); SUPABASE_WORKDIR overrides the
// CLI workdir.

import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  CATALOGUE,
  EMAIL_DOMAIN,
  EMAIL_PREFIX,
  UUID,
  apiOrigin,
  authOf,
  check,
  failures,
  readKeys,
  request,
  requestCount,
} from "./companyOsProbe/common.mjs";
import {
  buildOffice,
  ensureProbeTenants,
  grantMemberships,
  lendLocalCrmFlag,
  runValues,
} from "./companyOsProbe/fixture.mjs";
import {
  cleanup,
  holdProbeLock,
  sweepLeftovers,
} from "./companyOsProbe/cleanup.mjs";
import {
  contextArgumentsMatchNothing,
  memberResolves,
  sweepMemberOutputs,
} from "./companyOsProbe/memberChecks.mjs";
import {
  graphqlAndOpenApi,
  keysAreRefused,
  opsStaysClosed,
} from "./companyOsProbe/surfaceChecks.mjs";
import {
  emailChangeKeepsThePrincipal,
  othersAreRefused,
  signOutTakesEffect,
} from "./companyOsProbe/sessionChecks.mjs";

const CLIENT_OPTIONS = Object.freeze({
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});

async function main() {
  const origin = apiOrigin();
  const keys = readKeys();
  const lock = await holdProbeLock();
  try {
    await probe(origin, keys);
  } finally {
    await lock.release();
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  process.stdout.write(
    `  ${CATALOGUE.length} company_os_api functions, 5 keys and 7 real sessions: ${requestCount()} requests; only a live member session resolved, ops answered 406 to all\n`,
  );
}

/** One run under the lock: sweep, fixture, checks, then the cleanup. */
async function probe(origin, keys) {
  const rest = `${origin}/rest/v1`;
  const admin = createClient(origin, keys.service_role, CLIENT_OPTIONS);
  const run = randomBytes(4).toString("hex");
  const emailOf = (who) => `${EMAIL_PREFIX}${who}-${run}${EMAIL_DOMAIN}`;
  const createdUsers = [];

  /** A confirmed auth user (unless it exists) and one real session for it. */
  async function signIn(email, { create = true } = {}) {
    if (create) {
      const created = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
      });
      if (created.error || !UUID.test(created.data?.user?.id ?? "")) {
        throw new Error(`admin createUser failed: ${created.error?.message}`);
      }
      createdUsers.push(created.data.user.id);
    }
    const link = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (link.error || !link.data?.properties?.hashed_token) {
      throw new Error(`admin generateLink failed: ${link.error?.message}`);
    }
    const client = createClient(origin, keys.anon, CLIENT_OPTIONS);
    const verified = await client.auth.verifyOtp({
      type: "magiclink",
      token_hash: link.data.properties.hashed_token,
    });
    const token = verified.data?.session?.access_token;
    if (verified.error || !token) {
      throw new Error(`verifyOtp failed: ${verified.error?.message}`);
    }
    return {
      email,
      userId: link.data.user.id,
      client,
      credential: { apikey: keys.anon, bearer: token },
    };
  }

  const rpc = (fn, body, credential, profile = "company_os_api") =>
    request(`${rest}/rpc/${fn}`, {
      method: "POST",
      headers: {
        ...authOf(credential),
        "Content-Profile": profile,
        "Content-Type": "application/json",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  const t = { ...ensureProbeTenants(), values: runValues(), outputs: [] };
  await sweepLeftovers(admin);
  try {
    t.lender = lendLocalCrmFlag();
    t.ids = buildOffice(t);
    t.member = await signIn(emailOf("member"));
    t.memberOther = await signIn(t.member.email, { create: false });
    t.nonMember = await signIn(emailOf("non-member"));
    t.revoked = await signIn(emailOf("revoked"));
    t.otherTenant = await signIn(emailOf("other-tenant"));
    t.principalId = grantMemberships(t);
    t.keyCredentials = {
      none: {},
      publishable: { apikey: keys.publishable },
      anon: { apikey: keys.anon, bearer: keys.anon },
      service_role: { apikey: keys.service_role, bearer: keys.service_role },
      secret: { apikey: keys.secret },
    };
    // Arguments naming REAL rows of tenant A, so a refusal is identity
    // established before data, never a missing row.
    t.argsFor = (fn) =>
      ({
        get_agent: { p_agent_id: t.ids.agent_a },
        get_task: { p_task_id: t.ids.task_a },
        get_run: { p_run_id: t.ids.run_a },
        get_review: { p_review_id: t.ids.review_pending },
        get_review_advice: { p_review_id: t.ids.review_pending },
      })[fn] ?? {};
    /** A member read that must succeed, kept for the final sweep. */
    t.read = async (fn, args, credential = t.member.credential) => {
      const answer = await rpc(fn, args, credential);
      check(
        answer.status === 200,
        `member: ${fn} returned ${answer.status} ${answer.code ?? ""}, expected 200`,
      );
      check(
        answer.cacheControl === "no-store",
        `member: ${fn} answered with Cache-Control ${answer.cacheControl ?? "(none)"}, expected no-store`,
      );
      t.outputs.push({ fn, text: answer.text });
      return answer.json;
    };

    await memberResolves(t);
    await contextArgumentsMatchNothing(t, rpc);
    await keysAreRefused(t, rpc);
    await opsStaysClosed(t, rest);
    await graphqlAndOpenApi(t, origin, rest);
    await emailChangeKeepsThePrincipal(t, admin, signIn, emailOf);
    await othersAreRefused(t, rpc);
    await signOutTakesEffect(t, origin, keys, rpc);
    sweepMemberOutputs(t);
  } finally {
    await cleanup(admin, createdUsers, t.lender);
  }
}

main().catch((error) => {
  console.error(`  ${error.message}`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
});
