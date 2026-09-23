import type { LeadTriageAdvice } from "../../../../contracts/company-os-api/index.ts";
import { Field, Fields, None, Note, YesNo } from "../../components/display";
import { QueryView } from "../../components/queryStates";
import { REPLY_DRAFT_NOTE } from "../../copy";
import { adviceLabel } from "../../format/ptBR";
import { useReviewAdvice } from "../../query/useReviewAdvice";
import { WITHHELD_TEXT } from "./reviewLabels";

// The one content read (docs/PHASE_2C_BRIEF.md §9 ReviewAdvice, §13 item 3):
// mounted only while the operator has the advice open. useReviewAdvice keeps
// the answer for no time (gcTime 0) and removes it from the cache when this
// view unmounts. It shows the lead_triage classification, the summary and the
// recommended next action, or why the advice is withheld; never the reply
// draft, which the projection does not carry and its contract refuses.

const LeadTriageAdviceFields = ({ advice }: { advice: LeadTriageAdvice }) => (
  <Fields label="Análise">
    <Field term="Classificação">{adviceLabel(advice.outcome)}</Field>
    <Field term="Intenção">{adviceLabel(advice.intent)}</Field>
    <Field term="Prioridade">{adviceLabel(advice.priority)}</Field>
    <Field term="Precisa de revisão humana">
      <YesNo value={advice.needsHumanReview} />
    </Field>
    <Field term="Alertas">
      {advice.flags.length === 0 ? (
        <None />
      ) : (
        <span>{advice.flags.map(adviceLabel).join(", ")}</span>
      )}
    </Field>
    <Field term="Resumo">
      <span className="whitespace-pre-wrap">{advice.summary}</span>
    </Field>
    <Field term="Próxima ação recomendada">
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
      aria-label="Análise estruturada"
      className="flex flex-col gap-3"
    >
      <QueryView query={advice} what="a análise">
        {(data) =>
          "withheld" in data ? (
            <p>{`Análise retida: ${WITHHELD_TEXT[data.withheld]}.`}</p>
          ) : (
            <LeadTriageAdviceFields advice={data} />
          )
        }
      </QueryView>
      <Note>{REPLY_DRAFT_NOTE}</Note>
    </div>
  );
};
