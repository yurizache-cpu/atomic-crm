// Every new WhatsApp number becomes a CRM lead (ADR 0026 §C), end to end:
// signed Meta deliveries through the gateway's own login, the real worker
// runtime and the real screening, against a real Postgres. A registered test
// sender the CRM does not know becomes a contact before the admission reads
// the CRM, so its first message is answered; with no policy in force it stays
// unknown; a profile name gives the first name only when it reads as a name;
// a near-duplicate is a person's to resolve; two deliveries of one message
// create one lead.
//
// ALL DATA IS SYNTHETIC (BASELINE Q8). Numbers, targets and texts are invented.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import {
  removeFixtureModels,
  TENANT_A,
} from "../worker/testSupport/dbFixture.ts";
import { recordLeadPolicy } from "./leadPolicy.ts";
import {
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
  deliver,
  gatewayDatabase,
  metaPayload,
  provisionGatewayRole,
} from "./testSupport/whatsappFixture.ts";

const TARGET = "200000000000934";
const DEVICE = "5511900000934";
const ADMINISTRATIVE = "Qual o valor da primeira sessão?";
const PLACEHOLDER = "dbtest-wa";

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

const { prepare, frontDesk, runtime, drain, latest } = createFrontDeskHarness(
  () => ({ admin, owner, db, gateway }),
  { target: TARGET, device: DEVICE, messagePrefix: "WL" },
);

beforeEach(async () => {
  await deleteCrmContacts(admin);
  await prepare();
});

const policy = (dailyCap = 50) =>
  owner.withTransaction((tx) =>
    recordLeadPolicy(tx, {
      tenantId: TENANT_A,
      dailyCap,
      timeZone: "America/Sao_Paulo",
      namePlaceholder: PLACEHOLDER,
      actor: "dbtest-owner",
    }),
  );

let sequence = 0;
/** One signed delivery from the device, with the profile name Meta reports. */
const send = (body: string, profileName?: string, id?: string) => {
  sequence += 1;
  return deliver(
    gateway,
    metaPayload(
      TARGET,
      { messages: [{ id: id ?? `wamid.WLX${sequence}`, from: DEVICE, body }] },
      profileName === undefined
        ? {}
        : { contacts: [{ profile: { name: profileName }, wa_id: DEVICE }] },
    ),
  );
};

const leadContacts = async () =>
  (
    await admin.query<{ id: string; first_name: string; phone: string }>(
      `select c.id::text as id, c.first_name, c.phone_jsonb::text as phone
         from public.contacts c, jsonb_array_elements(c.phone_jsonb) e
        where regexp_replace(e ->> 'number', '[^0-9]', '', 'g') = $1
        order by c.id`,
      [DEVICE],
    )
  ).rows;

const acts = async () =>
  (
    await admin.query<{ act: string }>(
      "select act from ops.crm_contact_acts where tenant_id = $1 order by recorded_at, id",
      [TENANT_A],
    )
  ).rows.map((row) => row.act);

