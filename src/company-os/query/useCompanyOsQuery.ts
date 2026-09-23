import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import type {
  CompanyOsOperation,
  OperationInput,
  OperationResult,
} from "../../../contracts/company-os-api/index.ts";
import { useOperatorScope, useRuntime } from "../session/runtime";
import { dataKey } from "./keys";
import { POLL_INTERVAL_MS } from "./queryClient";

export interface CompanyOsQueryOptions<O extends CompanyOsOperation> {
  /**
   * Re-read every POLL_INTERVAL_MS while visible: always (Overview and
   * Agents), or while the last answer says the state can still change.
   */
  readonly poll?: boolean | ((data: OperationResult<O>) => boolean);
}

const pollsAfter = <O extends CompanyOsOperation>(
  poll: CompanyOsQueryOptions<O>["poll"],
  data: OperationResult<O> | undefined,
): boolean =>
  poll === true ||
  (typeof poll === "function" && data !== undefined && poll(data));

/**
 * One company_os_api read for a screen. It runs only behind a successful
 * operator_context (useOperatorScope throws otherwise), under a key that names
 * the user, the access epoch, the tenant and the principal; it is checked with
 * the operation's contracts on the way out and on the way back, and its answer
 * is kept only once a later operator_context confirms that generation
 * (session/generation.ts).
 */
export const useCompanyOsQuery = <O extends CompanyOsOperation>(
  operation: O,
  input: OperationInput<O>,
  options: CompanyOsQueryOptions<O> = {},
): UseQueryResult<OperationResult<O>> => {
  const { api, generation } = useRuntime();
  const scope = useOperatorScope();
  return useQuery({
    queryKey: dataKey(scope, operation, input),
    queryFn: async ({ signal }) => {
      const data = await api.call(operation, input, {
        expectedUserId: scope.userId,
        signal,
      });
      // Shown only under the generation the server still resolves.
      await generation.confirm(scope);
      return data;
    },
    refetchInterval: (query) =>
      pollsAfter(options.poll, query.state.data) ? POLL_INTERVAL_MS : false,
  });
};
