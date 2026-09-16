import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// MODEL PROVIDER SECRETS ARE BACKEND-ONLY, checked at the source (Phase 1D).
//
// A provider credential, and the configuration that routes to it, lives in the
// worker's environment and nowhere a browser can reach. Vite hands every `VITE_`
// variable to the bundle, so a provider name carrying that prefix is a leak
// waiting for its value. scripts/scan-build-artifacts.mjs refuses such a name in
// a BUILD; this file refuses it in the files that decide what a build contains,
// before anyone builds.
//
// It also holds the other half of the boundary: nothing under engine/models or
// engine/handlers names the `process` global. The router receives its
// environment as a parameter (routingConfig.ts; engine/worker/main.ts passes
// process.env) and a handler receives capabilities, so neither can read a key
// its caller did not hand it. Refusing `process` outright, rather than only
// `process.env`, leaves no alias (`const p = process`) to chase, and the global
// object is refused wherever a name does not follow it (`const g = globalThis`,
// `Reflect.get(globalThis, …)`), so it is no way round either.
//
// And the lint boundary for those two directories, which nothing else tests:
// no driver, database layer, domain or module loader, statically or through
// `import()`.
//
// Every provider name in this file is assembled at runtime. The scan below reads
// this file too, and needs no exemption.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Where a `VITE_` variable is read, defined or handed to a build. */
const BUILD_INPUT_ROOTS = [
  "src/",
  "demo/",
  "engine/",
  "supabase/functions/",
  "scripts/",
  // deploy.yml sets the build's environment.
  ".github/",
];
const VITE_CONFIG = /(^|\/)vite(st)?(\.[\w-]+)?\.config\.[cm]?[jt]s$/;
const ENV_FILE = /(^|\/)\.env(\.[\w.-]+)?$/;
const BINARY =
  /\.(png|jpe?g|gif|webp|avif|ico|bmp|svg|woff2?|ttf|otf|eot|pdf|zip|gz|mp3|mp4|webm|wasm)$/i;

const isBuildInput = (file: string): boolean =>
  !BINARY.test(file) &&
  (BUILD_INPUT_ROOTS.some((root) => file.startsWith(root)) ||
    VITE_CONFIG.test(file) ||
    ENV_FILE.test(file) ||
    // Vite replaces `%VITE_…%` in the HTML entry point.
    file === "index.html" ||
    // An npm script or a make target can set a variable for `vite build`.
    file === "package.json" ||
    /^makefile$/i.test(file));

/** Same set as the build scanner's rule. AZURE_OPENAI is covered by OPENAI. */
const PROVIDER_NAME_PARTS = [
  "OPENAI",
  "OPEN_AI",
  "ANTHROPIC",
  "CLAUDE",
  "AGENT_MODEL",
  "MODEL_PROVIDER",
];
const anyCase = (part: string): string =>
  part.replace(/[A-Z]/g, (c) => `[${c}${c.toLowerCase()}]`);
const VITE_PROVIDER_NAME = new RegExp(
  `VITE_[A-Za-z0-9_]*?(?:${PROVIDER_NAME_PARTS.map(anyCase).join("|")})[A-Za-z0-9_]*`,
  "g",
);
/**
 * A vite config can hand the bundle a variable WITHOUT the prefix: `define`
 * inlines any expression, and `envPrefix` widens what counts as public. So a
 * config names no provider variable at all, and never sets envPrefix.
 * Upper-case only: a config legitimately mentions the `.claude` directory.
 */
const CONFIG_PROVIDER_NAME = new RegExp(
  `[A-Z0-9_]*(?:${PROVIDER_NAME_PARTS.join("|")})[A-Z0-9_]*|\\benvPrefix\\b`,
  "g",
);

interface Finding {
  readonly file: string;
  readonly line: number;
  /** A variable or identifier name. Never a value. */
  readonly name: string;
}

const describeFinding = (f: Finding): string => `${f.file}:${f.line} ${f.name}`;

