import { Inbox } from "lucide-react";
import { Link, Route, Routes, useSearchParams } from "react-router";

import { cn } from "@/lib/utils";

import {
  REVIEW_STATUSES,
  type ReviewStatus,
  type ReviewSummary,
} from "../../../../contracts/company-os-api/index.ts";
import { Note, RecordLink, ScreenLayout } from "../../components/display";
import {
  EmptyState,
  Meta,
  OwnerCard,
  RelativeTime,
  TechnicalDetails,
} from "../../components/owner";
import { PageControls, PagesView } from "../../components/queryStates";
import { LIST_PATHS } from "../../components/recordPaths";
import { REVIEW_DECISIONS_CLI_NOTE, REVIEW_NOT_A_SEND_NOTE } from "../../copy";
import { oneOf } from "../../format/labels";
import { capabilityLabel, reviewStatusLabel } from "../../format/ptBR";
import { itemsOf, useCompanyOsPages } from "../../query/useCompanyOsPages";
import { ReviewDetail } from "./ReviewDetail";
import { outboundRecordText } from "./reviewLabels";
import { ReviewStatusBadge } from "./ReviewSummaryFields";

// Screen 6, Reviews / Decision Queue (docs/PHASE_2C_BRIEF.md §12). Pending
// first: the pending tab is the default and lists the oldest first, as the
// server orders it; each decided status has its own tab. Read-only in this
// phase: decisions are recorded through the operator CLI, and no screen offers
// one. A list carries no field of the model's proposal and no decision note.

const TABS: readonly ReviewStatus[] = REVIEW_STATUSES;

const StatusTabs = ({ active }: { active: ReviewStatus }) => (
  <nav
    aria-label="Situação da decisão"
    className="flex flex-wrap gap-1 border-b"
  >
    {TABS.map((status) => (
      <Link
        key={status}
        to={`${LIST_PATHS.reviews}?${new URLSearchParams({ status }).toString()}`}
        aria-current={status === active ? "page" : undefined}
        className={cn(
          "rounded-t-md px-3 py-2 text-sm",
          status === active ? "bg-accent font-medium" : "hover:bg-accent/50",
        )}
      >
        {reviewStatusLabel(status)}
      </Link>
    ))}
  </nav>
);

const ReviewCard = ({ review }: { review: ReviewSummary }) => (
  <OwnerCard
    label={`Decisão ${capabilityLabel(review.capability)}`}
    className="flex flex-col gap-3"
  >
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <span className="rounded-xl bg-amber-500/10 p-2.5 text-amber-700 dark:text-amber-300">
          <Inbox aria-hidden className="size-5" />
        </span>
        <div className="flex flex-col gap-1">
          <span className="font-medium">
            {capabilityLabel(review.capability)}
          </span>
          <span className="text-xs text-muted-foreground">
            Aberta <RelativeTime value={review.createdAt} />
            {review.reviewedAt === null ? null : (
              <>
                {" · decidida "}
                <RelativeTime value={review.reviewedAt} />
              </>
            )}
          </span>
        </div>
      </div>
      <ReviewStatusBadge review={review} />
    </div>
    <div className="flex flex-wrap gap-x-6 gap-y-1">
      {review.doNotContact ? (
        <span className="text-xs font-medium text-rose-700 dark:text-rose-300">
          Não contatar
        </span>
      ) : null}
      <Meta label="Envio">{outboundRecordText(review.outboundStatus)}</Meta>
      <Meta label="Nota">{review.hasNote ? "Sim" : "Não"}</Meta>
    </div>
    <div className="flex flex-wrap gap-4">
      <RecordLink
        kind="review"
        id={review.id}
        label={`Ver análise da revisão ${review.id}`}
      >
        Ver análise
      </RecordLink>
      <RecordLink
        kind="task"
        id={review.taskId}
        label={`Tarefa ${review.taskId}`}
      >
        Ver tarefa
      </RecordLink>
    </div>
    <TechnicalDetails
      rows={[
        ["Revisão", review.id],
        ["Tarefa", review.taskId],
        ["Execução", review.agentRunId ?? "—"],
        ["Capacidade", review.capability],
        ["Situação", review.status],
        ["Aberta (UTC)", review.createdAt],
      ]}
    />
  </OwnerCard>
);

const ReviewTable = ({ reviews }: { reviews: readonly ReviewSummary[] }) => (
  <div role="list" aria-label="Decisões" className="flex flex-col gap-3">
    {reviews.map((review) => (
      <div role="listitem" key={review.id}>
        <ReviewCard review={review} />
      </div>
    ))}
  </div>
);

const ReviewList = () => {
  const [params] = useSearchParams();
  const status = oneOf(params.get("status"), REVIEW_STATUSES) ?? "pending";
  const reviews = useCompanyOsPages("list_reviews", { p_status: status });
  const items = itemsOf(reviews.data);
  return (
    <ScreenLayout
      title="Decisões"
      description={
        status === "pending"
          ? "Aguardando sua revisão, das mais antigas para as mais novas."
          : "Decisões registradas, das mais recentes para as mais antigas."
      }
    >
      <Note>{`${REVIEW_DECISIONS_CLI_NOTE} ${REVIEW_NOT_A_SEND_NOTE}`}</Note>
      <StatusTabs active={status} />
      <PagesView query={reviews} what="as decisões">
        <ReviewTable reviews={items} />
        {items.length === 0 ? (
          <EmptyState icon={Inbox} title="Nenhuma decisão nesta situação." />
        ) : null}
        <PageControls query={reviews} />
      </PagesView>
    </ScreenLayout>
  );
};

export const ReviewsScreen = () => (
  <Routes>
    <Route index element={<ReviewList />} />
    <Route path=":reviewId" element={<ReviewDetail />} />
  </Routes>
);
