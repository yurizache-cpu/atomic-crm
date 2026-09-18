// Phase 2B inbound, against a real Postgres, through the gateway's OWN
// constrained login (ops_gateway_login, provisioned by the real script) and the
// real handler: a signed Meta delivery becomes Company OS work exactly once, in
// the tenant its provider target was configured for, and only on a test
// channel while BASELINE Q8 is open.
//
// ALL DATA IS SYNTHETIC (BASELINE Q8). Numbers, targets and texts are invented.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import {
  resetFixtures,
  TENANT_A,
  TENANT_B,
} from "../worker/testSupport/dbFixture.ts";
import {
  closeAgentRuntimeDatabases,
  openAgentRuntimeDatabases,
} from "./testSupport/agentRuntimeProbes.ts";
import {
  addCrmContact,
  buildClinic,
  countRows,
  deleteCrmContacts,
  deliver,
  gatewayDatabase,
  metaPayload,
  provisionGatewayRole,
} from "./testSupport/whatsappFixture.ts";
import { configureWhatsAppChannel } from "./communicationChannels.ts";
import { createGatewayStore } from "./whatsappGatewayStore.ts";

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
  await deleteCrmContacts(admin);
  await closeAgentRuntimeDatabases({ admin, owner, db });
});

beforeEach(async () => {
  await deleteCrmContacts(admin);
  await resetFixtures(admin);
});

const TARGET_A = "200000000000101";
const TARGET_B = "200000000000202";
const LEAD = "5511900000101";
const BODY =
  "Oi, queria saber como funciona a primeira consulta. SENTINEL-INBOUND";

const inboundFor = async (tenantId: string) =>
  (
    await admin.query<{
      id: string;
      task_id: string | null;
      agent_run_id: string | null;
      conversation_id: string | null;
      contact_resolution: string | null;
      crm_contact_ref: string | null;
      do_not_contact: boolean;
      source_kind: string;
    }>(
      `select id, task_id, agent_run_id, conversation_id, contact_resolution,
              crm_contact_ref, do_not_contact, source_kind
         from ops.inbound_messages where tenant_id = $1 order by created_at`,
      [tenantId],
    )
  ).rows;

describe("a signed delivery to a configured test channel", () => {
  it("becomes one inbound admission, one task and one agent run, in the channel's tenant", async () => {
    const clinic = await buildClinic(owner, TENANT_A, TARGET_A);
    await addCrmContact(admin, LEAD);

    const answer = await deliver(
      gateway,
      metaPayload(TARGET_A, {
        messages: [{ id: "wamid.IN0101", from: LEAD, body: BODY }],
      }),
    );
    expect(answer.status).toBe(200);

    const [row] = await inboundFor(TENANT_A);
    expect(row).toMatchObject({
      source_kind: "whatsapp",
      contact_resolution: "found",
      do_not_contact: false,
    });
    expect(row.crm_contact_ref).toMatch(/^crm:contact:[0-9]+$/);
    expect(row.task_id).not.toBeNull();
    expect(row.agent_run_id).not.toBeNull();

    // The task carries the body, as in Phase 2A; the run waits for the runtime.
    const { rows: tasks } = await admin.query<{
      description: string;
      type: string;
      company_id: string;
    }>("select description, type, company_id from ops.tasks where id = $1", [
      row.task_id,
    ]);
    expect(tasks[0]).toEqual({
      description: BODY,
      type: "lead_triage",
      company_id: clinic.companyId,
    });
    expect(
      await countRows(
        admin,
        "select count(*)::text as count from ops.jobs where tenant_id = $1",
        [TENANT_A],
      ),
    ).toBe(1);
  });

  it("converges when Meta redelivers it, sequentially or at once", async () => {
    await buildClinic(owner, TENANT_A, TARGET_A);
    const payload = metaPayload(TARGET_A, {
      messages: [
        { id: "wamid.IN0102", from: LEAD, body: BODY, timestamp: 1789700000 },
      ],
    });

    expect((await deliver(gateway, payload)).status).toBe(200);
    expect((await deliver(gateway, payload)).status).toBe(200);
    const concurrent = await Promise.all([
      deliver(gateway, payload),
      deliver(gateway, payload),
      deliver(gateway, payload),
    ]);
    expect(concurrent.map((r) => r.status)).toEqual([200, 200, 200]);

    expect(await inboundFor(TENANT_A)).toHaveLength(1);
    expect(
      await countRows(
        admin,
        "select count(*)::text as count from ops.tasks where tenant_id = $1",
        [TENANT_A],
      ),
    ).toBe(1);
    expect(
      await countRows(
        admin,
        "select count(*)::text as count from ops.agent_runs where tenant_id = $1",
        [TENANT_A],
      ),
    ).toBe(1);
  });

  it("refuses the same message id carrying a different message on the record, and creates nothing else", async () => {
    await buildClinic(owner, TENANT_A, TARGET_A);
    await deliver(
      gateway,
      metaPayload(TARGET_A, {
        messages: [
          { id: "wamid.IN0103", from: LEAD, body: BODY, timestamp: 1789700000 },
        ],
      }),
    );
    const lines: string[] = [];
    const answer = await deliver(
      gateway,
      metaPayload(TARGET_A, {
        messages: [
          {
            id: "wamid.IN0103",
            from: LEAD,
            body: "A different message",
            timestamp: 1789700000,
          },
        ],
      }),
      (line) => lines.push(line),
    );
    // A conflict is permanent: acknowledged only with a durable, content-free
    // refusal on the record, never retried.
    expect(answer.status).toBe(200);
    expect(lines.join("\n")).toContain('"refusedMessages":1');
    expect(await inboundFor(TENANT_A)).toHaveLength(1);
    const { rows } = await admin.query<{ payload: Record<string, unknown> }>(
      "select payload from ops.events where tenant_id = $1 and type = 'communication.inbound_refused'",
      [TENANT_A],
    );
    expect(rows.map((r) => r.payload.reason)).toEqual(["admission_refused"]);
  });
});

