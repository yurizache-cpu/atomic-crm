// The hazard rules, and the effect each statement has on a replay state.
//
// Every rule produces a FINDING with an exact, narrow id. That id is what an
// override marker must name verbatim, so you can silence one thing and never a
// category — and you cannot pre-emptively silence something that does not yet
// exist, because you cannot guess an id the engine has not emitted.

import {
  AUTHENTICATED_PRIVILEGES,
  BYPASS_ROLES,
  MATVIEW,
  UNKNOWN,
  indexAtDepth,
  parseAlterRelation,
  parseCreateExtension,
  parseCreateView,
  parseDropExtension,
  parseDropView,
  parseGrant,
  qualify,
  relKey,
  splitAtDepth,
} from "./parse.mjs";

/**
 * @typedef {object} Finding
 * @property {string} id  Exact id an override must name verbatim.
 * @property {string} rule
 * @property {string} file
 * @property {number} line
 * @property {string} message
 * @property {boolean} overridable
 */

export function finding(id, rule, file, line, message, overridable = true) {
  return { id, rule, file, line, message, overridable };
}

/** A replay state. Used for the whole corpus and, separately, per file. */
export function createState() {
  return {
    /** relation key -> true | false | UNKNOWN | MATVIEW */
    views: new Map(),
    /** extension name -> schema it was installed into */
    extensions: new Map(),
    /** tables created in this scope -> line, for the RLS pairing rule */
    tables: new Map(),
    rlsEnabled: new Set(),
    /** object key -> line / file of the statement that last touched it */
    lines: new Map(),
    files: new Map(),
  };
}

const UNREADABLE = (ctx, rule, what) =>
  ctx.at(
    `unclassifiable:${ctx.statement.file}:${ctx.statement.line}`,
    rule,
    `${what}: ${JSON.stringify(ctx.masked.slice(0, 120))}. The guard's inability to read this statement IS the finding — it is never assumed harmless.`,
    false,
  );

// --- handlers. Each returns true once it owns the statement. ---------------

function handleCreateTable(ctx) {
  const m = /^create\s+table\s+(if\s+not\s+exists\s+)?([a-z0-9_$.]+)/.exec(
    ctx.masked,
  );
  if (!m) return false;
  const rel = qualify(m[2]);
  if (rel) {
    ctx.state.tables.set(relKey(rel), ctx.statement.line);
    ctx.note(relKey(rel));
  }
  return true;
}

function handleCreateView(ctx) {
  const view = parseCreateView(ctx.masked);
  if (!view) return false;
  if (view.unclassifiable) {
    UNREADABLE(
      ctx,
      "unclassifiable-view",
      'a CREATE VIEW that does not match "<name> [(cols)] [with (opts)] as …"',
    );
    return true;
  }
  const key = relKey(view.rel);
  ctx.note(key);
  if (view.materialized) {
    ctx.state.views.set(key, MATVIEW);
    ctx.at(
      `materialized-view:${key}`,
      "materialized-view",
      `${key} is a materialized view. Matviews have no security_invoker concept and are materialised as their OWNER, so a matview over an RLS-protected table is the same exposure with no way to declare it safe.`,
    );
    return true;
  }
  // Inside a DO block the statement may be conditional, so a claim of `on` is
  // recorded as UNKNOWN rather than trusted.
  ctx.state.views.set(
    key,
    ctx.fromDo && view.invoker === true ? UNKNOWN : view.invoker,
  );
  return true;
}

function handleAlterRelation(ctx) {
  const alter = parseAlterRelation(ctx.masked);
  if (!alter) return false;
  if (alter.unclassifiable) {
    UNREADABLE(
      ctx,
      "unclassifiable-alter",
      "an ALTER whose target cannot be determined",
    );
    return true;
  }
  const key = relKey(alter.rel);
  if (alter.kind === "rls-weakened") {
    ctx.at(
      `rls-disable:${key}`,
      "rls-disable",
      `${key} has row level security disabled (or un-forced). Every policy on it stops applying, and the grants to authenticated then reach every row.`,
    );
    return true;
  }
  if (alter.kind === "rls-enabled") {
    ctx.state.rlsEnabled.add(key);
    return true;
  }
  if (alter.kind === "set-invoker") {
    // `alter table <view> set (security_invoker = …)` is legal: ALTER TABLE
    // accepts reloption SET/RESET on a view. Both designs reviewed for this
    // work missed that spelling, so it is handled explicitly and tested.
    if (
      ctx.state.views.has(key) ||
      !alter.isTable ||
      ctx.context.isKnownView(key)
    ) {
      ctx.note(key);
      ctx.state.views.set(
        key,
        ctx.fromDo && alter.invoker === true ? UNKNOWN : alter.invoker,
      );
    }
    return true;
  }
  if (alter.kind === "rename" && ctx.state.views.has(key)) {
    const value = ctx.state.views.get(key);
    ctx.state.views.delete(key);
    ctx.state.views.set(relKey(alter.to), value);
    ctx.note(relKey(alter.to));
  }
  return true;
}

