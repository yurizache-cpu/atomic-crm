// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from "eslint-plugin-storybook";

import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

// The engine's import boundaries (ADR 0005, ADR 0015, Phase 1D), as shared
// objects. A later block REPLACES a rule's options for the files it matches;
// flat config never merges pattern lists (measured 2026-09-14: an engine/models
// block naming only `pg` stopped `ra-core` from being flagged). So each engine
// block restates every ban above it, and restating these objects instead of
// copies keeps a restatement from drifting.
const ADAPTER_BOUNDARY = {
  group: ["ra-core", "ra-*", "react-admin", "@supabase/*"],
  message:
    "Engine code must not depend on the CRM adapter's internals (ADR 0005).",
};
const SPA_BOUNDARY = {
  group: ["**/src/**", "@/*"],
  message: "Engine code must not import from the SPA.",
};
const DOMAIN_BOUNDARY = {
  group: ["**/domain/**", "../domain/*"],
  message:
    "Execution must not depend on the Company OS domain; the dependency runs domain -> execution (ADR 0015).",
};
const MODELS_MESSAGE =
  "Model code must stay provider-neutral and database-free: no database driver, worker runtime or job handler; the dependency runs execution -> models.";
const HANDLERS_MESSAGE =
  "Handlers receive capabilities, never a database client or a domain service: no database driver, engine/db or engine/domain.";
const HANDLERS_WORKER_MESSAGE =
  "A handler imports worker types and helpers statically; loading the worker runtime at run time reaches past its capabilities.";
const MODULE_LOADER_MESSAGE =
  "createRequire() loads a module the import boundary never sees; use an ES import.";
/** `createRequire` loads a module that no import rule ever sees. */
const MODULE_LOADER_PATHS = ["module", "node:module"].map((name) => ({
  name,
  message: MODULE_LOADER_MESSAGE,
}));

/**
 * The same boundaries for what no-restricted-imports never reads: it checks
 * import and export declarations only, so `import("pg")` passed it. Each ban
 * pairs an esquery regex with its message. esquery ends a regex at its first
 * `/`, so a path separator is written `\x2F`. Every regex ignores case, as
 * no-restricted-imports' patterns do: a case-insensitive file system loads
 * engine/db from `../DB/`.
 */
const runtimeImportBans = (bans) =>
  bans.flatMap(([specifier, message]) => [
    { selector: `ImportExpression[source.value=${specifier}]`, message },
    { selector: `TSImportType[argument.literal.value=${specifier}]`, message },
  ]);
/** A specifier holding one of `names` as a whole path segment. */
const pathSegment = (names) => `/(^|\\x2F)(${names})(\\x2F|$)/i`;
const DATABASE_DRIVER = "/^pg($|-)/i";
/** `import("node:module")` hands over the createRequire its static import cannot. */
const MODULE_LOADER = "/^(node:)?module$/i";
/** Forms whose target no selector can read, so they are refused outright. */
const UNCHECKABLE_IMPORTS = [
  {
    selector: "ImportExpression[source.type!='Literal']",
    message:
      "A dynamic import must name a string literal: a computed specifier cannot be checked against the engine boundary.",
  },
  {
    // @typescript-eslint/no-require-imports refuses this too, but as a style
    // rule that can be relaxed repository-wide without anyone thinking of this
    // boundary.
    selector: "CallExpression[callee.type='Identifier'][callee.name='require']",
    message:
      "Engine code is ESM: require() loads a module the import boundary never sees.",
  },
  {
    selector: "TSExternalModuleReference",
    message:
      "`import x = require()` loads a module the import boundary never sees; use an ES import.",
  },
];

// The operator API contracts (docs/PHASE_2C_BRIEF.md §6.2) are shared by the
// browser module and the engine's tests, so they import zod and their sibling
// contract files (by `.ts` name) and nothing else, statically or at run time.
const CONTRACTS_MESSAGE =
  "A Company OS contract may import only zod and its sibling contract files (docs/PHASE_2C_BRIEF.md §6.2).";
