// @vitest-environment node
// The contracts as a minimisation tripwire (docs/PHASE_2C_BRIEF.md §6.2, §9,
// §13 item 2; SI-56).
//
// Every response schema is strict, so a field the brief keeps out of the
// browser (a body, a reply draft, a raw actor label, an email, an execution
// internal) cannot arrive silently: a projection that grew one would fail to
// parse and render an error instead of the value. This file proves that for
// EVERY object node of EVERY response, not only at the top level, and proves
// no schema declares such a key in the first place.
//
// The refinements that restate the projections' own semantics (truthful
// working state, cursors that name the last item, money the server formatted,
// facts allowed by the event's type) are exercised here too. What the real
// projections emit is companyOsContracts.dbtest.ts's subject.

import { describe, expect, it } from "vitest";
import * as contracts from "../../contracts/company-os-api/index.ts";
import {
  CONTRACT_SAMPLES,
  EVENT,
  RUN,
} from "./testSupport/companyOsContractSamples.ts";

const {
  COMPANY_OS_OPERATIONS,
  COMPANY_OS_OPERATION_NAMES,
  CompanyOsContractError,
  CompanyOsInputError,
  UNDECLARED_KEY_SEGMENT,
  parseOperationInput,
  parseOperationResult,
} = contracts;
type CompanyOsOperation = contracts.CompanyOsOperation;

/**
 * Keys no response may carry, at any depth (§13 item 2): bodies, results and
 * drafts; numbers and message identity; execution internals and global
 * sequence values; raw actor labels and a principal's display name; emails,
 * email hashes and session material. `role` is absent on purpose: it is the
 * operator context's membership role, and every other object refuses it by
 * strictness (checked below).
 */
const FORBIDDEN_KEYS = [
  "title",
  "description",
  "body",
  "result",
  "proposed",
  "prompt",
  "response_draft",
  "responseDraft",
  "draft",
  "input_fingerprint",
  "inputFingerprint",
  "contact_ref",
  "contactRef",
  "phone",
  "recipient",
  "to",
  "from",
  "external_message_id",
  "externalMessageId",
  "body_fingerprint",
  "bodyFingerprint",
  "crm_contact_ref",
  "crmContactRef",
  "conversation_id",
  "conversationId",
  "provider_target",
  "providerTarget",
  "last_error",
  "lastError",
  "lease_owner",
  "leaseOwner",
  "payload",
  "detail",
  "worker_id",
  "workerId",
  "correlation_id",
  "correlationId",
  "idempotency_key",
  "idempotencyKey",
  "request_fingerprint",
  "requestFingerprint",
  "provider_request_id",
  "providerRequestId",
  "provider_response_id",
  "providerResponseId",
  "provider_message_id",
  "providerMessageId",
  "authorized_check",
  "authorizedCheck",
  "send_check",
  "sendCheck",
  "seq",
  "job_event_id",
  "jobEventId",
  "price_id",
  "priceId",
  "tenant_id",
  "tenantId",
  "reviewer",
  "requested_by",
  "requestedBy",
  "tripped_by",
  "trippedBy",
  "cleared_by",
  "clearedBy",
  "marked_by",
  "markedBy",
  "configured_by",
  "configuredBy",
  "set_by",
  "setBy",
  "ended_by",
  "endedBy",
  "recorded_by",
  "recordedBy",
  "granted_by",
  "grantedBy",
  "revoked_by",
  "revokedBy",
  "display_name",
  "displayName",
  "membership",
  "membership_id",
  "membershipId",
  "grant_reason",
  "grantReason",
  "revoke_reason",
  "revokeReason",
  "email",
  "email_at_grant_sha256",
  "emailAtGrantSha256",
  "emailHash",
  "claims",
  "sub",
  "session_id",
  "sessionId",
  "access_token",
  "accessToken",
  "token",
  "secret",
] as const;

const SENTINEL = "SENTINEL-FORBIDDEN person@example.test";

type Path = readonly (string | number)[];

/** Every plain-object node of a sample, by path. */
const objectPaths = (value: unknown, path: Path = []): Path[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => objectPaths(item, [...path, index]));
  }
  if (value === null || typeof value !== "object") return [];
  return [
    path,
    ...Object.entries(value).flatMap(([key, child]) =>
      objectPaths(child, [...path, key]),
    ),
  ];
};

