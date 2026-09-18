// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createSyntheticCommunicationPort,
  isSyntheticIngressEnabled,
  MAX_SYNTHETIC_BODY_LENGTH,
  SYNTHETIC_INGRESS_ENABLED_VALUE,
  SYNTHETIC_INGRESS_FLAG,
} from "./syntheticIngress.ts";
import { CommunicationError } from "./types.ts";

// The synthetic transport: when it exists at all, and what it will admit.
// Whether an admitted message becomes work is leadIntake's and the database's,
// proven by the driver-backed suite.

const ON = { [SYNTHETIC_INGRESS_FLAG]: SYNTHETIC_INGRESS_ENABLED_VALUE };

const delivery = (overrides: Record<string, unknown> = {}) => ({
  external_message_id: "wa-test-0001",
  contact_ref: "synthetic:+5500000000000",
  body: "Oi, queria entender como funciona a primeira consulta.",
  received_at: "2026-09-17T12:00:00Z",
  ...overrides,
});

const refusalCode = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof CommunicationError) return error.code;
    throw error;
  }
  throw new Error("expected a CommunicationError");
};

describe("the synthetic ingress gate", () => {
  it("is off when the flag is absent", () => {
    expect(isSyntheticIngressEnabled({})).toBe(false);
    expect(refusalCode(() => createSyntheticCommunicationPort({}))).toBe(
      "ingress_disabled",
    );
  });

  // The whole point of an exact value: these are what end up in a deployment
  // environment by accident, and every one of them leaves the transport off.
  it.each(["true", "1", "yes", "on", "ENABLED", " enabled", "enabled "])(
    "stays off when the flag is %j",
    (value) => {
      const env = { [SYNTHETIC_INGRESS_FLAG]: value };
      expect(isSyntheticIngressEnabled(env)).toBe(false);
      expect(refusalCode(() => createSyntheticCommunicationPort(env))).toBe(
        "ingress_disabled",
      );
    },
  );

  it("is on only for the exact enabling value", () => {
    expect(isSyntheticIngressEnabled(ON)).toBe(true);
    expect(createSyntheticCommunicationPort(ON).sourceKind).toBe("synthetic");
  });

  it("reads one variable and never reports its value", () => {
    const read: string[] = [];
    const env = new Proxy(
      { ...ON },
      {
        get(target, name: string) {
          read.push(name);
          return Reflect.get(target, name);
        },
      },
    );

    createSyntheticCommunicationPort(env);

    expect(read).toEqual([SYNTHETIC_INGRESS_FLAG]);
  });

  it("names the variable, not its value, when it refuses", () => {
    const secret = "enabled-but-not-really";
    let message = "";
    try {
      createSyntheticCommunicationPort({ [SYNTHETIC_INGRESS_FLAG]: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(SYNTHETIC_INGRESS_FLAG);
    expect(message).not.toContain(secret);
  });
});

describe("receiving a synthetic delivery", () => {
  const port = createSyntheticCommunicationPort(ON);

  it("produces a frozen envelope with the transport's own kind", () => {
    const message = port.receive(delivery());

    expect(message).toEqual({
      sourceKind: "synthetic",
      externalMessageId: "wa-test-0001",
      contactRef: "synthetic:+5500000000000",
      body: "Oi, queria entender como funciona a primeira consulta.",
      receivedAt: new Date("2026-09-17T12:00:00Z"),
    });
    expect(Object.isFrozen(message)).toBe(true);
  });

  // Tenancy is not in the envelope, so a delivery cannot carry one: the fields
  // below are simply refused as unknown keys.
  it.each(["tenant_id", "company_id", "agent_id", "tenant"])(
    "refuses a delivery carrying %s",
    (field) => {
      expect(
        refusalCode(() =>
          port.receive(
            delivery({ [field]: "a0000000-0000-4000-8000-00000000000a" }),
          ),
        ),
      ).toBe("malformed_delivery");
    },
  );

  // Consent is not the envelope's to state: a delivery that tries to declare
  // its own sender contactable — or not — is refused outright, and the
  // envelope it would have produced carries no consent at all. The consent an
  // admission records comes from a ContactPolicy the caller trusts.
  it.each<[string, Record<string, unknown>]>([
    ["do_not_contact false", { do_not_contact: false }],
    ["do_not_contact true", { do_not_contact: true }],
    ["doNotContact false", { doNotContact: false }],
    ["a consent claim", { consent: "granted" }],
    ["an eligibility claim", { eligible: true }],
  ])("refuses a delivery carrying %s", (_name, overrides) => {
    expect(refusalCode(() => port.receive(delivery(overrides)))).toBe(
      "malformed_delivery",
    );
  });

  it("produces an envelope with no consent in it", () => {
    const message = port.receive(delivery());
    expect(Object.keys(message).sort()).toEqual([
      "body",
      "contactRef",
      "externalMessageId",
      "receivedAt",
      "sourceKind",
    ]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["no message id", { external_message_id: undefined }],
    ["a blank message id", { external_message_id: "" }],
    ["a message id with a space", { external_message_id: "wa test" }],
    ["no contact reference", { contact_ref: undefined }],
    ["no body", { body: undefined }],
    ["a non-string body", { body: 42 }],
    ["a received_at that is not an instant", { received_at: "yesterday" }],
    ["an unknown field", { direction: "inbound" }],
  ])("refuses a delivery with %s", (_name, overrides) => {
    expect(refusalCode(() => port.receive(delivery(overrides)))).toBe(
      "malformed_delivery",
    );
  });

  it("refuses a blank body as malformed and an oversize one by length", () => {
    expect(refusalCode(() => port.receive(delivery({ body: "   \n  " })))).toBe(
      "malformed_delivery",
    );
    expect(
      refusalCode(() =>
        port.receive(
          delivery({ body: "a".repeat(MAX_SYNTHETIC_BODY_LENGTH + 1) }),
        ),
      ),
    ).toBe("body_too_long");
    expect(
      port.receive(delivery({ body: "a".repeat(MAX_SYNTHETIC_BODY_LENGTH) }))
        .body.length,
    ).toBe(MAX_SYNTHETIC_BODY_LENGTH);
  });

  it("refuses a delivery that is not an object at all", () => {
    for (const value of [null, undefined, "text", 7, [], true]) {
      expect(refusalCode(() => port.receive(value))).toBe("malformed_delivery");
    }
  });

  it("offers no way to send anything", () => {
    expect(Object.keys(port).sort()).toEqual(["receive", "sourceKind"]);
    expect((port as unknown as Record<string, unknown>).send).toBeUndefined();
  });
});
