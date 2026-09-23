// The Company OS event feed (company_os_api.list_events) is deny-by-default
// twice over, and both lists live in SQL in the Phase 2C read-surface
// migration (docs/PHASE_2C_BRIEF.md §9, §11):
//
//   * ops.cos_event_known: the event types whose facts may leave at all. A type
//     outside it leaves as {} with factsWithheld, so a type a migration emits
//     but the list forgets silently degrades the operator's activity view.
//   * ops.cos_event_source: the provenance labels an event's source may carry.
//     events.source is caller-supplied, so a label outside the list leaves as
//     "other"; a label nobody writes is an allowance nobody reviewed.
//
// This file keeps both lists equal to what the repository actually writes. It
// reads the migrations (every emission site: the v_type assignments of the
// emitting triggers, the type argument of every ops.record_event call, and the
// four direct inserts into ops.events, with every other write into ops.events
// and every dynamic statement that could hide one refused), expands the three
// dynamic types from the SQL that bounds them, and collects the source labels
// the migrations, the engine's production code and the local development data
// write. Static file analysis only: no database. Line endings are normalised,
// because git checks this repository out CRLF on Windows and LF on Linux.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const READ_SURFACE = "20260922120000_company_os_read_surface.sql";

const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
// ops.events.source's own format (events_source_format).
const EVENT_SOURCE = /^[a-z][a-z0-9_.:-]{0,127}$/;

// Labels in ops.cos_event_source that no scanned file writes yet, each with the
// reason it is allowed. Every entry must stay unwritten: when a writer appears,
// the label leaves this list. (A label with no writer and no reason here fails;
// "synthetic-ingress" was removed from the allowlist for that reason: only a
// unit-test default in engine/domain/leadIntake.test.ts ever carried it.)
// company-os-ui left this list in S7.1: the review decision writes it
// (ops.decide_review_as_member, supabase/migrations/20260923120000_*).
const UNWRITTEN_SOURCES: Readonly<Record<string, string>> = Object.freeze({});

const read = (path: string): string =>
  readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** Removes `--` and block comments that sit outside single-quoted strings. */
const stripComments = (sql: string): string => {
  let out = "";
  let inQuote = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inQuote) {
      out += ch;
      if (ch === "'") inQuote = false;
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      out += ch;
    } else if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      out += "\n";
    } else if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 1;
    } else {
      out += ch;
    }
  }
  return out;
};

/**
 * The top-level arguments of the call whose opening parenthesis is at
 * `open`, split on commas outside parentheses and single quotes.
 */
const callArguments = (sql: string, open: number): string[] => {
  const args: string[] = [];
  let depth = 0;
  let inQuote = false;
  let current = "";
  for (let i = open + 1; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inQuote) {
      current += ch;
      if (ch === "'") inQuote = false;
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      current += ch;
    } else if (ch === "(") {
      depth += 1;
      current += ch;
    } else if (ch === ")") {
      if (depth === 0) {
        args.push(current.trim());
        return args;
      }
      depth -= 1;
      current += ch;
    } else if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  throw new Error(`unterminated call at offset ${open}`);
};

const literal = (expression: string): string | null => {
  const match = /^'([^']*)'$/.exec(expression.trim());
  return match ? match[1] : null;
};

const literalsIn = (list: string): string[] =>
  [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]);

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

interface SqlFile {
  readonly name: string;
  readonly sql: string;
}

const migrations: readonly SqlFile[] = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((name) => ({
    name,
    sql: stripComments(read(join(MIGRATIONS_DIR, name))),
  }));

