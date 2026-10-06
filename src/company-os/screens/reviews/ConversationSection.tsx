import type {
  ReviewConversation,
  ReviewDetail,
} from "../../../../contracts/company-os-api/index.ts";
import { Field, Fields, None, Note, Section } from "../../components/display";
import {
  CONVERSATION_NEWER_MESSAGE,
  CONVERSATION_NO_DRAFT,
  CONVERSATION_NO_SCREENING,
  CONVERSATION_NOTE,
  CONVERSATION_REDACTED,
  CONVERSATION_TITLE,
  CONVERSATION_UNAVAILABLE,
  FIXED_MESSAGE_LABELS,
  SCREENING_CLASS_LABELS,
  SCREENING_DISPOSITION_LABELS,
  SCREENING_NOTHING_READ,
} from "../../copy";

// ADR 0023 §L: what the assistant read of the message (the front desk's
// screened text, never the raw message) and the reply draft the send would
// carry, so a person sees what they accept. Read only: it changes nothing about
// the decisions a person may make, and accepting still sends nothing.

type Available = Extract<ReviewConversation, { status: "available" }>;

const Text = ({ children }: { children: string }) => (
  <span className="whitespace-pre-wrap">{children}</span>
);

const Message = ({ conversation }: { conversation: Available }) => {
  const { screening } = conversation;
  if (screening === null) return <None>{CONVERSATION_NO_SCREENING}</None>;
  if (screening.screenedMessage !== null)
    return <Text>{screening.screenedMessage}</Text>;
  return <None>{SCREENING_NOTHING_READ[screening.messageClass]}</None>;
};

const Reply = ({ conversation }: { conversation: Available }) => {
  if (conversation.replyDraft !== null)
    return <Text>{conversation.replyDraft}</Text>;
  return (
    <None>
      {conversation.contentRedacted
        ? CONVERSATION_REDACTED
        : CONVERSATION_NO_DRAFT}
    </None>
  );
};

const AvailableConversation = ({
  conversation,
}: {
  conversation: Available;
}) => {
  const { screening } = conversation;
  return (
    <>
      {conversation.newerMessage ? (
        <p role="alert" className="text-sm font-medium text-amber-700">
          {CONVERSATION_NEWER_MESSAGE}
        </p>
      ) : null}
      <Fields label={CONVERSATION_TITLE}>
        <Field term="Mensagem que o assistente leu">
          <Message conversation={conversation} />
        </Field>
        {screening === null ? null : (
          <>
            <Field term="Classificação">
              {SCREENING_CLASS_LABELS[screening.messageClass]}
            </Field>
            <Field term="Quem respondeu">
              {screening.fixedMessageKey === null
                ? SCREENING_DISPOSITION_LABELS[screening.disposition]
                : `${SCREENING_DISPOSITION_LABELS[screening.disposition]}: ${FIXED_MESSAGE_LABELS[screening.fixedMessageKey]}`}
            </Field>
          </>
        )}
        <Field term="Resposta que o envio levaria">
          <Reply conversation={conversation} />
        </Field>
      </Fields>
    </>
  );
};

export const ConversationSection = ({ review }: { review: ReviewDetail }) => (
  <Section title={CONVERSATION_TITLE}>
    <Note>{CONVERSATION_NOTE}</Note>
    {review.conversation.status === "unavailable" ? (
      <p className="text-sm">{CONVERSATION_UNAVAILABLE}</p>
    ) : (
      <AvailableConversation conversation={review.conversation} />
    )}
  </Section>
);
