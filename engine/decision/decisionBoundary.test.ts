import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { REGISTERED_HANDLER_KINDS } from "../worker/registry.ts";

// Static guard for the decision layer's authority (Phase 2D.1): the
// DecisionPort, its providers and the shadow decision handler are ADVISORY.
// This test goes red if their source ever reaches for a review decision, a
// send, the CRM, a stop act, a budget, a channel, a membership, a raw SQL
// client or the network, or asks a provider for prose reasoning.

const ROOT = join(import.meta.dirname, "..");
const SOURCES = [
  ...readdirSync(join(ROOT, "decision"))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => join("decision", file)),
  join("handlers", "decisionShadowEvaluate.ts"),
];

const FORBIDDEN: readonly [string, RegExp][] = [
  [
    "a review decision",
    /record_review_decision|decide_review|recordReviewDecision|reviewQueue/,
  ],
  [
    "a send or the outbound path",
    /outbound|whatsapp_send|sendWhatsapp|whatsappGateway|messaging|sendMessage/i,
  ],
  ["the CRM", /public\.|atomic-crm|crmContact|contacts_summary/],
  [
    "a stop act",
    /trip_execution_stop|clear_execution_stop|executionStops|tripStop/,
  ],
  [
    "budget, price, channel or membership",
    /spend_limit|model_price|communication_channels|grant_membership|memberships/,
  ],
  ["a database client", /from "pg"|withTransaction|\.query\(/],
  ["the network", /\bfetch\(|XMLHttpRequest|node:http|node:https|WebSocket/],
  ["the Company OS browser surface", /company_os_api|src\/company-os/],
  // A field or option that would carry or request hidden reasoning (the words
  // may appear in comments that forbid it).
  [
    "chain-of-thought",
    /chainOfThought|chain_of_thought|reasoning_effort|\breasoning\s*:|\bthinking\s*:/,
  ],
];

describe("the decision layer holds no authority", () => {
  it.each(SOURCES)("%s reaches for nothing but advice", (file) => {
    const source = readFileSync(join(ROOT, file), "utf8");
    for (const [what, pattern] of FORBIDDEN) {
      expect(pattern.test(source), `${file} reaches for ${what}`).toBe(false);
    }
  });

  it("registers the shadow decision as a worker kind, not a task-executable one", () => {
    expect(REGISTERED_HANDLER_KINDS).toContain("decision.shadow_evaluate");
  });
});