describe("tenancy comes from the configured provider target, never the payload", () => {
  it("routes each target to its own tenant, and a payload field cannot pick another", async () => {
    await buildClinic(owner, TENANT_A, TARGET_A);
    await buildClinic(owner, TENANT_B, TARGET_B);

    await deliver(
      gateway,
      metaPayload(
        TARGET_B,
        { messages: [{ id: "wamid.IN0201", from: LEAD, body: BODY }] },
        // Anything a sender could smuggle in is not read.
        {
          tenant_id: TENANT_A,
          company_id: "c0000000-0000-4000-8000-000000000000",
          synthetic: true,
        },
      ),
    );
    expect(await inboundFor(TENANT_A)).toHaveLength(0);
    const [row] = await inboundFor(TENANT_B);
    expect(row).toBeDefined();
    // Tenant B does not own this deployment's CRM: the contact is unavailable
    // to it, and that is do-not-contact.
    expect(row).toMatchObject({
      contact_resolution: "unavailable",
      do_not_contact: true,
      crm_contact_ref: null,
    });
  });

  it("does not acknowledge a message for an unknown or paused target, and admits it once the channel is live again", async () => {
    const clinic = await buildClinic(owner, TENANT_A, TARGET_A);
    const lines: string[] = [];
    const unknown = await deliver(
      gateway,
      metaPayload("299999999999999", {
        messages: [{ id: "wamid.IN0301", from: LEAD, body: BODY }],
      }),
      (line) => lines.push(line),
    );
    expect(unknown.status).toBe(503);
    // The business's own number id, so an operator sees which one; never the sender.
    expect(lines.join("\n")).toContain('"target":"299999999999999"');
    expect(lines.join("\n")).not.toContain(LEAD);

    await owner.withTransaction((tx) =>
      tx.query(
        "update ops.communication_channels set active = false where id = $1",
        [clinic.channelId],
      ),
    );
    const paused = metaPayload(TARGET_A, {
      messages: [{ id: "wamid.IN0302", from: LEAD, body: BODY }],
    });
    expect((await deliver(gateway, paused)).status).toBe(503);
    expect(
      await countRows(
        admin,
        "select count(*)::text as count from ops.inbound_messages",
      ),
    ).toBe(0);

    // Meta delivers it again. The channel is live again, so it becomes work.
    await owner.withTransaction((tx) =>
      tx.query(
        "update ops.communication_channels set active = true where id = $1",
        [clinic.channelId],
      ),
    );
    expect((await deliver(gateway, paused)).status).toBe(200);
    expect(
      await countRows(
        admin,
        "select count(*)::text as count from ops.inbound_messages where external_message_id = 'wamid.IN0302'",
      ),
    ).toBe(1);
  });

  it("does not acknowledge a message for a paused triage agent, and admits it once the agent is active", async () => {
    const clinic = await buildClinic(owner, TENANT_A, TARGET_A);
    const setAgent = (status: string) =>
      owner.withTransaction((tx) =>
        tx.query("select ops.set_agent_status($1, $2, $3, 'dbtest-whatsapp')", [
          TENANT_A,
          clinic.agentId,
          status,
        ]),
      );
    const payload = metaPayload(TARGET_A, {
      messages: [{ id: "wamid.IN0303", from: LEAD, body: BODY }],
    });
    await setAgent("inactive");
    expect((await deliver(gateway, payload)).status).toBe(503);
    expect(
      await countRows(
        admin,
        "select count(*)::text as count from ops.inbound_messages",
      ),
    ).toBe(0);
    await setAgent("active");
    expect((await deliver(gateway, payload)).status).toBe(200);
    expect((await inboundFor(TENANT_A)).length).toBe(1);
  });

  it("gives the same WhatsApp id a separate conversation in each tenant", async () => {
    await buildClinic(owner, TENANT_A, TARGET_A);
    await buildClinic(owner, TENANT_B, TARGET_B);
    await deliver(
      gateway,
      metaPayload(TARGET_A, {
        messages: [{ id: "wamid.IN0401", from: LEAD, body: BODY }],
      }),
    );
    await deliver(
      gateway,
      metaPayload(TARGET_B, {
        messages: [{ id: "wamid.IN0402", from: LEAD, body: BODY }],
      }),
    );
    const { rows } = await admin.query<{ tenant_id: string }>(
      "select tenant_id from ops.conversations where contact_ref = $1 order by tenant_id",
      [LEAD],
    );
    expect(rows.map((r) => r.tenant_id).sort()).toEqual(
      [TENANT_A, TENANT_B].sort(),
    );
  });
});

