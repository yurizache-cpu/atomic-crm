// The Company OS operator surface (Phase 2C, ADR 0019) and its pinned OD-8a
// exception (brief §7.6, §15; owner decisions S0-E, S0-F).
//
// What this module guards, all with NON-OVERRIDABLE findings:
//   - company_os_api is a function-only schema: every function in it is
//     catalogued, SECURITY DEFINER with exactly `set search_path = ''`, and its
//     body is exactly one call to its own gate. No relation, sequence, type or
//     domain; no default privilege; never on a search_path.
//   - ops_operator_api is a scrutinised capability role: USAGE on ops and
//     EXECUTE on catalogued gates only, nothing else, and it is created with
//     exactly its six attributes.
//   - The OD-8a exception is attached to EXACT migration file names, never to
//     the role or the schema: inside such a file, the literal migration
//     identity asserts itself, receives the role, grants the role CREATE on
//     company_os_api, transfers exactly the catalogued functions this file
//     created (ACL set first), then revokes CREATE and the membership. Nothing
//     is left for a later file.
//   - Outside the allowlist, every CREATE, CREATE OR REPLACE, DROP, ALTER,
//     GRANT or REVOKE on the surface, every ownership transfer anywhere, every
//     role switch, every REASSIGN OWNED and every ALTER DEFAULT PRIVILEGES that
//     can reach ops or company_os_api is a finding. The trusted migration owner
//     CAN still drop and recreate a function it no longer owns (it owns the
//     schema); this guard, the exact allowlist and the live pins are what stop
//     that, not PostgreSQL (S0-E).
//
// A name the guard can read only as a dynamic placeholder (`x_dynamic`) counts
// as naming the surface.
//
// This module is the entry point rules.mjs and replay.mjs import: the rule id,
// the replay state, the ORDER the sections run in, and the finding each rule
// reports. The rules themselves live in sibling modules, one per kind of
// statement: companyOsRoles.mjs (the identity assertion, role switching, roles
// and the membership pair), companyOsSchema.mjs (the schema itself),
// companyOsAcl.mjs (default privileges and object GRANT / REVOKE),
// companyOsFunctions.mjs (ownership, ALTER, CREATE and DROP FUNCTION) and
// companyOsFileEnd.mjs (the end-of-file lifecycle and the two readers
// replay.mjs applies before a statement reaches the handler);
// companyOsNames.mjs reads the names they share.

import { defaultPrivilegesSection, objectAclSection } from "./companyOsAcl.mjs";
import {
  checkIdentityOrder,
  checkPairOrder,
  checkPairsClosed,
  checkTransfers,
} from "./companyOsFileEnd.mjs";
import {
  alterRoutineSection,
  functionSection,
  ownershipSection,
} from "./companyOsFunctions.mjs";
import {
  identitySection,
  membershipSection,
  roleSection,
  roleSwitchSection,
} from "./companyOsRoles.mjs";
import {
  alterSchemaSection,
  nonFunctionObjectSection,
  schemaSection,
  searchPathSection,
} from "./companyOsSchema.mjs";

export { DYNAMIC, normalizeRoutineRef } from "./companyOsNames.mjs";
export { callsRoleSwitch, readIdentityAssertion } from "./companyOsFileEnd.mjs";

export const COMPANY_OS_RULE = "company-os-surface";

/** The per-file (and global) replay state of the surface. */
export function createCompanyOsState() {
  return {
    identityLine: null,
    membershipGrantLine: null,
    membershipRevokeLine: null,
    createGrantLine: null,
    createRevokeLine: null,
    /** catalogued signature -> line created in this scope */
    created: new Map(),
    /** signatures whose PUBLIC and application-role EXECUTE was revoked */
    aclRevoked: new Set(),
    /** signatures granted EXECUTE to authenticated */
    aclGranted: new Set(),
    /** signature -> line of its transfer to the capability role */
    transferred: new Map(),
    lastTransferLine: null,
  };
}

/**
 * The sections, in the order they run. Each returns true (it owns the
 * statement), false (leave it to the existing rules) or null (not its
 * statement: the next section reads it). The order is load-bearing, and it is
 * the order the checks have always run in: the identity marker first; a role
 * switch before the search_path check (both start with SET); roles before
 * membership; a membership GRANT or REVOKE (no ON) before an object one; ALTER
 * … OWNER TO before any other ALTER of a function, a schema or a relation.
 */
const SECTIONS = [
  identitySection,
  roleSwitchSection,
  searchPathSection,
  roleSection,
  membershipSection,
  defaultPrivilegesSection,
  objectAclSection,
  ownershipSection,
  alterRoutineSection,
  alterSchemaSection,
  nonFunctionObjectSection,
  schemaSection,
  functionSection,
];

/**
 * The handler. Returns true once it owns the statement; false leaves it to the
 * existing rules (which is how every non-surface statement keeps its current
 * treatment).
 */
export function handleCompanyOs(ctx) {
  const cfg = ctx.context?.companyOsApi;
  if (!cfg) return false;
  const surfaceStatement = readSurfaceStatement(ctx, cfg);
  for (const section of SECTIONS) {
    const owned = section(surfaceStatement);
    if (owned !== null) return owned;
  }
  return false;
}

/** What every section reads: the statement, the surface, its state, `fail`. */
function readSurfaceStatement(ctx, cfg) {
  const { statement } = ctx;
  const file = statement.file;
  const line = statement.line;
  const where = `${file}:${line}`;
  return {
    ctx,
    cfg,
    statement,
    m: ctx.masked,
    file,
    line,
    allowlisted: !ctx.fromDo && cfg.allowlistedMigrations.includes(file),
    state: ctx.state.companyOs,
    fail: (tag, message) =>
      ctx.at(
        `company-os:${tag}:${where}`,
        COMPANY_OS_RULE,
        `${message} (Company OS surface, brief §7.6 and §15; owner decisions S0-E and S0-F).`,
        false,
      ),
  };
}

/** End-of-file checks: the lifecycle closes inside the file that opens it. */
export function checkCompanyOsFileEnd({
  fileState,
  file,
  declaration,
  finding,
}) {
  const cfg = declaration.companyOsApi;
  const state = fileState.companyOs;
  const findings = [];
  const fail = (tag, line, message) =>
    findings.push(
      finding(
        `company-os:${tag}:${file}:${line}`,
        COMPANY_OS_RULE,
        file,
        line,
        `${message} (Company OS surface, brief §7.6 A).`,
        false,
      ),
    );
  if (!cfg.allowlistedMigrations.includes(file)) return findings;

  const lifecycle = { cfg, state, file, fail };
  checkIdentityOrder(lifecycle);
  checkPairsClosed(lifecycle);
  checkPairOrder(lifecycle);
  checkTransfers(lifecycle);
  return findings;
}
