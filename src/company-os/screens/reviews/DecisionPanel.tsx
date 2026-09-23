import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type {
  ReviewDecision,
  ReviewDetail,
} from "../../../../contracts/company-os-api/index.ts";
import { Note } from "../../components/display";
import {
  DECISION_ACTIONS,
  DECISION_ALREADY_RECORDED_TEXT,
  DECISION_CONFIRM_TITLE,
  DECISION_NOT_ALLOWED_TEXT,
  DECISION_NOT_FOUND_TEXT,
  DECISION_RECORDS_TEXT,
  DECISION_REFUSED_TEXT,
  DECISION_UNKNOWN_TEXT,
  DO_NOT_CONTACT_ACCEPT_NOTE,
  NO_MESSAGE_SENT_TEXT,
  NO_MESSAGE_WAS_SENT_TEXT,
} from "../../copy";
import { reviewStatusLabel } from "../../format/ptBR";
import {
  useDecideReview,
  type DecisionOutcome,
} from "../../query/useDecideReview";
import { useOperatorScope } from "../../session/runtime";

// The one browser act (S7.1): three explicit human decisions on an open review,
// each behind its own confirmation, none preselected or focused by default.
// Accepting records a decision and sends nothing; the screen says so before
// and after. Shown only for a pending review the server would let this member
// decide; every refusal still comes from the server.

const variantOf: Record<
  ReviewDecision,
  { variant: "default" | "secondary" | "outline"; className?: string }
> = {
  accepted: { variant: "default" },
  needs_edit: { variant: "secondary" },
  rejected: {
    variant: "outline",
    className: "border-destructive/50 text-destructive hover:text-destructive",
  },
};

const OutcomeMessage = ({ outcome }: { outcome: DecisionOutcome }) => {
  const text = (() => {
    switch (outcome.kind) {
      case "recorded":
        return `Decisão registrada: ${reviewStatusLabel(outcome.status)}. ${NO_MESSAGE_WAS_SENT_TEXT}`;
      case "already_decided":
        return outcome.status === null || outcome.status === "pending"
          ? DECISION_ALREADY_RECORDED_TEXT
          : `${DECISION_ALREADY_RECORDED_TEXT} Situação atual: ${reviewStatusLabel(outcome.status)}.`;
      case "not_allowed":
        return DECISION_NOT_ALLOWED_TEXT;
      case "not_found":
        return DECISION_NOT_FOUND_TEXT;
      case "refused":
        return DECISION_REFUSED_TEXT;
      case "unknown":
        return DECISION_UNKNOWN_TEXT;
    }
  })();
  return (
    <p
      role="status"
      className={cn(
        "rounded-lg border px-3 py-2 text-sm",
        outcome.kind === "recorded"
          ? "border-emerald-500/40 bg-emerald-500/10"
          : "border-amber-500/40 bg-amber-500/10",
      )}
    >
      {text}
    </p>
  );
};

/** The decisions that end this review's controls: anything but an unknown or a bad request. */
const closesControls = (outcome: DecisionOutcome | undefined) =>
  outcome !== undefined &&
  outcome.kind !== "unknown" &&
  outcome.kind !== "refused";

const Confirmation = ({
  decision,
  pending,
  onConfirm,
  onCancel,
}: {
  decision: ReviewDecision;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = `decision-confirm-${decision}`;
  // The safe choice has the focus: confirming is a second, deliberate act.
  useEffect(() => cancel.current?.focus(), [decision]);
  return (
    <div
      role="alertdialog"
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-4"
    >
      <p id={titleId} className="font-medium">
        {DECISION_CONFIRM_TITLE[decision]}
      </p>
      <p className="text-sm">
        {DECISION_RECORDS_TEXT} {NO_MESSAGE_SENT_TEXT}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant={variantOf[decision].variant}
          className={variantOf[decision].className}
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? "Registrando…" : "Confirmar"}
        </Button>
        <Button
          ref={cancel}
          variant="ghost"
          disabled={pending}
          onClick={onCancel}
        >
          Cancelar
        </Button>
      </div>
    </div>
  );
};

export const DecisionPanel = ({ review }: { review: ReviewDetail }) => {
  const { context } = useOperatorScope();
  const decide = useDecideReview(review.id);
  const [choice, setChoice] = useState<ReviewDecision | null>(null);
  const outcome = decide.data;
  const open =
    review.status === "pending" &&
    review.allowedDecisions.length > 0 &&
    context.allowedActions.decideReview &&
    !closesControls(outcome);

  const confirm = () => {
    if (choice === null || decide.isPending) return;
    decide.mutate(choice, { onSettled: () => setChoice(null) });
  };

  return (
    <div className="flex flex-col gap-3">
      {outcome === undefined ? null : <OutcomeMessage outcome={outcome} />}
      {!open ? null : (
        <>
          {review.allowedDecisions.includes("accepted") ? null : (
            <Note>{DO_NOT_CONTACT_ACCEPT_NOTE}</Note>
          )}
          <div
            role="group"
            aria-label="Registrar decisão"
            className="flex flex-wrap gap-2"
          >
            {DECISION_ACTIONS.filter((action) =>
              review.allowedDecisions.includes(action.decision),
            ).map((action) => (
              <Button
                key={action.decision}
                variant={variantOf[action.decision].variant}
                className={variantOf[action.decision].className}
                disabled={decide.isPending}
                aria-pressed={choice === action.decision}
                onClick={() => setChoice(action.decision)}
              >
                {action.label}
              </Button>
            ))}
          </div>
          {choice === null ? null : (
            <Confirmation
              decision={choice}
              pending={decide.isPending}
              onConfirm={confirm}
              onCancel={() => setChoice(null)}
            />
          )}
        </>
      )}
    </div>
  );
};
