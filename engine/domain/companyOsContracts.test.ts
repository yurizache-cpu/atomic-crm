// @vitest-environment node
// The operator API contracts (contracts/company-os-api): their vocabulary, their
// operation catalogue, their error vocabulary and their import boundary.
//
// A contract may import only zod, so it DUPLICATES the vocabularies the engine
// already pins to SQL. This file is where the copies meet the originals: each
// list must EQUAL its engine counterpart, so a status added to the engine and
// forgotten in the contract (or the reverse) fails here, before any screen
// renders it. Every other vocabulary, those with no engine counterpart
// included, is compared with the live database in
// companyOsContractVocabulary.dbtest.ts; TENANT_STOP_SCOPES is derived from
// EXECUTION_STOP_SCOPES here.
//
// It lives in engine/domain because a test importing the engine's vocabularies
// runs in the `functions` project; the contracts themselves may not import
// anything but zod (eslint.config.js), which the last block checks.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import * as contracts from "../../contracts/company-os-api/index.ts";
import * as leadTriage from "../models/leadTriage.ts";
import { MODEL_ERROR_CATEGORIES } from "../models/errors.ts";
import { FAILURE_CLASSES } from "../worker/failures.ts";
import { AGENT_RUN_STATUSES } from "./agentRunStateMachine.ts";
import { CHANNEL_MODES } from "./communicationChannels.ts";
import { EXECUTION_STOP_SCOPES } from "./executionStops.ts";
import { formatMicrosAsUsd } from "./money.ts";
import { OUTBOUND_STATUSES } from "./outboundMessages.ts";
import { REVIEW_DECISIONS, REVIEW_STATUSES } from "./reviewQueue.ts";
import { NEW_RUN_ADMISSIONS, SPEND_LIMIT_SCOPES } from "./spendLimits.ts";
import { TASK_STATUSES } from "./taskStateMachine.ts";
import { CONTRACT_SAMPLES } from "./testSupport/companyOsContractSamples.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const {
  COMPANY_OS_OPERATIONS,
  COMPANY_OS_OPERATION_NAMES,
  CompanyOsApiError,
  CompanyOsContractError,
  CompanyOsInputError,
  OS_ERROR_CODES,
  SELECTOR_ARGUMENTS,
  parseOperationInput,
  toCompanyOsApiError,
  withoutDefaultArguments,
} = contracts;
type CompanyOsOperation = contracts.CompanyOsOperation;

