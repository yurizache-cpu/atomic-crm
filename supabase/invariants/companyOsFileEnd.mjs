// The Company OS checks replay.mjs runs around the per-statement handler
// (companyOsApi.mjs): the identity-assertion reader and the set_config
// role-switch detector it applies to a statement before the handler sees it,
// and the lifecycle checks that run once an allowlisted file ends. Each
// lifecycle check reports through the `fail(tag, line, message)` that
// companyOsApi.mjs's checkCompanyOsFileEnd builds.

import { maskStatement, stripSqlComments } from "./sqlStatements.mjs";
import { unwrapDollar } from "./doBlocks.mjs";

/** The file asserts its identity before the membership grant. */
export function checkIdentityOrder({ cfg, state, file, fail }) {
  const opened =
    state.membershipGrantLine !== null ||
    state.createGrantLine !== null ||
    state.transferred.size > 0;
  const pinned = cfg.transfers[file] ?? [];
  if (opened || state.created.size || pinned.length) {
    if (state.identityLine === null) {
      fail(
        "identity-assertion-missing",
        0,
        `${file} never asserts that it runs as ${cfg.migrationIdentity}`,
      );
    } else if (
      state.membershipGrantLine !== null &&
      state.identityLine > state.membershipGrantLine
    ) {
      fail(
        "identity-assertion-late",
        state.identityLine,
        "the identity assertion comes after the membership grant",
      );
    }
  }
}

/** Both temporary pairs are revoked in the same migration that opens them. */
export function checkPairsClosed({ cfg, state, fail }) {
  if (
    state.membershipGrantLine !== null &&
    state.membershipRevokeLine === null
  ) {
    fail(
      "membership-unrevoked",
      state.membershipGrantLine,
      `the membership of ${cfg.migrationIdentity} in ${cfg.role} is never revoked in the same migration`,
    );
  }
  if (state.createGrantLine !== null && state.createRevokeLine === null) {
    fail(
      "create-unrevoked",
      state.createGrantLine,
      `CREATE on ${cfg.schema} is never revoked in the same migration`,
    );
  }
}

/** CREATE nests inside membership; both close after the last transfer. */
export function checkPairOrder({ state, fail }) {
  if (
    state.createGrantLine !== null &&
    state.membershipGrantLine !== null &&
    (state.createGrantLine < state.membershipGrantLine ||
      (state.createRevokeLine ?? Infinity) >
        (state.membershipRevokeLine ?? Infinity))
  ) {
    fail(
      "create-not-nested",
      state.createGrantLine,
      "the CREATE pair is not nested inside the membership pair",
    );
  }
  if (
    state.lastTransferLine !== null &&
    ((state.createRevokeLine ?? Infinity) < state.lastTransferLine ||
      (state.membershipRevokeLine ?? Infinity) < state.lastTransferLine)
  ) {
    fail(
      "revoke-before-transfer",
      state.lastTransferLine,
      "a revoke comes before the last ownership transfer",
    );
  }
  if (
    (state.membershipGrantLine !== null || state.createGrantLine !== null) &&
    state.transferred.size === 0
  ) {
    fail(
      "pair-without-transfer",
      state.membershipGrantLine ?? state.createGrantLine,
      "the OD-8a pair opens with no ownership transfer",
    );
  }
}

/** The pinned transfers happen, and every exposed function is transferred. */
export function checkTransfers({ cfg, state, file, fail }) {
  for (const ref of cfg.transfers[file] ?? []) {
    if (!state.transferred.has(ref)) {
      fail(
        `transfer-missing:${ref}`,
        0,
        `the pinned transfer of ${ref} never happens in ${file}`,
      );
    }
  }
  for (const [ref, line] of state.created) {
    if (ref.startsWith(`${cfg.schema}.`) && !state.transferred.has(ref)) {
      fail(
        `created-not-transferred:${ref}`,
        line,
        `${ref} is created but never transferred to ${cfg.role}`,
      );
    }
  }
}

/**
 * Recognise the one identity-assertion shape at the head of a DO body:
 * `begin if current_user <> '<id>' or session_user <> '<id>' then raise
 * exception …`. Returns the literal identity, or null.
 */
export function readIdentityAssertion(doStatement) {
  const body = doStatement.bodies?.length
    ? unwrapDollar(doStatement.bodies[0])
    : "";
  const text = stripSqlComments(body, doStatement.file)
    .replace(/\s+/g, " ")
    .trim();
  const hit =
    /^begin if current_user <> '([a-z_][a-z0-9_]*)' or session_user <> '([a-z_][a-z0-9_]*)' then raise exception /.exec(
      text,
    );
  if (!hit || hit[1] !== hit[2]) return null;
  return hit[1];
}

const ROLE_SWITCH_CALL =
  /\bset_config\s*\(\s*'\s*(role|session_authorization)\s*'/i;

/**
 * `set_config('role', …)` is SET ROLE by another name, and it hides in a
 * SELECT or PERFORM the head grammar otherwise leaves inert. Read with string
 * contents preserved, over the statement and every dollar-quoted body in it
 * (replay.mjs calls this before the inert-statement filter).
 */
export function callsRoleSwitch(statement) {
  const { masked, bodies } = maskStatement(
    statement.raw ?? "",
    statement.file,
    {
      preserveStrings: true,
    },
  );
  return [masked, ...bodies].some((text) => ROLE_SWITCH_CALL.test(text));
}
