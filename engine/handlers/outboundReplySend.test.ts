// @vitest-environment node
//
// The reply-send handler (ADR 0026 §B), phase by phase, with fake capabilities:
// what it asks the database, what it refuses to believe, and what it records
// for each way the one call can end. What the database does with these calls is
// proven against a real Postgres (engine/domain/automaticFixedTexts.dbtest.ts).
// Every value is synthetic.
import { describe, expect, it } from "vitest";
import {
  createFakeOutboundTransport,
  UNCONFIGURED_REPLY_TRANSPORT,
  type ReplyTransport,
} from "../communication/replyTransport.ts";
import type { OutboundOutcome } from "../communication/types.ts";
import type { ReplySendSettlement } from "../worker/capabilities.ts";
import {
  PermanentError,
  SecurityError,
  TransientError,
} from "../worker/failures.ts";
import type { CallOutcome, PrepareBudget } from "../worker/handlerRegistry.ts";
import type { LeasedJob } from "../worker/job.ts";
import {
  createOutboundReplySendHandler,
  OUTBOUND_REPLY_SEND_KIND,
  REPLY_SETTLE_MARGIN_MS,
  replySendSettlement,
} from "./outboundReplySend.ts";

const SEND_ID = "0b8f5a1e-0000-4000-8000-000000000001";
const OTHER_SEND_ID = "0b8f5a1e-0000-4000-8000-000000000002";
const REQUEST = {
  providerTarget: "200000000000001",
  to: "5511900000001",
  body: "Texto fixo fictício.",
};

const job = (
  payload: unknown = { outbound_message_id: SEND_ID },
): LeasedJob => ({
  id: "11111111-1111-1111-1111-111111111111",
  tenant_id: "aaaaaaaa-0000-0000-0000-000000000001",
  kind: OUTBOUND_REPLY_SEND_KIND,
  payload,
  attempts: 1,
  max_attempts: 5,
});

const budget = (remainingMs = 60_000): PrepareBudget => ({
  callBudgetMs: remainingMs,
  remainingMs: () => remainingMs,
});

const fakeTransport = (): ReplyTransport => {
  const transport = createFakeOutboundTransport();
  return { kind: "fake", transport, templates: transport, timeoutMs: 1_000 };
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
  const handler = createOutboundReplySendHandler({
    replyTransport: options.transport ?? fakeTransport(),
  });
  const outcome = handler.prepare(
    job(options.payload),
    {
      beginReplySend: async (transport: string) => {
        asked.push(transport);
        return answer;
      },
    },
    budget(options.remainingMs),
  );
  return { outcome, asked };
};

const confirmWith = (answer: unknown) => {
  const handler = createOutboundReplySendHandler({
    replyTransport: fakeTransport(),
  });
  return handler.confirm!(
    {
      outboundMessageId: SEND_ID,
      request: { ...REQUEST, correlation: SEND_ID },
    },
    {
      confirmReplySend: async () => answer,
      settleReplySend: async () => "sent",
    },
  );
};

describe("prepare begins only the send the lease is bound to", () => {
  it("asks for a call with the request the database built, correlated to the send", async () => {
    const { outcome, asked } = prepareWith({
      action: "start",
      outboundMessageId: SEND_ID,
      request: REQUEST,
    });
    expect(await outcome).toEqual({
      kind: "call",
      providerKind: "fake",
      state: {
        outboundMessageId: SEND_ID,
        request: { ...REQUEST, correlation: SEND_ID },
      },
    });
    expect(asked).toEqual(["fake"]);
  });

  it("tells the database it has no transport, and gives the job back when told to", async () => {
    const { outcome, asked } = prepareWith(
      { action: "released", outboundMessageId: SEND_ID },
      { transport: UNCONFIGURED_REPLY_TRANSPORT },
    );
    expect(await outcome).toEqual({
      kind: "released",
      detail: `outbound=${SEND_ID} status=waiting`,
    });
    expect(asked).toEqual(["none"]);
  });

  it("holds the job under a stop, and settles it when there is nothing to call", async () => {
    expect(
      await prepareWith({ action: "stopped", outboundMessageId: SEND_ID })
        .outcome,
    ).toEqual({ kind: "held" });
    expect(
      await prepareWith({
        action: "settled",
        status: "blocked",
        outboundMessageId: SEND_ID,
      }).outcome,
    ).toEqual({
      kind: "settled",
      detail: `outbound=${SEND_ID} status=blocked`,
    });
  });

  it("refuses a lease bound to another send as forged", async () => {
    await expect(
      prepareWith({
        action: "start",
        outboundMessageId: OTHER_SEND_ID,
        request: REQUEST,
      }).outcome,
    ).rejects.toBeInstanceOf(SecurityError);
  });

  it("refuses a job that names no send before asking the database anything", async () => {
    const { outcome, asked } = prepareWith(
      { action: "start", outboundMessageId: SEND_ID, request: REQUEST },
      { payload: { outbound_message_id: "not-a-uuid" } },
    );
    await expect(outcome).rejects.toBeInstanceOf(PermanentError);
    expect(asked).toEqual([]);
  });

  it("refuses an answer of a shape it does not accept", async () => {
    await expect(
      prepareWith({ action: "start", outboundMessageId: SEND_ID }).outcome,
    ).rejects.toBeInstanceOf(PermanentError);
    await expect(
      prepareWith({ action: "send_anyway", outboundMessageId: SEND_ID })
        .outcome,
    ).rejects.toBeInstanceOf(PermanentError);
  });

  it("rolls the start back when the lease is too short for the transport's own bound", async () => {
    const { outcome } = prepareWith(
      { action: "start", outboundMessageId: SEND_ID, request: REQUEST },
      { remainingMs: 1_000 + REPLY_SETTLE_MARGIN_MS - 1 },
    );
    await expect(outcome).rejects.toBeInstanceOf(TransientError);
  });
});

