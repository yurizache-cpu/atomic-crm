import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { CompanyOsApiError } from "../../../contracts/company-os-api/index.ts";
import { contextKey } from "../query/keys";
import { POLL_INTERVAL_MS } from "../query/queryClient";
import type { AccessState } from "../session/accessController";
import {
  OperatorScopeContext,
  useRuntime,
  type OperatorScope,
} from "../session/runtime";
import { LoadingState, UnavailableState } from "./AccessStates";
import { OperatorFrame } from "./OperatorFrame";

type SignedIn = Extract<AccessState, { status: "signed-in" }>;

/** Refusals the access controller turns into another state; shown as loading meanwhile. */
const ACCESS_REFUSALS: readonly string[] = ["OS401", "OS403", "OS409"];

const isAccessRefusal = (error: unknown): boolean =>
  error instanceof CompanyOsApiError && ACCESS_REFUSALS.includes(error.code);

/**
 * operator_context first, always (docs/PHASE_2C_BRIEF.md §6.2): no screen, and
 * so no other query, renders until it has answered for this user and epoch and
 * the tenant and principal it reported are bound.
 *
 * Why it is read again every POLL_INTERVAL_MS while visible, and on focus, on
 * EVERY screen, those that read nothing on a timer included: it is how the
 * page learns that the membership moved to another tenant, was revoked, or
 * that the principal changed, while the operator only looks at what is
 * already shown. A change clears the cache (AccessController.bindTenant) and a
 * refusal ends access, so data on screen never outlives its generation by
 * more than one interval. Each data answer is also confirmed on its own
 * (session/generation.ts); this poll covers the screen that reads nothing.
 */
export const ContextGate = ({ access }: { access: SignedIn }) => {
  const { api, controller } = useRuntime();
  const { userId, epoch, tenantId, principalId } = access;
  const context = useQuery({
    queryKey: contextKey(userId, epoch),
    queryFn: ({ signal }) =>
      api.call("operator_context", {}, { expectedUserId: userId, signal }),
    staleTime: 0,
    refetchInterval: POLL_INTERVAL_MS,
  });

  const reportedTenantId = context.data?.tenant.id;
  const reportedPrincipalId = context.data?.principal.id;
  useEffect(() => {
    if (reportedTenantId !== undefined && reportedPrincipalId !== undefined) {
      controller.bindTenant(epoch, reportedTenantId, reportedPrincipalId);
    }
  }, [controller, epoch, reportedTenantId, reportedPrincipalId]);

  const scope = useMemo<OperatorScope | null>(
    () =>
      context.data !== undefined &&
      tenantId !== null &&
      principalId !== null &&
      context.data.tenant.id === tenantId &&
      context.data.principal.id === principalId
        ? { userId, epoch, tenantId, principalId, context: context.data }
        : null,
    [context.data, userId, epoch, tenantId, principalId],
  );

  if (context.isError && isAccessRefusal(context.error))
    return <LoadingState />;
  if (scope === null) {
    return context.isError ? (
      <UnavailableState onRetry={() => void context.refetch()} />
    ) : (
      <LoadingState />
    );
  }
  return (
    <OperatorScopeContext.Provider value={scope}>
      <OperatorFrame
        context={scope.context}
        onSignOut={() => void controller.signOut()}
      />
    </OperatorScopeContext.Provider>
  );
};
