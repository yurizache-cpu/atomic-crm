import type { LeadTriageAdvice } from "../../../../contracts/company-os-api/index.ts";
import { Field, Fields, None, Note, YesNo } from "../../components/display";
import { QueryView } from "../../components/queryStates";
import { REPLY_DRAFT_NOTE } from "../../copy";
import { humanize } from "../../format/labels";
import { useReviewAdvice } from "../../query/useReviewAdvice";
import { WITHHELD_TEXT } from "./reviewLabels";

// The one content read (docs/PHASE_2C_BRIEF.md §9 ReviewAdvice, §13 item 3):
// mounted only while the operator has the advice open. useReviewAdvice keeps
// the answer for no time (gcTime 0) and removes it from the cache when this
// view unmounts. It shows the lead_triage classification, the summary and the
// recommended next action, or why the advice is withheld; never the reply
// draft, which the projection does not carry and its contract refuses.

const LeadTriageAdviceFields = ({ advice }: { advice: LeadTriageAdvice }) => (
  <Fields label="Advice">
    <Field term="Outcome">{humanize(advice.outcome)}</Field>
    <Field term="Intent">{humanize(advice.intent)}</Field>
    <Field term="Priority">{advice.priority}</Field>
    <Field term="Needs human review">
      <YesNo value={advice.needsHumanReview} />
    </Field>
    <Field term="Flags">
      {advice.flags.length === 0 ? (
        <None />
      ) : (
        <span>{advice.flags.map(humanize).join(", ")}</span>
      )}
    </Field>
    <Field term="Summary">
      <span className="whitespace-pre-wrap">{advice.summary}</span>
    </Field>
    <Field term="Recommended next action">
      <span className="whitespace-pre-wrap">
        {advice.recommendedNextAction}
      </span>
    </Field>
  </Fields>
);

export const AdviceView = ({ reviewId }: { reviewId: string }) => {
  const advice = useReviewAdvice(reviewId);
  return (
    <div
      role="region"
      aria-label="Structured advice"
      className="flex flex-col gap-3"
    >
      <QueryView query={advice} what="the advice">
        {(data) =>
          "withheld" in data ? (
            <p>{`Advice withheld: ${WITHHELD_TEXT[data.withheld]}.`}</p>
          ) : (
            <LeadTriageAdviceFields advice={data} />
          )
        }
      </QueryView>
      <Note>{REPLY_DRAFT_NOTE}</Note>
    </div>
  );
};
