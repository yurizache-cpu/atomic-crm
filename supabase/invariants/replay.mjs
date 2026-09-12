// Ordered replay of `supabase/migrations/*.sql` to an END STATE, plus
// per-statement hazard rules on migrations that are not yet sealed.
//
// WHY THE MIGRATIONS AND NOT `supabase/schemas/`
// The declarative schema was CORRECT throughout the incident this guard exists
// to prevent: 03_views.sql declares all four views `with (security_invoker =
// on)`, 06_grants.sql revokes anon everywhere, 07_storage.sql declares the
// bucket private. A guard reading those files would have been GREEN while
// contacts_summary served every patient contact record to an unauthenticated
// HTTP caller. The gap between the declaration and the migration set IS the bug
// class, so the replay runs over what actually reaches a database.
//
// THE TWO LAYERS, AND HOW ALREADY-FIXED HISTORY IS RESOLVED
// 20260911232039_pending_delta.sql really does create two views without
// security_invoker; 20260911235000 repairs both. The SET is secure even though
// one file is not, and a naive per-file rule would red-flag committed,
// already-remediated history forever. So:
//
//   1. END-STATE REPLAY over the WHOLE ordered corpus, sealed files included.
//      That is the property that matters — "the repository cannot describe an
//      insecure end state" — and it is green today precisely BECAUSE 235000
//      repairs 232039.
//
//   2. PER-STATEMENT HAZARD RULES on UNSEALED files only, judged against that
//      FILE's own end state. History is exempted by a sha256 seal over the exact
//      audited bytes, never by a pattern whitelist the next regression could
//      also match. New SQL must be safe on its own face, because a deploy can
//      apply a flattening migration without its repair — yet the repository's
//      documented repair pattern still passes: `create or replace view …` then
//      `alter view … set (security_invoker = on)`, which changes only the
//      reloption so the query text stays byte-identical to pg_dump form and the
//      next `db diff` sees no phantom change. A guard that refused THAT would be
//      deleted the first time `db diff` re-emitted a view.

import {
  InvariantError,
  classifyHead,
  splitStatements,
  stripSqlComments,
} from "./sqlStatements.mjs";
import { loadMigrationCorpus, validateDeclaration } from "./declaration.mjs";
import { scanDoBody } from "./doBlocks.mjs";
import { MATVIEW, UNKNOWN } from "./parse.mjs";
import { applyStatement, createState, finding } from "./rules.mjs";
import { reconcileOverrides } from "./overrides.mjs";

export { InvariantError, loadMigrationCorpus, validateDeclaration };

/** Human-readable one-liner per finding. */
export function formatFinding(f) {
  return `[${f.rule}] ${f.file}${f.line ? `:${f.line}` : ""} (${f.id})\n    ${f.message}`;
}

/** History is immutable, and the seal is CLOSED. */
function checkSeal({ corpus, seal, sealedThrough }) {
  const findings = [];
  const onDisk = new Set(corpus.map((m) => m.file));

  for (const file of Object.keys(seal)) {
    const m = /^(\d{14})_[A-Za-z0-9_-]+\.sql$/.exec(file);
    if (!m) {
      findings.push(
        finding(
          "seal:malformed",
          "seal",
          "seal.json",
          0,
          `seal entry "${file}" is not a migration filename`,
          false,
        ),
      );
      continue;
    }
    if (m[1] > sealedThrough) {
      findings.push(
        finding(
          "seal:beyond-frozen-point",
          "seal",
          "seal.json",
          0,
          `${file} is sealed but is newer than sealedThrough (${sealedThrough}). The seal is CLOSED: anything newer is always classified in full, so "seal it and move on" is not a path past this guard.`,
          false,
        ),
      );
    }
    if (!onDisk.has(file)) {
      findings.push(
        finding(
          "seal:deleted",
          "seal",
          file,
          0,
          `${file} is sealed but no longer exists on disk`,
          false,
        ),
      );
    }
  }

  for (const migration of corpus) {
    if (migration.timestamp > sealedThrough) continue;
    const expected = seal[migration.file];
    if (!expected) {
      findings.push(
        finding(
          "seal:back-dated",
          "seal",
          migration.file,
          0,
          `${migration.file} predates sealedThrough (${sealedThrough}) but is not in the seal. A back-dated filename would otherwise be exempt from every hazard rule.`,
          false,
        ),
      );
      continue;
    }
    if (expected !== migration.sha256) {
      findings.push(
        finding(
          "seal:edited",
          "seal",
          migration.file,
          0,
          `${migration.file} has been edited (sha256 ${migration.sha256.slice(0, 12)}… != sealed ${expected.slice(0, 12)}…). Migrations are immutable, and the "raise exception" assertions in the hand-written security migrations live inside these bytes — the seal is what makes removing one impossible without a visible diff.`,
          false,
        ),
      );
    }
  }
  return findings;
}

