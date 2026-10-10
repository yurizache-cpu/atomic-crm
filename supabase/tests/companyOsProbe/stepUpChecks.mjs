// The provider's own record of a recent second factor, measured on the local
// GoTrue (ADR 0026 §E, SI-87; slice 5 design §0.1, §8.4, review SEC-1), for
// supabase/tests/companyOsApiExposure.mjs.
//
// The browser inbox's reply needs the caller's session to have verified its
// authenticator-app factor within the hour, read from auth.mfa_amr_claims,
// with the session's factor one the user had before the session began
// (ops.operator_second_factor_recent). What only the provider can show is
// whether it keeps that record the way the rule reads it, so this measures,
// over real requests:
//
//   1. a TOTP factor enrolled and verified on a fresh session makes that
//      session aal2, names the factor as the session's, and records a `totp`
//      claim; the rule still refuses it, because the factor is newer than the
//      session;
//   2. the same factor verified on a NEW session (aal1 to aal2) records the
//      claim there, and the rule accepts it;
//   3. verified AGAIN 1.5 s later on that same aal2 session, the provider
//      moves the claim's updated_at, keeps aal2 and keeps the session id: a
//      member re-verifies inline, without signing in again (the rule still
//      accepts);
//   4. a SECOND factor enrolled and verified on that aal2 session (what a
//      stolen session could do) becomes the session's factor and moves the
//      claim too, and the rule then refuses: a factor enrolled during the
//      session never counts.
//
// The rule is evaluated as the database owner inside a transaction that is
// always rolled back, with the seed-only exemption row removed there and the
// session's own claims set, exactly as a gate would read them. TOTP codes are
// RFC 6238 (HMAC-SHA1, 30 s, 6 digits), computed with node:crypto. The user is
// a per-run probe user, so the probe's cleanup deletes it, and its factors and
// sessions go with it. Nothing here prints a secret, a code or a token.

import { createHmac } from "node:crypto";
import { UUID, authOf, check, psql, request } from "./common.mjs";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
/** How long the probe waits before verifying again on the same session. */
const REVERIFY_AFTER_MS = 1_500;

/** RFC 4648 base32, as the provider issues a TOTP secret. */
function base32Decode(secret) {
  const clean = secret.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error("the TOTP secret is not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 6238: the six-digit code of `secret` for the 30-second step at `atMs`. */
export function totpCode(secret, atMs = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / STEP_SECONDS)));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}

/** The claims of an access token (its payload, unverified: the probe minted it). */
function claimsOf(token) {
  const [, payload] = String(token).split(".");
  return JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"));
}

/**
 * The session as the database holds it: its assurance level, its factor and
 * its `totp` claim's updated_at in microseconds since the epoch ("none" when
 * absent), read as the owner.
 */
function sessionRecord(userId, sessionId) {
  const [line] = psql(
    `select s.aal::text || '|' || coalesce(s.factor_id::text, 'none') || '|'
            || coalesce((select (extract(epoch from a.updated_at) * 1000000)::bigint::text
                           from auth.mfa_amr_claims a
                          where a.session_id = s.id and a.authentication_method = 'totp'), 'none')
       from auth.sessions s
      where s.id = :'session' and s.user_id = :'user';`,
    { session: sessionId, user: userId },
  );
  const [aal, factorId, claimAt] = (line ?? "").split("|");
  return { aal, factorId, claimAt };
}

/**
 * ops.operator_second_factor_recent() for this session, with the seed-only
 * exemption removed, in a transaction that is always rolled back.
 */
function ruleAccepts(userId, sessionId) {
  const lines = psql(
    `begin;
     delete from ops.operator_assurance_exemption;
     select set_config('request.jwt.claims',
                       json_build_object('sub', :'user', 'session_id', :'session',
                                         'role', 'authenticated', 'aal', 'aal2')::text, true);
     select 'recent=' || ops.operator_second_factor_recent()::text;
     rollback;`,
    { session: sessionId, user: userId },
  );
  const answer = lines.find((l) => l.startsWith("recent="));
  if (answer === undefined) throw new Error("the rule gave no answer");
  return answer === "recent=true";
}

/**
 * One factor call on the auth API, with the session's current access token.
 * Throws with the status and the provider's code only, never a body.
 */