// The local development data: the SQL files at the root of supabase/.
const developmentData: readonly SqlFile[] = readdirSync(join(ROOT, "supabase"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((name) => ({
    name,
    sql: stripComments(read(join(ROOT, "supabase", name))),
  }));

const readSurface = migrations.find((m) => m.name === READ_SURFACE);

/** The body of `create function ops.<name>` in the read-surface migration. */
const readSurfaceBody = (name: string): string => {
  const sql = readSurface?.sql ?? "";
  const start = sql.search(new RegExp(`create function ops\\.${name}\\(`));
  if (start === -1)
    throw new Error(`ops.${name} is missing from ${READ_SURFACE}`);
  const end = sql.indexOf("$$;", start);
  return sql.slice(start, end);
};

const knownTypes = (): string[] => {
  const body = readSurfaceBody("cos_event_known");
  const list = /p_type in \(([^)]*)\)/.exec(body);
  if (!list)
    throw new Error("ops.cos_event_known has no `p_type in (...)` list");
  return literalsIn(list[1]);
};

const allowedSources = (): string[] => {
  const body = readSurfaceBody("cos_event_source");
  const list = /p_source in \(([^)]*)\)/.exec(body);
  if (!list)
    throw new Error("ops.cos_event_source has no `p_source in (...)` list");
  return literalsIn(list[1]);
};

/** The last definition of ops.<name>(...) across the migrations. */
const lastDefinition = (name: string): string => {
  let found = "";
  for (const { sql } of migrations) {
    const re = new RegExp(
      `create (?:or replace )?function ops\\.${name}\\(`,
      "g",
    );
    for (const match of sql.matchAll(re)) {
      const end = sql.indexOf("$function$;", match.index);
      const alt = sql.indexOf("$$;", match.index);
      const stop = [end, alt].filter((i) => i !== -1).sort((a, b) => a - b)[0];
      found = sql.slice(match.index, stop);
    }
  }
  if (!found) throw new Error(`no migration defines ops.${name}`);
  return found;
};

interface Emission {
  readonly file: string;
  readonly expression: string;
  readonly offset: number;
  readonly sql: string;
}

// Every place a migration names an event type: the emitting triggers assign
// v_type, and every other emitter calls ops.record_event with the type as its
// third argument.
const emissions = (): Emission[] => {
  const found: Emission[] = [];
  for (const { name, sql } of migrations) {
    for (const match of sql.matchAll(/\bv_type\s*:=\s*([^;]+);/g)) {
      found.push({
        file: name,
        expression: squash(match[1]),
        offset: match.index,
        sql,
      });
    }
    for (const match of sql.matchAll(/ops\.record_event\s*\(/g)) {
      const before = sql.slice(Math.max(0, match.index - 40), match.index);
      if (/(function|procedure|exists)\s+$/i.test(before)) continue;
      const args = callArguments(sql, match.index + match[0].length - 1);
      found.push({
        file: name,
        expression: squash(args[2] ?? ""),
        offset: match.index,
        sql,
      });
    }
  }
  return found;
};

// The three dynamic types, each expanded from the SQL that bounds it. A dynamic
// expression not listed here fails the suite: its values cannot be checked.
const DYNAMIC_TYPES: ReadonlyArray<{
  readonly expression: string;
  readonly expand: (emission: Emission) => string[];
}> = [
  {
    // The closing branch of ops.emit_lifecycle_event, guarded by the status list.
    expression: "'task.' || new.status",
    expand: ({ sql, offset }) => {
      const guards = [
        ...sql
          .slice(Math.max(0, offset - 400), offset)
          .matchAll(/new\.status in \(([^)]*)\)/g),
      ];
      const guard = guards.at(-1);
      if (!guard)
        throw new Error("'task.' || new.status has no status guard before it");
      return literalsIn(guard[1]).map((s) => `task.${s}`);
    },
  },
  {
    // ops.emit_agent_run_event: every status a run can move to, running as started.
    expression:
      "'agent_run.' || case new.status when 'running' then 'started' else new.status end",
    expand: () => {
      const body = lastDefinition("agent_run_status_transitions");
      const pairs = [...body.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)'\)/g)];
      if (pairs.length === 0)
        throw new Error("no run status transitions found");
      return [
        ...new Set(pairs.map((p) => (p[2] === "running" ? "started" : p[2]))),
      ].map((s) => `agent_run.${s}`);
    },
  },
  {
    // ops.settle_outbound_send: exactly the outcomes it accepts.
    expression: "'communication.outbound_' || p_outcome",
    expand: ({ sql, offset }) => {
      const start = sql.lastIndexOf(
        "function ops.settle_outbound_send(",
        offset,
      );
      const guard = /p_outcome not in \(([^)]*)\)/.exec(
        sql.slice(start, offset),
      );
      if (start === -1 || !guard)
        throw new Error("the outbound outcome list is missing");
      return literalsIn(guard[1]).map((s) => `communication.outbound_${s}`);
    },
  },
];