const withKeyAt = (
  sample: unknown,
  path: Path,
  key: string,
  value: unknown = SENTINEL,
): Record<string, unknown> => {
  const copy = structuredClone(sample) as Record<string, unknown>;
  const node = path.reduce<unknown>(
    (at, step) => (at as Record<string | number, unknown>)[step],
    copy,
  ) as Record<string, unknown>;
  node[key] = value;
  return copy;
};

const responseOf = (operation: CompanyOsOperation) =>
  COMPANY_OS_OPERATIONS[operation].response;

const parses = (operation: CompanyOsOperation, value: unknown): boolean =>
  responseOf(operation).safeParse(value).success;

/**
 * The records keyed by a reason code: counts per snake_case code, the only
 * object nodes whose keys are data rather than fields. Every other object is
 * strict, or a record keyed by a closed vocabulary.
 */
const REASON_RECORDS = [
  "communication_status inbound.refusedTodayByReason",
  "communication_status outbound.blockedByReason",
];

/** A node takes a new reason-code key with a count only if it is such a record. */
const isReasonRecord = (
  operation: CompanyOsOperation,
  sample: unknown,
  path: Path,
): boolean => parses(operation, withKeyAt(sample, path, "cos_probe_reason", 0));

describe("every response parses as the projections build it", () => {
  it.each(COMPANY_OS_OPERATION_NAMES)("%s", (operation) => {
    const samples = CONTRACT_SAMPLES[operation];
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      const result = responseOf(operation).safeParse(sample);
      expect(result.error?.issues ?? []).toEqual([]);
    }
  });
});