const lineAt = (text: string, index: number): number =>
  text.slice(0, index).split("\n").length;

const matchesOf = (file: string, text: string, pattern: RegExp): Finding[] =>
  [...text.matchAll(pattern)].map((match) => ({
    file,
    line: lineAt(text, match.index),
    name: match[0],
  }));

const findBrowserProviderNames = (file: string, text: string): Finding[] => [
  ...matchesOf(file, text, VITE_PROVIDER_NAME),
  ...(VITE_CONFIG.test(file)
    ? matchesOf(file, text, CONFIG_PROVIDER_NAME)
    : []),
];

const GLOBAL_OBJECTS = new Set(["globalThis", "global", "window", "self"]);

/** `job.process` or `{ process: 1 }` names a member, not the global. */
const isMemberName = (node: ts.Identifier): boolean => {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  return (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isMethodDeclaration(parent)) &&
    parent.name === node
  );
};

/**
 * The global object used as anything but `globalThis.name` or
 * `globalThis["name"]`: aliased, parenthesised, passed as an argument or indexed
 * by a computed key, it reaches `process` without the name ever following it.
 * A type position (`typeof globalThis.fetch`) runs nothing.
 */
const escapesGlobalObject = (node: ts.Identifier): boolean => {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression !== node;
  if (ts.isQualifiedName(parent)) return false;
  if (ts.isElementAccessExpression(parent) && parent.expression === node) {
    return !ts.isStringLiteralLike(parent.argumentExpression);
  }
  return true;
};

const isProcessModule = (node: ts.Node | undefined): boolean =>
  node !== undefined &&
  ts.isStringLiteralLike(node) &&
  /^(node:)?process$/.test(node.text);

/**
 * Every place a file reaches the `process` global or the process module. Read
 * from the syntax tree, so a comment or a string that mentions process.env is
 * not a finding.
 */
const findProcessReferences = (file: string, text: string): Finding[] => {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const findings: Finding[] = [];
  const report = (node: ts.Node, name: string): void => {
    findings.push({
      file,
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      name,
    });
  };
  const onGlobalObject = (node: ts.Expression): boolean =>
    ts.isIdentifier(node) && GLOBAL_OBJECTS.has(node.text);
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.text === "process" &&
      !isMemberName(node)
    ) {
      report(node, "process");
    } else if (
      ts.isIdentifier(node) &&
      GLOBAL_OBJECTS.has(node.text) &&
      !isMemberName(node) &&
      escapesGlobalObject(node)
    ) {
      report(node, node.text);
    } else if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "process" &&
      onGlobalObject(node.expression)
    ) {
      report(node, node.getText(source));
    } else if (
      ts.isElementAccessExpression(node) &&
      onGlobalObject(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "process"
    ) {
      report(node, node.getText(source));
    } else if (
      ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        isProcessModule(node.moduleSpecifier)) ||
      (ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        isProcessModule(node.arguments[0]))
    ) {
      report(node, "node:process");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
};

/**
 * Tracked files plus untracked ones git does not ignore, so a file that has not
 * been committed yet is still read. A failure throws: a scan that silently
 * lists nothing would pass.
 */
const repositoryFiles = (): readonly string[] =>
  execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter((file) => file !== "" && existsSync(join(ROOT, file)));

const readRepositoryFile = (file: string): string =>
  readFileSync(join(ROOT, file), "utf8");

/** A `VITE_` name, assembled so this file never contains one. */
const viteName = (suffix: string): string => "VITE" + "_" + suffix;

