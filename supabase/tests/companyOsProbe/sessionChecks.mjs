// Identity over real GoTrue sessions: an email never selects a principal,
// every other signed-in caller is refused byte for byte, and a sign-out takes
// effect on the next call (supabase/tests/companyOsApiExposure.mjs).

import {
  CATALOGUE,
  authOf,
  check,
  expectAnswer,
  refusalBody,
  request,
} from "./common.mjs";

/** An admin email change keeps the principal; the former email holds nothing. */
export async function emailChangeKeepsThePrincipal(t, admin, signIn, emailOf) {
  t.movedEmail = emailOf("member-moved");
  const moved = await admin.auth.admin.updateUserById(t.member.userId, {
    email: t.movedEmail,
    email_confirm: true,
  });
  check(
    !moved.error && moved.data?.user?.id === t.member.userId,
    `admin email change failed or changed the auth user id: ${moved.error?.message ?? ""}`,
  );
  const afterChange = await t.read("operator_context", {});
  check(
    afterChange?.principal?.id === t.principalId &&
      afterChange?.tenant?.id === t.tenantA,
    "member: an admin email change moved the principal or the tenant of a live session",
  );
  const movedSession = await signIn(t.movedEmail, { create: false });
  const renewed = await t.read("operator_context", {}, movedSession.credential);
  check(
    renewed?.principal?.id === t.principalId,
    "member: a new session under the changed email resolves to another principal",
  );
  t.formerEmail = await signIn(t.member.email);
  check(
    t.formerEmail.userId !== t.member.userId,
    "the former email signed in as the member's auth user",
  );
}

/** Every other signed-in caller: the one fixed OS403, byte for byte. */
export async function othersAreRefused(t, rpc) {
  const refused = {
    "non-member": t.nonMember,
    "revoked member": t.revoked,
    "member of an ineligible tenant": t.otherTenant,
    "new user with a former member's email": t.formerEmail,
  };
  for (const fn of CATALOGUE) {
    const expected = refusalBody("OS403", fn, "no access");
    for (const [who, caller] of Object.entries(refused)) {
      const answer = await rpc(fn, t.argsFor(fn), caller.credential);
      expectAnswer(answer, 400, expected, `${who}: ${fn}`);
    }
  }
}

/** Sign-out takes effect on the next call, for that session only. */
export async function signOutTakesEffect(t, origin, keys, rpc) {
  await t.read("operator_context", {}, t.memberOther.credential);
  const logout = await request(`${origin}/auth/v1/logout?scope=local`, {
    method: "POST",
    headers: authOf({
      apikey: keys.anon,
      bearer: t.memberOther.credential.bearer,
    }),
  });
  check(
    logout.status === 204,
    `POST /auth/v1/logout returned ${logout.status}, expected 204`,
  );
  for (const fn of CATALOGUE) {
    const answer = await rpc(fn, t.argsFor(fn), t.memberOther.credential);
    const expected = refusalBody("OS401", fn, "not signed in");
    expectAnswer(answer, 400, expected, `signed-out session: ${fn}`);
  }
  const stillSignedIn = await t.read("operator_context", {});
  check(
    stillSignedIn?.principal?.id === t.principalId,
    "member: signing one session out refused the member's other session",
  );
}