describe("a new WhatsApp number becomes a CRM lead (ADR 0026 §C)", () => {
  it("creates the lead before the admission reads the CRM, so its first message is answered", async () => {
    await frontDesk(KNOWLEDGE, POLICY);
    await policy();
    const { provider, registry } = runtime();
    expect((await send(ADMINISTRATIVE, "Maria Silva")).status).toBe(200);
    await drain(registry);

    expect(await leadContacts()).toEqual([
      expect.objectContaining({ first_name: "Maria" }),
    ]);
    const out = await latest();
    expect(out).toMatchObject({
      disposition: "model",
      review_status: "pending",
    });
    expect(provider.calls).toHaveLength(1);
    const { rows } = await admin.query<{
      contact_resolution: string;
      do_not_contact: boolean;
    }>(
      "select contact_resolution, do_not_contact from ops.inbound_messages where task_id = $1",
      [out.task_id],
    );
    expect(rows).toEqual([
      { contact_resolution: "found", do_not_contact: false },
    ]);
    expect(await acts()).toEqual(["created"]);
    const events = await admin.query<{ n: string }>(
      "select count(*)::text as n from ops.events where tenant_id = $1 and type = 'lead.created'",
      [TENANT_A],
    );
    expect(events.rows[0].n).toBe("1");
  });

  it("keeps a new number unknown, and held for a person, while no policy is in force", async () => {
    await frontDesk(KNOWLEDGE, POLICY);
    const { provider, registry } = runtime();
    await send(ADMINISTRATIVE, "Maria Silva");
    await drain(registry);
    expect(await leadContacts()).toEqual([]);
    expect(await acts()).toEqual(["skipped:no_cap"]);
    expect(await latest()).toMatchObject({ disposition: "held_for_person" });
    expect(provider.calls).toHaveLength(0);
  });

  it("names the lead with the owner's placeholder when the profile name does not read as a name", async () => {
    await frontDesk(KNOWLEDGE, POLICY);
    await policy();
    const { registry } = runtime();
    await send(ADMINISTRATIVE, "Pare de me mandar");
    await drain(registry);
    expect(await leadContacts()).toEqual([
      expect.objectContaining({ first_name: PLACEHOLDER }),
    ]);
  });

  it("holds a near-duplicate for a person and creates nothing", async () => {
    await frontDesk(KNOWLEDGE, POLICY);
    await policy();
    // The same person without the country code: the last eight digits match.
    await addCrmContact(admin, DEVICE.slice(2));
    const { registry } = runtime();
    await send(ADMINISTRATIVE, "Maria Silva");
    await drain(registry);
    expect(await leadContacts()).toEqual([]);
    expect(await acts()).toEqual(["skipped:possible_match"]);
    const { rows } = await admin.query<{ detail: string; open: boolean }>(
      `select detail, resolved_at is null as open from ops.exceptions
        where tenant_id = $1 and kind = 'contact_unresolved'`,
      [TENANT_A],
    );
    expect(rows).toEqual([{ detail: "possible_match", open: true }]);
  });

  it("creates one lead, and records one act, for two deliveries of one message at once", async () => {
    await frontDesk(KNOWLEDGE, POLICY);
    await policy();
    const answers = await Promise.all([
      send(ADMINISTRATIVE, "Maria Silva", "wamid.WLDUP1"),
      send(ADMINISTRATIVE, "Maria Silva", "wamid.WLDUP1"),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(await leadContacts()).toHaveLength(1);
    expect(await acts()).toEqual(["created"]);
  });

  it("records one skip for two deliveries of one message at once with no policy", async () => {
    await frontDesk(KNOWLEDGE, POLICY);
    await Promise.all([
      send(ADMINISTRATIVE, undefined, "wamid.WLDUP2"),
      send(ADMINISTRATIVE, undefined, "wamid.WLDUP2"),
    ]);
    expect(await acts()).toEqual(["skipped:no_cap"]);
  });

  it("never creates a lead past the day's cap", async () => {
    await frontDesk(KNOWLEDGE, POLICY);
    await policy(1);
    // Another lead of the tenant took today's one place.
    await admin.query(
      `with other as (
         insert into ops.conversations (tenant_id, company_id, channel_id, contact_ref, last_inbound_at)
         select c.tenant_id, c.company_id, c.id, '5511900000999', now()
           from ops.communication_channels c where c.tenant_id = $1
         returning tenant_id, company_id, channel_id, id)
       insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act, crm_contact_ref)
       select tenant_id, company_id, id, channel_id, 'created', 'crm:contact:999999999' from other`,
      [TENANT_A],
    );
    await send(ADMINISTRATIVE, "Maria Silva");
    expect(await leadContacts()).toEqual([]);
    expect(await acts()).toEqual(["created", "skipped:cap"]);
  });
});
