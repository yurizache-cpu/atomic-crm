// outbound.reply_send (ADR 0026 §B, §E): ONE send the database authorized
// before the job existed, carried to the contact, holding the conversation
// through the call: a published fixed text the owner's policy authorized
// (ops.authorize_fixed_reply, in the screening), or a person's own reply
// written and asked to be sent in one act from the browser inbox
// (ops.authorize_person_reply, SI-87); never by a task, never for a model's
// draft. The body is the stored text either way; this handler never knows
// which kind it carries.
//
//   prepare  (TX2a, committed) begin the send the LEASE is bound to: the
//            database re-checks the kill switch, freshness (a fixed text's 30
//            minutes, a person's reply's 24-hour window), every send gate, the
//            opt-out rule, the policy as published now (a fixed text only)
//            and the stale rule, and records `sending` BEFORE anything is
//            called. `stopped` holds the job; `released` means the database
//            gave the job back (this worker has no transport, a newer message
//            is still to be screened, or an earlier person's reply of the
//            conversation is still to leave); anything else that is not a
//            start settles the job without calling anyone (a block, listed for
//            a person).
//   confirm  (TX2b, the call's own transaction) take the conversation, so the
//            contact's next message waits until the call is settled (waiting
//            a bounded time for it), and read again what can change
//            meanwhile: an acknowledgement waits for a newer message still to
//            be screened, and a conversation another call holds is waited for,
//            both by putting the send back and releasing the job; a reply the
//            newer message made stale, or to a number erased since, is settled
//            failed, never called.
//   call     one call to the transport.
//   settle   (TX2b) store the outcome. A transport that refused and did not
//            send, or a call never started because the deadline passed first,
//            is `failed`; anything else that is not an accepted message
//            (a timeout, a 5xx, a lost answer, a thrown error) is
//            `indeterminate`: it may have been sent, so nothing sends it
//            again, and a person resolves it.

import { z } from "zod";
import type { ReplyTransport } from "../communication/replyTransport.ts";
import type {
  OutboundOutcome,
  OutboundRequest,
} from "../communication/types.ts";
import type { ReplySendSettlement } from "../worker/capabilities.ts";
import {
  PermanentError,
  SecurityError,
  TransientError,
} from "../worker/failures.ts";
import type {
  CallOutcome,
  ExternalCallHandlerDefinition,
  HeldCallConfirmation,
  PrepareOutcome,
} from "../worker/handlerRegistry.ts";
import { payloadObject } from "../worker/job.ts";

export const OUTBOUND_REPLY_SEND_KIND = "outbound.reply_send";

/** Room left for the settlement after the call, inside the lease. */
export const REPLY_SETTLE_MARGIN_MS = 2_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const DIGITS = /^[0-9]{1,10}$/;

const beginSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("settled"),
    status: z.string(),
    outboundMessageId: z.string().regex(UUID),
  }),
  z.object({
    action: z.literal("stopped"),
    outboundMessageId: z.string().regex(UUID),
  }),
  z.object({
    action: z.literal("released"),
    outboundMessageId: z.string().regex(UUID),
  }),
  z.object({
    action: z.literal("start"),
    outboundMessageId: z.string().regex(UUID),
    request: z.object({
      providerTarget: z.string().min(1).max(64),
      to: z.string().min(1).max(64),
      body: z.string().min(1).max(4096),
    }),
  }),
]);

const confirmSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("send"),
    outboundMessageId: z.string().regex(UUID),
  }),
  z.object({
    action: z.literal("settled"),
    status: z.string(),
    outboundMessageId: z.string().regex(UUID),
  }),
  z.object({
    action: z.literal("released"),
    outboundMessageId: z.string().regex(UUID),
  }),
]);

type PrepareCapability = "beginReplySend";
type SettleCapability = "confirmReplySend" | "settleReplySend";

interface ReplyState {
  readonly outboundMessageId: string;
  readonly request: OutboundRequest;
}

export type OutboundReplySendHandler = ExternalCallHandlerDefinition<
  PrepareCapability,
  SettleCapability,
  ReplyState,
  OutboundOutcome
>;

const describe = (outboundMessageId: string, status: string): string =>
  `outbound=${outboundMessageId} status=${status}`;

