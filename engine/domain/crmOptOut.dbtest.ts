// The opt-out reaches the CRM after its acknowledgement (ADR 0026 §C), end to
// end: signed Meta deliveries through the gateway's own login, the real worker
// runtime, the real screening, the reply job and the record job, against a
// real Postgres. The contact's opt-out is recorded in the CRM's consent
// ledger as the system's once its acknowledgement settled (or at the window's
// end), and its exception reconciled; an acknowledgement still on its way is
// waited for; a person's dismissal records nothing and stops the unsent
// acknowledgement; a number's erasure records the pending opt-out first; an
// unknown number records nothing.
//
// ALL DATA IS SYNTHETIC (BASELINE Q8). Numbers, targets and texts are invented.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import {
  createFakeOutboundTransport,
  type ReplyTransport,
} from "../communication/replyTransport.ts";
import {
  removeFixtureModels,
  TENANT_A,
} from "../worker/testSupport/dbFixture.ts";
import {
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  openAgentRuntimeDatabases,
} from "./testSupport/agentRuntimeProbes.ts";
import {
  createFrontDeskHarness,
  DEAL_NAME,
  FRONT_DESK_MODELS,
  KNOWLEDGE,
  POLICY,
} from "./testSupport/frontDeskHarness.ts";
import {
  addCrmContact,
  deleteCrmContacts,
  gatewayDatabase,
  provisionGatewayRole,
} from "./testSupport/whatsappFixture.ts";

const TARGET = "200000000000935";
const DEVICE = "5511900000935";
const OPT_OUT = "Não quero mais receber mensagens.";
const AUTO_ACK = { ...POLICY, automaticFixedTexts: ["opt_out_ack"] };

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;
let gateway: WorkerDatabase;

beforeAll(() => {
  ({ admin, owner, db } = openAgentRuntimeDatabases());
  provisionGatewayRole();
  gateway = gatewayDatabase();
}, 60_000);

afterAll(async () => {
  await gateway.close();
  await removeFixtureModels(admin, FRONT_DESK_MODELS);
  await admin.query("delete from public.deals where name = $1", [DEAL_NAME]);
  await deleteCrmContacts(admin);
  await closeAgentRuntimeDatabases({ admin, owner, db });
});

const { prepare, frontDesk, runtime, drain, send, latest } =
  createFrontDeskHarness(() => ({ admin, owner, db, gateway }), {
    target: TARGET,
    device: DEVICE,
    messagePrefix: "OO",
  });

beforeEach(async () => {
  await deleteCrmContacts(admin);
  await prepare();
});

const { runAgentJob } = agentRuntimeProbes(() => ({ admin, owner, db }));

const fake = (): ReplyTransport & {
  readonly transport: ReturnType<typeof createFakeOutboundTransport>;
} => ({
  kind: "fake",
  transport: createFakeOutboundTransport(),
  timeoutMs: 1_000,
});

/** The CRM contact the device's number resolves to, and its flag. */
const contactFlag = async (): Promise<
  { id: string; flag: boolean } | undefined
> =>
  (
    await admin.query<{ id: string; flag: boolean }>(
      `select c.id::text as id, lp.do_not_contact as flag
         from public.contacts c
         join public.lead_profiles lp on lp.contact_id = c.id,
              jsonb_array_elements(c.phone_jsonb) e
        where regexp_replace(e ->> 'number', '[^0-9]', '', 'g') = $1`,
      [DEVICE],
    )
  ).rows[0];

const ledger = async (contactId: string) =>
  (
    await admin.query<{
      from_value: boolean | null;
      to_value: boolean;
      origin: string;
      reason_ref: string | null;
    }>(
      `select from_value, to_value, origin, reason_ref from public.lead_consent_changes
        where contact_id = $1::bigint order by changed_at, id`,
      [contactId],
    )
  ).rows;

const request = async () =>
  (
    await admin.query<{ outcome: string | null; job_id: string }>(
      "select outcome, job_id from ops.crm_opt_out_requests where tenant_id = $1",
      [TENANT_A],
    )
  ).rows;

const optOutException = async () =>
  (
    await admin.query<{
      id: string;
      occurrences: number;
      resolution: string | null;
    }>(
      `select id, occurrences, resolution from ops.exceptions
        where tenant_id = $1 and kind = 'opt_out' order by raised_at`,
      [TENANT_A],
    )
  ).rows;

/** Makes the queued record job due now (its acknowledgement's move, or the window's end). */
const recordDue = () =>
  admin.query(
    `update ops.jobs set available_at = now()
      where tenant_id = $1 and kind = 'crm.opt_out_record' and status = 'queued'`,
    [TENANT_A],
  );

const acts = async () =>
  (
    await admin.query<{ act: string }>(
      "select act from ops.crm_contact_acts where tenant_id = $1 order by recorded_at, id",
      [TENANT_A],
    )
  ).rows.map((row) => row.act);

