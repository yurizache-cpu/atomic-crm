// Phase 2B outbound, against a real Postgres: a send of an accepted review
// leaves only by an explicit operator send, after consent is read FRESH, and the
// provider is called at most once whatever happens. Provider status callbacks,
// through the gateway's own login, move a send forward and never backward, and
// never across tenants. A send that fails or whose outcome is uncertain
// reaches the exception queue (ADR 0025), after its settlement committed, and
// provider evidence reconciles it.
//
// ALL DATA IS SYNTHETIC (BASELINE Q8). The transport is a counting fake.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import type { OutboundTransport } from "../communication/types.ts";
import {
  resetFixtures,
  TENANT_A,
  TENANT_B,
} from "../worker/testSupport/dbFixture.ts";
import { tripExecutionStop } from "./executionStops.ts";
import {
  resolveException,
  syncTenantSendExceptions,
} from "./exceptionQueue.ts";
import {
  markOutboundIndeterminate,
  readOutbound,
  requestOutboundSend,
} from "./outboundMessages.ts";
import { sendApprovedReview } from "./outboundSend.ts";
import { recordPrivacyNotice } from "./privacyNotices.ts";
import {
  closeAgentRuntimeDatabases,
  fakeRuntime,
  openAgentRuntimeDatabases,
} from "./testSupport/agentRuntimeProbes.ts";
import {
  accepted,
  addCrmContact,
  ADVICE,
  buildClinic,
  countRows,
  decide,
  deleteCrmContacts,
  deliver,
  fakeTransport,
  gatewayDatabase,
  metaPayload,
  OPERATOR,
  provisionGatewayRole,
  setDoNotContact,
  triageAndAccept,
  type Clinic,
  type InboundItem,
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

const TARGET_A = "200000000000303";
const TARGET_B = "200000000000404";
const LEAD = "5511900000303";

interface Scenario {
  readonly clinic: Clinic;
  readonly contactId: string;
  readonly reviewId: string;
}

/** A contact writes on a test channel, the model triages, and a person accepts. */
const acceptedReview = async (
  options: {
    readonly tenantId?: string;
    readonly target?: string;
    readonly messageId?: string;
    /** Delivered in the same notification, before the reviewed message. */
    readonly before?: readonly InboundItem[];
  } = {},
): Promise<Scenario> => {
  const clinic = await buildClinic(
    owner,
    options.tenantId ?? TENANT_A,
    options.target ?? TARGET_A,
    "test",
    [LEAD],
  );
  const contactId = await addCrmContact(admin, LEAD);
  await deliver(
    gateway,
    metaPayload(clinic.providerTarget, {
      messages: [
        ...(options.before ?? []),
        {
          id: options.messageId ?? "wamid.IN1001",
          from: LEAD,
          body: "Synthetic enquiry",
        },
      ],
    }),
  );
  const { registry } = fakeRuntime({ type: "respond", content: ADVICE });
  const reviewId = await triageAndAccept(owner, db, registry, clinic.tenantId);
  return { clinic, contactId, reviewId };
};

const send = (
  scenario: Scenario,
  transport: OutboundTransport,
  seams: Parameters<typeof sendApprovedReview>[3] = {},
) =>
  sendApprovedReview(
    owner,
    transport,
    {
      tenantId: scenario.clinic.tenantId,
      reviewId: scenario.reviewId,
      requestedBy: OPERATOR,
      source: "dbtest-whatsapp",
    },
    seams,
  );

const outboundCount = (tenantId: string) =>
  countRows(
    admin,
    "select count(*)::text as count from ops.outbound_messages where tenant_id = $1",
    [tenantId],
  );

/** ADR 0025: the exceptions of the scenario's send, oldest first. */
const sendExceptions = async (scenario: Scenario) =>
  (
    await admin.query<{
      kind: string;
      priority: string;
      raised_by: string;
      resolution: string | null;
      resolved_by: string | null;
    }>(
      `select e.kind, e.priority, e.raised_by, e.resolution, e.resolved_by
         from ops.exceptions e
         join ops.outbound_messages o on o.id = e.outbound_message_id
        where o.review_item_id = $1
        order by e.raised_at, e.kind`,
      [scenario.reviewId],
    )
  ).rows;

const exceptionEvents = (tenantId: string, type: string) =>
  countRows(
    admin,
    "select count(*)::text as count from ops.events where tenant_id = $1 and type = $2",
    [tenantId, type],
  );

const outboundOf = async (scenario: Scenario) => {
  const { rows } = await admin.query<{ id: string }>(
    "select id from ops.outbound_messages where review_item_id = $1",
    [scenario.reviewId],
  );
  return owner.withTransaction((tx) => readOutbound(tx, rows[0].id));
};

describe("the human boundary", () => {
  it("accepting a review sends nothing: only the explicit send calls the provider", async () => {
    const scenario = await acceptedReview();
    const transport = fakeTransport(() => accepted("wamid.OUT1001"));

    // Accepted, and nothing has left.
    expect(await outboundCount(TENANT_A)).toBe(0);
    expect(transport.calls).toHaveLength(0);

    const report = await send(scenario, transport);
    expect(report).toMatchObject({
      status: "sent",
      providerCalled: true,
      created: true,
    });
    expect(transport.calls).toHaveLength(1);
    // What was sent is the reviewed draft, to the conversation's contact, from its channel.
    expect(transport.calls[0]).toMatchObject({
      providerTarget: TARGET_A,
      to: LEAD,
      body: ADVICE.response_draft,
      correlation: report.outboundMessageId,
    });
    // Sending does not touch the decision.
    const { rows } = await admin.query<{ status: string }>(
      "select status from ops.review_items where id = $1",
      [scenario.reviewId],
    );
    expect(rows[0].status).toBe("accepted");
    expect((await outboundOf(scenario))?.providerMessageId).toBe(
      "wamid.OUT1001",
    );
  });

  it.each(["rejected", "needs_edit", "pending"] as const)(
    "a %s review cannot be sent",
    async (decision) => {
      const clinic = await buildClinic(owner, TENANT_A, TARGET_A, "test", [
        LEAD,
      ]);
      await addCrmContact(admin, LEAD);
      await deliver(
        gateway,
        metaPayload(TARGET_A, {
          messages: [{ id: "wamid.IN1101", from: LEAD, body: "Synthetic" }],
        }),
      );
      const { registry } = fakeRuntime({ type: "respond", content: ADVICE });
      const { runOneJob } = await import("../worker/runOneJob.ts");
      await runOneJob(db, { workerId: "dbtest-whatsapp", registry });
      const reviewId =
        decision === "pending"
          ? (
              await admin.query<{ id: string }>(
                "select id from ops.review_items where tenant_id = $1",
                [TENANT_A],
              )
            ).rows[0].id
          : await decide(owner, TENANT_A, decision);
      const transport = fakeTransport(() => accepted("wamid.never"));
      await expect(
        sendApprovedReview(owner, transport, {
          tenantId: clinic.tenantId,
          reviewId,
          requestedBy: OPERATOR,
          source: "dbtest-whatsapp",
        }),
      ).rejects.toMatchObject({ code: "invalid_state" });
      expect(transport.calls).toHaveLength(0);
      expect(await outboundCount(TENANT_A)).toBe(0);
    },
  );
});

describe("consent is read fresh at the moment of acting", () => {
  it("refuses a lead who opted out after admission, although the review was accepted", async () => {
    const scenario = await acceptedReview();
    await setDoNotContact(admin, scenario.contactId, true);
    const transport = fakeTransport(() => accepted("wamid.never"));
    await expect(send(scenario, transport)).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("do_not_contact"),
    });
    expect(transport.calls).toHaveLength(0);
    expect(await outboundCount(TENANT_A)).toBe(0);
  });

  it("blocks a send whose consent changes between the request and the call, and allows it again once restored", async () => {
    const scenario = await acceptedReview();
    await owner.withTransaction((tx) =>
      requestOutboundSend(tx, {
        tenantId: TENANT_A,
        reviewId: scenario.reviewId,
        requestedBy: OPERATOR,
        source: "dbtest-whatsapp",
      }),
    );
    await setDoNotContact(admin, scenario.contactId, true);
    const transport = fakeTransport(() => accepted("wamid.OUT1201"));

    expect(await send(scenario, transport)).toMatchObject({
      status: "blocked",
      blockedReason: "do_not_contact",
      providerCalled: false,
    });
    expect(transport.calls).toHaveLength(0);

    await setDoNotContact(admin, scenario.contactId, false);
    expect(await send(scenario, transport)).toMatchObject({
      status: "sent",
      providerCalled: true,
    });
    expect(transport.calls).toHaveLength(1);
  });

  it("refuses a contact the CRM no longer resolves to exactly one person", async () => {
    const scenario = await acceptedReview();
    await addCrmContact(admin, LEAD); // a second contact with the same number
    const transport = fakeTransport(() => accepted("wamid.never"));
    await expect(send(scenario, transport)).rejects.toMatchObject({
      message: expect.stringContaining("contact_ambiguous"),
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("refuses a reply outside the 24-hour window the contact opened", async () => {
    const scenario = await acceptedReview();
    await admin.query(
      "update ops.conversations set last_inbound_at = now() - interval '25 hours' where tenant_id = $1",
      [TENANT_A],
    );
    await expect(
      send(
        scenario,
        fakeTransport(() => accepted("x")),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("outside_service_window"),
    });
  });

  it("refuses while an execution stop covers the tenant", async () => {
    const scenario = await acceptedReview();
    await owner.withTransaction((tx) =>
      tripExecutionStop(
        tx,
        { scope: "tenant", tenantId: TENANT_A },
        { reason: "dbtest outbound stop", actor: "dbtest" },
      ),
    );
    await expect(
      send(
        scenario,
        fakeTransport(() => accepted("x")),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("execution_stopped"),
    });
  });
});

describe("at most one provider call", () => {
  it("answers a repeated send with the same send, and never calls twice", async () => {
    const scenario = await acceptedReview();
    const transport = fakeTransport(() => accepted("wamid.OUT1301"));
    const first = await send(scenario, transport);
    const second = await send(scenario, transport);
    expect(second).toMatchObject({
      outboundMessageId: first.outboundMessageId,
      status: "sent",
      providerCalled: false,
      created: false,
    });
    expect(transport.calls).toHaveLength(1);
    expect(await outboundCount(TENANT_A)).toBe(1);
  });

  it("makes one call when several operators send at once", async () => {
    const scenario = await acceptedReview();
    const transport = fakeTransport(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return accepted("wamid.OUT1401");
    });
    const reports = await Promise.all([
      send(scenario, transport),
      send(scenario, transport),
      send(scenario, transport),
    ]);
    expect(transport.calls).toHaveLength(1);
    expect(reports.filter((r) => r.providerCalled)).toHaveLength(1);
    expect(new Set(reports.map((r) => r.outboundMessageId)).size).toBe(1);
  });

  it("records a definitive provider refusal as failed, with a code and no text", async () => {
    const scenario = await acceptedReview();
    const transport = fakeTransport(() => ({
      kind: "rejected",
      errorCode: "131047",
      errorClass: "service_window_closed",
    }));
    expect(await send(scenario, transport)).toMatchObject({
      status: "failed",
      providerCalled: true,
      exceptionsSynced: true,
    });
    expect(await outboundOf(scenario)).toMatchObject({
      status: "failed",
      errorCode: "131047",
      errorClass: "service_window_closed",
    });
    // A failed send is not sent again by asking again.
    expect(await send(scenario, transport)).toMatchObject({
      status: "failed",
      providerCalled: false,
    });
    expect(transport.calls).toHaveLength(1);
    // ADR 0025: one exception, recorded after the settlement, once.
    expect(await sendExceptions(scenario)).toEqual([
      {
        kind: "send_failed",
        priority: "normal",
        raised_by: "operator-cli",
        resolution: null,
        resolved_by: null,
      },
    ]);
    expect(await exceptionEvents(TENANT_A, "exception.raised")).toBe(1);
  });

  it("records an ambiguous outcome as indeterminate and never calls again", async () => {
    const scenario = await acceptedReview();
    const transport = fakeTransport(() => ({
      kind: "ambiguous",
      errorClass: "timeout",
    }));
    expect(await send(scenario, transport)).toMatchObject({
      status: "indeterminate",
      providerCalled: true,
    });
    expect(await send(scenario, transport)).toMatchObject({
      status: "indeterminate",
      providerCalled: false,
    });
    expect(transport.calls).toHaveLength(1);
    expect(await sendExceptions(scenario)).toMatchObject([
      { kind: "send_indeterminate", priority: "high", resolution: null },
    ]);
  });

  it("keeps the settlement when the send's exception cannot be recorded, and asking again records it", async () => {
    const scenario = await acceptedReview();
    const transport = fakeTransport(() => ({
      kind: "rejected",
      errorCode: "131047",
      errorClass: "service_window_closed",
    }));
    // Fault injection: the queue's function is out of reach for this one send.
    await admin.query(
      "alter function ops.sync_send_exceptions(uuid, uuid, text) rename to sync_send_exceptions_dbtest_off",
    );
    let report: Awaited<ReturnType<typeof send>>;
    try {
      report = await send(scenario, transport);
    } finally {
      await admin.query(
        "alter function ops.sync_send_exceptions_dbtest_off(uuid, uuid, text) rename to sync_send_exceptions",
      );
    }
    expect(report).toMatchObject({
      status: "failed",
      providerCalled: true,
      settlementRecorded: true,
      exceptionsSynced: false,
    });
    expect(await outboundOf(scenario)).toMatchObject({ status: "failed" });
    expect(await sendExceptions(scenario)).toEqual([]);

    // Asking again calls nothing, and records the exception.
    expect(await send(scenario, transport)).toMatchObject({
      status: "failed",
      providerCalled: false,
      exceptionsSynced: true,
    });
    expect(await sendExceptions(scenario)).toMatchObject([
      { kind: "send_failed", resolution: null },
    ]);
    // The owner's sync finds nothing left to record.
    expect(
      await owner.withTransaction((tx) =>
        syncTenantSendExceptions(tx, { tenantId: TENANT_A }),
      ),
    ).toEqual({ sends: 1, opened: 0, closed: 0 });
    expect(transport.calls).toHaveLength(1);
  });

  it("resumes a send that crashed before the call, and calls it once", async () => {
    const scenario = await acceptedReview();
    // The request committed; the process died before beginning the send.
    await owner.withTransaction((tx) =>
      requestOutboundSend(tx, {
        tenantId: TENANT_A,
        reviewId: scenario.reviewId,
        requestedBy: OPERATOR,
        source: "dbtest-whatsapp",
      }),
    );
    const transport = fakeTransport(() => accepted("wamid.OUT1501"));
    expect(await send(scenario, transport)).toMatchObject({
      status: "sent",
      providerCalled: true,
      created: false,
    });
    expect(transport.calls).toHaveLength(1);
  });

  it("never calls again after a crash once the send was in flight, and lets a status callback settle it", async () => {
    const scenario = await acceptedReview();
    const transport = fakeTransport(() => accepted("wamid.OUT1601"));
    await expect(
      send(scenario, transport, {
        afterCall: async () => {
          throw new Error("dbtest: the process died after the call");
        },
      }),
    ).rejects.toThrow(/process died/);
    expect(transport.calls).toHaveLength(1);
    const inFlight = await outboundOf(scenario);
    expect(inFlight).toMatchObject({
      status: "sending",
      providerMessageId: null,
    });

    // Running the send again calls nothing: the call may already have gone.
    expect(await send(scenario, transport)).toMatchObject({
      status: "sending",
      providerCalled: false,
    });
    expect(transport.calls).toHaveLength(1);

    // It is too early for a person to call it unknown.
    await expect(
      owner.withTransaction((tx) =>
        markOutboundIndeterminate(tx, TENANT_A, inFlight!.id, OPERATOR),
      ),
    ).rejects.toMatchObject({ code: "invalid_state" });

    // Meta's status names the send by the correlation it carried.
    await deliver(
      gateway,
      metaPayload(TARGET_A, {
        statuses: [
          {
            id: "wamid.OUT1601",
            status: "delivered",
            recipient: LEAD,
            correlation: inFlight!.id,
          },
        ],
      }),
    );
    expect(await outboundOf(scenario)).toMatchObject({
      status: "delivered",
      providerMessageId: "wamid.OUT1601",
    });
    expect(transport.calls).toHaveLength(1);
    // Never uncertain on the record, so never an exception.
    expect(await sendExceptions(scenario)).toEqual([]);
  });

  it("lists a send left sending past the client's timeout, once, until evidence settles it", async () => {
    const scenario = await acceptedReview();
    const transport = fakeTransport(() => accepted("wamid.OUT1611"));
    await expect(
      send(scenario, transport, {
        afterCall: async () => {
          throw new Error("dbtest: the process died after the call");
        },
      }),
    ).rejects.toThrow(/process died/);
    const inFlight = await outboundOf(scenario);
    const sync = () =>
      owner.withTransaction((tx) =>
        syncTenantSendExceptions(tx, { tenantId: TENANT_A }),
      );
    // Still within the window the call may take: nothing to list.
    expect(await sync()).toEqual({ sends: 1, opened: 0, closed: 0 });
    await admin.query(
      "update ops.outbound_messages set sending_at = now() - interval '6 minutes' where id = $1",
      [inFlight!.id],
    );
    expect(await sync()).toEqual({ sends: 1, opened: 1, closed: 0 });
    // A person's mark records the same uncertainty, not a second one.
    await owner.withTransaction((tx) =>
      markOutboundIndeterminate(tx, TENANT_A, inFlight!.id, OPERATOR),
    );
    expect(await sendExceptions(scenario)).toMatchObject([
      { kind: "send_indeterminate", resolution: null },
    ]);
    await deliver(
      gateway,
      metaPayload(TARGET_A, {
        statuses: [
          {
            id: "wamid.OUT1611",
            status: "delivered",
            recipient: LEAD,
            correlation: inFlight!.id,
          },
        ],
      }),
    );
    expect(await sendExceptions(scenario)).toEqual([
      {
        kind: "send_indeterminate",
        priority: "high",
        raised_by: "operator-cli",
        resolution: "reconciled",
        resolved_by: "whatsapp-gateway",
      },
    ]);
  });
});

describe("provider status callbacks", () => {
  const sentScenario = async () => {
    const scenario = await acceptedReview();
    await send(
      scenario,
      fakeTransport(() => accepted("wamid.OUT1701")),
    );
    return scenario;
  };
  const status = (
    id: string,
    value: string,
    extra: Partial<{
      correlation: string;
      recipient: string;
      errorCode: number;
    }> = {},
  ) =>
    metaPayload(TARGET_A, {
      statuses: [
        { id, status: value, recipient: extra.recipient ?? LEAD, ...extra },
      ],
    });

  it("moves a send forward, ignores duplicates and older news, and records one fact per step", async () => {
    const scenario = await sentScenario();
    await deliver(gateway, status("wamid.OUT1701", "read"));
    await deliver(gateway, status("wamid.OUT1701", "read"));
    await deliver(gateway, status("wamid.OUT1701", "delivered"));
    await deliver(gateway, status("wamid.OUT1701", "sent"));
    await deliver(gateway, status("wamid.OUT1701", "played"));
    expect(await outboundOf(scenario)).toMatchObject({ status: "read" });
    const { rows } = await admin.query<{ status: string }>(
      "select payload->>'status' as status from ops.events where tenant_id = $1 and type = 'communication.delivery_updated'",
      [TENANT_A],
    );
    expect(rows.map((r) => r.status)).toEqual(["read"]);
  });

  it("records a failure, and lets later delivery evidence win over it", async () => {
    const scenario = await sentScenario();
    await deliver(
      gateway,
      status("wamid.OUT1701", "failed", { errorCode: 131026 }),
    );
    expect(await outboundOf(scenario)).toMatchObject({
      status: "failed",
      errorCode: "131026",
    });
    // ADR 0025: the gateway raised it inside its own entry...
    expect(await sendExceptions(scenario)).toMatchObject([
      { kind: "send_failed", raised_by: "whatsapp-gateway", resolution: null },
    ]);
    await deliver(gateway, status("wamid.OUT1701", "delivered"));
    expect(await outboundOf(scenario)).toMatchObject({
      status: "delivered",
      errorCode: null,
    });
    // ...and the delivery evidence reconciles it.
    expect(await sendExceptions(scenario)).toMatchObject([
      {
        kind: "send_failed",
        resolution: "reconciled",
        resolved_by: "whatsapp-gateway",
      },
    ]);
  });

  it("reconciles an uncertain send that then fails, and lists the failure", async () => {
    const scenario = await acceptedReview();
    await send(
      scenario,
      fakeTransport(() => ({ kind: "ambiguous", errorClass: "timeout" })),
    );
    const pending = await outboundOf(scenario);
    await deliver(
      gateway,
      status("wamid.OUT1751", "failed", {
        correlation: pending!.id,
        errorCode: 131026,
      }),
    );
    expect(await outboundOf(scenario)).toMatchObject({ status: "failed" });
    expect(await sendExceptions(scenario)).toMatchObject([
      { kind: "send_indeterminate", resolution: "reconciled" },
      { kind: "send_failed", resolution: null },
    ]);
  });

  it("still takes a late delivery for a send a person already resolved", async () => {
    const scenario = await acceptedReview();
    await send(
      scenario,
      fakeTransport(() => ({ kind: "ambiguous", errorClass: "timeout" })),
    );
    const pending = await outboundOf(scenario);
    const { rows } = await admin.query<{ id: string }>(
      "select id from ops.exceptions where outbound_message_id = $1",
      [pending!.id],
    );
    await owner.withTransaction((tx) =>
      resolveException(tx, {
        tenantId: TENANT_A,
        exceptionId: rows[0].id,
        resolution: "resolved",
        actor: "dbtest-person",
        occurrences: 1,
      }),
    );
    const answer = await deliver(
      gateway,
      status("wamid.OUT1761", "delivered", { correlation: pending!.id }),
    );
    expect(answer.status).toBe(200);
    expect(await outboundOf(scenario)).toMatchObject({
      status: "delivered",
      providerMessageId: "wamid.OUT1761",
    });
    expect(await sendExceptions(scenario)).toEqual([
      {
        kind: "send_indeterminate",
        priority: "high",
        raised_by: "operator-cli",
        resolution: "resolved",
        resolved_by: "dbtest-person",
      },
    ]);
  });

  it("resolves an indeterminate send only when the correlation AND the recipient match", async () => {
    const scenario = await acceptedReview();
    await send(
      scenario,
      fakeTransport(() => ({ kind: "ambiguous", errorClass: "timeout" })),
    );
    const pending = await outboundOf(scenario);

    await deliver(
      gateway,
      status("wamid.OUT1801", "sent", {
        correlation: pending!.id,
        recipient: "5511900009999",
      }),
    );
    expect(await outboundOf(scenario)).toMatchObject({
      status: "indeterminate",
      providerMessageId: null,
    });

    // A status the recipient check refused settles nothing.
    expect(await sendExceptions(scenario)).toMatchObject([
      { kind: "send_indeterminate", resolution: null },
    ]);

    await deliver(
      gateway,
      status("wamid.OUT1801", "sent", { correlation: pending!.id }),
    );
    expect(await outboundOf(scenario)).toMatchObject({
      status: "sent",
      providerMessageId: "wamid.OUT1801",
    });
    expect(await sendExceptions(scenario)).toMatchObject([
      { kind: "send_indeterminate", resolution: "reconciled" },
    ]);
    expect(await exceptionEvents(TENANT_A, "exception.resolved")).toBe(1);
  });

  it("cannot reach another tenant's send through its own target", async () => {
    const scenarioA = await acceptedReview();
    await send(
      scenarioA,
      fakeTransport(() => ({ kind: "ambiguous", errorClass: "timeout" })),
    );
    const sendA = await outboundOf(scenarioA);
    await buildClinic(owner, TENANT_B, TARGET_B);

    // Tenant B's channel names tenant A's send, by provider id and by correlation.
    await deliver(
      gateway,
      metaPayload(TARGET_B, {
        statuses: [
          {
            id: "wamid.OUT1901",
            status: "delivered",
            recipient: LEAD,
            correlation: sendA!.id,
          },
        ],
      }),
    );
    expect(await outboundOf(scenarioA)).toMatchObject({
      status: "indeterminate",
      providerMessageId: null,
    });
    expect(
      await countRows(
        admin,
        "select count(*)::text as count from ops.events where tenant_id = $1 and type = 'communication.delivery_updated'",
        [TENANT_B],
      ),
    ).toBe(0);
  });
});

describe("the outbound record", () => {
  it("links the send to the inbound conversation and holds no text or recipient", async () => {
    const scenario = await acceptedReview();
    await send(
      scenario,
      fakeTransport(() => accepted("wamid.OUT2001")),
    );
    const { rows } = await admin.query<Record<string, unknown>>(
      `select o.*, (select m.conversation_id from ops.inbound_messages m where m.task_id = o.task_id) as inbound_conversation
         from ops.outbound_messages o where o.review_item_id = $1`,
      [scenario.reviewId],
    );
    expect(rows[0].conversation_id).toBe(rows[0].inbound_conversation);
    const record = JSON.stringify(rows[0]);
    expect(record).not.toContain("SENTINEL");
    expect(record).not.toContain(LEAD);

    const { rows: facts } = await admin.query<{
      type: string;
      payload: unknown;
    }>(
      "select type, payload from ops.events where tenant_id = $1 and type like 'communication.outbound%' order by seq",
      [TENANT_A],
    );
    expect(facts.map((f) => f.type)).toEqual([
      "communication.outbound_authorized",
      "communication.outbound_attempted",
      "communication.outbound_sent",
    ]);
    expect(JSON.stringify(facts)).not.toContain("SENTINEL");
    expect(JSON.stringify(facts)).not.toContain(LEAD);
  });
});

describe("a reply the contact's newer message made stale is never sent (ADR 0023 §L)", () => {
  const writeAgain = (scenario: Scenario, messageId: string) =>
    deliver(
      gateway,
      metaPayload(scenario.clinic.providerTarget, {
        messages: [
          { id: messageId, from: LEAD, body: "Synthetic second question" },
        ],
      }),
    );

  it("refuses the request once the contact wrote again, and calls nothing", async () => {
    const scenario = await acceptedReview();
    await writeAgain(scenario, "wamid.IN1002");
    const transport = fakeTransport(() => accepted("wamid.never"));
    await expect(send(scenario, transport)).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("newer_message"),
    });
    expect(transport.calls).toHaveLength(0);
    expect(await outboundCount(TENANT_A)).toBe(0);
  });

  it("blocks at the last gate a message that arrived after the request, on the record", async () => {
    const scenario = await acceptedReview();
    await owner.withTransaction((tx) =>
      requestOutboundSend(tx, {
        tenantId: TENANT_A,
        reviewId: scenario.reviewId,
        requestedBy: OPERATOR,
        source: "dbtest-whatsapp",
      }),
    );
    await writeAgain(scenario, "wamid.IN1003");
    const transport = fakeTransport(() => accepted("wamid.never"));

    expect(await send(scenario, transport)).toMatchObject({
      status: "blocked",
      blockedReason: "newer_message",
      providerCalled: false,
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("still sends a reply whose message is the conversation's latest", async () => {
    const scenario = await acceptedReview();
    const transport = fakeTransport(() => accepted("wamid.OUT3001"));
    expect(await send(scenario, transport)).toMatchObject({
      status: "sent",
      providerCalled: true,
    });
    expect(transport.calls).toHaveLength(1);
  });

  const sendImage = (scenario: Scenario, messageId: string) =>
    deliver(
      gateway,
      metaPayload(scenario.clinic.providerTarget, {
        messages: [{ id: messageId, from: LEAD, body: "", kind: "image" }],
      }),
    );

  it("refuses the request once the contact sent an image, which the store refused on the record", async () => {
    const scenario = await acceptedReview();
    await sendImage(scenario, "wamid.IN1004");
    const transport = fakeTransport(() => accepted("wamid.never"));
    await expect(send(scenario, transport)).rejects.toMatchObject({
      code: "refused",
      message: expect.stringContaining("newer_message"),
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("still sends when the conversation's other message is an image sent before the reviewed one", async () => {
    const scenario = await acceptedReview({
      before: [
        {
          id: "wamid.IN1005",
          from: LEAD,
          body: "",
          kind: "image",
          timestamp: Math.floor(Date.now() / 1000) - 60,
        },
      ],
    });
    const transport = fakeTransport(() => accepted("wamid.OUT3005"));
    expect(await send(scenario, transport)).toMatchObject({
      status: "sent",
      providerCalled: true,
    });
  });

  it("stops the call when the contact writes after the last check: never called, settled failed", async () => {
    const scenario = await acceptedReview();
    const transport = fakeTransport(() => accepted("wamid.never"));
    const report = await send(scenario, transport, {
      afterBegin: async () => {
        await writeAgain(scenario, "wamid.IN1006");
      },
    });
    expect(report).toMatchObject({
      status: "failed",
      blockedReason: "newer_message",
      providerCalled: false,
    });
    expect(transport.calls).toHaveLength(0);
    expect(await outboundOf(scenario)).toMatchObject({
      status: "failed",
      errorClass: "newer_message",
      providerMessageId: null,
    });
    // Never called: nothing for a person to chase (ADR 0025).
    expect(await sendExceptions(scenario)).toEqual([]);
  });

  /** True once a WhatsApp admission waits on a lock; gives up after about five seconds. */
  const admissionIsWaiting = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { rows } = await admin.query<{ waiting: number }>(
        `select count(*)::int as waiting from pg_stat_activity
          where wait_event_type = 'Lock' and query like '%receive_whatsapp_message%'`,
      );
      if (rows[0].waiting > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };

  it("holds the contact's next message at its admission while the call is in flight", async () => {
    const scenario = await acceptedReview();
    const pending: { delivery: ReturnType<typeof writeAgain> | null } = {
      delivery: null,
    };
    let admissionWaited = false;
    const transport = fakeTransport(async () => {
      pending.delivery = writeAgain(scenario, "wamid.IN1007");
      admissionWaited = await admissionIsWaiting();
      return accepted("wamid.OUT3007");
    });

    expect(await send(scenario, transport)).toMatchObject({
      status: "sent",
      providerCalled: true,
    });
    expect(admissionWaited).toBe(true);
    // Admitted only once the reply it would have made stale had been settled.
    expect(await pending.delivery).toMatchObject({ status: 200 });
  });
});

describe("the privacy notice (ADR 0021)", () => {
  const NOTICE =
    "Privacy notice: synthetic clinic, no AI reads your messages. Your rights: https://clinic.example.test/privacy";

  /** The same person writes again, and a person accepts the next triage. */
  const nextAcceptedReply = async (scenario: Scenario, messageId: string) => {
    await deliver(
      gateway,
      metaPayload(scenario.clinic.providerTarget, {
        messages: [{ id: messageId, from: LEAD, body: "Synthetic follow-up" }],
      }),
    );
    const { registry } = fakeRuntime({ type: "respond", content: ADVICE });
    return {
      ...scenario,
      reviewId: await triageAndAccept(
        owner,
        db,
        registry,
        scenario.clinic.tenantId,
      ),
    };
  };

  it("rides on every reply of a conversation until one carrying it is delivered, recording its version, and then stops", async () => {
    const scenario = await acceptedReview({ messageId: "wamid.IN4001" });
    await owner.withTransaction((tx) =>
      recordPrivacyNotice(tx, {
        tenantId: scenario.clinic.tenantId,
        version: "v1",
        noticeUrl: "https://clinic.example.test/privacy",
        whatsappText: NOTICE,
        lawfulBasisRef: "lgpd:art7-v+art11-ii-f",
        actor: "dbtest-owner",
      }),
    );
    const withNotice = `${ADVICE.response_draft}\n\n${NOTICE}`;

    const first = fakeTransport(() => accepted("wamid.OUT4001"));
    expect(await send(scenario, first)).toMatchObject({ status: "sent" });
    // The reviewed draft, a blank line, then the tenant's notice: nothing else.
    expect(first.calls[0].body).toBe(withNotice);
    expect((await outboundOf(scenario))?.privacyNoticeVersion).toBe("v1");

    // Accepted by the provider is not delivered: the next reply carries it again.
    const second = await nextAcceptedReply(scenario, "wamid.IN4002");
    const again = fakeTransport(() => accepted("wamid.OUT4002"));
    expect(await send(second, again)).toMatchObject({ status: "sent" });
    expect(again.calls[0].body).toBe(withNotice);

    // Meta reports it delivered, through the gateway's own login.
    await deliver(
      gateway,
      metaPayload(scenario.clinic.providerTarget, {
        statuses: [
          { id: "wamid.OUT4002", status: "delivered", recipient: LEAD },
        ],
      }),
    );
    expect((await outboundOf(second))?.status).toBe("delivered");

    // Once it reached the person, the next reply carries the draft alone.
    const third = await nextAcceptedReply(scenario, "wamid.IN4003");
    const next = fakeTransport(() => accepted("wamid.OUT4003"));
    expect(await send(third, next)).toMatchObject({ status: "sent" });
    expect(next.calls[0].body).toBe(ADVICE.response_draft);
    expect((await outboundOf(third))?.privacyNoticeVersion).toBeNull();

    // The send records still hold neither text nor recipient.
    const { rows } = await admin.query<Record<string, unknown>>(
      "select o.* from ops.outbound_messages o where o.tenant_id = $1",
      [scenario.clinic.tenantId],
    );
    expect(JSON.stringify(rows)).not.toContain(LEAD);
    expect(JSON.stringify(rows)).not.toContain("synthetic clinic");
  });
});
