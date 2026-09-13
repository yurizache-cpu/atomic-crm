import { describe, expect, it } from "vitest";
import { CompanyOsError, toDomainError } from "./errors.ts";

const pgError = (code: string, message = "boom") =>
  Object.assign(new Error(message), { code });

describe("toDomainError", () => {
  it.each([
    ["OS401", "missing_tenant_scope"],
    ["OS403", "refused"],
    ["OS404", "not_found"],
    ["OS409", "invalid_state"],
    ["OS400", "invalid_argument"],
    ["22P02", "malformed_identifier"],
    ["23505", "duplicate"],
    ["23514", "constraint_violation"],
  ])("maps SQLSTATE %s to %s", (sqlstate, code) => {
    const mapped = toDomainError(pgError(sqlstate, "from the database"));
    expect(mapped).toBeInstanceOf(CompanyOsError);
    expect((mapped as CompanyOsError).code).toBe(code);
    expect((mapped as CompanyOsError).sqlstate).toBe(sqlstate);
    expect((mapped as CompanyOsError).message).toBe("from the database");
  });

  it("leaves a native permission failure alone, so a wrong-role connection is not mistaken for a refusal", () => {
    const native = pgError("42501", "permission denied for table companies");
    expect(toDomainError(native)).toBe(native);
  });

  it("leaves connection failures and unknown errors alone", () => {
    const dropped = pgError("08006");
    expect(toDomainError(dropped)).toBe(dropped);
    expect(toDomainError("just a string")).toBe("just a string");
    expect(toDomainError(undefined)).toBeUndefined();
  });

  it("does not wrap an error twice", () => {
    const once = new CompanyOsError("not_found", "gone");
    expect(toDomainError(once)).toBe(once);
  });
});
