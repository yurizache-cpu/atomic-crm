import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseSessionPort } from "./companyOsSession";

// The SessionPort over supabase-js (docs/PHASE_2C_BRIEF.md §6.2, OD-10):
// nothing of supabase-js crosses it but a user id, an event name, a response
// body and a refusal's code. vi.mock does not reach modules under the browser
// runner, so the first block uses a structural stand-in for the client, and the
// second drives the port the Company OS really gets (the CRM's own client and
// logout) over a stubbed global fetch. All data synthetic.

type AuthCallback = (event: string, session: unknown) => void;

const SESSION = {
  access_token: "synthetic-access-token",
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    email: "operator@example.test",
  },
};

const createClientStandIn = () => {
  const callbacks: AuthCallback[] = [];
  const rpcCalls: unknown[] = [];
  const signals: AbortSignal[] = [];
  let unsubscribed = 0;
  let sessionAnswer: unknown = { data: { session: SESSION }, error: null };
  let rpcAnswer: unknown = { data: { v: 1 }, error: null };

  const client = {
    auth: {
      getSession: async () => {
        if (sessionAnswer instanceof Error) throw sessionAnswer;
        return sessionAnswer;
      },
      onAuthStateChange: (callback: AuthCallback) => {
        callbacks.push(callback);
        return {
          data: { subscription: { unsubscribe: () => (unsubscribed += 1) } },
        };
      },
    },
    schema: (schema: string) => ({
      rpc: (name: string, args: unknown) => {
        rpcCalls.push({ schema, name, args });
        const answer = Promise.resolve(rpcAnswer);
        return Object.assign(answer, {
          abortSignal: (signal: AbortSignal) => {
            signals.push(signal);
            return answer;
          },
        });
      },
    }),
  };

  return {
    client: client as unknown as SupabaseClient,
    callbacks,
    rpcCalls,
    signals,
    unsubscribed: () => unsubscribed,
    answerSession: (answer: unknown) => (sessionAnswer = answer),
    answerRpc: (answer: unknown) => (rpcAnswer = answer),
  };
};

const noLogout = async () => {};

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the SessionPort over supabase-js", () => {
  it("calls company_os_api by name and hands back the refusal's code alone", async () => {
    const standIn = createClientStandIn();
    standIn.answerRpc({
      data: null,
      error: {
        code: "OS403",
        message: "synthetic server text",
        details: "synthetic detail",
        hint: "synthetic hint",
      },
    });
    const port = createSupabaseSessionPort({
      client: standIn.client,
      logout: noLogout,
    });
    const signal = new AbortController().signal;

    const response = await port.rpc("list_stops", { p_limit: 5 }, signal);

    expect(response).toEqual({ data: null, error: { code: "OS403" } });
    expect(standIn.rpcCalls).toEqual([
      { schema: "company_os_api", name: "list_stops", args: { p_limit: 5 } },
    ]);
    expect(standIn.signals).toEqual([signal]);
  });

  it("hands back a response body as it came", async () => {
    const standIn = createClientStandIn();
    const port = createSupabaseSessionPort({
      client: standIn.client,
      logout: noLogout,
    });

    expect(await port.rpc("overview", {})).toEqual({
      data: { v: 1 },
      error: null,
    });
  });

  it("reports the signed-in user by id alone, and no session when it cannot read one", async () => {
    const standIn = createClientStandIn();
    const port = createSupabaseSessionPort({
      client: standIn.client,
      logout: noLogout,
    });

    expect(await port.currentUser()).toEqual({ userId: SESSION.user.id });
    standIn.answerSession({
      data: { session: null },
      error: { name: "AuthError" },
    });
    expect(await port.currentUser()).toBeNull();
    standIn.answerSession(new Error("storage unavailable"));
    expect(await port.currentUser()).toBeNull();
  });

  it("delivers auth changes after the auth callback returns, SIGNED_OUT as no user, and none after unsubscribing", async () => {
    const standIn = createClientStandIn();
    const port = createSupabaseSessionPort({
      client: standIn.client,
      logout: noLogout,
    });
    const heard: unknown[] = [];
    const unsubscribe = port.onAuthStateChange((event, user) =>
      heard.push([event, user]),
    );

    standIn.callbacks[0]("TOKEN_REFRESHED", SESSION);
    expect(heard).toEqual([]);
    await nextTask();
    standIn.callbacks[0]("SIGNED_OUT", SESSION);
    await nextTask();
    standIn.callbacks[0]("SIGNED_IN", SESSION);
    unsubscribe();
    await nextTask();

    expect(heard).toEqual([
      ["TOKEN_REFRESHED", { userId: SESSION.user.id }],
      ["SIGNED_OUT", null],
    ]);
    expect(standIn.unsubscribed()).toBe(1);
  });

  it("rejects a sign-out the logout did not complete, without its error text", async () => {
    const port = createSupabaseSessionPort({
      client: createClientStandIn().client,
      logout: async () => {
        throw new Error("synthetic server text");
      },
    });

    await expect(port.signOut()).rejects.toThrow(
      /^The session could not be ended\.$/,
    );
  });
});

