// owner_notification.send (ADR 0026 §D): the owner's notification that a
// request for a person, or a message waiting for one, is in the queue, sent as
// the owner's approved utility template to the owner's own number. Queued only
// with the episode that raised it (ops.record_owner_notification_intent);
// never by a task.
//
//   prepare  (TX2a, committed) begin the notification the LEASE is bound to:
//            the database re-checks the kill switch, its expiry, the target in
//            force and its channel, quiet hours and the caps, sets aside what
//            a release or a person's reply already answered, and records
//            `sending` BEFORE anything is called, with every due notification
//            of the same target carried by this one send (a digest across
//            conversations). `stopped` holds the job; `released` means the
//            database gave the job back (quiet hours, a cap, or this worker has
//            no transport); anything else that is not a start settles the job
//            without calling anyone.
//   call     one call to the template transport.
//   settle   (TX2b) store the outcome, as a reply's: refused or never started
//            is `failed`; anything else that is not an accepted message is
//            `indeterminate`, never sent again. A failure fails what the send
//            carried, so a later message may tell the owner; no outcome raises
//            an exception or an event.
//
// The owner's number and the contact's first word exist only in the begin
// answer and this handler's memory; the job's detail names the notification
// and its status only (SI-86).

import { z } from "zod";
import type { ReplyTransport } from "../communication/replyTransport.ts";
import type {
  OutboundOutcome,
  OutboundTemplateRequest,
} from "../communication/types.ts";
import {
  PermanentError,
  SecurityError,
  TransientError,
} from "../worker/failures.ts";
import type {
  CallOutcome,
  ExternalCallHandlerDefinition,
  PrepareOutcome,
} from "../worker/handlerRegistry.ts";
import { payloadObject } from "../worker/job.ts";
import {
  REPLY_SETTLE_MARGIN_MS,
  replySendSettlement,
} from "./outboundReplySend.ts";

export const OWNER_NOTIFICATION_SEND_KIND = "owner_notification.send";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const beginSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("settled"),
    status: z.string(),
    ownerNotificationId: z.string().regex(UUID),
  }),
  z.object({
    action: z.literal("stopped"),
    ownerNotificationId: z.string().regex(UUID),
  }),
  z.object({
    action: z.literal("released"),
    ownerNotificationId: z.string().regex(UUID),
  }),
  z.object({
    action: z.literal("start"),
    ownerNotificationId: z.string().regex(UUID),
    request: z.strictObject({
      providerTarget: z.string().regex(/^[0-9]{1,32}$/),
      to: z.string().regex(/^[0-9]{8,15}$/),
      templateName: z.string().regex(/^[a-z0-9_]{1,512}$/),
      languageCode: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/),
      parameters: z.array(z.string().min(1).max(60)).min(1).max(2),
    }),
  }),
]);

type PrepareCapability = "beginOwnerNotification";
type SettleCapability = "settleOwnerNotification";

interface NotificationState {
  readonly ownerNotificationId: string;
  readonly request: OutboundTemplateRequest;
}

export type OwnerNotificationSendHandler = ExternalCallHandlerDefinition<
  PrepareCapability,
  SettleCapability,
  NotificationState,
  OutboundOutcome
>;

const describe = (ownerNotificationId: string, status: string): string =>
  `owner_notification=${ownerNotificationId} status=${status}`;

export function createOwnerNotificationSendHandler(dependencies: {
  readonly replyTransport: ReplyTransport;
}): OwnerNotificationSendHandler {
  const { replyTransport } = dependencies;
  const handler: OwnerNotificationSendHandler = {
    kind: OWNER_NOTIFICATION_SEND_KIND,
    shape: "external_call",
    prepareCapabilities: Object.freeze<PrepareCapability[]>([
      "beginOwnerNotification",
    ]),
    settleCapabilities: Object.freeze<SettleCapability[]>([
      "settleOwnerNotification",
    ]),

    async prepare(
      job,
      capabilities,
      budget,
    ): Promise<PrepareOutcome<NotificationState>> {
      const named = payloadObject(job.payload).owner_notification_id;
      if (typeof named !== "string" || !UUID.test(named)) {
        throw new PermanentError(
          "the job names no notification; nothing was begun",
        );
      }
      const parsed = beginSchema.safeParse(
        await capabilities.beginOwnerNotification(
          replyTransport.templates === null ? "none" : replyTransport.kind,
        ),
      );
      if (!parsed.success) {
        throw new PermanentError(
          "ops.begin_owner_notification returned a shape this handler does not accept",
        );
      }
      const begun = parsed.data;
      // A job whose lease is bound to another notification is forged or
      // mis-routed.
      if (begun.ownerNotificationId !== named) {
        throw new SecurityError(
          "the job's owner_notification_id does not name the notification its lease is bound to",
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
        replyTransport.templates === null ||
        budget.remainingMs() < replyTransport.timeoutMs + REPLY_SETTLE_MARGIN_MS
      ) {
        throw new TransientError(
          "lease too short for the notification transport; nothing was begun",
        );
      }
      const { parameters, ...request } = begun.request;
      return {
        kind: "call",
        providerKind: replyTransport.kind,
        state: Object.freeze({
          ownerNotificationId: named,
          request: Object.freeze({
            ...request,
            bodyParameters: Object.freeze([...parameters]),
            correlation: `owner-notification:${named}`,
          }),
        }),
      };
    },

    async call(state): Promise<OutboundOutcome> {
      if (replyTransport.templates === null) {
        // Prepare never asks for a call without a transport.
        throw new PermanentError("no notification transport on this worker");
      }
      return replyTransport.templates.sendTemplate(state.request);
    },

    async settle(
      state,
      outcome: CallOutcome<OutboundOutcome>,
      capabilities,
    ): Promise<string> {
      const status = await capabilities.settleOwnerNotification(
        replySendSettlement(outcome),
      );
      if (status === "not_sending") {
        throw new PermanentError(
          "the notification was not this attempt's to settle",
        );
      }
      return describe(state.ownerNotificationId, status);
    },
  };
  return Object.freeze(handler);
}
