// The recorded browser inbox the browser tests replay (ADR 0026 §E, SI-87),
// read from the REAL projections, never hand-built.
//
// The shared recordings (companyOsRecordedResponses.dbtest.ts) carry an empty
// waiting list. This suite records one inbox of its own, at a FIXED instant.
// One rolled-back transaction:
//   * gives a fresh tenant the local CRM, a clinic, its test channel and one
//     CRM contact whose stored first name has two words;
//   * builds three conversations through the real admission, takeover, reply
//     and release functions:
//       waiting   a message from the number before it was registered as a
//                 test device (health: withheld), two test messages, a
//                 person's reply the operator sent through the CLI path, an
//                 image the transport refused, and a person's reply asked for
//                 through the inbox's own act (queued); held by a person and
//                 waiting for one;
//       released  held by a person, then released to the agent: no longer
//                 waiting;
//       withheld  one message from a number that is not a test device;
//   * moves the CLI reply's instants ten minutes earlier with the send table's
//     guard off, because two replies stamped at the transaction's one instant
//     would be ordered by their random ids; the guard itself is proven by
//     supabase/tests/browser_inbox.sql;
//   * then reads ops.cos_waiting_list and ops.read_conversation, the callees
//     of the overview's waiting list and of company_os_api.get_conversation.
//
// Every instant is built relative to the transaction's now() and shifted to
// AS_OF, so the recording does not depend on the day it is made. The task
// references are mapped to deterministic ids by fixture label (a reference
// the recorder cannot place fails the recording). The result is parsed with
// its contracts, swept for every number, id, label and withheld text the
// fixture planted, and compared with
// src/company-os/testing/recorded/inbox.json:
//
//   COMPANY_OS_RECORD=1 SUPABASE_DB_CONTAINER=supabase_db_atomic-crm-e2e \
//     SUPABASE_DB_PORT=54342 npx vitest run --config vitest.db.config.ts \
//     engine/domain/companyOsInboxRecording.dbtest.ts
//
// Without COMPANY_OS_RECORD=1 nothing is written. All data is synthetic and
// nothing outlives the transaction.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { format, resolveConfig } from "prettier";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConversationSchema,
  WaitingListSchema,
  type Conversation,
} from "../../contracts/company-os-api/index.ts";
import {
  adminPool,
  assertTargetDatabase,
} from "../worker/testSupport/dbFixture.ts";

const RECORDING = join(
  fileURLToPath(new URL("../../", import.meta.url)),
  "src/company-os/testing/recorded/inbox.json",
);
const GENERATED_BY =
  "engine/domain/companyOsInboxRecording.dbtest.ts; re-record with COMPANY_OS_RECORD=1, never edit by hand";

/** Monday 2030-03-04, 10:30 in São Paulo. */
const AS_OF = "2030-03-04T13:30:00.000000Z";
const SOURCE = "rec-inbox";
const TARGET = "200000000000880";
const PERSON = "rec-inbox-person";
const OPERATOR = "rec-inbox-operator";

/** The contacts' numbers: invented, on the test line only. */
const NUMBER = {
  waiting: "5511900007701",
  released: "5511900007702",
  withheld: "5511900007703",
} as const;

/** What the withheld messages say: it must never reach the recording. */
const WITHHELD_TEXT = {
  beforeRegistration: "Rec inbox: escrita antes do registro do aparelho.",
  notTest: "Rec inbox: escrita de um número que não é de teste.",
} as const;

/** The texts the recording shows, all invented. */
const SHOWN = {
  first: "Oi, queria saber como funciona a primeira sessão.",
  cliReply: "Oi! A primeira sessão dura 50 minutos e é online.",
  second: "Tem horário na quinta?\nPode ser à tarde.",
  inboxReply: "Temos sim, às 15h. Pode ser?",
  released: "Bom dia, gostaria de remarcar.",
} as const;

/** The CRM's stored first name: the inbox shows its first word only. */
const STORED_FIRST_NAME = "  Ana-Maria Exemplo";
const STORED_LAST_NAME = "Recinbox";

/** Every recorded task, by label, and its deterministic id. */
const LABELS = [
  "task:inbox-waiting",
  "task:inbox-waiting-first",
  "task:inbox-released",
  "task:inbox-withheld",
] as const;
type Label = (typeof LABELS)[number];

