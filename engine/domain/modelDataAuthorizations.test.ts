import { describe, expect, it } from "vitest";
import type { TxClient } from "../db/types.ts";
import { CompanyOsError } from "./errors.ts";
import {
  recordModelDataAuthorization,
  retireModelDataAuthorization,
  type ModelDataAuthorizationInput,
} from "./modelDataAuthorizations.ts";

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const ID = "c1000000-0000-4000-8000-0000000000c1";

// FAKE evidence references: test data, never a real provider's record.
const HEALTH: ModelDataAuthorizationInput = Object.freeze({
  tenantId: TENANT,
  dataClass: "health",
  capability: "lead_triage",
  provider: "openai",
  model: "gpt-fixture-2026-09-01",
  validFrom: "2026-10-01T00:00:00Z",
  expiresAt: "2026-12-01T00:00:00Z",
  providerEvidenceRef: "fixture:provider-evidence:v1",
  evidenceVerifiedAt: "2026-09-30T00:00:00Z",
  trainingExcluded: true,
  contractRef: "fixture:contract:v1",
  dpaRef: "fixture:dpa:v1",
  zeroRetentionRef: "fixture:zdr:v1",
  retentionEvidenceRef: "fixture:retention:v1",
  transferMechanismRef: "fixture:transfer:v1",
  lawfulBasisRef: "fixture:consent:v1",
  contentRetentionDays: 30,
});

const recording = () => {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const tx = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [{ result: sql.includes("retire") ? true : ID }] };
    },
  } as unknown as TxClient;
  return { tx, calls };
};

const unreachable = {
  query: async () => {
    throw new Error("the database must not be reached");
  },
} as unknown as TxClient;

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CompanyOsError) return error.code;
    throw error;
  }
  return "no error";
};

describe("recording a model-data authorization (ADR 0020)", () => {
  it("calls exactly one owner function with every field bound, in its order", async () => {
    const { tx, calls } = recording();

    expect(
      await recordModelDataAuthorization(tx, HEALTH, { actor: "owner" }),
    ).toBe(ID);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe(
      "select ops.record_model_data_authorization($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) as result",
    );
    expect(calls[0]?.params).toEqual([
      TENANT,
      "health",
      "lead_triage",
      "openai",
      "gpt-fixture-2026-09-01",
      "2026-10-01T00:00:00Z",
      "2026-12-01T00:00:00Z",
      "fixture:provider-evidence:v1",
      "2026-09-30T00:00:00Z",
      true,
      "fixture:contract:v1",
      "fixture:dpa:v1",
      "fixture:zdr:v1",
      "fixture:retention:v1",
      "fixture:transfer:v1",
      "fixture:consent:v1",
      30,
      "owner",
    ]);
  });

  it.each([
    ["an identifier class", { dataClass: "identifier" }],
    ["clinical records", { dataClass: "clinical_record" }],
    ["derived data", { dataClass: "derived" }],
    ["synthetic data, which needs none", { dataClass: "synthetic" }],
    ["the in-process fake provider", { provider: "fake" }],
    ["health with no lawful basis", { lawfulBasisRef: undefined }],
    ["health with no transfer mechanism", { transferMechanismRef: undefined }],
    ["health with no zero-retention evidence", { zeroRetentionRef: undefined }],
    ["health with training not excluded", { trainingExcluded: false }],
    ["health kept 31 days", { contentRetentionDays: 31 }],
    ["health with no retention period", { contentRetentionDays: undefined }],
    ["prose instead of a reference", { lawfulBasisRef: "the patient agreed" }],
    [
      "an expiry 400 days after the evidence",
      { expiresAt: "2027-11-04T00:00:00Z" },
    ],
    [
      "validity before the evidence was verified",
      { validFrom: "2026-09-29T00:00:00Z" },
    ],
    ["an instant with no offset", { validFrom: "2026-10-01T00:00:00" }],
  ])("refuses %s before any connection", async (_case, patch) => {
    expect(
      await codeOf(
        recordModelDataAuthorization(
          unreachable,
          { ...HEALTH, ...patch } as ModelDataAuthorizationInput,
          { actor: "owner" },
        ),
      ),
    ).toBe("invalid_argument");
  });

  it("sends operational data with no person-content references or retention period", async () => {
    const { tx, calls } = recording();

    await recordModelDataAuthorization(
      tx,
      {
        tenantId: TENANT,
        dataClass: "operational",
        capability: "lead_triage",
        provider: "openai",
        model: "gpt-fixture-2026-09-01",
        validFrom: "2026-10-01T00:00:00Z",
        expiresAt: "2026-12-01T00:00:00Z",
        providerEvidenceRef: "fixture:provider-evidence:v1",
        evidenceVerifiedAt: "2026-09-30T00:00:00Z",
        trainingExcluded: false,
      },
      { actor: "owner" },
    );

    expect(calls[0]?.params.slice(10)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "owner",
    ]);
  });

  it("retires by id with a reason and an actor, and refuses a malformed id first", async () => {
    const { tx, calls } = recording();

    expect(
      await retireModelDataAuthorization(tx, ID, {
        reason: "evidence withdrawn",
        actor: "owner",
      }),
    ).toBe(true);
    expect(calls[0]?.params).toEqual([ID, "evidence withdrawn", "owner"]);
    expect(
      await codeOf(
        retireModelDataAuthorization(unreachable, "not-a-uuid", {
          reason: "x",
          actor: "owner",
        }),
      ),
    ).toBe("malformed_identifier");
  });
});
