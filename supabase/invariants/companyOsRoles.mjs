// Roles on the Company OS operator surface (companyOsApi.mjs runs these
// sections, in its order): the migration identity's assertion, role switching
// and bulk ownership, CREATE, ALTER and DROP of a role, and the one pinned
// OD-8a membership pair. Each section returns true (it owns the statement),
// false (the existing rules) or null (not its statement: the next section).

import { indexAtDepth } from "./parse.mjs";
import { DYNAMIC } from "./companyOsNames.mjs";

/** The identity assertion, derived from its DO block (replay.mjs). */
export function identitySection({ statement, cfg, state, line, fail }) {
  if (!statement.identityAssertion) return null;
  if (statement.identity !== cfg.migrationIdentity) {
    fail(
      "identity-literal",
      `the migration asserts identity "${statement.identity}", not the measured literal "${cfg.migrationIdentity}"`,
    );
  } else if (state.identityLine === null) {
    state.identityLine = line;
  }
  return true;
}

/** Role switching and bulk ownership: never. */
export function roleSwitchSection({ m, fail }) {
  if (
    /^(set|reset)\s+((session|local)\s+)?(role|session\s+authorization)\b/.test(
      m,
    )
  ) {
    fail(
      "role-switch",
      "SET ROLE / RESET ROLE / SET SESSION AUTHORIZATION changes whose privileges every later statement runs with",
    );
    return true;
  }
  if (/^reassign\s+owned\b/.test(m)) {
    fail(
      "reassign-owned",
      "REASSIGN OWNED moves ownership with no statement naming the objects",
    );
    return true;
  }
  return null;
}

/** CREATE, ALTER or DROP of a role, or of its USER and GROUP aliases. */
export function roleSection(surfaceStatement) {
  const { m, cfg, fail } = surfaceStatement;
  // CREATE USER and CREATE GROUP are CREATE ROLE with other defaults (USER
  // logs in); they are never needed, so only their DO-body form reaches here
  // (a top-level one is an unclassified head) and it is refused.
  if (/^(create|alter|drop)\s+(user|group)\b/.test(m)) {
    fail(
      "role-alias",
      "CREATE, ALTER or DROP USER or GROUP: roles change only as CREATE ROLE, under the rules below",
    );
    return true;
  }
  if (/^(create|alter|drop)\s+role\b/.test(m)) {
    const verb = /^(create|alter|drop)/.exec(m)[1];
    const target =
      /^(?:create|alter|drop)\s+role\s+(?:if\s+exists\s+)?([a-z0-9_$]+)/.exec(
        m,
      )?.[1];
    const surface = target === cfg.role || target === DYNAMIC;
    if (verb === "alter") {
      fail(
        "alter-role",
        `ALTER ROLE ${target ?? "?"}: role attributes and memberships change only through a reviewed guard update`,
      );
      return true;
    }
    if (verb === "drop") {
      // Dropping another role removes authority and never adds any.
      if (surface) {
        fail(
          "drop-role",
          `DROP ROLE ${cfg.role}: no migration drops the capability role`,
        );
      }
      return true;
    }
    return createRole(surfaceStatement, target, surface);
  }
  return null;
}

/** CREATE ROLE: the capability role only as pinned; any other role benign. */
function createRole({ m, cfg, allowlisted, fail }, target, surface) {
  const attrs = m
    .replace(/^create\s+role\s+[a-z0-9_$]+\s*/, "")
    .replace(/^with\s+/, "")
    .split(/\s+/)
    .filter(Boolean)
    .sort();
  if (!surface) {
    // Another role (ops_worker and ops_gateway are created this way): a
    // NOLOGIN role holds nothing until a grant names it, and every grant is
    // read by the existing rules. Anything conferring a login, a blanket
    // attribute or a membership at creation (IN ROLE, ROLE, ADMIN) is not.
    const benign = attrs.every((a) =>
      /^(nologin|nosuperuser|nocreatedb|nocreaterole|nobypassrls|noreplication|noinherit|inherit)$/.test(
        a,
      ),
    );
    if (!benign) {
      fail(
        "create-role-attributes",
        `CREATE ROLE ${target ?? "?"} with "${attrs.join(" ")}": a new role carries no login, blanket attribute or membership`,
      );
    }
    return true;
  }
  if (!allowlisted) {
    fail(
      "create-role",
      `CREATE ROLE ${cfg.role} outside the exact OD-8a allowlist`,
    );
    return true;
  }
  const want =
    "nobypassrls nocreatedb nocreaterole noinherit nologin nosuperuser";
  if (attrs.join(" ") !== want) {
    fail(
      "create-role-attributes",
      `CREATE ROLE ${cfg.role} must carry exactly NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT, got "${attrs.join(" ")}"`,
    );
  }
  return true;
}

/** Role membership: a GRANT or REVOKE with no ON. */
export function membershipSection(surfaceStatement) {
  const { m } = surfaceStatement;
  const isMembership =
    /^(grant|revoke)\b/.test(m) &&
    indexAtDepth(m, " on ", /^grant/.test(m) ? 5 : 6) === -1;
  if (!isMembership) return null;
  return /^grant\b/.test(m)
    ? membershipGrant(surfaceStatement)
    : membershipRevoke(surfaceStatement);
}

/** The pinned OD-8a grant, after the identity assertion, once. */
function membershipGrant({ m, cfg, state, line, allowlisted, fail }) {
  const exact = new RegExp(
    `^grant ${cfg.role} to ${cfg.migrationIdentity};?$`,
  ).test(m);
  // Anything but the one pinned grant stays unclassifiable and
  // non-overridable exactly as today (rules.mjs, handleGrant).
  if (!exact || !allowlisted) return false;
  if (state.identityLine === null) {
    fail(
      "identity-assertion-missing",
      `the membership grant comes before (or without) the migration's assertion that it runs as ${cfg.migrationIdentity}`,
    );
  }
  if (state.membershipGrantLine !== null) {
    fail("membership-regrant", "a second membership grant in one migration");
  }
  state.membershipGrantLine = line;
  return true;
}

/** The pinned OD-8a revoke closing its own grant; any other one refused. */
function membershipRevoke({ m, cfg, state, line, allowlisted, fail }) {
  const exact = new RegExp(
    `^revoke ${cfg.role} from ${cfg.migrationIdentity};?$`,
  ).test(m);
  if (
    exact &&
    allowlisted &&
    state.membershipGrantLine !== null &&
    state.membershipRevokeLine === null
  ) {
    state.membershipRevokeLine = line;
    return true;
  }
  fail(
    "membership-revoke",
    "a role-membership REVOKE other than the pinned OD-8a revoke closing its own grant",
  );
  return true;
}
