// @vitest-environment node
import { describe, expect, it } from "vitest";
import { earliest, latest, mergeLeadProfile } from "./mergeLeadProfile";

// Before this existed, `merge_contacts` re-pointed only `tasks` and
// `contact_notes`, then deleted the loser contact. Every FK referencing
// contacts is ON DELETE CASCADE and a trigger creates exactly one
// lead_profiles row per contact — so EVERY merge silently destroyed one lead
// profile, including its `do_not_contact` opt-out. A cascade raises nothing,
// so nobody would ever have seen it happen.

const P = (over: Record<string, unknown> = {}) => ({
  do_not_contact: false,
  acquired_at: "2026-02-01T00:00:00Z",
  last_interaction_at: "2026-02-01T00:00:00Z",
  next_action_at: null,
  operational_status: "active",
  ...over,
});

describe("mergeLeadProfile — consent", () => {
  // The LGPD-relevant rule. Each case is a way the old "winner wins" would
  // have silently re-enabled contact for someone who opted out.
  it.each([
    ["neither opted out", false, false, false],
    ["the winner opted out", true, false, true],
    ["only the LOSER opted out", false, true, true],
    ["both opted out", true, true, true],
  ])("%s -> %s", (_label, winnerFlag, loserFlag, expected) => {
    expect(
      mergeLeadProfile(
        P({ do_not_contact: winnerFlag }),
        P({ do_not_contact: loserFlag }),
      ).do_not_contact,
    ).toBe(expected);
  });

  it("treats a null/undefined flag as not-opted-out, never as opted-in", () => {
    // A missing value must not be able to CLEAR a real opt-out on the other side.
    expect(
      mergeLeadProfile(P({ do_not_contact: null }), P({ do_not_contact: true }))
        .do_not_contact,
    ).toBe(true);
    expect(
      mergeLeadProfile(
        P({ do_not_contact: undefined }),
        P({ do_not_contact: true }),
      ).do_not_contact,
    ).toBe(true);
  });

  it("is symmetric — which contact is the winner cannot change consent", () => {
    // If this ever fails, the outcome depends on which row the user happened
    // to click, which is exactly the bug.
    const a = P({ do_not_contact: true });
    const b = P({ do_not_contact: false });
    expect(mergeLeadProfile(a, b).do_not_contact).toBe(
      mergeLeadProfile(b, a).do_not_contact,
    );
  });
});

describe("mergeLeadProfile — timestamps", () => {
  it("keeps the earliest acquisition — when the person was first seen at all", () => {
    expect(
      mergeLeadProfile(
        P({ acquired_at: "2026-05-01T00:00:00Z" }),
        P({ acquired_at: "2026-01-01T00:00:00Z" }),
      ).acquired_at,
    ).toBe("2026-01-01T00:00:00Z");
  });

  it("keeps the latest interaction — the most recent real signal", () => {
    expect(
      mergeLeadProfile(
        P({ last_interaction_at: "2026-05-01T00:00:00Z" }),
        P({ last_interaction_at: "2026-07-01T00:00:00Z" }),
      ).last_interaction_at,
    ).toBe("2026-07-01T00:00:00Z");
  });

  it("keeps the soonest next action — dropping it would drop a commitment", () => {
    expect(
      mergeLeadProfile(
        P({ next_action_at: "2026-09-30T00:00:00Z" }),
        P({ next_action_at: "2026-09-12T00:00:00Z" }),
      ).next_action_at,
    ).toBe("2026-09-12T00:00:00Z");
  });

  it("does not invent a timestamp when only one side has one", () => {
    expect(
      mergeLeadProfile(P({ next_action_at: null }), P({ next_action_at: null }))
        .next_action_at,
    ).toBeNull();
    expect(
      mergeLeadProfile(
        P({ acquired_at: null }),
        P({ acquired_at: "2026-03-01T00:00:00Z" }),
      ).acquired_at,
    ).toBe("2026-03-01T00:00:00Z");
  });
});

describe("earliest / latest", () => {
  it("return null only when both sides are null", () => {
    expect(earliest(null, null)).toBeNull();
    expect(latest(null, null)).toBeNull();
    expect(earliest(null, "2026-01-01")).toBe("2026-01-01");
    expect(latest("2026-01-01", null)).toBe("2026-01-01");
  });

  it("are symmetric", () => {
    expect(earliest("2026-01-01", "2026-05-01")).toBe(
      earliest("2026-05-01", "2026-01-01"),
    );
    expect(latest("2026-01-01", "2026-05-01")).toBe(
      latest("2026-05-01", "2026-01-01"),
    );
  });
});