function handleDropView(ctx) {
  const drop = parseDropView(ctx.masked);
  if (!drop) return false;
  if (drop.unclassifiable) {
    UNREADABLE(
      ctx,
      "unclassifiable-drop-view",
      "a DROP VIEW whose targets cannot be determined",
    );
    return true;
  }
  for (const rel of drop.rels) {
    const key = relKey(rel);
    const credited = ctx.creditRemoval(
      ["pg_class", "pg_views"],
      rel.name,
      `view ${key}`,
      `uncredited-drop:${key}`,
    );
    if (credited) ctx.state.views.delete(key);
  }
  return true;
}

function handleCreateExtension(ctx) {
  const ext = parseCreateExtension(ctx.masked);
  if (!ext) return false;
  if (ext.unclassifiable) {
    UNREADABLE(
      ctx,
      "unclassifiable-extension",
      "a CREATE EXTENSION whose name cannot be determined",
    );
    return true;
  }
  ctx.state.extensions.set(ext.name, ext.schema);
  ctx.note(`extension:${ext.name}`);
  return true;
}

function handleDropExtension(ctx) {
  const drop = parseDropExtension(ctx.masked);
  if (!drop) return false;
  if (drop.unclassifiable) {
    UNREADABLE(
      ctx,
      "unclassifiable-extension",
      "a DROP EXTENSION whose names cannot be determined",
    );
    return true;
  }
  for (const name of drop.names) {
    const credited = ctx.creditRemoval(
      ["pg_extension"],
      name,
      `extension ${name}`,
      `uncredited-drop:extension:${name}`,
    );
    if (credited) ctx.state.extensions.delete(name);
  }
  return true;
}

function grantFindingsForRole(ctx, grant, role) {
  if (BYPASS_ROLES.has(role)) return; // already a full bypass; stated, not hidden
  if (role === "anon" || role === "public") {
    ctx.at(
      `grant:${role}:${grant.object}`,
      "role-grant",
      `GRANT to "${role}" on ${grant.object}. ` +
        (role === "anon"
          ? "anon holds no privilege on anything (SI-11). A grant like this, on a view that had lost security_invoker, is exactly what produced an unauthenticated read of every contact record over plain HTTP."
          : "PUBLIC reaches every role, anon included."),
    );
    return;
  }
  if (role !== "authenticated") {
    ctx.at(
      `grant:${role}:${grant.object}`,
      "role-grant",
      `GRANT to undeclared role "${role}". Roles are an allow-list: add it to BYPASS_ROLES in supabase/invariants/parse.mjs with a stated reason, or narrow the grant.`,
    );
    return;
  }
  if (
    /^all\s+(tables|sequences|functions|routines|procedures)\s+in\s+schema\b/.test(
      grant.object,
    )
  ) {
    ctx.at(
      `grant:authenticated:${grant.object}`,
      "role-grant",
      `GRANT … ON ${grant.object} TO authenticated covers every current object at once, so a relation added later inherits it with no statement naming it.`,
    );
    return;
  }
  for (const privilege of grant.privileges) {
    if (AUTHENTICATED_PRIVILEGES.has(privilege)) continue;
    ctx.at(
      `grant:authenticated:${grant.object}:${privilege}`,
      "role-grant",
      privilege === "all"
        ? `GRANT ALL ON ${grant.object} TO authenticated silently includes TRUNCATE, which RLS does not gate (measured: as anon, "truncate public.lead_profiles" took it from 2 rows to 0 with every SELECT policy in force). Enumerate the verbs instead.`
        : `GRANT ${privilege.toUpperCase()} ON ${grant.object} TO authenticated. TRUNCATE is not gated by RLS, TRIGGER attaches code to a table you do not own, REFERENCES probes rows through a foreign key.`,
    );
  }
}

function handleGrant(ctx) {
  const grant = parseGrant(ctx.masked);
  if (!grant) return false;
  if (grant.unclassifiable) {
    UNREADABLE(
      ctx,
      "unclassifiable-grant",
      `a GRANT that does not decompose into privileges / object / roles (${grant.reason})`,
    );
    return true;
  }
  for (const role of grant.roles) grantFindingsForRole(ctx, grant, role);
  return true;
}