const mintedId = (label: Label): string =>
  `00000000-0000-4000-8000-0040${String(LABELS.indexOf(label) + 1).padStart(8, "0")}`;

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

interface Admission {
  readonly task_id?: string;
  readonly agent_run_id?: string;
  readonly conversation_id: string;
  readonly inbound_message_id?: string;
  readonly state: string;
}

const receive = (
  client: PoolClient,
  wamid: string,
  from: string,
  body: string | null,
  minutesAgo: number,
): Promise<Admission> =>
  one<Admission>(
    client,
    `select ops.receive_whatsapp_message($1, $2, $3, $4, now() - make_interval(mins => $5)) as result`,
    [TARGET, wamid, from, body, minutesAgo],
  );

interface Built {
  readonly tenantId: string;
  /** Task id -> fixture label. */
  readonly labels: ReadonlyMap<string, Label>;
  readonly tasks: Readonly<Record<Label, string>>;
  /** Every id, number and text the recording must not carry. */
  readonly planted: readonly string[];
}

async function build(client: PoolClient): Promise<Built> {
  // The local CRM is this tenant's for the transaction (the rollback restores it).
  await client.query(
    "update ops.tenants set owns_local_crm = false where owns_local_crm",
  );
  const tenantId = await one<string>(
    client,
    `insert into ops.tenants (id, slug, name, owns_local_crm)
     values (gen_random_uuid(), 'rec-inbox', 'Recorded inbox', true) returning id as result`,
  );
  const companyId = await one<string>(
    client,
    "select ops.create_company($1, 'rec-inbox-clinic', 'Clinic', $2) as result",
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
    "select ops.configure_whatsapp_channel($1, $2, $3, $4, 'test', 'rec channel', $5, true) as result",
    [tenantId, companyId, agentId, TARGET, PERSON],
  );
  const contactId = await one<string>(
    client,
    `insert into public.contacts (first_name, last_name, phone_jsonb)
     values ($1, $2, $3::jsonb) returning id::text as result`,
    [
      STORED_FIRST_NAME,
      STORED_LAST_NAME,
      JSON.stringify([
        { number: `+55 ${NUMBER.waiting.slice(2)}`, type: "Mobile" },
      ]),
    ],
  );
  const principal = `principal:${randomUUID()}`;
  const planted: string[] = [
    tenantId,
    companyId,
    departmentId,
    agentId,
    channelId,
    TARGET,
    PERSON,
    OPERATOR,
    principal,
    `crm:contact:${contactId}`,
    STORED_LAST_NAME,
    "Exemplo",
    "wamid.",
    ...Object.values(NUMBER),
    ...Object.values(WITHHELD_TEXT),
  ];
  const remember = (admission: Admission) => {
    planted.push(
      ...[
        admission.conversation_id,
        admission.task_id,
        admission.agent_run_id,
        admission.inbound_message_id,
      ].filter((id): id is string => typeof id === "string"),
    );
    return admission;
  };

  // The waiting conversation.
  remember(
    await receive(
      client,
      "wamid.REC-INBOX-W0",
      NUMBER.waiting,
      WITHHELD_TEXT.beforeRegistration,
      50,
    ),
  );
  await client.query("select ops.register_test_sender($1, $2, $3, $4)", [
    tenantId,
    channelId,
    NUMBER.waiting,
    PERSON,
  ]);
  const first = remember(
    await receive(
      client,
      "wamid.REC-INBOX-W1",
      NUMBER.waiting,
      SHOWN.first,
      40,
    ),
  );
  const conversationId = first.conversation_id;
  await client.query("select ops.take_over_conversation($1, $2, $3)", [
    tenantId,
    conversationId,
    PERSON,
  ]);
  // A person's reply from the CLI, sent through the operator's send act.
  const cli = await one<{ review_item_id: string }>(
    client,
    `select ops.record_person_reply($1, $2, $3, $4, ops.cos_conversation_revision($1, $2)) as result`,
    [tenantId, conversationId, SHOWN.cliReply, PERSON],
  );
  const request = await one<{ outbound_message_id: string }>(
    client,
    "select ops.request_outbound_send($1, $2, $3, 'operator-cli') as result",
    [tenantId, cli.review_item_id, OPERATOR],
  );
  const outboundId = request.outbound_message_id;
  planted.push(cli.review_item_id, outboundId);
  const begun = await one<{ state: string }>(
    client,
    "select ops.begin_outbound_send($1, $2) as result",
    [tenantId, outboundId],
  );
  const confirmed = await one<{ state: string }>(
    client,
    "select ops.confirm_outbound_send($1, $2) as result",
    [tenantId, outboundId],
  );
  const settled = await one<{ state: string }>(
    client,
    "select ops.settle_outbound_send($1, $2, 'sent', 'wamid.REC-INBOX-OUT-1', null, null) as result",
    [tenantId, outboundId],
  );
  expect([begun.state, confirmed.state, settled.state]).toEqual([
    "send",
    "send",
    "sent",
  ]);
  await client.query(
    "alter table ops.outbound_messages disable trigger outbound_messages_guard",
  );
  await client.query(
    `update ops.outbound_messages
        set authorized_at = now() - interval '35 minutes', sending_at = now() - interval '35 minutes',
            settled_at = now() - interval '35 minutes'
      where id = $1`,
    [outboundId],
  );
  await client.query(
    "alter table ops.outbound_messages enable trigger outbound_messages_guard",
  );
  const second = remember(
    await receive(
      client,
      "wamid.REC-INBOX-W2",
      NUMBER.waiting,
      SHOWN.second,
      20,
    ),
  );
  remember(
    await receive(client, "wamid.REC-INBOX-W3", NUMBER.waiting, null, 10),
  );
  // A person's reply asked for through the inbox's own act (queued).
  const queued = await one<{ outcome: string }>(
    client,
    `select ops.reply_to_conversation_as_member($1, $2, $3, $4, ops.cos_conversation_revision($1, $5)) as result`,
    [tenantId, principal, second.task_id, SHOWN.inboxReply, conversationId],
  );
  expect(queued.outcome).toBe("queued");

  // The released conversation.
  await client.query("select ops.register_test_sender($1, $2, $3, $4)", [
    tenantId,
    channelId,
    NUMBER.released,
    PERSON,
  ]);
  const released = remember(
    await receive(
      client,
      "wamid.REC-INBOX-R1",
      NUMBER.released,
      SHOWN.released,
      30,
    ),
  );
  await client.query("select ops.take_over_conversation($1, $2, $3)", [
    tenantId,
    released.conversation_id,
    PERSON,
  ]);
  remember(
    await receive(client, "wamid.REC-INBOX-R2", NUMBER.released, null, 25),
  );
  await client.query("select ops.release_conversation($1, $2, $3)", [
    tenantId,
    released.conversation_id,
    PERSON,
  ]);

  // The withheld conversation: a number that is not a test device.
  const withheld = remember(
    await receive(
      client,
      "wamid.REC-INBOX-H1",
      NUMBER.withheld,
      WITHHELD_TEXT.notTest,
      15,
    ),
  );

  const tasks: Record<Label, string> = {
    "task:inbox-waiting": second.task_id!,
    "task:inbox-waiting-first": first.task_id!,
    "task:inbox-released": released.task_id!,
    "task:inbox-withheld": withheld.task_id!,
  };
  const labels = new Map(
    (Object.entries(tasks) as [Label, string][]).map(([label, id]) => [
      id,
      label,
    ]),
  );
  return { tenantId, labels, tasks, planted };
}

