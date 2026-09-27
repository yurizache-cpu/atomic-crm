// The four commercial acts (Phase 3B.2, owner decision R), live through
// PostgREST (supabase/tests/companyOsApiExposure.mjs). Their semantics, the
// bridge and the act log are proven in supabase/tests/
// commercial_opportunity_acts.sql and engine/domain/
// commercialOpportunityActs.dbtest.ts; here, the HTTP surface: who reaches
// them, which arguments exist, and that a deal the browser was never shown
// answers exactly like one that does not exist. Nothing here changes a deal.

import { check, expectAnswer, refusalBody } from "./common.mjs";

const ZERO_REVISION = `r1.${"0".repeat(32)}`;

/** A well-typed call of each act, naming a deal id no browser was shown. */
const CALLS = Object.freeze({
  move_opportunity: (ref) => ({
    p_deal_ref: ref,
    p_target_stage: "probe-stage",
    p_expected_revision: ZERO_REVISION,
  }),
  set_opportunity_next_action: (ref) => ({
    p_deal_ref: ref,
    p_next_action_at: null,
    p_expected_revision: ZERO_REVISION,
  }),
  convert_opportunity: (ref) => ({
    p_deal_ref: ref,
    p_target_stage: "probe-stage",
    p_expected_revision: ZERO_REVISION,
  }),
  lose_opportunity: (ref) => ({
    p_deal_ref: ref,
    p_loss_reason: "probe-reason",
    p_expected_revision: ZERO_REVISION,
  }),
});

/** The arguments of each act, for the probe's catalogue matrix. */
export const COMMERCIAL_ACT_ARGUMENTS = Object.freeze(
  Object.fromEntries(
    Object.entries(CALLS).map(([act, call]) => [act, call(1)]),
  ),
);

/**
 * Nobody but the member reaches a commercial act; the browser supplies no
 * tenant, actor, salesperson or operation; an id past the browser's number
 * range and a missing one are the same OS404, byte for byte; a malformed
 * revision is OS400. The member's tenant owns the local CRM here, so the
 * refusals below come from the act, not from the CRM gate.
 */
export async function commercialActsRefuse(t, rpc) {
  const refused = {
    "non-member": t.nonMember,
    "revoked member": t.revoked,
    "member of an ineligible tenant": t.otherTenant,
    "new user with a former member's email": t.formerEmail,
  };
  const asMember = (act, body) => rpc(act, body, t.member.credential);
  for (const [act, call] of Object.entries(CALLS)) {
    for (const [who, caller] of Object.entries(refused)) {
      expectAnswer(
        await rpc(act, call(1), caller.credential),
        400,
        refusalBody("OS403", act, "no access"),
        `${who}: ${act}`,
      );
    }
    for (const extra of [
      { p_tenant_id: t.tenantA },
      { p_actor: `principal:${t.principalId}` },
      { p_sales_id: 1 },
      { p_operation: "update" },
    ]) {
      expectAnswer(
        await asMember(act, { ...call(1), ...extra }),
        404,
        "PGRST202",
        `member: ${act} with ${Object.keys(extra)[0]}`,
      );
    }
    const unseen = await asMember(act, call(9007199254740991 + 1));
    const missing = await asMember(act, call(9007199254740990));
    expectAnswer(
      missing,
      400,
      refusalBody("OS404", act, "not found"),
      `member: ${act} on a missing deal`,
    );
    check(
      unseen.status === missing.status && unseen.text === missing.text,
      `member: ${act} on a deal id no browser was shown is distinguishable from a missing one`,
    );
    expectAnswer(
      await asMember(act, { ...call(1), p_expected_revision: "stale" }),
      400,
      refusalBody("OS400", act, "bad request"),
      `member: ${act} with a malformed revision`,
    );
  }
}
