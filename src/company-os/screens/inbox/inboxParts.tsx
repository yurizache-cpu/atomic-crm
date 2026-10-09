import { useEffect, useId, useRef } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { CANCEL_BUTTON } from "./inboxCopy";

// The inbox acts' two shared pieces: the confirmation each act needs before it
// is asked for (its safe choice has the focus), and the line that says what
// the server answered.

export const ConfirmDialog = ({
  title,
  body,
  confirmLabel,
  confirmDisabled,
  notice,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  confirmDisabled: boolean;
  /** Why confirming is not possible now, when it is not. */
  notice?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  const titleId = useId();
  const bodyId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  // The safe choice has the focus: confirming is a second, deliberate act.
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-4"
    >
      <p id={titleId} className="font-medium">
        {title}
      </p>
      <p id={bodyId} className="text-sm">
        {body}
      </p>
      {notice ? (
        <p role="status" className="text-sm font-medium">
          {notice}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={confirmDisabled} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button ref={cancel} variant="ghost" onClick={onCancel}>
          {CANCEL_BUTTON}
        </Button>
      </div>
    </div>
  );
};

/** What the server answered to an act: green once it is on its way, amber otherwise. */
export const OutcomeNote = ({
  text,
  done,
}: {
  text: string;
  done: boolean;
}) => (
  <p
    role="status"
    className={cn(
      "rounded-lg border px-3 py-2 text-sm",
      done
        ? "border-emerald-500/40 bg-emerald-500/10"
        : "border-amber-500/40 bg-amber-500/10",
    )}
  >
    {text}
  </p>
);
