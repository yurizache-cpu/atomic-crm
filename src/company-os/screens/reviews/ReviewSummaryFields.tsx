import type { ReviewSummary } from "../../../../contracts/company-os-api/index.ts";
import {
  Field,
  RecordLink,
  StateBadge,
  Timestamp,
  YesNo,
} from "../../components/display";
import { TechnicalDetails } from "../../components/owner";
import { capabilityLabel } from "../../format/ptBR";
import { outboundRecordText, reviewStatusText } from "./reviewLabels";

// A review's summary as the owner reads it: its state, what kind of work it
// decides, when it was opened and decided, and whether a send was ever
// recorded; never a reviewer label (docs/PHASE_2C_BRIEF.md §9). The ids stay in
// the technical details.

export const ReviewStatusBadge = ({ review }: { review: ReviewSummary }) => (
  <StateBadge value={review.status} label={reviewStatusText(review.status)} />
);

export const ReviewSummaryFields = ({ review }: { review: ReviewSummary }) => (
  <>
    <Field term="Situação">
      <ReviewStatusBadge review={review} />
    </Field>
    <Field term="Trabalho">{capabilityLabel(review.capability)}</Field>
    <Field term="Tarefa">
      <RecordLink
        kind="task"
        id={review.taskId}
        label={`Tarefa ${review.taskId}`}
      >
        Ver tarefa
      </RecordLink>
    </Field>
    <Field term="Execução da IA">
      {review.agentRunId === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <RecordLink
          kind="run"
          id={review.agentRunId}
          label={`Execução ${review.agentRunId}`}
        >
          Ver execução
        </RecordLink>
      )}
    </Field>
    <Field term="Não contatar">
      <YesNo value={review.doNotContact} />
    </Field>
    <Field term="Aberta">
      <Timestamp value={review.createdAt} />
    </Field>
    <Field term="Decidida">
      <Timestamp value={review.reviewedAt} />
    </Field>
    <Field term="Tem nota de decisão">
      <YesNo value={review.hasNote} />
    </Field>
    <Field term="Envio">
      <span>{outboundRecordText(review.outboundStatus)}</span>
    </Field>
    <Field term="Técnico">
      <TechnicalDetails
        rows={[
          ["Revisão", review.id],
          ["Tarefa", review.taskId],
          ["Execução", review.agentRunId ?? "—"],
          ["Capacidade", review.capability],
          ["Situação", review.status],
          ["Aberta (UTC)", review.createdAt],
          ["Decidida (UTC)", review.reviewedAt ?? "—"],
        ]}
      />
    </Field>
  </>
);
