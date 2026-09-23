import type { QueryClient } from "@tanstack/react-query";

import { CompanyOsApiError } from "../../../contracts/company-os-api/index.ts";
import type { SessionEvent, SessionPort, SessionUser } from "../ports";
import {
  generationOf,
  readIdentityOf,
  type KeyGeneration,
} from "../query/keys";
import { createCompanyOsQueryClient } from "../query/queryClient";

// Who may see Company OS data right now, and the query cache that follows it
// (docs/PHASE_2C_BRIEF.md §6.2 "Session (OD-10)", "Server state").
//
//   checking    the session is being read; nothing is called
//   signed-out  no session, or an OS401 anywhere; nothing is called
//   no-access   operator_context refused (OS403, or OS409 for two active
//               memberships); nothing else is called until the user changes
//   signed-in   operator_context may be read; data may be read once the
//               tenant and principal it reported are bound
//
// Every transition away from what was shown clears the whole cache FIRST, so
// no screen can render one user's, one membership's or one tenant's data under
// another: sign-out, a change of user, OS401, OS403, a change of tenant or
// principal and unmount. An OS403 on a data read clears the cache and re-reads
// operator_context (a new epoch). Until the read that was refused succeeds
// again, any further OS403 on a data read is final (no-access, the cache
// cleared): another read of the same screen succeeding proves nothing about
// the refused one, so a function refused on its own causes one re-read and
// then stops, however many reads its screen makes.
//
// An explicit sign-out is final for this mount. Whether or not the server
// ended the session, the Company OS stays signed out until a NEW sign-in (a
// SIGNED_IN for another user) or a fresh mount: a TOKEN_REFRESHED, a
// USER_UPDATED or a SIGNED_IN of the person who signed out (supabase-js
// re-announces a stored session when a tab regains focus) never restores it,
// so a sign-out that did not reach the server is not undone behind them.

/** Why there is no access: operator_context refused, or a read refused twice. */
export type NoAccessReason = "membership" | "read-refused";

export type AccessState =
  | { readonly status: "checking" }
  | { readonly status: "signed-out"; readonly signOutFailed: boolean }
  | {
      readonly status: "no-access";
      readonly userId: string;
      readonly reason: NoAccessReason;
    }
  | {
      readonly status: "signed-in";
      readonly userId: string;
      readonly epoch: number;
      /** The tenant operator_context reported for this epoch; null until then. */
      readonly tenantId: string | null;
      /** The principal operator_context reported for this epoch; null until then. */
      readonly principalId: string | null;
    };

export interface AccessController {
  readonly queryClient: QueryClient;
  getState(): AccessState;
  subscribe(listener: () => void): () => void;
  /** Follows the session; returns the stop, which clears the cache. */
  start(): () => void;
  /** operator_context answered `tenantId` and `principalId` in `epoch`. */
  bindTenant(epoch: number, tenantId: string, principalId: string): void;
  /** Clears the cache, then ends the session; final for this mount. */
  signOut(): Promise<void>;
}

const CHECKING: AccessState = { status: "checking" };
const SIGNED_OUT: AccessState = { status: "signed-out", signOutFailed: false };

/** operator_context refusals that mean the caller holds no usable membership. */
const CONTEXT_REFUSALS: readonly string[] = ["OS403", "OS409"];

const userOf = (state: AccessState): string | null =>
  state.status === "signed-in" || state.status === "no-access"
    ? state.userId
    : null;

