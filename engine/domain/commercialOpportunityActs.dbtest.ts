// The four commercial acts (Phase 3B.2, owner decision R; SI-68, SI-69) under
// concurrency, over the real `pg` driver on separate connections, and through
// the real identity gates as a signed-in member.
//
// Every act locks its deal row, recomputes the revision from the locked row
// and refuses a stale one with OS409, so of two acts made from the same
// revision exactly one commits:
//
//   - two moves: one moved, one OS409;
//   - a move and a conversion: the first wins, the second OS409;
//   - a conversion and a loss (either order): never both outcomes;
//   - two next-action changes: one set, one OS409, no update silently lost;
//   - a next action and its bridge-planned follow-up commit together, and a
//     rolled-back act leaves neither;
//   - the member's call through company_os_api: recorded as the principal,
//     refused once the membership is revoked or the CRM changes hands, and
//     answered with the one retryable OS429 while another writer holds the
//     deal past the gate's 2 s bound, nothing changed.
//
// The race cases call the narrow act as its gate does, with the resolved
// tenant and actor (the identity matrix is supabase/tests/company_os_api.sql's).
// Deals are committed so each connection sees them, and removed afterwards;
// the CRM's stage configuration is restored. All data is synthetic.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import {
  ADMIN_URL,
  TENANT_A,
  TENANT_B,
  adminPool,
  assertTargetDatabase,
  cleanupFixtures,
  resetFixtures,
} from "../worker/testSupport/dbFixture.ts";
import {
  memberIdentity,
  signInAsMember,
} from "./testSupport/companyOsMember.ts";

const ACTOR = "principal:00000000-0000-4000-8000-0000000000d1";
const LOSS = "dbtest_commercial_price";
const BOUND_MS = 2_000;
/** What a slow machine may add around the bound; it never shortens the wait. */
const SLACK_MS = 3_000;

let admin: Pool;
/** The racing and holding connections, apart from admin, which reads. */
let racers: Pool;
let savedConfiguration: unknown;
const created: number[] = [];

beforeAll(async () => {
  admin = adminPool();
  racers = new Pool({
    connectionString: ADMIN_URL,
    max: 6,
    statement_timeout: 20_000,
    connectionTimeoutMillis: 10_000,
  });
  await assertTargetDatabase(admin);
  const { rows } = await admin.query<{ config: unknown }>(
    "select config from public.configuration where id = 1",
  );
  savedConfiguration = rows[0]?.config ?? {};
  await admin.query(
    `update public.configuration set config = $1::jsonb where id = 1`,
    [
      JSON.stringify({
        dealStages: [
          { value: "lead", label: "Lead" },
          { value: "contact", label: "Contato" },
          { value: "proposal", label: "Proposta" },
          { value: "won", label: "Ganha" },
          { value: "enrolled", label: "Matriculada" },
        ],
        dealPipelineStatuses: ["won", "enrolled"],
      }),
    ],
  );
  await admin.query(
    `insert into public.loss_reasons (code, label, active, sort_order)
     values ($1, 'DB test price', true, 1) on conflict (code) do nothing`,
    [LOSS],
  );
});

afterAll(async () => {
  if (admin) {
    if (created.length > 0) {
      await admin.query("delete from public.deals where id = any($1::int8[])", [
        created,
      ]);
    }
    await admin.query("delete from public.loss_reasons where code = $1", [
      LOSS,
    ]);
    await admin.query(
      "update public.configuration set config = $1::jsonb where id = 1",
      [JSON.stringify(savedConfiguration)],
    );
  }
  await racers?.end();
  await cleanupFixtures(admin);
  await admin?.end();
});

beforeEach(async () => {
  await resetFixtures(admin);
});