describe("the contract vocabularies equal the engine's", () => {
  it.each([
    ["TASK_STATUSES", contracts.TASK_STATUSES, TASK_STATUSES],
    ["AGENT_RUN_STATUSES", contracts.AGENT_RUN_STATUSES, AGENT_RUN_STATUSES],
    ["REVIEW_STATUSES", contracts.REVIEW_STATUSES, REVIEW_STATUSES],
    ["REVIEW_DECISIONS", contracts.REVIEW_DECISIONS, REVIEW_DECISIONS],
    ["OUTBOUND_STATUSES", contracts.OUTBOUND_STATUSES, OUTBOUND_STATUSES],
    [
      "EXECUTION_STOP_SCOPES",
      contracts.EXECUTION_STOP_SCOPES,
      EXECUTION_STOP_SCOPES,
    ],
    ["CHANNEL_MODES", contracts.CHANNEL_MODES, CHANNEL_MODES],
    ["SPEND_ADMISSIONS", contracts.SPEND_ADMISSIONS, NEW_RUN_ADMISSIONS],
    ["JOB_FAILURE_CLASSES", contracts.JOB_FAILURE_CLASSES, FAILURE_CLASSES],
    [
      "LEAD_TRIAGE_OUTCOMES",
      contracts.LEAD_TRIAGE_OUTCOMES,
      leadTriage.LEAD_TRIAGE_OUTCOMES,
    ],
    [
      "LEAD_TRIAGE_INTENTS",
      contracts.LEAD_TRIAGE_INTENTS,
      leadTriage.LEAD_TRIAGE_INTENTS,
    ],
    [
      "LEAD_TRIAGE_PRIORITIES",
      contracts.LEAD_TRIAGE_PRIORITIES,
      leadTriage.LEAD_TRIAGE_PRIORITIES,
    ],
    [
      "LEAD_TRIAGE_FLAGS",
      contracts.LEAD_TRIAGE_FLAGS,
      leadTriage.LEAD_TRIAGE_FLAGS,
    ],
  ])("%s", (_name, contract, engine) => {
    expect([...contract]).toEqual([...engine]);
  });

  it("bounds the advice exactly as the lead_triage output contract does", () => {
    expect(leadTriage.LEAD_TRIAGE_CAPABILITY).toBe("lead_triage");
    expect(contracts.TRIAGE_SUMMARY_MAX_LENGTH).toBe(
      leadTriage.TRIAGE_SUMMARY_MAX_LENGTH,
    );
    expect(contracts.NEXT_ACTION_MAX_LENGTH).toBe(
      leadTriage.NEXT_ACTION_MAX_LENGTH,
    );
    expect(contracts.MAX_TRIAGE_FLAGS).toBe(leadTriage.MAX_TRIAGE_FLAGS);
  });

  it("records every model error category, plus exactly the three the runtime adds", () => {
    const extra = contracts.AGENT_RUN_ERROR_CATEGORIES.filter(
      (category) =>
        !(MODEL_ERROR_CATEGORIES as readonly string[]).includes(category),
    );
    expect(extra).toEqual(["job_failed", "interrupted", "refused"]);
    for (const category of MODEL_ERROR_CATEGORIES) {
      expect(contracts.AGENT_RUN_ERROR_CATEGORIES).toContain(category);
    }
  });

  it("names a tenant stop by every scope but global", () => {
    expect([...contracts.TENANT_STOP_SCOPES]).toEqual(
      EXECUTION_STOP_SCOPES.filter((scope) => scope !== "global"),
    );
  });

  it("names a tenant's own spend row by every limit scope but global", () => {
    expect([...contracts.TENANT_LIMIT_SCOPES]).toEqual(
      SPEND_LIMIT_SCOPES.filter((scope) => scope !== "global"),
    );
    // The overview adds the one state of a tenant with no budget row.
    expect([...contracts.TENANT_ADMISSIONS]).toEqual([
      ...NEW_RUN_ADMISSIONS,
      "unconfigured",
    ]);
  });

  it("checks money against the engine's own USD formatting", () => {
    for (const micros of [
      "0",
      "1",
      "300",
      "-300",
      "999999",
      "1000000",
      "30545",
      "-1000000000000000",
      "9223372036854775807",
      "-9223372036854775808",
    ]) {
      expect(contracts.formatMicrosAsUsd(micros), micros).toBe(
        formatMicrosAsUsd(micros),
      );
    }
  });
});

/**
 * The catalogue as brief §8 and the S2 migration define it: names, argument
 * names, types and DEFAULTs (`= value`). companyOsContracts.dbtest.ts compares
 * the same catalogue with pg_proc; this literal makes any change to it a
 * reviewed diff.
 */
const PINNED_CATALOGUE: Readonly<
  Record<CompanyOsOperation, readonly string[]>
> = {
  operator_context: [],
  overview: [],
  list_agents: [],
  get_agent: ["p_agent_id uuid"],
  list_tasks: [
    "p_cursor text = null",
    "p_status text = null",
    "p_agent_id uuid = null",
    "p_limit integer = 50",
  ],
  get_task: ["p_task_id uuid"],
  list_runs: [
    "p_cursor text = null",
    "p_status text = null",
    "p_agent_id uuid = null",
    "p_attention_only boolean = false",
    "p_limit integer = 50",
  ],
  get_run: ["p_run_id uuid"],
  list_reviews: [
    "p_cursor text = null",
    'p_status text = "pending"',
    "p_limit integer = 50",
  ],
  get_review: ["p_review_id uuid"],
  get_review_advice: ["p_review_id uuid"],
  list_events: [
    "p_cursor text = null",
    "p_subject_type text = null",
    "p_subject_id uuid = null",
    "p_limit integer = 50",
  ],
  list_stops: [
    "p_include_cleared boolean = false",
    "p_cursor text = null",
    "p_limit integer = 50",
  ],
  spend_summary: [],
  communication_status: [],
};

