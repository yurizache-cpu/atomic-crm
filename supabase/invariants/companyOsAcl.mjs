// Privileges on the Company OS operator surface (companyOsApi.mjs runs these
// sections, in its order): ALTER DEFAULT PRIVILEGES, which may open no future
// path onto ops or company_os_api, and every object GRANT or REVOKE touching
// the surface: the schema's two privileges, the pinned temporary CREATE pair,
// and EXECUTE on an exposed function or a gate. Each section returns true (it
// owns the statement), false (the existing rules) or null (not its statement:
// the next section).

import { indexAtDepth, splitAtDepth } from "./parse.mjs";
import {
  DYNAMIC,
  mentionsSurface,
  namesGate,
  normalizeRoutineRef,
} from "./companyOsNames.mjs";

/** The application roles: EXECUTE on the surface is revoked from them. */
const APP_ROLES = new Set([
  "public",
  "anon",
  "authenticated",
  "service_role",
  "ops_worker",
  "ops_gateway",
]);

/** Default privileges: no future path onto ops or the surface. */
export function defaultPrivilegesSection({ m, cfg, fail }) {
  if (!/^alter\s+default\s+privileges\b/.test(m)) return null;
  const grantAt = indexAtDepth(m, " grant ");
  const isGrant = grantAt !== -1;
  const scope = /\bin\s+schema\s+(.+?)\s+(grant|revoke)\b/.exec(m);
  const schemas = scope ? splitAtDepth(scope[1], ",") : [];
  if (mentionsSurface(m, cfg)) {
    fail(
      "default-privileges-surface",
      `ALTER DEFAULT PRIVILEGES naming ${cfg.schema}, ${cfg.role} or a dynamic name`,
    );
  } else if (isGrant && !scope) {
    fail(
      "default-privileges-global",
      "a GRANT-form ALTER DEFAULT PRIVILEGES with no IN SCHEMA reaches every schema the grantor creates objects in, ops and company_os_api included",
    );
  } else if (isGrant && schemas.includes("ops")) {
    fail(
      "default-privileges-ops",
      "a GRANT-form ALTER DEFAULT PRIVILEGES in schema ops gives a future EXECUTE or table path with no statement naming it",
    );
  }
  return false; // the existing default-privilege rules still apply
}

/** Object GRANT / REVOKE touching the surface. */
export function objectAclSection(surfaceStatement) {
  if (!/^(grant|revoke)\b/.test(surfaceStatement.m)) return null;
  return handleObjectAcl(surfaceStatement);
}

