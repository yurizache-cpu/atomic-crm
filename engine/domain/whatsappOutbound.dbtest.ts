// Phase 2B outbound, against a real Postgres: a human-approved reply leaves
// only by an explicit operator send, after consent is read FRESH, and the
// provider is called at most once whatever happens. Provider status callbacks,
// through the gateway's own login, move a send forward and never backward, and
// never across tenants.
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
  markOutboundIndeterminate,
  readOutbound,
  requestOutboundSend,
} from "./outboundMessages.ts";
import { sendApprovedReview } from "./outboundSend.ts";
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
  } = {},
): Promise<Scenario> => {
  const clinic = await buildClinic(
    owner,
    options.tenantId ?? TENANT_A,
    options.target ?? TARGET_A,
  );
  const contactId = await addCrmContact(admin, LEAD);
  await deliver(
    gateway,
    metaPayload(clinic.providerTarget, {
      messages: [
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
      const clinic = await buildClinic(owner, TENANT_A, TARGET_A);
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
    await deliver(gateway, status("wamid.OUT1701", "delivered"));
    expect(await outboundOf(scenario)).toMatchObject({
      status: "delivered",
      errorCode: null,
    });
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

    await deliver(
      gateway,
      status("wamid.OUT1801", "sent", { correlation: pending!.id }),
    );
    expect(await outboundOf(scenario)).toMatchObject({
      status: "sent",
      providerMessageId: "wamid.OUT1801",
    });
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
