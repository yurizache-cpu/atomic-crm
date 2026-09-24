import { afterEach, describe, expect, it, vi } from "vitest";

import { DecisionProviderUnavailableError } from "./decisionPort.ts";
import { DecisionVectorSchema, type DecisionInput } from "./decisionVector.ts";
import {
  FAKE_DECISION_PROVIDER,
  createFakeDecisionProvider,
  fakeVerdict,
} from "./fakeDecisionProvider.ts";
import { createJevDecisionProvider } from "./jevDecisionProvider.ts";
import { decisionShadowFromEnv } from "./providerFromEnv.ts";

// The providers behind the DecisionPort in 2D.1: the deterministic fake, and
// the Jev boundary, which has no approved contract and reaches nothing.

const input = (
  triage: Partial<DecisionInput["triage"]> = {},
  rest: Partial<DecisionInput> = {},
): DecisionInput => ({
  version: "decision_input.v1",
  subject: "lead_triage.review",
  sourceClass: "synthetic",
  contactPolicy: "contactable",
  triage: {
    outcome: "triaged",
    intent: "information",
    priority: "normal",
    flags: [],
    needsHumanReview: true,
    ...triage,
  },
  ...rest,
});

const FINGERPRINT = `sha256:${"b".repeat(64)}`;
const signal = new AbortController().signal;

describe("the fake decision provider", () => {
  it("answers a strict, valid vector that echoes the input fingerprint and names itself fake", async () => {
    const provider = createFakeDecisionProvider({
      now: () => new Date("2026-09-24T12:00:00.000Z"),
    });

    const vector = await provider.evaluate(
      { input: input(), inputFingerprint: FINGERPRINT },
      { signal },
    );

    const parsed = DecisionVectorSchema.parse(vector);
    expect(parsed).toMatchObject({
      recommendation: "accept",
      confidence: 0.82,
      caution: "low",
      mode: "shadow",
      provider: FAKE_DECISION_PROVIDER,
      inputFingerprint: FINGERPRINT,
      evaluatedAt: "2026-09-24T12:00:00.000Z",
    });
    expect(provider.identity.kind).toBe("fake");
  });

  it("is deterministic: the same input answers the same verdict", () => {
    expect(fakeVerdict(input({ flags: ["spam"] }))).toEqual(
      fakeVerdict(input({ flags: ["spam"] })),
    );
  });

  it.each([
    [
      "a possible crisis",
      input({ flags: ["possible_crisis"] }),
      "needs_edit",
      "high",
    ],
    ["a minor", input({ flags: ["minor"] }), "needs_edit", "high"],
    [
      "a do-not-contact lead",
      input({}, { contactPolicy: "do_not_contact" }),
      "reject",
      "medium",
    ],
    ["spam", input({ flags: ["spam"] }), "reject", "low"],
    [
      "an out-of-scope outcome",
      input({ outcome: "out_of_scope" }),
      "reject",
      "low",
    ],
    [
      "a triage that needs input",
      input({ outcome: "needs_input" }),
      "needs_edit",
      "medium",
    ],
    ["a support request", input({ intent: "support" }), "abstain", "low"],
    [
      "no structured signal",
      input({ outcome: null, intent: null }),
      "abstain",
      "low",
    ],
  ])("answers %s with %s", (_label, request, recommendation, caution) => {
    expect(fakeVerdict(request)).toMatchObject({ recommendation, caution });
  });
});

describe("the Jev boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reaches nothing: it reports the provider unavailable without any network call", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const jev = createJevDecisionProvider();

    const outcome = jev.evaluate(
      { input: input(), inputFingerprint: FINGERPRINT },
      { signal },
    );

    await expect(outcome).rejects.toBeInstanceOf(
      DecisionProviderUnavailableError,
    );
    await expect(outcome).rejects.toMatchObject({
      code: "jev_contract_not_approved",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(jev.identity).toEqual({
      kind: "jev",
      id: "jev",
      version: "unconnected",
    });
  });
});

describe("DECISION_SHADOW_PROVIDER", () => {
  it("is off when unset: no request, and a provider that reaches nothing", async () => {
    const config = decisionShadowFromEnv({});

    expect(config.requestsShadowDecisions).toBe(false);
    expect(config.port.identity.kind).toBe("none");
    await expect(
      config.port.evaluate(
        { input: input(), inputFingerprint: FINGERPRINT },
        { signal },
      ),
    ).rejects.toMatchObject({ code: "provider_not_configured" });
  });

  it("selects the fake or the Jev boundary by name, and refuses anything else", () => {
    expect(
      decisionShadowFromEnv({ DECISION_SHADOW_PROVIDER: "fake" }).port.identity
        .kind,
    ).toBe("fake");
    expect(
      decisionShadowFromEnv({ DECISION_SHADOW_PROVIDER: "jev" }).port.identity
        .kind,
    ).toBe("jev");
    expect(() =>
      decisionShadowFromEnv({ DECISION_SHADOW_PROVIDER: "gpt" }),
    ).toThrow(/refusing to start/);
  });
});
