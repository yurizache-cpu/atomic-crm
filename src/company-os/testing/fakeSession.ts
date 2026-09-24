import type { CompanyOsFunction } from "../../../contracts/company-os-api/index.ts";
import type {
  RpcResponse,
  SessionEvent,
  SessionListener,
  SessionPort,
  SessionUser,
} from "../ports";

// A SessionPort for browser tests: vi.mock does not reach modules under the
// browser runner, so the Company OS is tested through the port it is given.
// Every call is recorded, and each operation answers what the test set; an
// operation the test did not expect answers OS500 and is still recorded, so an
// assertion on `calls` catches it.

export interface RecordedCall {
  readonly operation: CompanyOsFunction;
  readonly args: Readonly<Record<string, unknown>>;
}

export type Responder = (
  args: Readonly<Record<string, unknown>>,
) => RpcResponse | Promise<RpcResponse>;

export interface FakeSession {
  readonly port: SessionPort;
  readonly calls: readonly RecordedCall[];
  /** How often the Company OS asked the port to end the session. */
  readonly signOutRequests: number;
  /** Answer `operation` with `responder` from now on. */
  answer(operation: CompanyOsFunction, responder: Responder): void;
  /** The session changes, and every listener hears it. */
  emit(event: SessionEvent, user: SessionUser | null): void;
  /** Runs when the Company OS asks to end the session, before it ends. */
  onSignOut(hook: () => void): void;
  callsOf(operation: CompanyOsFunction): readonly RecordedCall[];
}

export const ok = (data: unknown): RpcResponse => ({ data, error: null });

export const refused = (code: string): RpcResponse => ({
  data: null,
  error: { code },
});

export const createFakeSession = (
  initialUser: SessionUser | null,
): FakeSession => {
  let user = initialUser;
  const listeners = new Set<SessionListener>();
  const responders = new Map<CompanyOsFunction, Responder>();
  const calls: RecordedCall[] = [];
  let signOutRequests = 0;
  let signOutHook = () => {};

  const emit = (event: SessionEvent, next: SessionUser | null) => {
    user = next;
    for (const listener of [...listeners]) listener(event, next);
  };

  const port: SessionPort = {
    currentUser: async () => user,
    onAuthStateChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    signOut: async () => {
      signOutRequests += 1;
      signOutHook();
      emit("SIGNED_OUT", null);
    },
    rpc: async (operation, args) => {
      calls.push({ operation, args });
      const responder = responders.get(operation);
      return responder === undefined ? refused("OS500") : responder(args);
    },
  };

  return {
    port,
    calls,
    get signOutRequests() {
      return signOutRequests;
    },
    answer: (operation, responder) => {
      responders.set(operation, responder);
    },
    emit,
    onSignOut: (hook) => {
      signOutHook = hook;
    },
    callsOf: (operation) =>
      calls.filter((call) => call.operation === operation),
  };
};
