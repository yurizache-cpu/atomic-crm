// The one browser act (S7.1: decide_review), live through PostgREST
// (supabase/tests/companyOsApiExposure.mjs). Run while the member is signed in
// and review_open is still pending.

import { randomUUID } from "node:crypto";

import { check, expectAnswer, psql, refusalBody } from "./common.mjs";

const ACT = "decide_review";

/** The review's status and reviewer, and every outbound row that names it. */
function reviewState(t) {
  const [status, reviewer, outbound] = psql(
    `select r.status, coalesce(r.reviewer, '-'),
            (select count(*) from ops.outbound_messages o where o.review_item_id = r.id)
       from ops.review_items r where r.id = :'review';`,
    { review: t.ids.review_open },
  )[0].split("|");
  return { status, reviewer, outbound: Number(outbound) };
}

/**
 * Nobody but the member decides; the browser supplies a review and a decision
 * only; a foreign review answers like a random uuid; a review outside the
 * synthetic and test scope (BASELINE Q8) is refused; the member's decision is
 * recorded once, no-store, as the principal, and nothing is sent.
 */
export async function memberDecidesOnce(t, rpc) {
  const { ids, member } = t;
  const decide = (body, credential = member.credential) =>
    rpc(ACT, body, credential);
  const open = { p_review_id: ids.review_open, p_decision: "rejected" };

  // Identity first: every other signed-in caller is refused OS403, the same
  // bytes, before the review is even looked at.
  const refused = {
    "non-member": t.nonMember,
    "revoked member": t.revoked,
    "member of an ineligible tenant": t.otherTenant,
    "new user with a former member's email": t.formerEmail,
  };
  for (const [who, caller] of Object.entries(refused)) {
    expectAnswer(
      await decide(open, caller.credential),
      400,
      refusalBody("OS403", ACT, "no access"),
      `${who}: ${ACT}`,
    );
  }

  // The tenant, the actor, the reviewer and a note are never inputs.
  for (const extra of [
    { p_tenant_id: t.tenantA },
    { p_actor: `principal:${t.principalId}` },
    { p_reviewer: "someone" },
    { p_note: "a note" },
  ]) {
    expectAnswer(
      await decide({ ...open, ...extra }),
      404,
      "PGRST202",
      `member: ${ACT} with ${Object.keys(extra)[0]}`,
    );
  }

  // Tenant B's review and a random uuid are indistinguishable.
  const other = await decide({
    p_review_id: ids.review_b,
    p_decision: "rejected",
  });
  const random = await decide({
    p_review_id: randomUUID(),
    p_decision: "rejected",
  });
  check(
    other.status === 400 &&
      other.status === random.status &&
      other.text === random.text,
    `member: ${ACT} on another tenant's review is distinguishable from a random uuid`,
  );

  // A review of a task no admission created is outside the Q8 scope.
  expectAnswer(
    await decide({ p_review_id: ids.review_pending, p_decision: "rejected" }),
    400,
    refusalBody("OS403", ACT, "no access"),
    `member: ${ACT} outside the synthetic and test scope`,
  );

  const before = reviewState(t);
  check(
    before.status === "pending" && before.outbound === 0,
    `member: a refused ${ACT} changed the open review (${before.status})`,
  );

  // The decision: recorded once, as the principal, no-store; nothing sent.
  const accepted = await decide({ ...open, p_decision: "accepted" });
  check(
    accepted.status === 200 &&
      accepted.cacheControl === "no-store" &&
      accepted.json?.status === "accepted" &&
      accepted.json?.recorded === true &&
      accepted.json?.reviewItemId === ids.review_open,
    `member: ${ACT} returned ${accepted.status} ${accepted.code ?? ""} ${accepted.cacheControl ?? ""}, expected 200 no-store`,
  );
  const again = await decide({ ...open, p_decision: "accepted" });
  check(
    again.status === 200 && again.json?.recorded === false,
    `member: repeating the same ${ACT} was not answered as already recorded`,
  );
  expectAnswer(
    await decide(open),
    400,
    refusalBody("OS409", ACT, "conflict"),
    `member: changing a decided review`,
  );
  const after = reviewState(t);
  check(
    after.status === "accepted" &&
      after.reviewer === `principal:${t.principalId}` &&
      after.outbound === 0,
    `member: the decision was not recorded as the principal with nothing sent (${after.status}, ${after.outbound} outbound)`,
  );
}

