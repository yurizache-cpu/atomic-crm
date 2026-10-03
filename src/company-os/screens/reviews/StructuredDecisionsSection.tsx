import type { ReactNode } from "react";

import type {
  AvailableStructuredDecisions,
  BusinessRouteDecision,
  LeadIntelligenceDecision,
  ModelRouteDecision,
  ReviewDetail,
} from "../../../../contracts/company-os-api/index.ts";
import { Field, Fields, Note, Section, YesNo } from "../../components/display";
import {
  MoneyValue,
  StatusChip,
  TechnicalDetails,
} from "../../components/owner";
import {
  SHADOW_BADGE,
  SHADOW_POLICY_REQUIRED,
  SHADOW_STATE_TEXT,
  STRUCTURED_BLOCK_TITLES,
  STRUCTURED_CAPABILITY_LABELS,
  STRUCTURED_EMPTY,
  STRUCTURED_INTENT_LABELS,
  STRUCTURED_LEVEL_LABELS,
  STRUCTURED_NEXT_ACTION_LABELS,
  STRUCTURED_NOTE,
  STRUCTURED_OBJECTION_LABELS,
  STRUCTURED_REFUSAL_TEXT,
  STRUCTURED_SPECIAL_DEPARTMENTS,
  STRUCTURED_STATE_TEXT,
  STRUCTURED_TITLE,
} from "../../copy";
import { decisionModelLabel } from "./shadowLabels";

// ADR 0022: the structured decisions a review carries (get_review's
// `structuredDecisions`), read only. Beside the route the deterministic path
// took, each shows what the decision model (Jev today) chose, with its
// confidence, and whether the two agree. It offers no control, never pretends
// an answer exists when none was stored, and shows no input, question or
// probability map; the codes and the build stay under the technical details.

type Decision =
  | BusinessRouteDecision
  | LeadIntelligenceDecision
  | ModelRouteDecision;
type Level = keyof typeof STRUCTURED_LEVEL_LABELS;
type DepartmentRef = { slug: string; name: string | null };

const percent = (value: number): string => `${Math.round(value * 100)}%`;

/** "Operações · 99%": a choice with its confidence when the model gave one. */
const withConfidence = (label: string, confidence: number | null): string =>
  confidence === null ? label : `${label} · ${percent(confidence)}`;

const levelLabel = (level: Level | null): string =>
  level === null ? "—" : STRUCTURED_LEVEL_LABELS[level];

/** The company's own name for the department, else the route's label, else the slug. */
const departmentLabel = (ref: DepartmentRef | null): string =>
  ref === null
    ? "—"
    : (ref.name ?? STRUCTURED_SPECIAL_DEPARTMENTS[ref.slug] ?? ref.slug);

const capabilityLabel = (capability: string | null): string =>
  capability === null
    ? "—"
    : (STRUCTURED_CAPABILITY_LABELS[capability] ?? capability);

/** Why a decision has no answer to show; null once it is completed. */
const stateText = (decision: Decision | null): string | null => {
  if (decision === null) return STRUCTURED_STATE_TEXT.none;
  switch (decision.status) {
    case "completed":
      return null;
    case "refused":
      return decision.refusal === null
        ? STRUCTURED_STATE_TEXT.failed
        : STRUCTURED_REFUSAL_TEXT[decision.refusal];
    default:
      return STRUCTURED_STATE_TEXT[decision.status];
  }
};

const Technical = ({ decision }: { decision: Decision }) => (
  <TechnicalDetails
    rows={[
      ["Conjunto de perguntas", decision.questionSet],
      ["Modelo de decisão", decision.decisionModel ?? "—"],
      ["Estado", decision.status],
      ["Recusa", decision.refusal ?? "—"],
      ["Erro", decision.errorCode ?? "—"],
      ["Custo", <MoneyValue key="cost" value={decision.chargedCost} />],
      ["Pedida (UTC)", decision.requestedAt],
      ["Concluída (UTC)", decision.settledAt ?? "—"],
    ]}
  />
);

/** One decision: its answer when completed, else why there is none. */
const Block = <D extends Decision>({
  title,
  decision,
  children,
}: {
  title: string;
  decision: D | null;
  children: (completed: D & { answer: NonNullable<D["answer"]> }) => ReactNode;
}) => {
  const text = stateText(decision);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {decision === null || decision.answer === null || text !== null ? (
        <p className="text-sm">{text}</p>
      ) : (
        <Fields label={title}>
          {children(decision as D & { answer: NonNullable<D["answer"]> })}
          <Field term="Modelo de decisão">
            {decision.decisionModel === null
              ? "—"
              : decisionModelLabel(decision.decisionModel)}
          </Field>
        </Fields>
      )}
      {decision === null ? null : <Technical decision={decision} />}
    </div>
  );
};