const pinnedForm = (arg: contracts.OperationArgument): string =>
  arg.optional
    ? `${arg.name} ${arg.type} = ${JSON.stringify(arg.defaultValue)}`
    : `${arg.name} ${arg.type}`;

interface InputField {
  safeParse(value: unknown): { success: boolean };
}

const inputShape = (
  operation: CompanyOsOperation,
): Readonly<Record<string, InputField>> =>
  (
    COMPANY_OS_OPERATIONS[operation].input as unknown as {
      def: { shape: Record<string, InputField> };
    }
  ).def.shape;

const inputKeys = (operation: CompanyOsOperation): string[] =>
  Object.keys(inputShape(operation));

describe("the operation catalogue", () => {
  it("is exactly the 15 read operations, with their pinned arguments", () => {
    expect(COMPANY_OS_OPERATION_NAMES).toHaveLength(15);
    const catalogue = Object.fromEntries(
      COMPANY_OS_OPERATION_NAMES.map((name) => [
        name,
        COMPANY_OS_OPERATIONS[name].args.map(pinnedForm),
      ]),
    );
    expect(catalogue).toEqual(PINNED_CATALOGUE);
  });

  it("gives a required argument no default, and puts every defaulted one last", () => {
    for (const name of COMPANY_OS_OPERATION_NAMES) {
      const { args } = COMPANY_OS_OPERATIONS[name];
      for (const arg of args.filter((a) => !a.optional)) {
        expect(arg.defaultValue, `${name}.${arg.name}`).toBeNull();
      }
      const firstOptional = args.findIndex((arg) => arg.optional);
      if (firstOptional >= 0) {
        expect(
          args.slice(firstOptional).every((arg) => arg.optional),
          name,
        ).toBe(true);
      }
    }
  });

  it("offers neither browser act, nor a clear, a send or a configure", () => {
    expect(
      COMPANY_OS_OPERATION_NAMES.filter((name) =>
        /decide|trip|clear|send|configure|grant|revoke|retry|mark/.test(name),
      ),
    ).toEqual([]);
  });

  it("takes no tenant, company, actor, reviewer, source or causation argument, and names every uuid a selector", () => {
    for (const name of COMPANY_OS_OPERATION_NAMES) {
      for (const arg of COMPANY_OS_OPERATIONS[name].args) {
        expect(arg.name, `${name}.${arg.name}`).not.toMatch(
          /^p_(tenant|company|actor$|reviewer$|source$|causation)/,
        );
        if (arg.type === "uuid") {
          expect(SELECTOR_ARGUMENTS, `${name}.${arg.name}`).toContain(arg.name);
        }
      }
    }
  });

  it("accepts as input exactly the arguments the function takes, optional exactly where it has a default", () => {
    for (const name of COMPANY_OS_OPERATION_NAMES) {
      expect(inputKeys(name), name).toEqual(
        COMPANY_OS_OPERATIONS[name].args.map((arg) => arg.name),
      );
      const shape = inputShape(name);
      for (const arg of COMPANY_OS_OPERATIONS[name].args) {
        expect(
          shape[arg.name].safeParse(undefined).success,
          `${name}.${arg.name}`,
        ).toBe(arg.optional);
      }
    }
  });

  /** An input naming every required argument (each a selector uuid). */
  const validInput = (name: CompanyOsOperation): Record<string, unknown> =>
    Object.fromEntries(
      COMPANY_OS_OPERATIONS[name].args
        .filter((arg) => !arg.optional)
        .map((arg) => {
          if (arg.type !== "uuid") {
            throw new Error(`no sample value for ${name}.${arg.name}`);
          }
          return [arg.name, "00000000-0000-4000-8000-00000000abcd"];
        }),
    );

  it("refuses a tenant, an actor or any other extra key in every input", () => {
    for (const name of COMPANY_OS_OPERATION_NAMES) {
      // The input is valid without the extra key, so the key is what fails.
      const valid = validInput(name);
      expect(parseOperationInput(name, valid), name).toEqual(valid);
      for (const extra of ["p_tenant_id", "p_actor", "tenant", "operation"]) {
        let thrown: unknown;
        try {
          parseOperationInput(name, { ...valid, [extra]: "x" });
        } catch (error) {
          thrown = error;
        }
        expect(thrown, `${name} + ${extra}`).toBeInstanceOf(
          CompanyOsInputError,
        );
        expect(thrown, `${name} + ${extra}`).not.toBeInstanceOf(
          CompanyOsContractError,
        );
        expect(
          (thrown as InstanceType<typeof CompanyOsInputError>).issues,
          `${name} + ${extra}`,
        ).toEqual([{ path: [], code: "unrecognized_keys" }]);
      }
    }
  });

  it("lets either act hint be true or false in the operator context, and names no clear", () => {
    const [context] = CONTRACT_SAMPLES.operator_context;
    const allowed = context.allowedActions as Record<string, boolean>;
    const schema = COMPANY_OS_OPERATIONS.operator_context.response;
    expect(schema.safeParse(context).success).toBe(true);
    for (const act of ["decideReview", "tripStop"]) {
      for (const value of [true, false]) {
        expect(
          schema.safeParse({
            ...context,
            allowedActions: { ...allowed, [act]: value },
          }).success,
          `${act} ${value}`,
        ).toBe(true);
      }
    }
    expect(
      schema.safeParse({
        ...context,
        allowedActions: { ...allowed, clearStop: false },
      }).success,
      "clearStop",
    ).toBe(false);
    // The advice hint is not an act: either value parses.
    expect(
      schema.safeParse({
        ...context,
        allowedActions: { ...allowed, viewAdvice: false },
      }).success,
    ).toBe(true);
  });

  it("checks selectors, cursors, enums and limits before a request leaves", () => {
    const run = "00000000-0000-4000-8000-00000000abcd";
    expect(parseOperationInput("list_tasks", {})).toEqual({});
    expect(
      parseOperationInput("list_runs", {
        p_cursor: `rn1:${run}`,
        p_status: "indeterminate",
        p_attention_only: true,
        p_limit: 100,
      }),
    ).toMatchObject({ p_limit: 100 });
    const refused: [CompanyOsOperation, Record<string, unknown>][] = [
      ["get_run", { p_run_id: "not-a-uuid" }],
      ["get_run", { p_run_id: run.toUpperCase() }],
      ["get_run", {}],
      ["list_tasks", { p_cursor: `rn1:${run}` }],
      ["list_tasks", { p_status: "done" }],
      ["list_tasks", { p_limit: 0 }],
      ["list_tasks", { p_limit: 101 }],
      ["list_reviews", { p_status: "approved" }],
      ["list_events", { p_subject_type: "task" }],
      ["list_events", { p_subject_type: "stop", p_subject_id: run }],
    ];
    for (const [name, input] of refused) {
      expect(
        () => parseOperationInput(name, input),
        `${name} ${JSON.stringify(input)}`,
      ).toThrow(CompanyOsInputError);
    }
  });

  it("says an input refusal is the request's, never a response that broke its contract", () => {
    let thrown: unknown;
    try {
      parseOperationInput("get_run", { p_run_id: "not-a-uuid" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CompanyOsInputError);
    expect(thrown).not.toBeInstanceOf(CompanyOsContractError);
    const error = thrown as InstanceType<typeof CompanyOsInputError>;
    expect(error.message).toBe(
      "company_os_api.get_run: the request broke its input contract",
    );
    expect(error.message).not.toMatch(/response|not-a-uuid/);
    expect(error.issues).toEqual([
      { path: ["p_run_id"], code: "invalid_format" },
    ]);
  });

  it("drops exactly the arguments the server reads as their DEFAULT", () => {
    const run = "00000000-0000-4000-8000-00000000abcd";
    expect(
      withoutDefaultArguments("list_runs", {
        p_status: null,
        p_agent_id: undefined,
        p_attention_only: false,
        p_limit: 50,
        p_cursor: null,
      }),
    ).toEqual({});
    expect(
      withoutDefaultArguments("list_runs", {
        p_limit: 100,
        p_attention_only: true,
        p_agent_id: run,
      }),
    ).toEqual({ p_agent_id: run, p_attention_only: true, p_limit: 100 });
    expect(
      Object.keys(
        withoutDefaultArguments("list_runs", {
          p_limit: 100,
          p_agent_id: run,
        }),
      ),
    ).toEqual(["p_agent_id", "p_limit"]);
    expect(
      withoutDefaultArguments("list_reviews", { p_status: "pending" }),
    ).toEqual({});
    expect(
      withoutDefaultArguments("list_reviews", { p_status: "accepted" }),
    ).toEqual({ p_status: "accepted" });
    expect(
      withoutDefaultArguments("list_stops", { p_include_cleared: false }),
    ).toEqual({});
    expect(withoutDefaultArguments("get_run", { p_run_id: run })).toEqual({
      p_run_id: run,
    });
  });
});

describe("the refusal vocabulary", () => {
  it("is exactly the seven codes the identity gates raise", () => {
    expect([...OS_ERROR_CODES]).toEqual([
      "OS400",
      "OS401",
      "OS403",
      "OS404",
      "OS409",
      "OS429",
      "OS500",
    ]);
  });

  it("maps a gate's code to the typed error and keeps none of the server's text", () => {
    for (const code of OS_ERROR_CODES) {
      const error = toCompanyOsApiError("get_task", {
        code,
        message: "SENTINEL-SERVER-TEXT",
        details: "SENTINEL-DETAIL",
      });
      expect(error).toBeInstanceOf(CompanyOsApiError);
      expect(error.code).toBe(code);
      expect(error.operation).toBe("get_task");
      expect(JSON.stringify({ ...error, message: error.message })).not.toMatch(
        /SENTINEL/,
      );
    }
  });

  it.each([
    // Signed out (anon), or a caller no grant reaches: no access.
    ["42501", "OS403"],
    // company_os_api unexposed, the instant rollback: no access.
    ["PGRST106", "OS403"],
    // A token PostgREST refuses, an expired session included: not signed in.
    ["PGRST301", "OS401"],
    ["PGRST302", "OS401"],
    ["PGRST303", "OS401"],
  ])(
    "answers PostgREST's %s as the refusal a screen renders, %s, with none of its text",
    (code, typed) => {
      const error = toCompanyOsApiError("operator_context", {
        code,
        message: "SENTINEL-SERVER-TEXT",
        hint: "SENTINEL-HINT",
      });
      expect(error.code).toBe(typed);
      expect(JSON.stringify({ ...error, message: error.message })).not.toMatch(
        /SENTINEL/,
      );
    },
  );

  it("answers anything outside the vocabulary as OS500", () => {
    for (const failure of [
      { code: "22P02" },
      { code: "PGRST202" },
      { code: "PGRST300" },
      { code: "57014" },
      { code: "os403" },
      { code: "pgrst106" },
      { code: "constructor" },
      { code: 42501 },
      new Error("SENTINEL"),
      null,
      "OS403",
    ]) {
      expect(toCompanyOsApiError("overview", failure).code).toBe("OS500");
    }
  });
});

describe("the contracts import zod and each other, nothing else", () => {
  const BOUNDARY_RULES = new Set([
    "no-restricted-imports",
    "no-restricted-syntax",
  ]);
  const LINT_TIMEOUT_MS = 60_000;
  const FIXTURE = "contracts/company-os-api/lintFixture";

  const boundaryRulesHit = async (
    eslint: ESLint,
    code: string,
    extension = "ts",
  ): Promise<string[]> => {
    const [result] = await eslint.lintText(code, {
      filePath: join(ROOT, FIXTURE + "." + extension),
    });
    expect(
      result.messages.filter((m) => m.fatal),
      code,
    ).toEqual([]);
    return result.messages
      .filter((m) => m.ruleId !== null && BOUNDARY_RULES.has(m.ruleId))
      .map((m) => m.ruleId as string);
  };

  it(
    "refuses the CRM, the engine, a driver, a persister and every run-time import",
    async () => {
      const eslint = new ESLint({ cwd: ROOT });
      for (const code of [
        'import { useGetList } from "ra-core";',
        'import { createClient } from "@supabase/supabase-js";',
        'import { TASK_STATUSES } from "../../engine/domain/taskStateMachine.ts";',
        'import { Pool } from "pg";',
        'import { persistQueryClient } from "@tanstack/react-query-persist-client";',
        'import React from "react";',
        'import { z } from "zod/v4";',
        'import { cn } from "@/lib/utils";',
        'import "./sub/x.ts";',
        'import "./primitives";',
        'export * from "../other/index.ts";',
        'await import("zod");',
        'type T = import("zod").ZodType;',
        'require("zod");',
        'import z = require("zod");',
      ]) {
        expect(await boundaryRulesHit(eslint, code), code).not.toEqual([]);
      }
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "holds for a contract file of any source extension, not only .ts",
    async () => {
      // The SPA and the typecheck reach these as readily as a .ts file, and a
      // .ts-only glob once left them unchecked or unlinted.
      const eslint = new ESLint({ cwd: ROOT });
      for (const extension of [
        "tsx",
        "mts",
        "cts",
        "js",
        "jsx",
        "mjs",
        "cjs",
      ]) {
        for (const code of [
          'import { Pool } from "pg";',
          'export * from "../../engine/domain/money.ts";',
          'await import("pg");',
          'require("pg");',
        ]) {
          expect(
            await boundaryRulesHit(eslint, code, extension),
            `${extension}: ${code}`,
          ).not.toEqual([]);
        }
        expect(
          await boundaryRulesHit(
            eslint,
            'import { z } from "zod";\nexport * from "./primitives.ts";',
            extension,
          ),
          extension,
        ).toEqual([]);
      }
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "leaves the SI-19 persister ban on src in force",
    async () => {
      const eslint = new ESLint({ cwd: ROOT });
      const [result] = await eslint.lintText(
        'import { persistQueryClient } from "@tanstack/react-query-persist-client";',
        { filePath: join(ROOT, "src/company-os/lintFixture.ts") },
      );
      expect(
        result.messages
          .filter((m) => m.ruleId === "no-restricted-imports")
          .map((m) => m.message),
      ).toEqual([expect.stringMatching(/SEC-1BS-01/)]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "refuses every browser, storage, network and environment global, bare or as a member, in any source extension",
    async () => {
      const eslint = new ESLint({ cwd: ROOT });
      const IO_RULES = new Set([
        "no-restricted-globals",
        "no-restricted-properties",
        "no-restricted-syntax",
      ]);
      const ioRulesHit = async (code: string, extension: string) => {
        const [result] = await eslint.lintText(code, {
          filePath: join(ROOT, FIXTURE + "." + extension),
        });
        expect(
          result.messages.filter((m) => m.fatal),
          code,
        ).toEqual([]);
        return result.messages
          .filter((m) => m.ruleId !== null && IO_RULES.has(m.ruleId))
          .map((m) => m.message);
      };
      const refused = [
        'localStorage.setItem("k", "v");',
        'sessionStorage.getItem("k");',
        'indexedDB.open("db");',
        'caches.open("c");',
        'cookieStore.get("k");',
        "document.title;",
        "document.cookie;",
        "window.name;",
        "globalThis.fetch;",
        "self.location;",
        'fetch("/rest/v1/rpc/overview");',
        "new XMLHttpRequest();",
        "navigator.userAgent;",
        'new WebSocket("ws://127.0.0.1");',
        'new EventSource("/stream");',
        'importScripts("/worker.js");',
        "process.env.ADMIN_DATABASE_URL;",
        'eval("globalThis");',
        'Function("return this")();',
        "import.meta.env.MODE;",
        "const { fetch: f } = api;",
        "value.localStorage;",
        "holder.document;",
      ];
      for (const extension of ["ts", "tsx", "js", "mjs", "cjs"]) {
        for (const code of refused) {
          const messages = await ioRulesHit(code, extension);
          expect(messages, `${extension}: ${code}`).not.toEqual([]);
          expect(messages.join("\n"), `${extension}: ${code}`).toMatch(
            /pure function of its input/,
          );
        }
      }
      // A local binding of the same name is not the global.
      expect(
        await ioRulesHit(
          "const document = { title: 1 };\nexport const title = document;",
          "ts",
        ),
      ).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "leaves zod and a sibling contract file alone",
    async () => {
      const eslint = new ESLint({ cwd: ROOT });
      for (const code of [
        'import { z } from "zod";',
        'import { UuidSchema } from "./primitives.ts";',
        'import type { CursorKind } from "./primitives.ts";',
        'export * from "./agents.ts";',
      ]) {
        expect(await boundaryRulesHit(eslint, code), code).toEqual([]);
      }
    },
    LINT_TIMEOUT_MS,
  );
});