describe("BASELINE Q8: the real-data gate is closed", () => {
  it("never makes a production channel live through the service", async () => {
    const clinic = await buildClinic(owner, TENANT_A, TARGET_A);
    const configure = (providerTarget: string, active?: boolean) =>
      owner.withTransaction((tx) =>
        configureWhatsAppChannel(tx, {
          tenantId: TENANT_A,
          companyId: clinic.companyId,
          agentId: clinic.agentId,
          providerTarget,
          mode: "production",
          label: "real number",
          actor: "dbtest",
          active,
        }),
      );
    // A new live production channel, and the live test channel turned into one.
    await expect(configure("200000000000909")).rejects.toThrow(
      /real-data gate is closed/,
    );
    await expect(configure(TARGET_A)).rejects.toThrow(
      /real-data gate is closed/,
    );
    // Inactive is allowed; re-activating it is refused like the rest.
    await configure("200000000000909", false);
    await expect(configure("200000000000909", true)).rejects.toThrow(
      /real-data gate is closed/,
    );
    expect(
      await countRows(
        admin,
        "select count(*)::text as count from ops.communication_channels where mode = 'production' and active",
      ),
    ).toBe(0);
  });

  it("does not acknowledge a message to a production target, and stores nothing about it", async () => {
    const clinic = await buildClinic(owner, TENANT_A, TARGET_A, "production");
    const payload = metaPayload(
      TARGET_A,
      { messages: [{ id: "wamid.IN0501", from: LEAD, body: BODY }] },
      // A payload cannot vouch for itself, or change the channel.
      { synthetic: true, mode: "test", active: true },
    );
    expect((await deliver(gateway, payload)).status).toBe(503);
    expect((await deliver(gateway, payload)).status).toBe(503);

    expect(
      await countRows(
        admin,
        "select count(*)::text as count from ops.inbound_messages where tenant_id = $1",
        [TENANT_A],
      ),
    ).toBe(0);
    expect(
      await countRows(
        admin,
        "select count(*)::text as count from ops.tasks where tenant_id = $1",
        [TENANT_A],
      ),
    ).toBe(0);
    expect(
      await countRows(
        admin,
        "select count(*)::text as count from ops.agent_runs where tenant_id = $1",
        [TENANT_A],
      ),
    ).toBe(0);
    expect(
      await countRows(
        admin,
        "select count(*)::text as count from ops.conversations where tenant_id = $1",
        [TENANT_A],
      ),
    ).toBe(0);

    // Not acknowledged, so nothing about it is recorded either.
    expect(
      await countRows(
        admin,
        "select count(*)::text as count from ops.events where tenant_id = $1 and type in ('communication.inbound_held', 'communication.inbound_refused', 'communication.received')",
        [TENANT_A],
      ),
    ).toBe(0);
    const { rows: channel } = await admin.query<{
      mode: string;
      active: boolean;
    }>("select mode, active from ops.communication_channels where id = $1", [
      clinic.channelId,
    ]);
    expect(channel).toEqual([{ mode: "production", active: false }]);
  });
});

