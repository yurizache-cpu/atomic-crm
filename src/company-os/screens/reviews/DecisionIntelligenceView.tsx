import {
  CircleHelp,
  CircleMinus,
  Equal,
  EqualNot,
  ScanSearch,
  UserCheck,
} from "lucide-react";

import type {
  DecisionIntelligence,
  DecisionIntelligenceGroup,
} from "../../../../contracts/company-os-api/index.ts";
import { Field, Fields, Note, Section } from "../../components/display";
import { StatCard, StatusChip, TechnicalDetails } from "../../components/owner";
import { QueryView } from "../../components/queryStates";
import {
  DECISION_INTELLIGENCE_CARDS,
  DECISION_INTELLIGENCE_DISTRIBUTION_HIDDEN,
  DECISION_INTELLIGENCE_EMPTY,
  DECISION_INTELLIGENCE_EXPLANATION,
  SHADOW_BADGE,
  SHADOW_POLICY_REQUIRED,
  SHADOW_RECOMMENDATION_LABELS,
} from "../../copy";
import { reviewStatusLabel } from "../../format/ptBR";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";
import {
  MIN_EVALUATIONS_FOR_DISTRIBUTION,
  agreementText,
  policyVersionLabel,
  providerLabel,
} from "./shadowLabels";

// Phase 2D.3: the shadow calibration view (Decisões → Inteligência), read only.
// It shows how often the shadow engine's recommendation matched the person's
// own decision: AGREEMENT, with its sample always visible, never accuracy or a
// score, and never a verdict on the person. Counts come from the overview's
// `decisionIntelligence` section, aggregated by the database; this view only
// adds them up for the current policy version. No control, no chart.

type Totals = Omit<DecisionIntelligenceGroup, "policyVersion" | "provider">;

const ZERO: Totals = {
  evaluations: 0,
  recommendations: 0,
  abstained: 0,
  pending: 0,
  indeterminate: 0,
  invalid: 0,
  failed: 0,
  refused: 0,
  withHumanDecision: 0,
  comparable: 0,
  agreements: 0,
  disagreements: 0,
  byRecommendation: { accept: 0, needs_edit: 0, reject: 0, abstain: 0 },
  byHumanOutcome: { pending: 0, accepted: 0, rejected: 0, needs_edit: 0 },
};

/** The current version's counts, summed over its providers. */
const currentTotals = (intelligence: DecisionIntelligence): Totals =>
  intelligence.groups
    .filter(
      (group) => group.policyVersion === intelligence.currentPolicyVersion,
    )
    .reduce<Totals>(
      (sum, group) => ({
        evaluations: sum.evaluations + group.evaluations,
        recommendations: sum.recommendations + group.recommendations,
        abstained: sum.abstained + group.abstained,
        pending: sum.pending + group.pending,
        indeterminate: sum.indeterminate + group.indeterminate,
        invalid: sum.invalid + group.invalid,
        failed: sum.failed + group.failed,
        refused: sum.refused + group.refused,
        withHumanDecision: sum.withHumanDecision + group.withHumanDecision,
        comparable: sum.comparable + group.comparable,
        agreements: sum.agreements + group.agreements,
        disagreements: sum.disagreements + group.disagreements,
        byRecommendation: {
          accept: sum.byRecommendation.accept + group.byRecommendation.accept,
          needs_edit:
            sum.byRecommendation.needs_edit + group.byRecommendation.needs_edit,
          reject: sum.byRecommendation.reject + group.byRecommendation.reject,
          abstain:
            sum.byRecommendation.abstain + group.byRecommendation.abstain,
        },
        byHumanOutcome: {
          pending: sum.byHumanOutcome.pending + group.byHumanOutcome.pending,
          accepted: sum.byHumanOutcome.accepted + group.byHumanOutcome.accepted,
          rejected: sum.byHumanOutcome.rejected + group.byHumanOutcome.rejected,
          needs_edit:
            sum.byHumanOutcome.needs_edit + group.byHumanOutcome.needs_edit,
        },
      }),
      ZERO,
    );

const groupProvider = (group: DecisionIntelligenceGroup): string =>
  group.provider === null
    ? "Ainda sem motor (pendentes ou recusadas)"
    : `${providerLabel(group.provider.kind)} · versão ${group.provider.version}`;