/** An instant as microseconds since the epoch, from cos_ts's exact format. */
const microsOf = (instant: string): bigint => {
  const match = /^(.{19})\.(\d{6})Z$/.exec(instant);
  if (match === null) throw new Error(`not a contract instant: ${instant}`);
  return BigInt(Date.parse(`${match[1]}Z`)) * 1000n + BigInt(Number(match[2]));
};

const instantOf = (micros: bigint): string =>
  `${new Date(Number(micros / 1000000n) * 1000).toISOString().slice(0, 19)}.${String(micros % 1000000n).padStart(6, "0")}Z`;

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * Every instant shifted from the transaction's now() to AS_OF, and every task
 * reference mapped to its label's deterministic id.
 */
function normalise(
  value: unknown,
  now: string,
  labels: ReadonlyMap<string, Label>,
): unknown {
  const shift = microsOf(AS_OF) - microsOf(now);
  return JSON.parse(JSON.stringify(value), (key, v) => {
    if (typeof v !== "string") return v;
    if (key === "ref" || key === "p_task_id") {
      const label = labels.get(v);
      if (label === undefined) {
        throw new Error(
          `the inbox names a task the recorder cannot place: ${v}`,
        );
      }
      return mintedId(label);
    }
    return INSTANT.test(v) ? instantOf(microsOf(v) + shift) : v;
  });
}

