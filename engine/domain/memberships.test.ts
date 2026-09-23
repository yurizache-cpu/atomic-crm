// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TxClient } from "../db/types.ts";
import { CompanyOsError } from "./errors.ts";
import {
  DEFAULT_LISTED_MEMBERSHIPS,
  EMAIL_CHANGED_SINCE_GRANT,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_LISTED_MEMBERSHIPS,
  MAX_MEMBERSHIP_REASON_LENGTH,
  MEMBERSHIP_COLUMNS,
  grantMembership,
  listMemberships,
  revokeMembership,
  type GrantMembershipInput,
  type MembershipAct,
} from "./memberships.ts";

// What the membership boundary sends and what it refuses to send, with no
// database. What the owner services decide (the auth user's state, the Phase 2C
// eligibility policy, one active membership, a revocation recorded once) and
// that nothing email-derived is ever printed are proven against a real Postgres
// in memberships.dbtest.ts.

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const AUTH_USER = "f0000000-0000-4000-8000-00000000000f";
const PRINCIPAL = "a1000000-0000-4000-8000-0000000000a1";
const MEMBERSHIP = "b1000000-0000-4000-8000-0000000000b1";
// A synthetic person's email, assembled so no scanner mistakes it for data.
const EMAIL = ["Sentinel.Person", "Example.Test"].join("@");

const INPUT: GrantMembershipInput = {
  tenantId: TENANT,
  authUserId: AUTH_USER,
  displayName: "Synthetic Operator",
};
const ACT: MembershipAct = { actor: "owner", reason: "synthetic pilot" };

const GRANT_SQL = "select ops.grant_membership($1, $2, $3, $4, $5) as result";
const REVOKE_SQL = "select ops.revoke_membership($1, $2, $3) as result";

const recordingDatabase = (rows: readonly unknown[]) => {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const tx: TxClient = {
    async query<TRow>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [...rows] as TRow[] };
    },
  };
  return { tx, calls };
};

const answering = (result: unknown) => recordingDatabase([{ result }]);

/** A database that must never be reached. */
const unreachable: TxClient = {
  query: () => {
    throw new Error("the database was reached with input that is never valid");
  },
};

const refusalOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CompanyOsError);
    return error as CompanyOsError;
  }
  throw new Error("expected a CompanyOsError");
};

describe("granting a membership", () => {
  it("sends the tenant, the auth user id, the display name, the actor and the reason as one parameterised call", async () => {
    const { tx, calls } = answering({
      principalId: PRINCIPAL,
      membershipId: MEMBERSHIP,
      recorded: true,
    });

    const granted = await grantMembership(tx, INPUT, ACT);

    expect(granted).toEqual({
      principalId: PRINCIPAL,
      membershipId: MEMBERSHIP,
      recorded: true,
    });
    expect(Object.isFrozen(granted)).toBe(true);
    expect(calls).toEqual([
      {
        sql: GRANT_SQL,
        params: [
          TENANT,
          AUTH_USER,
          "Synthetic Operator",
          "owner",
          "synthetic pilot",
        ],
      },
    ]);
  });

  it("measures a display name in code points, as the database does", async () => {
    const { tx, calls } = answering({
      principalId: PRINCIPAL,
      membershipId: MEMBERSHIP,
      recorded: false,
    });
    const displayName = "\u{1F9D1}".repeat(MAX_DISPLAY_NAME_LENGTH);

    expect(
      (await grantMembership(tx, { ...INPUT, displayName }, ACT)).recorded,
    ).toBe(false);
    expect(calls[0]?.params[2]).toBe(displayName);
  });

  it.each<[string, Partial<GrantMembershipInput>, Partial<MembershipAct>]>([
    ["an email in place of the auth user id", { authUserId: EMAIL }, {}],
    ["an auth user id that is not a uuid", { authUserId: "user-1" }, {}],
    ["a tenant that is not a uuid", { tenantId: "dev" }, {}],
    ["an email as the display name", { displayName: EMAIL }, {}],
    ["a display name with an @", { displayName: "ops@clinic" }, {}],
    ["a blank display name", { displayName: "   " }, {}],
    [
      "a display name one code point too long",
      { displayName: "d".repeat(MAX_DISPLAY_NAME_LENGTH + 1) },
      {},
    ],
    [
      "a display name with a control character",
      { displayName: "Synthetic\u0007Operator" },
      {},
    ],
    [
      "a display name with a format character",
      { displayName: "Synthetic\u200bOperator" },
      {},
    ],
    ["an empty actor", {}, { actor: "" }],
    ["an upper-case actor", {}, { actor: "Owner" }],
    ["an actor claiming the system: prefix", {}, { actor: "system:grants" }],
    [
      "an actor claiming the principal: prefix",
      {},
      { actor: `principal:${PRINCIPAL}` },
    ],
    ["a blank reason", {}, { reason: " " }],
    [
      "a reason one code point too long",
      {},
      { reason: "r".repeat(MAX_MEMBERSHIP_REASON_LENGTH + 1) },
    ],
    ["a reason with a bidirectional override", {}, { reason: "ok\u202egr" }],
  ])(
    "refuses %s before reaching the database, repeating nothing it was given",
    async (_case, input, act) => {
      const refusal = await refusalOf(
        grantMembership(
          unreachable,
          { ...INPUT, ...input },
          { ...ACT, ...act },
        ),
      );

      expect(["invalid_argument", "malformed_identifier"]).toContain(
        refusal.code,
      );
      for (const value of [...Object.values(input), ...Object.values(act)]) {
        if (value?.trim()) expect(refusal.message).not.toContain(value);
      }
      expect(refusal.message.toLowerCase()).not.toContain(EMAIL.toLowerCase());
    },
  );

  it("maps the eligibility refusal to its domain code with the database's own message", async () => {
    const message =
      "ops.grant_membership: in Phase 2C only the tenant that owns the local CRM is eligible";
    const tx: TxClient = {
      query: async () => {
        throw Object.assign(new Error(message), { code: "OS403" });
      },
    };

    const refusal = await refusalOf(grantMembership(tx, INPUT, ACT));

    expect(refusal).toMatchObject({ code: "refused", message });
  });

  it("throws rather than inventing an answer the database did not give", async () => {
    await expect(
      grantMembership(answering({ recorded: true }).tx, INPUT, ACT),
    ).rejects.toThrow("ops.grant_membership returned no membership");
    await expect(
      grantMembership(recordingDatabase([]).tx, INPUT, ACT),
    ).rejects.toThrow("ops.grant_membership returned no answer");
  });
});

