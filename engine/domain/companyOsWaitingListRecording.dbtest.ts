// The recorded waiting list the browser tests replay (ADR 0026 §D), read from
// the REAL projection, never hand-built.
//
// The shared recordings (companyOsRecordedResponses.dbtest.ts) carry an empty
// waiting list. This suite records one populated list of its own, at a FIXED
// instant. One rolled-back transaction:
//   * builds a fresh tenant with a clinic, its test channel and five
//     conversations, each with a task and its open episodes (a request for a
//     person, waiting messages, both), and one resolved episode;
//   * records the owner's target and plants notifications in each state the
//     screen shows (delivered, carried by that digest, failed, pending, none);
//   * moves every instant to 2030 with the guards off, because they stamp the
//     real clock and no fixed recording could hold it; the rules themselves are
//     proven by supabase/tests/owner_notifications.sql and
//     ownerNotifications.dbtest.ts;
//   * then reads ops.cos_waiting_list(tenant, AS_OF).
//
// The task references are mapped to deterministic ids by fixture label (a
// reference the recorder cannot place fails the recording). The result is
// parsed with its contract, swept for every number and id the fixture planted,
// and compared with src/company-os/testing/recorded/waiting-list.json:
//
//   COMPANY_OS_RECORD=1 SUPABASE_DB_CONTAINER=supabase_db_atomic-crm-e2e \
//     SUPABASE_DB_PORT=54342 npx vitest run --config vitest.db.config.ts \
//     engine/domain/companyOsWaitingListRecording.dbtest.ts
//
// Without COMPANY_OS_RECORD=1 nothing is written. All data is synthetic and
// nothing outlives the transaction.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { format, resolveConfig } from "prettier";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WaitingListSchema } from "../../contracts/company-os-api/index.ts";
import {
  adminPool,
  assertTargetDatabase,
} from "../worker/testSupport/dbFixture.ts";

const RECORDING = join(
  fileURLToPath(new URL("../../", import.meta.url)),
  "src/company-os/testing/recorded/waiting-list.json",
);

/** Monday 2030-03-04, 10:30 in São Paulo. */
const AS_OF = new Date("2030-03-04T13:30:00Z");
const SOURCE = "rec-waiting";
const TARGET = "200000000000990";
const OWNER = "5511900000999";

const minutesBefore = (minutes: number): Date =>
  new Date(AS_OF.getTime() - minutes * 60_000);

interface Planted {
  readonly label: string;
  readonly contact: string;
  /** The contact's last message, minutes before AS_OF. */
  readonly lastMessage: number;
  /** Open episodes: kind, minutes before AS_OF, occurrences. */
  readonly episodes: readonly (readonly [string, number, number])[];
}

const CONVERSATIONS: readonly Planted[] = [
  {
    label: "w1",
    contact: "5511900000991",
    lastMessage: 50,
    episodes: [["person_requested", 50, 1]],
  },
  {
    label: "w2",
    contact: "5511900000992",
    lastMessage: 10,
    episodes: [
      ["person_requested", 40, 1],
      ["message_waiting", 30, 3],
    ],
  },
  {
    label: "w3",
    contact: "5511900000993",
    lastMessage: 25 * 60,
    episodes: [["message_waiting", 26 * 60, 2]],
  },
  {
    label: "w4",
    contact: "5511900000994",
    lastMessage: 5,
    episodes: [["person_requested", 5, 1]],
  },
  {
    label: "w5",
    contact: "5511900000995",
    lastMessage: 2,
    episodes: [["message_waiting", 2, 1]],
  },
];

let admin: Pool;

beforeAll(async () => {
  admin = adminPool();
  await assertTargetDatabase(admin);
});

afterAll(async () => {
  await admin?.end();
});

