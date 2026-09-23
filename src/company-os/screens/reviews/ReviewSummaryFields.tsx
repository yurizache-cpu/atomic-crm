import type { ReviewSummary } from "../../../../contracts/company-os-api/index.ts";
import {
  Field,
  None,
  RecordLink,
  StateBadge,
  Timestamp,
  YesNo,
} from "../../components/display";
import { outboundRecordText, reviewStatusText } from "./reviewLabels";

// A review's summary as definition-list rows, shared by the review detail and
// the task detail. No reviewer label exists in the projection (the stored one
// is free-form), and no field of the model's proposal: that is the advice,
// read only on explicit open.

export const ReviewStatusBadge = ({ review }: { review: ReviewSummary }) => (
  <StateBadge value={review.status} label={reviewStatusText(review.status)} />
);

export const ReviewSummaryFields = ({ review }: { review: ReviewSummary }) => (
  <>
    <Field term="Review">
      <RecordLink kind="review" id={review.id} />
    </Field>
    <Field term="Status">
      <ReviewStatusBadge review={review} />
    </Field>
    <Field term="Capability">{review.capability}</Field>
    <Field term="Task">
      <RecordLink kind="task" id={review.taskId} />
    </Field>
    <Field term="Agent run">
      {review.agentRunId === null ? (
        <None />
      ) : (
        <RecordLink kind="run" id={review.agentRunId} />
      )}
    </Field>
    <Field term="Do not contact">
      <YesNo value={review.doNotContact} />
    </Field>
    <Field term="Opened">
      <Timestamp value={review.createdAt} />
    </Field>
    <Field term="Decided">
      <Timestamp value={review.reviewedAt} />
    </Field>
    <Field term="Has a decision note">
      <YesNo value={review.hasNote} />
    </Field>
    <Field term="Outbound record">
      <span>{outboundRecordText(review.outboundStatus)}</span>
    </Field>
  </>
);