/** Expand a file's statements, replacing each DO block with what it yields. */
function expandStatements(statements, file) {
  const expanded = [];
  const findings = [];
  for (const statement of statements) {
    const { head, security } = classifyHead(statement); // throws on unknown head
    if (!security) continue; // INERT for every declared domain
    if (head !== "do") {
      expanded.push(statement);
      continue;
    }
    const { derived, unresolved } = scanDoBody(statement);
    for (const message of unresolved) {
      findings.push(
        finding(
          `dynamic-sql:${file}:${statement.line}`,
          "unresolvable-dynamic-sql",
          file,
          statement.line,
          message,
          false,
        ),
      );
    }
    expanded.push(...derived);
  }
  return { expanded, findings };
}

/** Per-file end-state checks, on unsealed migrations only. */
function checkFileEndState({ fileState, file, declaration }) {
  const findings = [];
  const lineOf = (key) => fileState.lines.get(key) ?? 0;

  // A new table whose RLS is never enabled. Not a rule bolted on: the grant
  // rule allows SELECT/INSERT/UPDATE/DELETE to `authenticated` unconditionally,
  // and that is only sound because RLS gates the ROWS. `create table public.x
  // (…); grant select … to authenticated;` with no RLS reproduces §16.1 — a
  // relation an application role reads with no policy applied — while looking
  // entirely ordinary in a diff.
  for (const [key, line] of fileState.tables) {
    if (!declaration.views.enforcedSchemas.includes(key.split(".")[0]))
      continue;
    if (fileState.rlsEnabled.has(key)) continue;
    findings.push(
      finding(
        `rls-missing:${key}`,
        "rls-missing",
        file,
        line,
        `${key} is created without "alter table ${key} enable row level security" in the same migration. Every grant to authenticated relies on RLS to gate the rows; without it, the grant IS the whole authorisation.`,
      ),
    );
  }

  for (const [key, value] of fileState.views) {
    const schema = key.split(".")[0];
    if (!declaration.views.enforcedSchemas.includes(schema)) {
      if (declaration.views.ignoredSchemas.includes(schema)) continue;
      findings.push(
        finding(
          `view-foreign-schema:${key}`,
          "view-security-invoker",
          file,
          lineOf(key),
          `${key} is a view outside the enforced schemas (${declaration.views.enforcedSchemas.join(", ")}). Silently ignoring another schema would be fail-open — PostgREST exposes whatever config.toml lists, today ["public", "storage", "graphql_public"]. Add the schema to views.enforcedSchemas so its views are held to the same security_invoker rule, or list it in views.ignoredSchemas deliberately.`,
        ),
      );
      continue;
    }
    if (value === true || value === MATVIEW) continue;
    findings.push(
      finding(
        `view-security-invoker:${key}`,
        "view-security-invoker",
        file,
        lineOf(key),
        value === UNKNOWN
          ? `${key} ends this migration with a security_invoker value this guard cannot evaluate. No guessing: an unreadable value fails.`
          : `${key} ends this migration WITHOUT security_invoker, so it executes as its OWNER and RLS on its source tables does not apply to it at all. This is the exact defect that shipped (PHASE_0_5_REPORT §16.1): the base table refused, the view handed the rows over. \`supabase db diff\` never emits view reloptions — repair it in the SAME migration with \`alter view ${key} set (security_invoker = on);\`, which changes only the reloption and leaves the query text byte-identical, so the next diff sees no phantom change.`,
      ),
    );
  }

  for (const [name, schema] of fileState.extensions) {
    const line = lineOf(`extension:${name}`);
    if (declaration.extensions.forbidden.includes(name)) {
      findings.push(
        finding(
          `extension:${name}`,
          "extension-allowlist",
          file,
          line,
          name === "pg_net"
            ? `extension "pg_net" is forbidden. Schema "net" is owned by supabase_admin, only a grantor may revoke a grant, and postgres is not a member — so a REVOKE issued by a migration is accepted and SILENTLY IGNORED (measured: net.http_get still executed as authenticated afterwards). Installing it re-grants anon and authenticated permanently, and no privilege change this project can make will close it again. Its PRESENCE is the failure (SI-02, ADR 0011).`
            : `extension "${name}" is forbidden: it is an outbound-network or code-execution capability reachable from inside the database, the same hazard class as pg_net (SI-02).`,
        ),
      );
      continue;
    }
    if (!declaration.extensions.allowed.includes(name)) {
      findings.push(
        finding(
          `extension:${name}`,
          "extension-allowlist",
          file,
          line,
          `extension "${name}" is not on the allow-list. An extension is a capability decision: add it to declaration.json#extensions.allowed in the same commit, in review.`,
        ),
      );
      continue;
    }
    if (!declaration.extensions.allowedSchemas.includes(schema)) {
      findings.push(
        finding(
          `extension-schema:${name}:${schema}`,
          "extension-allowlist",
          file,
          line,
          `extension "${name}" is installed into schema "${schema}". Reachability is a property of the SCHEMA, not the name: "extensions" is owned by postgres and can be closed with REVOKE USAGE, which is exactly why \`http\` could be contained and \`pg_net\` could not.`,
        ),
      );
    }
  }

  return findings;
}