const CONTRACTS_BOUNDARY = {
  regex: "^(?!(zod|\\./[A-Za-z0-9_-]+\\.ts)$)",
  caseSensitive: true,
  message: CONTRACTS_MESSAGE,
};
const CONTRACTS_RUNTIME_IMPORTS = [
  "ImportExpression",
  "TSImportType",
  "CallExpression[callee.type='Identifier'][callee.name='require']",
  "TSExternalModuleReference",
].map((selector) => ({ selector, message: CONTRACTS_MESSAGE }));
// A contract is a pure function of its input: it reads no browser storage,
// document, network or environment, whatever the runtime that loads it (the
// browser, Node's engine tests). The globals are refused by name, bare or as a
// member of any object (window.fetch, globalThis.localStorage, x.document);
// the global object itself is refused under each of its names, and the two
// ways to reach it without one (eval, Function) are refused too.
const CONTRACTS_IO_MESSAGE =
  "A Company OS contract is a pure function of its input: no browser, storage, network or environment global (docs/PHASE_2C_BRIEF.md §6.2).";
const CONTRACTS_IO_NAMES = [
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "cookieStore",
  "document",
  "window",
  "globalThis",
  "self",
  "fetch",
  "XMLHttpRequest",
  "navigator",
  "WebSocket",
  "EventSource",
  "importScripts",
  "process",
];
const CONTRACTS_IO_GLOBALS = [...CONTRACTS_IO_NAMES, "eval", "Function"].map(
  (name) => ({ name, message: CONTRACTS_IO_MESSAGE }),
);
const CONTRACTS_IO_PROPERTIES = CONTRACTS_IO_NAMES.map((property) => ({
  property,
  message: CONTRACTS_IO_MESSAGE,
}));
// import.meta.env and import.meta.url read the environment and the loader.
const CONTRACTS_IO_SYNTAX = {
  selector: "MetaProperty[meta.name='import'][property.name='meta']",
  message: CONTRACTS_IO_MESSAGE,
};

// The SPA's boundaries (docs/PHASE_2C_BRIEF.md §6.3). The same replacement
// rule applies: every src block below restates the persister ban and the
// engine ban from these objects, so none can drift from the others.
//
// SEC-1BS-01 / SI-19 / SI-59: no React Query persister anywhere in the SPA.
const SPA_PERSISTER_BAN = {
  group: ["@tanstack/*persist*"],
  message:
    "Response data must not be persisted to browser storage (SEC-1BS-01). Keep the React Query cache in memory.",
};
const SPA_ENGINE_MESSAGE =
  "The SPA must not import engine code: it would carry the database driver into the bundle (docs/PHASE_2C_BRIEF.md §6.3).";
const SPA_ENGINE_BAN = {
  group: ["**/engine", "**/engine/**"],
  message: SPA_ENGINE_MESSAGE,
};
const CRM_COMPANY_OS_MESSAGE =
  "The CRM must not depend on the Company OS; only src/App.tsx knows both (docs/PHASE_2C_BRIEF.md §6.3).";
const CRM_COMPANY_OS_BAN = {
  group: ["**/company-os", "**/company-os/**"],
  message: CRM_COMPANY_OS_MESSAGE,
};

// The Company OS module (src/company-os) is ra-core-free and CRM-free: it
// reaches the session and the database only through its injected ports, and
// never a database driver or engine code.
const COMPANY_OS_ADAPTER_MESSAGE =
  "The Company OS reaches the CRM, react-admin and Supabase only through its injected ports (docs/PHASE_2C_BRIEF.md §6.2).";
const COMPANY_OS_DRIVER_MESSAGE =
  "The Company OS runs in the browser: no database driver (docs/PHASE_2C_BRIEF.md §6.3).";
const COMPANY_OS_SPA_MESSAGE =
  "The Company OS shares only @/components/ui and @/lib/utils with the SPA: the SPA's hooks and other libraries reach ra-core (a localStorage-backed store among them) (docs/PHASE_2C_BRIEF.md §6.3).";
const COMPANY_OS_SHELL_MESSAGE =
  "The Company OS never imports the application shell: src/App.tsx and src/companyOsSession.ts hold the CRM and the Supabase client, and reach the module only by injection (docs/PHASE_2C_BRIEF.md §6.2).";
const COMPANY_OS_SPECIFIER_MESSAGE =
  "Name a module plainly: an absolute path, or a `.` or `..` segment after a named one, hides which module it reaches from the import boundary.";
/**
 * Bans matched as regular expressions on the specifier, whatever the depth of
 * the importing file: `[source, message]`, with `/` written plainly. They are
 * read by no-restricted-imports and, rewritten for esquery, by the run-time
 * import selectors, so the two can never drift. Every one ignores case, as a
 * case-insensitive file system does.
 */