describe("the last gate decides in the call's own transaction", () => {
  it("calls, settles or waits as the database answers", async () => {
    expect(
      await confirmWith({ action: "send", outboundMessageId: SEND_ID }),
    ).toEqual({
      kind: "call",
    });
    expect(
      await confirmWith({
        action: "settled",
        status: "failed",
        outboundMessageId: SEND_ID,
      }),
    ).toEqual({ kind: "settled", detail: `outbound=${SEND_ID} status=failed` });
    expect(
      await confirmWith({ action: "released", outboundMessageId: SEND_ID }),
    ).toEqual({
      kind: "released",
      detail: `outbound=${SEND_ID} status=waiting`,
    });
  });

  it("refuses an answer about another send, or of an unknown shape", async () => {
    await expect(
      confirmWith({ action: "send", outboundMessageId: OTHER_SEND_ID }),
    ).rejects.toBeInstanceOf(PermanentError);
    await expect(
      confirmWith({ action: "start", outboundMessageId: SEND_ID }),
    ).rejects.toBeInstanceOf(PermanentError);
  });
});

describe("what the settlement records for each way the call ends", () => {
  const ended = (value: unknown): CallOutcome<OutboundOutcome> => ({
    ok: true,
    value: value as OutboundOutcome,
    durationMs: 5,
  });

  it("records an accepted message sent, with its provider id", () => {
    expect(
      replySendSettlement(
        ended({ kind: "accepted", providerMessageId: "wamid.SYNTHETIC" }),
      ),
    ).toEqual<ReplySendSettlement>({
      outcome: "sent",
      providerMessageId: "wamid.SYNTHETIC",
      errorCode: null,
      errorClass: null,
    });
  });

  it("records a refusal failed, keeping only well-formed codes", () => {
    expect(
      replySendSettlement(
        ended({
          kind: "rejected",
          errorCode: "131026",
          errorClass: "recipient_unavailable",
        }),
      ),
    ).toMatchObject({
      outcome: "failed",
      errorCode: "131026",
      errorClass: "recipient_unavailable",
    });
    expect(
      replySendSettlement(
        ended({ kind: "rejected", errorCode: "x1", errorClass: "Not A Class" }),
      ),
    ).toMatchObject({
      outcome: "failed",
      errorCode: null,
      errorClass: "provider_rejected",
    });
  });

  it("records failed a call never started because the deadline passed first", () => {
    expect(
      replySendSettlement({
        ok: false,
        error: new DOMException("deadline", "TimeoutError"),
        durationMs: 0,
        notStarted: true,
      }),
    ).toEqual<ReplySendSettlement>({
      outcome: "failed",
      providerMessageId: null,
      errorCode: null,
      errorClass: "deadline_before_call",
    });
  });

  it("records indeterminate whatever may have reached the provider", () => {
    expect(
      replySendSettlement({
        ok: false,
        error: new DOMException("aborted", "AbortError"),
        durationMs: 900,
      }),
    ).toMatchObject({
      outcome: "indeterminate",
      errorClass: "transport_threw",
    });
    expect(
      replySendSettlement(
        ended({ kind: "ambiguous", errorClass: "provider_timeout" }),
      ),
    ).toMatchObject({
      outcome: "indeterminate",
      errorClass: "provider_timeout",
    });
    expect(replySendSettlement(ended({ kind: "accepted" }))).toMatchObject({
      outcome: "indeterminate",
      errorClass: "provider_answer_unreadable",
    });
  });

  it("refuses to settle a send that is not this attempt's", async () => {
    const handler = createOutboundReplySendHandler({
      replyTransport: fakeTransport(),
    });
    await expect(
      handler.settle(
        {
          outboundMessageId: SEND_ID,
          request: { ...REQUEST, correlation: SEND_ID },
        },
        ended({ kind: "accepted", providerMessageId: "wamid.SYNTHETIC" }),
        {
          confirmReplySend: async () => null,
          settleReplySend: async () => "not_sending",
        },
      ),
    ).rejects.toBeInstanceOf(PermanentError);
  });
});