const BusinessRoute = ({
  decision,
}: {
  decision: BusinessRouteDecision | null;
}) => (
  <Block title={STRUCTURED_BLOCK_TITLES.businessRoute} decision={decision}>
    {({ answer, routeTaken }) => (
      <>
        <Field term="Intenção">
          {withConfidence(
            STRUCTURED_INTENT_LABELS[answer.intent],
            answer.intentConfidence,
          )}
        </Field>
        <Field term="Departamento sugerido">
          {withConfidence(
            departmentLabel(answer.department),
            answer.departmentConfidence,
          )}
        </Field>
        <Field term="Departamento usado">
          {departmentLabel(routeTaken.department)}
        </Field>
        <Field term="Mesmo departamento">
          {routeTaken.department === null ? (
            "—"
          ) : (
            <YesNo
              value={answer.department.slug === routeTaken.department.slug}
            />
          )}
        </Field>
        <Field term="Capacidade sugerida">
          {withConfidence(
            capabilityLabel(answer.capability),
            answer.capabilityConfidence,
          )}
        </Field>
        <Field term="Capacidade usada">
          {capabilityLabel(routeTaken.capability)}
        </Field>
        <Field term="Complexidade">{levelLabel(answer.complexity)}</Field>
        <Field term="Chance de precisar de uma pessoa antes">
          {percent(answer.humanReviewProbability)}
        </Field>
      </>
    )}
  </Block>
);

const LeadIntelligence = ({
  decision,
}: {
  decision: LeadIntelligenceDecision | null;
}) => (
  <Block title={STRUCTURED_BLOCK_TITLES.leadIntelligence} decision={decision}>
    {({ answer }) => (
      <>
        <Field term="Prontidão para contratar">
          {levelLabel(answer.commercialReadiness)}
        </Field>
        <Field term="Prontidão para agendar">
          {levelLabel(answer.schedulingReadiness)}
        </Field>
        <Field term="Prioridade de retorno">
          {levelLabel(answer.followUpPriority)}
        </Field>
        <Field term="Objeção percebida">
          {STRUCTURED_OBJECTION_LABELS[answer.objection]}
        </Field>
        <Field term="Próximo passo sugerido">
          {STRUCTURED_NEXT_ACTION_LABELS[answer.nextBestAction]}
        </Field>
      </>
    )}
  </Block>
);

const ModelRoute = ({ decision }: { decision: ModelRouteDecision | null }) => (
  <Block title={STRUCTURED_BLOCK_TITLES.modelRoute} decision={decision}>
    {({ answer, routeTaken }) => (
      <>
        <Field term="Modelo usado">{routeTaken.model ?? "—"}</Field>
        <Field term="Modelo sugerido">
          {withConfidence(answer.suggestedModel, answer.confidence)}
        </Field>
        <Field term="Mesmo modelo">
          {routeTaken.model === null ? (
            "—"
          ) : (
            <YesNo value={answer.suggestedModel === routeTaken.model} />
          )}
        </Field>
      </>
    )}
  </Block>
);

const Available = ({
  decisions,
}: {
  decisions: AvailableStructuredDecisions;
}) =>
  decisions.businessRoute === null &&
  decisions.leadIntelligence === null &&
  decisions.modelRoute === null ? (
    <p className="text-sm">{STRUCTURED_EMPTY}</p>
  ) : (
    <div className="flex flex-col gap-5">
      <BusinessRoute decision={decisions.businessRoute} />
      <LeadIntelligence decision={decisions.leadIntelligence} />
      <ModelRoute decision={decisions.modelRoute} />
    </div>
  );

export const StructuredDecisionsSection = ({
  review,
}: {
  review: ReviewDetail;
}) => {
  const decisions = review.structuredDecisions;
  return (
    <Section title={STRUCTURED_TITLE}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone="gray" label={SHADOW_BADGE} />
        <StatusChip tone="amber" label={SHADOW_POLICY_REQUIRED} />
      </div>
      <Note>{STRUCTURED_NOTE}</Note>
      {decisions.status === "unavailable" ? (
        <p className="text-sm">{SHADOW_STATE_TEXT.unavailable}</p>
      ) : (
        <Available decisions={decisions} />
      )}
    </Section>
  );
};