const COMPANY_OS_SPECIFIER_BANS = [
  // Through the alias, an allowlist: a ui component or @/lib/utils, no other.
  ["^@/(?!components/ui/[^/]+$|lib/utils$)", COMPANY_OS_SPA_MESSAGE],
  // Relative paths that climb out of src/company-os into the rest of src.
  ["(^|/)(hooks|test)(/|$)", COMPANY_OS_SPA_MESSAGE],
  ["(^|/)lib(/(?!utils$)|$)", COMPANY_OS_SPA_MESSAGE],
  [
    "(^|/)(app|main|companyossession)(\\.[cm]?[jt]sx?)?$",
    COMPANY_OS_SHELL_MESSAGE,
  ],
  ["^/|(^|/)[^./][^/]*/\\.\\.?(/|$)", COMPANY_OS_SPECIFIER_MESSAGE],
];
const COMPANY_OS_IMPORT_BANS = [
  {
    group: ["ra-core", "ra-*", "react-admin", "@supabase/*"],
    message: COMPANY_OS_ADAPTER_MESSAGE,
  },
  {
    // The bare directory too: each has an index module (components/admin/index.ts).
    group: [
      "**/components/atomic-crm",
      "**/components/atomic-crm/**",
      "**/components/admin",
      "**/components/admin/**",
      "**/components/supabase",
      "**/components/supabase/**",
    ],
    message: COMPANY_OS_ADAPTER_MESSAGE,
  },
  { group: ["pg", "pg-*", "pg/**"], message: COMPANY_OS_DRIVER_MESSAGE },
  ...COMPANY_OS_SPECIFIER_BANS.map(([regex, message]) => ({ regex, message })),
  SPA_ENGINE_BAN,
  SPA_PERSISTER_BAN,
];
const COMPANY_OS_DYNAMIC_IMPORTS = [
  {
    selector: "ImportExpression[source.type!='Literal']",
    message:
      "A dynamic import must name a string literal: a computed specifier cannot be checked against the Company OS boundary.",
  },
  {
    selector: "CallExpression[callee.type='Identifier'][callee.name='require']",
    message:
      "The Company OS is ESM: require() loads a module the import boundary never sees.",
  },
  {
    selector: "TSExternalModuleReference",
    message:
      "`import x = require()` loads a module the import boundary never sees; use an ES import.",
  },
  ...runtimeImportBans([
    [
      "/^(ra-|react-admin($|\\x2F)|@supabase\\x2F)/i",
      COMPANY_OS_ADAPTER_MESSAGE,
    ],
    [
      "/(^|\\x2F)components\\x2F(atomic-crm|admin|supabase)(\\x2F|$)/i",
      COMPANY_OS_ADAPTER_MESSAGE,
    ],
    ["/^pg($|[-\\x2F])/i", COMPANY_OS_DRIVER_MESSAGE],
    [pathSegment("engine"), SPA_ENGINE_MESSAGE],
    ["/^@tanstack\\x2F[^\\x2F]*persist/i", SPA_PERSISTER_BAN.message],
    ...COMPANY_OS_SPECIFIER_BANS.map(([source, message]) => [
      `/${source.replaceAll("/", "\\x2F")}/i`,
      message,
    ]),
  ]),
];
// Code no import rule sees: a Vite glob import (import.meta.glob) or a worker
// loads modules by path at run time, so the module may use neither.
const COMPANY_OS_LOADER_MESSAGE =
  "The Company OS loads code only through checked imports: no import.meta (a glob import loads modules no import rule sees) and no worker.";
const COMPANY_OS_HIDDEN_LOADERS = [
  "MetaProperty[meta.name='import'][property.name='meta']",
  "NewExpression[callee.name=/^(Shared)?Worker$/]",
  "NewExpression[callee.property.name=/^(Shared)?Worker$/]",
].map((selector) => ({ selector, message: COMPANY_OS_LOADER_MESSAGE }));
const COMPANY_OS_HTML_MESSAGE =
  "The Company OS renders React-escaped text only: no raw HTML (docs/PHASE_2C_BRIEF.md §6.2).";