const emittedTypes = (): { types: Set<string>; unresolved: string[] } => {
  const types = new Set<string>();
  const unresolved: string[] = [];
  for (const emission of emissions()) {
    // The pass-through inside ops.record_event and the emitters' own variable.
    const plain = literal(emission.expression);
    if (plain !== null) {
      types.add(plain);
      continue;
    }
    const dynamic = DYNAMIC_TYPES.find(
      (d) => d.expression === emission.expression,
    );
    if (dynamic) {
      for (const type of dynamic.expand(emission)) types.add(type);
      continue;
    }
    unresolved.push(`${emission.file}: ${emission.expression}`);
  }
  return { types, unresolved };
};

/** The SQL with each single-quoted literal's content blanked, offsets kept. */
const blankLiterals = (sql: string): string => {
  const out: string[] = [];
  let inQuote = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'") inQuote = !inQuote;
    out.push(inQuote && ch !== "'" && ch !== "\n" ? " " : ch);
  }
  return out.join("");
};

/** The offset of the `;` ending the statement at `from`, outside quotes. */
const statementEnd = (sql: string, from: number): number => {
  let i = from;
  while (i < sql.length) {
    const ch = sql[i];
    const tag = ch === "$" ? /^\$[A-Za-z_]*\$/.exec(sql.slice(i)) : null;
    if (tag) {
      const close = sql.indexOf(tag[0], i + tag[0].length);
      if (close === -1) return sql.length;
      i = close + tag[0].length;
    } else if (ch === "'") {
      const close = sql.indexOf("'", i + 1);
      if (close === -1) return sql.length;
      i = close + 1;
    } else if (ch === ";") {
      return i;
    } else {
      i += 1;
    }
  }
  return sql.length;
};

const lineOf = (sql: string, offset: number): number =>
  sql.slice(0, offset).split("\n").length;

// Every way a statement can name ops.events as its target, quoted or not,
// qualified or not (no migration puts ops on a search path).
const EVENTS_WRITE =
  /\b(insert\s+into|merge\s+into|copy)\s+(?:only\s+)?(?:"?ops"?\s*\.\s*)?"?events"?(?![\w$"])/gi;

/**
 * Every write into ops.events in these files, each as `file:line: <the type
 * expression>` for an `INSERT ... (columns) VALUES (...)`, or as the reason
 * this file cannot read its type: a write inside a string literal (dynamic
 * SQL), a MERGE or COPY, an INSERT ... SELECT or any other shape, or no type.
 */
const eventWrites = (files: readonly SqlFile[]): string[] =>
  files.flatMap(({ name, sql }) => {
    const code = blankLiterals(sql);
    return [...sql.matchAll(EVENTS_WRITE)].map((m) => {
      const where = `${name}:${lineOf(sql, m.index)}`;
      if (code.slice(m.index, m.index + m[0].length) !== m[0])
        return `${where}: inside a string literal`;
      if (!/^insert/i.test(m[1])) return `${where}: ${squash(m[1])}`;
      const shape = /^\s*\(([^)]*)\)\s*values\s*\(/i.exec(
        sql.slice(m.index + m[0].length),
      );
      if (!shape) return `${where}: not the (columns) values (...) form`;
      const columns = shape[1].split(",").map((c) => c.trim().toLowerCase());
      const values = callArguments(
        sql,
        m.index + m[0].length + shape[0].length - 1,
      );
      const type = columns.indexOf("type");
      return `${where}: ${type === -1 ? "no type column" : squash(values[type] ?? "")}`;
    });
  });

// The statements a dynamic EXECUTE may run: schema and privilege changes,
// which cannot write a row. Anything else, or SQL built where this file cannot
// read it, is a possible emission path.
const DYNAMIC_KEYWORDS: ReadonlySet<string> = new Set([
  "alter",
  "comment",
  "create",
  "drop",
  "grant",
  "revoke",
]);

/** Every dynamic EXECUTE in these files whose SQL is not readable DDL or DCL. */
const unreadableDynamicSql = (
  files: readonly SqlFile[],
): { readonly executes: number; readonly findings: string[] } => {
  let executes = 0;
  const findings: string[] = [];
  for (const { name, sql } of files) {
    const code = blankLiterals(sql);
    // Not GRANT/REVOKE EXECUTE ON, nor a trigger's EXECUTE FUNCTION|PROCEDURE.
    for (const m of code.matchAll(
      /\bexecute\s+(?!(?:function|procedure|on)\b)/gi,
    )) {
      executes += 1;
      const start = m.index + m[0].length;
      const arg = sql.slice(start, statementEnd(sql, start)).trim();
      const dollar = /^(\$[A-Za-z_]*\$)(.*?)\1/s.exec(arg);
      const quoted = /^(?:format\s*\(\s*)?'((?:[^']|'')*)'/i.exec(arg);
      const text = dollar ? dollar[2] : quoted ? quoted[1] : null;
      const keyword = text === null ? null : /^\s*([a-z]+)/i.exec(text);
      const where = `${name}:${lineOf(sql, m.index)}`;
      if (!keyword)
        findings.push(
          `${where}: SQL this file cannot read (${arg.slice(0, 60)})`,
        );
      else if (!DYNAMIC_KEYWORDS.has(keyword[1].toLowerCase()))
        findings.push(`${where}: a dynamic ${keyword[1]}`);
    }
  }
  return { executes, findings };
};

