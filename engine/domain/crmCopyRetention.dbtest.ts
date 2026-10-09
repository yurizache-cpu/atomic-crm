// The CRM copy of a WhatsApp lead follows the number's retention (ADR 0026
// §C), end to end: signed Meta deliveries through the gateway's own login, the
// real worker runtime and the owner's erasure, against a real Postgres. A lead
// the gateway created and no one worked on is deleted, with its lead profile
// and attribution, when its number's retention ends; a lead a person is
// writing a note on while the number is erased is kept, and the note survives.
//
// ALL DATA IS SYNTHETIC (BASELINE Q8). Numbers, targets and texts are invented.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import {
  removeFixtureModels,
  TENANT_A,
} from "../worker/testSupport/dbFixture.ts";
import { waitUntil } from "../worker/testSupport/spendProbes.ts";
import { eraseContactByNumber } from "./contactIdentifiers.ts";
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
  deleteCrmContacts,
  deliver,
  gatewayDatabase,
  metaPayload,
  provisionGatewayRole,
  type Clinic,
} from "./testSupport/whatsappFixture.ts";

const TARGET = "200000000000937";
const TARGET_B = "200000000000938";
const DEVICE = "5511900000937";
const ADMINISTRATIVE = "Qual o valor da primeira sessão?";
const THIRTEEN_MONTHS_S = 13 * 31 * 24 * 60 * 60;

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;
let gateway: WorkerDatabase;
let clinic: Clinic;

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

const { prepare, frontDesk, runtime, drain } = createFrontDeskHarness(
  () => ({ admin, owner, db, gateway }),
  { target: TARGET, device: DEVICE, messagePrefix: "CR" },
);

beforeEach(async () => {
  await deleteCrmContacts(admin);
  await prepare();
  clinic = await frontDesk(KNOWLEDGE, POLICY);
  await owner.withTransaction((tx) =>
    recordLeadPolicy(tx, {
      tenantId: TENANT_A,
      dailyCap: 50,
      timeZone: "America/Sao_Paulo",
      namePlaceholder: "dbtest-wa",
      actor: "dbtest-owner",
    }),
  );
});

let sequence = 0;
/** One signed delivery from the device, at an instant in Unix seconds. */
const send = async (timestamp?: number): Promise<void> => {
  sequence += 1;
  const answer = await deliver(
    gateway,
    metaPayload(TARGET, {
      messages: [
        {
          id: `wamid.CRX${sequence}`,
          from: DEVICE,
          body: ADMINISTRATIVE,
          timestamp,
        },
      ],
    }),
  );
  expect(answer.status).toBe(200);
};

/** The CRM contact the device's number resolves to, if any. */
const lead = async (): Promise<string | undefined> =>
  (
    await admin.query<{ id: string }>(
      `select c.id::text as id from public.contacts c, jsonb_array_elements(c.phone_jsonb) e
        where regexp_replace(e ->> 'number', '[^0-9]', '', 'g') = $1`,
      [DEVICE],
    )
  ).rows[0]?.id;

const acts = async () =>
  (
    await admin.query<{ act: string }>(
      "select act from ops.crm_contact_acts where tenant_id = $1 order by act",
      [TENANT_A],
    )
  ).rows.map((row) => row.act);