/** Whole-corpus end-state checks. */
function checkGlobalEndState({
  globalState,
  declaration,
  endViews,
  declaredViews,
}) {
  const findings = [];
  const where = (key) => globalState.files.get(key) ?? "supabase/migrations";

  for (const [key, value] of endViews) {
    if (!declaredViews.has(key)) {
      findings.push(
        finding(
          `end-state-view-undeclared:${key}`,
          "end-state",
          "declaration.json",
          0,
          `the migration set ends with an undeclared view ${key}. Every view an application role can reach is a review decision: add it to declaration.json#views.declared — which the test pins as a literal, so it is a second, loud diff.`,
          false,
        ),
      );
      continue;
    }
    if (value === true) continue;
    findings.push(
      finding(
        `end-state-view:${key}`,
        "end-state",
        // Attributed to the migration that last touched it, so an override for
        // this id has a file to live in and lands where the state was caused.
        where(key),
        0,
        `after applying every migration in order, ${key} is ${
          value === MATVIEW
            ? "a materialized view"
            : value === UNKNOWN
              ? "security_invoker=<unreadable>"
              : "NOT security_invoker"
        }. The SET as a whole describes an insecure end state.`,
      ),
    );
  }

  for (const key of declaredViews) {
    if (endViews.has(key)) continue;
    findings.push(
      finding(
        `end-state-view-missing:${key}`,
        "end-state",
        "supabase/migrations",
        0,
        `declared view ${key} does not exist after the replay. Either a migration dropped it silently or the declaration is stale; both are decisions, not accidents.`,
        false,
      ),
    );
  }

  for (const [name] of globalState.extensions) {
    const key = `extension:${name}`;
    if (declaration.extensions.forbidden.includes(name)) {
      findings.push(
        finding(
          `end-state-extension:${name}`,
          "end-state",
          where(key),
          0,
          `after applying every migration in order, extension "${name}" is installed. It is forbidden (SI-02).`,
        ),
      );
    } else if (!declaration.extensions.allowed.includes(name)) {
      findings.push(
        finding(
          `end-state-extension:${name}`,
          "end-state",
          where(key),
          0,
          `after applying every migration in order, extension "${name}" is installed and is not on the allow-list.`,
        ),
      );
    }
  }

  return findings;
}

/**
 * The whole guard.
 *
 * @param {object} input
 * @param {{file: string, sql: string, timestamp: string, sha256: string}[]} input.corpus
 *   Ordered migrations. INJECTABLE deliberately: synthetic regressions can be
 *   appended to the real corpus in tests, and the `db:diff` wrapper can classify
 *   a candidate migration before it is ever written to disk.
 * @param {object} input.declaration
 * @param {Record<string,string>} input.seal
 * @param {string} input.repoRoot
 * @returns {{findings: object[], activeOverrides: object[], endState: object, stats: object}}
 */