/** What the settlement records for the one call's outcome. */
export function replySendSettlement(
  outcome: CallOutcome<OutboundOutcome>,
): ReplySendSettlement {
  if (!outcome.ok && outcome.notStarted === true) {
    // Never started: nothing can have reached the transport.
    return {
      outcome: "failed",
      providerMessageId: null,
      errorCode: null,
      errorClass: "deadline_before_call",
    };
  }
  if (!outcome.ok) {
    // The transport never throws by contract; if it did, it may have sent.
    return {
      outcome: "indeterminate",
      providerMessageId: null,
      errorCode: null,
      errorClass: "transport_threw",
    };
  }
  const value = outcome.value;
  if (
    value?.kind === "accepted" &&
    typeof value.providerMessageId === "string"
  ) {
    return {
      outcome: "sent",
      providerMessageId: value.providerMessageId,
      errorCode: null,
      errorClass: null,
    };
  }
  if (value?.kind === "rejected") {
    return {
      outcome: "failed",
      providerMessageId: null,
      errorCode:
        typeof value.errorCode === "string" && DIGITS.test(value.errorCode)
          ? value.errorCode
          : null,
      errorClass: REASON_CODE.test(value.errorClass)
        ? value.errorClass
        : "provider_rejected",
    };
  }
  return {
    outcome: "indeterminate",
    providerMessageId: null,
    errorCode: null,
    errorClass:
      value?.kind === "ambiguous" && REASON_CODE.test(value.errorClass)
        ? value.errorClass
        : "provider_answer_unreadable",
  };
}

export function createOutboundReplySendHandler(dependencies: {
  readonly replyTransport: ReplyTransport;
}): OutboundReplySendHandler {
  const { replyTransport } = dependencies;
  const handler: OutboundReplySendHandler = {
    kind: OUTBOUND_REPLY_SEND_KIND,
    shape: "external_call",
    prepareCapabilities: Object.freeze<PrepareCapability[]>(["beginReplySend"]),
    settleCapabilities: Object.freeze<SettleCapability[]>([
      "confirmReplySend",
      "settleReplySend",
    ]),
    afterSettlement: Object.freeze(["syncSendExceptions" as const]),

    async prepare(
      job,
      capabilities,
      budget,
    ): Promise<PrepareOutcome<ReplyState>> {
      const named = payloadObject(job.payload).outbound_message_id;
      if (typeof named !== "string" || !UUID.test(named)) {
        throw new PermanentError("the job names no send; nothing was begun");
      }
      const parsed = beginSchema.safeParse(
        await capabilities.beginReplySend(
          replyTransport.transport === null ? "none" : replyTransport.kind,
        ),
      );
      if (!parsed.success) {
        throw new PermanentError(
          "ops.begin_reply_send returned a shape this handler does not accept",
        );
      }
      const begun = parsed.data;
      // A job whose lease is bound to another send is forged or mis-routed.
      if (begun.outboundMessageId !== named) {
        throw new SecurityError(
          "the job's outbound_message_id does not name the send its lease is bound to",
        );
      }
      if (begun.action === "stopped") return { kind: "held" };
      if (begun.action === "released") {
        return { kind: "released", detail: describe(named, "waiting") };
      }
      if (begun.action === "settled") {
        return { kind: "settled", detail: describe(named, begun.status) };
      }
      // `sending` commits only with this prepare transaction: a lease too
      // short for the transport's own bound throws, the start rolls back and
      // nothing is called.
      if (
        replyTransport.transport === null ||
        budget.remainingMs() < replyTransport.timeoutMs + REPLY_SETTLE_MARGIN_MS
      ) {
        throw new TransientError(
          "lease too short for the reply transport; nothing was begun",
        );
      }
      return {
        kind: "call",
        providerKind: replyTransport.kind,
        state: Object.freeze({
          outboundMessageId: named,
          request: Object.freeze({ ...begun.request, correlation: named }),
        }),
      };
    },

    async confirm(state, capabilities): Promise<HeldCallConfirmation> {
      const parsed = confirmSchema.safeParse(
        await capabilities.confirmReplySend(),
      );
      if (
        !parsed.success ||
        parsed.data.outboundMessageId !== state.outboundMessageId
      ) {
        throw new PermanentError(
          "ops.confirm_reply_send returned a shape this handler does not accept",
        );
      }
      if (parsed.data.action === "settled") {
        return {
          kind: "settled",
          detail: describe(state.outboundMessageId, parsed.data.status),
        };
      }
      if (parsed.data.action === "released") {
        return {
          kind: "released",
          detail: describe(state.outboundMessageId, "waiting"),
        };
      }
      return { kind: "call" };
    },

    async call(state): Promise<OutboundOutcome> {
      if (replyTransport.transport === null) {
        // Prepare never asks for a call without a transport.
        throw new PermanentError("no reply transport on this worker");
      }
      return replyTransport.transport.send(state.request);
    },

    async settle(
      state,
      outcome: CallOutcome<OutboundOutcome>,
      capabilities,
    ): Promise<string> {
      const status = await capabilities.settleReplySend(
        replySendSettlement(outcome),
      );
      if (status === "not_sending") {
        throw new PermanentError("the send was not this attempt's to settle");
      }
      return describe(state.outboundMessageId, status);
    },
  };
  return Object.freeze(handler);
}
