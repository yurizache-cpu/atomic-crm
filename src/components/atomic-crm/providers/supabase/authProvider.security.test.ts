import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { QUERY_CACHE_STORAGE_KEY } from "../queryCacheKey";

// Regression tests for SEC-1BS-01 (see docs/SECURITY_AUDIT_1BS_REPORT.md).
//
// Logging out used to clear two auth hints and leave the PERSISTED REACT QUERY
// CACHE behind — every contact, note, email address and consent flag the user
// had viewed, for `gcTime` (24h), across browser restarts. For the first tenant,
// an online psychology clinic, that is other people's clinical data sitting on
// a device after its user explicitly ended the session.
//
// These drive the REAL auth provider's `logout`. `vi.mock` does not work under
// the browser-mode runner (CLAUDE.md, "Tests"), so the seam is the global
// `fetch` plus stubbed env, exactly as `getContactAvatar.test.ts` does it.

const SENSITIVE = JSON.stringify({
  clientState: {
    queries: [
      {
        queryKey: ["contacts", "getList"],
        state: {
          data: {
            data: [
              {
                id: 1,
                first_name: "Patient",
                last_name: "Example",
                email_jsonb: [{ email: "patient@example.invalid" }],
              },
            ],
          },
        },
      },
    ],
  },
});

describe("logout clears everything the browser cached about the tenant", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_SUPABASE_URL", "http://127.0.0.1:54341");
    vi.stubEnv("VITE_SB_PUBLISHABLE_KEY", "sb_publishable_test_key");
    // Every network call the sign-out makes resolves as a benign success.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("removes the persisted React Query cache", async () => {
    const { getAuthProvider } = await import("./authProvider");
    localStorage.setItem(QUERY_CACHE_STORAGE_KEY, SENSITIVE);
    localStorage.setItem("RaStore.auth.is_initialized", "true");
    localStorage.setItem("RaStore.auth.current_sale", '{"id":1}');

    await getAuthProvider().logout?.({});

    expect(localStorage.getItem(QUERY_CACHE_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem("RaStore.auth.is_initialized")).toBeNull();
    expect(localStorage.getItem("RaStore.auth.current_sale")).toBeNull();
  });

  it("leaves no contact data anywhere in localStorage after logout", async () => {
    // Deliberately broader than the key check: the assertion is that the PII is
    // gone, not that one particular key was removed. If a future change moves
    // the cache to another key, this still fails.
    const { getAuthProvider } = await import("./authProvider");
    localStorage.setItem(QUERY_CACHE_STORAGE_KEY, SENSITIVE);

    await getAuthProvider().logout?.({});

    const remaining = Object.keys(localStorage)
      .map((k) => `${k}=${localStorage.getItem(k)}`)
      .join("\n");
    expect(remaining).not.toContain("patient@example.invalid");
    expect(remaining).not.toContain("Patient");
  });
});