const Distribution = ({ totals }: { totals: Totals }) =>
  totals.evaluations < MIN_EVALUATIONS_FOR_DISTRIBUTION ? (
    <Note>{DECISION_INTELLIGENCE_DISTRIBUTION_HIDDEN}</Note>
  ) : (
    <div className="grid gap-4 md:grid-cols-2">
      <Fields label="Recomendações do motor">
        {(["accept", "needs_edit", "reject", "abstain"] as const).map((key) => (
          <Field key={key} term={SHADOW_RECOMMENDATION_LABELS[key]}>
            {totals.byRecommendation[key]}
          </Field>
        ))}
      </Fields>
      <Fields label="Decisões humanas">
        {(["pending", "accepted", "rejected", "needs_edit"] as const).map(
          (key) => (
            <Field key={key} term={reviewStatusLabel(key)}>
              {totals.byHumanOutcome[key]}
            </Field>
          ),
        )}
      </Fields>
    </div>
  );

const Versions = ({ intelligence }: { intelligence: DecisionIntelligence }) => (
  <div role="list" aria-label="Por versão" className="flex flex-col gap-2">
    {intelligence.groups.map((group) => (
      <div
        role="listitem"
        key={`${group.policyVersion}:${group.provider?.kind ?? ""}:${group.provider?.id ?? ""}:${group.provider?.version ?? ""}`}
        className="flex flex-col gap-1 rounded-lg border p-3 text-sm"
      >
        <span className="font-medium">
          {`Política ${policyVersionLabel(group.policyVersion)}${
            group.policyVersion === intelligence.currentPolicyVersion
              ? " (atual)"
              : " (anterior)"
          } · ${groupProvider(group)}`}
        </span>
        <span className="text-muted-foreground">
          {`${group.evaluations} ${group.evaluations === 1 ? "avaliação" : "avaliações"} · concordância ${agreementText(group.agreements, group.comparable)}`}
        </span>
        <TechnicalDetails
          rows={[
            ["Política", group.policyVersion],
            [
              "Motor",
              group.provider === null
                ? "—"
                : `${group.provider.kind}/${group.provider.id}@${group.provider.version}`,
            ],
            ["Pendentes", String(group.pending)],
            ["Inválidas", String(group.invalid)],
            ["Falhas", String(group.failed)],
            ["Recusadas", String(group.refused)],
          ]}
        />
      </div>
    ))}
  </div>
);

const IntelligenceBody = ({
  intelligence,
}: {
  intelligence: DecisionIntelligence;
}) => {
  const totals = currentTotals(intelligence);
  // Neutral on purpose: agreement is an observation, not a score.
  const cards = [
    ["evaluations", ScanSearch],
    ["withHumanDecision", UserCheck],
    ["agreements", Equal],
    ["disagreements", EqualNot],
    ["abstained", CircleMinus],
    ["indeterminate", CircleHelp],
  ] as const;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map(([key, icon]) => (
          <StatCard
            key={key}
            icon={icon}
            label={DECISION_INTELLIGENCE_CARDS[key]}
            value={totals[key]}
          />
        ))}
      </div>
      <Section title="Concordância">
        <p className="text-sm">
          {totals.comparable === 0
            ? "Nenhuma recomendação com decisão humana para comparar ainda."
            : `Concordância: ${agreementText(totals.agreements, totals.comparable)}`}
        </p>
        <Note>
          Só entram na comparação avaliações com recomendação e com decisão
          humana registrada. Uma abstenção, uma avaliação incerta ou uma revisão
          ainda pendente não conta como concordância nem como discordância.
        </Note>
      </Section>
      <Section title="Distribuição">
        <Distribution totals={totals} />
      </Section>
      <Section title="Por versão">
        <Versions intelligence={intelligence} />
      </Section>
    </>
  );
};

export const DecisionIntelligenceView = () => {
  const overview = useCompanyOsQuery("overview", {});
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone="gray" label={SHADOW_BADGE} />
        <StatusChip tone="amber" label={SHADOW_POLICY_REQUIRED} />
      </div>
      <Note>{DECISION_INTELLIGENCE_EXPLANATION}</Note>
      <QueryView query={overview} what="a inteligência de decisão">
        {(data) =>
          data.decisionIntelligence.groups.length === 0 ? (
            <p className="text-sm">{DECISION_INTELLIGENCE_EMPTY}</p>
          ) : (
            <IntelligenceBody intelligence={data.decisionIntelligence} />
          )
        }
      </QueryView>
    </div>
  );
};
