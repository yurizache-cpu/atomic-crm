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
import { REVIEW_NOT_A_SEND_NOTE } from "../../copy";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";
import { useOperatorScope } from "../../session/runtime";
import { AdviceView } from "./AdviceView";
import { DecisionPanel } from "./DecisionPanel";
import { ReviewSummaryFields } from "./ReviewSummaryFields";
import { ShadowDecisionSection } from "./ShadowDecisionSection";

// One review (get_review): its summary, the decision note and, while it is
// open, the one browser act (S7.1): the member's decision, confirmed, which
// sends nothing. The structured advice is a separate read, made only when the
// operator opens it and dropped from memory when they close it
// (docs/PHASE_2C_BRIEF.md §13 item 3). The reply draft is never shown. The
// shadow decision (Phase 2D.1) is shown read only, and decides nothing.

const Decision = ({ review }: { review: ReviewDetailData }) => (
  <Section title="Decisão">
    <Note>{REVIEW_NOT_A_SEND_NOTE}</Note>
    <Fields label="Decisão">
      <Field term="Nota da decisão">
        {review.decisionNote === null ? (
          <None>sem nota</None>
        ) : (
          <span className="whitespace-pre-wrap">{review.decisionNote}</span>
        )}
      </Field>
    </Fields>
    {/* Keyed by review: a decision's outcome belongs to that review alone. */}
    <DecisionPanel key={review.id} review={review} />
  </Section>
);

const Advice = ({ reviewId }: { reviewId: string }) => {
  const { context } = useOperatorScope();
  const [open, setOpen] = useState(false);
  if (!context.allowedActions.viewAdvice) {
    return (
      <Section title="Análise da IA">
        <Note>A análise não está disponível para este operador.</Note>
      </Section>
    );
  }
  return (
    <Section title="Análise da IA">
      <Note>
        A análise estruturada só é lida quando você a abre, e é descartada
        quando você a fecha.
      </Note>
      <div>
        <Button
          variant="outline"
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Ocultar análise" : "Ver análise"}
        </Button>
      </div>
      {open ? <AdviceView reviewId={reviewId} /> : null}
    </Section>
  );
};

const ReviewDetailBody = ({ review }: { review: ReviewDetailData }) => (
  <>
    <Section title="Revisão">
      <Fields label="Revisão">
        <ReviewSummaryFields review={review} />
      </Fields>
    </Section>
    <Decision review={review} />
    {/* Phase 2D.1: advisory, read only; it changes nothing above. */}
    <ShadowDecisionSection review={review} />
    {/* Keyed by review: the route keeps this element when only :reviewId
        changes (Back, a typed address), and an advice view opened on one
        review must never read or show another's without its own open. */}
    <Advice key={review.id} reviewId={review.id} />
  </>
);

const ReviewDetailRead = ({ reviewId }: { reviewId: string }) => {
  const review = useCompanyOsQuery("get_review", { p_review_id: reviewId });
  return (
    <QueryView query={review} what="a revisão">
      {(data) => <ReviewDetailBody review={data} />}
    </QueryView>
  );
};

export const ReviewDetail = () => {
  const reviewId = useRouteRecordId("reviewId");
  return (
    <ScreenLayout title="Decisão">
      <Link
        to={LIST_PATHS.reviews}
        className="text-sm underline underline-offset-4"
      >
        ← Voltar às decisões
      </Link>
      {reviewId === null ? (
        <RecordNotFound />
      ) : (
        <ReviewDetailRead reviewId={reviewId} />
      )}
    </ScreenLayout>
  );
};
