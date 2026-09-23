// Company OS memberships through the owner CLI (`npm run ops -- membership
// grant|revoke|list`) against a real Postgres (Phase 2C; brief §7.4, §8 rows
// 18-20, §16; SI-39).
//
// engine/cli/operator.test.ts sees the SQL the tool sends to a fake database.
// What only the real database shows:
//
//   * that a grant binds the auth user id, never an email, records the SHA-256
//     of the lower-cased email and prints only ids;
//   * that the listing's emailChangedSinceGrant, computed in SQL, flips when the
//     auth email changes and not when only its case does;
//   * that the owner services refuse a tenant outside the Phase 2C eligibility
//     policy, an unknown tenant, an auth user that is missing, unconfirmed,
//     banned or deleted, and a second active membership, recording nothing;
//   * that no output, on success or on any refusal, carries the email, its
//     lower-cased form, its hash, an auth token or a piece of the connection
//     string.
//
// ONE ROLLED-BACK TRANSACTION PER CASE. A principal and a membership are never
// deleted (their guards refuse it, the owner included), so a committed fixture
// would outlive the suite and block the delete of its tenant. Each command runs
// in a savepoint of the case's transaction, through the production CLI code and
// the production owner connection; the tenants and auth users are the case's
// own and vanish with it. It lives in engine/domain because only there may a
// test import the CLIs and the database fixture together (eslint.config.js).
//
// ALL DATA IS SYNTHETIC: sentinel emails and tokens that no output may carry.

