import { describe, expect, it } from "vitest";
import {
  CLOSED_TASK_STATUSES,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  canTransition,
  isClosed,
  isTaskStatus,
  nextStatuses,
} from "./taskStateMachine.ts";

// The database is the enforcement point; these tests pin the SHAPE of the
// machine so a change to it is a deliberate diff here. Equality with the
// database's own relation is asserted in companyOs.dbtest.ts.

describe("the task state machine", () => {
  it("walks the happy path queued -> assigned -> in_progress -> completed", () => {
    expect(canTransition("queued", "assigned")).toBe(true);
    expect(canTransition("assigned", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "completed")).toBe(true);
  });

  it("offers the controlled alternatives: waiting, failed and cancelled", () => {
    expect(nextStatuses("in_progress")).toEqual([
      "waiting",
      "completed",
      "failed",
      "cancelled",
    ]);
    expect(nextStatuses("waiting")).toEqual([
      "in_progress",
      "failed",
      "cancelled",
    ]);
  });

  it("has no way out of a closed status, so a retry is a new task", () => {
    for (const closed of CLOSED_TASK_STATUSES) {
      expect(nextStatuses(closed)).toEqual([]);
      expect(isClosed(closed)).toBe(true);
    }
  });

  it("never returns a task to queued, and never skips straight to done", () => {
    for (const from of TASK_STATUSES) {
      expect(canTransition(from, "queued")).toBe(false);
    }
    expect(canTransition("queued", "completed")).toBe(false);
    expect(canTransition("assigned", "completed")).toBe(false);
  });

  it("refuses a self-transition, which is no change rather than a transition", () => {
    for (const status of TASK_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it("only ever names known statuses, with no duplicate edges", () => {
    const seen = new Set<string>();
    for (const [from, to] of TASK_TRANSITIONS) {
      expect(isTaskStatus(from) && isTaskStatus(to)).toBe(true);
      expect(seen.has(`${from}->${to}`)).toBe(false);
      seen.add(`${from}->${to}`);
    }
    expect(seen.size).toBe(11);
  });

  it("does not mistake a runtime label or a non-string for a status", () => {
    for (const value of ["thinking", "busy", "QUEUED", "", null, 3, {}]) {
      expect(isTaskStatus(value)).toBe(false);
    }
  });
});
