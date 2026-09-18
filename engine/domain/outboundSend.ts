// Sending an approved reply: at most one provider call, between two committed
// transactions (Phase 2B).
//
// The shape is the external-call shape the agent runtime proved (Phase 1D,
// engine/worker/externalCall.ts), for the same reason: a provider call that
// may have reached the provider must never be made twice by the system.
//
//   TX1   request  ops.request_outbound_send: an accepted review, a person's
//                  explicit ask, the fresh eligibility check. Idempotent per
//                  review, so asking again answers the same send.
//   TX2   begin    ops.begin_outbound_send: eligibility checked AGAIN, then
//                  `sending` COMMITTED before the call leaves the process.
//                  Only this transaction's answer carries the text.
//   CALL           exactly one OutboundTransport.send, no transaction.
//   TX3   settle   ops.settle_outbound_send: sent | failed | indeterminate.
//
// WHAT A CRASH LEAVES, and why it is safe:
//   * before TX2 commits: the send is `authorized`; asking again begins it,
//     and it is called once.
//   * after TX2 commits: the send is `sending` and may have left. Nothing here
//     calls it again: a second run finds it `sending` and stops. A status
//     callback can still resolve it (the correlation travels with the call),
//     and a person may record it indeterminate after the client's timeout.
//
// Nothing here decides whether a message may be sent; the database does, in
// TX1 and TX2. Nothing here retries.

import type { WorkerDatabase } from "../db/types.ts";
import type {
  OutboundOutcome,
  OutboundTransport,
} from "../communication/types.ts";
import {
  beginOutboundSend,
  requestOutboundSend,
  settleOutboundSend,
  type OutboundStatus,
  type RequestSendInput,
} from "./outboundMessages.ts";

export interface SendReport {
  readonly outboundMessageId: string;
  readonly status: OutboundStatus;
  /** True when this call created the send; false when it answered an earlier one. */
  readonly created: boolean;
  /** True only when THIS invocation made the provider call. */
  readonly providerCalled: boolean;
  readonly blockedReason: string | null;
  /**
   * False when the call happened but its outcome could not be recorded: the
   * send stays `sending`, and it may have been delivered.
   */
  readonly settlementRecorded: boolean;
  /**
   * What THIS invocation's one call produced, or null when it made none. With
   * the provider message id, the evidence a send whose settlement failed would
   * otherwise lose: an id and a class, never text.
   */
  readonly providerOutcome: OutboundOutcome["kind"] | null;
  readonly providerMessageId: string | null;
}

export interface SendSeams {
  /** Tests only: runs after TX2 committed `sending`, before the call. */
  readonly afterBegin?: (outboundMessageId: string) => Promise<void>;
  /** Tests only: runs after the call, before TX3. A throw behaves like a crash. */
  readonly afterCall?: (outboundMessageId: string) => Promise<void>;
}

/** A transport that broke its no-throw contract is treated as ambiguous. */
const callOnce = async (
  transport: OutboundTransport,
  request: Parameters<OutboundTransport["send"]>[0],
): Promise<OutboundOutcome> => {
  try {
    return await transport.send(request);
  } catch {
    return { kind: "ambiguous", errorClass: "transport_threw" };
  }
};

export async function sendApprovedReview(
  owner: WorkerDatabase,
  transport: OutboundTransport,
  input: RequestSendInput,
  seams: SendSeams = {},
): Promise<SendReport> {
  // --- TX1: request. A refusal throws and records nothing. ----------------
  const requested = await owner.withTransaction((tx) =>
    requestOutboundSend(tx, input),
  );
  const report = (
    status: OutboundStatus,
    overrides: Partial<SendReport> = {},
  ): SendReport =>
    Object.freeze({
      outboundMessageId: requested.outboundMessageId,
      status,
      created: requested.created,
      providerCalled: false,
      blockedReason: null,
      settlementRecorded: true,
      providerOutcome: null,
      providerMessageId: null,
      ...overrides,
    });
  if (requested.status !== "authorized") {
    // Already begun, settled or still blocked: never a second call.
    return report(requested.status);
  }

  // --- TX2: begin. `sending` is durable before anything leaves. -----------
  const begun = await owner.withTransaction((tx) =>
    beginOutboundSend(tx, input.tenantId, requested.outboundMessageId),
  );
  if (begun.state === "blocked") {
    return report("blocked", { blockedReason: begun.reason });
  }
  if (begun.state !== "send") {
    return report(begun.state);
  }
  if (seams.afterBegin) await seams.afterBegin(requested.outboundMessageId);

  // --- CALL: exactly one. -------------------------------------------------
  const outcome = await callOnce(transport, begun.request);
  const evidence = {
    providerCalled: true,
    providerOutcome: outcome.kind,
    providerMessageId:
      outcome.kind === "accepted" ? outcome.providerMessageId : null,
  };
  if (seams.afterCall) await seams.afterCall(requested.outboundMessageId);

  // --- TX3: settle. -------------------------------------------------------
  try {
    const settled = await owner.withTransaction((tx) =>
      settleOutboundSend(
        tx,
        input.tenantId,
        requested.outboundMessageId,
        outcome,
      ),
    );
    return report(settled.status, evidence);
  } catch {
    // The call happened; its outcome is not on the record. The send stays
    // `sending`, which is the truth: it may have been delivered. What the call
    // produced goes back to the operator, so it is not lost with the settle.
    return report("sending", { ...evidence, settlementRecorded: false });
  }
}
