import {
  CompanyOsApiError,
  CompanyOsContractError,
  CompanyOsInputError,
} from "../../../contracts/company-os-api/index.ts";
import {
  CONTRACT_ERROR_TEXT,
  INPUT_ERROR_TEXT,
  errorTextOf,
} from "../components/queryErrors";
import { createFakeSession, ok, refused } from "../testing/fakeSession";
import {
  TENANT_A,
  USER_A,
  USER_B,
  operatorContext,
  syntheticId,
} from "../testing/samples";
import { createCompanyOsApi } from "./companyOsApi";

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CompanyOsApiError) return error.code;
    if (error instanceof CompanyOsContractError) return "contract";
    if (error instanceof CompanyOsInputError) return "input";
    throw error;
  }
  throw new Error("the call did not fail");
};

describe("the Company OS API adapter", () => {
  it("sends the checked input and returns the parsed response", async () => {
    const session = createFakeSession(USER_A);
    session.answer("operator_context", () =>
      ok(operatorContext(TENANT_A, "Synthetic Clinic")),
    );
    session.answer("list_tasks", () =>
      ok({
        v: 1,
        asOf: "2026-09-22T10:00:00.000000Z",
        items: [],
        nextCursor: null,
      }),
    );
    const api = createCompanyOsApi(session.port);

    const context = await api.call("operator_context", {});
    const tasks = await api.call("list_tasks", { p_status: "assigned" });

    expect(context.tenant).toEqual({ id: TENANT_A, name: "Synthetic Clinic" });
    expect(tasks.items).toEqual([]);
    expect(session.calls).toEqual([
      { operation: "operator_context", args: {} },
      { operation: "list_tasks", args: { p_status: "assigned" } },
    ]);
  });

  it("refuses an argument the function does not take before any request leaves", async () => {
    const session = createFakeSession(USER_A);
    const api = createCompanyOsApi(session.port);

    const code = await codeOf(
      api.call("list_tasks", { p_tenant_id: syntheticId(9) } as never),
    );

    expect(code).toBe("input");
    expect(session.calls).toEqual([]);
  });

  it("refuses a malformed id as a request the browser did not send, never as a response that broke its contract", async () => {
    const session = createFakeSession(USER_A);
    const api = createCompanyOsApi(session.port);
    let thrown: unknown;

    try {
      await api.call("get_task", { p_task_id: "not-a-uuid" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CompanyOsInputError);
    expect(thrown).not.toBeInstanceOf(CompanyOsContractError);
    expect(errorTextOf(thrown)).toBe(INPUT_ERROR_TEXT);
    expect(errorTextOf(thrown)).not.toBe(CONTRACT_ERROR_TEXT);
    expect(session.calls).toEqual([]);
  });

  it("treats no session as signed out and sends nothing", async () => {
    const session = createFakeSession(null);
    const api = createCompanyOsApi(session.port);

    expect(await codeOf(api.call("operator_context", {}))).toBe("OS401");
    expect(session.calls).toEqual([]);
  });

  it("treats a session of another user than the cache's as signed out", async () => {
    const session = createFakeSession(USER_B);
    const api = createCompanyOsApi(session.port);

    const code = await codeOf(
      api.call("operator_context", {}, { expectedUserId: USER_A.userId }),
    );

    expect(code).toBe("OS401");
    expect(session.calls).toEqual([]);
  });

  it.each([
    ["OS403", "OS403"],
    ["OS404", "OS404"],
    ["42501", "OS403"],
    ["PGRST106", "OS403"],
    ["PGRST301", "OS401"],
    ["PGRST303", "OS401"],
    ["22P02", "OS500"],
    ["", "OS500"],
  ])("turns a %j refusal into %s", async (serverCode, expected) => {
    const session = createFakeSession(USER_A);
    session.answer("overview", () => refused(serverCode));
    const api = createCompanyOsApi(session.port);

    expect(await codeOf(api.call("overview", {}))).toBe(expected);
  });

  it("renders a response that broke its contract as an error, never as the value", async () => {
    const session = createFakeSession(USER_A);
    session.answer("operator_context", () =>
      ok({
        ...operatorContext(TENANT_A, "Synthetic Clinic"),
        email: "x@y.test",
      }),
    );
    const api = createCompanyOsApi(session.port);

    expect(await codeOf(api.call("operator_context", {}))).toBe("contract");
  });

  it("turns a request that never answered into OS500", async () => {
    const session = createFakeSession(USER_A);
    session.answer("overview", () => Promise.reject(new TypeError("offline")));
    const api = createCompanyOsApi(session.port);

    expect(await codeOf(api.call("overview", {}))).toBe("OS500");
  });
});
