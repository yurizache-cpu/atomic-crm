import {
  CompanyOsApiError,
  CompanyOsContractError,
  OS_ERROR_CODES,
} from "../../../contracts/company-os-api/index.ts";
import { shouldRetry } from "./queryClient";

describe("the Company OS retry policy", () => {
  it.each(OS_ERROR_CODES.filter((code) => code.startsWith("OS4")))(
    "never retries %s",
    (code) => {
      expect(shouldRetry(0, new CompanyOsApiError("overview", code))).toBe(
        false,
      );
    },
  );

  it("retries OS500 once, and only once", () => {
    const error = new CompanyOsApiError("overview", "OS500");

    expect(shouldRetry(0, error)).toBe(true);
    expect(shouldRetry(1, error)).toBe(false);
  });

  it("never retries a response that broke its contract, or an unknown failure", () => {
    expect(shouldRetry(0, new CompanyOsContractError("overview", []))).toBe(
      false,
    );
    expect(shouldRetry(0, new TypeError("bug"))).toBe(false);
  });
});
