// The exception queue's conversation side (ADR 0025 Part A), end to end:
// signed Meta deliveries through the gateway's own login, the real worker
// runtime and the real screening, against a real Postgres. What a message
// tells a person reaches ops.exceptions once, whoever holds the conversation;
// a message no reply can reach gets no model (A3); a release resolves what it
// ends and waits for a person on danger and an opt-out; the owner's act
// resolves once, inside its tenant. Send exceptions are proven in
// whatsappOutbound.dbtest.ts.
//
// ALL DATA IS SYNTHETIC (BASELINE Q8). Numbers, targets and texts are invented.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import {
  removeFixtureModels,
  TENANT_A,
  TENANT_B,
} from "../worker/testSupport/dbFixture.ts";
import { CompanyOsError } from "./errors.ts";
import { listExceptions, resolveException } from "./exceptionQueue.ts";
import {
  recordPersonReply,
  releaseConversation,
  takeOverConversation,
} from "./frontDesk.ts";
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
  gatewayDatabase,
  provisionGatewayRole,
} from "./testSupport/whatsappFixture.ts";

const TARGET = "200000000000929";
const DEVICE = "5511900000929";
const ADMINISTRATIVE = "Qual o valor da primeira sessão?";
const DANGER = "Não quero mais viver.";
const OPT_OUT = "Não quero mais receber mensagens.";
const PERSON = "dbtest-person";

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

const { prepare, frontDesk, runtime, drain, send, latest, holder } =
  createFrontDeskHarness(() => ({ admin, owner, db, gateway }), {
    target: TARGET,
    device: DEVICE,
    messagePrefix: "EQ",
  });

beforeEach(prepare);

interface ExceptionRecord {
  id: string;
  kind: string;
  priority: string;
  detail: string | null;
  resolution: string | null;
  resolved_by: string | null;
}

const exceptions = async (): Promise<ExceptionRecord[]> =>
  (
    await admin.query<ExceptionRecord>(
      `select id, kind, priority, detail, resolution, resolved_by from ops.exceptions
        where tenant_id = $1 order by raised_at, kind`,
      [TENANT_A],
    )
  ).rows;

const open = async (): Promise<Pick<ExceptionRecord, "kind" | "priority">[]> =>
  (await exceptions())
    .filter((row) => row.resolution === null)
    .map(({ kind, priority }) => ({ kind, priority }));

const eventCount = async (type: string): Promise<number> =>
  Number(
    (
      await admin.query<{ n: string }>(
        "select count(*)::text as n from ops.events where tenant_id = $1 and type = $2",
        [TENANT_A, type],
      )
    ).rows[0].n,
  );

const act = <T>(fn: (tx: TxClient) => Promise<T>): Promise<T> =>
  owner.withTransaction(fn);

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CompanyOsError) return error.code;
    throw error;
  }
  throw new Error("the act was not refused");
};