describe("no build input names a VITE_ model provider variable", () => {
  it("finds the name in every spelling a source, env or config file uses", () => {
    const openAi = viteName("OPENAI_API_KEY");
    const cases: [string, string, string][] = [
      ["src/app.ts", `const k = import.meta.env.${openAi};`, openAi],
      ["src/env.d.ts", `readonly "${openAi}": string;`, openAi],
      [
        ".env.example",
        `# model\n${viteName("AGENT_MODEL_PROVIDER")}=`,
        viteName("AGENT_MODEL_PROVIDER"),
      ],
      [
        "vite.config.ts",
        `process.env.${viteName("ANTHROPIC_API_KEY")}`,
        viteName("ANTHROPIC_API_KEY"),
      ],
      [
        "index.html",
        `<meta content="%${viteName("CLAUDE_KEY")}%">`,
        viteName("CLAUDE_KEY"),
      ],
      [
        ".github/workflows/deploy.yml",
        `${viteName("AZURE_OPENAI_ENDPOINT")}: x`,
        viteName("AZURE_OPENAI_ENDPOINT"),
      ],
      [
        "scripts/x.mjs",
        `env.${viteName("DEFAULT_MODEL_PROVIDER")}`,
        viteName("DEFAULT_MODEL_PROVIDER"),
      ],
      ["demo/x.ts", `env.${viteName("Open_Ai_Key")}`, viteName("Open_Ai_Key")],
    ];
    for (const [file, text, name] of cases) {
      expect(
        findBrowserProviderNames(file, text).map(describeFinding),
      ).toContain(`${file}:${text.split("\n").length} ${name}`);
    }
  });

  it("leaves the VITE_ variables the SPA reads, and server-side provider names, alone", () => {
    const text = [
      "import.meta.env.VITE_SUPABASE_URL",
      "import.meta.env.VITE_SB_PUBLISHABLE_KEY",
      "import.meta.env.VITE_SUPABASE_ANON_KEY",
      "import.meta.env.VITE_IS_DEMO",
      "import.meta.env.VITE_INBOUND_EMAIL",
      "import.meta.env.VITE_ATTACHMENTS_BUCKET",
      "import.meta.env.VITE_GOOGLE_WORKPLACE_DOMAIN",
      "import.meta.env.VITE_DISABLE_EMAIL_PASSWORD_AUTHENTICATION",
      "import.meta.env.VITE_DATA_MODEL_VERSION",
      // The worker's own configuration, read from its environment.
      "const key = env.OPENAI" + "_API_KEY;",
      "const provider = env.AGENT" + "_MODEL_PROVIDER;",
    ].join("\n");
    expect(findBrowserProviderNames("src/app.ts", text)).toEqual([]);
    expect(findBrowserProviderNames("engine/models/x.ts", text)).toEqual([]);
  });

  it("refuses a vite config that inlines a provider variable or widens the env prefix", () => {
    const serverName = "OPENAI" + "_API_KEY";
    const config = [
      `define: { "import.meta.env.KEY": JSON.stringify(process.env.${serverName}) },`,
      `envPrefix: ["VITE_", "APP_"],`,
      `test: { exclude: [".claude/**"] },`,
    ].join("\n");
    expect(
      findBrowserProviderNames("vite.config.ts", config).map(describeFinding),
    ).toEqual([`vite.config.ts:1 ${serverName}`, "vite.config.ts:2 envPrefix"]);
    // Outside a vite config, a server-side name is ordinary worker code.
    expect(findBrowserProviderNames("engine/worker/main.ts", config)).toEqual(
      [],
    );
  });

  it("reads every place a build takes its variables from, and nothing documentary", () => {
    for (const file of [
      "src/App.tsx",
      "demo/main.tsx",
      "engine/models/routingConfig.ts",
      "supabase/functions/postmark/index.ts",
      "scripts/scan-build-artifacts.mjs",
      ".github/workflows/deploy.yml",
      "vite.config.ts",
      "vite.demo.config.ts",
      "vitest.db.config.ts",
      ".env.development",
      ".env.example",
      "supabase/functions/.env",
      "index.html",
      "package.json",
      "makefile",
    ]) {
      expect(isBuildInput(file), file).toBe(true);
    }
    for (const file of [
      "docs/adr/0016-agent-runs-and-model-providers.md",
      "doc/src/content/docs/developers/deploy.mdx",
      ".claude/agents/quality-reviewer.md",
      "supabase/migrations/20260914120000_agent_runtime.sql",
      "src/assets/logo.png",
    ]) {
      expect(isBuildInput(file), file).toBe(false);
    }
  });

  it("holds for every build input in the repository", () => {
    const inputs = repositoryFiles().filter(isBuildInput);
    // The listing reaches every root, this file included: an empty or partial
    // listing must fail here rather than pass below.
    for (const expected of [
      "src/App.tsx",
      "demo/main.tsx",
      "engine/models/providerSecretsBoundary.test.ts",
      "supabase/functions/postmark/index.ts",
      "scripts/scan-build-artifacts.mjs",
      ".github/workflows/deploy.yml",
      "vite.config.ts",
      ".env.development",
      "index.html",
      "package.json",
      "makefile",
    ]) {
      expect(inputs, expected).toContain(expected);
    }
    const findings = inputs.flatMap((file) =>
      findBrowserProviderNames(file, readRepositoryFile(file)),
    );
    expect(findings.map(describeFinding)).toEqual([]);
  });
});

