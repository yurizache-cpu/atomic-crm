import { describe, expect, it } from "vitest";
import { checkProductionScope, moduleIdentity } from "../production-scope.mjs";
import {
  CONFIG,
  MERGE,
  POOL,
  TREE,
  USERS,
  found,
  mutate,
  read,
  rulesOf,
} from "./production-scope-helpers.mjs";

// Every "refuses" case reintroduces a way back for the removed MCP SQL function
// into a deployed edge function, and the guard must name it. Cases marked
// (review), (review 2) and (review 3) reproduce ways three adversarial reviews
// got past earlier versions of the guard.

const MCP_IMPORT =
  'import { McpServer } from "npm:@modelcontextprotocol/sdk@1.28.0/server/mcp.js";\n';
const POOL_SKETCH = {
  path: POOL,
  content:
    'import { Pool } from "https://deno.land/x/postgres@v0.17.0/mod.ts";\nexport const db = new Pool("", 1);\n',
};
const TOOLS = "supabase/functions/users/tools.ts";
const IMPORTS_TOOLS = { path: USERS, content: 'import "./tools.ts";\n' };

describe("production scope: reintroducing the MCP function", () => {
  it("refuses the function directory coming back with its MCP server", () => {
    expect(
      found({ path: "supabase/functions/mcp/index.ts", content: MCP_IMPORT }),
    ).toEqual([
      "function-not-allowlisted supabase/functions/mcp",
      "generic-sql-endpoint supabase/functions/mcp/index.ts:1",
    ]);
  });

  it("refuses a second supabase functions tree (review)", () => {
    expect(
      found({
        path: "staging/supabase/functions/users/index.ts",
        content: "Deno.serve(() => new Response(null));\n",
      }),
    ).toEqual(["functions-tree-outside-canonical staging/supabase/functions"]);
  });

  it("refuses code imported from outside the tree, by relative or absolute path (review 3)", () => {
    expect(
      found(
        { path: "engine/mcp/index.ts", content: MCP_IMPORT },
        { path: USERS, content: 'import "../../../engine/mcp/index.ts";\n' },
      ),
    ).toEqual([`function-imports-outside-functions ${USERS}:1`]);
    expect(
      found({ path: USERS, content: 'import "/srv/engine/mcp/index.ts";\n' }),
    ).toEqual([`function-imports-outside-functions ${USERS}:1`]);
  });

  it("reads every way a module is loaded, through comments, quotes and semicolons (review 3)", () => {
    for (const content of [
      'import {\n  Client, // Deno\'s client; see its docs\n} from "npm:pg@8.11.3";\n',
      'export * from "npm:pg@8.11.3";\n',
      'export { Client } from "npm:pg@8.11.3";\n',
      'import pg = require("npm:pg@8.11.3");\n',
      'const pg = require("npm:pg@8.11.3");\n',
      'type Pg = typeof import("npm:pg@8.11.3");\n',
    ]) {
      expect(found(IMPORTS_TOOLS, { path: TOOLS, content })).toEqual([
        `function-dependency-unreviewed ${TOOLS}:1`,
      ]);
    }
    expect(
      found(
        { path: USERS, content: 'import "./view.tsx";\n' },
        {
          path: "supabase/functions/users/view.tsx",
          content:
            "/** @jsxImportSource npm:preact@10.26.0 */\nexport const View = () => <p />;\n",
        },
      ),
    ).toEqual([
      "function-dependency-unreviewed supabase/functions/users/view.tsx:1",
    ]);
    expect(
      rulesOf(IMPORTS_TOOLS, { path: TOOLS, content: `/**/ ${MCP_IMPORT}` }),
    ).toEqual(["function-dependency-unreviewed", "generic-sql-endpoint"]);
    expect(
      found(POOL_SKETCH, {
        path: USERS,
        content:
          'import {\n  db, // the pool; see merge_contacts\n} from "../_shared/db.ts";\n',
      }),
    ).toEqual([`postgres-pool-consumer ${USERS}:1`]);
  });

  it("refuses a known MCP server or SQL parser wherever function source names it (review 2)", () => {
    for (const name of [
      "npm:mcp-lite@0.8.0",
      "npm:@hono/mcp",
      "https://esm.sh/%40modelcontextprotocol/sdk",
      "McpServer",
      "node-sql-parser",
      "pgsql-ast-parser",
    ]) {
      expect(
        found({ path: USERS, content: `const tool = "${name}";\n` }),
      ).toEqual([`generic-sql-endpoint ${USERS}:1`]);
    }
  });

  it("refuses unreviewed modules, modules from unreviewed files, and loaders no review can follow (review 2)", () => {
    for (const specifier of [
      "npm:postgres@3",
      "node:child_process",
      "https://deno.land/x/postgres@v0.17.0/mod.ts",
    ]) {
      expect(
        found({ path: USERS, content: `import x from "${specifier}";\n` }),
      ).toEqual([`function-dependency-unreviewed ${USERS}:1`]);
    }
    expect(
      found({
        path: USERS,
        content:
          'const m = "sdk";\nawait import(`npm:${m}`);\nconst load = createRequire(import.meta.url);\n',
      }),
    ).toEqual([
      `function-dynamic-import ${USERS}:2`,
      `function-dynamic-import ${USERS}:3`,
    ]);
  });

  it("names a module by scheme and package, never by version, and trusts no path trick (review 3)", () => {
    expect(
      [
        "npm:@modelcontextprotocol/sdk@1.28.0/server/mcp.js",
        "jsr:@supabase/supabase-js@2",
        "https://deno.land/x/postgres@v0.17.0/mod.ts",
        "https://esm.sh/%40modelcontextprotocol/sdk@1.28.0/server/mcp.js",
        "node:child_process",
        "tldts",
        "https://esm.sh/kysely@0.27.2/../pg@8.11.3",
        "https://esm.sh/kysely@0.27.2/%2e%2e/pg@8.11.3",
        "https://esm.sh/kysely@0.27.2?alias=pg",
        "https://esm.sh/kysely@0.27.2?deps=pg@8.11.3",
        "https://esm.sh/kysely@0.27.2?external=pg",
      ].map(moduleIdentity),
    ).toEqual([
      "npm:@modelcontextprotocol/sdk",
      "jsr:@supabase/supabase-js",
      "https://deno.land/x/postgres",
      "https://esm.sh/%40modelcontextprotocol/sdk",
      "node:child_process",
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("refuses an unresolved import, a module map it cannot read and a reviewed function with no entrypoint (review 3)", () => {
    expect(found({ path: USERS, content: 'import "./tools.ts";\n' })).toEqual([
      `function-import-unresolved ${USERS}:1`,
    ]);
    const remap =
      '{ "imports": { "jsr:@supabase/supabase-js@2": "npm:postgres@3" } }';
    for (const [path, content] of [
      [
        "supabase/functions/users/deno.json",
        '{ "imports": {}, "scopes": { "./": { "jsr:@supabase/supabase-js@2": "npm:postgres@3" } } }',
      ],
      [
        "supabase/functions/users/deno.json",
        '{ "importMap": "../../map.json" }',
      ],
      [
        "supabase/functions/users/deno.json",
        '{\n  // comments make it unreadable\n  "imports": {}\n}',
      ],
      [
        "supabase/functions/users/deno.json",
        '{ "imports": { "../_shared/utils.ts": "./utils.ts" } }',
      ],
      [
        "supabase/functions/users/deno.json",
        '{ "imports": { "https://deno.land/x/postgres@v0.17.0/": "https://esm.sh/pg-mcp@1/" } }',
      ],
      ["supabase/functions/import_map.json", remap],
      ["supabase/functions/deno.json", remap],
      ["supabase/functions/users/import_map.json", remap],
      ["supabase/functions/users/deno.jsonc", remap],
      ["supabase/functions/users/package.json", '{ "dependencies": {} }'],
    ]) {
      expect(rulesOf({ path, content })).toEqual([
        "function-import-map-unreadable",
      ]);
    }
    expect(
      checkProductionScope(TREE.filter((f) => f.path !== USERS)).map(
        (v) => v.rule,
      ),
    ).toEqual(["allowlisted-function-missing"]);
  });

  it("refuses caller input handed to a raw SQL call under any alias, wrapper or literal member name (review 3)", () => {
    for (const call of [
      "await db.executeQuery(CompiledQuery.raw(sql));",
      "await db.executeQuery(CompiledQuery\n  .raw(sql));",
      'await db.executeQuery(CompiledQuery.raw("SELECT " + sql));',
      "await db.executeQuery(CompiledQuery.raw(`SELECT ${sql}`));",
      "await db.executeQuery({ sql, parameters: [], query: null });",
      "await db.executeQuery(Object.freeze({ sql, parameters: [] }));",
      "await db.executeQuery(JSON.parse(sql));",
      "await db.executeQuery(CompiledQuery.raw!(sql));",
      "await db.executeQuery((CompiledQuery.raw)(sql));",
      "await kysql.raw(sql).execute(db);",
      "await CompiledQuery.raw.call(null, sql);",
      "await CompiledQuery.raw.apply(null, [sql]);",
      "await other.raw.bind(other)(sql).execute(db);",
      "const { raw } = CompiledQuery;",
      "await client.unsafe(sql);",
      "await client.unsafe(sql.trim());",
      "await client.query(sql);",
      "await client.queryObject(sql);",
      'await client["queryObject"](sql);',
      "await client.queryObject({ text: sql });",
      "await client.queryArray(sql);",
    ]) {
      expect(
        rulesOf({
          path: USERS,
          content: `const { sql } = await req.json();\n${call}\n`,
        }),
      ).toEqual(["raw-sql-non-literal"]);
    }
  });

  it("accepts literal SQL with bound parameters, refuses any interpolated template, and refuses a query compiled elsewhere (closure)", () => {
    expect(
      found({
        path: MERGE,
        content:
          'await trx.executeQuery(CompiledQuery.raw("SET LOCAL ROLE authenticated"));\nawait trx.executeQuery(\n  CompiledQuery.raw(\n    "SELECT set_config(\'request.jwt.claim.sub\', $1, true)",\n    [userId],\n  ),\n);\n',
      }),
    ).toEqual([]);
    for (const path of [MERGE, POOL, USERS]) {
      expect(
        found({
          path,
          content:
            "await trx.executeQuery(CompiledQuery.raw(`SELECT set_config('request.jwt.claim.sub', '${userId}', true)`));\n",
        }),
      ).toEqual([`raw-sql-non-literal ${path}:1`]);
    }
    for (const path of [MERGE, POOL]) {
      expect(
        found({ path, content: "await trx.executeQuery(query.compile());\n" }),
      ).toEqual([`raw-sql-non-literal ${path}:1`]);
    }
  });

  it("refuses a raw SQL helper added to the shared pool module (review 3)", () => {
    const pool = read(POOL);
    expect(found({ path: POOL, content: pool })).toEqual([]);
    for (const helper of [
      "export const runSql = (client, text) => client.queryObject(text);",
      "export const runCompiled = (client, compiledQuery) => client.queryObject({ text: compiledQuery.sql, args: [] });",
      "export const runWith = (client, compiledQuery, options) => client.queryObject({ text: compiledQuery.sql, ...options });",
    ]) {
      expect(rulesOf({ path: POOL, content: `${pool}\n${helper}\n` })).toEqual([
        "raw-sql-non-literal",
      ]);
    }
  });

  it("refuses a function that imports another function's files (closure)", () => {
    expect(
      found({
        path: USERS,
        content:
          'import "../merge_contacts/index.ts";\nDeno.serve(() => new Response(null));\n',
      }),
    ).toEqual([`function-imports-other-function ${USERS}:1`]);
    expect(
      rulesOf(
        {
          path: USERS,
          content: 'import { helper } from "../_shared/helper.ts";\n',
        },
        {
          path: "supabase/functions/_shared/helper.ts",
          content:
            'export { runAsUser as helper } from "../merge_contacts/index.ts";\n',
        },
      ),
    ).toEqual(["function-imports-other-function"]);
    expect(
      found(
        {
          path: MERGE,
          content: 'import { a } from "../merge_contacts/helper.ts";\n',
        },
        {
          path: "supabase/functions/merge_contacts/helper.ts",
          content: "export const a = 1;\n",
        },
      ),
    ).toEqual([]);
  });

  it("refuses the shared Postgres pool reached from a function other than merge_contacts (review)", () => {
    expect(
      found(POOL_SKETCH, {
        path: USERS,
        content: 'import { db } from "../_shared/db.ts";\n',
      }),
    ).toEqual([`postgres-pool-consumer ${USERS}:1`]);
  });

  it("refuses function configuration away from its canonical paths, however the key is spelled (review 3)", () => {
    const header = "[functions.users]\nverify_jwt = false";
    for (const line of [
      'entrypoint = "../engine/mcp/index.ts"',
      'entrypoint = "./functions/users/main.ts"',
      '"entrypoint" = "../engine/mcp/index.ts"',
      'entrypoint = ""',
      'import_map = "./import_map.json"',
      'static_files = [\n  "./functions/users/page.html", # see ]\n  "../engine/x",\n]',
      'static_files = ["./functions/users/../../engine/x"]',
    ]) {
      expect(rulesOf(mutate(CONFIG, header, `${header}\n${line}`))).toEqual([
        "function-config-path-not-canonical",
      ]);
    }
    expect(
      rulesOf({
        path: CONFIG,
        content: `functions.users.entrypoint = "../engine/mcp/index.ts"\n${read(CONFIG)}`,
      }),
    ).toEqual(["function-config-path-not-canonical"]);
  });

  it("refuses the function's configuration, however the table or key is spelled (review 3)", () => {
    for (const content of [
      "[functions.mcp]\nverify_jwt = false\n",
      '[ functions . "mcp" ]\nverify_jwt = false\n',
      "[functions.'mcp']\nverify_jwt = false\n",
      "[functions]\nverify_jwt = false\n",
      "[remotes.staging.functions.users]\nverify_jwt = false\n",
      "functions.mcp.verify_jwt = false\n",
      'functions = { users = { entrypoint = "../x" } }\n',
    ]) {
      expect(rulesOf({ path: CONFIG, content })).toEqual([
        "function-config-not-allowlisted",
      ]);
    }
  });
});
