// Deterministic merge semantics for the two lead profiles involved in a
// contact merge.
//
// Kept as a pure function, separate from the transaction, because the rule
// that matters here is a CONSENT rule and it must be provable without a
// database. `do_not_contact` is an opt-out: if either side of a merge asked
// not to be contacted, the merged contact is opted out. Never "winner wins" —
// an opt-out is not recoverable by guessing, and silently re-enabling contact
// because the surviving row happened to be the winner's is an LGPD incident,
// not a data-quality one.

export interface LeadProfileFields {
  do_not_contact?: boolean | null;
  acquired_at?: string | null;
  last_interaction_at?: string | null;
  next_action_at?: string | null;
  operational_status?: string | null;
}

/** Earliest of two nullable ISO timestamps; null only when both are null. */
export const earliest = (
  a: string | null | undefined,
  b: string | null | undefined,
): string | null => (a && b ? (a < b ? a : b) : (a ?? b ?? null));

/** Latest of two nullable ISO timestamps; null only when both are null. */
export const latest = (
  a: string | null | undefined,
  b: string | null | undefined,
): string | null => (a && b ? (a > b ? a : b) : (a ?? b ?? null));

export function mergeLeadProfile(
  winner: LeadProfileFields,
  loser: LeadProfileFields,
): Required<Pick<LeadProfileFields, "do_not_contact">> & LeadProfileFields {
  return {
    // Consent: opted out if EITHER side was. This is the load-bearing line.
    do_not_contact:
      Boolean(winner.do_not_contact) || Boolean(loser.do_not_contact),
    // Acquisition is the first time this person was seen at all.
    acquired_at: earliest(winner.acquired_at, loser.acquired_at),
    // The most recent signal is the true one.
    last_interaction_at: latest(
      winner.last_interaction_at,
      loser.last_interaction_at,
    ),
    // The soonest commitment survives; dropping it would drop a promise.
    next_action_at: earliest(winner.next_action_at, loser.next_action_at),
    operational_status:
      winner.operational_status ?? loser.operational_status ?? null,
  };
}
