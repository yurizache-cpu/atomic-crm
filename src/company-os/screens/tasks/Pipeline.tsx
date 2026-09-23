import type { ReactNode } from "react";

import type { TaskSummary } from "../../../../contracts/company-os-api/index.ts";
import { RecordLink } from "../../components/display";
import { StatusChip } from "../../components/owner";
import { outboundStatusText } from "../../format/outbound";
import { runStatusLabel, toneOfState, type Tone } from "../../format/ptBR";
import { shownRunStatus } from "../runs/liveness";
import { reviewStatusText } from "../reviews/reviewLabels";

// A task's derived pipeline (docs/PHASE_2C_BRIEF.md §9, §10) as a stepper:
// received (the task exists), the AI's latest run, the review, and the single
// outbound record, each with the status the server derived. This, not the
// lifecycle status, is what shows how far the work went. A stage is marked done
// only by its own fact: a run that succeeded, a decided review, a recorded
// send. A needs_edit review says it has no follow-up path (§10); an outbound
// record's absence reads "nenhum envio registrado", never "aguardando". Once
// the answer is older than two polling intervals, a latest run that can still
// change reads "Desconhecido" (runs/liveness.ts).

const Step = ({
  title,
  done,
  children,
}: {
  title: string;
  done: boolean;
  children: ReactNode;
}) => (
  <li className="flex min-w-36 flex-1 flex-col gap-1.5">
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className={
          done
            ? "size-2.5 rounded-full bg-emerald-500"
            : "size-2.5 rounded-full border-2 border-muted-foreground/40"
        }
      />
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </span>
    </div>
    <div className="flex flex-col gap-1 pl-4.5">{children}</div>
  </li>
);

const Chip = ({ tone, label }: { tone: Tone; label: string }) => (
  <span>
    <StatusChip tone={tone} label={label} />
  </span>
);

export const Pipeline = ({
  pipeline,
  current,
}: {
  pipeline: TaskSummary["pipeline"];
  /** Whether the answer the pipeline came in is still current (§10). */
  current: boolean;
}) => {
  const run = pipeline.latestRun;
  const runStatus = run === null ? null : shownRunStatus(run, current);
  return (
    <ol aria-label="Etapas" className="flex flex-wrap gap-4">
      <Step title="Recebida" done>
        <Chip tone="green" label="Tarefa criada" />
      </Step>
      <Step title="IA processou" done={runStatus === "succeeded"}>
        {run === null || runStatus === null ? (
          <Chip tone="gray" label="Sem execução ainda" />
        ) : (
          <>
            <Chip
              tone={toneOfState(runStatus)}
              label={runStatusLabel(runStatus)}
            />
            <RecordLink
              kind="run"
              id={run.id}
              label={`Última execução ${run.id}`}
            >
              Ver execução
            </RecordLink>
          </>
        )}
      </Step>
      <Step
        title="Revisão"
        done={pipeline.review !== null && pipeline.review.status !== "pending"}
      >
        {pipeline.review === null ? (
          <Chip tone="gray" label="Sem revisão" />
        ) : (
          <>
            <Chip
              tone={toneOfState(pipeline.review.status)}
              label={reviewStatusText(pipeline.review.status)}
            />
            <RecordLink
              kind="review"
              id={pipeline.review.id}
              label={`Revisão ${pipeline.review.id}`}
            >
              Ver decisão
            </RecordLink>
          </>
        )}
      </Step>
      <Step
        title="Envio"
        done={
          pipeline.outbound !== null &&
          ["sent", "delivered", "read"].includes(pipeline.outbound.status)
        }
      >
        {pipeline.outbound === null ? (
          <Chip tone="gray" label="Nenhum envio registrado" />
        ) : (
          <Chip
            tone={toneOfState(pipeline.outbound.status)}
            label={outboundStatusText(pipeline.outbound.status)}
          />
        )}
      </Step>
    </ol>
  );
};
