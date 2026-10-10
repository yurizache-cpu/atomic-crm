// @vitest-environment node
//
// The owner-notification handler (ADR 0026 §D), phase by phase, with fake
// capabilities: what it asks the database, what it refuses to believe, and
// what it records for each way the one call can end. What the database does
// with these calls is proven against a real Postgres
// (engine/domain/ownerNotifications.dbtest.ts). Every value is synthetic.
import { describe, expect, it } from "vitest";
import {
  createFakeOutboundTransport,
  UNCONFIGURED_REPLY_TRANSPORT,
  type ReplyTransport,
} from "../communication/replyTransport.ts";
import type { ReplySendSettlement } from "../worker/capabilities.ts";
import {
  PermanentError,
  SecurityError,
  TransientError,
} from "../worker/failures.ts";
import type { PrepareBudget } from "../worker/handlerRegistry.ts";
import type { LeasedJob } from "../worker/job.ts";
import {
  createOwnerNotificationSendHandler,
  OWNER_NOTIFICATION_SEND_KIND,
} from "./ownerNotificationSend.ts";

const NOTE_ID = "0b8f5a1e-0000-4000-8000-0000000000a1";
const OTHER_ID = "0b8f5a1e-0000-4000-8000-0000000000a2";
const REQUEST = {
  providerTarget: "200000000000001",
  to: "5511900000977",
  templateName: "aviso_fila_conversa",
  languageCode: "pt_BR",
  parameters: ["Maria", "14:35"],
};

const job = (
  payload: unknown = { owner_notification_id: NOTE_ID },
): LeasedJob => ({
  id: "11111111-1111-1111-1111-111111111111",
  tenant_id: "aaaaaaaa-0000-0000-0000-000000000001",
  kind: OWNER_NOTIFICATION_SEND_KIND,
  payload,
  attempts: 1,
  max_attempts: 5,
});

const budget = (remainingMs = 60_000): PrepareBudget => ({
  callBudgetMs: remainingMs,
  remainingMs: () => remainingMs,
});

const fake = () => {
  const transport = createFakeOutboundTransport();
  const reply: ReplyTransport = {
    kind: "fake",
    transport,
    templates: transport,
    timeoutMs: 1_000,
  };
  return { reply, transport };
};

const prepareWith = (
  answer: unknown,
  options: {
    transport?: ReplyTransport;
    payload?: unknown;
    remainingMs?: number;
  } = {},
) => {
  const asked: string[] = [];
  const handler = createOwnerNotificationSendHandler({
    replyTransport: options.transport ?? fake().reply,
  });
  const outcome = handler.prepare(
    job(options.payload),
    {
      beginOwnerNotification: async (transport: string) => {
        asked.push(transport);
        return answer;
      },
    },
    budget(options.remainingMs),
  );
  return { outcome, asked };
};

