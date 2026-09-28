import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it } from "vitest";

import { createCrmAccessProbe } from "./crmAccess";

// The probe only chooses which screen to show (Production Security Gate A.1):
// the database decides what a session may read. It asks the provider for the
// level its token states, and only for a session at level 1 asks the SERVER
// whether the caller's own `sales` row is visible. A fake client stands for
// both; all data synthetic.

interface FakeClientOptions {
  readonly level: "aal1" | "aal2" | "aal3" | null;
  readonly levelError?: boolean;
  readonly sales?: readonly { id: number }[];
  readonly salesError?: boolean;
}

const fakeClient = (options: FakeClientOptions) => {
  const asked: string[] = [];
  const client = {
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: async () =>
          options.levelError
            ? { data: null, error: new Error("no level") }
            : { data: { currentLevel: options.level }, error: null },
      },
    },
    from: (table: string) => ({
      select: () => ({
        limit: async () => {
          asked.push(table);
          return options.salesError
            ? { data: null, error: new Error("no answer") }
            : { data: options.sales ?? [], error: null };
        },
      }),
    }),
  } as unknown as SupabaseClient;
  return { client, asked };
};

describe("the CRM access probe (Production Security Gate A.1)", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("sends a level-1 session the server answers nothing to the second factor", async () => {
    const { client, asked } = fakeClient({ level: "aal1", sales: [] });
    expect(await createCrmAccessProbe(client)()).toBe("second-factor");
    expect(asked).toEqual(["sales"]);
  });

  it("does not send a level-1 session the server does answer (the local exemption)", async () => {
    const { client } = fakeClient({ level: "aal1", sales: [{ id: 1 }] });
    expect(await createCrmAccessProbe(client)()).toBe("allowed");
  });

  it("asks the server nothing for a session at level 2 or 3, or for no session", async () => {
    for (const level of ["aal2", "aal3", null] as const) {
      const { client, asked } = fakeClient({ level, sales: [] });
      expect(await createCrmAccessProbe(client)()).toBe("allowed");
      expect(asked).toEqual([]);
    }
  });

  it("shows the CRM when a question fails: its own calls report the failure", async () => {
    expect(
      await createCrmAccessProbe(
        fakeClient({ level: "aal1", salesError: true }).client,
      )(),
    ).toBe("allowed");
    expect(
      await createCrmAccessProbe(
        fakeClient({ level: "aal1", levelError: true }).client,
      )(),
    ).toBe("allowed");
  });

  it("lets the two email-link pages through without asking anything", async () => {
    for (const hash of ["#/set-password", "#/forgot-password"]) {
      history.replaceState(null, "", hash);
      const { client, asked } = fakeClient({ level: "aal1", sales: [] });
      expect(await createCrmAccessProbe(client)()).toBe("allowed");
      expect(asked).toEqual([]);
    }
  });
});
