import path from "node:path";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import react from "@vitejs/plugin-react";

// Three test projects (https://vitest.dev/guide/projects.html):
//   - "app":       React/DOM unit tests, run in a real browser (Playwright/Chromium).
//   - "claude":    agent-harness hook tests, plain Node integration tests that spawn
//                  the .claude/hooks/*.mjs hooks as subprocesses. No DOM, no browser.
//   - "functions": Supabase Edge Function tests. Written for Deno with JSR imports;
//                  Node-only here, with the jsr:/npm: specifiers aliased to their
//                  installed npm equivalents. Aliases are scoped to this project.
// Run everything with `npm run test:unit:app`, or a single suite with
// `npm run test:unit:claude` / `npm run test:unit:functions` (neither boots a browser).
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        optimizeDeps: {
          exclude: ["playwright", "playwright-core"],
        },
        resolve: {
          preserveSymlinks: true,
          alias: {
            "@": path.resolve(__dirname, "./src"),
          },
        },
        test: {
          name: "app",
          globals: true,
          browser: {
            headless: true,
            provider: playwright(),
            enabled: true,
            instances: [
              {
                browser: "chromium",
                ...(process.env.CI && {
                  launch: { channel: "chromium-headless-shell" },
                }),
              },
            ],
            commands: {
              // Uses Chrome DevTools Protocol to override the timezone at runtime,
              // since process.env.TZ has no effect in a real browser environment.
              async setTimezone({ context, page }, timezoneId: string) {
                const session = await context.newCDPSession(page);
                await session.send("Emulation.setTimezoneOverride", {
                  timezoneId,
                });
                await session.detach();
              },
            },
          },
          exclude: [
            "**/node_modules/**",
            "doc/**",
            "supabase/**",
            ".supabase-e2e/**",
            "e2e/**/*.spec.{ts,tsx}",
            // Harness hook tests are Node-only (they import node:fs / node:path
            // and spawn subprocesses); they run under the "claude" project below.
            ".claude/**",
            // Same reason: repository tooling tests read the filesystem, which
            // the browser-mode runner cannot do. This project has no `include`,
            // so anything not excluded here is picked up by the default glob.
            "scripts/**",
            // The engine is a server-side Node process, not part of the bundle.
            "engine/**",
          ],
          server: {
            deps: {
              external: [/playwright/],
            },
          },
        },
      },
      {
        test: {
          name: "claude",
          environment: "node",
          // `.claude/` is the agent harness; `scripts/` is the repository's own
          // Node tooling. Both are node-side .mjs with the same needs, and this
          // project already runs in CI and in deploy.yml's gate, so widening it
          // is cheaper than a fourth project plus a fourth script and CI step.
          include: [".claude/**/*.test.mjs", "scripts/**/*.test.mjs"],
          // These tests spawn `node` subprocesses and do real git/worktree work,
          // so they need more headroom than the default 5s.
          testTimeout: 30000,
          hookTimeout: 30000,
          server: {
            deps: {
              // `.claude/scripts/*.mjs` are executables whose first line is a
              // `#!` hashbang. Vite preserves it and Vitest wraps the module in
              // a function body, where `#!` is a SyntaxError — so a test that
              // imports one fails to collect. Externalising lets node import
              // them natively, which accepts the hashbang. Scoped to this
              // project; the app/functions projects are unaffected.
              external: [/[/\\]\.claude[/\\]scripts[/\\][^/\\]+\.mjs$/],
            },
          },
        },
      },
      {
        // Map the Deno imports to the installed npm packages so Vitest can run
        // these Deno-targeted tests in Node without a Deno runtime. These aliases
        // only apply to this project.
        resolve: {
          alias: {
            "jsr:@supabase/supabase-js@2": path.resolve(
              __dirname,
              "node_modules/@supabase/supabase-js",
            ),
            "npm:tldts": path.resolve(__dirname, "node_modules/tldts"),
            "npm:pgsql-ast-parser@^12": "pgsql-ast-parser",
          },
        },
        test: {
          name: "functions",
          globals: true,
          environment: "node",
          // Widened from `supabase/functions/**` so schema-level checks
          // (migrations vs seed vs declarative schema) can live next to the
          // SQL they guard. Those are static file analyses — no database.
          // `engine/` is the server-side Company OS code; it is Node, like
          // the edge functions, so it runs in this project rather than a fourth.
          include: ["supabase/**/*.test.ts", "engine/**/*.test.ts"],
          exclude: ["**/node_modules/**", ".supabase-e2e/**"],
        },
      },
    ],
  },
});
