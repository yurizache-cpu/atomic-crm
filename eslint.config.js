// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from "eslint-plugin-storybook";

import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

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
        {
          patterns: [
            {
              group: ["ra-core", "ra-*", "react-admin", "@supabase/*"],
              message:
                "Engine code must not depend on the CRM adapter's internals (ADR 0005).",
            },
            {
              group: ["**/src/**", "@/*"],
              message: "Engine code must not import from the SPA.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "engine/worker/**/*.ts",
      "engine/db/**/*.ts",
      "engine/handlers/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["ra-core", "ra-*", "react-admin", "@supabase/*"],
              message:
                "Engine code must not depend on the CRM adapter's internals (ADR 0005).",
            },
            {
              group: ["**/src/**", "@/*"],
              message: "Engine code must not import from the SPA.",
            },
            {
              group: ["**/domain/**", "../domain/*"],
              message:
                "Execution must not depend on the Company OS domain; the dependency runs domain -> execution (ADR 0015).",
            },
          ],
        },
      ],
    },
  },
  storybook.configs["flat/recommended"],
);