/** The position of p_source in the last definition of every ops function. */
const sourcePositions = (): Map<string, number> => {
  const positions = new Map<string, number>();
  for (const { sql } of migrations) {
    for (const match of sql.matchAll(
      /create (?:or replace )?function ops\.([a-z_0-9]+)\s*\(/g,
    )) {
      const params = callArguments(sql, match.index + match[0].length - 1);
      const index = params.findIndex((p) => /^p_source\s/.test(p));
      if (index === -1) positions.delete(match[1]);
      else positions.set(match[1], index);
    }
  }
  return positions;
};

/** Literal source labels passed to a p_source parameter in these SQL files. */
const sqlSourceLabels = (files: readonly SqlFile[]): Map<string, string[]> => {
  const positions = sourcePositions();
  const labels = new Map<string, string[]>();
  const note = (label: string, where: string) =>
    labels.set(label, [...(labels.get(label) ?? []), where]);
  for (const { name, sql } of files) {
    for (const match of sql.matchAll(/ops\.([a-z_0-9]+)\s*\(/g)) {
      const position = positions.get(match[1]);
      if (position === undefined) continue;
      const before = sql.slice(Math.max(0, match.index - 40), match.index);
      if (/(function|procedure|exists)\s+$/i.test(before)) continue;
      const args = callArguments(sql, match.index + match[0].length - 1);
      const value = literal(args[position] ?? "");
      if (value !== null) note(value, `${name} (ops.${match[1]})`);
    }
  }
  return labels;
};

/** Every non-test TypeScript file under engine/. */
const engineSources = (): SqlFile[] =>
  readdirSync(join(ROOT, "engine"), { recursive: true, encoding: "utf8" })
    .filter(
      (f) =>
        f.endsWith(".ts") &&
        !/\.(test|dbtest)\.ts$/.test(f) &&
        !/(^|[\\/])testSupport[\\/]/.test(f),
    )
    .map((f) => ({
      name: `engine/${f.replace(/\\/g, "/")}`,
      sql: read(join(ROOT, "engine", f)),
    }));

/** Source labels the engine's production code passes to the database. */
const engineSourceLabels = (): Map<string, string[]> => {
  const labels = new Map<string, string[]>();
  for (const { name, sql: code } of engineSources()) {
    const found = [
      ...code.matchAll(/\b[A-Z_]*SOURCE\s*=\s*"([^"]+)"/g),
      ...code.matchAll(/\bsource:\s*"([^"]+)"/g),
    ].map((m) => m[1]);
    for (const label of found.filter((l) => EVENT_SOURCE.test(l))) {
      labels.set(label, [...(labels.get(label) ?? []), name]);
    }
  }
  return labels;
};

