import type { ReactNode } from "react";

import type { TaskSummary } from "../../../../contracts/company-os-api/index.ts";
import { None, RecordLink, StateBadge } from "../../components/display";
import { outboundStatusText } from "../../format/outbound";
import { reviewStatusText } from "../reviews/reviewLabels";
import { shownRunStatus } from "../runs/liveness";

// A task's derived pipeline (docs/PHASE_2C_BRIEF.md §9, §10): its latest run,
// its review and its single outbound record, each with the status the server
// derived. This, not the lifecycle status, is what shows how far the work went.
// A needs_edit review says it has no follow-up path (§10), as it does on the
// review itself; an outbound record's absence reads "no send recorded", never
// "awaiting". Once the answer is older than two polling intervals, a latest
// run that can still change reads "unknown" (runs/liveness.ts).

const Stage = ({ label, children }: { label: string; children: ReactNode }) => (
  <span className="flex flex-wrap items-center gap-1">
    <span className="text-xs text-muted-foreground">{`${label}:`}</span>
    {children}
  </span>
);

export const Pipeline = ({
  pipeline,
  current,
}: {
  pipeline: TaskSummary["pipeline"];
  /** Whether the answer the pipeline came in is still current (§10). */
  current: boolean;
}) => (
  <span className="flex flex-col gap-1">
    <Stage label="Latest run">
      {pipeline.latestRun === null ? (
        <None />
      ) : (
        <>
          <StateBadge value={shownRunStatus(pipeline.latestRun, current)} />
          <RecordLink
            kind="run"
            id={pipeline.latestRun.id}
            label={`Latest run ${pipeline.latestRun.id}`}
          />
        </>
      )}
    </Stage>
    <Stage label="Review">
      {pipeline.review === null ? (
        <None />
      ) : (
        <>
          <StateBadge
            value={pipeline.review.status}
            label={reviewStatusText(pipeline.review.status)}
          />
          <RecordLink
            kind="review"
            id={pipeline.review.id}
            label={`Review ${pipeline.review.id}`}
          />
        </>
      )}
    </Stage>
    <Stage label="Outbound record">
      {pipeline.outbound === null ? (
        <None>no send recorded</None>
      ) : (
        <StateBadge
          value={pipeline.outbound.status}
          label={outboundStatusText(pipeline.outbound.status)}
        />
      )}
    </Stage>
  </span>
);