export function analyze({ corpus, declaration, seal, repoRoot }) {
  validateDeclaration(declaration);
  if (!corpus.length) {
    throw new InvariantError("analyze() received an empty corpus");
  }

  const sealedThrough = declaration.sealedThrough;
  const findings = checkSeal({ corpus, seal, sealedThrough });
  const globalState = createState();
  const declaredViews = new Set(
    declaration.views.declared.map((v) => `${declaration.views.schema}.${v}`),
  );

  // Comment-stripped text per file, for catalogue-predicate matching. Matching
  // against RAW text would match a predicate written inside a comment:
  // 20260911235500_drop_pg_net.sql:35 contains the words "drop extension
  // pg_net" in a `--` comment, so a raw-text marker would still match after the
  // executable statement had been deleted.
  const strippedByFile = new Map();
  const context = {
    isKnownView: (key) => declaredViews.has(key) || globalState.views.has(key),
    provesRemoval(file, catalogues, name) {
      const text = strippedByFile.get(file) ?? "";
      if (!/raise\s+exception/.test(text)) return false;
      if (!catalogues.some((c) => text.includes(c))) return false;
      return text.includes(`'${name.toLowerCase()}'`);
    },
  };

  let statementsScanned = 0;
  let sealedStatements = 0;
  let sealedFiles = 0;

  for (const migration of corpus) {
    const sealed =
      migration.timestamp <= sealedThrough && Boolean(seal[migration.file]);
    strippedByFile.set(
      migration.file,
      stripSqlComments(migration.sql, migration.file),
    );

    const statements = splitStatements(migration.sql, migration.file);
    statementsScanned += statements.length;
    if (sealed) {
      sealedStatements += statements.length;
      sealedFiles += 1;
    }

    const { expanded, findings: expansionFindings } = expandStatements(
      statements,
      migration.file,
    );
    findings.push(...expansionFindings);

    const fileState = createState();
    for (const statement of expanded) {
      const hazards = applyStatement(fileState, statement, context);
      // The same statement drives the global replay. Effects are identical;
      // findings are taken from the file-scoped pass only.
      applyStatement(globalState, statement, context);
      if (!sealed) findings.push(...hazards);
    }

    if (sealed) continue;
    findings.push(
      ...checkFileEndState({ fileState, file: migration.file, declaration }),
    );
  }

  const endViews = new Map(
    [...globalState.views].filter(
      ([key]) => key.split(".")[0] === declaration.views.schema,
    ),
  );
  findings.push(
    ...checkGlobalEndState({
      globalState,
      declaration,
      endViews,
      declaredViews,
    }),
  );

  const { active, hatchFindings } = reconcileOverrides({
    findings,
    corpus,
    declaration,
    repoRoot,
  });
  const surviving = findings.filter(
    (f) => !active.some((o) => o.invariantId === f.id),
  );
  surviving.push(...hatchFindings);

  return {
    findings: surviving,
    activeOverrides: active,
    endState: {
      views: Object.fromEntries([...endViews].sort()),
      extensions: Object.fromEntries([...globalState.extensions].sort()),
    },
    stats: {
      filesScanned: corpus.length,
      statementsScanned,
      sealedFiles,
      sealedStatements,
    },
  };
}

/**
 * The cheap cross-check on the OTHER side of the gap: every view the
 * declarative schema declares must itself carry `security_invoker = on`, so the
 * next `db diff` starts from a correct source of truth.
 *
 * Explicitly NOT the primary guard. 03_views.sql was correct throughout the
 * incident; checking it alone would have been green while contacts_summary was
 * serving every contact record to anon.
 */
export function checkDeclarativeViews(sql, declaration) {
  const findings = [];
  const state = createState();
  const context = { isKnownView: () => false, provesRemoval: () => false };
  for (const statement of splitStatements(
    sql,
    "supabase/schemas/03_views.sql",
  )) {
    applyStatement(state, statement, context);
  }
  for (const name of declaration.views.declared) {
    const key = `${declaration.views.schema}.${name}`;
    const value = state.views.get(key);
    if (value === true) continue;
    findings.push(
      finding(
        `declarative-view:${key}`,
        "declarative-schema",
        "supabase/schemas/03_views.sql",
        0,
        `${key} is declared ${
          value === undefined
            ? "nowhere"
            : `with security_invoker=${String(value)}`
        } in the declarative schema. Intent and migrations must agree, or the next generated migration starts from the wrong place.`,
        false,
      ),
    );
  }
  return findings;
}