async function one<T>(
  client: PoolClient,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T> {
  const { rows } = await client.query<{ result: T }>(sql, [...params]);
  return rows[0].result;
}

interface Built {
  readonly tenantId: string;
  /** Task id -> fixture label. */
  readonly tasks: ReadonlyMap<string, string>;
  /** Every id and number the recording must not carry. */
  readonly planted: readonly string[];
}

async function build(client: PoolClient): Promise<Built> {
  const tenantId = await one<string>(
    client,
    `insert into ops.tenants (id, slug, name)
     values (gen_random_uuid(), 'rec-waiting', 'Recorded waiting list') returning id as result`,
  );
  const companyId = await one<string>(
    client,
    "select ops.create_company($1, 'rec-waiting-clinic', 'Clinic', $2, null, null) as result",
    [tenantId, SOURCE],
  );
  const departmentId = await one<string>(
    client,
    "select ops.create_department($1, $2, 'reception', 'Reception', $3, null, null) as result",
    [tenantId, companyId, SOURCE],
  );
  const agentId = await one<string>(
    client,
    `select ops.create_agent($1, $2, $3, 'front-desk', 'Front desk', 'Receptionist', $4,
                             'Answers contacts.', null, null) as result`,
    [tenantId, companyId, departmentId, SOURCE],
  );
  const channelId = await one<string>(
    client,
    "select ops.configure_whatsapp_channel($1, $2, $3, $4, 'test', 'rec channel', 'rec-owner', true) as result",
    [tenantId, companyId, agentId, TARGET],
  );

  const tasks = new Map<string, string>();
  const planted: string[] = [tenantId, companyId, channelId, OWNER];
  const episodes = new Map<string, string>();
  const conversations = new Map<string, string>();
  for (const spec of CONVERSATIONS) {
    const conversationId = await one<string>(
      client,
      `insert into ops.conversations (tenant_id, company_id, channel_id, contact_ref, last_inbound_at)
       values ($1, $2, $3, $4, now()) returning id as result`,
      [tenantId, companyId, channelId, spec.contact],
    );
    conversations.set(spec.label, conversationId);
    planted.push(conversationId, spec.contact);
    const taskId = await one<string>(
      client,
      `select ops.create_task($1, $2, 'lead_triage', 'WhatsApp message', $3, null, $4, null, 100,
                              null, null, null, null, 'test') as result`,
      [tenantId, companyId, SOURCE, departmentId],
    );
    tasks.set(taskId, spec.label);
    for (const [kind] of spec.episodes) {
      const id = await one<string>(
        client,
        "select ops.open_exception($1, $2, $3, $4, $5, null, null, 'rec-waiting') as result",
        [tenantId, companyId, taskId, kind, conversationId],
      );
      episodes.set(`${spec.label}:${kind}`, id);
      planted.push(id);
    }
  }
  // A resolved episode is no one's to wait for.
  const resolved = await one<string>(
    client,
    "select ops.open_exception($1, $2, $3, 'person_requested', $4, null, null, 'rec-waiting') as result",
    [
      tenantId,
      companyId,
      [...tasks.keys()][0],
      await one<string>(
        client,
        `insert into ops.conversations (tenant_id, company_id, channel_id, contact_ref, last_inbound_at)
         values ($1, $2, $3, '5511900000996', now()) returning id as result`,
        [tenantId, companyId, channelId],
      ),
    ],
  );
  await client.query(
    "select ops.close_exception($1, 'released', 'rec-waiting')",
    [resolved],
  );

  // The owner's target, then a notification in each state the screen shows.
  const targetId = await one<string>(
    client,
    `select ops.record_owner_notification_target($1, $2, $3, 'aviso_fila_conversa', 'aviso_fila_resumo',
                                                 'rec-owner') as result`,
    [tenantId, channelId, OWNER],
  );
  await client.query(
    "alter table ops.owner_notifications disable trigger owner_notifications_guard",
  );
  await client.query(
    "alter table ops.exceptions disable trigger exceptions_guard",
  );
  await client.query(
    "alter table ops.conversations disable trigger conversations_guard_update",
  );
  const notify = async (
    label: string,
    kind: string,
    status: string,
    minutes: number,
    extra: { readonly carriedBy?: string; readonly sent?: boolean } = {},
  ): Promise<string> => {
    const id = await one<string>(client, "select gen_random_uuid() as result");
    const job = await one<string>(
      client,
      `select ops.enqueue_job($1, 'owner_notification.send', jsonb_build_object('owner_notification_id', $2::text),
                              100, now(), 5, $3) as result`,
      [tenantId, id, `owner_notification:${id}`],
    );
    const at = minutesBefore(minutes);
    const sent = extra.sent === true;
    await client.query(
      `insert into ops.owner_notifications (
         id, tenant_id, company_id, exception_id, conversation_id, kind, trigger_seq, waiting_since, target_id,
         unit_company_id, unit_department_id, unit_agent_id, job_id, status, carried_by, recorded_at, due_at,
         expires_at, send_channel_id, template_kind, transport, job_attempt, sending_at, settled_at,
         delivered_at, provider_message_key, error_class)
       values ($1, $2, $3, $4, $5, $6, 1, $7::timestamptz, $8, $3, $9, $10, $11, $12, $13, $7::timestamptz,
               $7::timestamptz + interval '1 minute',
               $7::timestamptz + interval '1 day', $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [
        id,
        tenantId,
        companyId,
        episodes.get(`${label}:${kind}`),
        conversations.get(label),
        kind,
        at,
        targetId,
        departmentId,
        agentId,
        job,
        status,
        extra.carriedBy ?? null,
        sent ? channelId : null,
        sent ? "episode" : null,
        sent ? "meta" : null,
        sent ? 1 : null,
        sent ? new Date(at.getTime() + 60_000) : null,
        sent ? new Date(at.getTime() + 61_000) : null,
        status === "delivered" ? new Date(at.getTime() + 90_000) : null,
        status === "delivered" ? "0".repeat(64) : null,
        status === "failed" ? "provider_rejected" : null,
      ],
    );
    planted.push(id, job);
    return id;
  };
  const carrier = await notify("w1", "person_requested", "delivered", 49, {
    sent: true,
  });
  await notify("w2", "person_requested", "coalesced", 39, {
    carriedBy: carrier,
  });
  await notify("w3", "message_waiting", "failed", 26 * 60 - 1, { sent: true });
  await notify("w4", "person_requested", "pending", 4);

  // Every instant in 2030.
  for (const spec of CONVERSATIONS) {
    await client.query(
      "update ops.conversations set last_inbound_at = $2 where id = $1",
      [conversations.get(spec.label), minutesBefore(spec.lastMessage)],
    );
    for (const [kind, minutes, occurrences] of spec.episodes) {
      await client.query(
        `update ops.exceptions set raised_at = $2, last_raised_at = $2, occurrences = $3 where id = $1`,
        [
          episodes.get(`${spec.label}:${kind}`),
          minutesBefore(minutes),
          occurrences,
        ],
      );
    }
  }
  return { tenantId, tasks, planted };
}

/** Each task reference as a deterministic id by fixture label: w1 -> ...0001. */
function mapRefs(value: unknown, tasks: ReadonlyMap<string, string>): unknown {
  return JSON.parse(JSON.stringify(value), (key, v) => {
    if (key !== "ref") return v;
    const label = tasks.get(v as string);
    if (label === undefined)
      throw new Error(
        `the waiting list names a task the recorder cannot place: ${v}`,
      );
    return `00000000-0000-4000-8000-${label.slice(1).padStart(12, "0")}`;
  });
}

async function record(): Promise<{
  list: unknown;
  planted: readonly string[];
}> {
  const client = await admin.connect();
  try {
    await client.query("begin");
    const built = await build(client);
    const list = await one<unknown>(
      client,
      "select ops.cos_waiting_list($1, $2) as result",
      [built.tenantId, AS_OF],
    );
    return { list: mapRefs(list, built.tasks), planted: built.planted };
  } finally {
    await client.query("rollback");
    client.release();
  }
}

describe("the recorded waiting list is the real projection at a fixed instant", () => {
  it("parses with its contract, leaks nothing the fixture planted, and equals the committed recording", async () => {
    // Arrange / Act
    const { list, planted } = await record();

    // Assert: the contract, FIFO order, and every state the screen needs.
    const parsed = WaitingListSchema.parse(list);
    expect(parsed.total).toBe(5);
    expect(
      parsed.items.map((item) => [
        item.ref.slice(-1),
        item.kinds,
        item.notification.state,
      ]),
    ).toEqual([
      ["3", ["message_waiting"], "failed"],
      ["1", ["person_requested"], "delivered"],
      ["2", ["message_waiting", "person_requested"], "delivered"],
      ["4", ["person_requested"], "pending"],
      ["5", ["message_waiting"], "none"],
    ]);
    expect(parsed.items[2].counts).toEqual({
      message_waiting: 3,
      person_requested: 1,
    });
    expect(parsed.items[0].windowEndsAt).toBe("2030-03-04T12:30:00.000000Z");
    const text = JSON.stringify(parsed);
    for (const value of planted) {
      expect(text).not.toContain(value);
    }

    const formatted = await format(JSON.stringify(parsed), {
      ...(await resolveConfig(RECORDING)),
      parser: "json",
    });
    if (process.env.COMPANY_OS_RECORD === "1") {
      writeFileSync(RECORDING, formatted);
    }
    expect(JSON.parse(readFileSync(RECORDING, "utf8"))).toEqual(parsed);
  });
});
