// Functions on the Company OS operator surface (companyOsApi.mjs runs these
// sections, in its order): the pinned OD-8a ownership transfers and every
// other OWNER TO, ALTER and DROP of an exposed function or a gate, and CREATE
// FUNCTION, which holds each exposed function to exactly one call to its own
// gate. Each section returns true (it owns the statement), false (the
// existing rules) or null (not its statement: the next section).

import { readParens, splitAtDepth } from "./parse.mjs";
import { stripSqlComments } from "./sqlStatements.mjs";
import { unwrapDollar } from "./doBlocks.mjs";
import {
  mentionsSurface,
  namesGate,
  normalizeRoutineRef,
} from "./companyOsNames.mjs";

/** The parameter names of a CREATE FUNCTION argument list, in order. */
function parameterNames(inner) {
  return splitAtDepth(inner, ",").map((raw) => {
    const tokens = raw
      .replace(/^(in|out|inout|variadic)\s+/, "")
      .split(/\s+/)
      .filter(Boolean);
    return tokens.length > 1 && /^p_[a-z0-9_]+$/.test(tokens[0])
      ? tokens[0]
      : null;
  });
}

/** Ownership: only the exact pinned transfers of this file. */
export function ownershipSection(surfaceStatement) {
  const { m, cfg, file, allowlisted, fail } = surfaceStatement;
  if (!(/\bowner\s+to\b/.test(m) && /^alter\b/.test(m))) return null;
  const routine =
    /^alter\s+(function|routine|procedure)\s+(.+?)\s+owner\s+to\s+([a-z0-9_$]+);?$/.exec(
      m,
    );
  if (!routine) {
    if (mentionsSurface(m, cfg)) {
      fail(
        "owner-to",
        `an ownership change naming ${cfg.role}, ${cfg.schema} or a dynamic name`,
      );
      return true;
    }
    return false; // another object kind's owner: the existing rules
  }
  const ref = normalizeRoutineRef(routine[2]);
  const to = routine[3];
  const pinned =
    routine[1] === "function" &&
    to === cfg.role &&
    allowlisted &&
    ref !== null &&
    (cfg.transfers[file] ?? []).includes(ref);
  if (!pinned) {
    fail(
      "owner-to",
      `ALTER ${routine[1].toUpperCase()} … OWNER TO ${to}: an ownership transfer outside the exact pinned OD-8a transfers of this file`,
    );
    return true;
  }
  recordTransfer(surfaceStatement, ref);
  return true;
}

/**
 * A pinned transfer: inside both windows, once, of a function this file
 * created and whose ACL it already set.
 */
function recordTransfer({ state, line, fail }, ref) {
  if (
    state.membershipGrantLine === null ||
    state.membershipRevokeLine !== null
  ) {
    fail(
      "transfer-outside-membership",
      `${ref} transferred outside the membership window`,
    );
  }
  if (state.createGrantLine === null || state.createRevokeLine !== null) {
    fail(
      "transfer-outside-create",
      `${ref} transferred outside the CREATE window`,
    );
  }
  if (!state.created.has(ref)) {
    fail(
      "transfer-not-created-here",
      `${ref} was not created by this migration`,
    );
  }
  if (!state.aclRevoked.has(ref) || !state.aclGranted.has(ref)) {
    fail(
      "transfer-before-acl",
      `${ref} is transferred before its ACL is set (revoke from PUBLIC and the application roles, then grant EXECUTE to authenticated)`,
    );
  }
  if (state.transferred.has(ref)) {
    fail("transfer-twice", `${ref} transferred twice`);
  }
  state.transferred.set(ref, line);
  state.lastTransferLine = line;
}

/** ALTER FUNCTION / ROUTINE / PROCEDURE on the surface. */
export function alterRoutineSection({ m, cfg, fail }) {
  if (!/^alter\s+(function|routine|procedure)\b/.test(m)) return null;
  if (
    mentionsSurface(m, cfg) ||
    namesGate(m) ||
    /\bset\s+schema\s+company_os_api\b/.test(m)
  ) {
    fail(
      "alter-routine",
      "ALTER FUNCTION on the operator surface (a gate or an exposed function): no SECURITY INVOKER flip, SET, RESET, SET SCHEMA or RENAME",
    );
    return true;
  }
  return false;
}

/** CREATE PROCEDURE or ROUTINE, CREATE FUNCTION, and DROP of a routine. */
export function functionSection(surfaceStatement) {
  const { m, cfg, fail } = surfaceStatement;
  if (
    /^create\s+(or\s+replace\s+)?(procedure|routine)\b/.test(m) &&
    mentionsSurface(m, cfg)
  ) {
    fail("create-procedure", `${cfg.schema} holds functions only`);
    return true;
  }
  if (/^create\s+(or\s+replace\s+)?function\b/.test(m)) {
    return handleCreateFunction(surfaceStatement);
  }
  if (/^drop\s+(function|routine|procedure)\b/.test(m)) {
    if (mentionsSurface(m, cfg) || namesGate(m)) {
      fail(
        "drop-routine",
        "DROP of an exposed function or a gate: the schema owner can drop a function it no longer owns and recreate it as its own, so only a reviewed forward migration with its own allowlist entry may change the catalogue",
      );
      return true;
    }
    return false;
  }
  return null;
}