async function factorCall(api, credential, path, body) {
  const answer = await request(`${api}/factors${path}`, {
    method: "POST",
    headers: { ...authOf(credential), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (answer.status !== 200) {
    const code = answer.json?.error_code ?? answer.json?.code ?? "";
    throw new Error(
      `POST /auth/v1/factors${path.replace(/[0-9a-f-]{36}/g, "<id>")} returned ${answer.status} ${code}`,
    );
  }
  return answer.json;
}

/** Enrols a TOTP factor on the session; resolves to its id and secret. */
async function enrol(api, credential, name) {
  const factor = await factorCall(api, credential, "", {
    factor_type: "totp",
    friendly_name: name,
  });
  if (
    !UUID.test(factor?.id ?? "") ||
    typeof factor?.totp?.secret !== "string"
  ) {
    throw new Error("the provider enrolled no TOTP factor");
  }
  return { id: factor.id, secret: factor.totp.secret };
}

/**
 * Challenges and verifies `factor` on the session the credential holds;
 * resolves to the credential of the session's new (aal2) access token.
 */
async function verify(api, credential, factor) {
  const challenge = await factorCall(
    api,
    credential,
    `/${factor.id}/challenge`,
    {},
  );
  const session = await factorCall(api, credential, `/${factor.id}/verify`, {
    challenge_id: challenge.id,
    code: totpCode(factor.secret),
  });
  if (typeof session?.access_token !== "string") {
    throw new Error("the provider's verification returned no session");
  }
  return { ...credential, bearer: session.access_token };
}

const later = (a, b) => a !== "none" && b !== "none" && BigInt(b) > BigInt(a);

/** The four measurements above, on one per-run probe user. */
export async function secondFactorStepUp(t, origin, signIn, emailOf) {
  const api = `${origin}/auth/v1`;
  const what = "second-factor step-up";

  // 1. Enrolled and verified on a fresh session: aal2, its factor, a claim,
  //    and the rule refuses (the factor is newer than the session).
  const first = await signIn(emailOf("step-up"));
  const s1 = claimsOf(first.credential.bearer).session_id;
  const factor = await enrol(api, first.credential, "cos probe step-up 1");
  const s1Verified = await verify(api, first.credential, factor);
  const s1Claims = claimsOf(s1Verified.bearer);
  const s1Record = sessionRecord(first.userId, s1);
  check(
    UUID.test(s1 ?? "") &&
      s1Claims.session_id === s1 &&
      s1Claims.aal === "aal2",
    `${what}: verifying a factor did not raise the same session to aal2`,
  );
  check(
    s1Record.aal === "aal2" &&
      s1Record.factorId === factor.id &&
      s1Record.claimAt !== "none",
    `${what}: the provider did not record aal2, the verified factor and a totp claim on the session (${s1Record.aal}, factor ${s1Record.factorId === factor.id ? "the verified one" : s1Record.factorId}, claim ${s1Record.claimAt === "none" ? "absent" : "present"})`,
  );
  check(
    !ruleAccepts(first.userId, s1),
    `${what}: a factor enrolled during the session counted as a recent second factor`,
  );

  // 2. A new session verifies the factor it had before it began: accepted.
  const second = await signIn(first.email, { create: false });
  const s2 = claimsOf(second.credential.bearer).session_id;
  check(
    UUID.test(s2 ?? "") &&
      s2 !== s1 &&
      claimsOf(second.credential.bearer).aal === "aal1",
    `${what}: a new sign-in did not open a new aal1 session`,
  );
  const s2Verified = await verify(api, second.credential, factor);
  const before = sessionRecord(first.userId, s2);
  check(
    before.aal === "aal2" &&
      before.factorId === factor.id &&
      before.claimAt !== "none",
    `${what}: the new session's verification was not recorded (${before.aal}, claim ${before.claimAt === "none" ? "absent" : "present"})`,
  );
  check(
    ruleAccepts(first.userId, s2),
    `${what}: a factor older than the session, verified on it, was not a recent second factor`,
  );

  // 3. Verified again on the same aal2 session: the claim moves, aal2 and the
  //    session stay.
  await new Promise((resolve) => setTimeout(resolve, REVERIFY_AFTER_MS));
  const reverified = await verify(api, s2Verified, factor);
  const again = sessionRecord(first.userId, s2);
  check(
    claimsOf(reverified.bearer).session_id === s2 &&
      claimsOf(reverified.bearer).aal === "aal2",
    `${what}: re-verifying on an aal2 session changed the session or its level`,
  );
  check(
    again.aal === "aal2" &&
      again.factorId === factor.id &&
      later(before.claimAt, again.claimAt),
    `${what}: re-verifying on an aal2 session did not move the totp claim's updated_at (or changed the session's level or factor)`,
  );
  check(
    ruleAccepts(first.userId, s2),
    `${what}: the re-verified session was not a recent second factor`,
  );

  // 4. A second factor enrolled and verified on that session becomes its
  //    factor and moves the claim; the rule then refuses the session.
  const intruder = await enrol(api, reverified, "cos probe step-up 2");
  await verify(api, reverified, intruder);
  const after = sessionRecord(first.userId, s2);
  check(
    after.aal === "aal2" &&
      after.factorId === intruder.id &&
      later(again.claimAt, after.claimAt),
    `${what}: verifying a second factor did not make it the session's factor and move the claim`,
  );
  check(
    !ruleAccepts(first.userId, s2),
    `${what}: a factor enrolled during the session, once verified, counted as a recent second factor`,
  );
}