/** The stop `id` as the database holds it. */
function stopRow(id) {
  const [scope, trippedBy, origin, reason, cleared] = psql(
    `select s.scope, s.tripped_by, s.origin, s.reason, (s.cleared_at is not null)::text
       from ops.execution_stops s where s.id = :'stop';`,
    { stop: id },
  )[0].split("|");
  return { scope, trippedBy, origin, reason, cleared: cleared === "true" };
}

/**
 * The second act (S7.2): nobody but the member trips; the browser names a
 * scope and a target only; a global or job_kind stop and another tenant's
 * target are refused; a trip is recorded once as the principal, origin owner,
 * and an existing stop answers already_stopped. Nothing is cleared.
 */
export async function memberTripsOnce(t, rpc) {
  const { ids, member } = t;
  const trip = (body, credential = member.credential) =>
    rpc("trip_stop", body, credential);
  const department = { p_scope: "department", p_target_id: ids.department_a };

  for (const [who, caller] of Object.entries({
    "non-member": t.nonMember,
    "revoked member": t.revoked,
    "member of an ineligible tenant": t.otherTenant,
    "new user with a former member's email": t.formerEmail,
  })) {
    expectAnswer(
      await trip(department, caller.credential),
      400,
      refusalBody("OS403", "trip_stop", "no access"),
      `${who}: trip_stop`,
    );
  }
  for (const extra of [
    { p_tenant_id: t.tenantA },
    { p_actor: `principal:${t.principalId}` },
    { p_reason: "a reason" },
    { p_job_kind: "agent_run.execute" },
  ]) {
    expectAnswer(
      await trip({ ...department, ...extra }),
      404,
      "PGRST202",
      `member: trip_stop with ${Object.keys(extra)[0]}`,
    );
  }
  for (const scope of ["global", "job_kind"]) {
    expectAnswer(
      await trip({ p_scope: scope }),
      400,
      refusalBody("OS403", "trip_stop", "no access"),
      `member: a ${scope} trip_stop`,
    );
  }
  const other = await trip({ p_scope: "company", p_target_id: ids.company_b });
  const random = await trip({ p_scope: "company", p_target_id: randomUUID() });
  check(
    other.status === 400 &&
      other.status === random.status &&
      other.text === random.text,
    "member: trip_stop on another tenant's company is distinguishable from a random uuid",
  );

  const tripped = await trip(department);
  check(
    tripped.status === 200 &&
      tripped.cacheControl === "no-store" &&
      tripped.json?.outcome === "stopped",
    `member: trip_stop returned ${tripped.status} ${tripped.code ?? ""} ${tripped.json?.outcome ?? ""}, expected 200 no-store stopped`,
  );
  const again = await trip(department);
  check(
    again.status === 200 &&
      again.json?.outcome === "already_stopped" &&
      again.json?.stopId === tripped.json?.stopId,
    "member: repeating the same trip_stop was not already_stopped on the same stop",
  );
  const row = stopRow(tripped.json?.stopId);
  check(
    row.scope === "department" &&
      row.trippedBy === `principal:${t.principalId}` &&
      row.origin === "owner" &&
      row.reason === "owner requested execution stop via Company OS" &&
      !row.cleared,
    `member: the trip was not recorded as the principal, origin owner, with the fixed reason (${JSON.stringify(row)})`,
  );
  // The agent already carries the CLI's owner stop: it absorbs the trip.
  const absorbed = await trip({ p_scope: "agent", p_target_id: ids.agent_a });
  check(
    absorbed.status === 200 &&
      absorbed.json?.outcome === "already_stopped" &&
      absorbed.json?.stopId === ids.stop_a,
    "member: an existing owner stop did not absorb the trip",
  );
}