import { createHash, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import {
  ADMIN_URL,
  adminPool,
  assertTargetDatabase,
} from "../worker/testSupport/dbFixture.ts";
import {
  openSession,
  type TransactionSession,
} from "../worker/testSupport/transactionSession.ts";
import { listMemberships } from "./memberships.ts";
import {
  connectionPieces,
  leaks,
  newTranscript,
  openOwnerDatabase,
  runOps,
  type CliRun,
  type CliTranscript,
  type OpenDatabase,
} from "./testSupport/ownerCli.ts";

const ACTOR = "dbtest-membership-owner";
const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

interface Fixture {
  /** Owns the local CRM for this transaction: the one eligible tenant. */
  readonly eligible: string;
  /** Does not: the Phase 2C policy refuses it. */
  readonly other: string;
  /** Takes the CRM over in the case that moves a person between tenants. */
  readonly second: string;
  readonly member: string;
  readonly unconfirmed: string;
  readonly banned: string;
  readonly deleted: string;
  /** Mixed case, so the lower-cased form differs. */
  readonly email: string;
  readonly changedEmail: string;
  /** Every text no output may carry. */
  readonly forbidden: readonly string[];
}

let owner: WorkerDatabase;
let session: TransactionSession;
let fixture: Fixture;
let transcript: CliTranscript;

/** The owner connection, confined to a savepoint of the case's one transaction. */
function inSession(opened: { count: number }): OpenDatabase {
  return () => {
    opened.count += 1;
    return {
      identity: () =>
        Promise.reject(new Error("the owner CLI never runs the identity gate")),
      close: async () => undefined,
      withTransaction: <T>(fn: (tx: TxClient) => Promise<T>) =>
        session.run(async (tx) => {
          await tx.query("savepoint dbtest_cli");
          try {
            const result = await fn(tx);
            await tx.query("release savepoint dbtest_cli");
            return result;
          } catch (error) {
            await tx.query("rollback to savepoint dbtest_cli");
            throw error;
          }
        }),
    };
  };
}

const opened = { count: 0 };
const ops = (argv: readonly string[]): Promise<CliRun> =>
  runOps(argv, { transcript, openDatabase: inSession(opened) });

const grantArgs = (
  tenant: string,
  authUserId: string,
  overrides: Readonly<Record<string, string>> = {},
): string[] =>
  Object.entries({
    tenant,
    "auth-user-id": authUserId,
    "display-name": "Synthetic Operator",
    actor: ACTOR,
    reason: "synthetic pilot operator",
    ...overrides,
  }).reduce<string[]>(
    (argv, [name, value]) => [...argv, `--${name}`, value],
    ["membership", "grant"],
  );

const revokeArgs = (membershipId: string): string[] => [
  ...["membership", "revoke", "--id", membershipId],
  ...["--actor", ACTOR, "--reason", "synthetic pilot ended"],
];

const listArgs = (tenant: string): string[] => [
  ...["membership", "list", "--tenant", tenant],
];

const errorOf = (run: CliRun) =>
  JSON.parse(run.stderr[0] ?? "{}") as { error?: string; message?: string };

async function seed(tx: TxClient): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const ids = {
    eligible: randomUUID(),
    other: randomUUID(),
    second: randomUUID(),
    member: randomUUID(),
    unconfirmed: randomUUID(),
    banned: randomUUID(),
    deleted: randomUUID(),
  };
  const email = `Sentinel.Member.${suffix}@Example.Test`;
  const changedEmail = `Changed.Member.${suffix}@Example.Test`;
  const tokens = [`dbtest-confirmation-${suffix}`, `dbtest-recovery-${suffix}`];

  // At most one tenant owns the local CRM: this transaction's own takes it.
  await tx.query(
    "update ops.tenants set owns_local_crm = false where owns_local_crm",
  );
  await tx.query(
    `insert into ops.tenants (id, slug, name, owns_local_crm) values
       ($1, $4, 'DB test membership tenant', true),
       ($2, $5, 'DB test membership tenant, not the CRM''s', false),
       ($3, $6, 'DB test membership tenant, second', false)`,
    [
      ids.eligible,
      ids.other,
      ids.second,
      `dbtest-mbr-${suffix}`,
      `dbtest-mbr-other-${suffix}`,
      `dbtest-mbr-second-${suffix}`,
    ],
  );
  // Inserting into auth.users fires handle_new_user, the dashboard's own path.
  await tx.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                             email_confirmed_at, banned_until, deleted_at,
                             confirmation_token, recovery_token,
                             created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
     values
       ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        $5, 'x', now(), null, null, $9, $10, now(), now(), '{}', '{}'),
       ($2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        $6, 'x', null, null, null, null, null, now(), now(), '{}', '{}'),
       ($3, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        $7, 'x', now(), now() + interval '1 day', null, null, null, now(), now(), '{}', '{}'),
       ($4, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        $8, 'x', now(), null, now(), null, null, now(), now(), '{}', '{}')`,
    [
      ids.member,
      ids.unconfirmed,
      ids.banned,
      ids.deleted,
      email,
      `Sentinel.Unconfirmed.${suffix}@Example.Test`,
      `Sentinel.Banned.${suffix}@Example.Test`,
      `Sentinel.Deleted.${suffix}@Example.Test`,
      ...tokens,
    ],
  );

  const emails = [email, changedEmail].flatMap((address) => [
    address,
    address.toLowerCase(),
    sha256(address),
    sha256(address.toLowerCase()),
  ]);
  return {
    ...ids,
    email,
    changedEmail,
    forbidden: [...emails, ...tokens, "@Example.Test", ...connectionPieces()],
  };
}

async function memberRows(): Promise<number> {
  return session.run(async (tx) => {
    const { rows } = await tx.query<{ n: number }>(
      `select count(*)::int as n
         from ops.tenant_memberships m
         join ops.principals p on p.id = m.principal_id
        where p.subject = any($1::uuid[])`,
      [[fixture.member, fixture.unconfirmed, fixture.banned, fixture.deleted]],
    );
    return rows[0].n;
  });
}

const setAuthEmail = (address: string): Promise<void> =>
  session.run(async (tx) => {
    await tx.query("update auth.users set email = $2 where id = $1", [
      fixture.member,
      address,
    ]);
  });

beforeAll(async () => {
  const admin = adminPool();
  try {
    await assertTargetDatabase(admin);
    const { rows } = await admin.query<{ present: boolean }>(
      `select to_regprocedure('ops.grant_membership(uuid,uuid,text,text,text)') is not null as present`,
    );
    if (!rows[0]?.present) {
      throw new Error(
        "the Phase 2C read-surface migration is not applied to this database",
      );
    }
  } finally {
    await admin.end();
  }
  owner = openOwnerDatabase(ADMIN_URL);
});

afterAll(async () => {
  await owner?.close();
});

beforeEach(async () => {
  opened.count = 0;
  transcript = newTranscript();
  session = openSession(owner);
  fixture = await session.run(seed);
});

afterEach(async () => {
  try {
    // Every line any command of the case printed, successes and refusals alike.
    expect(leaks(transcript, fixture.forbidden)).toEqual([]);
  } finally {
    await session.end("rollback");
  }
});

describe("the owner's membership acts on the real database", () => {
  it("grants a membership to an auth user id, prints only its ids, records the hash of the lower-cased email and answers a replay with the same membership", async () => {
    const granted = await ops(grantArgs(fixture.eligible, fixture.member));

    expect(granted).toMatchObject({ code: 0, stderr: [] });
    expect(granted.lines).toEqual([
      {
        principalId: expect.any(String),
        membershipId: expect.any(String),
        recorded: true,
      },
    ]);
    const { principalId, membershipId } = granted.lines[0] as {
      principalId: string;
      membershipId: string;
    };
    const stored = await session.run(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `select p.kind, p.issuer, p.subject, p.display_name, m.tenant_id, m.role,
                m.email_at_grant_sha256, m.granted_by, m.revoked_at
           from ops.tenant_memberships m
           join ops.principals p on p.id = m.principal_id
          where m.id = $1 and p.id = $2`,
        [membershipId, principalId],
      );
      return rows;
    });
    expect(stored).toEqual([
      {
        kind: "human",
        issuer: "supabase_auth",
        subject: fixture.member,
        display_name: "Synthetic Operator",
        tenant_id: fixture.eligible,
        role: "tenant_operator",
        email_at_grant_sha256: sha256(fixture.email.toLowerCase()),
        granted_by: ACTOR,
        revoked_at: null,
      },
    ]);

    const replay = await ops(grantArgs(fixture.eligible, fixture.member));
    expect(replay.lines).toEqual([
      { principalId, membershipId, recorded: false },
    ]);
  });

  it("lists a membership with emailChangedSinceGrant computed in SQL: false at grant, true once the auth email changes, false again for the same address in another case", async () => {
    const granted = await ops(grantArgs(fixture.eligible, fixture.member));
    const { principalId, membershipId } = granted.lines[0] as {
      principalId: string;
      membershipId: string;
    };
    const listed = async () => {
      const run = await ops(listArgs(fixture.eligible));
      expect(run).toMatchObject({ code: 0, stderr: [] });
      return run.lines;
    };

    const atGrant = await listed();
    expect(atGrant).toEqual([
      {
        id: membershipId,
        principalId,
        authUserId: fixture.member,
        tenantId: fixture.eligible,
        role: "tenant_operator",
        state: "active",
        displayName: "Synthetic Operator",
        grantedAt: expect.stringMatching(/Z$/),
        revokedAt: null,
        emailChangedSinceGrant: false,
      },
    ]);

    await setAuthEmail(fixture.changedEmail);
    expect(await listed()).toEqual([
      { ...atGrant[0], emailChangedSinceGrant: true },
    ]);

    await setAuthEmail(fixture.email.toUpperCase());
    expect(await listed()).toEqual([
      { ...atGrant[0], emailChangedSinceGrant: false },
    ]);

    // The domain read returns the same objects the CLI printed: nothing more.
    const returned = await session.run((tx) =>
      listMemberships(tx, { tenantId: fixture.eligible }),
    );
    transcript.lines.push(JSON.stringify(returned));
    expect(returned).toEqual(await listed());
  });

  it("revokes a membership once, and lists it as revoked", async () => {
    const granted = await ops(grantArgs(fixture.eligible, fixture.member));
    const { membershipId } = granted.lines[0] as { membershipId: string };

    expect((await ops(revokeArgs(membershipId))).lines).toEqual([
      { membershipId, revoked: true },
    ]);
    expect((await ops(revokeArgs(membershipId))).lines).toEqual([
      { membershipId, revoked: false },
    ]);
    expect((await ops(listArgs(fixture.eligible))).lines).toEqual([
      expect.objectContaining({
        id: membershipId,
        state: "revoked",
        revokedAt: expect.stringMatching(/Z$/),
      }),
    ]);
  });

  it("moves a person to another tenant only by a revoke and a new grant: a second active membership is refused", async () => {
    const first = await ops(grantArgs(fixture.eligible, fixture.member));
    const { principalId, membershipId } = first.lines[0] as {
      principalId: string;
      membershipId: string;
    };
    await session.run(async (tx) => {
      await tx.query(
        "update ops.tenants set owns_local_crm = false where id = $1",
        [fixture.eligible],
      );
      await tx.query(
        "update ops.tenants set owns_local_crm = true where id = $1",
        [fixture.second],
      );
    });

    const refused = await ops(grantArgs(fixture.second, fixture.member));
    expect(refused.code).toBe(1);
    expect(errorOf(refused).error).toBe("invalid_state");

    await ops(revokeArgs(membershipId));
    const moved = await ops(grantArgs(fixture.second, fixture.member));
    expect(moved.lines).toEqual([
      { principalId, membershipId: expect.any(String), recorded: true },
    ]);
    expect(moved.lines[0]?.membershipId).not.toBe(membershipId);
  });
});

describe("the owner's membership refusals on the real database", () => {
  it("refuses a tenant outside the Phase 2C eligibility policy, an unknown tenant, and an auth user that is missing, unconfirmed, banned or deleted, recording nothing", async () => {
    const cases: readonly [string, string, string][] = [
      [fixture.other, fixture.member, "refused"],
      [randomUUID(), fixture.member, "not_found"],
      [fixture.eligible, randomUUID(), "not_found"],
      [fixture.eligible, fixture.unconfirmed, "not_found"],
      [fixture.eligible, fixture.banned, "not_found"],
      [fixture.eligible, fixture.deleted, "not_found"],
    ];
    for (const [tenant, authUserId, code] of cases) {
      const run = await ops(grantArgs(tenant, authUserId));

      expect(run.code).toBe(1);
      expect(run.stdout).toEqual([]);
      expect(errorOf(run).error).toBe(code);
    }
    expect(await memberRows()).toBe(0);
  });

  it("refuses an unknown membership on revoke", async () => {
    const run = await ops(revokeArgs(randomUUID()));

    expect(run.code).toBe(1);
    expect(errorOf(run).error).toBe("not_found");
  });

  it("refuses an email as the auth user id before any connection opens, and an email as the display name or a reserved actor before the database is asked", async () => {
    const byEmail = await ops(grantArgs(fixture.eligible, fixture.email));
    expect(byEmail.code).toBe(2);
    expect(opened.count).toBe(0);

    const refusedOverrides: readonly Readonly<Record<string, string>>[] = [
      { "display-name": fixture.email },
      { actor: `principal:${randomUUID()}` },
      { actor: "system:membership" },
    ];
    for (const overrides of refusedOverrides) {
      const run = await ops(
        grantArgs(fixture.eligible, fixture.member, overrides),
      );
      expect(run.code).toBe(1);
      expect(errorOf(run).error).toBe("invalid_argument");
    }
    expect(await memberRows()).toBe(0);
  });
});
