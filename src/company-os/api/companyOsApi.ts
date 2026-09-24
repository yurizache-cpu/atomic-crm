import {
  CompanyOsApiError,
  parseOperationInput,
  parseOperationResult,
  toCompanyOsApiError,
  type CompanyOsFunction,
  type FunctionInput,
  type FunctionResult,
} from "../../../contracts/company-os-api/index.ts";
import type {
  CallOptions,
  CompanyOsApi,
  RpcResponse,
  SessionPort,
} from "../ports";

// The CompanyOsApi adapter over SessionPort.rpc (docs/PHASE_2C_BRIEF.md §6.2).
//
// The session is checked BEFORE every call. Without one, supabase-js would
// send the publishable key instead of a user token; PostgREST would then run
// the call as `anon`, whose 42501 the contracts map to OS403, and a signed-out
// browser would be told it has no access. No session is OS401: signed out.

const signedOut = (operation: CompanyOsFunction) =>
  new CompanyOsApiError(operation, "OS401");

const sessionMatches = async (
  session: SessionPort,
  expectedUserId: string | undefined,
): Promise<boolean> => {
  try {
    const user = await session.currentUser();
    return (
      user !== null &&
      (expectedUserId === undefined || user.userId === expectedUserId)
    );
  } catch {
    return false;
  }
};

export const createCompanyOsApi = (session: SessionPort): CompanyOsApi => {
  const invoke = async <F extends CompanyOsFunction>(
    operation: F,
    input: FunctionInput<F>,
    options: CallOptions = {},
  ): Promise<FunctionResult<F>> => {
    // A key the function does not take never leaves the browser.
    const args = parseOperationInput(operation, input) as Readonly<
      Record<string, unknown>
    >;
    if (!(await sessionMatches(session, options.expectedUserId))) {
      throw signedOut(operation);
    }
    let response: RpcResponse;
    try {
      response = await session.rpc(operation, args, options.signal);
    } catch {
      // A lost connection or an aborted request: nothing of it is kept.
      throw new CompanyOsApiError(operation, "OS500");
    }
    if (response.error !== null) {
      throw toCompanyOsApiError(operation, response.error);
    }
    return parseOperationResult(operation, response.data);
  };
  // The reads and the acts share every check; they differ only in what
  // they may name (ports.ts).
  return { call: invoke, act: invoke };
};
