// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TxClient } from "../db/types.ts";
import { createSyntheticContactPolicy } from "../communication/syntheticContactPolicy.ts";
import type {
  CommunicationTarget,
  ContactPolicy,
  InboundMessage,
} from "../communication/types.ts";
import { CompanyOsError } from "./errors.ts";
import { admitInboundMessage } from "./leadIntake.ts";

// What reaches the database when a message is admitted, and what never gets
// that far. Whether the admission is idempotent is the database's answer,
// proven by the driver-backed suite.

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const COMPANY = "b0000000-0000-4000-8000-00000000000b";
const AGENT = "c0000000-0000-4000-8000-00000000000c";
const INBOUND = "d0000000-0000-4000-8000-00000000000d";
const TASK = "e0000000-0000-4000-8000-00000000000e";
const RUN = "f0000000-0000-4000-8000-00000000000f";
const CONTACT = "synthetic:+5500000000000";

const TARGET: CommunicationTarget = {
  tenantId: TENANT,
  companyId: COMPANY,
  agentId: AGENT,
};

const MESSAGE: InboundMessage = {
  sourceKind: "synthetic",
  externalMessageId: "wa-test-0001",
  contactRef: CONTACT,
  body: "Oi, queria entender como funciona a primeira consulta.",
  receivedAt: new Date("2026-09-17T12:00:00Z"),
};

/** The trusted source says this contact may be contacted. */
const ELIGIBLE = createSyntheticContactPolicy({ eligible: [CONTACT] });
/** The trusted source says this contact must not be contacted. */
const BLOCKED = createSyntheticContactPolicy({ blocked: [CONTACT] });

/** The do_not_contact position of ops.admit_inbound_message. */
const DO_NOT_CONTACT = 8;

const recorder = () => {
  const queries: { sql: string; params: readonly unknown[] }[] = [];
  const tx: TxClient = {
    async query<TRow>(sql: string, params: readonly unknown[] = []) {
      queries.push({ sql, params });
      return {
        rows: [
          {
            result: {
              inbound_message_id: INBOUND,
              task_id: TASK,
              agent_run_id: RUN,
            },
          },
        ] as TRow[],
      };
    },
  };
  return { queries, tx };
};

const admit = (
  tx: TxClient,
  message: InboundMessage = MESSAGE,
  policy: ContactPolicy = ELIGIBLE,
  target: CommunicationTarget = TARGET,
  source = "synthetic-ingress",
) => admitInboundMessage(tx, target, message, policy, source);

const refusal = async (
  target: CommunicationTarget,
  message: InboundMessage,
  source = "synthetic-ingress",
): Promise<string> => {
  const { tx } = recorder();
  try {
    await admit(tx, message, ELIGIBLE, target, source);
  } catch (error) {
    expect(error).toBeInstanceOf(CompanyOsError);
    return (error as CompanyOsError).code;
  }
  throw new Error("expected a CompanyOsError");
};

