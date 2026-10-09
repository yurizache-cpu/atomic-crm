import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import type { AvailableConversation } from "../../../../contracts/company-os-api/index.ts";
import { Note } from "../../components/display";
import type { ReleaseResultKind } from "../../query/useReleaseConversation";
import {
  OPT_OUT_OPEN_RELEASE,
  RELEASE_BUTTON,
  RELEASE_CHANGED_WHILE_OPEN,
  RELEASE_CONFIRM_BODY,
  RELEASE_CONFIRM_BUTTON,
  RELEASE_CONFIRM_TITLE,
  RELEASE_GROUP_LABEL,
  RELEASE_OUTCOME_TEXT,
} from "./inboxCopy";
import { ConfirmDialog, OutcomeNote } from "./inboxParts";
import { useReturnFocus } from "./useReturnFocus";
import type { ConversationActs } from "./useConversationActs";

// The browser inbox's release (ADR 0026 §E, SI-87): a conversation a person
// holds goes back to the agent, behind a confirmation that names the revision
// the conversation showed. It sends nothing, and it is never offered while the
// contact's opt-out is open: resolving that stays a terminal act. One act per
// confirmation, never retried.

/** What the last release answered; shown on any view of the conversation. */
export const ReleaseOutcome = ({
  result,
}: {
  result: ReleaseResultKind | undefined;
}) =>
  result === undefined ? null : (
    <OutcomeNote
      text={RELEASE_OUTCOME_TEXT[result]}
      done={result === "released"}
    />
  );

export const ReleasePanel = ({
  conversation,
  current,
  acts,
}: {
  conversation: AvailableConversation;
  current: boolean;
  acts: ConversationActs;
}) => {
  // The revision the confirmation was opened at, while it is open.
  const [confirming, setConfirming] = useState<number | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const group = useRef<HTMLDivElement>(null);
  useReturnFocus(confirming !== null, trigger, group);
  const allowed = conversation.allowedActs.release;
  const changed = confirming !== null && confirming !== conversation.revision;

  const confirm = () => {
    if (confirming === null || changed) return;
    setConfirming(null);
    acts.sendRelease(confirming);
  };

  return (
    <div
      ref={group}
      tabIndex={-1}
      role="group"
      aria-label={RELEASE_GROUP_LABEL}
      className="flex flex-col gap-3 outline-none"
    >
      <ReleaseOutcome result={acts.releaseResult} />
      {conversation.optOutOpen ? <Note>{OPT_OUT_OPEN_RELEASE}</Note> : null}
      {!allowed || !current ? null : confirming === null ? (
        <div>
          <Button
            ref={trigger}
            variant="outline"
            disabled={acts.releasePending}
            onClick={() => setConfirming(conversation.revision)}
          >
            {RELEASE_BUTTON}
          </Button>
        </div>
      ) : (
        <ConfirmDialog
          title={RELEASE_CONFIRM_TITLE}
          body={RELEASE_CONFIRM_BODY}
          confirmLabel={RELEASE_CONFIRM_BUTTON}
          confirmDisabled={changed || acts.releasePending}
          notice={changed ? RELEASE_CHANGED_WHILE_OPEN : null}
          onConfirm={confirm}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
};
