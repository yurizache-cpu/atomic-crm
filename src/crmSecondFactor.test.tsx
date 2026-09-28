import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import type { MfaPort, MfaStatus } from "./company-os/ports";
import { createFakeSession } from "./company-os/testing/fakeSession";
import type { CrmAccess } from "./crmAccess";
import { CrmSecondFactorGate } from "./crmSecondFactor";

// Production Security Gate A.1 in the browser: the database answers a CRM
// session below multi-factor assurance level 2 nothing, so the application
// shell sends such a session through the same second-factor screen the
// Company OS uses instead of a CRM of empty lists. It is convenience: the CRM
// is shown again only after the (fake) probe says the server now answers the
// session. All data synthetic; the code is fake.

const USER = { userId: "00000000-0000-4000-8000-0000000000a1" };
const OTHER = { userId: "00000000-0000-4000-8000-0000000000b2" };
const CODE = "123456";
const CRM_TEXT = "Synthetic CRM dashboard";

const Crm = () => <p>{CRM_TEXT}</p>;

const createFakeMfa = (
  status: MfaStatus | null,
  accepts: (code: string) => boolean,
) => {
  const verified: string[] = [];
  const port: MfaPort = {
    status: async () => status,
    enrollTotp: async () => ({
      factorId: "factor-new",
      qrCode:
        "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
      secret: "SYNTHETICKEY234567",
    }),
    verifyTotp: async (factorId, code) => {
      verified.push(`${factorId}:${code}`);
      return accepts(code);
    },
  };
  return { port, verified };
};

/** A probe the test drives: what the server answers this session now. */
const createProbe = (initial: CrmAccess) => {
  let answer: CrmAccess = initial;
  let failing = false;
  return {
    probe: async (): Promise<CrmAccess> => {
      if (failing) throw new Error("the server could not be asked");
      return answer;
    },
    serverNowAccepts: () => {
      answer = "allowed";
    },
    serverNowRefuses: () => {
      answer = "second-factor";
    },
    fail: () => {
      failing = true;
    },
  };
};

const renderGate = async (
  session: ReturnType<typeof createFakeSession>,
  probe: () => Promise<CrmAccess>,
) =>
  render(
    <CrmSecondFactorGate session={session.port} probe={probe}>
      <Crm />
    </CrmSecondFactorGate>,
  );

describe("the CRM second-factor gate (Production Security Gate A.1)", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("sends a session the server refuses at level 1 to the second factor, not to the CRM", async () => {
    const mfa = createFakeMfa(
      { needsSecondFactor: true, factorId: "factor-1" },
      (c) => c === CODE,
    );
    const session = createFakeSession(USER, { mfa: mfa.port });
    const server = createProbe("second-factor");
    const screen = await renderGate(session, server.probe);

    await expect
      .element(
        screen.getByRole("heading", { name: "Verificação em duas etapas" }),
      )
      .toBeVisible();
    await expect.element(screen.getByText(/O CRM exige/)).toBeVisible();
    expect(screen.getByText(CRM_TEXT).query()).toBeNull();

    await screen.getByLabelText("Código de 6 dígitos").fill(CODE);
    await screen.getByRole("button", { name: "Verificar" }).click();
    await expect.poll(() => mfa.verified).toEqual([`factor-1:${CODE}`]);
    // The code alone opens nothing: the CRM waits for the server's answer.
    expect(screen.getByText(CRM_TEXT).query()).toBeNull();

    server.serverNowAccepts();
    session.emit("MFA_CHALLENGE_VERIFIED", USER);
    await expect.element(screen.getByText(CRM_TEXT)).toBeVisible();
  });

  it("offers enrolment to a person with no factor yet", async () => {
    const mfa = createFakeMfa(
      { needsSecondFactor: true, factorId: null },
      () => true,
    );
    const session = createFakeSession(USER, { mfa: mfa.port });
    const screen = await renderGate(
      session,
      createProbe("second-factor").probe,
    );

    await expect
      .element(
        screen.getByRole("button", {
          name: "Configurar o aplicativo autenticador",
        }),
      )
      .toBeVisible();
    expect(screen.getByText(CRM_TEXT).query()).toBeNull();
  });

  it("shows the CRM untouched to a session the server accepts (the local exemption)", async () => {
    const mfa = createFakeMfa(
      { needsSecondFactor: true, factorId: null },
      () => true,
    );
    const session = createFakeSession(USER, { mfa: mfa.port });
    const screen = await renderGate(session, createProbe("allowed").probe);

    await expect.element(screen.getByText(CRM_TEXT)).toBeVisible();
    expect(screen.getByText(/exige um segundo fator/).query()).toBeNull();
  });

  it("shows the CRM (its login) when nobody is signed in", async () => {
    const screen = await renderGate(
      createFakeSession(null),
      createProbe("allowed").probe,
    );
    await expect.element(screen.getByText(CRM_TEXT)).toBeVisible();
  });

  it("shows the CRM when the server cannot be asked: the CRM's own calls report it", async () => {
    const failing = createProbe("second-factor");
    failing.fail();
    const screen = await renderGate(createFakeSession(USER), failing.probe);
    await expect.element(screen.getByText(CRM_TEXT)).toBeVisible();
  });

  it("stops the CRM for a new sign-in the server refuses, and returns to the login on sign-out", async () => {
    const mfa = createFakeMfa(
      { needsSecondFactor: true, factorId: "factor-1" },
      () => false,
    );
    const session = createFakeSession(null, { mfa: mfa.port });
    const server = createProbe("allowed");
    const screen = await renderGate(session, server.probe);
    await expect.element(screen.getByText(CRM_TEXT)).toBeVisible();

    // Somebody signs in from the CRM's login page; the server refuses them
    // below level 2, so the CRM gives way to the second factor.
    server.serverNowRefuses();
    session.emit("SIGNED_IN", OTHER);
    await expect
      .element(screen.getByLabelText("Código de 6 dígitos"))
      .toBeVisible();
    expect(screen.getByText(CRM_TEXT).query()).toBeNull();

    // Signing out (the screen's own control) leaves the second factor for the login.
    await screen.getByRole("button", { name: "Sair" }).click();
    await expect.poll(() => session.signOutRequests).toBe(1);
    await expect.element(screen.getByText(CRM_TEXT)).toBeVisible();
  });
});
