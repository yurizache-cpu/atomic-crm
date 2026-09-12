// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  classifyError,
  describeError,
  PermanentError,
  SecurityError,
  TransientError,
} from "./failures.ts";

describe("classification is by type first", () => {
  it("reads the class off a marker error", () => {
    expect(classifyError(new TransientError("db blipped"))).toBe("transient");
    expect(classifyError(new PermanentError("bad payload"))).toBe("permanent");
    expect(classifyError(new SecurityError("not your lease"))).toBe("security");
  });

  it("keeps the marker class even when a SQLSTATE says otherwise", () => {
    // A handler that has decided "this is permanent" must win over a code that
    // happens to look transient: the handler knows what it attempted.
    const error = Object.assign(new PermanentError("already refunded"), {
      code: "08006",
    });
    expect(classifyError(error)).toBe("permanent");
  });
});

describe("SQLSTATE mapping", () => {
  it("treats a privilege refusal as a security failure, not a retry", () => {
    // The important case. An RLS policy or a missing grant refusing a statement
    // is a trust-boundary event; retrying it is an attack on a schedule.
    expect(classifyError({ code: "42501" })).toBe("security");
  });

  it("treats malformed input as permanent", () => {
    expect(classifyError({ code: "22P02" })).toBe("permanent");
    expect(classifyError({ code: "23514" })).toBe("permanent");
  });

  it("treats connection and contention failures as transient", () => {
    expect(classifyError({ code: "08006" })).toBe("transient");
    expect(classifyError({ code: "40P01" })).toBe("transient");
    expect(classifyError({ code: "57014" })).toBe("transient");
    expect(classifyError({ code: "ECONNREFUSED" })).toBe("transient");
  });
});

describe("the default is unknown, never transient", () => {
  it("classifies a plain Error as unknown", () => {
    // This distinction is the whole point of having four classes rather than
    // two. `unknown` still retries, but it is RECORDED as unanalysed, so a
    // failure nobody has looked at stays visible instead of being filed as
    // understood infrastructure noise.
    expect(classifyError(new Error("something went wrong"))).toBe("unknown");
  });

  it("classifies a thrown non-Error as unknown", () => {
    expect(classifyError("a string")).toBe("unknown");
    expect(classifyError(null)).toBe("unknown");
    expect(classifyError(undefined)).toBe("unknown");
  });

  it("classifies an unrecognised SQLSTATE as unknown", () => {
    expect(classifyError({ code: "XX000" })).toBe("unknown");
  });

  it("ignores a non-string code", () => {
    expect(classifyError({ code: 42501 })).toBe("unknown");
  });
});

describe("describeError", () => {
  it("includes the SQLSTATE when there is one", () => {
    expect(
      describeError(Object.assign(new Error("denied"), { code: "42501" })),
    ).toBe("42501: denied");
  });

  it("stringifies a non-Error", () => {
    expect(describeError(404)).toBe("404");
  });

  it("does not include a stack", () => {
    const error = new Error("boom");
    expect(describeError(error)).not.toContain("at ");
  });
});
