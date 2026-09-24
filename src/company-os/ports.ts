// The Company OS module's two ports (docs/PHASE_2C_BRIEF.md §6.1, §6.2).
//
// The module may not import `@supabase/*` or any CRM module (eslint.config.js),
// so the session reaches it through SessionPort, whose one implementation
// (src/companyOsSession.ts) wraps the CRM's single supabase-js client and is
// injected by src/App.tsx. It carries only what the module needs: who is signed
// in (a user id, never an email or a token), when that changes, a sign-out,
// and one call into the function-only schema `company_os_api`. CompanyOsApi is
// the typed, contract-checked face of that call that every screen uses.

import type {
  ActInput,
  ActResult,
  CompanyOsAct,
  CompanyOsFunction,
  CompanyOsOperation,
  OperationInput,
  OperationResult,
} from "../../contracts/company-os-api/index.ts";

/** The signed-in user, by auth user id alone. */
export interface SessionUser {
  readonly userId: string;
}

/** supabase-js auth events, by name. */
export type SessionEvent =
  | "INITIAL_SESSION"
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "TOKEN_REFRESHED"
  | "USER_UPDATED"
  | "PASSWORD_RECOVERY"
  | "MFA_CHALLENGE_VERIFIED";

export type SessionListener = (
  event: SessionEvent,
  user: SessionUser | null,
) => void;

/** A company_os_api answer: the body, or the refusal's code and nothing else. */
export interface RpcResponse {
  readonly data: unknown;
  readonly error: { readonly code: string } | null;
}

export interface SessionPort {
  /** The signed-in user now, or null; never rejects (a failure is no session). */
  currentUser(): Promise<SessionUser | null>;
  /** Every later change; returns the unsubscribe. */
  onAuthStateChange(listener: SessionListener): () => void;
  /** Ends the session; rejects when it could not. */
  signOut(): Promise<void>;
  /** One POST to company_os_api.<operation>; the arguments are already checked. */
  rpc(
    operation: CompanyOsFunction,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<RpcResponse>;
}

export interface CallOptions {
  /** The user the caller's cache belongs to: any other session is refused as signed out. */
  readonly expectedUserId?: string;
  readonly signal?: AbortSignal;
}

export interface CompanyOsApi {
  /**
   * Checks the input with the operation's contract, checks for a session,
   * calls, and parses the answer with the response contract. Throws a
   * CompanyOsApiError (by code) or a CompanyOsContractError.
   */
  call<O extends CompanyOsOperation>(
    operation: O,
    input: OperationInput<O>,
    options?: CallOptions,
  ): Promise<OperationResult<O>>;
  /**
   * The two acts (S7.1 decide_review, S7.2 trip_stop), apart from the reads
   * so nothing typed as a read can name one. The same checks as call. Called
   * once per explicit human confirmation, never retried: a lost connection is
   * OS500, whose outcome is unknown, and the caller re-reads the state
   * instead.
   */
  act<A extends CompanyOsAct>(
    act: A,
    input: ActInput<A>,
    options?: CallOptions,
  ): Promise<ActResult<A>>;
}
