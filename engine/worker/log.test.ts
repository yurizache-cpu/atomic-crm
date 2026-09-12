// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createLogger, formatLogLine } from "./log.ts";

describe("log lines are structured", () => {
  it("emits one JSON object per line", () => {
    const lines: string[] = [];
    const log = createLogger(
      (line) => lines.push(line),
      () => new Date("2026-09-12T10:00:00.000Z"),
    );
    log("job.leased", { workerId: "w1", jobId: "j1", tenantId: "t1" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      at: "2026-09-12T10:00:00.000Z",
      event: "job.leased",
      workerId: "w1",
      jobId: "j1",
      tenantId: "t1",
    });
  });

  it("omits fields that were not supplied rather than emitting nulls", () => {
    const line = JSON.parse(
      formatLogLine("worker.idle", { workerId: "w1" }, "t"),
    );
    expect(Object.keys(line)).toEqual(["at", "event", "workerId"]);
  });

  it("contains no newline, so one event is one line", () => {
    const line = formatLogLine(
      "job.attempt_failed",
      { detail: "line one\nline two" },
      "t",
    );
    expect(line.split("\n")).toHaveLength(1);
  });
});

describe("what a log line must not carry", () => {
  it("has no field that can hold a payload", () => {
    // The guard is the TYPE, but a type is erased at runtime, so this asserts
    // the shape the formatter will actually emit. The first tenant is a
    // psychology clinic: an email body in a log line is an LGPD incident.
    const line = JSON.parse(
      formatLogLine(
        "job.attempt_completed",
        {
          workerId: "w1",
          jobId: "j1",
          tenantId: "t1",
          kind: "postmark.ledger_retention",
          attempt: 1,
          maxAttempts: 5,
          durationMs: 12,
          failureClass: "transient",
          count: 3,
          detail: "purged=3",
        },
        "t",
      ),
    );
    expect(Object.keys(line).sort()).toEqual([
      "at",
      "attempt",
      "count",
      "detail",
      "durationMs",
      "event",
      "failureClass",
      "jobId",
      "kind",
      "maxAttempts",
      "tenantId",
      "workerId",
    ]);
    expect(Object.keys(line)).not.toContain("payload");
  });

  it("truncates a long detail so a driver dump cannot become the log", () => {
    const line = JSON.parse(
      formatLogLine("job.attempt_failed", { detail: "x".repeat(5000) }, "t"),
    );
    expect(line.detail.length).toBe(500);
  });

  it("drops an unexpected extra field instead of passing it through", () => {
    const line = JSON.parse(
      formatLogLine(
        "job.leased",
        { workerId: "w1", payload: { secret: 1 } } as never,
        "t",
      ),
    );
    expect(line).not.toHaveProperty("payload");
  });
});
