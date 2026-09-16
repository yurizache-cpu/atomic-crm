// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_STATUSES,
  AGENT_RUN_TRANSITIONS,
  FINISHED_AGENT_RUN_STATUSES,
  canTransitionAgentRun,
  isAgentRunStatus,
  isFinishedAgentRunStatus,
  type AgentRunStatus,
} from "./agentRunStateMachine.ts";

// The database is the enforcement point; these tests pin the SHAPE of the
// machine so a change to it is a deliberate diff here. The expected edges are
// written out literally, never derived from the module, so the module cannot
// agree with itself by construction. Equality with the database's own relation,
// ops.agent_run_status_transitions(), is asserted against a live Postgres.

const EDGES = [
  "pending->running",
  "pending->cancelled",
  "pending->failed",
  "running->succeeded",
  "running->failed",
  "running->indeterminate",
];

const allowedPairs = (): string[] => {
  const allowed: string[] = [];
  for (const from of AGENT_RUN_STATUSES) {
    for (const to of AGENT_RUN_STATUSES) {
      if (canTransitionAgentRun(from, to)) allowed.push(`${from}->${to}`);
    }
  }
  return allowed;
};

describe("the agent run state machine", () => {
  it("names the six statuses the database's CHECK constraint accepts", () => {
    expect([...AGENT_RUN_STATUSES]).toEqual([
      "pending",
      "running",
      "succeeded",
      "failed",
      "indeterminate",
      "cancelled",
    ]);
  });

  it("allows exactly the six declared edges among all 36 ordered pairs", () => {
    expect(allowedPairs().sort()).toEqual([...EDGES].sort());
    expect(AGENT_RUN_TRANSITIONS.map(([from, to]) => `${from}->${to}`)).toEqual(
      EDGES,
    );
  });

  it("starts a run only from pending, so a run is started once", () => {
    for (const from of AGENT_RUN_STATUSES) {
      expect(canTransitionAgentRun(from, "running")).toBe(from === "pending");
    }
  });

  it("never returns a run to pending", () => {
    for (const from of AGENT_RUN_STATUSES) {
      expect(canTransitionAgentRun(from, "pending")).toBe(false);
    }
  });

  it("reaches succeeded and indeterminate only from running, because only a started run can have called a model", () => {
    for (const from of AGENT_RUN_STATUSES) {
      expect(canTransitionAgentRun(from, "succeeded")).toBe(from === "running");
      expect(canTransitionAgentRun(from, "indeterminate")).toBe(
        from === "running",
      );
    }
  });

  it("cancels only a run that never started, since a running run may already have a call on the wire", () => {
    expect(canTransitionAgentRun("pending", "cancelled")).toBe(true);
    expect(canTransitionAgentRun("running", "cancelled")).toBe(false);
  });

  it("has no way out of a finished status, so a retry is a new run", () => {
    expect([...FINISHED_AGENT_RUN_STATUSES].sort()).toEqual(
      ["cancelled", "failed", "indeterminate", "succeeded"].sort(),
    );
    for (const finished of FINISHED_AGENT_RUN_STATUSES) {
      expect(isFinishedAgentRunStatus(finished)).toBe(true);
      for (const to of AGENT_RUN_STATUSES) {
        expect(canTransitionAgentRun(finished, to)).toBe(false);
      }
    }
  });

  it("treats pending and running as the only unfinished statuses", () => {
    const unfinished = AGENT_RUN_STATUSES.filter(
      (status) => !isFinishedAgentRunStatus(status),
    );
    expect(unfinished).toEqual(["pending", "running"]);
  });

  it("refuses a self-transition, which is no change rather than a transition", () => {
    for (const status of AGENT_RUN_STATUSES) {
      expect(canTransitionAgentRun(status, status)).toBe(false);
    }
  });

  it("cannot be widened at runtime by a caller holding the exported data", () => {
    expect(() =>
      (AGENT_RUN_TRANSITIONS as unknown as unknown[]).push([
        "failed",
        "running",
      ]),
    ).toThrow(TypeError);
    expect(() => {
      (AGENT_RUN_TRANSITIONS[0] as unknown as AgentRunStatus[])[1] =
        "succeeded";
    }).toThrow(TypeError);
    expect(() =>
      (AGENT_RUN_STATUSES as unknown as string[]).push("retrying"),
    ).toThrow(TypeError);
    expect(allowedPairs().sort()).toEqual([...EDGES].sort());
  });

  it("does not mistake a task status, a runtime label or a non-string for a run status", () => {
    for (const value of [
      "queued",
      "in_progress",
      "completed",
      "thinking",
      "retrying",
      "PENDING",
      "",
      null,
      undefined,
      3,
      {},
    ]) {
      expect(isAgentRunStatus(value)).toBe(false);
    }
    for (const status of AGENT_RUN_STATUSES) {
      expect(isAgentRunStatus(status)).toBe(true);
    }
  });
});