describe("the CRM copy of a WhatsApp lead follows the number's retention (ADR 0026 §C)", () => {
  it("deletes the lead no one worked on, with its profile and attribution, when its number's retention ends", async () => {
    await send(Math.floor(Date.now() / 1000) - THIRTEEN_MONTHS_S);
    const contactId = await lead();
    expect(contactId).toBeDefined();

    // The number's retention job is due: the worker erases the number.
    await drain(runtime().registry);
    expect(await lead()).toBeUndefined();
    const { rows } = await admin.query<{ n: string }>(
      `select (select count(*) from public.contacts where id = $1::bigint)
            + (select count(*) from public.lead_profiles where contact_id = $1::bigint)
            + (select count(*) from public.acquisition_attributions where contact_id = $1::bigint) as n`,
      [contactId],
    );
    expect(rows[0].n).toBe("0");
    expect(await acts()).toEqual(["created", "deleted"]);
    const erased = await admin.query<{ erased: boolean }>(
      "select contact_erased_at is not null as erased from ops.conversations where tenant_id = $1",
      [TENANT_A],
    );
    expect(erased.rows).toEqual([{ erased: true }]);
  });

  it("keeps the lead a person is writing a note on while the number is erased, and the note survives", async () => {
    await send();
    const contactId = await lead();
    expect(contactId).toBeDefined();

    const person = await admin.connect();
    let erasure: Promise<unknown> | undefined;
    try {
      await person.query("begin");
      await person.query(
        "insert into public.contact_notes (contact_id, text) values ($1::bigint, 'A person''s note')",
        [contactId],
      );
      erasure = owner.withTransaction((tx) =>
        eraseContactByNumber(tx, {
          tenantId: TENANT_A,
          number: DEVICE,
          actor: "dbtest-owner",
        }),
      );
      // The erasure waits for the person's transaction on the contact.
      await waitUntil(
        async () =>
          (
            await admin.query<{ waiting: boolean }>(
              "select exists (select 1 from pg_locks where not granted) as waiting",
            )
          ).rows[0].waiting,
        "the erasure did not wait for the person's note",
        1_500,
      );
      await person.query("commit");
    } finally {
      person.release();
    }
    await expect(erasure).resolves.toEqual({ conversationsErased: 1 });

    expect(await lead()).toBe(contactId);
    const notes = await admin.query<{ n: string }>(
      "select count(*)::text as n from public.contact_notes where contact_id = $1::bigint",
      [contactId],
    );
    expect(notes.rows[0].n).toBe("1");
    expect(await acts()).toEqual(["created", "kept"]);
  });

  it("holds every conversation of the number before any CRM row, so a screening on its second conversation never waits on it in a cycle", async () => {
    const { rows: channels } = await admin.query<{ id: string }>(
      "select ops.configure_whatsapp_channel($1, $2, $3, $4, 'test', 'dbtest channel B', 'dbtest') as id",
      [TENANT_A, clinic.companyId, clinic.agentId, TARGET_B],
    );
    await admin.query("select ops.register_test_sender($1, $2, $3, 'dbtest')", [
      TENANT_A,
      channels[0].id,
      DEVICE,
    ]);
    await send();
    const contactId = await lead();
    const second = await deliver(
      gateway,
      metaPayload(TARGET_B, {
        messages: [{ id: "wamid.CRB1", from: DEVICE, body: ADMINISTRATIVE }],
      }),
    );
    expect(second.status).toBe(200);
    const { rows: conversations } = await admin.query<{ id: string }>(
      "select id from ops.conversations where channel_id = $1",
      [channels[0].id],
    );

    // A screening on the second conversation holds it, as the lift does.
    const screening = await admin.connect();
    let erasure: Promise<unknown> | undefined;
    try {
      await screening.query("begin");
      await screening.query(
        "select 1 from ops.conversations where id = $1 for key share",
        [conversations[0].id],
      );
      erasure = owner.withTransaction((tx) =>
        eraseContactByNumber(tx, {
          tenantId: TENANT_A,
          number: DEVICE,
          actor: "dbtest-owner",
        }),
      );
      await waitUntil(
        async () =>
          (
            await admin.query<{ waiting: boolean }>(
              "select exists (select 1 from pg_locks where not granted) as waiting",
            )
          ).rows[0].waiting,
        "the erasure did not wait for the second conversation",
        1_500,
      );
      // The erasure holds no CRM row while it waits: the lift can take the profile.
      await expect(
        admin.query(
          "select 1 from public.lead_profiles where contact_id = $1::bigint for update nowait",
          [contactId],
        ),
      ).resolves.toBeDefined();
      await screening.query("commit");
    } finally {
      screening.release();
    }
    await expect(erasure).resolves.toEqual({ conversationsErased: 2 });
    expect(await lead()).toBeUndefined();
  });
});