describe("a contact no reply can reach gets no model (ADR 0025 A3)", () => {
  it("holds a number with no CRM contact before any model, and lists it once", async () => {
    await frontDesk();
    const { provider, decisions, registry } = runtime();
    await send(ADMINISTRATIVE);
    await drain(registry);

    const out = await latest();
    expect(out).toMatchObject({
      run_status: "cancelled",
      error_code: "front_desk_held_for_person",
      disposition: "held_for_person",
      fixed_message_key: null,
      review_status: null,
    });
    expect(provider.calls).toHaveLength(0);
    expect(decisions.asked).toHaveLength(0);
    const { rows } = await admin.query<{ routes: string; decided: string }>(
      `select (select count(*) from ops.agent_run_routes where tenant_id = $1)::text as routes,
              (select count(*) from ops.structured_decisions where tenant_id = $1)::text as decided`,
      [TENANT_A],
    );
    expect(rows[0]).toEqual({ routes: "0", decided: "0" });
    // The agent keeps the conversation: no person was asked for.
    expect(await holder(out.conversation_id)).toMatchObject({
      holder: "agent",
    });
    expect(await exceptions()).toMatchObject([
      {
        kind: "contact_unresolved",
        priority: "high",
        detail: "not_found",
        resolution: null,
      },
    ]);
    expect(await eventCount("exception.raised")).toBe(1);

    // The open episode absorbs the next message.
    await send("E vocês atendem online?");
    await drain(registry);
    expect(await exceptions()).toHaveLength(1);
    expect(await eventCount("exception.raised")).toBe(1);
    expect(provider.calls).toHaveLength(0);
  });

  it("answers the next message once a person links the contact, and reconciles the exception", async () => {
    await frontDesk();
    const { provider, registry } = runtime();
    await send(ADMINISTRATIVE);
    await drain(registry);
    await addCrmContact(admin, DEVICE);
    await send("Pode ser terça às 19h?");
    await drain(registry);

    expect(await latest()).toMatchObject({
      disposition: "model",
      run_status: "succeeded",
    });
    expect(provider.calls).toHaveLength(1);
    expect(await exceptions()).toMatchObject([
      {
        kind: "contact_unresolved",
        resolution: "reconciled",
        resolved_by: "front-desk",
      },
    ]);
    expect(await eventCount("exception.resolved")).toBe(1);
  });

  it("says why a contact is unresolved: ambiguous, or a tenant without the CRM", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    await addCrmContact(admin, DEVICE);
    const { provider, registry } = runtime();
    await send(ADMINISTRATIVE);
    await drain(registry);
    expect(await exceptions()).toMatchObject([
      { kind: "contact_unresolved", detail: "ambiguous" },
    ]);

    await prepare();
    await frontDesk();
    await admin.query(
      "update ops.tenants set owns_local_crm = false where id = $1",
      [TENANT_A],
    );
    await send(ADMINISTRATIVE);
    await drain(registry);
    expect(await exceptions()).toMatchObject([
      { kind: "contact_unresolved", detail: "unavailable" },
    ]);
    expect(provider.calls).toHaveLength(0);
  });

  it("holds a contact marked do-not-contact, at normal priority", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE, { doNotContact: true });
    const { provider, registry } = runtime();
    await send(ADMINISTRATIVE);
    await drain(registry);
    expect(await latest()).toMatchObject({ disposition: "held_for_person" });
    expect(await exceptions()).toMatchObject([
      { kind: "do_not_contact", priority: "normal", detail: null },
    ]);
    expect(provider.calls).toHaveLength(0);
  });

  it("keeps a person's reply out of a message no reply can reach", async () => {
    await frontDesk();
    const { registry } = runtime();
    await send(ADMINISTRATIVE);
    await drain(registry);
    const out = await latest();
    expect(
      await refusal(
        act((tx) =>
          recordPersonReply(tx, {
            tenantId: TENANT_A,
            conversationId: out.conversation_id,
            text: "Oi!",
            actor: PERSON,
          }),
        ),
      ),
    ).toBe("invalid_state");
    const { rows } = await admin.query(
      "select 1 from ops.review_items where tenant_id = $1",
      [TENANT_A],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("what a message tells a person reaches the queue, whoever holds the conversation (ADR 0025 A2)", () => {
  it("raises danger and the unreachable contact together, and calls no model", async () => {
    await frontDesk();
    const { provider, registry } = runtime();
    await send(DANGER);
    await drain(registry);
    const out = await latest();
    expect(out).toMatchObject({
      disposition: "fixed_reply",
      fixed_message_key: "safety",
    });
    expect(await holder(out.conversation_id)).toMatchObject({
      holder: "person",
      holder_reason: "safety",
    });
    expect((await open()).sort((a, b) => a.kind.localeCompare(b.kind))).toEqual(
      [
        { kind: "contact_unresolved", priority: "high" },
        { kind: "safety", priority: "urgent" },
      ],
    );
    expect(provider.calls).toHaveLength(0);
  });

  it("raises an urgent exception for danger after a held message", async () => {
    await frontDesk();
    const { registry } = runtime();
    await send(ADMINISTRATIVE);
    await drain(registry);
    await send(DANGER);
    await drain(registry);
    expect(await open()).toEqual([
      { kind: "contact_unresolved", priority: "high" },
      { kind: "safety", priority: "urgent" },
    ]);
  });

  it("raises an urgent exception for danger in a conversation a person took over", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { provider, registry } = runtime();
    await send(ADMINISTRATIVE);
    await drain(registry);
    const first = await latest();
    await act((tx) =>
      takeOverConversation(tx, {
        tenantId: TENANT_A,
        conversationId: first.conversation_id,
        actor: PERSON,
      }),
    );
    await send(DANGER);
    await drain(registry);
    expect(await latest()).toMatchObject({ disposition: "held_for_person" });
    expect(await holder(first.conversation_id)).toMatchObject({
      holder: "person",
      holder_reason: "operator",
    });
    // Danger is listed; nothing else needs saying.
    expect(await open()).toEqual([{ kind: "safety", priority: "urgent" }]);
    expect(provider.calls).toHaveLength(1);
  });

  it("lists a message waiting in a conversation a person holds once, and the release resolves it", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { registry } = runtime();
    await send(ADMINISTRATIVE);
    await drain(registry);
    const first = await latest();
    await act((tx) =>
      takeOverConversation(tx, {
        tenantId: TENANT_A,
        conversationId: first.conversation_id,
        actor: PERSON,
      }),
    );
    // Taking a conversation over raises nothing: a person holds it.
    expect(await exceptions()).toHaveLength(0);
    await send("Vocês atendem online?");
    await drain(registry);
    await send("Alguém aí?");
    await drain(registry);
    expect(await open()).toEqual([
      { kind: "message_waiting", priority: "normal" },
    ]);

    await act((tx) =>
      releaseConversation(tx, {
        tenantId: TENANT_A,
        conversationId: first.conversation_id,
        actor: PERSON,
      }),
    );
    expect(await exceptions()).toMatchObject([
      {
        kind: "message_waiting",
        resolution: "released",
        resolved_by: PERSON,
      },
    ]);
    expect(await eventCount("exception.raised")).toBe(1);
    expect(await eventCount("exception.resolved")).toBe(1);
  });

  it("refuses the release while danger or an opt-out is open, until a person resolves it", async () => {
    await frontDesk();
    await addCrmContact(admin, DEVICE);
    const { provider, registry } = runtime();
    await send(DANGER);
    await drain(registry);
    const out = await latest();
    const release = () =>
      act((tx) =>
        releaseConversation(tx, {
          tenantId: TENANT_A,
          conversationId: out.conversation_id,
          actor: PERSON,
        }),
      );
    expect(await refusal(release())).toBe("invalid_state");
    expect(await holder(out.conversation_id)).toMatchObject({
      holder: "person",
    });

    const [safety] = await exceptions();
    expect(
      await act((tx) =>
        resolveException(tx, {
          tenantId: TENANT_A,
          exceptionId: safety.id,
          resolution: "resolved",
          actor: PERSON,
        }),
      ),
    ).toEqual({ state: "resolved" });
    expect(await release()).toEqual({ state: "released" });
    await send(ADMINISTRATIVE);
    await drain(registry);
    expect(provider.calls).toHaveLength(1);

    await send(OPT_OUT);
    await drain(registry);
    expect(await open()).toEqual([{ kind: "opt_out", priority: "normal" }]);
    expect(await refusal(release())).toBe("invalid_state");
  });

  it("says when the agent has not published a fixed text it needed", async () => {
    await frontDesk(KNOWLEDGE, POLICY, [
      "operating_policy",
      "playbook",
      "knowledge",
    ]);
    await addCrmContact(admin, DEVICE);
    const { provider, registry } = runtime();
    await send("Tenho tido crises de pânico e não durmo direito.");
    await drain(registry);
    const out = await latest();
    expect(out).toMatchObject({ disposition: "held_for_person" });
    expect(await holder(out.conversation_id)).toMatchObject({
      holder: "person",
      holder_reason: "operator",
    });
    expect(await open()).toEqual([
      { kind: "configuration_missing", priority: "high" },
    ]);
    expect(provider.calls).toHaveLength(0);
  });

  it("records each exception event with its kind and priority only, about the message's task", async () => {
    await frontDesk();
    const { registry } = runtime();
    await send(DANGER);
    await drain(registry);
    const [first] = await exceptions();
    await act((tx) =>
      resolveException(tx, {
        tenantId: TENANT_A,
        exceptionId: first.id,
        resolution: "dismissed",
        actor: PERSON,
      }),
    );
    const out = await latest();
    const { rows } = await admin.query<{
      type: string;
      source: string;
      subject_type: string;
      subject_id: string;
      payload: Record<string, unknown>;
    }>(
      `select type, source, subject_type, subject_id, payload from ops.events
        where tenant_id = $1 and type like 'exception.%' order by seq`,
      [TENANT_A],
    );
    expect(rows.map((row) => row.type)).toEqual([
      "exception.raised",
      "exception.raised",
      "exception.resolved",
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        source: "exception-queue",
        subject_type: "task",
        subject_id: out.task_id,
      });
      const allowed =
        row.type === "exception.raised"
          ? ["exception_id", "kind", "priority", "subject_kind", "detail"]
          : ["exception_id", "kind", "priority", "subject_kind", "resolution"];
      for (const key of Object.keys(row.payload))
        expect(allowed).toContain(key);
      const text = JSON.stringify(row.payload);
      expect(text).not.toContain(DEVICE);
      expect(text).not.toContain(out.conversation_id);
    }
  });
});