describe("the opt-out reaches the CRM after its acknowledgement (ADR 0026 §C)", () => {
  it("records the opt-out as the system's once its automatic acknowledgement is sent, and reconciles the exception", async () => {
    await frontDesk(KNOWLEDGE, AUTO_ACK);
    await addCrmContact(admin, DEVICE);
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await send(OPT_OUT);
    await drain(registry);

    expect(reply.transport.calls).toHaveLength(1);
    const contact = await contactFlag();
    expect(contact?.flag).toBe(true);
    const { task_id: taskId } = await latest();
    expect(await ledger(contact!.id)).toEqual([
      {
        from_value: false,
        to_value: true,
        origin: "system_opt_out",
        reason_ref: `task:${taskId}`,
      },
    ]);
    expect(await request()).toMatchObject([{ outcome: "recorded" }]);
    expect(await optOutException()).toMatchObject([
      { resolution: "reconciled" },
    ]);
    expect(await acts()).toEqual(["opted_out"]);
    const { rows } = await admin.query<{ n: string }>(
      "select count(*)::text as n from ops.events where tenant_id = $1 and type = 'lead.opted_out'",
      [TENANT_A],
    );
    expect(rows[0].n).toBe("1");
  });

  it("keeps a supervised acknowledgement's opt-out until its window ends, then records it", async () => {
    await frontDesk(KNOWLEDGE, POLICY);
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime(undefined, { replyTransport: fake() });
    await send(OPT_OUT);
    await drain(registry);

    expect((await contactFlag())?.flag).toBe(false);
    const { rows } = await admin.query<{ later: boolean }>(
      `select j.available_at > now() + interval '23 hours' as later
         from ops.crm_opt_out_requests r join ops.jobs j on j.id = r.job_id
        where r.tenant_id = $1`,
      [TENANT_A],
    );
    expect(rows).toEqual([{ later: true }]);

    await recordDue();
    expect(await runAgentJob(registry)).toMatchObject({
      kind: "crm.opt_out_record",
      detail: "crm_opt_out_record=recorded",
    });
    expect((await contactFlag())?.flag).toBe(true);
  });

  it("waits for an acknowledgement still on its way, so the flag never refuses it", async () => {
    await frontDesk(KNOWLEDGE, AUTO_ACK);
    await addCrmContact(admin, DEVICE);
    // No transport: the acknowledgement is authorized and waits for one.
    const { registry: idle } = runtime();
    await send(OPT_OUT);
    await drain(idle);
    const before = await request();
    await recordDue();
    expect(await runAgentJob(idle)).toMatchObject({
      kind: "crm.opt_out_record",
      detail: "crm_opt_out_record=deferred",
    });
    expect((await contactFlag())?.flag).toBe(false);
    const after = await request();
    expect(after[0].outcome).toBeNull();
    expect(after[0].job_id).not.toBe(before[0].job_id);

    // A transport arrives: the acknowledgement leaves, then the opt-out is recorded.
    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await admin.query(
      `update ops.jobs set available_at = now()
        where tenant_id = $1 and kind = 'outbound.reply_send' and status = 'queued'`,
      [TENANT_A],
    );
    await drain(registry);
    expect(reply.transport.calls).toHaveLength(1);
    await recordDue();
    await drain(registry);
    expect((await contactFlag())?.flag).toBe(true);
    expect(await request()).toMatchObject([{ outcome: "recorded" }]);
  });

  it("records nothing for an opt-out a person dismissed, and stops its unsent acknowledgement", async () => {
    await frontDesk(KNOWLEDGE, AUTO_ACK);
    await addCrmContact(admin, DEVICE);
    const { registry: idle } = runtime();
    await send(OPT_OUT);
    await drain(idle);
    const [episode] = await optOutException();
    await admin.query(
      "select ops.resolve_exception($1, $2, 'dismissed', 'dbtest-person', $3)",
      [TENANT_A, episode.id, episode.occurrences],
    );

    const reply = fake();
    const { registry } = runtime(undefined, { replyTransport: reply });
    await admin.query(
      `update ops.jobs set available_at = now()
        where tenant_id = $1 and kind = 'outbound.reply_send' and status = 'queued'`,
      [TENANT_A],
    );
    await drain(registry);
    expect(reply.transport.calls).toHaveLength(0);
    const { rows } = await admin.query<{
      status: string;
      blocked_reason: string;
    }>(
      "select status, blocked_reason from ops.outbound_messages where tenant_id = $1",
      [TENANT_A],
    );
    expect(rows).toEqual([
      { status: "blocked", blocked_reason: "newer_message" },
    ]);

    await recordDue();
    expect(await runAgentJob(registry)).toMatchObject({
      kind: "crm.opt_out_record",
      detail: "crm_opt_out_record=dismissed",
    });
    expect((await contactFlag())?.flag).toBe(false);
    expect(await acts()).toEqual(["opt_out_dismissed"]);
  });

  it("records a pending opt-out before the number is erased, while the number still finds the contact", async () => {
    await frontDesk(KNOWLEDGE, POLICY);
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime(undefined, { replyTransport: fake() });
    await send(OPT_OUT);
    await drain(registry);
    expect((await contactFlag())?.flag).toBe(false);

    await admin.query(
      "select ops.erase_contact_by_number($1, $2, 'dbtest-owner')",
      [TENANT_A, DEVICE],
    );
    expect((await contactFlag())?.flag).toBe(true);
    expect(await request()).toMatchObject([{ outcome: "recorded" }]);
    await recordDue();
    expect(await runAgentJob(registry)).toMatchObject({
      kind: "crm.opt_out_record",
      detail: "crm_opt_out_record=already_settled",
    });
  });

  it("records nothing, and leaves the exception for a person, when no single contact has the number", async () => {
    await frontDesk(KNOWLEDGE, POLICY);
    const { registry } = runtime(undefined, { replyTransport: fake() });
    await send(OPT_OUT);
    await drain(registry);
    await recordDue();
    expect(await runAgentJob(registry)).toMatchObject({
      kind: "crm.opt_out_record",
      detail: "crm_opt_out_record=unresolved",
    });
    expect(await acts()).toContain("opt_out_unresolved");
    expect(await optOutException()).toMatchObject([{ resolution: null }]);
  });
});