interface Recorded {
  readonly waitingList: unknown;
  readonly calls: readonly {
    readonly operation: "get_conversation";
    readonly args: { readonly p_task_id: string };
    readonly response: unknown;
  }[];
  readonly planted: readonly string[];
}

async function record(): Promise<Recorded> {
  const client = await admin.connect();
  try {
    await client.query("begin");
    const built = await build(client);
    const now = await one<string>(client, "select ops.cos_ts(now()) as result");
    const waitingList = await one<unknown>(
      client,
      "select ops.cos_waiting_list($1, now()) as result",
      [built.tenantId],
    );
    const calls = [];
    for (const label of LABELS) {
      const response = await one<unknown>(
        client,
        "select ops.read_conversation($1, $2) as result",
        [built.tenantId, built.tasks[label]],
      );
      calls.push({
        operation: "get_conversation" as const,
        args: { p_task_id: built.tasks[label] },
        response,
      });
    }
    return {
      waitingList: normalise(waitingList, now, built.labels),
      calls: normalise(calls, now, built.labels) as Recorded["calls"],
      planted: built.planted,
    };
  } finally {
    await client.query("rollback");
    client.release();
  }
}

describe("the recorded browser inbox is the real projection at a fixed instant", () => {
  it("parses with its contracts, leaks nothing the fixture planted, and equals the committed recording", async () => {
    // Arrange / Act
    const { waitingList, calls, planted } = await record();

    // Assert: the contracts, and every state the screens need.
    const list = WaitingListSchema.parse(waitingList);
    expect(list.items.map((item) => [item.ref, item.kinds])).toEqual([
      [mintedId("task:inbox-waiting"), ["message_waiting"]],
    ]);
    const answers: Partial<Record<Label, Conversation>> = Object.fromEntries(
      calls.map((call) => [
        LABELS.find((label) => mintedId(label) === call.args.p_task_id),
        ConversationSchema.parse(call.response),
      ]),
    );
    const waiting = answers["task:inbox-waiting"];
    // Any task of the conversation's own messages reaches it (D1).
    expect(answers["task:inbox-waiting-first"]).toEqual(waiting);
    expect(answers["task:inbox-released"]).toMatchObject({
      status: "not_waiting",
    });
    expect(answers["task:inbox-withheld"]).toMatchObject({
      status: "withheld",
      reason: "not_test",
    });
    if (waiting?.status !== "available") {
      throw new Error("the waiting conversation is not available");
    }
    expect(waiting).toMatchObject({
      asOf: AS_OF,
      holder: "person",
      optOutOpen: false,
      firstName: "Ana-Maria",
      allowedActs: { reply: true, release: true },
      replyUnavailable: null,
      earlierTurns: false,
      revision: 4,
    });
    expect(
      waiting.turns.map((turn) =>
        turn.kind === "reply"
          ? [turn.kind, turn.author, turn.delivery, turn.text]
          : turn.kind === "refused"
            ? [turn.kind, turn.reason]
            : [turn.kind, turn.text ?? turn.hidden],
      ),
    ).toEqual([
      ["inbound", "withheld"],
      ["inbound", SHOWN.first],
      ["reply", "person", "sent", SHOWN.cliReply],
      ["inbound", SHOWN.second],
      ["refused", "unsupported_content"],
      ["reply", "person", "queued", SHOWN.inboxReply],
    ]);
    const text = JSON.stringify({ waitingList, calls });
    for (const value of planted) {
      expect(text).not.toContain(value);
    }

    const ids = Object.fromEntries(
      LABELS.map((label) => [label, mintedId(label)]),
    );
    const file = {
      generatedBy: GENERATED_BY,
      asOf: AS_OF,
      ids,
      waitingList,
      calls,
    };
    const formatted = await format(JSON.stringify(file), {
      ...(await resolveConfig(RECORDING)),
      parser: "json",
    });
    if (process.env.COMPANY_OS_RECORD === "1") {
      writeFileSync(RECORDING, formatted);
    }
    expect(JSON.parse(readFileSync(RECORDING, "utf8"))).toEqual(file);
  });
});