describe("engine/models and engine/handlers never name the process global", () => {
  it("finds every way of reaching process.env", () => {
    const cases: [string, string][] = [
      ["const key = process.env.KEY;", "process"],
      ['const env = process["env"];', "process"],
      ["const { env } = process;", "process"],
      ["const p = process; p.env;", "process"],
      ["read({ process });", "process"],
      ["globalThis.process.env.KEY;", "globalThis.process"],
      ['global["process"].env;', 'global["process"]'],
      ['import { env } from "node:process";', "node:process"],
      ['import proc from "process";', "node:process"],
      ['const { env } = await import("node:process");', "node:process"],
      // The global object, aliased or indexed so that no name follows it.
      ["const g = globalThis; g.process.env;", "globalThis"],
      ["(globalThis).process.env;", "globalThis"],
      ['Reflect.get(globalThis, "process").env;', "globalThis"],
      ['globalThis["pro" + "cess"].env;', "globalThis"],
      ["const w = self; w.process;", "self"],
    ];
    for (const [text, name] of cases) {
      expect(
        findProcessReferences("engine/models/x.ts", text).map((f) => f.name),
        text,
      ).toContain(name);
    }
  });

  it("ignores comments, strings and members that merely share the name", () => {
    const text = [
      "// Pure: main.ts passes process.env, and nothing here reads it.",
      "/** process.env is never read here. */",
      'it("reads only the object it is given, never process.env", () => {});',
      "const key = env.OPENAI" + "_API_KEY;",
      "job.process();",
      "const handler = { process: () => undefined };",
      "interface Step { process(): void }",
      // The global object followed by a name that is not process.
      "const fetchImpl = options.fetch ?? globalThis.fetch;",
      'const f = globalThis["fetch"];',
      "type Fetch = typeof globalThis.fetch;",
      "const o = { self: 1, window: 2 }; o.self;",
    ].join("\n");
    expect(findProcessReferences("engine/models/x.ts", text)).toEqual([]);
  });

  it("holds for every file under engine/models and engine/handlers", () => {
    const files = repositoryFiles().filter(
      (file) =>
        /^engine\/(models|handlers)\//.test(file) &&
        /\.[cm]?[jt]sx?$/.test(file),
    );
    for (const expected of [
      "engine/models/routingConfig.ts",
      "engine/models/openaiResponses.ts",
      "engine/handlers/postmarkLedgerRetention.ts",
    ]) {
      expect(files, expected).toContain(expected);
    }
    const findings = files.flatMap((file) =>
      findProcessReferences(file, readRepositoryFile(file)),
    );
    expect(findings.map(describeFinding)).toEqual([]);
  });
});