describe("the event type allowlist equals what the migrations emit", () => {
  it("reads both lists from the read-surface migration", () => {
    expect(
      readSurface,
      `missing: supabase/migrations/${READ_SURFACE}`,
    ).toBeDefined();
    expect(knownTypes().length).toBeGreaterThan(20);
    expect(allowedSources().length).toBeGreaterThan(3);
  });

  it("finds every emission site, and every one resolves to known types", () => {
    const { types, unresolved } = emittedTypes();
    expect(
      unresolved,
      "an event type expression this test cannot expand",
    ).toEqual([]);
    // A positive control: the scan reaches all three kinds of emitter.
    expect(types).toContain("company.created");
    expect(types).toContain("agent_run.started");
    expect(types).toContain("communication.outbound_indeterminate");
    for (const type of types) expect(type).toMatch(EVENT_TYPE);
  });

  it("every type a migration emits is in ops.cos_event_known", () => {
    const known = new Set(knownTypes());
    const missing = [...emittedTypes().types]
      .filter((t) => !known.has(t))
      .sort();
    expect(
      missing,
      "a migration emits an event type ops.cos_event_known does not list: its facts would be withheld from the operator",
    ).toEqual([]);
  });

  it("ops.cos_event_known names no type the migrations never emit", () => {
    const { types } = emittedTypes();
    const unused = knownTypes()
      .filter((t) => !types.has(t))
      .sort();
    expect(unused, "an allowlisted event type nothing emits").toEqual([]);
  });

  it("ops.cos_event_known lists each type once", () => {
    const list = knownTypes();
    expect(new Set(list).size).toBe(list.length);
  });

  it("every write into ops.events is one of the four inserts that take the type from an emitter's variable", () => {
    // The four inserts: the two emitting triggers (v_type) and the two
    // versions of ops.record_event (p_type). Any other write, in any form (an
    // INSERT ... SELECT, a MERGE, a COPY, one inside a string EXECUTE runs),
    // is an emission path whose types this file cannot check.
    const writes = eventWrites(migrations);
    expect(writes, "the writes into ops.events").toHaveLength(4);
    for (const write of writes) expect(write).toMatch(/: (v_type|p_type)$/);
  });

  it("no dynamic statement in the migrations can write an event", () => {
    // EXECUTE runs a constant or a format() template whose first word is a
    // schema or privilege change; a write, or SQL assembled where this file
    // cannot read it, fails until this file learns to check its types.
    const { executes, findings } = unreadableDynamicSql(migrations);
    expect(findings, "a dynamic statement that could emit an event").toEqual(
      [],
    );
    // A positive control: the scan reaches the migrations' dynamic revokes.
    expect(executes).toBeGreaterThan(10);
  });

  it("the write and dynamic-statement scans catch every emitter shape (red-first controls)", () => {
    const file = (sql: string): SqlFile[] => [
      { name: "probe.sql", sql: stripComments(sql) },
    ];
    // Recognised, quoted and upper-case: the type is read.
    expect(
      eventWrites(
        file(
          'INSERT INTO "ops"."events" (tenant_id, type) VALUES (t, v_type);',
        ),
      ),
    ).toEqual(["probe.sql:1: v_type"]);
    // Each emitter shape the four-insert rule would otherwise miss.
    expect(
      eventWrites(
        file(
          [
            "insert into ops.events (tenant_id, type) select t, 'x.y' from z;",
            "insert into ops.events select * from z;",
            "merge into ops.events e using z on false when not matched then insert values (z.*);",
            "execute 'insert into ops.events (type) values (v_type)';",
            "insert into ops.events (tenant_id, type) values (t, 'x.literal');",
          ].join("\n"),
        ),
      ),
    ).toEqual([
      "probe.sql:1: not the (columns) values (...) form",
      "probe.sql:2: not the (columns) values (...) form",
      "probe.sql:3: merge into",
      "probe.sql:4: inside a string literal",
      "probe.sql:5: 'x.literal'",
    ]);
    // A dollar-quoted EXECUTE is still counted as a write.
    expect(
      eventWrites(
        file("execute $q$ insert into ops.events (type) values (v_type) $q$;"),
      ),
    ).toEqual(["probe.sql:1: v_type"]);
    expect(
      unreadableDynamicSql(
        file(
          [
            "execute 'insert into ops.events (type) values (v_type)';",
            "execute format('insert into %I.%I (type) values (%L)', 'ops', 'events', 'x.y');",
            "execute v_sql;",
            "execute $q$ select ops.record_event(t, c, 'x.y', 's') $q$;",
            "execute format('revoke all on schema ops from %I', v_role);",
            "execute $q$ create or replace function public.f() returns int language sql as $f$ select 1 $f$ $q$;",
            "grant execute on function ops.f() to x;",
            "create trigger t after insert on ops.tasks for each row execute function ops.g();",
          ].join("\n"),
        ),
      ),
    ).toEqual({
      executes: 6,
      findings: [
        "probe.sql:1: a dynamic insert",
        "probe.sql:2: a dynamic insert",
        "probe.sql:3: SQL this file cannot read (v_sql)",
        "probe.sql:4: a dynamic select",
      ],
    });
  });

  it("the engine's recordEvent wrapper has no production caller", () => {
    // Were it called, the engine would become an emitter this file cannot read.
    const callers = engineSources().filter(({ name, sql: code }) =>
      name !== "engine/domain/companyOs.ts"
        ? /\brecordEvent\s*\(/.test(code)
        : (code.match(/\brecordEvent\s*\(/g) ?? []).length > 1,
    );
    expect(callers.map((c) => c.name)).toEqual([]);
  });
});

describe("the event source allowlist equals the labels the repository writes", () => {
  const written = (): Map<string, string[]> => {
    const all = new Map<string, string[]>();
    for (const labels of [
      sqlSourceLabels(migrations),
      sqlSourceLabels(developmentData),
      engineSourceLabels(),
    ]) {
      for (const [label, where] of labels)
        all.set(label, [...(all.get(label) ?? []), ...where]);
    }
    return all;
  };

  it("finds the writers (positive controls)", () => {
    const labels = written();
    // A literal in a migration, a constant in the engine, the development data.
    expect(
      labels
        .get("whatsapp-gateway")
        ?.some((w) => w.endsWith(".sql (ops.admit_inbound_core)")),
    ).toBe(true);
    expect(
      labels
        .get("agent-runtime")
        ?.some((w) => w.includes("push_event_context")),
    ).toBe(true);
    expect(labels.get("lead-triage-demo")).toContain(
      "engine/cli/leadTriageDemo.ts",
    );
    expect(labels.get("seed")?.length ?? 0).toBeGreaterThan(0);
  });

  it("every written label is in ops.cos_event_source", () => {
    const allowed = new Set(allowedSources());
    const missing = [...written().entries()]
      .filter(([label]) => !allowed.has(label))
      .map(([label, where]) => `${label} (${[...new Set(where)].join(", ")})`)
      .sort();
    expect(
      missing,
      "a label the repository writes as an event source is not allowlisted: the browser would see it as other",
    ).toEqual([]);
  });

  it("every allowlisted label is written, or is a recorded exception that is still unwritten", () => {
    const labels = written();
    const allowed = allowedSources();
    const unexplained = allowed.filter(
      (l) => !labels.has(l) && !(l in UNWRITTEN_SOURCES),
    );
    expect(unexplained, "an allowlisted source label nothing writes").toEqual(
      [],
    );
    const nowWritten = Object.keys(UNWRITTEN_SOURCES).filter((l) =>
      labels.has(l),
    );
    expect(
      nowWritten,
      "an exception now has a writer: remove it from UNWRITTEN_SOURCES",
    ).toEqual([]);
    const stale = Object.keys(UNWRITTEN_SOURCES).filter(
      (l) => !allowed.includes(l),
    );
    expect(stale, "an exception that is no longer allowlisted").toEqual([]);
  });

  it("every allowlisted label is a valid event source, listed once", () => {
    const allowed = allowedSources();
    for (const label of allowed) expect(label).toMatch(EVENT_SOURCE);
    expect(new Set(allowed).size).toBe(allowed.length);
    expect(allowed).not.toContain("other");
  });
});
