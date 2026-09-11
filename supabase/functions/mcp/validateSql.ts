import { parse, type Statement } from "npm:pgsql-ast-parser@^12";

const ALLOWED_READ_TYPES = new Set(["select", "with"]);
const ALLOWED_WRITE_TYPES = new Set(["insert", "update", "delete", "with"]);

// Collect every statement type reachable in a parsed AST.
//
// A `with` node has TWO sides and both can carry DML:
//   - `bind[]`  — the CTE definitions, e.g. WITH d AS (DELETE ... RETURNING *)
//   - `in`      — the statement the WITH is attached to, e.g.
//                 WITH x AS (SELECT 1) DELETE FROM contacts
// An earlier version walked only `bind`, so the second form collected
// {with, select} and passed the read-only gate while actually deleting.
// Both sides recurse, because either can nest a further WITH.
//
// Unknown node shapes contribute their own `type`, so anything this function
// does not understand lands outside the allow-list and is rejected: the
// classifier fails closed by construction.
function collectStatementTypes(stmts: Statement[]): Set<string> {
  const types = new Set<string>();
  const visit = (stmt: Statement | undefined | null, depth: number): void => {
    // Depth cap: a hand-crafted deeply nested statement must not turn
    // validation into a stack overflow (which would throw past the gate).
    if (!stmt || typeof stmt !== "object" || depth > 50) return;
    if (typeof stmt.type === "string") types.add(stmt.type);
    if (stmt.type !== "with") return;
    const node = stmt as Statement & {
      bind?: { statement?: Statement }[];
      in?: Statement;
    };
    if (Array.isArray(node.bind)) {
      for (const cte of node.bind) visit(cte?.statement, depth + 1);
    }
    visit(node.in, depth + 1);
  };
  for (const stmt of stmts) visit(stmt, 0);
  return types;
}

export function validateReadOnly(sql: string): string | null {
  let stmts: Statement[];
  try {
    stmts = parse(sql);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // pgsql-ast-parser appends a parse-table dump that is useless to the
    // LLM and consumes many tokens; keep the diagnostic prefix only.
    const message = raw.split("Here is the state of my parse table")[0].trim();
    return `Failed to parse SQL: ${message}`;
  }
  if (stmts.length === 0) {
    return "Empty query.";
  }
  if (stmts.length > 1) {
    return "Only a single statement is allowed.";
  }
  const types = collectStatementTypes(stmts);
  for (const type of types) {
    if (!ALLOWED_READ_TYPES.has(type)) {
      return `Statement type "${type}" is not allowed in read-only queries. Use the mutate tool for data modifications.`;
    }
  }
  return null;
}

export function validateWrite(sql: string): string | null {
  let stmts: Statement[];
  try {
    stmts = parse(sql);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // pgsql-ast-parser appends a parse-table dump that is useless to the
    // LLM and consumes many tokens; keep the diagnostic prefix only.
    const message = raw.split("Here is the state of my parse table")[0].trim();
    return `Failed to parse SQL: ${message}`;
  }
  if (stmts.length === 0) {
    return "Empty query.";
  }
  if (stmts.length > 1) {
    return "Only a single statement is allowed.";
  }
  const types = collectStatementTypes(stmts);
  for (const type of types) {
    if (!ALLOWED_WRITE_TYPES.has(type)) {
      return `Statement type "${type}" is not allowed. Only INSERT, UPDATE, and DELETE statements are supported.`;
    }
  }
  return null;
}