describe("nothing is acknowledged in silence", () => {
  it("acknowledges a message it cannot admit only with a content-free refusal on the record", async () => {
    await buildClinic(owner, TENANT_A, TARGET_A);
    const now = String(Math.floor(Date.now() / 1000));
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "100000000000001",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "15550000000",
                  phone_number_id: TARGET_A,
                },
                messages: [
                  {
                    from: LEAD,
                    id: "wamid.IN0901",
                    timestamp: now,
                    type: "image",
                    image: { id: "media-1" },
                  },
                  {
                    from_user_id: "BR.bsuid.1",
                    id: "wamid.IN0902",
                    timestamp: now,
                    type: "text",
                    text: { body: BODY },
                  },
                  {
                    from: LEAD,
                    id: "wamid.IN0903",
                    timestamp: now,
                    type: "text",
                    text: { body: `${BODY} ${"x".repeat(4100)}` },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const lines: string[] = [];
    expect((await deliver(gateway, payload, (l) => lines.push(l))).status).toBe(
      200,
    );
    expect((await deliver(gateway, payload)).status).toBe(200);

    // One fact per message across both deliveries: the reason, the channel and,
    // with a sender number, the conversation. Never the body or the number.
    const { rows } = await admin.query<{ payload: Record<string, unknown> }>(
      "select payload from ops.events where tenant_id = $1 and type = 'communication.inbound_refused' order by payload ->> 'reason'",
      [TENANT_A],
    );
    expect(rows.map((r) => r.payload.reason)).toEqual([
      "body_too_long",
      "no_sender_number",
      "unsupported_content",
    ]);
    for (const { payload: fact } of rows) {
      expect(
        Object.keys(fact).every((k) =>
          ["channel_id", "conversation_id", "reason"].includes(k),
        ),
      ).toBe(true);
      expect(JSON.stringify(fact)).not.toContain(LEAD);
    }
    expect(
      await countRows(
        admin,
        "select count(*)::text as count from ops.inbound_messages",
      ),
    ).toBe(0);
    expect(
      await countRows(
        admin,
        "select count(*)::text as count from ops.tasks where description like '%SENTINEL%'",
      ),
    ).toBe(0);
    expect(lines.join("\n")).not.toContain("SENTINEL");
    expect(lines.join("\n")).not.toContain(LEAD);
  });

  it("admits a message whose timestamp is ahead of the database's clock", async () => {
    await buildClinic(owner, TENANT_A, TARGET_A);
    const answer = await createGatewayStore(gateway).receiveMessage({
      providerTarget: TARGET_A,
      externalMessageId: "wamid.IN0904",
      from: LEAD,
      body: BODY,
      receivedAt: new Date(Date.now() + 3_600_000),
    });
    expect(answer).toBe("admitted");
    expect(
      await countRows(
        admin,
        "select count(*)::text as count from ops.inbound_messages where external_message_id = 'wamid.IN0904' and received_at <= now()",
      ),
    ).toBe(1);
  });
});

describe("the CRM is read, never written", () => {
  it("resolves found, not found and ambiguous without creating or changing a contact", async () => {
    await buildClinic(owner, TENANT_A, TARGET_A);
    await addCrmContact(admin, "5511900000111");
    await addCrmContact(admin, "5511900000222");
    await addCrmContact(admin, "5511900000222");
    const before = await admin.query<{ c: string; p: string; x: string }>(
      `select (select count(*) from public.contacts)::text as c,
              (select count(*) from public.lead_profiles)::text as p,
              (select md5(string_agg(lp.id || ':' || lp.do_not_contact || ':' || lp.updated_at, ',' order by lp.id))
                 from public.lead_profiles lp) as x`,
    );

    await deliver(
      gateway,
      metaPayload(TARGET_A, {
        messages: [
          { id: "wamid.IN0601", from: "5511900000111", body: BODY },
          { id: "wamid.IN0602", from: "5511900000333", body: BODY },
          { id: "wamid.IN0603", from: "5511900000222", body: BODY },
        ],
      }),
    );
    const rows = await inboundFor(TENANT_A);
    expect(rows.map((r) => [r.contact_resolution, r.do_not_contact])).toEqual([
      ["found", false],
      ["not_found", true],
      ["ambiguous", true],
    ]);

    const after = await admin.query<{ c: string; p: string; x: string }>(
      `select (select count(*) from public.contacts)::text as c,
              (select count(*) from public.lead_profiles)::text as p,
              (select md5(string_agg(lp.id || ':' || lp.do_not_contact || ':' || lp.updated_at, ',' order by lp.id))
                 from public.lead_profiles lp) as x`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("records an opted-out contact as do-not-contact at admission", async () => {
    await buildClinic(owner, TENANT_A, TARGET_A);
    await addCrmContact(admin, LEAD, { doNotContact: true });
    await deliver(
      gateway,
      metaPayload(TARGET_A, {
        messages: [{ id: "wamid.IN0701", from: LEAD, body: BODY }],
      }),
    );
    expect((await inboundFor(TENANT_A))[0]).toMatchObject({
      contact_resolution: "found",
      do_not_contact: true,
    });
  });
});

describe("conversations group messages; they never merge work", () => {
  it("links two messages from one contact to one conversation and two tasks", async () => {
    await buildClinic(owner, TENANT_A, TARGET_A);
    await deliver(
      gateway,
      metaPayload(TARGET_A, {
        messages: [
          { id: "wamid.IN0801", from: LEAD, body: "First message" },
          { id: "wamid.IN0802", from: LEAD, body: "Second message" },
        ],
      }),
    );
    const rows = await inboundFor(TENANT_A);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.conversation_id)).size).toBe(1);
    expect(new Set(rows.map((r) => r.task_id)).size).toBe(2);
    const { rows: tasks } = await admin.query<{ description: string }>(
      "select description from ops.tasks where tenant_id = $1 order by created_at",
      [TENANT_A],
    );
    // Each task carries its own message only: nothing is concatenated.
    expect(tasks.map((t) => t.description)).toEqual([
      "First message",
      "Second message",
    ]);
  });
});

describe("content stays out of facts and logs", () => {
  it("records no body or sender in any event, and logs neither", async () => {
    await buildClinic(owner, TENANT_A, TARGET_A);
    await addCrmContact(admin, LEAD);
    const lines: string[] = [];
    await deliver(
      gateway,
      metaPayload(TARGET_A, {
        messages: [{ id: "wamid.IN0901", from: LEAD, body: BODY }],
      }),
      (line) => lines.push(line),
    );
    const { rows } = await admin.query<{ payload: unknown }>(
      "select payload from ops.events where tenant_id = $1",
      [TENANT_A],
    );
    const facts = JSON.stringify(rows);
    expect(facts).not.toContain("SENTINEL");
    expect(facts).not.toContain(LEAD);
    const logged = lines.join("\n");
    expect(logged).not.toContain("SENTINEL");
    expect(logged).not.toContain(LEAD);
  });
});
