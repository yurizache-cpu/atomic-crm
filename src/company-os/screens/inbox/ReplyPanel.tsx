import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import {
  ReplyTextSchema,
  type AvailableConversation,
} from "../../../../contracts/company-os-api/index.ts";
import { Note } from "../../components/display";
import { useRuntime } from "../../session/runtime";
import { TotpCodeForm } from "../../shell/SecondFactorFlow";
import {
  CHANGED_WHILE_OPEN,
  NO_FACTOR,
  REPLY_BUTTON,
  REPLY_CONFIRM_BODY,
  REPLY_CONFIRM_BUTTON,
  REPLY_CONFIRM_TITLE,
  REPLY_GROUP_LABEL,
  REPLY_HINT,
  REPLY_INVALID_TEXT,
  REPLY_LABEL,
  REPLY_PENDING_TEXT,
  REPLY_UNAVAILABLE_TEXT,
  STEP_UP_DONE,
  STEP_UP_NEW_FACTOR_NOTE,
  STEP_UP_RETRY,
  STEP_UP_SIGN_OUT,
  STEP_UP_TEXT,
  STEP_UP_UNAVAILABLE,
  replyCounter,
} from "./inboxCopy";
import { replyOnItsWay, replyOutcomeText } from "./inboxOutcomes";
import { ConfirmDialog, OutcomeNote } from "./inboxParts";
import { useReturnFocus } from "./useReturnFocus";
import type { ConversationActs } from "./useConversationActs";

// The browser inbox's reply (ADR 0026 §E, SI-87): the member writes their own
// text (nothing is prefilled, no draft is offered), asks to send it, and
// confirms; the confirmation names the revision the conversation showed, and
// cannot be given once the contact wrote again. One act per confirmation,
// never retried. A missing recent second factor asks for the authenticator
// code here, and the member then confirms the send again: nothing is sent on
// the code alone. Offered only while the server says a reply may be asked for
// and the answer is current; every refusal still comes from the server.

/** The authenticator code, for the member's own factor; or why it cannot be asked for here. */
const ReverifySecondFactor = ({ onVerified }: { onVerified: () => void }) => {
  const { mfa } = useRuntime();
  // undefined while the provider is asked; null: the provider says there is
  // no factor; "unavailable": the provider could not be asked (a failed
  // request is never read as "no factor").
  const [factorId, setFactorId] = useState<
    string | null | "unavailable" | undefined
  >(undefined);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (mfa === undefined) {
      setFactorId(null);
      return;
    }
    let active = true;
    setFactorId(undefined);
    mfa.status().then(
      (status) => {
        if (active)
          setFactorId(status === null ? "unavailable" : status.factorId);
      },
      () => {
        if (active) setFactorId("unavailable");
      },
    );
    return () => {
      active = false;
    };
  }, [mfa, attempt]);

  if (factorId === undefined) return null;
  if (factorId === "unavailable") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Note>{STEP_UP_UNAVAILABLE}</Note>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAttempt((n) => n + 1)}
        >
          {STEP_UP_RETRY}
        </Button>
      </div>
    );
  }
  if (factorId === null || mfa === undefined) return <Note>{NO_FACTOR}</Note>;
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <p className="text-sm">{STEP_UP_TEXT}</p>
      <Note>{STEP_UP_NEW_FACTOR_NOTE}</Note>
      <TotpCodeForm mfa={mfa} factorId={factorId} onVerified={onVerified} />
    </div>
  );
};

/** What the last act answered, and the second factor it asked for. */
const ReplyOutcome = ({ acts }: { acts: ConversationActs }) => {
  const result = acts.replyResult;
  if (acts.replyPending) {
    return (
      <p role="status" className="text-sm">
        {REPLY_PENDING_TEXT}
      </p>
    );
  }
  if (result === undefined) return null;
  if (result.kind === "second_factor_required") {
    if (acts.stepUp === "verified") {
      return <OutcomeNote text={STEP_UP_DONE} done={false} />;
    }
    if (acts.stepUp === "exhausted") {
      return <OutcomeNote text={STEP_UP_SIGN_OUT} done={false} />;
    }
    return (
      <>
        <OutcomeNote text={replyOutcomeText(result)} done={false} />
        <ReverifySecondFactor onVerified={acts.factorVerified} />
      </>
    );
  }
  return (
    <OutcomeNote text={replyOutcomeText(result)} done={replyOnItsWay(result)} />
  );
};

export const ReplyPanel = ({
  conversation,
  current,
  acts,
}: {
  conversation: AvailableConversation;
  current: boolean;
  acts: ConversationActs;
}) => {
  const fieldId = useId();
  const hintId = useId();
  // The revision the confirmation was opened at, while it is open.
  const [confirming, setConfirming] = useState<number | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const group = useRef<HTMLDivElement>(null);
  useReturnFocus(confirming !== null, trigger, group);
  const count = [...acts.draft].length;
  const valid = ReplyTextSchema.safeParse(acts.draft).success;
  const changed = confirming !== null && confirming !== conversation.revision;

  const confirm = () => {
    if (confirming === null || changed) return;
    setConfirming(null);
    acts.sendReply(conversation, confirming);
  };

  return (
    <div
      ref={group}
      tabIndex={-1}
      role="group"
      aria-label={REPLY_GROUP_LABEL}
      className="flex flex-col gap-3 outline-none"
    >
      <ReplyOutcome acts={acts} />
      {!conversation.allowedActs.reply ? (
        <Note>
          {
            REPLY_UNAVAILABLE_TEXT[
              conversation.replyUnavailable ?? "nothing_to_answer"
            ]
          }
        </Note>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <Label htmlFor={fieldId}>{REPLY_LABEL}</Label>
            <Textarea
              id={fieldId}
              aria-describedby={hintId}
              autoComplete="off"
              rows={4}
              value={acts.draft}
              disabled={acts.replyPending || confirming !== null}
              onChange={(event) => acts.setDraft(event.target.value)}
            />
            <p
              id={hintId}
              className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"
            >
              <span>{REPLY_HINT}</span>
              <span>{replyCounter(count)}</span>
            </p>
            {acts.draft !== "" && !valid ? (
              <p className="text-xs">{REPLY_INVALID_TEXT}</p>
            ) : null}
          </div>
          {!current ? null : confirming === null ? (
            <div>
              <Button
                ref={trigger}
                disabled={!valid || acts.replyPending}
                onClick={() => setConfirming(conversation.revision)}
              >
                {REPLY_BUTTON}
              </Button>
            </div>
          ) : (
            <ConfirmDialog
              title={REPLY_CONFIRM_TITLE}
              body={REPLY_CONFIRM_BODY}
              confirmLabel={REPLY_CONFIRM_BUTTON}
              confirmDisabled={changed || acts.replyPending}
              notice={changed ? CHANGED_WHILE_OPEN : null}
              onConfirm={confirm}
              onCancel={() => setConfirming(null)}
            />
          )}
        </>
      )}
    </div>
  );
};
