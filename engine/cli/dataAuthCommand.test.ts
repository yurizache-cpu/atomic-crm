import { describe, expect, it } from "vitest";
import { buildDataAuthRecord } from "./dataAuthCommand.ts";

const TENANT = "a0000000-0000-4000-8000-00000000000a";

describe("the data-auth record command's syntax", () => {
  const values = (patch: Record<string, string | undefined>) =>
    new Map(
      Object.entries({
        tenant: TENANT,
        class: "health",
        "training-excluded": "yes",
        ...patch,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );

  it.each([
    ["a never-authorizable class", { class: "clinical_record" }],
    ["an unstated training answer", { "training-excluded": "maybe" }],
    [
      "a retention period that is not a number",
      { "content-retention-days": "thirty" },
    ],
  ])("refuses %s as a usage error", (_case, patch) => {
    expect(buildDataAuthRecord(values(patch)).ok).toBe(false);
  });

  it("defaults nothing: an absent reference stays absent", () => {
    const built = buildDataAuthRecord(values({}));
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.input.lawfulBasisRef).toBeUndefined();
      expect(built.input.contentRetentionDays).toBeUndefined();
      expect(built.input.trainingExcluded).toBe(true);
    }
  });
});
