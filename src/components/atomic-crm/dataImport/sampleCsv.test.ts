import { describe, expect, it } from "vitest";

import companiesSampleCsv from "./companies_sample.csv?raw";
import dealsSampleCsv from "./deals_sample.csv?raw";
import {
  defaultDealCategories,
  defaultDealStages,
} from "../root/defaultConfiguration";
import { toConfiguredValue } from "./parseCell";

// The sample CSVs are what the "Download CSV sample" link hands a user, so they
// are the app telling people what a valid import looks like. When the fork
// replaced the deal pipeline, these files kept upstream's stage names — so
// importing the app's OWN sample silently dropped every deal into the first
// stage ("Novo lead"), because an unmatched stage falls back to the default.
// That is invisible: the import reports success.
//
// These tests pin the sample files against the live configuration. They are the
// regression guard for exactly that class of drift, and they matter more now
// that ADR 0013 has removed the database CHECK — the configuration layer is
// where stage validity is enforced, so the two must not disagree.

const parseCsv = (raw: string) => {
  const [header, ...rows] = raw
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const columns = header.split(",");
  return rows.map((row) => {
    // The samples deliberately contain no quoted commas; keep the split naive
    // so a future quoted field makes this fail loudly rather than silently.
    const cells = row.split(",");
    return Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? ""]));
  });
};

describe("deals_sample.csv", () => {
  const rows = parseCsv(dealsSampleCsv);

  it("is not empty", () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it("names only stages the configured pipeline actually has", () => {
    for (const row of rows) {
      // Resolves a label or a value against the configured stages, exactly as
      // the importer does. `undefined` means the importer would discard it and
      // silently fall back to the first stage.
      expect(
        toConfiguredValue(row.stage, defaultDealStages),
        `stage "${row.stage}" is not in the configured pipeline`,
      ).toBeDefined();
    }
  });

  it("names only categories the configuration actually has", () => {
    for (const row of rows) {
      expect(
        toConfiguredValue(row.category, defaultDealCategories),
        `category "${row.category}" is not configured`,
      ).toBeDefined();
    }
  });

  it("does not put every sample row in the pipeline's first stage", () => {
    // The failure mode this whole file exists for: when the stage names go
    // stale, every row resolves to the fallback and the sample stops
    // demonstrating a pipeline at all.
    const resolved = rows.map((r) => toConfiguredValue(r.stage, defaultDealStages));
    const firstStage = defaultDealStages[0]?.value;
    expect(new Set(resolved).size).toBeGreaterThan(1);
    expect(resolved.every((s) => s === firstStage)).toBe(false);
  });
});

describe("companies_sample.csv", () => {
  const rows = parseCsv(companiesSampleCsv);

  it("is not empty", () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it("has a name on every row", () => {
    for (const row of rows) expect(row.name?.trim()).toBeTruthy();
  });
});