// The real port, as src/App.tsx builds it. The session supabase-js stores for
// 127.0.0.1 is `sb-127-auth-token`; the CRM caches its sale row beside it.
const API_URL = "http://127.0.0.1:54341";
const AUTH_TOKEN_KEY = "sb-127-auth-token";
const CACHED_SALE_KEY = "RaStore.auth.current_sale";
const CACHED_INIT_KEY = "RaStore.auth.is_initialized";
const RESPONSE_SENTINEL = "Sentinel projection value from company_os_api";

interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly profile: string | null;
}

describe("the SessionPort src/App.tsx builds: the CRM's own client and logout", () => {
  const seen: SeenRequest[] = [];
  let answer: (path: string) => Response = () => new Response(null);

  const network = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    seen.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      profile: headers.get("Content-Profile"),
    });
    return answer(url.pathname);
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const plantSession = () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    localStorage.setItem(
      AUTH_TOKEN_KEY,
      JSON.stringify({
        access_token: "synthetic-access-token",
        refresh_token: "synthetic-refresh-token",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: expiresAt,
        user: {
          id: SESSION.user.id,
          aud: "authenticated",
          role: "authenticated",
          app_metadata: {},
          user_metadata: {},
          created_at: "2026-09-22T10:00:00Z",
        },
      }),
    );
  };

  const browserStorage = async () => ({
    localStorage: Object.keys(localStorage)
      .sort()
      .map((key) => [key, localStorage.getItem(key)]),
    sessionStorage: Object.keys(sessionStorage)
      .sort()
      .map((key) => [key, sessionStorage.getItem(key)]),
    cookies: document.cookie,
    indexedDB: (await indexedDB.databases()).map((db) => db.name).sort(),
    cacheStorage: (await caches.keys()).sort(),
  });

  beforeEach(() => {
    vi.stubEnv("VITE_SUPABASE_URL", API_URL);
    vi.stubEnv("VITE_SB_PUBLISHABLE_KEY", "sb_publishable_test_key");
    vi.stubGlobal("fetch", network);
    seen.length = 0;
    localStorage.clear();
    sessionStorage.clear();
    plantSession();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("answers each read with a POST to company_os_api and leaves browser storage as it found it", async () => {
    answer = () => json({ v: 1, note: RESPONSE_SENTINEL });
    const before = await browserStorage();
    const port = createSupabaseSessionPort();

    const overview = await port.rpc("overview", {});
    const stops = await port.rpc("list_stops", { p_limit: 5 });
    await nextTask();

    expect(overview).toEqual({
      data: { v: 1, note: RESPONSE_SENTINEL },
      error: null,
    });
    expect(stops.error).toBeNull();
    expect(seen.filter((request) => request.path.startsWith("/rest/"))).toEqual(
      [
        {
          method: "POST",
          path: "/rest/v1/rpc/overview",
          profile: "company_os_api",
        },
        {
          method: "POST",
          path: "/rest/v1/rpc/list_stops",
          profile: "company_os_api",
        },
      ],
    );
    const after = await browserStorage();
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain(RESPONSE_SENTINEL);
  });

  it("signs out as the CRM does: the CRM's cached identity goes with the session", async () => {
    answer = (path) =>
      path === "/auth/v1/logout"
        ? new Response(null, { status: 204 })
        : json({});
    localStorage.setItem(
      CACHED_SALE_KEY,
      JSON.stringify({ id: 7, administrator: true, role: "owner" }),
    );
    localStorage.setItem(CACHED_INIT_KEY, "true");
    const port = createSupabaseSessionPort();

    await port.signOut();

    expect(seen).toContainEqual({
      method: "POST",
      path: "/auth/v1/logout",
      profile: null,
    });
    expect(localStorage.getItem(CACHED_SALE_KEY)).toBeNull();
    expect(localStorage.getItem(CACHED_INIT_KEY)).toBeNull();
    expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull();
  });

  it("drops the CRM's cached identity even when the server does not end the session, and says the sign-out failed", async () => {
    answer = (path) =>
      path === "/auth/v1/logout"
        ? json({ code: 500, msg: "synthetic failure" }, 500)
        : json({});
    localStorage.setItem(
      CACHED_SALE_KEY,
      JSON.stringify({ id: 7, administrator: true, role: "owner" }),
    );
    const port = createSupabaseSessionPort();

    await expect(port.signOut()).rejects.toThrow(
      /^The session could not be ended\.$/,
    );

    expect(localStorage.getItem(CACHED_SALE_KEY)).toBeNull();
  });
});
