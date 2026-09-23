import { Link, Route, Routes, useSearchParams } from "react-router";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import {
  REVIEW_STATUSES,
  type ReviewStatus,
  type ReviewSummary,
} from "../../../../contracts/company-os-api/index.ts";
import {
  Note,
  RecordLink,
  ScreenLayout,
  Timestamp,
  YesNo,
} from "../../components/display";
import { PageControls, PagesView } from "../../components/queryStates";
import { LIST_PATHS } from "../../components/recordPaths";
import { REVIEW_DECISIONS_CLI_NOTE, REVIEW_NOT_A_SEND_NOTE } from "../../copy";
import { humanize, oneOf } from "../../format/labels";
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
  <nav aria-label="Review status" className="flex flex-wrap gap-1 border-b">
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
        {humanize(status)}
      </Link>
    ))}
  </nav>
);

const ReviewRow = ({ review }: { review: ReviewSummary }) => (
  <TableRow>
    <TableCell>
      <RecordLink kind="review" id={review.id} />
    </TableCell>
    <TableCell>
      <ReviewStatusBadge review={review} />
    </TableCell>
    <TableCell>{review.capability}</TableCell>
    <TableCell>
      <RecordLink kind="task" id={review.taskId} />
    </TableCell>
    <TableCell>
      <YesNo value={review.doNotContact} />
    </TableCell>
    <TableCell>
      <Timestamp value={review.createdAt} />
    </TableCell>
    <TableCell>
      <Timestamp value={review.reviewedAt} />
    </TableCell>
    <TableCell>
      <YesNo value={review.hasNote} />
    </TableCell>
    <TableCell>{outboundRecordText(review.outboundStatus)}</TableCell>
  </TableRow>
);

const ReviewTable = ({ reviews }: { reviews: readonly ReviewSummary[] }) => (
  <Table aria-label="Reviews">
    <TableHeader>
      <TableRow>
        <TableHead>Review</TableHead>
        <TableHead>Status</TableHead>
        <TableHead>Capability</TableHead>
        <TableHead>Task</TableHead>
        <TableHead>Do not contact</TableHead>
        <TableHead>Opened</TableHead>
        <TableHead>Decided</TableHead>
        <TableHead>Note</TableHead>
        <TableHead>Outbound record</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {reviews.map((review) => (
        <ReviewRow key={review.id} review={review} />
      ))}
    </TableBody>
  </Table>
);

const ReviewList = () => {
  const [params] = useSearchParams();
  const status = oneOf(params.get("status"), REVIEW_STATUSES) ?? "pending";
  const reviews = useCompanyOsPages("list_reviews", { p_status: status });
  const items = itemsOf(reviews.data);
  return (
    <ScreenLayout
      title="Reviews"
      description={
        status === "pending"
          ? "Pending reviews, oldest first."
          : "Decided reviews, newest first."
      }
    >
      <Note>{`${REVIEW_DECISIONS_CLI_NOTE} ${REVIEW_NOT_A_SEND_NOTE}`}</Note>
      <StatusTabs active={status} />
      <PagesView query={reviews} what="the reviews">
        <ReviewTable reviews={items} />
        {items.length === 0 ? <Note>No review has this status.</Note> : null}
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
