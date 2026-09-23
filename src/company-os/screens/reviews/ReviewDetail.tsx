import { useState } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";

import { type ReviewDetail as ReviewDetailData } from "../../../../contracts/company-os-api/index.ts";
import {
  Field,
  Fields,
  None,
  Note,
  ScreenLayout,
  Section,
} from "../../components/display";
import { QueryView } from "../../components/queryStates";
import { RecordNotFound } from "../../components/RecordNotFound";
import { useRouteRecordId } from "../../components/routeRecord";
import { LIST_PATHS } from "../../components/recordPaths";
import {
  ALLOWED_DECISIONS_NOTE,
  REVIEW_DECISIONS_CLI_NOTE,
  REVIEW_NOT_A_SEND_NOTE,
} from "../../copy";
import { humanize } from "../../format/labels";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";
import { useOperatorScope } from "../../session/runtime";
import { AdviceView } from "./AdviceView";
import { ReviewSummaryFields } from "./ReviewSummaryFields";

// One review (get_review): its summary, the decision note and the decisions
// the server would accept, shown as information only: there is no decision
// control in this phase. The structured advice is a separate read, made only
// when the operator opens it and dropped from memory when they close it
// (docs/PHASE_2C_BRIEF.md §13 item 3). The reply draft is never shown.

const Decision = ({ review }: { review: ReviewDetailData }) => (
  <Section title="Decision">
    <Note>{`${REVIEW_DECISIONS_CLI_NOTE} ${REVIEW_NOT_A_SEND_NOTE}`}</Note>
    <Fields label="Decision">
      <Field term="Decision note">
        {review.decisionNote === null ? (
          <None>no note</None>
        ) : (
          <span className="whitespace-pre-wrap">{review.decisionNote}</span>
        )}
      </Field>
      <Field term="Decisions the server would accept">
        {review.allowedDecisions.length === 0 ? (
          <None>none: this review is not pending</None>
        ) : (
          <span>{review.allowedDecisions.map(humanize).join(", ")}</span>
        )}
      </Field>
    </Fields>
    {review.allowedDecisions.length === 0 ? null : (
      <Note>{ALLOWED_DECISIONS_NOTE}</Note>
    )}
  </Section>
);

const Advice = ({ reviewId }: { reviewId: string }) => {
  const { context } = useOperatorScope();
  const [open, setOpen] = useState(false);
  if (!context.allowedActions.viewAdvice) {
    return (
      <Section title="Advice">
        <Note>Advice is not available to this operator.</Note>
      </Section>
    );
  }
  return (
    <Section title="Advice">
      <Note>
        The structured advice is read only when you open it, and is dropped when
        you close it.
      </Note>
      <div>
        <Button
          variant="outline"
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide advice" : "Show advice"}
        </Button>
      </div>
      {open ? <AdviceView reviewId={reviewId} /> : null}
    </Section>
  );
};

const ReviewDetailBody = ({ review }: { review: ReviewDetailData }) => (
  <>
    <Section title="Review">
      <Fields label="Review">
        <ReviewSummaryFields review={review} />
      </Fields>
    </Section>
    <Decision review={review} />
    {/* Keyed by review: the route keeps this element when only :reviewId
        changes (Back, a typed address), and an advice view opened on one
        review must never read or show another's without its own open. */}
    <Advice key={review.id} reviewId={review.id} />
  </>
);

const ReviewDetailRead = ({ reviewId }: { reviewId: string }) => {
  const review = useCompanyOsQuery("get_review", { p_review_id: reviewId });
  return (
    <QueryView query={review} what="the review">
      {(data) => <ReviewDetailBody review={data} />}
    </QueryView>
  );
};

export const ReviewDetail = () => {
  const reviewId = useRouteRecordId("reviewId");
  return (
    <ScreenLayout title="Review">
      <Link
        to={LIST_PATHS.reviews}
        className="text-sm underline underline-offset-4"
      >
        All pending reviews
      </Link>
      {reviewId === null ? (
        <RecordNotFound />
      ) : (
        <ReviewDetailRead reviewId={reviewId} />
      )}
    </ScreenLayout>
  );
};
