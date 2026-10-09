import { cn } from "@/lib/utils";

import type { ConversationTurn } from "../../../../contracts/company-os-api/index.ts";
import { Note } from "../../components/display";
import { RelativeTime } from "../../components/owner";
import {
  DELIVERY_LABEL,
  EARLIER_TURNS_NOTE,
  HIDDEN_MARKER,
  INBOUND_LABEL,
  NO_TURNS,
  PRIVACY_NOTICE_NOTE,
  authorLabel,
  reasonText,
  refusedMarker,
} from "./inboxCopy";

// The conversation's turns, oldest first (ADR 0026 §E, SI-87): what the
// contact wrote, in its own words, only where the server sent its text; a
// message the transport refused, by its reason only; and every reply that
// left or may have left, or a person's reply asked for here, with who wrote
// it and where its delivery stands. Every text is plain React text, its line
// breaks kept: no markup is ever read from it and no link is ever made of it.

const Body = ({
  text,
  hidden,
}: {
  text: string | null;
  hidden: keyof typeof HIDDEN_MARKER | null;
}) =>
  text === null ? (
    <p className="text-sm italic text-muted-foreground">
      {HIDDEN_MARKER[hidden ?? "withheld"]}
    </p>
  ) : (
    <p className="whitespace-pre-wrap break-words text-sm">{text}</p>
  );

const Header = ({ label, at }: { label: string; at: string }) => (
  <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
    <span className="font-medium text-foreground">{label}</span>
    <RelativeTime value={at} />
  </p>
);

const deliveryText = (
  delivery: keyof typeof DELIVERY_LABEL,
  reason: string | null,
) =>
  reason === null
    ? DELIVERY_LABEL[delivery]
    : `${DELIVERY_LABEL[delivery]}: ${reasonText(reason)}`;

const Turn = ({ turn }: { turn: ConversationTurn }) => {
  switch (turn.kind) {
    case "inbound":
      return (
        <>
          <Header label={INBOUND_LABEL} at={turn.at} />
          <Body text={turn.text} hidden={turn.hidden} />
        </>
      );
    case "refused":
      return (
        <>
          <Header label={INBOUND_LABEL} at={turn.at} />
          <p className="text-sm italic text-muted-foreground">
            {refusedMarker(turn.reason)}
          </p>
        </>
      );
    case "reply":
      return (
        <>
          <Header
            label={authorLabel(turn.author, turn.fixedKey, turn.automatic)}
            at={turn.at}
          />
          <Body text={turn.text} hidden={turn.hidden} />
          <p className="text-xs text-muted-foreground">
            {deliveryText(turn.delivery, turn.reason)}
            {turn.withPrivacyNotice ? ` · ${PRIVACY_NOTICE_NOTE}` : null}
          </p>
        </>
      );
  }
};

export const TurnList = ({
  turns,
  earlierTurns,
}: {
  turns: readonly ConversationTurn[];
  earlierTurns: boolean;
}) => (
  <div className="flex flex-col gap-3">
    {earlierTurns ? <Note>{EARLIER_TURNS_NOTE}</Note> : null}
    {turns.length === 0 ? (
      <Note>{NO_TURNS}</Note>
    ) : (
      <ol aria-label="Mensagens da conversa" className="flex flex-col gap-2">
        {turns.map((turn, index) => (
          <li
            // The turns carry no identifier, by design: their order is their key.
            key={index}
            className={cn(
              "flex max-w-[85%] flex-col gap-1 rounded-lg border px-3 py-2",
              turn.kind === "reply"
                ? "self-end border-primary/30 bg-primary/5"
                : "self-start bg-card",
            )}
          >
            <Turn turn={turn} />
          </li>
        ))}
      </ol>
    )}
  </div>
);
