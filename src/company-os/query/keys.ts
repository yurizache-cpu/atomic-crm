import { hashKey } from "@tanstack/react-query";

import type { CompanyOsOperation } from "../../../contracts/company-os-api/index.ts";

// Every Company OS query key names the generation it belongs to: the auth user
// and the access epoch (a counter the access controller advances on every
// reset), and, for data, the tenant and the principal operator_context
// reported. A result can therefore never be read under another user, another
// reset, another tenant or another principal, and a refusal that arrives from
// a superseded generation is recognised as stale and ignored.

export const QUERY_ROOT = "company-os";
const CONTEXT = "operator_context";

/** The generation a data read belongs to, as operator_context described it. */
export interface DataScope {
  readonly userId: string;
  readonly epoch: number;
  readonly tenantId: string;
  readonly principalId: string;
}

export const contextKey = (userId: string, epoch: number) =>
  [QUERY_ROOT, userId, epoch, CONTEXT] as const;

export const dataKey = (
  scope: DataScope,
  operation: CompanyOsOperation,
  input: unknown,
) =>
  [
    QUERY_ROOT,
    scope.userId,
    scope.epoch,
    scope.tenantId,
    scope.principalId,
    operation,
    input,
  ] as const;

/**
 * A paged read: the same generation prefix, with a marker so the cursor-driven
 * infinite query never shares a key with a single read of the same input.
 */
export const pagesKey = (
  scope: DataScope,
  operation: CompanyOsOperation,
  input: unknown,
) => [...dataKey(scope, operation, input), "pages"] as const;

/** How many leading parts of a data key name its generation. */
const DATA_SCOPE_PARTS = 5;

/**
 * The read a data key names whatever its generation: its operation, its input
 * and, for a paged read, its marker. The same read made again after a reset
 * has the same identity.
 */
export const readIdentityOf = (key: readonly unknown[]): string =>
  hashKey(key.slice(DATA_SCOPE_PARTS));

export interface KeyGeneration {
  readonly userId: string;
  readonly epoch: number;
  readonly isContext: boolean;
}

/** The generation a key belongs to, or null for a key this module did not build. */
export const generationOf = (key: readonly unknown[]): KeyGeneration | null => {
  const [root, userId, epoch, fourth] = key;
  if (
    root !== QUERY_ROOT ||
    typeof userId !== "string" ||
    typeof epoch !== "number"
  ) {
    return null;
  }
  return { userId, epoch, isContext: key.length === 4 && fourth === CONTEXT };
};