describe("revoking a membership", () => {
  it("sends the membership, the actor and the reason, and reports whether this call revoked it", async () => {
    const { tx, calls } = answering({
      membershipId: MEMBERSHIP,
      revoked: false,
    });

    expect(await revokeMembership(tx, MEMBERSHIP, ACT)).toEqual({
      membershipId: MEMBERSHIP,
      revoked: false,
    });
    expect(calls).toEqual([
      { sql: REVOKE_SQL, params: [MEMBERSHIP, "owner", "synthetic pilot"] },
    ]);
  });

  it("refuses a malformed membership id and a reserved actor before reaching the database", async () => {
    expect(
      (await refusalOf(revokeMembership(unreachable, "m-1", ACT))).code,
    ).toBe("malformed_identifier");
    for (const actor of ["system:revocations", `principal:${PRINCIPAL}`]) {
      expect(
        (
          await refusalOf(
            revokeMembership(unreachable, MEMBERSHIP, { ...ACT, actor }),
          )
        ).code,
      ).toBe("invalid_argument");
    }
  });
});

describe("listing memberships", () => {
  it.each([
    "email_at_grant_sha256",
    "grant_reason",
    "revoke_reason",
    "granted_by",
    "revoked_by",
    "created_by",
    "disabled_by",
    "encrypted_password",
    "confirmation_token",
    "recovery_token",
    "email_change",
    "raw_user_meta_data",
  ])("never returns %s", (column) => {
    const outputs = MEMBERSHIP_COLUMNS.replace(
      `${EMAIL_CHANGED_SINCE_GRANT} as email_changed_since_grant`,
      "",
    );

    expect(outputs).not.toMatch(new RegExp(`\\b${column}\\b`));
  });

  it("reads an email in exactly one expression, which compares hashes and yields only a boolean", () => {
    const outputs = MEMBERSHIP_COLUMNS.replace(
      `${EMAIL_CHANGED_SINCE_GRANT} as email_changed_since_grant`,
      "",
    );

    expect(MEMBERSHIP_COLUMNS).toContain(
      `${EMAIL_CHANGED_SINCE_GRANT} as email_changed_since_grant`,
    );
    expect(outputs).not.toMatch(/email|sha256|hash/i);
    expect(EMAIL_CHANGED_SINCE_GRANT).toMatch(
      /^\(u\.email is null\s+or pg_catalog\.encode\(pg_catalog\.sha256\(pg_catalog\.convert_to\(pg_catalog\.lower\(u\.email\), 'UTF8'\)\), 'hex'\)\s+is distinct from m\.email_at_grant_sha256\)$/,
    );
  });

  it("sends the tenant and the limit as parameters, fifty by default", async () => {
    const { tx, calls } = recordingDatabase([]);

    await listMemberships(tx);
    await listMemberships(tx, { tenantId: TENANT, limit: 20 });

    expect(calls.map(({ params }) => params)).toEqual([
      [null, DEFAULT_LISTED_MEMBERSHIPS],
      [TENANT, 20],
    ]);
    expect(calls[0]?.sql).not.toContain(TENANT);
  });

  it("refuses a limit outside its bounds and a malformed tenant before reaching the database", async () => {
    for (const limit of [0, MAX_LISTED_MEMBERSHIPS + 1, 1.5]) {
      expect(
        (await refusalOf(listMemberships(unreachable, { limit }))).code,
      ).toBe("invalid_argument");
    }
    expect(
      (await refusalOf(listMemberships(unreachable, { tenantId: EMAIL }))).code,
    ).toBe("malformed_identifier");
  });

  it("returns each row field by field, with its state, and throws on a role or signal it does not know", async () => {
    const row = {
      id: MEMBERSHIP,
      principal_id: PRINCIPAL,
      auth_user_id: AUTH_USER,
      tenant_id: TENANT,
      role: "tenant_operator",
      display_name: "Synthetic Operator",
      granted_at: "2026-09-22T10:00:00.000000Z",
      revoked_at: null,
      email_changed_since_grant: false,
      email: EMAIL,
    };

    expect(await listMemberships(recordingDatabase([row]).tx)).toEqual([
      {
        id: MEMBERSHIP,
        principalId: PRINCIPAL,
        authUserId: AUTH_USER,
        tenantId: TENANT,
        role: "tenant_operator",
        state: "active",
        displayName: "Synthetic Operator",
        grantedAt: "2026-09-22T10:00:00.000000Z",
        revokedAt: null,
        emailChangedSinceGrant: false,
      },
    ]);
    await expect(
      listMemberships(recordingDatabase([{ ...row, role: "operator" }]).tx),
    ).rejects.toThrow("unknown role");
    await expect(
      listMemberships(
        recordingDatabase([{ ...row, email_changed_since_grant: null }]).tx,
      ),
    ).rejects.toThrow("no email-change signal");
  });
});