describe("admitting an inbound message", () => {
  it("calls one function and returns the work it became", async () => {
    const { queries, tx } = recorder();

    const admitted = await admit(tx);

    expect(admitted).toEqual({
      inboundMessageId: INBOUND,
      taskId: TASK,
      agentRunId: RUN,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("ops.admit_inbound_message");
    expect(queries[0].sql).toMatch(/\(\$1(, \$\d+)*\)/);
  });

  it("sends the scope from the target and everything else as bound values", async () => {
    const { queries, tx } = recorder();

    await admit(tx);

    expect(queries[0].params).toEqual([
      TENANT,
      COMPANY,
      AGENT,
      "synthetic",
      "wa-test-0001",
      CONTACT,
      MESSAGE.body,
      "synthetic-ingress",
      false,
      MESSAGE.receivedAt,
    ]);
    // Nothing of the message is spliced into the statement text.
    expect(queries[0].sql).not.toContain(TENANT);
    expect(queries[0].sql).not.toContain("wa-test-0001");
  });

  // Tenancy comes from the target, which the caller built from configuration.
  // A message carrying its own scope contributes nothing, because the call is
  // assembled from named fields.
  it("ignores a tenant smuggled onto the message", async () => {
    const { queries, tx } = recorder();
    const smuggled = {
      ...MESSAGE,
      tenantId: "99999999-9999-4999-8999-999999999999",
      companyId: "99999999-9999-4999-8999-999999999999",
    } as InboundMessage;

    await admit(tx, smuggled);

    expect(queries[0].params).not.toContain(
      "99999999-9999-4999-8999-999999999999",
    );
    expect(queries[0].params[0]).toBe(TENANT);
  });

  it.each<[string, Partial<CommunicationTarget>]>([
    ["no tenant", { tenantId: undefined as unknown as string }],
    ["a tenant that is not a uuid", { tenantId: "tenant-one" }],
    ["a company that is not a uuid", { companyId: "company" }],
    ["an agent that is not a uuid", { agentId: "agent" }],
  ])("refuses a target with %s", async (_name, overrides) => {
    expect(await refusal({ ...TARGET, ...overrides }, MESSAGE)).toBe(
      "malformed_identifier",
    );
  });

  it.each<[string, Partial<InboundMessage>]>([
    ["an empty body", { body: "   " }],
    ["a body over the ceiling", { body: "a".repeat(4001) }],
    ["a message id with a space", { externalMessageId: "wa test" }],
    ["an empty message id", { externalMessageId: "" }],
    ["a contact reference with a space", { contactRef: "a b" }],
    ["no received_at", { receivedAt: undefined as unknown as Date }],
    ["an invalid received_at", { receivedAt: new Date("nonsense") }],
  ])("refuses a message with %s", async (_name, overrides) => {
    const code = await refusal(TARGET, { ...MESSAGE, ...overrides });
    expect(["invalid_argument", "malformed_identifier"]).toContain(code);
  });

  it("refuses a malformed source before anything is sent", async () => {
    expect(await refusal(TARGET, MESSAGE, "Synthetic Ingress")).toBe(
      "invalid_argument",
    );
  });

  it("rejects its promise rather than throwing before one exists", async () => {
    const { tx } = recorder();
    const promise = admit(tx, MESSAGE, ELIGIBLE, {
      ...TARGET,
      tenantId: "nope",
    });
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).rejects.toBeInstanceOf(CompanyOsError);
  });

  it("refuses an answer that is not an admission", async () => {
    const tx: TxClient = {
      async query<TRow>() {
        return { rows: [{ result: { task_id: TASK } }] as TRow[] };
      },
    };
    await expect(admit(tx)).rejects.toThrow("no admission");
  });
});

describe("the consent an admission records", () => {
  it("comes from the trusted policy: an eligible contact is recorded eligible", async () => {
    const { queries, tx } = recorder();
    await admit(tx, MESSAGE, ELIGIBLE);
    expect(queries[0].params[DO_NOT_CONTACT]).toBe(false);
  });

  it("comes from the trusted policy: a blocked contact is recorded blocked", async () => {
    const { queries, tx } = recorder();
    await admit(tx, MESSAGE, BLOCKED);
    expect(queries[0].params[DO_NOT_CONTACT]).toBe(true);
  });

  // The attack: the message claims its own sender is contactable. The
  // envelope has no such field; a value smuggled onto it is simply not read,
  // and the trusted answer wins.
  it("is never taken from the message: payload says eligible, policy says blocked, blocked wins", async () => {
    const { queries, tx } = recorder();
    const claimingEligible = {
      ...MESSAGE,
      doNotContact: false,
      do_not_contact: false,
      consent: "granted",
    } as unknown as InboundMessage;

    await admit(tx, claimingEligible, BLOCKED);

    expect(queries[0].params[DO_NOT_CONTACT]).toBe(true);
  });

  it("asks the policy about the contact the message names", async () => {
    const asked: string[] = [];
    const policy: ContactPolicy = {
      doNotContact: (contactRef) => {
        asked.push(contactRef);
        return false;
      },
    };
    const { tx } = recorder();

    await admit(tx, MESSAGE, policy);

    expect(asked).toEqual([CONTACT]);
  });

  it.each<[string, unknown]>([
    ["undefined", undefined],
    ["null", null],
    ["the string 'false'", "false"],
    ["zero", 0],
  ])(
    "records do-not-contact when the policy answers %s rather than false",
    async (_name, answer) => {
      const { queries, tx } = recorder();
      const unsure = { doNotContact: () => answer } as unknown as ContactPolicy;

      await admit(tx, MESSAGE, unsure);

      expect(queries[0].params[DO_NOT_CONTACT]).toBe(true);
    },
  );

  it("admits nothing when the policy cannot answer", async () => {
    const { queries, tx } = recorder();
    const broken: ContactPolicy = {
      doNotContact: () => {
        throw new Error("consent source unavailable");
      },
    };

    await expect(admit(tx, MESSAGE, broken)).rejects.toThrow(
      "consent source unavailable",
    );
    expect(queries).toHaveLength(0);
  });
});
