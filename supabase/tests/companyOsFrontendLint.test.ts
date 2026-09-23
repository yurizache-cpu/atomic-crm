import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// The frontend boundaries of the Company OS (docs/PHASE_2C_BRIEF.md §6.3 items
// 1-3), proven executable. eslint.config.js IS the guard, so each case lints a
// virtual file through the real config and names the rule that must refuse it;
// a parse failure fails the case instead of passing it as "not refused". The
// paths are virtual because a real fixture under src/ would fail `npm run lint`.
//
// Model: engine/models/providerSecretsBoundary.test.ts.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LINT_TIMEOUT_MS = 60_000;

const BOUNDARY_RULES = new Set([
  "no-restricted-imports",
  "no-restricted-syntax",
  "no-restricted-globals",
  "no-restricted-properties",
  "no-console",
]);

type Case = readonly [file: string, code: string, rule: string];

const lint = async (eslint: ESLint, file: string, code: string) => {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, file) });
  expect(
    result.messages.filter((message) => message.fatal),
    `${file}: ${code}`,
  ).toEqual([]);
  return result.messages;
};

const boundaryRulesHit = async (
  eslint: ESLint,
  file: string,
  code: string,
): Promise<string[]> =>
  (await lint(eslint, file, code))
    .filter((m) => m.ruleId !== null && BOUNDARY_RULES.has(m.ruleId))
    .map((m) => m.ruleId as string);

const expectEachRefusedBy = async (cases: readonly Case[]) => {
  const eslint = new ESLint({ cwd: ROOT });
  for (const [file, code, rule] of cases) {
    expect(
      await boundaryRulesHit(eslint, file, code),
      `${file}: ${code}`,
    ).toContain(rule);
  }
};

const COMPANY_OS_FILE = "src/company-os/shell/Example.tsx";
const COMPANY_OS_TEST = "src/company-os/shell/Example.test.tsx";