describe("the lint boundary holds engine/handlers and engine/models at run time too", () => {
  // eslint.config.js IS the guard, so each case lints a virtual file through
  // the real config. Only the two boundary rules count; a parse failure fails
  // the case instead of passing it as "not refused".
  const BOUNDARY_RULES = new Set([
    "no-restricted-imports",
    "no-restricted-syntax",
  ]);
  const LINT_TIMEOUT_MS = 60_000;

  const boundaryRulesHit = async (
    eslint: ESLint,
    file: string,
    code: string,
  ): Promise<string[]> => {
    const [result] = await eslint.lintText(code, {
      filePath: join(ROOT, file),
    });
    expect(
      result.messages.filter((m) => m.fatal),
      `${file}: ${code}`,
    ).toEqual([]);
    return result.messages
      .filter((m) => m.ruleId !== null && BOUNDARY_RULES.has(m.ruleId))
      .map((m) => m.ruleId as string);
  };

  it(
    "refuses a driver, the database layer, the domain or a module loader, in every import form",
    async () => {
      const eslint = new ESLint({ cwd: ROOT });
      const cases: [string, string][] = [
        ["engine/handlers/x.ts", 'import pg from "pg";'],
        ["engine/handlers/x.ts", 'export * from "../db/types.ts";'],
        ["engine/handlers/x.ts", 'await import("pg-pool");'],
        ["engine/handlers/x.ts", 'await import("../db/workerDatabase.ts");'],
        ["engine/handlers/x.ts", 'await import("../domain/agentRuns.ts");'],
        ["engine/handlers/x.ts", 'await import("../worker/runOneJob.ts");'],
        ["engine/handlers/x.ts", 'type T = import("../db/types.ts").TxClient;'],
        ["engine/handlers/x.ts", "await import(specifier);"],
        ["engine/handlers/x.ts", 'require("pg");'],
        ["engine/handlers/x.ts", 'import pg = require("pg");'],
        [
          "engine/handlers/x.ts",
          'import { createRequire } from "node:module";',
        ],
        ["engine/models/x.ts", 'import { Pool } from "pg";'],
        [
          "engine/models/x.ts",
          'await import("../handlers/agentRunExecute.ts");',
        ],
        ["engine/models/x.ts", 'type T = import("pg").Pool;'],
        ["engine/models/x.ts", 'import { createRequire } from "module";'],
        // The dynamic form of the module loader hands over the same
        // createRequire, and createRequire(url)("pg") names no import at all.
        [
          "engine/handlers/x.ts",
          'const { createRequire } = await import("node:module");',
        ],
        ["engine/models/x.ts", 'const m = await import("module");'],
        // A case-insensitive file system loads engine/db from `../DB/`; the
        // static patterns already ignore case, so the dynamic ones must too.
        ["engine/handlers/x.ts", 'await import("../DB/workerDatabase.ts");'],
        ["engine/handlers/x.ts", 'await import("PG");'],
        ["engine/models/x.ts", 'await import("../Worker/runOneJob.ts");'],
        ["engine/models/x.ts", 'await import("../Domain/agentRuns.ts");'],
      ];
      for (const [file, code] of cases) {
        expect(
          await boundaryRulesHit(eslint, file, code),
          `${file}: ${code}`,
        ).not.toEqual([]);
      }
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "leaves what a handler and a model legitimately import alone",
    async () => {
      const eslint = new ESLint({ cwd: ROOT });
      const cases: [string, string][] = [
        ["engine/handlers/x.ts", 'import { z } from "zod";'],
        [
          "engine/handlers/x.ts",
          'import type { Capabilities } from "../worker/capabilities.ts";',
        ],
        [
          "engine/handlers/x.ts",
          'import { payloadObject } from "../worker/job.ts";',
        ],
        [
          "engine/handlers/x.ts",
          'import { fingerprintModelRequest } from "../models/fingerprint.ts";',
        ],
        ["engine/models/x.ts", 'import { createHash } from "node:crypto";'],
        ["engine/models/x.ts", 'import { ModelError } from "./errors.ts";'],
      ];
      for (const [file, code] of cases) {
        expect(
          await boundaryRulesHit(eslint, file, code),
          `${file}: ${code}`,
        ).toEqual([]);
      }
    },
    LINT_TIMEOUT_MS,
  );
});