function handleDefaultPrivileges(ctx) {
  if (!/^alter\s+default\s+privileges\b/.test(ctx.masked)) return false;
  const grantAt = indexAtDepth(ctx.masked, " grant ");
  if (grantAt === -1) return true; // the REVOKE form only ever tightens
  const toAt = indexAtDepth(ctx.masked, " to ", grantAt);
  if (toAt === -1) {
    UNREADABLE(
      ctx,
      "unclassifiable-default-privileges",
      "an ALTER DEFAULT PRIVILEGES … GRANT with no readable TO clause",
    );
    return true;
  }
  const roles = splitAtDepth(ctx.masked.slice(toAt + 4).replace(/;$/, ""), ",");
  for (const role of roles) {
    if (role !== "anon" && role !== "authenticated" && role !== "public") {
      continue;
    }
    ctx.at(
      `default-privileges:${role}`,
      "default-privileges",
      `ALTER DEFAULT PRIVILEGES … GRANT … TO ${role} makes every relation a FUTURE migration creates reachable by ${role}, with no statement ever naming it. This is the root cause of hole 2 in 20260911235000, and it is not DDL that \`db diff\` can emit, so nothing else will catch it.`,
    );
  }
  return true;
}

function handleStorage(ctx) {
  if (/^update\s+storage\.buckets\b/.test(ctx.masked)) {
    const closesIt =
      /\bset\b[^;]*\bpublic\s*=\s*false\b/.test(ctx.masked) &&
      !/\btrue\b/.test(ctx.masked);
    if (!closesIt) {
      ctx.at(
        "storage-bucket-public",
        "storage-bucket",
        `an UPDATE on storage.buckets that is not provably CLOSING a bucket: ${JSON.stringify(ctx.masked.slice(0, 120))}. This repository has already shipped a public attachments bucket once — 07_storage.sql declared it private in DML that \`db diff\` cannot emit, so every migrated database had it public (SI-08).`,
      );
    }
    return true;
  }
  if (/^insert\s+into\s+storage\.buckets\b/.test(ctx.masked)) {
    if (/\btrue\b/.test(ctx.masked)) {
      ctx.at(
        "storage-bucket-public",
        "storage-bucket",
        'an INSERT into storage.buckets carrying "true": a bucket created public is world-readable over HTTP with no policy involved. Create it private and open it deliberately (SI-08).',
      );
    }
    return true;
  }
  return false;
}

const HANDLERS = [
  handleCreateTable,
  handleCreateView,
  handleAlterRelation,
  handleDropView,
  handleCreateExtension,
  handleDropExtension,
  handleGrant,
  handleDefaultPrivileges,
  handleStorage,
];

/**
 * Apply one statement to `state`, returning any hazard findings.
 *
 * @param {object} state from createState()
 * @param {{file: string, line: number, masked: string, fromDoBlock?: boolean}} statement
 * @param {{isKnownView: (key: string) => boolean, provesRemoval: (file: string, catalogues: string[], name: string) => boolean}} context
 * @returns {Finding[]}
 */
export function applyStatement(state, statement, context) {
  /** @type {Finding[]} */
  const findings = [];
  const fromDo = Boolean(statement.fromDoBlock);

  const ctx = {
    state,
    statement,
    context,
    fromDo,
    masked: statement.masked,
    at: (id, rule, message, overridable = true) =>
      findings.push(
        finding(id, rule, statement.file, statement.line, message, overridable),
      ),
    note: (key) => {
      state.lines.set(key, statement.line);
      state.files.set(key, statement.file);
    },
    /**
     * A capability-REDUCING effect claimed inside a DO block is credited only
     * when the same migration PROVES it over the catalogue and raises if it did
     * not happen.
     *
     * The mere presence of a `raise exception` somewhere in the block is not
     * enough, and that distinction is load-bearing — it is exactly the
     * fail-open all three reviews found in the design this one is built from.
     * `do $$ begin if false then raise exception 'x'; end if;
     * create extension pg_net; end $$;` satisfies "contains a raise exception"
     * and installs the extension anyway.
     */
    creditRemoval: (catalogues, name, label, id) => {
      if (!fromDo) return true; // unconditional top-level DDL
      if (context.provesRemoval(statement.file, catalogues, name)) return true;
      ctx.at(
        id,
        "uncredited-do-effect",
        `${label} is dropped inside a DO block, but ${statement.file} never asserts the removal over the catalogue — it needs a ${catalogues.join("/")} predicate naming '${name}' guarded by "raise exception", so the migration aborts if its own claim is false. Without that the claim is not credited and the end state keeps the old value.`,
      );
      return false;
    },
  };

  for (const handler of HANDLERS) {
    if (handler(ctx)) break;
  }
  return findings;
}