describe("the Company OS module reaches nothing but its ports", () => {
  it(
    "refuses the CRM, react-admin, Supabase, the engine, a driver and a persister, in every import form",
    async () => {
      const imports = "no-restricted-imports";
      const syntax = "no-restricted-syntax";
      await expectEachRefusedBy(
        [
          ['import { useGetList } from "ra-core";', imports],
          ['import polyglotI18nProvider from "ra-i18n-polyglot";', imports],
          ['import { Admin } from "react-admin";', imports],
          ['import { createClient } from "@supabase/supabase-js";', imports],
          ['import { CRM } from "@/components/atomic-crm/root/CRM";', imports],
          [
            'import { CRM } from "../../components/atomic-crm/root/CRM";',
            imports,
          ],
          ['import { Admin } from "@/components/admin/admin";', imports],
          [
            'import { SetPasswordPage } from "@/components/supabase/set-password-page";',
            imports,
          ],
          [
            'import { claimJob } from "../../../engine/db/workerDatabase.ts";',
            imports,
          ],
          ['import pg from "pg";', imports],
          ['import Pool from "pg-pool";', imports],
          [
            'import { persistQueryClient } from "@tanstack/react-query-persist-client";',
            imports,
          ],
          ['export * from "ra-core";', imports],
          ['await import("ra-core");', syntax],
          ['await import("react-admin");', syntax],
          ['await import("@supabase/supabase-js");', syntax],
          ['await import("@/components/atomic-crm/root/CRM");', syntax],
          ['await import("../../components/admin/admin");', syntax],
          ['await import("../../../engine/domain/agentRuns.ts");', syntax],
          ['await import("../../../Engine/db/workerDatabase.ts");', syntax],
          ['await import("pg");', syntax],
          ['await import("@tanstack/query-async-storage-persister");', syntax],
          ['type T = import("ra-core").Identifier;', syntax],
          ["await import(specifier);", syntax],
          ['require("pg");', syntax],
          ['import pg = require("pg");', syntax],
        ].map(([code, rule]) => [COMPANY_OS_FILE, code, rule] as const),
      );
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "refuses the rest of the SPA and the application shell, whatever the depth of the importing file",
    async () => {
      const imports = "no-restricted-imports";
      const syntax = "no-restricted-syntax";
      await expectEachRefusedBy(
        [
          // The bare directories: each has an index module.
          ['import { Admin } from "@/components/admin";', imports],
          ['import { Admin } from "../../components/admin";', imports],
          ['import { CRM } from "@/components/atomic-crm";', imports],
          ['import * as auth from "@/components/supabase";', imports],
          // The SPA's hooks and libraries reach ra-core.
          ['import { useSavedQueries } from "@/hooks/saved-queries";', imports],
          ['import { useIsMobile } from "../../hooks/use-mobile";', imports],
          ['import * as hooks from "@/hooks";', imports],
          ['import { i18nProvider } from "@/lib/i18nProvider";', imports],
          ['import { genericMemo } from "../../lib/genericMemo";', imports],
          ['import * as lib from "@/lib";', imports],
          // The CRM's test helpers, and anything else under the alias.
          ['import { StoryWrapper } from "@/test/StoryWrapper";', imports],
          ['import { StoryWrapper } from "../../test/StoryWrapper";', imports],
          ['import logo from "@/assets/react.svg";', imports],
          // The shell, which holds the CRM and the Supabase client.
          [
            'import { createSupabaseSessionPort } from "../../companyOsSession";',
            imports,
          ],
          ['import App from "../../App";', imports],
          ['import App from "../../App.tsx";', imports],
          ['import "../../main";', imports],
          // A path that hides where it goes.
          ['import { Admin } from "@/components/ui/../admin";', imports],
          ['import * as saved from "/src/hooks/saved-queries";', imports],
          // The same, loaded at run time or named in a type.
          ['await import("@/components/admin");', syntax],
          ['await import("@/hooks/saved-queries");', syntax],
          ['await import("../../lib/i18nProvider");', syntax],
          ['await import("../../companyOsSession");', syntax],
          ['await import("../../App");', syntax],
          ['await import("@/components/ui/../admin");', syntax],
          ['await import("@/test/StoryWrapper");', syntax],
          [
            'type D = import("../../companyOsSession").SessionPortDependencies;',
            syntax,
          ],
        ].map(([code, rule]) => [COMPANY_OS_FILE, code, rule] as const),
      );
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "refuses code loaded outside checked imports: import.meta and workers, in tests too",
    async () => {
      const syntax = "no-restricted-syntax";
      const cases = [
        'const modules = import.meta.glob("/src/components/atomic-crm/**/*.ts", { eager: true });',
        "const mode = import.meta.env.MODE;",
        'new Worker(new URL("../../components/atomic-crm/root/CRM.tsx", import.meta.url));',
        'new Worker("/assets/crm.js", { type: "module" });',
        'new SharedWorker("/assets/crm.js");',
        'new window.Worker("/assets/crm.js");',
      ];
      await expectEachRefusedBy([
        ...cases.map((code) => [COMPANY_OS_FILE, code, syntax] as const),
        ...cases.map((code) => [COMPANY_OS_TEST, code, syntax] as const),
      ]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "refuses browser storage and cookies, bare or as a member of any object",
    async () => {
      const globals = "no-restricted-globals";
      const properties = "no-restricted-properties";
      await expectEachRefusedBy(
        [
          ['localStorage.setItem("k", "v");', globals],
          ['sessionStorage.getItem("k");', globals],
          ['indexedDB.open("db");', globals],
          ['caches.open("c");', globals],
          ['cookieStore.set("k", "v");', globals],
          ['window.localStorage.setItem("k", "v");', properties],
          ["globalThis.sessionStorage.clear();", properties],
          ['self.indexedDB.open("db");', properties],
          ["window.caches.keys();", properties],
          ['window["localStorage"].clear();', properties],
          ["const { localStorage: store } = window;", properties],
          ['document.cookie = "k=v";', properties],
          ['window.document.cookie = "k=v";', properties],
          ["navigator.storage.getDirectory();", properties],
          ["window[name].clear();", "no-restricted-syntax"],
          ["globalThis[name];", "no-restricted-syntax"],
        ].map(([code, rule]) => [COMPANY_OS_FILE, code, rule] as const),
      );
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "refuses raw HTML",
    async () => {
      await expectEachRefusedBy(
        [
          [
            "export const X = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;",
            "no-restricted-syntax",
          ],
          [
            'createElement("div", { dangerouslySetInnerHTML: { __html: html } });',
            "no-restricted-syntax",
          ],
          ["element.innerHTML = html;", "no-restricted-properties"],
          [
            'element.insertAdjacentHTML("beforeend", html);',
            "no-restricted-properties",
          ],
        ].map(([code, rule]) => [COMPANY_OS_FILE, code, rule] as const),
      );
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "refuses an href built from data, in JSX, in an object and by assignment, in tests too",
    async () => {
      const syntax = "no-restricted-syntax";
      const cases = [
        "export const X = ({ url }: { url: string }) => <a href={url}>x</a>;",
        "export const X = ({ id }: { id: string }) => <a href={`#/company-os/tasks/${id}`}>x</a>;",
        'export const X = ({ id }: { id: string }) => <a href={"#/" + id}>x</a>;',
        "export const X = ({ link }: { link: { url: string } }) => <a href={link.url}>x</a>;",
        "export const X = ({ url }: { url: string }) => <svg><use xlinkHref={url} /></svg>;",
        'createElement("a", { href: data.url });',
        "const props = { href: `#/${id}` };",
        "anchor.href = url;",
        'location.href = "#/";',
      ];
      await expectEachRefusedBy([
        ...cases.map((code) => [COMPANY_OS_FILE, code, syntax] as const),
        ...cases.map((code) => [COMPANY_OS_TEST, code, syntax] as const),
      ]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "leaves an href that is a string literal or an UPPER_CASE constant alone",
    async () => {
      const eslint = new ESLint({ cwd: ROOT });
      expect(
        await boundaryRulesHit(
          eslint,
          COMPANY_OS_FILE,
          [
            'const CRM_HOME_HREF = "#/";',
            "export const A = () => <a href={CRM_HOME_HREF}>CRM</a>;",
            'export const B = () => <a href="#/">CRM</a>;',
            "export const C = () => <a href={`#/`}>CRM</a>;",
            'const props = { href: "#/" };',
            "void props;",
          ].join("\n"),
        ),
      ).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "refuses every console call in the module, and lets a test silence a report it provokes",
    async () => {
      await expectEachRefusedBy(
        [
          'console.log("x");',
          "console.error(error);",
          "console.warn(value);",
          "console.info(state);",
          "console.debug(response);",
        ].map((code) => [COMPANY_OS_FILE, code, "no-console"] as const),
      );
      const eslint = new ESLint({ cwd: ROOT });
      expect(
        await boundaryRulesHit(
          eslint,
          COMPANY_OS_TEST,
          'vi.spyOn(console, "error").mockImplementation(() => {}); console.error("expected");',
        ),
      ).toEqual([]);
      await expectEachRefusedBy([
        [COMPANY_OS_TEST, 'console.log("x");', "no-console"],
      ]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "lifts only the storage bans for its tests, which must read storage to prove it empty",
    async () => {
      const eslint = new ESLint({ cwd: ROOT });
      for (const test of [
        COMPANY_OS_TEST,
        "src/company-os/shell/Example.test.ts",
      ]) {
        expect(
          await boundaryRulesHit(
            eslint,
            test,
            'localStorage.getItem("k"); await caches.keys(); document.cookie;',
          ),
          test,
        ).toEqual([]);
      }
      await expectEachRefusedBy([
        [
          COMPANY_OS_TEST,
          "element.innerHTML = html;",
          "no-restricted-properties",
        ],
        [
          COMPANY_OS_TEST,
          "element.outerHTML = html;",
          "no-restricted-properties",
        ],
        [
          COMPANY_OS_TEST,
          'element.insertAdjacentHTML("beforeend", html);',
          "no-restricted-properties",
        ],
        [
          COMPANY_OS_TEST,
          'createElement("div", { dangerouslySetInnerHTML: { __html: h } });',
          "no-restricted-syntax",
        ],
        [
          COMPANY_OS_TEST,
          'import { useGetList } from "ra-core";',
          "no-restricted-imports",
        ],
        [
          COMPANY_OS_TEST,
          'await import("@/components/atomic-crm/root/CRM");',
          "no-restricted-syntax",
        ],
        [
          COMPANY_OS_TEST,
          'import { persistQueryClient } from "@tanstack/react-query-persist-client";',
          "no-restricted-imports",
        ],
        [
          COMPANY_OS_TEST,
          "const X = () => <div dangerouslySetInnerHTML={{ __html: h }} />;",
          "no-restricted-syntax",
        ],
        [
          COMPANY_OS_TEST,
          'import { useSavedQueries } from "@/hooks/saved-queries";',
          "no-restricted-imports",
        ],
        [
          COMPANY_OS_TEST,
          'import { createSupabaseSessionPort } from "../../companyOsSession";',
          "no-restricted-imports",
        ],
      ]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "leaves a module file that keeps to its ports clean",
    async () => {
      const eslint = new ESLint({ cwd: ROOT });
      const clean = [
        'import { useQuery } from "@tanstack/react-query";',
        'import { lazy, useEffect } from "react";',
        'import { NavLink, createHashRouter } from "react-router";',
        'import { RouterProvider } from "react-router/dom";',
        'import { Button } from "@/components/ui/button";',
        'import { Badge } from "../../components/ui/badge";',
        'import { cn } from "@/lib/utils";',
        'import { parseOperationResult } from "../../../contracts/company-os-api/index.ts";',
        'import type { SessionPort } from "../ports";',
        'import { Note } from "../components/display";',
        'import { AppLink } from "./AppLink";',
        'const Screen = lazy(() => import("../screens/placeholders"));',
        "export const Example = ({ session }: { session: SessionPort }) => {",
        '  useEffect(() => { window.addEventListener("popstate", () => history.back()); }, []);',
        '  const query = useQuery({ queryKey: ["k"], queryFn: () => session.currentUser() });',
        "  void parseOperationResult; void createHashRouter; void RouterProvider; void Screen; void Badge; void Note; void AppLink;",
        '  return <NavLink to="/company-os" className={cn("a")}><Button>{String(query.data)}</Button></NavLink>;',
        "};",
      ].join("\n");
      const messages = await lint(eslint, COMPANY_OS_FILE, clean);
      expect(messages.filter((m) => m.severity === 2)).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );
});

describe("the CRM and the rest of the SPA stay apart from the Company OS and the engine", () => {
  it(
    "refuses a CRM import of the Company OS, statically or at run time, and keeps the CRM's own bans",
    async () => {
      const crm = "src/components/atomic-crm/root/Example.tsx";
      await expectEachRefusedBy([
        [
          crm,
          'import CompanyOsApp from "@/company-os/CompanyOsApp";',
          "no-restricted-imports",
        ],
        [
          crm,
          'import type { SessionPort } from "../../../company-os/ports";',
          "no-restricted-imports",
        ],
        [
          crm,
          'await import("../../../company-os/CompanyOsApp");',
          "no-restricted-syntax",
        ],
        [
          crm,
          'import { persistQueryClient } from "@tanstack/react-query-persist-client";',
          "no-restricted-imports",
        ],
        [
          crm,
          'import { x } from "../../../../engine/domain/agentRuns.ts";',
          "no-restricted-imports",
        ],
      ]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "refuses an engine import anywhere in src or demo, and keeps the persister ban there",
    async () => {
      await expectEachRefusedBy([
        [
          "src/lib/example.ts",
          'import { x } from "../../engine/domain/agentRuns.ts";',
          "no-restricted-imports",
        ],
        [
          "src/lib/example.ts",
          'await import("../../engine/db/workerDatabase.ts");',
          "no-restricted-syntax",
        ],
        [
          "demo/example.tsx",
          'import { x } from "../engine/worker/job.ts";',
          "no-restricted-imports",
        ],
        [
          "demo/example.tsx",
          'import { persistQueryClient } from "@tanstack/react-query-persist-client";',
          "no-restricted-imports",
        ],
        [
          "src/lib/example.ts",
          'import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";',
          "no-restricted-imports",
        ],
      ]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "lets the application shell import both sides",
    async () => {
      const eslint = new ESLint({ cwd: ROOT });
      expect(
        await boundaryRulesHit(
          eslint,
          "src/App.tsx",
          [
            'import { CRM } from "@/components/atomic-crm/root/CRM";',
            'import { SurfaceSwitch } from "./company-os/surface/SurfaceSwitch";',
            'const CompanyOsApp = lazy(() => import("./company-os/CompanyOsApp"));',
          ].join("\n"),
        ),
      ).toEqual([]);
      expect(
        await boundaryRulesHit(
          eslint,
          "src/companyOsSession.ts",
          [
            'import type { SupabaseClient } from "@supabase/supabase-js";',
            'import { getAuthProvider } from "@/components/atomic-crm/providers/supabase/authProvider";',
            'import type { SessionPort } from "./company-os/ports";',
          ].join("\n"),
        ),
      ).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "keeps browser storage, raw HTML, the engine and a persister out of the application shell that every Company OS answer passes through",
    async () => {
      const cases = [
        [
          'sessionStorage.setItem("company-os", JSON.stringify(data));',
          "no-restricted-globals",
        ],
        ['localStorage.setItem("k", "v");', "no-restricted-globals"],
        ['indexedDB.open("db");', "no-restricted-globals"],
        ['caches.open("c");', "no-restricted-globals"],
        ['window.localStorage.setItem("k", "v");', "no-restricted-properties"],
        ['document.cookie = "k=v";', "no-restricted-properties"],
        ["element.innerHTML = html;", "no-restricted-properties"],
        ['window["sessionStorage"].clear();', "no-restricted-properties"],
        ["window[name].clear();", "no-restricted-syntax"],
        [
          'createElement("div", { dangerouslySetInnerHTML: { __html: html } });',
          "no-restricted-syntax",
        ],
        [
          'import { persistQueryClient } from "@tanstack/react-query-persist-client";',
          "no-restricted-imports",
        ],
        [
          'import { x } from "../engine/domain/agentRuns.ts";',
          "no-restricted-imports",
        ],
        [
          'await import("../engine/db/workerDatabase.ts");',
          "no-restricted-syntax",
        ],
      ] as const;
      await expectEachRefusedBy(
        ["src/App.tsx", "src/companyOsSession.ts"].flatMap((file) =>
          cases.map(([code, rule]) => [file, code, rule] as const),
        ),
      );
    },
    LINT_TIMEOUT_MS,
  );
});