describe("the owner's act (ADR 0025 A4)", () => {
  it("resolves once, inside its own tenant, with a person's resolution only", async () => {
    await frontDesk();
    const { registry } = runtime();
    await send(ADMINISTRATIVE);
    await drain(registry);
    const [row] = await exceptions();
    const resolve = (
      tenantId: string,
      resolution: string,
      actor: string = PERSON,
    ) =>
      act((tx) =>
        resolveException(tx, {
          tenantId,
          exceptionId: row.id,
          resolution,
          actor,
        }),
      );

    expect(await refusal(resolve(TENANT_A, "released"))).toBe(
      "invalid_argument",
    );
    expect(await refusal(resolve(TENANT_A, "reconciled"))).toBe(
      "invalid_argument",
    );
    expect(await refusal(resolve(TENANT_A, "dismissed", "a person"))).toBe(
      "invalid_argument",
    );
    expect(await refusal(resolve(TENANT_B, "dismissed"))).toBe("not_found");
    expect(await resolve(TENANT_A, "dismissed")).toEqual({
      state: "dismissed",
    });
    expect(await resolve(TENANT_A, "resolved")).toEqual({
      state: "already_resolved",
      resolution: "dismissed",
    });
    expect(await eventCount("exception.resolved")).toBe(1);

    const listed = await act((tx) =>
      Promise.all([
        listExceptions(tx, { tenantId: TENANT_A }),
        listExceptions(tx, { tenantId: TENANT_A, all: true }),
      ]),
    );
    expect(listed[0]).toHaveLength(0);
    expect(listed[1]).toMatchObject([
      {
        id: row.id,
        kind: "contact_unresolved",
        priority: "high",
        subjectKind: "conversation",
        detail: "not_found",
        resolution: "dismissed",
        resolvedBy: PERSON,
      },
    ]);
    // A dismissed episode is final; the contact's next message opens a new one.
    await send("Olá?");
    await drain(registry);
    expect(await open()).toEqual([
      { kind: "contact_unresolved", priority: "high" },
    ]);
  });
});