/** CREATE [OR REPLACE] FUNCTION: the exposed functions and the gates. */
function handleCreateFunction(surfaceStatement) {
  const { m, cfg, state, statement, fail } = surfaceStatement;
  const head =
    /^create\s+(or\s+replace\s+)?function\s+([a-z0-9_$]+\.[a-z0-9_$]+)\s*\(/.exec(
      m,
    );
  if (!head) {
    if (mentionsSurface(m, cfg)) {
      fail(
        "create-function-unreadable",
        "a CREATE FUNCTION on the surface that does not parse",
      );
      return true;
    }
    return false;
  }
  const name = head[2];
  const exposed = name.startsWith(`${cfg.schema}.`);
  const gate = name.startsWith("ops.gate_");
  const setClauses = [
    ...m.matchAll(/\bset\s+([a-z_][a-z0-9_.]*)\s*(=|\bto\b)\s*([^ ]+)/g),
  ];
  if (
    setClauses.some(
      (c) =>
        c[1] === "search_path" && new RegExp(`\\b${cfg.schema}\\b`).test(c[3]),
    )
  ) {
    fail(
      "function-search-path",
      `a function whose search_path names ${cfg.schema}`,
    );
    return true;
  }
  if (!exposed && !gate) return false;

  const group = readParens(m, m.indexOf("(", head.index + head[0].length - 1));
  const ref = group ? normalizeRoutineRef(`${name}(${group.inner})`) : null;
  const created = { orReplace: head[1], name, ref, exposed, gate, group };
  if (refuseCreateFunction(surfaceStatement, created)) return true;
  checkFunctionDefinition(surfaceStatement, created, setClauses);
  state.created.set(ref, statement.line);
  return true;
}

/**
 * The refusals that end the statement: outside the allowlist, an unreadable
 * argument list, an uncatalogued function, or a replace.
 */
function refuseCreateFunction(
  { ctx, cfg, state, allowlisted, fail },
  { orReplace, name, ref, exposed },
) {
  if (!allowlisted) {
    fail(
      "create-function",
      `CREATE${orReplace ? " OR REPLACE" : ""} FUNCTION ${name} outside the exact OD-8a allowlist: the catalogue grows only through a reviewed forward migration and guard update`,
    );
    return true;
  }
  if (ref === null) {
    fail(
      "create-function-unreadable",
      `${name}: the argument list does not parse`,
    );
    return true;
  }
  if (exposed ? !cfg.catalogue.includes(ref) : !cfg.gates.includes(ref)) {
    fail(
      "uncatalogued",
      `${ref} is not in the pinned ${exposed ? "catalogue" : "gate list"}`,
    );
    return true;
  }
  if (
    orReplace ||
    state.created.has(ref) ||
    ctx.context.isOperatorOwned?.(ref)
  ) {
    fail(
      "replace-function",
      `${ref} is replaced or created twice: an allowlisted migration creates each surface function once and replaces none the role already owns`,
    );
    return true;
  }
  return false;
}

/** A catalogued function's definition: DEFINER, its SET clauses, its body. */
function checkFunctionDefinition(surfaceStatement, created, setClauses) {
  const { m, fail } = surfaceStatement;
  const { ref, exposed, gate, group } = created;
  if (!/\bsecurity\s+definer\b/.test(m)) {
    fail("function-not-definer", `${ref} must be SECURITY DEFINER`);
  }
  const sets = setClauses.map((c) => `${c[1]}=${c[3]}`);
  const wantSets = exposed ? ["search_path=''"] : null;
  if (exposed && JSON.stringify(sets) !== JSON.stringify(wantSets)) {
    fail(
      "function-config",
      `${ref} must carry exactly set search_path = '' and no other SET, got [${sets.join(", ")}]`,
    );
  }
  if (gate && !sets.includes("search_path=''")) {
    fail("function-config", `${ref} must set search_path = ''`);
  }
  const body = readFunctionBody(surfaceStatement, group);
  if (/\bexecute\b|\bformat\s*\(/.test(body.replace(/'[^']*'/g, "''"))) {
    fail("dynamic-sql-in-body", `${ref}: no dynamic SQL in a graph body`);
  }
  if (exposed) checkExposedBody(surfaceStatement, created, body);
}

/** The function's dollar-quoted body, comments stripped ("" when none). */
function readFunctionBody({ m, statement }, group) {
  const bodyIndex = /\$body(\d+)\$/.exec(m.slice(group.end));
  return bodyIndex
    ? stripSqlComments(
        unwrapDollar(statement.bodies[Number(bodyIndex[1])] ?? ""),
        statement.file,
      )
    : "";
}

/** An exposed function's body is exactly one call to its own gate. */
function checkExposedBody({ cfg, fail }, { name, ref, group }, body) {
  const params = parameterNames(group.inner);
  const gateName = `ops.gate_${name.slice(cfg.schema.length + 1)}`;
  const want = `select ${gateName}(${params.join(",")})`;
  const got = body
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "")
    .replace(/\s*,\s*/g, ",")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
  if (params.includes(null) || got !== want) {
    fail(
      "function-body",
      `${ref}: the body must be exactly "${want}", got "${got.slice(0, 120)}"`,
    );
  }
}