/** The published state and its listeners. */
const createStateStore = () => {
  let state: AccessState = CHECKING;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    publish: (next: AccessState) => {
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

type StateStore = ReturnType<typeof createStateStore>;

/** A fresh signed-in state: a new epoch, nothing bound yet. */
const createEpochs = () => {
  let epoch = 0;
  return (userId: string): AccessState => {
    epoch += 1;
    return {
      status: "signed-in",
      userId,
      epoch,
      tenantId: null,
      principalId: null,
    };
  };
};

/**
 * The OS401 / OS403 / OS409 rules for the answers of the cache's queries,
 * and the one re-read an OS403 on a data read earns.
 */
const createRefusalPolicy = (
  store: StateStore,
  reset: (next: AccessState) => void,
  nextEpoch: (userId: string) => AccessState,
) => {
  // The read whose OS403 started the re-read under way (readIdentityOf), or
  // null: set by that reset, cleared only when that same read succeeds again.
  let recheckOf: string | null = null;

  /** The generation of `key` when it is the one shown now; null when stale. */
  const currentGeneration = (key: readonly unknown[]): KeyGeneration | null => {
    const generation = generationOf(key);
    const state = store.get();
    if (
      generation === null ||
      state.status !== "signed-in" ||
      generation.userId !== state.userId ||
      generation.epoch !== state.epoch
    ) {
      return null;
    }
    return generation;
  };

  const onDataForbidden = (
    generation: KeyGeneration,
    key: readonly unknown[],
  ) => {
    if (recheckOf !== null) {
      reset({
        status: "no-access",
        userId: generation.userId,
        reason: "read-refused",
      });
      return;
    }
    reset(nextEpoch(generation.userId));
    recheckOf = readIdentityOf(key);
  };

  const onError = (error: unknown, key: readonly unknown[]) => {
    if (!(error instanceof CompanyOsApiError)) return;
    const generation = currentGeneration(key);
    if (generation === null) return;
    if (error.code === "OS401") {
      reset(SIGNED_OUT);
    } else if (generation.isContext) {
      if (CONTEXT_REFUSALS.includes(error.code)) {
        reset({
          status: "no-access",
          userId: generation.userId,
          reason: "membership",
        });
      }
    } else if (error.code === "OS403") {
      onDataForbidden(generation, key);
    }
  };

  const onSuccess = (key: readonly unknown[]) => {
    if (
      recheckOf !== null &&
      currentGeneration(key)?.isContext === false &&
      readIdentityOf(key) === recheckOf
    ) {
      recheckOf = null;
    }
  };

  return { onError, onSuccess, forget: () => (recheckOf = null) };
};

/** Session events after an explicit sign-out: only a new person signs in again. */
const restoresAfterSignOut = (
  event: SessionEvent,
  user: SessionUser | null,
  signedOutUserId: string | null,
): boolean =>
  event === "SIGNED_IN" && user !== null && user.userId !== signedOutUserId;

export const createAccessController = (
  session: SessionPort,
): AccessController => {
  const store = createStateStore();
  const nextEpoch = createEpochs();
  // Set by an explicit sign-out: the user who signed out ("" when unknown).
  let signedOutUserId: string | null = null;

  /** Clear first, then show the next state. */
  const reset = (next: AccessState) => {
    refusals.forget();
    queryClient.clear();
    store.publish(next);
  };

  const refusals = createRefusalPolicy(store, reset, nextEpoch);
  const queryClient = createCompanyOsQueryClient({
    // Deferred: the cache calls this from inside the failing query's fetch,
    // and clearing the cache there would re-enter it.
    onError: (error, key) => queueMicrotask(() => refusals.onError(error, key)),
    onSuccess: refusals.onSuccess,
  });

  const applyUser = (user: SessionUser | null) => {
    if (user === null) {
      reset(SIGNED_OUT);
    } else if (userOf(store.get()) !== user.userId) {
      reset(nextEpoch(user.userId));
    }
  };

  const onSessionEvent = (event: SessionEvent, user: SessionUser | null) => {
    if (event === "SIGNED_OUT") {
      applyUser(null);
      return;
    }
    if (signedOutUserId !== null) {
      if (!restoresAfterSignOut(event, user, signedOutUserId)) return;
      signedOutUserId = null;
    }
    applyUser(user);
  };

  const start = () => {
    let active = true;
    const unsubscribe = session.onAuthStateChange((event, user) => {
      if (active) onSessionEvent(event, user);
    });
    const decide = (user: SessionUser | null) => {
      // An auth event may already have decided.
      if (active && store.get().status === "checking") applyUser(user);
    };
    void session.currentUser().then(decide, () => decide(null));
    return () => {
      active = false;
      unsubscribe();
      reset(CHECKING);
    };
  };

  const bindTenant = (
    forEpoch: number,
    tenantId: string,
    principalId: string,
  ) => {
    const state = store.get();
    if (state.status !== "signed-in" || state.epoch !== forEpoch) return;
    if (state.tenantId === null) {
      store.publish({ ...state, tenantId, principalId });
    } else if (
      state.tenantId !== tenantId ||
      state.principalId !== principalId
    ) {
      reset(nextEpoch(state.userId));
    }
  };

  const signOut = async () => {
    signedOutUserId = userOf(store.get()) ?? "";
    reset(SIGNED_OUT);
    try {
      await session.signOut();
    } catch {
      // Nothing is shown or called either way; say the server kept the session.
      if (store.get().status === "signed-out") {
        store.publish({ status: "signed-out", signOutFailed: true });
      }
    }
  };

  return {
    queryClient,
    getState: store.get,
    subscribe: store.subscribe,
    start,
    bindTenant,
    signOut,
  };
};