describe("no response accepts a forbidden key, at any depth", () => {
  it.each(COMPANY_OS_OPERATION_NAMES)("%s", (operation) => {
    for (const sample of CONTRACT_SAMPLES[operation]) {
      const paths = objectPaths(sample);
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        // A reason-code record's keys are data, not fields: the next test.
        if (isReasonRecord(operation, sample, path)) continue;
        for (const key of FORBIDDEN_KEYS) {
          // Refused whatever the value, a count included, so strictness (or
          // a closed key vocabulary) is what refuses it, not the value's type.
          for (const value of [SENTINEL, 0]) {
            expect(
              parses(operation, withKeyAt(sample, path, key, value)),
              `${operation} ${path.join(".")}.${key} = ${JSON.stringify(value)}`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it("keys a reason record by snake_case reason codes, each holding a count, and nothing else", () => {
    const found = COMPANY_OS_OPERATION_NAMES.flatMap((operation) =>
      CONTRACT_SAMPLES[operation].flatMap((sample) =>
        objectPaths(sample)
          .filter((path) => isReasonRecord(operation, sample, path))
          .map((path) => ({ operation, sample, path })),
      ),
    );
    // A new record keyed by open data is a reviewed change to this list.
    expect([
      ...new Set(found.map((f) => `${f.operation} ${f.path.join(".")}`)),
    ]).toEqual(REASON_RECORDS);
    for (const { operation, sample, path } of found) {
      const where = `${operation} ${path.join(".")}`;
      for (const key of [...FORBIDDEN_KEYS, "person@example.test"]) {
        // Never a value other than a count, under any key.
        expect(
          parses(operation, withKeyAt(sample, path, key, SENTINEL)),
          where + "." + key,
        ).toBe(false);
        // A count is taken under a key only when the key is a reason code:
        // the SQL takes these keys from codes that its own filter or check
        // constraint bounds with the same pattern. Such a key is a code by
        // format (`email`, `title`), never a field, and a contract error
        // never repeats it.
        expect(
          parses(operation, withKeyAt(sample, path, key, 1)),
          where + "." + key + " = 1",
        ).toBe(contracts.ReasonCodeSchema.safeParse(key).success);
      }
    }
  });

  it("refuses an agent's role or description, the configuration free text", () => {
    const [detail] = CONTRACT_SAMPLES.get_agent;
    for (const key of ["role", "description"]) {
      expect(
        responseOf("get_agent").safeParse(withKeyAt(detail, ["agent"], key))
          .success,
        key,
      ).toBe(false);
    }
  });

  it("never lets a reply draft through the advice, in either branch", () => {
    for (const sample of CONTRACT_SAMPLES.get_review_advice) {
      for (const key of ["response_draft", "responseDraft", "draft"]) {
        const leaked = { ...sample, [key]: "SENTINEL-DRAFT" };
        expect(responseOf("get_review_advice").safeParse(leaked).success).toBe(
          false,
        );
        // The typed error says where the response broke, never what it held.
        let thrown: unknown;
        try {
          parseOperationResult("get_review_advice", leaked);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(CompanyOsContractError);
        const error = thrown as InstanceType<typeof CompanyOsContractError>;
        expect(
          JSON.stringify({ message: error.message, issues: error.issues }),
        ).not.toContain("SENTINEL-DRAFT");
      }
    }
  });

  it("refuses advice carrying the stored body, a number or the task text", () => {
    const [advice] = CONTRACT_SAMPLES.get_review_advice;
    for (const key of [
      "body",
      "contactRef",
      "description",
      "title",
      "result",
    ]) {
      expect(
        responseOf("get_review_advice").safeParse({ ...advice, [key]: "x" })
          .success,
        key,
      ).toBe(false);
    }
  });
});

describe("a contract error keeps where a response broke, never what it held", () => {
  const brokenBy = (operation: CompanyOsOperation, value: unknown) => {
    let thrown: unknown;
    try {
      parseOperationResult(operation, value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, operation).toBeInstanceOf(CompanyOsContractError);
    const error = thrown as InstanceType<typeof CompanyOsContractError>;
    return {
      issues: error.issues,
      text: JSON.stringify({ message: error.message, issues: error.issues }),
    };
  };

  /** The operation's first sample, with `key` of the node at `path` set to `value`. */
  const patched = (
    operation: CompanyOsOperation,
    path: Path,
    key: string,
    value: unknown,
  ) => withKeyAt(CONTRACT_SAMPLES[operation][0], path, key, value);

  it("never repeats a record's key, which is data, whether the key or its count broke", () => {
    const badReason = brokenBy(
      "communication_status",
      patched("communication_status", ["inbound"], "refusedTodayByReason", {
        "person@example.test": 1,
      }),
    );
    expect(badReason.issues).toEqual([
      {
        path: ["inbound", "refusedTodayByReason", UNDECLARED_KEY_SEGMENT],
        code: "invalid_key",
      },
    ]);
    expect(badReason.text).not.toContain("example.test");

    const badCount = brokenBy(
      "communication_status",
      patched("communication_status", ["outbound"], "blockedByReason", {
        cos_sentinel_reason: "SENTINEL",
      }),
    );
    expect(badCount.issues).toEqual([
      {
        path: ["outbound", "blockedByReason", UNDECLARED_KEY_SEGMENT],
        code: "invalid_type",
      },
    ]);
    expect(badCount.text).not.toMatch(/cos_sentinel_reason|SENTINEL/);

    const badStatus = brokenBy(
      "overview",
      patched("overview", ["runs"], "todayByStatus", {
        "person@example.test": 1,
      }),
    );
    expect(badStatus.issues).toEqual([
      {
        path: ["runs", "todayByStatus", UNDECLARED_KEY_SEGMENT],
        code: "invalid_key",
      },
    ]);
    expect(badStatus.text).not.toContain("example.test");
  });

  it("keeps the keys the contract declares and array positions, through a union", () => {
    expect(
      brokenBy(
        "list_agents",
        patched("list_agents", ["items", 0, "evidence"], "workingRunIds", [
          "SENTINEL-NOT-A-UUID",
        ]),
      ).issues,
    ).toEqual([
      {
        path: ["items", 0, "evidence", "workingRunIds", 0],
        code: "invalid_format",
      },
    ]);
    // The advice is a union of the pinned advice and the withheld answer.
    expect(
      brokenBy(
        "get_review_advice",
        patched("get_review_advice", [], "summary", ""),
      ).issues,
    ).toEqual([{ path: ["summary"], code: "too_small" }]);
  });

  it("names neither an unrecognized key nor its value, in a response or an input", () => {
    const extra = brokenBy(
      "list_stops",
      patched("list_stops", ["items", 0], "person@example.test", "SENTINEL"),
    );
    expect(extra.issues).toEqual([
      { path: ["items", 0], code: "unrecognized_keys" },
    ]);
    expect(extra.text).not.toMatch(/example\.test|SENTINEL/);

    let thrown: unknown;
    try {
      parseOperationInput("get_task", {
        p_task_id: RUN.taskId,
        "person@example.test": "SENTINEL",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CompanyOsInputError);
    const error = thrown as InstanceType<typeof CompanyOsInputError>;
    expect(error.issues).toEqual([{ path: [], code: "unrecognized_keys" }]);
    expect(
      JSON.stringify({ message: error.message, issues: error.issues }),
    ).not.toMatch(/example\.test|SENTINEL/);
  });
});

interface ZodNode {
  readonly def: {
    readonly type: string;
    readonly shape?: Record<string, ZodNode>;
    readonly element?: ZodNode;
    readonly innerType?: ZodNode;
    readonly options?: readonly ZodNode[];
    readonly valueType?: ZodNode;
    readonly in?: ZodNode;
    readonly out?: ZodNode;
  };
}

/** Every object key a schema declares, at any depth. */
const declaredKeys = (
  schema: ZodNode,
  seen: Set<ZodNode> = new Set(),
): string[] => {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const { def } = schema;
  const children: ZodNode[] = [
    ...Object.values(def.shape ?? {}),
    ...(def.options ?? []),
    ...[def.element, def.innerType, def.valueType, def.in, def.out].filter(
      (child): child is ZodNode => child !== undefined,
    ),
  ];
  return [
    ...Object.keys(def.shape ?? {}),
    ...children.flatMap((child) => declaredKeys(child, seen)),
  ];
};

describe("no schema declares a forbidden key", () => {
  it("across every response, the event facts included", () => {
    const keys = new Set(
      [
        ...COMPANY_OS_OPERATION_NAMES.map(responseOf),
        ...Object.values(contracts.EVENT_FACTS),
      ].flatMap((schema) => declaredKeys(schema as unknown as ZodNode)),
    );
    // The walk reaches nested objects, records, unions and the facts.
    for (const known of [
      "nextCursor",
      "workingRunIds",
      "recommendedNextAction",
      "outbound_message_id",
      "refusedTodayByReason",
      "companyId",
    ]) {
      expect(keys).toContain(known);
    }
    expect(FORBIDDEN_KEYS.filter((key) => keys.has(key))).toEqual([]);
  });
});

describe("the refinements restate the projections' own semantics", () => {
  const refuse = (
    operation: CompanyOsOperation,
    sample: Record<string, unknown>,
  ) => expect(responseOf(operation).safeParse(sample).success).toBe(false);

  it("reports an agent working only with a working run id (SI-57)", () => {
    const [list] = CONTRACT_SAMPLES.list_agents;
    const [agent] = list.items as Record<string, unknown>[];
    const evidence = agent.evidence as Record<string, unknown>;
    const withAgent = (patch: Record<string, unknown>) => ({
      ...list,
      items: [{ ...agent, ...patch }],
    });
    refuse(
      "list_agents",
      withAgent({ evidence: { ...evidence, workingRunIds: [] } }),
    );
    refuse("list_agents", withAgent({ activity: "idle" }));
    refuse(
      "list_agents",
      withAgent({
        availability: "stopped",
        evidence: { ...evidence, stop: null },
      }),
    );
    refuse("list_agents", withAgent({ availability: "available" }));
    refuse("list_agents", withAgent({ attentionCount: 0 }));
    expect(
      responseOf("list_agents").safeParse(
        withAgent({
          availability: "inactive",
          evidence: { ...evidence, inactiveUnit: "department" },
        }),
      ).success,
    ).toBe(true);
  });

  it("makes nextCursor name the last item and nothing else", () => {
    const [page] = CONTRACT_SAMPLES.list_tasks;
    refuse("list_tasks", { ...page, nextCursor: `tk1:${RUN.id}` });
    refuse("list_tasks", {
      ...page,
      nextCursor: `rn1:${(page.items as { id: string }[])[0].id}`,
    });
    refuse("list_tasks", { ...page, items: [], nextCursor: `tk1:${RUN.id}` });
    const [runs] = CONTRACT_SAMPLES.list_runs;
    const [run] = runs.items as { id: string }[];
    const lettered = { ...run, id: "00000000-0000-4000-8000-00000000abcd" };
    refuse("list_runs", {
      ...runs,
      items: [lettered],
      nextCursor: `rn1:${lettered.id.toUpperCase()}`,
    });
    expect(
      responseOf("list_runs").safeParse({
        ...runs,
        items: [lettered],
        nextCursor: `rn1:${lettered.id}`,
      }).success,
    ).toBe(true);
  });

  it("requires the USD string the server formatted from the micros", () => {
    expect(contracts.formatMicrosAsUsd("0")).toBe("0.000000");
    expect(contracts.formatMicrosAsUsd("5")).toBe("0.000005");
    expect(contracts.formatMicrosAsUsd("-300")).toBe("-0.000300");
    expect(contracts.formatMicrosAsUsd("1000000000000")).toBe("1000000.000000");
    expect(contracts.formatMicrosAsUsd("999999938617")).toBe("999999.938617");
    for (const money of [
      { micros: "300", usd: "0.000301" },
      { micros: "300", usd: "0.0003" },
      { micros: 300, usd: "0.000300" },
      { micros: "0300", usd: "0.000300" },
      { micros: "300", usd: "0.000300", currency: "USD" },
    ]) {
      expect(contracts.MoneySchema.safeParse(money).success).toBe(false);
    }
  });

  it("keeps each event's facts to its type's allowlist", () => {
    const parse = (event: Record<string, unknown>) =>
      contracts.EventSummarySchema.safeParse(event).success;
    expect(parse(EVENT)).toBe(true);
    expect(parse({ ...EVENT, type: "lead_triage.reviewed" })).toBe(false);
    expect(parse({ ...EVENT, facts: {} })).toBe(false);
    expect(
      parse({
        ...EVENT,
        type: "communication.outbound_indeterminate",
        facts: {
          outbound_message_id: RUN.id,
          marked_by: "person@example.test",
        },
      }),
    ).toBe(false);
    expect(
      parse({
        ...EVENT,
        type: "custom.thing_happened",
        facts: {},
        factsWithheld: false,
      }),
    ).toBe(false);
    expect(
      parse({
        ...EVENT,
        type: "custom.thing_happened",
        facts: { outbound_message_id: RUN.id },
        factsWithheld: true,
      }),
    ).toBe(false);
    expect(parse({ ...EVENT, source: "legacy-import" })).toBe(false);
    expect(parse({ ...EVENT, subjectType: null })).toBe(false);
  });

  it("gives decisions only to a pending review, never accepting a do-not-contact one", () => {
    const [decided, pending] = CONTRACT_SAMPLES.get_review;
    refuse("get_review", { ...decided, allowedDecisions: ["rejected"] });
    refuse("get_review", {
      ...pending,
      allowedDecisions: ["accepted", "rejected"],
    });
    refuse("get_review", { ...decided, hasNote: false });
    refuse("get_review", {
      ...pending,
      allowedDecisions: ["rejected", "rejected"],
    });
  });

  it("takes a decision note as stored, the empty one included, up to 1000 characters", () => {
    const [decided] = CONTRACT_SAMPLES.get_review;
    expect(
      responseOf("get_review").safeParse({ ...decided, decisionNote: "" })
        .success,
    ).toBe(true);
    expect(
      responseOf("get_review").safeParse({
        ...decided,
        decisionNote: "\u{1F600}".repeat(1000),
      }).success,
    ).toBe(true);
    refuse("get_review", { ...decided, decisionNote: "x".repeat(1001) });
  });

  it("ties a run's attention to its status", () => {
    refuse("get_run", {
      ...CONTRACT_SAMPLES.get_run[0],
      attention: "running_without_live_lease",
    });
  });

  it("ties a stop's target and job kind to its scope", () => {
    const [page] = CONTRACT_SAMPLES.list_stops;
    const [stop] = page.items as Record<string, unknown>[];
    const withStop = (patch: Record<string, unknown>) => ({
      ...page,
      items: [{ ...stop, ...patch }],
    });
    refuse("list_stops", withStop({ scope: "tenant" }));
    refuse("list_stops", withStop({ scope: "global", target: null }));
    refuse("list_stops", withStop({ jobKind: "agent_run.execute" }));
    refuse("list_stops", withStop({ clearedReason: null }));
  });
});