/** GRANT or REVOKE on an object. */
function handleObjectAcl(surfaceStatement) {
  const { m, cfg, allowlisted, fail } = surfaceStatement;
  const acl = readObjectAcl(m);
  if (acl === null) return false;
  const { isGrant, objectText, roles } = acl;

  const touchesSchema = new RegExp(`\\b${cfg.schema}\\b`).test(objectText);
  const touchesGate = namesGate(objectText);
  const namesRole = roles.includes(cfg.role) || roles.includes(DYNAMIC);
  const dynamicObject = objectText.includes(DYNAMIC);
  if (!touchesSchema && !touchesGate) {
    if (!namesRole) return false;
    // A REVOKE from a dynamic role on a non-surface object only tightens (the
    // Phase 1A migrations loop such revokes over ops); the existing rules own it.
    if (!isGrant && !roles.includes(cfg.role)) return false;
  }

  if (dynamicObject || roles.includes(DYNAMIC)) {
    fail(
      "acl-dynamic",
      "a GRANT or REVOKE on the surface whose object or role is a dynamic name",
    );
    return true;
  }
  if (!allowlisted) {
    fail(
      "acl-outside-allowlist",
      `${isGrant ? "GRANT" : "REVOKE"} on the operator surface outside the exact OD-8a allowlist`,
    );
    return true;
  }
  if (
    /\ball\s+(functions|routines|procedures|tables|sequences)\s+in\s+schema\b/.test(
      objectText,
    )
  ) {
    fail(
      "acl-schema-wide",
      "a schema-wide GRANT or REVOKE on the operator surface",
    );
    return true;
  }

  if (/^schema\s+/.test(objectText)) {
    return schemaPrivilegeAcl(surfaceStatement, acl);
  }
  if (
    !/^(function|routine|procedure)\s+/.test(objectText) &&
    !/\(/.test(objectText)
  ) {
    fail(
      "acl-object",
      `${isGrant ? "GRANT" : "REVOKE"} on a non-function object naming ${cfg.role}`,
    );
    return true;
  }
  return functionAcl(surfaceStatement, acl);
}

/** The privileges, object and roles of a GRANT or REVOKE on an object. */
function readObjectAcl(m) {
  const isGrant = /^grant\b/.test(m);
  const body = isGrant
    ? m
    : m.replace(/^revoke\s+(grant\s+option\s+for\s+)?/, "revoke ");
  const onAt = indexAtDepth(body, " on ");
  const toAt = indexAtDepth(body, isGrant ? " to " : " from ", onAt + 4);
  if (onAt === -1 || toAt === -1) return null;
  const privileges = splitAtDepth(body.slice(isGrant ? 5 : 6, onAt), ",").map(
    (p) => p.replace(/\s+privileges$/, "").trim(),
  );
  const objectText = body.slice(onAt + 4, toAt).trim();
  const roles = splitAtDepth(
    body
      .slice(toAt + (isGrant ? 4 : 6))
      .replace(/;$/, "")
      .replace(/\s+(cascade|restrict)$/, ""),
    ",",
  ).map((r) => r.replace(/^group\s+/, "").trim());
  return { isGrant, privileges, objectText, roles };
}

/** The schema's two privileges, and the pinned temporary CREATE pair. */
function schemaPrivilegeAcl(
  { cfg, state, line, fail },
  { isGrant, privileges, objectText, roles },
) {
  const schemas = splitAtDepth(objectText.replace(/^schema\s+/, ""), ",");
  const key = `${isGrant ? "grant" : "revoke"} ${privileges.join(",")} ${schemas.join(",")} ${roles.join(",")}`;
  if (
    key === `grant usage ${cfg.schema} authenticated` ||
    key === `grant usage ops ${cfg.role}`
  ) {
    return true;
  }
  if (key === `grant create ${cfg.schema} ${cfg.role}`) {
    if (
      state.membershipGrantLine === null ||
      state.membershipRevokeLine !== null ||
      state.createGrantLine !== null
    ) {
      fail(
        "create-grant-window",
        `CREATE on ${cfg.schema} granted outside the membership window, or twice`,
      );
    }
    state.createGrantLine = line;
    return true;
  }
  if (key === `revoke create ${cfg.schema} ${cfg.role}`) {
    if (
      state.createGrantLine === null ||
      state.createRevokeLine !== null ||
      state.membershipRevokeLine !== null
    ) {
      fail(
        "create-revoke-window",
        `CREATE on ${cfg.schema} revoked with no open grant, twice, or after the membership revoke`,
      );
    }
    state.createRevokeLine = line;
    return true;
  }
  fail(
    "schema-privilege",
    `schema privilege "${key}": only USAGE on ${cfg.schema} to authenticated, USAGE on ops to ${cfg.role}, and the pinned temporary CREATE pair are allowed`,
  );
  return true;
}

/** EXECUTE on functions: every reference must parse, each is then checked. */
function functionAcl(surfaceStatement, acl) {
  const refs = splitAtDepth(
    acl.objectText.replace(/^(function|routine|procedure)\s+/, ""),
    ",",
  ).map((part) => ({
    part,
    ref: normalizeRoutineRef(
      part.replace(/^(function|routine|procedure)\s+/, ""),
    ),
  }));
  if (refs.some((r) => r.ref === null)) {
    surfaceStatement.fail(
      "acl-unreadable",
      `a function reference on the surface that does not parse`,
    );
    return true;
  }
  for (const { ref } of refs) functionRefAcl(surfaceStatement, acl, ref);
  return true;
}

/** One function reference: a gate, an exposed function, or neither. */
function functionRefAcl(surfaceStatement, acl, ref) {
  const { cfg, fail } = surfaceStatement;
  const exposed = ref.startsWith(`${cfg.schema}.`);
  const gate = ref.startsWith("ops.gate_");
  if (!exposed && !gate) {
    // A non-surface function in the same statement: only a revoke from the
    // application roles (the deny-by-default hygiene) is allowed here.
    if (!acl.isGrant && acl.roles.every((r) => APP_ROLES.has(r))) return;
    fail(
      `acl-non-surface:${ref}`,
      `${ref}: ${cfg.role} may execute gates only`,
    );
    return;
  }
  if (exposed && !cfg.catalogue.includes(ref)) {
    fail(
      `uncatalogued:${ref}`,
      `${ref} is not in the pinned Company OS catalogue`,
    );
    return;
  }
  if (gate && !cfg.gates.includes(ref)) {
    fail(`uncatalogued-gate:${ref}`, `${ref} is not in the pinned gate list`);
    return;
  }
  if (exposed) {
    exposedFunctionAcl(surfaceStatement, acl, ref);
  } else {
    gateAcl(surfaceStatement, acl, ref);
  }
}

/** An exposed function: EXECUTE to authenticated only, before its transfer. */
function exposedFunctionAcl(
  { state, fail },
  { isGrant, privileges, roles },
  ref,
) {
  if (!state.created.has(ref) || state.transferred.has(ref)) {
    fail(
      `acl-after-transfer:${ref}`,
      `${ref}: its ACL may change only in the file that creates it, before its transfer`,
    );
    return;
  }
  if (isGrant) {
    if (
      privileges.join(",") !== "execute" ||
      roles.join(",") !== "authenticated"
    ) {
      fail(`acl-exposed:${ref}`, `${ref}: only EXECUTE to authenticated`);
      return;
    }
    state.aclGranted.add(ref);
    return;
  }
  if (!roles.every((r) => APP_ROLES.has(r)) || !roles.includes("public")) {
    fail(
      `acl-exposed-revoke:${ref}`,
      `${ref}: the revoke must name PUBLIC and only application roles`,
    );
    return;
  }
  state.aclRevoked.add(ref);
}

/** A gate: EXECUTE to the capability role only. */
function gateAcl({ cfg, fail }, { isGrant, privileges, roles }, ref) {
  if (isGrant) {
    if (privileges.join(",") !== "execute" || roles.join(",") !== cfg.role) {
      fail(`acl-gate:${ref}`, `${ref}: only EXECUTE to ${cfg.role}`);
    }
  } else if (!roles.every((r) => APP_ROLES.has(r))) {
    fail(
      `acl-gate-revoke:${ref}`,
      `${ref}: revoke only from the application roles`,
    );
  }
}