describe("prepare begins only the notification the lease is bound to", () => {
  it("asks for one template call with the request the database built, correlated to the notification", async () => {
    const { outcome, asked } = prepareWith({
      action: "start",
      ownerNotificationId: NOTE_ID,
      request: REQUEST,
    });
    expect(await outcome).toEqual({
      kind: "call",
      providerKind: "fake",
      state: {
        ownerNotificationId: NOTE_ID,
        request: {
          providerTarget: REQUEST.providerTarget,
          to: REQUEST.to,
          templateName: REQUEST.templateName,
          languageCode: REQUEST.languageCode,
          bodyParameters: REQUEST.parameters,
          correlation: `owner-notification:${NOTE_ID}`,
        },
      },
    });
    expect(asked).toEqual(["fake"]);
  });

  it("tells the database it has no transport, and maps a hold, a release and a settlement", async () => {
    const none = prepareWith(
      { action: "released", ownerNotificationId: NOTE_ID },
      { transport: UNCONFIGURED_REPLY_TRANSPORT },
    );
    expect(await none.outcome).toEqual({
      kind: "released",
      detail: `owner_notification=${NOTE_ID} status=waiting`,
    });
    expect(none.asked).toEqual(["none"]);
    expect(
      await prepareWith({ action: "stopped", ownerNotificationId: NOTE_ID })
        .outcome,
    ).toEqual({ kind: "held" });
    expect(
      await prepareWith({
        action: "settled",
        status: "coalesced",
        ownerNotificationId: NOTE_ID,
      }).outcome,
    ).toEqual({
      kind: "settled",
      detail: `owner_notification=${NOTE_ID} status=coalesced`,
    });
  });

  it("refuses a job naming no notification, an answer about another one, and a shape it does not know", async () => {
    await expect(
      prepareWith({}, { payload: { owner_notification_id: "x" } }).outcome,
    ).rejects.toBeInstanceOf(PermanentError);
    await expect(
      prepareWith({ action: "stopped", ownerNotificationId: OTHER_ID }).outcome,
    ).rejects.toBeInstanceOf(SecurityError);
    for (const bad of [
      {
        action: "start",
        ownerNotificationId: NOTE_ID,
        request: { ...REQUEST, to: "+5511900000977" },
      },
      {
        action: "start",
        ownerNotificationId: NOTE_ID,
        request: { ...REQUEST, parameters: [] },
      },
      {
        action: "start",
        ownerNotificationId: NOTE_ID,
        request: { ...REQUEST, extra: 1 },
      },
      { action: "send", ownerNotificationId: NOTE_ID },
    ]) {
      await expect(prepareWith(bad).outcome).rejects.toBeInstanceOf(
        PermanentError,
      );
    }
  });

  it("begins nothing when the lease cannot hold the transport's bound", async () => {
    await expect(
      prepareWith(
        { action: "start", ownerNotificationId: NOTE_ID, request: REQUEST },
        { remainingMs: 2_500 },
      ).outcome,
    ).rejects.toBeInstanceOf(TransientError);
  });
});

describe("the call and its settlement", () => {
  it("sends the template once and records the provider's id; a refusal is failed, an uncertain end indeterminate", async () => {
    const { reply, transport } = fake();
    const handler = createOwnerNotificationSendHandler({
      replyTransport: reply,
    });
    const prepared = await handler.prepare(
      job(),
      {
        beginOwnerNotification: async () => ({
          action: "start",
          ownerNotificationId: NOTE_ID,
          request: REQUEST,
        }),
      },
      budget(),
    );
    if (prepared.kind !== "call") throw new Error("expected a call");
    const outcome = await handler.call(prepared.state, {
      signal: new AbortController().signal,
      deadline: Date.now() + 10_000,
    });
    expect(transport.templateCalls).toHaveLength(1);
    expect(transport.calls).toHaveLength(0);

    const settled: ReplySendSettlement[] = [];
    const settle = (status: string) => ({
      settleOwnerNotification: async (settlement: ReplySendSettlement) => {
        settled.push(settlement);
        return status;
      },
    });
    expect(
      await handler.settle(
        prepared.state,
        { ok: true, value: outcome, durationMs: 5 },
        settle("sent"),
      ),
    ).toBe(`owner_notification=${NOTE_ID} status=sent`);
    await handler.settle(
      prepared.state,
      {
        ok: true,
        durationMs: 5,
        value: {
          kind: "rejected",
          errorCode: "132001",
          errorClass: "provider_rejected",
        },
      },
      settle("failed"),
    );
    await handler.settle(
      prepared.state,
      {
        ok: true,
        durationMs: 5,
        value: { kind: "ambiguous", errorClass: "timeout" },
      },
      settle("indeterminate"),
    );
    expect(settled).toEqual([
      {
        outcome: "sent",
        providerMessageId: `fake.owner-notification:${NOTE_ID}`,
        errorCode: null,
        errorClass: null,
      },
      {
        outcome: "failed",
        providerMessageId: null,
        errorCode: "132001",
        errorClass: "provider_rejected",
      },
      {
        outcome: "indeterminate",
        providerMessageId: null,
        errorCode: null,
        errorClass: "timeout",
      },
    ]);
    await expect(
      handler.settle(
        prepared.state,
        { ok: true, value: outcome, durationMs: 5 },
        settle("not_sending"),
      ),
    ).rejects.toBeInstanceOf(PermanentError);
  });
});
