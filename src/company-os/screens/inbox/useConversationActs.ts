import { useRef, useState } from "react";

import type { AvailableConversation } from "../../../../contracts/company-os-api/index.ts";
import {
  personRepliesWith,
  useReplyToConversation,
  type ReplyResult,
} from "../../query/useReplyToConversation";
import {
  useReleaseConversation,
  type ReleaseResultKind,
} from "../../query/useReleaseConversation";

// What the open conversation keeps while its read refreshes or fails: the
// member's unsent text, the last answer of each act and where the second
// factor stands. It lives in the conversation's page, above the read's
// loading and error states, and is keyed by the conversation's reference, so
// a failed poll never loses the text and another conversation never shows it.
// Nothing here is persisted: it is component state, gone with the page.

/**
 * The reply's second factor (ADR 0026 §E: verified within the hour): asked
 * for after a `second_factor_required`; verified once a code was accepted
 * here; exhausted when the server still asks after an accepted code, where
 * only signing in again helps.
 */
export type StepUp = "none" | "asking" | "verified" | "exhausted";

export interface ConversationActs {
  readonly draft: string;
  readonly setDraft: (text: string) => void;
  readonly replyResult: ReplyResult | undefined;
  readonly replyPending: boolean;
  readonly stepUp: StepUp;
  /**
   * Asks once for the member's reply at the revision the confirmation
   * captured; a second call while one is in flight does nothing.
   */
  readonly sendReply: (
    conversation: AvailableConversation,
    revision: number,
  ) => void;
  readonly factorVerified: () => void;
  readonly releaseResult: ReleaseResultKind | undefined;
  readonly releasePending: boolean;
  /** Asks once for the release at `revision`; a second call while one is in flight does nothing. */
  readonly sendRelease: (revision: number) => void;
}

/** The answers after which the member's text is on its way, or already was. */
const CLEARS_DRAFT: ReadonlySet<ReplyResult["kind"]> = new Set([
  "queued",
  "recorded",
  "already_recorded",
]);

export const useConversationActs = (taskRef: string): ConversationActs => {
  const reply = useReplyToConversation();
  const release = useReleaseConversation();
  const [draft, setDraft] = useState("");
  const [stepUp, setStepUp] = useState<StepUp>("none");
  // Set synchronously on the first confirmation, so a second click in the
  // same frame never makes a second act.
  const replying = useRef(false);
  const releasing = useRef(false);

  const sendReply = (conversation: AvailableConversation, revision: number) => {
    if (replying.current || reply.isPending) return;
    replying.current = true;
    const text = draft;
    reply.mutate(
      {
        taskRef,
        text,
        revision,
        priorPersonReplies: personRepliesWith(conversation, text),
      },
      {
        onSuccess: (result) => {
          if (CLEARS_DRAFT.has(result.kind)) setDraft("");
          if (result.kind === "second_factor_required") {
            setStepUp((now) => (now === "verified" ? "exhausted" : "asking"));
          } else {
            setStepUp("none");
          }
        },
        onSettled: () => {
          replying.current = false;
        },
      },
    );
  };

  const sendRelease = (revision: number) => {
    if (releasing.current || release.isPending) return;
    releasing.current = true;
    release.mutate(
      { taskRef, revision },
      {
        onSettled: () => {
          releasing.current = false;
        },
      },
    );
  };

  return {
    draft,
    setDraft,
    replyResult: reply.data,
    replyPending: reply.isPending,
    stepUp,
    sendReply,
    factorVerified: () => setStepUp("verified"),
    releaseResult: release.data,
    releasePending: release.isPending,
    sendRelease,
  };
};
