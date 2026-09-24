import type {
  ReviewDetail,
  ShadowDecision,
  ShadowRecommendation,
} from "../../../../contracts/company-os-api/index.ts";
import { Field, Fields, Note, Section } from "../../components/display";
import { StatusChip, TechnicalDetails } from "../../components/owner";
import {
  SHADOW_BADGE,
  SHADOW_NOTE,
  SHADOW_POLICY_REQUIRED,
  SHADOW_REASON_LABELS,
  SHADOW_REASON_UNKNOWN,
  SHADOW_RECOMMENDATION_LABELS,
  SHADOW_STATE_TEXT,
  SHADOW_TITLE,
} from "../../copy";
import { reviewStatusLabel } from "../../format/ptBR";
import { policyVersionLabel, providerLabel } from "./shadowLabels";

// Phase 2D.1: the shadow decision a review carries (get_review's
// `shadowDecision`), read only. It shows what the decision layer recommended,
// how confident it was, and what the deterministic policy made of it, which is
// always "human review required". It offers no control, never pretends a
// recommendation exists when none was stored, and shows no input, prompt or
// reasoning. Phase 2D.2 adds the policy and provider versions and the reason
// codes as the owner reads them; the codes themselves stay under the
// technical details.

const POLICY_LABELS: Record<string, string> = {
  recommendation_available: "Recomendação disponível",
  low_confidence: "Confiança baixa",
  high_caution: "Cautela alta",
  abstained: "Sem recomendação",
  provider_indeterminate: "Resultado incerto",
  provider_invalid: "Resposta recusada",
  provider_failed: "Motor indisponível",
};

const CAUTION_LABELS: Record<string, string> = {
  low: "Baixa",
  medium: "Média",
  high: "Alta",
};

const reasonLabel = (code: string): string =>
  (SHADOW_REASON_LABELS as Record<string, string>)[code] ??
  SHADOW_REASON_UNKNOWN;

/** The human decision each recommendation corresponds to; abstain has none. */
const HUMAN_DECISION: Record<ShadowRecommendation, string | null> = {
  accept: "accepted",
  needs_edit: "needs_edit",
  reject: "rejected",
  abstain: null,
};

type Evaluation = Exclude<ShadowDecision, { status: "unavailable" }>;

const stateText = (shadow: ShadowDecision | null): string | null => {
  if (shadow === null) return SHADOW_STATE_TEXT.none;
  switch (shadow.status) {
    case "unavailable":
      return SHADOW_STATE_TEXT.unavailable;
    case "pending":
      return SHADOW_STATE_TEXT.pending;
    case "indeterminate":
      return SHADOW_STATE_TEXT.indeterminate;
    case "invalid":
      return SHADOW_STATE_TEXT.invalid;
    case "failed":
      return SHADOW_STATE_TEXT.failed;
    case "refused":
      return shadow.refusal === "stopped"
        ? SHADOW_STATE_TEXT.refused_stopped
        : shadow.refusal === "policy_retired"
          ? SHADOW_STATE_TEXT.refused_policy_retired
          : SHADOW_STATE_TEXT.refused_not_eligible;
    case "completed":
      return null;
  }
};

/** Observational only: whether the person's decision matched the recommendation. */
const agreement = (review: ReviewDetail, shadow: Evaluation): string => {
  if (shadow.recommendation === null) return "Não se aplica";
  const expected = HUMAN_DECISION[shadow.recommendation];
  if (expected === null) return "Não se aplica";
  return review.status === expected ? "Sim" : "Não";
};

const Completed = ({
  review,
  shadow,
}: {
  review: ReviewDetail;
  shadow: Evaluation;
}) => (
  <>
    <Fields label={SHADOW_TITLE}>
      <Field term="Recomendação">
        {shadow.recommendation === null
          ? "—"
          : SHADOW_RECOMMENDATION_LABELS[shadow.recommendation]}
      </Field>
      <Field term="Confiança">
        {shadow.confidence === null
          ? "—"
          : `${Math.round(shadow.confidence * 100)}%`}
      </Field>
      <Field term="Cautela">
        {shadow.caution === null ? "—" : CAUTION_LABELS[shadow.caution]}
      </Field>
      <Field term="Motivos">
        {shadow.reasonCodes.length === 0
          ? "—"
          : [...new Set(shadow.reasonCodes.map(reasonLabel))].join(" · ")}
      </Field>
      <Field term="Política">
        {`${POLICY_LABELS[shadow.policy.outcome ?? ""] ?? "—"} · ${SHADOW_POLICY_REQUIRED}`}
      </Field>
      <Field term="Versão da política">
        {policyVersionLabel(shadow.policyVersion)}
      </Field>
      <Field term="Motor">
        {shadow.provider === null
          ? "—"
          : `${providerLabel(shadow.provider.kind)} · versão ${shadow.provider.version}`}
      </Field>
      {review.status === "pending" ? null : (
        <>
          <Field term="Resultado humano">
            {reviewStatusLabel(review.status)}
          </Field>
          <Field term="Concordância com a recomendação">
            {agreement(review, shadow)}
          </Field>
        </>
      )}
    </Fields>
    <TechnicalDetails
      rows={[
        ["Motivos", shadow.reasonCodes.join(", ") || "—"],
        ["Política", shadow.policy.outcome ?? "—"],
        ["Versão da política", shadow.policyVersion],
        [
          "Motor",
          shadow.provider === null
            ? "—"
            : `${shadow.provider.kind}/${shadow.provider.id}@${shadow.provider.version}`,
        ],
        ["Pedida (UTC)", shadow.requestedAt],
        ["Concluída (UTC)", shadow.settledAt ?? "—"],
      ]}
    />
  </>
);

export const ShadowDecisionSection = ({ review }: { review: ReviewDetail }) => {
  const shadow = review.shadowDecision;
  const text = stateText(shadow);
  return (
    <Section title={SHADOW_TITLE}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone="gray" label={SHADOW_BADGE} />
        <StatusChip tone="amber" label={SHADOW_POLICY_REQUIRED} />
      </div>
      <Note>{SHADOW_NOTE}</Note>
      {text !== null || shadow === null || shadow.status === "unavailable" ? (
        <p className="text-sm">{text}</p>
      ) : (
        <Completed review={review} shadow={shadow} />
      )}
    </Section>
  );
};
