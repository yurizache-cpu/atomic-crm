import { DECISION_INTELLIGENCE_SMALL_SAMPLE } from "../../copy";

// The shadow decision's owner-facing wording, shared by a review's shadow
// section and the calibration tab (Phase 2D.1 to 2D.3).

/** Below this many comparable evaluations no rate is shown, only the counts. */
export const MIN_COMPARABLE_FOR_RATE = 5;
/** Below this many evaluations no distribution is shown. */
export const MIN_EVALUATIONS_FOR_DISTRIBUTION = 5;

export const providerLabel = (kind: string): string =>
  kind === "fake"
    ? "Simulação determinística (não é o Jev)"
    : kind === "jev"
      ? "Jev"
      : "Nenhum motor configurado";

/** "decision_shadow.v2" as "v2". */
export const policyVersionLabel = (version: string): string =>
  version.replace(/^decision_shadow\./, "");

/** "2 de 3 comparáveis (67%)"; the rate only once the sample allows it. */
export const agreementText = (
  agreements: number,
  comparable: number,
): string => {
  const counts = `${agreements} de ${comparable} ${comparable === 1 ? "comparável" : "comparáveis"}`;
  if (comparable < MIN_COMPARABLE_FOR_RATE) {
    return `${counts}. ${DECISION_INTELLIGENCE_SMALL_SAMPLE}`;
  }
  return `${counts} (${Math.round((agreements / comparable) * 100)}%)`;
};
