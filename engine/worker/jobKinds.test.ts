// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { AGENT_RUN_EXECUTE_KIND } from "../handlers/agentRunExecute.ts";
import { DECISION_SHADOW_EVALUATE_KIND } from "../handlers/decisionShadowEvaluate.ts";
import { POSTMARK_LEDGER_RETENTION_KIND } from "../handlers/postmarkLedgerRetention.ts";
import { createModelRouter } from "../models/router.ts";
import {
  createRegistry,
  type AnyHandlerDefinition,
  type ExternalCallHandlerDefinition,
} from "./handlerRegistry.ts";
import {
  assertRegistryClassified,
  EXTERNAL_JOB_KINDS,
  INTERNAL_JOB_KINDS,
} from "./jobKinds.ts";
import { createHandlerRegistry, REGISTERED_HANDLER_KINDS } from "./registry.ts";

// The classification the kill switch relies on (ADR 0017 §6): an external kind
// is held by a stop and must be an external_call handler; an internal kind is
// never held and must be transactional. The driver-backed mirror of
// ops.external_job_kinds() and ops.internal_job_kinds() lives with the database
// tests; this file holds the worker's half.

const transactional = (kind: string): AnyHandlerDefinition => ({
  kind,
  capabilities: [],
  run: async () => "ok",
});

const external = (kind: string): ExternalCallHandlerDefinition => ({
  kind,
  shape: "external_call",
  prepareCapabilities: [],
  settleCapabilities: [],
  prepare: async () => ({ kind: "settled", detail: "nothing to call" }),
  call: async () => null,
  settle: async () => "settled",
});

const emptyRouter = () =>
  createModelRouter({ routes: new Map(), providers: new Map() });

const refusalOf = (definitions: readonly AnyHandlerDefinition[]): string => {
  try {
    assertRegistryClassified(createRegistry(definitions));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the registry to be refused");
};

describe("the worker's registry classifies every job kind for the kill switch", () => {
  it("accepts the real registry, whose kinds are exactly the classified ones", () => {
    const registry = createHandlerRegistry({ modelRouter: emptyRouter() });
    expect(() => assertRegistryClassified(registry)).not.toThrow();
    expect([...registry.keys()].sort()).toEqual(
      [...EXTERNAL_JOB_KINDS, ...INTERNAL_JOB_KINDS].sort(),
    );
    expect([...REGISTERED_HANDLER_KINDS].sort()).toEqual(
      [...EXTERNAL_JOB_KINDS, ...INTERNAL_JOB_KINDS].sort(),
    );
  });

  it("names exactly the handlers' own kind constants in each list", () => {
    expect([...EXTERNAL_JOB_KINDS]).toEqual([
      AGENT_RUN_EXECUTE_KIND,
      DECISION_SHADOW_EVALUATE_KIND,
    ]);
    expect([...INTERNAL_JOB_KINDS]).toEqual([POSTMARK_LEDGER_RETENTION_KIND]);
  });

  it("keeps the two lists disjoint and frozen", () => {
    expect(
      EXTERNAL_JOB_KINDS.filter((kind) => INTERNAL_JOB_KINDS.includes(kind)),
    ).toEqual([]);
    expect(Object.isFrozen(EXTERNAL_JOB_KINDS)).toBe(true);
    expect(Object.isFrozen(INTERNAL_JOB_KINDS)).toBe(true);
  });

  it("refuses a registered kind that is in neither list, naming only the kind", () => {
    const message = refusalOf([
      external(AGENT_RUN_EXECUTE_KIND),
      transactional("crm.unclassified_sync"),
    ]);
    expect(message).toBe(
      'job kind "crm.unclassified_sync" must be classified as exactly one of external or internal',
    );
  });

  it("refuses an external kind registered as a transactional handler, which the stop check would never hold before a call", () => {
    const message = refusalOf([transactional(AGENT_RUN_EXECUTE_KIND)]);
    expect(message).toBe(
      `job kind "${AGENT_RUN_EXECUTE_KIND}" is external, so its handler must be an external_call handler`,
    );
  });

  it("refuses an internal kind registered as an external_call handler, which no stop would ever hold", () => {
    const message = refusalOf([external(POSTMARK_LEDGER_RETENTION_KIND)]);
    expect(message).toBe(
      `job kind "${POSTMARK_LEDGER_RETENTION_KIND}" is internal, so its handler must be a transactional handler`,
    );
  });

  it("refuses to build the worker's own registry when a handler it registers has the wrong shape for its kind", async () => {
    // Arrange: the worker's registry list, with the agent run handler swapped
    // for a transactional one of the same kind, which no stop check would hold.
    vi.resetModules();
    vi.doMock("../handlers/agentRunExecute.ts", async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      createAgentRunExecuteHandler: () => transactional(AGENT_RUN_EXECUTE_KIND),
    }));
    try {
      const { createHandlerRegistry: buildWorkerRegistry } = await import(
        "./registry.ts"
      );

      // Act / Assert
      expect(() => buildWorkerRegistry({ modelRouter: emptyRouter() })).toThrow(
        `job kind "${AGENT_RUN_EXECUTE_KIND}" is external, so its handler must be an external_call handler`,
      );
    } finally {
      vi.doUnmock("../handlers/agentRunExecute.ts");
      vi.resetModules();
    }
  });

  it("accepts a registry that registers only some of the classified kinds", () => {
    expect(() =>
      assertRegistryClassified(
        createRegistry([transactional(POSTMARK_LEDGER_RETENTION_KIND)]),
      ),
    ).not.toThrow();
    expect(() => assertRegistryClassified(createRegistry([]))).not.toThrow();
  });
});