const COMPANY_OS_RAW_HTML = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: COMPANY_OS_HTML_MESSAGE,
  },
  {
    // createElement(type, { dangerouslySetInnerHTML }) and its spread props.
    selector:
      "Property:matches([key.name='dangerouslySetInnerHTML'], [key.value='dangerouslySetInnerHTML'])",
    message: COMPANY_OS_HTML_MESSAGE,
  },
];
// SI-59: nothing from the Company OS reaches durable browser storage. The
// globals and their members (window.*, globalThis.*, self.*, or any other
// object) are refused by name; a computed member of the global object cannot
// be read by name, so it is refused outright.
const COMPANY_OS_STORAGE_MESSAGE =
  "Company OS data must never reach browser storage: keep it in the in-memory query cache (docs/PHASE_2C_BRIEF.md §13 item 6).";
const COMPANY_OS_STORAGE_NAMES = [
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "cookieStore",
];
const COMPANY_OS_STORAGE_GLOBALS = COMPANY_OS_STORAGE_NAMES.map((name) => ({
  name,
  message: COMPANY_OS_STORAGE_MESSAGE,
}));
const COMPANY_OS_RESTRICTED_PROPERTIES = [
  ...[...COMPANY_OS_STORAGE_NAMES, "cookie"].map((property) => ({
    property,
    message: COMPANY_OS_STORAGE_MESSAGE,
  })),
  // navigator.storage.getDirectory() is the origin-private file system.
  {
    object: "navigator",
    property: "storage",
    message: COMPANY_OS_STORAGE_MESSAGE,
  },
  ...["innerHTML", "outerHTML", "insertAdjacentHTML"].map((property) => ({
    property,
    message: COMPANY_OS_HTML_MESSAGE,
  })),
];
const COMPANY_OS_HTML_PROPERTIES = COMPANY_OS_RESTRICTED_PROPERTIES.filter(
  ({ message }) => message === COMPANY_OS_HTML_MESSAGE,
);
// No data-built href (docs/PHASE_2C_BRIEF.md §6.2): every plain anchor of the
// module leaves it for a CONSTANT hash (AccessStates.tsx), so an href is a
// string literal or an UPPER_CASE constant, in JSX and in an object, and no
// code assigns one. A router `to` is not linted: each is built from a checked
// uuid (components/recordPaths.ts) or a constant path, and the read-only
// sweep (screens/readOnly.test.tsx) asserts every rendered link stays inside
// #/company-os or is the CRM root.
const COMPANY_OS_HREF_MESSAGE =
  "An href in the Company OS is a string literal or an UPPER_CASE constant, never built from data (docs/PHASE_2C_BRIEF.md §6.2).";
const HREF_CONSTANT =
  ":not(Literal, TemplateLiteral[expressions.length=0], Identifier[name=/^[A-Z][A-Z0-9_]*$/])";
