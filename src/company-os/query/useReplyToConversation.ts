import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  CompanyOsApiError,
  CompanyOsInputError,
  type Conversation,
  type ReplyOutcomeCode,
} from "../../../contracts/company-os-api/index.ts";
import { useOperatorScope, useRuntime } from "../session/runtime";
import { QUERY_ROOT } from "./keys";

// The browser inbox's reply (ADR 0026 §E, SI-87): the member's own text, to
// the conversation's newest message, at the revision the screen showed. The
// server answers every refusal as an outcome with nothing written; a person's
// reply is the one send the browser may cause, and it leaves only through the
// worker's reply job.
//
// Called once per explicit human confirmation and NEVER retried
// (`retry: false`, on top of the client's default): a repeat of the same text
// at the same revision is answered `already_recorded`, but a person decides
// whether to ask again, not a loop. The affected reads are read again after
// every answer and every error. OS429 says the conversation was busy and
// nothing was recorded; OS401, OS403 and OS409 come only from the identity
// gate (access is checked again); OS404 is an unknown reference; OS400 a
// request the server refused. Any other failure (a dropped connection, a lost
// answer, a broken contract) leaves the outcome unknown: the conversation is
// read again, and the reply counts as recorded only when it now shows more of
// the member's replies with exactly this text than before the act.

/** What the member is told once the act settles. */
export type ReplyResultKind =
  | ReplyOutcomeCode
  | "recorded"
  | "busy"
  | "not_allowed"
  | "not_found"
  | "refused"
  | "unknown";

export interface ReplyResult {
  readonly kind: ReplyResultKind;
  /** Why the send's gates refuse it now: only for `not_sendable`. */
  readonly reason: string | null;
}

export interface ReplyRequest {
  /** Any task of the conversation's own inbound messages (its route reference). */
  readonly taskRef: string;
  readonly text: string;
  /** The revision the open conversation showed. */
  readonly revision: number;
  /** How many of the shown replies by a person carry exactly `text`. */
  readonly priorPersonReplies: number;
}

/** Every read whose answer a reply changes. */
const AFFECTED_READS: ReadonlySet<string> = new Set([
  "get_conversation",
  "overview",
  "list_events",
  "list_reviews",
  "list_tasks",
  "get_task",
  "get_review",
]);

/** How many shown replies by a person carry exactly `text`. */
export const personRepliesWith = (
  conversation: Conversation,
  text: string,
): number =>
  conversation.status !== "available"
    ? 0
    : conversation.turns.filter(
        (turn) =>
          turn.kind === "reply" &&
          turn.author === "person" &&
          turn.text === text,
      ).length;

const codeOf = (error: unknown): string | null =>
  error instanceof CompanyOsApiError ? error.code : null;

const answered = (kind: ReplyResultKind): ReplyResult => ({
  kind,
  reason: null,
});

export const useReplyToConversation = () => {
  const { api } = useRuntime();
  const scope = useOperatorScope();
  const queryClient = useQueryClient();
  const options = { expectedUserId: scope.userId };

  const refresh = () =>
    queryClient.invalidateQueries(
      {
        predicate: (query) =>
          query.queryKey[0] === QUERY_ROOT &&
          AFFECTED_READS.has(String(query.queryKey[5])),
      },
      { throwOnError: false },
    );

  /** Whether the server now shows this reply once more than before; null when it cannot tell. */
  const showsReply = async (request: ReplyRequest): Promise<boolean | null> => {
    try {
      const conversation = await api.call(
        "get_conversation",
        { p_task_id: request.taskRef },
        options,
      );
      return (
        personRepliesWith(conversation, request.text) >
        request.priorPersonReplies
      );
    } catch {
      return null;
    }
  };

  return useMutation({
    retry: false,
    mutationFn: async (request: ReplyRequest): Promise<ReplyResult> => {
      try {
        const result = await api.act(
          "reply_to_conversation",
          {
            p_task_id: request.taskRef,
            p_text: request.text,
            p_expected_revision: request.revision,
          },
          options,
        );
        await refresh();
        return { kind: result.outcome, reason: result.reason };
      } catch (error) {
        // The browser refused its own input: no request left.
        if (error instanceof CompanyOsInputError) return answered("refused");
        const code = codeOf(error);
        switch (code) {
          case "OS429":
            await refresh();
            return answered("busy");
          case "OS401":
          case "OS403":
          case "OS409":
            await refresh();
            return answered("not_allowed");
          case "OS404":
            await refresh();
            return answered("not_found");
          case "OS400":
            await refresh();
            return answered("refused");
        }
        // Anything else leaves the outcome unknown: ask the server.
        const shown = await showsReply(request);
        await refresh();
        return answered(shown === true ? "recorded" : "unknown");
      }
    },
  });
};
