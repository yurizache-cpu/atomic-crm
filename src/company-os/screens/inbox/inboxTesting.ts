import type {
  AvailableConversation,
  Conversation,
  ConversationTurn,
  ReleaseOutcomeCode,
  ReplyOutcomeCode,
} from "../../../../contracts/company-os-api/index.ts";
import type { MfaPort, MfaStatus } from "../../ports";
import { ok, refused, type Responder } from "../../testing/fakeSession";
import {
  createRecordedSession,
  overviewWithRecordedInbox,
  recorded,
  rid,
  RECORDED_INBOX_AS_OF,
  type RecordedSession,
} from "../../testing/recorded";
import { USER_A } from "../../testing/samples";

// The inbox's browser tests (ADR 0026 §E), fed with the conversation the real
// ops.read_conversation returned at a fixed instant
// (testing/recorded/inbox.json). A test that needs a state the recording does
// not hold derives it from the recorded answer, valid against the same
// contract the adapter parses it with.

export const WAITING = rid("task:inbox-waiting");
export const WAITING_FIRST = rid("task:inbox-waiting-first");
export const RELEASED = rid("task:inbox-released");
export const WITHHELD = rid("task:inbox-withheld");

export const CONVERSATION_HASH = `#/company-os/inbox/${WAITING}`;

/** The recorded waiting conversation. */
export const recordedConversation = (): AvailableConversation => {
  const answer = recorded("get_conversation", { p_task_id: WAITING });
  if (answer.status !== "available") {
    throw new Error("The recorded waiting conversation is not available.");
  }
  return answer;
};

/** An inbound turn the contact wrote, `minutes` after the recording's instant. */
export const inboundTurn = (text: string, minutes = 1): ConversationTurn => ({
  kind: "inbound",
  at: new Date(Date.parse(RECORDED_INBOX_AS_OF) + minutes * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, ".000000Z"),
  text,
  hidden: null,
});

/** A person's queued reply carrying `text`, as the server shows one. */
export const personReplyTurn = (text: string): ConversationTurn => ({
  kind: "reply",
  at: RECORDED_INBOX_AS_OF,
  author: "person",
  fixedKey: null,
  automatic: false,
  text,
  hidden: null,
  delivery: "queued",
  reason: null,
  withPrivacyNotice: false,
});

export const replyAnswer = (
  outcome: ReplyOutcomeCode,
  reason: string | null = null,
) => ({
  v: 1,
  asOf: RECORDED_INBOX_AS_OF,
  outcome,
  revision:
    outcome === "second_factor_required" || outcome === "withheld"
      ? null
      : recordedConversation().revision,
  reason,
});

export const releaseAnswer = (outcome: ReleaseOutcomeCode) => ({
  v: 1,
  asOf: RECORDED_INBOX_AS_OF,
  outcome,
  revision: outcome === "withheld" ? null : recordedConversation().revision,
});

export interface InboxSession extends RecordedSession {
  /** What get_conversation answers for the waiting conversation from now on. */
  show(conversation: Conversation): void;
  /** get_conversation for the waiting conversation refuses with `code` from now on. */
  refuseReads(code: string): void;
}

/**
 * A member of the recorded tenant whose overview carries the inbox's waiting
 * list, and whose waiting conversation answers what the test shows it; every
 * other conversation answers as recorded.
 */
export const createInboxSession = (
  options: { readonly mfa?: MfaPort } = {},
): InboxSession => {
  const session = createRecordedSession("tenant", USER_A, options);
  let current: Conversation = recordedConversation();
  let refusal: string | null = null;
  session.answer("overview", () => ok(overviewWithRecordedInbox()));
  const recordedOr404: Responder = (args) => {
    try {
      return ok(recorded("get_conversation", args));
    } catch {
      return refused("OS404");
    }
  };
  session.answer("get_conversation", (args) => {
    if (args.p_task_id !== WAITING) return recordedOr404(args);
    return refusal === null ? ok(current) : refused(refusal);
  });
  return Object.assign(session, {
    show: (conversation: Conversation) => {
      current = conversation;
      refusal = null;
    },
    refuseReads: (code: string) => {
      refusal = code;
    },
  });
};

export interface FakeMfa {
  readonly port: MfaPort;
  readonly verified: string[];
}

/** The provider's second factor, answering `status` and accepting `code` only. */
export const createFakeMfa = (
  status: MfaStatus | null,
  code: string,
): FakeMfa => {
  const verified: string[] = [];
  return {
    verified,
    port: {
      status: async () => status,
      enrollTotp: async () => {
        throw new Error("The inbox never enrols a factor.");
      },
      verifyTotp: async (factorId, given) => {
        verified.push(`${factorId}:${given}`);
        return given === code;
      },
    },
  };
};