const COMPANY_OS_DATA_HREF = [
  `JSXAttribute[name.name=/^(href|xlinkHref)$/] > JSXExpressionContainer > ${HREF_CONSTANT}`,
  `Property[key.name=/^(href|xlinkHref)$/] > ${HREF_CONSTANT}.value`,
  "AssignmentExpression > MemberExpression.left[property.name='href']",
].map((selector) => ({ selector, message: COMPANY_OS_HREF_MESSAGE }));
const COMPANY_OS_COMPUTED_GLOBAL_MEMBER = {
  selector:
    "MemberExpression[computed=true][object.name=/^(window|globalThis|self)$/][property.type!='Literal']",
  message:
    "A computed member of the global object cannot be checked against the storage ban; name the member.",
};

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx,mjs}"],
    ignores: ["**/node_modules/**", "**/dist/**", "**/.astro/**"],
    languageOptions: {
      ecmaVersion: 2020,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
        },
      ],
      "no-console": ["error", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/consistent-type-imports": "warn",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Node scripts and Claude Code hooks. TypeScript files rely on the
    // compiler for undefined identifiers; plain JS needs no-undef back on.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "no-undef": "error",
    },
  },
  {
    files: [
      "src/components/admin/*.{ts,tsx}",
      "src/hooks/*.{ts,tsx}",
      "src/lib/*.{ts,tsx}",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "off",
    },
  },
  {
    files: ["src/components/ui/*.{ts,tsx}"],
    rules: {
      "react-refresh/only-export-components": "off",
      "@typescript-eslint/consistent-type-imports": "off",
    },
  },
  {
    // SEC-1BS-01 (docs/SECURITY_AUDIT_1BS_REPORT.md). A React Query persister
    // writes every CRM record a user views — contacts, notes, email addresses,
    // consent state — to browser storage that survives a restart. For a
    // psychology clinic that is clinical data left behind on a device, and no
    // product requirement needs offline access. The cache stays in memory.
    //
    // And no SPA or demo file imports engine code, so `pg` never enters the
    // bundle (docs/PHASE_2C_BRIEF.md §6.3 item 2).
    files: ["src/**/*.{ts,tsx}", "demo/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [SPA_PERSISTER_BAN, SPA_ENGINE_BAN] },
      ],
      "no-restricted-syntax": [
        "error",
        ...runtimeImportBans([[pathSegment("engine"), SPA_ENGINE_MESSAGE]]),
      ],
    },
  },
  {
    // The CRM never depends on the Company OS: only src/App.tsx knows both
    // (docs/PHASE_2C_BRIEF.md §6.3 item 2). Restates the SPA bans above.
    files: ["src/components/atomic-crm/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [SPA_PERSISTER_BAN, SPA_ENGINE_BAN, CRM_COMPANY_OS_BAN] },
      ],
      "no-restricted-syntax": [
        "error",
        ...runtimeImportBans([
          [pathSegment("engine"), SPA_ENGINE_MESSAGE],
          [pathSegment("company-os"), CRM_COMPANY_OS_MESSAGE],
        ]),
      ],
    },
  },
  {
    // The Company OS module (docs/PHASE_2C_BRIEF.md §6.3 item 1): no CRM,
    // react-admin, Supabase client, engine or driver import, statically or at
    // run time; no browser storage; no raw HTML; no data-built href; and no
    // console at all (§13 item 9: no browser log carries a projection value).
    // Restates the SPA bans above.
    files: ["src/company-os/**/*.{ts,tsx}"],
    rules: {
      // Options, not only a severity: a severity alone keeps the options of
      // the block above, which allow console.warn and console.error.
      "no-console": ["error", {}],
      "no-restricted-imports": ["error", { patterns: COMPANY_OS_IMPORT_BANS }],
      "no-restricted-globals": ["error", ...COMPANY_OS_STORAGE_GLOBALS],
      "no-restricted-properties": [
        "error",
        ...COMPANY_OS_RESTRICTED_PROPERTIES,
      ],
      "no-restricted-syntax": [
        "error",
        ...COMPANY_OS_DYNAMIC_IMPORTS,
        ...COMPANY_OS_HIDDEN_LOADERS,
        ...COMPANY_OS_RAW_HTML,
        ...COMPANY_OS_DATA_HREF,
        COMPANY_OS_COMPUTED_GLOBAL_MEMBER,
      ],
    },
  },
  {
    // A Company OS test must read browser storage to prove nothing reached it
    // (the storage sentinel), and may silence a report it provokes on purpose
    // (console.error for an error a boundary caught). Only the storage bans
    // and the console ban are lifted here: the import bans, the raw HTML bans
    // (JSX, createElement props, innerHTML, outerHTML, insertAdjacentHTML)
    // and the data-built href ban still hold.
    files: ["src/company-os/**/*.test.{ts,tsx}"],
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
      "no-restricted-globals": "off",
      "no-restricted-properties": ["error", ...COMPANY_OS_HTML_PROPERTIES],
      "no-restricted-syntax": [
        "error",
        ...COMPANY_OS_DYNAMIC_IMPORTS,
        ...COMPANY_OS_HIDDEN_LOADERS,
        ...COMPANY_OS_RAW_HTML,
        ...COMPANY_OS_DATA_HREF,
      ],
    },
  },
  {
    // The application shell carries every Company OS answer: src/App.tsx
    // mounts the module and src/companyOsSession.ts is the port every response
    // passes through. Both may import the CRM and Supabase, which is their job,
    // but neither may put anything in browser storage or render raw HTML
    // (docs/PHASE_2C_BRIEF.md §13 item 6). Restates the SPA bans above.
    files: ["src/App.tsx", "src/companyOsSession.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [SPA_PERSISTER_BAN, SPA_ENGINE_BAN] },
      ],
      "no-restricted-globals": ["error", ...COMPANY_OS_STORAGE_GLOBALS],
      "no-restricted-properties": [
        "error",
        ...COMPANY_OS_RESTRICTED_PROPERTIES,
      ],
      "no-restricted-syntax": [
        "error",
        ...runtimeImportBans([[pathSegment("engine"), SPA_ENGINE_MESSAGE]]),
        ...COMPANY_OS_RAW_HTML,
        COMPANY_OS_COMPUTED_GLOBAL_MEMBER,
      ],
    },
  },
  {
    // The engine boundary, mechanically (ADR 0005, CLAUDE.md rule 1). Engine code
    // never depends on the CRM adapter's internals: no react-admin, no Supabase
    // client, nothing from the SPA. And execution never depends on the domain —
    // the dependency runs domain -> execution (ADR 0015).
    files: ["engine/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [ADAPTER_BOUNDARY, SPA_BOUNDARY] },
      ],
    },
  },
  {
    // Execution, and the model layer it calls, never depend on the domain.
    files: [
      "engine/worker/**/*.ts",
      "engine/db/**/*.ts",
      "engine/handlers/**/*.ts",
      "engine/models/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [ADAPTER_BOUNDARY, SPA_BOUNDARY, DOMAIN_BOUNDARY] },
      ],
    },
  },
  {
    // Handlers receive capabilities (Phase 1B): a frozen object holding what
    // their registry entry declared, never a database client and never a domain
    // service. So nothing under engine/handlers may reach the database driver,
    // engine/db or engine/domain, statically or at run time. Worker types and
    // helpers stay importable; that is how a handler declares itself.
    //
    // engine/handlers stays in the execution block's files too, so deleting
    // this block must not lift the domain ban.
    files: ["engine/handlers/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: MODULE_LOADER_PATHS,
          patterns: [
            ADAPTER_BOUNDARY,
            SPA_BOUNDARY,
            DOMAIN_BOUNDARY,
            { group: ["pg", "pg-*", "**/db/**"], message: HANDLERS_MESSAGE },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        ...UNCHECKABLE_IMPORTS,
        ...runtimeImportBans([
          [DATABASE_DRIVER, HANDLERS_MESSAGE],
          [pathSegment("db"), HANDLERS_MESSAGE],
          [pathSegment("domain"), DOMAIN_BOUNDARY.message],
          [pathSegment("worker"), HANDLERS_WORKER_MESSAGE],
          [MODULE_LOADER, MODULE_LOADER_MESSAGE],
        ]),
      ],
    },
  },
  {
    // Models are provider-neutral and database-free (Phase 1D). A model call
    // holds no transaction, no lease and no capability, so nothing under
    // engine/models may reach the database driver, the worker runtime, a job
    // handler or the domain, statically or at run time. Execution imports
    // models, never the reverse.
    //
    // engine/models stays in the execution block's files too, so deleting this
    // block must not lift the domain ban.
    files: ["engine/models/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: MODULE_LOADER_PATHS,
          patterns: [
            ADAPTER_BOUNDARY,
            SPA_BOUNDARY,
            DOMAIN_BOUNDARY,
            {
              group: [
                "pg",
                "pg-*",
                "**/worker/**",
                "**/db/**",
                "**/handlers/**",
              ],
              message: MODELS_MESSAGE,
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        ...UNCHECKABLE_IMPORTS,
        ...runtimeImportBans([
          [DATABASE_DRIVER, MODELS_MESSAGE],
          [pathSegment("worker|db|handlers"), MODELS_MESSAGE],
          [pathSegment("domain"), DOMAIN_BOUNDARY.message],
          [MODULE_LOADER, MODULE_LOADER_MESSAGE],
        ]),
      ],
    },
  },
  {
    // The contracts may reach nothing but zod. The SI-19 persister ban needs no
    // restating: this block's files do not overlap the src and demo block, and
    // a persister is one of the imports it already refuses. Every source
    // extension is matched, and parsed as a TypeScript module, because the SPA
    // can import a .tsx or .js file here as readily as a .ts one: a .ts-only
    // glob left .tsx, .js and .mjs files unchecked and .jsx, .mts and .cts
    // files unlinted (measured 2026-09-23).
    //
    // Nor may they touch a browser, storage, network or environment global
    // (CONTRACTS_IO_NAMES above), so a contract stays a pure function of the
    // value it parses in every runtime that loads it.
    files: ["contracts/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    languageOptions: { parser: tseslint.parser, sourceType: "module" },
    rules: {
      "no-restricted-imports": ["error", { patterns: [CONTRACTS_BOUNDARY] }],
      "no-restricted-globals": ["error", ...CONTRACTS_IO_GLOBALS],
      "no-restricted-properties": ["error", ...CONTRACTS_IO_PROPERTIES],
      "no-restricted-syntax": [
        "error",
        ...CONTRACTS_RUNTIME_IMPORTS,
        CONTRACTS_IO_SYNTAX,
      ],
    },
  },
  storybook.configs["flat/recommended"],
);
