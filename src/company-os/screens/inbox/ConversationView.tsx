import { Link } from "react-router";

import type {
  AvailableConversation,
  Conversation,
} from "../../../../contracts/company-os-api/index.ts";
import { Field, Fields, None, Note, Section } from "../../components/display";
import { RelativeTime } from "../../components/owner";
import { LIST_PATHS } from "../../components/recordPaths";
import { STATE_UNKNOWN_NOTE } from "../../copy";
import {
  BACK_TO_INBOX,
  CONVERSATION_NOTE,
  CONVERSATION_NOT_WAITING,
  CONVERSATION_WITHHELD,
  HOLDER_LABEL,
  NO_FIRST_NAME,
  OPT_OUT_OPEN_NOTE,
  REPLY_GROUP_LABEL,
  RELEASE_GROUP_LABEL,
  TURNS_TITLE,
  windowText,
} from "./inboxCopy";
import { replyOnItsWay, replyOutcomeText } from "./inboxOutcomes";
import { OutcomeNote } from "./inboxParts";
import { ReleaseOutcome, ReleasePanel } from "./ReleasePanel";
import { ReplyPanel } from "./ReplyPanel";
import { TurnList } from "./TurnList";
import type { ConversationActs } from "./useConversationActs";

// One conversation of the browser inbox as the server answered it (ADR 0026
// §E, SI-87): withheld or no longer waiting is a state with its own sentence;
// an available conversation shows who it is with, its window, its turns and
// the two acts the server allows now. When the answer is too old to be
// current, the acts hide their buttons until a new one arrives.

/** The last answers of the acts, kept when the conversation leaves the queue. */
const LastOutcomes = ({ acts }: { acts: ConversationActs }) => (
  <>
    {acts.replyResult === undefined ? null : (
      <OutcomeNote
        text={replyOutcomeText(acts.replyResult)}
        done={replyOnItsWay(acts.replyResult)}
      />
    )}
    <ReleaseOutcome result={acts.releaseResult} />
  </>
);

const StateView = ({
  text,
  acts,
}: {
  text: string;
  acts: ConversationActs;
}) => (
  <Section title="Situação">
    <LastOutcomes acts={acts} />
    <Note>{text}</Note>
    <div>
      <Link
        to={LIST_PATHS.inbox}
        className="text-sm underline underline-offset-4"
      >
        {BACK_TO_INBOX}
      </Link>
    </div>
  </Section>
);

const Available = ({
  conversation,
  current,
  acts,
}: {
  conversation: AvailableConversation;
  current: boolean;
  acts: ConversationActs;
}) => (
  <>
    {current ? null : (
      <p role="status" className="text-sm font-medium">
        {STATE_UNKNOWN_NOTE}
      </p>
    )}
    <Section title="Contato">
      <Fields label="Contato">
        <Field term="Nome no CRM">
          {conversation.firstName ?? <None>{NO_FIRST_NAME}</None>}
        </Field>
        <Field term="Com quem está">{HOLDER_LABEL[conversation.holder]}</Field>
        <Field term="Última mensagem">
          <RelativeTime value={conversation.lastMessageAt} />
        </Field>
        <Field term="Janela de resposta">
          {windowText(conversation.windowEndsAt, conversation.asOf)}
        </Field>
      </Fields>
      {conversation.optOutOpen ? <Note>{OPT_OUT_OPEN_NOTE}</Note> : null}
      <Note>{CONVERSATION_NOTE}</Note>
    </Section>
    <Section title={TURNS_TITLE}>
      <TurnList
        turns={conversation.turns}
        earlierTurns={conversation.earlierTurns}
      />
    </Section>
    <Section title={REPLY_GROUP_LABEL}>
      <ReplyPanel conversation={conversation} current={current} acts={acts} />
    </Section>
    {conversation.allowedActs.release ||
    conversation.optOutOpen ||
    acts.releaseResult !== undefined ? (
      <Section title={RELEASE_GROUP_LABEL}>
        <ReleasePanel
          conversation={conversation}
          current={current}
          acts={acts}
        />
      </Section>
    ) : null}
  </>
);

export const ConversationView = ({
  conversation,
  current,
  acts,
}: {
  conversation: Conversation;
  current: boolean;
  acts: ConversationActs;
}) => {
  switch (conversation.status) {
    case "withheld":
      return (
        <StateView
          text={CONVERSATION_WITHHELD[conversation.reason]}
          acts={acts}
        />
      );
    case "not_waiting":
      return <StateView text={CONVERSATION_NOT_WAITING} acts={acts} />;
    case "available":
      return (
        <Available conversation={conversation} current={current} acts={acts} />
      );
  }
};
