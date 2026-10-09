import type { ReplyResult } from "../../query/useReplyToConversation";
import { REPLY_OUTCOME_TEXT, notSendableText } from "./inboxCopy";

// What the member is told once a reply settles, from one map (inboxCopy.ts).

/** The answers after which the reply is on its way, or already was. */
const ON_ITS_WAY: ReadonlySet<ReplyResult["kind"]> = new Set([
  "queued",
  "recorded",
  "already_recorded",
]);

/** Whether the reply is on its way after this answer. */
export const replyOnItsWay = (result: ReplyResult): boolean =>
  ON_ITS_WAY.has(result.kind);

export const replyOutcomeText = (result: ReplyResult): string =>
  result.kind === "not_sendable"
    ? notSendableText(result.reason)
    : REPLY_OUTCOME_TEXT[result.kind];