/** A committed deal in `stage`, entered five days ago. */
async function deal(stage: string, next: Date | null = null): Promise<number> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into public.deals (name, stage, pipeline_stage, next_action_at, stage_entered_at)
     values ('dbtest commercial deal', $1, $1, $2, now() - interval '5 days')
     returning id`,
    [stage, next],
  );
  const id = Number(rows[0].id);
  created.push(id);
  return id;
}

async function state(id: number) {
  const { rows } = await admin.query<{
    stage: string;
    next: Date | null;
    converted: Date | null;
    lost: Date | null;
    revision: string;
    transitions: string;
    acts: string;
  }>(
    `select d.pipeline_stage as stage, d.next_action_at as next, d.converted_at as converted,
            d.lost_at as lost, ops.crm_deal_revision(d) as revision,
            (select count(*) from public.deal_stage_transitions t where t.deal_id = d.id) as transitions,
            (select count(*) from ops.commercial_acts a where a.deal_ref = d.id) as acts
       from public.deals d where d.id = $1`,
    [id],
  );
  return rows[0];
}

/** One act as its gate calls it, with the resolved tenant and actor. */
const ACTS = {
  move: "select ops.move_opportunity_as_member($1, $2, $3, $4, $5) as r",
  next: "select ops.set_opportunity_next_action_as_member($1, $2, $3, $4, $5) as r",
  convert: "select ops.convert_opportunity_as_member($1, $2, $3, $4, $5) as r",
  lose: "select ops.lose_opportunity_as_member($1, $2, $3, $4, $5) as r",
} as const;

type Settled =
  | { readonly ok: true; readonly outcome: string }
  | { readonly ok: false; readonly code: string };

const settle = (promise: Promise<{ rows: { r: { outcome: string } }[] }>) =>
  promise.then(
    (result): Settled => ({ ok: true, outcome: result.rows[0].r.outcome }),
    (error: { code?: string }): Settled => ({
      ok: false,
      code: error.code ?? "?",
    }),
  );

/** Waits until `pid` waits on a lock, so the race really is one. */
async function blocked(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await admin.query<{ w: string | null }>(
      "select wait_event_type as w from pg_stat_activity where pid = $1",
      [pid],
    );
    if (rows[0]?.w === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`connection ${pid} never waited on a lock`);
}

/**
 * Two acts from the same view on two connections: the first takes the deal's
 * row lock inside an open transaction, the second waits on it, and the first
 * commits. Resolves to both outcomes, each transaction committed if it
 * succeeded and rolled back otherwise.
 */
async function race(
  first: keyof typeof ACTS,
  firstInput: unknown,
  second: keyof typeof ACTS,
  secondInput: unknown,
  id: number,
  revision: string,
): Promise<[Settled, Settled]> {
  const one: PoolClient = await racers.connect();
  const two: PoolClient = await racers.connect();
  try {
    await one.query("begin");
    await two.query("begin");
    const pid = Number(
      (await two.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0].pid,
    );
    const a = await settle(
      one.query(ACTS[first], [TENANT_A, ACTOR, id, firstInput, revision]),
    );
    const pending = settle(
      two.query(ACTS[second], [TENANT_A, ACTOR, id, secondInput, revision]),
    );
    await blocked(pid);
    await one.query(a.ok ? "commit" : "rollback");
    const b = await pending;
    await two.query(b.ok ? "commit" : "rollback");
    return [a, b];
  } finally {
    one.release();
    two.release();
  }
}

describe("the commercial acts under concurrency", () => {
  it("exactly one of two moves from one revision commits; the other is refused as stale", async () => {
    const id = await deal("lead");
    const { revision } = await state(id);

    const [a, b] = await race(
      "move",
      "contact",
      "move",
      "proposal",
      id,
      revision,
    );

    expect(a).toEqual({ ok: true, outcome: "moved" });
    expect(b).toEqual({ ok: false, code: "OS409" });
    const after = await state(id);
    expect(after.stage).toBe("contact");
    expect(Number(after.transitions)).toBe(2);
    expect(Number(after.acts)).toBe(1);
  });

  it("a move and a conversion from one revision: the first wins and the second is refused", async () => {
    const id = await deal("proposal");
    const { revision } = await state(id);

    const [a, b] = await race(
      "move",
      "contact",
      "convert",
      "won",
      id,
      revision,
    );

    expect(a).toEqual({ ok: true, outcome: "moved" });
    expect(b).toEqual({ ok: false, code: "OS409" });
    const after = await state(id);
    expect(after.stage).toBe("contact");
    expect(after.converted).toBeNull();
  });

  it("a conversion and a loss from one revision never leave both outcomes, in either order", async () => {
    for (const [first, firstInput, second, secondInput] of [
      ["convert", "won", "lose", LOSS],
      ["lose", LOSS, "convert", "won"],
    ] as const) {
      const id = await deal("proposal");
      const { revision } = await state(id);

      const [a, b] = await race(
        first,
        firstInput,
        second,
        secondInput,
        id,
        revision,
      );

      expect(a.ok).toBe(true);
      expect(b).toEqual({ ok: false, code: "OS409" });
      const after = await state(id);
      expect([after.converted === null, after.lost === null].sort()).toEqual([
        false,
        true,
      ]);
    }
  });

  it("two next-action changes from one revision: one is set, the other refused, and no update is silently lost", async () => {
    const id = await deal("contact");
    const { revision } = await state(id);
    const one = new Date(Date.now() + 2 * 86_400_000);
    const two = new Date(Date.now() + 3 * 86_400_000);

    const [a, b] = await race("next", one, "next", two, id, revision);

    expect(a).toEqual({ ok: true, outcome: "set" });
    expect(b).toEqual({ ok: false, code: "OS409" });
    expect((await state(id)).next?.getTime()).toBe(one.getTime());
  });
});

describe("the next action and its follow-up", () => {
  /** A company, a department, a cadence and an enabled bridge in tenant A. */
  async function bridge(): Promise<void> {
    await admin.query(
      `select ops.configure_commercial_follow_up_bridge($1, true, c.id, d.id, null,
                (ops.define_follow_up_policy_version($1, 'dbtest-commercial', 'DB test cadence',
                                                     array[60, 1440], 'dbtest') ->> 'version_id')::uuid,
                'dbtest')
         from (select ops.create_company($1, 'dbtest-commercial', 'DB test commercial', 'dbtest') as id) c,
              lateral (select ops.create_department($1, c.id, 'dbtest-desk', 'DB test desk', 'dbtest') as id) d`,
      [TENANT_A],
    );
  }

  async function plans(id: number) {
    const { rows } = await admin.query<{ status: string; anchor: Date }>(
      `select p.status, p.anchor_at as anchor from ops.follow_up_plans p
        where p.tenant_id = $1 and p.subject_ref = 'deal:' || $2::text order by p.created_at, p.id`,
      [TENANT_A, id],
    );
    return rows;
  }

  it("commits the deal's next action and its planned follow-up together, and a rolled-back act leaves neither", async () => {
    await bridge();
    const id = await deal("contact");
    const first = new Date(
      Math.floor(Date.now() / 60_000) * 60_000 + 2 * 86_400_000,
    );
    const second = new Date(first.getTime() + 86_400_000);

    // Inside the act's transaction, nothing is visible elsewhere yet.
    const writer = await racers.connect();
    try {
      await writer.query("begin");
      const { rows } = await writer.query<{
        r: { followUp: { status: string } };
      }>(ACTS.next, [TENANT_A, ACTOR, id, first, (await state(id)).revision]);
      expect(rows[0].r.followUp.status).toBe("scheduled");
      expect((await state(id)).next).toBeNull();
      expect(await plans(id)).toEqual([]);
      await writer.query("commit");
    } finally {
      writer.release();
    }
    expect((await state(id)).next?.getTime()).toBe(first.getTime());
    expect(await plans(id)).toEqual([
      { status: "active", anchor: new Date(first.getTime() - 3_600_000) },
    ]);

    // A second change, rolled back: the deal, its plan and the act log stay.
    const before = await state(id);
    const rollback = await racers.connect();
    try {
      await rollback.query("begin");
      await rollback.query(ACTS.next, [
        TENANT_A,
        ACTOR,
        id,
        second,
        before.revision,
      ]);
      await rollback.query("rollback");
    } finally {
      rollback.release();
    }
    const after = await state(id);
    expect(after.next?.getTime()).toBe(first.getTime());
    expect(after.revision).toBe(before.revision);
    expect(after.acts).toBe(before.acts);
    expect(await plans(id)).toEqual([
      { status: "active", anchor: new Date(first.getTime() - 3_600_000) },
    ]);
  });
});

describe("the commercial acts through the member's gates", () => {
  /** One member call in a rolled-back transaction; its answer or its refusal. */
  async function asMember(
    sql: string,
    params: unknown[],
    before?: (tx: PoolClient) => Promise<void>,
  ): Promise<{
    value?: Record<string, unknown>;
    code?: string;
    message?: string;
    ms: number;
  }> {
    const tx = await racers.connect();
    const started = Date.now();
    try {
      await tx.query("begin");
      await signInAsMember(tx, TENANT_A, memberIdentity());
      if (before) await before(tx);
      const { rows } = await tx.query<{ r: Record<string, unknown> }>(
        sql,
        params,
      );
      return { value: rows[0].r, ms: Date.now() - started };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return { code: e.code, message: e.message, ms: Date.now() - started };
    } finally {
      await tx.query("rollback").catch(() => {});
      tx.release();
    }
  }

  it("moves a deal as a member through the gate, and refuses once the membership is revoked or the CRM changes hands", async () => {
    const id = await deal("lead");
    const { revision } = await state(id);
    const move =
      "select company_os_api.move_opportunity($1, 'contact', $2) as r";

    const done = await asMember(move, [id, revision]);
    expect(done.value).toMatchObject({
      dealRef: id,
      outcome: "moved",
      stage: "contact",
    });

    const revoked = await asMember(move, [id, revision], async (tx) => {
      await tx.query("reset role");
      await tx.query(
        `select ops.revoke_membership(m.id, 'dbtest', 'dbtest revoke')
           from ops.tenant_memberships m where m.revoked_at is null
            and m.principal_id = (select p.id from ops.principals p where p.display_name = 'dbtest member'
                                   order by p.created_at desc limit 1)`,
      );
      await tx.query("set local role authenticated");
    });
    expect(revoked).toMatchObject({
      code: "OS403",
      message: "company_os_api.move_opportunity: no access",
    });

    const moved = await asMember(move, [id, revision], async (tx) => {
      await tx.query("reset role");
      await tx.query(
        "update ops.tenants set owns_local_crm = false where id = $1",
        [TENANT_A],
      );
      await tx.query(
        "update ops.tenants set owns_local_crm = true where id = $1",
        [TENANT_B],
      );
      await tx.query("set local role authenticated");
    });
    expect(moved).toMatchObject({
      code: "OS403",
      message: "company_os_api.move_opportunity: no access",
    });
    // Every member session above was rolled back: the deal never moved.
    expect((await state(id)).stage).toBe("lead");
  });

  it("answers the one retryable OS429 while another writer holds the deal past the 2 s bound, and changes nothing", async () => {
    const id = await deal("lead");
    const { revision } = await state(id);
    const holder = await racers.connect();
    try {
      await holder.query("begin");
      await holder.query(
        "select 1 from public.deals where id = $1 for update",
        [id],
      );

      const answer = await asMember(
        "select company_os_api.move_opportunity($1, 'contact', $2) as r",
        [id, revision],
      );

      expect(answer).toMatchObject({
        code: "OS429",
        message:
          "company_os_api.move_opportunity: could not be completed yet; retry",
      });
      expect(answer.ms).toBeGreaterThanOrEqual(BOUND_MS - 100);
      expect(answer.ms).toBeLessThan(BOUND_MS + SLACK_MS);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    const after = await state(id);
    expect(after.stage).toBe("lead");
    expect(Number(after.acts)).toBe(0);
  });
});
