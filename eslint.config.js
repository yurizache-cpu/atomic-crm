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
    files: ["src/**/*.{ts,tsx}", "demo/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@tanstack/*persist*"],
              message:
                "CRM response data must not be persisted to browser storage (SEC-1BS-01). Keep the React Query cache in memory.",
            },
          ],
        },
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
  storybook.configs["flat/recommended"],
);
