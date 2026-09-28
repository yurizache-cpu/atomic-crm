import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Production Security Gate A.1: the database answers a CRM session below
// authenticator assurance level 2 nothing, so at level 1 the caller's `sales`
// row is invisible. checkAuth used to read that as a disabled account and END
// the session, which would make the second factor unreachable. It must end the
// session only when the session is past its second factor and the account is
// still missing. These drive the REAL auth provider over a stubbed `fetch`, a
// stored synthetic session and the provider's own level; nothing is granted by
// the browser (the database stays the authority).

const USER_ID = "00000000-0000-4000-8000-0000000000a1";
const STORAGE_KEY = "sb-127-auth-token";

const base64url = (value: unknown) =>
  btoa(JSON.stringify(value))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const storeSession = (aal: "aal1" | "aal2") => {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const accessToken = [
    base64url({ alg: "none", typ: "JWT" }),
    base64url({
      sub: USER_ID,
      aud: "authenticated",
      role: "authenticated",
      aal,
      session_id: "00000000-0000-4000-8000-0000000005e5",
      exp: expiresAt,
    }),
    "synthetic-signature",
  ].join(".");
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      access_token: accessToken,
      refresh_token: "synthetic-refresh",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: expiresAt,
      user: {
        id: USER_ID,
        aud: "authenticated",
        role: "authenticated",
        app_metadata: {},
        user_metadata: {},
        created_at: "2026-01-01T00:00:00Z",
      },
    }),
  );
};

describe("checkAuth and a session below its second factor", () => {
  const requests: string[] = [];

  beforeEach(() => {
    requests.length = 0;
    vi.resetModules();
    vi.stubEnv("VITE_SUPABASE_URL", "http://127.0.0.1:54341");
    vi.stubEnv("VITE_SB_PUBLISHABLE_KEY", "sb_publishable_test_key");
    // The `sales` read answers no row, as the database does below level 2 (and
    // for a disabled account); every other call resolves as a benign success.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("/rest/v1/sales")) {
          return new Response(
            JSON.stringify({
              code: "PGRST116",
              details: "The result contains 0 rows",
              hint: null,
              message: "JSON object requested, multiple (or no) rows returned",
            }),
            { status: 406, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    localStorage.clear();
    window.location.hash = "#/";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("keeps a level-1 session whose account the database does not show, so the second factor stays reachable", async () => {
    storeSession("aal1");
    const { getAuthProvider } = await import("./authProvider");

    await expect(getAuthProvider().checkAuth({})).resolves.toBeUndefined();

    expect(requests.some((url) => url.includes("/auth/v1/logout"))).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("still ends a level-2 session whose account is disabled or unprovisioned", async () => {
    storeSession("aal2");
    const { getAuthProvider } = await import("./authProvider");

    await expect(getAuthProvider().checkAuth({})).rejects.toThrow(
      "Your account is disabled or has not been provisioned.",
    );

    expect(requests.some((url) => url.includes("/auth/v1/logout"))).toBe(true);
  });
});
