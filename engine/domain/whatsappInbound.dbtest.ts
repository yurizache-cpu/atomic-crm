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

  it("refuses the same message id carrying a different message, and creates nothing", async () => {
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
    // A conflict is permanent: acknowledged, recorded as refused, never retried.
    expect(answer.status).toBe(200);
    expect(lines.join("\n")).toContain('"code":"OS409"');
    expect(await inboundFor(TENANT_A)).toHaveLength(1);
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

  it("refuses an unknown or inactive target without admitting anything", async () => {
    const clinic = await buildClinic(owner, TENANT_A, TARGET_A);
    const lines: string[] = [];
    const unknown = await deliver(
      gateway,
      metaPayload("299999999999999", {
        messages: [{ id: "wamid.IN0301", from: LEAD, body: BODY }],
      }),
      (line) => lines.push(line),
    );
    expect(unknown.status).toBe(200);
    expect(lines.join("\n")).toContain('"code":"OS404"');

    await owner.withTransaction((tx) =>
      tx.query(
        "update ops.communication_channels set active = false where id = $1",
        [clinic.channelId],
      ),
    );
    await deliver(
      gateway,
      metaPayload(TARGET_A, {
        messages: [{ id: "wamid.IN0302", from: LEAD, body: BODY }],
      }),
    );
    expect(
      await countRows(
        admin,
        "select count(*)::text as count from ops.inbound_messages",
      ),
    ).toBe(0);
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

describe("BASELINE Q8: a production channel creates no work", () => {
  it("holds a message to a production target: no ledger row, no task, no run, only the fact", async () => {
    const clinic = await buildClinic(owner, TENANT_A, TARGET_A, "production");
    const payload = metaPayload(
      TARGET_A,
      { messages: [{ id: "wamid.IN0501", from: LEAD, body: BODY }] },
      // A payload cannot vouch for itself.
      { synthetic: true, mode: "test" },
    );
    expect((await deliver(gateway, payload)).status).toBe(200);
    expect((await deliver(gateway, payload)).status).toBe(200);

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

    // One held fact across both deliveries, naming the channel and nothing else.
    const { rows: held } = await admin.query<{
      payload: Record<string, unknown>;
    }>(
      "select payload from ops.events where tenant_id = $1 and type = 'communication.inbound_held'",
      [TENANT_A],
    );
    expect(held).toEqual([
      {
        payload: {
          channel_id: clinic.channelId,
          reason: "q8_production_channel",
        },
      },
    ]);
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
