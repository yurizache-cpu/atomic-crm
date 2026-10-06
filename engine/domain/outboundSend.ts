// A send of an accepted review: at most one provider call, between two
// committed transactions (Phase 2B).
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
//   TX3   confirm  ops.confirm_outbound_send holds the send's conversation
//         + CALL   and reads the stale-reply predicate again (ADR 0023 §L);
//         + settle then exactly one OutboundTransport.send, and
//                  ops.settle_outbound_send: sent | failed | indeterminate.
//                  One transaction, so the contact's next message waits at its
//                  admission until the call is settled: the reply that leaves
//                  was the conversation's latest when it left.
//
// WHAT A CRASH LEAVES, and why it is safe:
//   * before TX2 commits: the send is `authorized`; asking again begins it,
//     and it is called once.
//   * after TX2 commits: the send is `sending` and may have left. Nothing here
//     calls it again: a second run finds it `sending` and stops. A status
//     callback can still resolve it (the correlation travels with the call),
//     and a person may record it indeterminate after the client's timeout. A
//     crash inside TX3 rolls back only the settlement, and the same holds.
//   * a send TX3 stops was never called: `failed`, class `newer_message`.
//
// Nothing here decides whether a message may be sent; the database does, in
// TX1, TX2 and TX3. Nothing here retries.
//
// Phase 2E.1: the CALL is observed through TelemetryPort (a span and the
// external-call metrics), with the operation, the provider kind and the
// outcome class only: never the recipient, the text or the provider's answer.
// Telemetry cannot change the call, the settlement or the report.

import type { TxClient, WorkerDatabase } from "../db/types.ts";
import {
  guardTelemetry,
  NOOP_TELEMETRY,
  type TelemetryPort,
} from "../telemetry/telemetryPort.ts";
import type {
  OutboundOutcome,
  OutboundTransport,
} from "../communication/types.ts";
import {
  beginOutboundSend,
  confirmOutboundSend,
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
  /** Why no call was made, as the database answered it (a block or a stop). */
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
  /** Tests only: runs after the call, before its settlement. A throw behaves like a crash. */
  readonly afterCall?: (outboundMessageId: string) => Promise<void>;
}

/**
 * How long the send's last transaction may sit idle while the one call is in
 * flight: longer than any call a transport may make (the Meta transport's
 * timeout is at most 60 s), so a slow call is still settled, and bounded, so a
 * stalled sender cannot hold a conversation forever.
 */
const CALL_HOLD_LIMIT_MS = 75_000;

const holdThroughTheCall = (tx: TxClient) =>
  tx.query(
    `set local idle_in_transaction_session_timeout = ${CALL_HOLD_LIMIT_MS}`,
  );

/** What the one call produced, for the report: an id and a class, never text. */
const evidenceOf = (outcome: OutboundOutcome) => ({
  providerCalled: true,
  providerOutcome: outcome.kind,
  providerMessageId:
    outcome.kind === "accepted" ? outcome.providerMessageId : null,
});

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

/** The send's one call, observed. What it returns is the call's, unchanged. */
const observedCall = async (
  telemetry: TelemetryPort,
  tenantId: string,
  call: () => Promise<OutboundOutcome>,
): Promise<OutboundOutcome> => {
  const span = telemetry.startSpan("company_os.whatsapp.send", {
    "company_os.operation": "whatsapp.send",
    "company_os.provider.kind": "meta",
    "company_os.tenant.id": tenantId,
  });
  const startedAt = Date.now();
  const outcome = await call();
  const callClass = outcome.kind === "accepted" ? "ok" : "error";
  span.setAttributes({ "company_os.call.outcome": callClass });
  span.end(callClass);
  telemetry.count("company_os_external_calls_total", {
    operation: "whatsapp.send",
    outcome: callClass,
  });
  telemetry.observe(
    "company_os_provider_duration_seconds",
    Math.max(0, Date.now() - startedAt) / 1000,
    { provider_kind: "meta", operation: "whatsapp.send" },
  );
  return outcome;
};

export async function sendApprovedReview(
  owner: WorkerDatabase,
  transport: OutboundTransport,
  input: RequestSendInput,
  seams: SendSeams = {},
  telemetry: TelemetryPort = NOOP_TELEMETRY,
): Promise<SendReport> {
  const observed = guardTelemetry(telemetry);
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

  // --- TX3: confirm, then the one call, then settle. ------------------------
  const attempt: { outcome: OutboundOutcome | null; settling: boolean } = {
    outcome: null,
    settling: false,
  };
  try {
    return await owner.withTransaction(async (tx) => {
      await holdThroughTheCall(tx);
      const gate = await confirmOutboundSend(
        tx,
        input.tenantId,
        requested.outboundMessageId,
      );
      if (gate.state !== "send") {
        return report(gate.state, { blockedReason: gate.reason });
      }

      // --- CALL: exactly one. -----------------------------------------------
      const outcome = await observedCall(observed, input.tenantId, () =>
        callOnce(transport, begun.request),
      );
      attempt.outcome = outcome;
      if (seams.afterCall) await seams.afterCall(requested.outboundMessageId);

      attempt.settling = true;
      const settled = await settleOutboundSend(
        tx,
        input.tenantId,
        requested.outboundMessageId,
        outcome,
      );
      return report(settled.status, evidenceOf(outcome));
    });
  } catch (error) {
    // Before the call nothing left: the error is the caller's, as for TX1 and
    // TX2 (the send stays `sending`, which a person may record).
    if (attempt.outcome === null || !attempt.settling) throw error;
    // The call happened; its outcome is not on the record. The send stays
    // `sending`, which is the truth: it may have been delivered. What the call
    // produced goes back to the operator, so it is not lost with the settle.
    return report("sending", {
      ...evidenceOf(attempt.outcome),
      settlementRecorded: false,
    });
  }
}
