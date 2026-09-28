import { render } from "vitest-browser-react";

import CompanyOsApp from "./CompanyOsApp";
import type { MfaPort, MfaStatus } from "./ports";
import {
  createFakeSession,
  ok,
  refused,
  type FakeSession,
} from "./testing/fakeSession";
import { createStopsProbe } from "./testing/probes";
import { TENANT_A, USER_A, operatorContext } from "./testing/samples";

// Production Security Gate A in the browser: the server refuses a session
// below multi-factor assurance level 2 as OS401, and the Company OS then
// completes the second factor through the provider's own factor (the MfaPort),
// or shows the plain signed-out state. Whatever the browser does, only the
// server's next answer grants access. All data synthetic; the code is fake.

const CODE = "123456";

interface FakeMfa {
  readonly port: MfaPort;
  readonly verified: string[];
  readonly enrollments: number;
}

const createFakeMfa = (
  status: MfaStatus | null,
  accepts: (code: string) => boolean,
): FakeMfa => {
  const verified: string[] = [];
  let enrollments = 0;
  return {
    verified,
    get enrollments() {
      return enrollments;
    },
    port: {
      status: async () => status,
      enrollTotp: async () => {
        enrollments += 1;
        return {
          factorId: "factor-new",
          qrCode:
            "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
          secret: "SYNTHETICKEY234567",
        };
      },
      verifyTotp: async (factorId, code) => {
        verified.push(`${factorId}:${code}`);
        return accepts(code);
      },
    },
  };
};

/** operator_context refuses (below level 2) until the test says it is met. */
const withAssurance = (session: FakeSession) => {
  let met = false;
  session.answer("operator_context", () =>
    met
      ? ok(operatorContext(TENANT_A, "Synthetic Clinic A"))
      : refused("OS401"),
  );
  return () => {
    met = true;
  };
};

const renderApp = async (session: FakeSession) => {
  history.replaceState(null, "", "#/company-os");
  const probe = createStopsProbe();
  const screen = await render(
    <CompanyOsApp
      session={session.port}
      screens={{ overview: probe.Screen }}
    />,
  );
  return { screen, probe };
};

describe("the Company OS second factor (Production Security Gate A)", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("enrols the provider's authenticator factor, and only the server's next answer opens the Company OS", async () => {
    const mfa = createFakeMfa(
      { needsSecondFactor: true, factorId: null },
      (c) => c === CODE,
    );
    const session = createFakeSession(USER_A, { mfa: mfa.port });
    const meet = withAssurance(session);
    const { screen } = await renderApp(session);

    await expect
      .element(
        screen.getByRole("heading", { name: "Verificação em duas etapas" }),
      )
      .toBeVisible();
    await screen
      .getByRole("button", { name: "Configurar o aplicativo autenticador" })
      .click();
    await expect
      .element(
        screen.getByRole("img", {
          name: "Código QR do aplicativo autenticador",
        }),
      )
      .toBeVisible();
    await expect.element(screen.getByText("SYNTHETICKEY234567")).toBeVisible();

    await screen.getByLabelText("Código de 6 dígitos").fill(CODE);
    await screen.getByRole("button", { name: "Verificar" }).click();
    await expect.poll(() => mfa.verified).toEqual([`factor-new:${CODE}`]);

    // The provider announces the stronger session; the server now answers.
    meet();
    session.emit("MFA_CHALLENGE_VERIFIED", USER_A);
    await expect
      .element(screen.getByText("Synthetic Clinic A").first())
      .toBeVisible();
  });

  it("asks an enrolled user for a code only, and a refused code opens nothing", async () => {
    const mfa = createFakeMfa(
      { needsSecondFactor: true, factorId: "factor-1" },
      () => false,
    );
    const session = createFakeSession(USER_A, { mfa: mfa.port });
    withAssurance(session);
    const { screen } = await renderApp(session);

    await expect
      .element(screen.getByLabelText("Código de 6 dígitos"))
      .toBeVisible();
    expect(mfa.enrollments).toBe(0);
    await screen.getByLabelText("Código de 6 dígitos").fill("000000");
    await screen.getByRole("button", { name: "Verificar" }).click();

    await expect.element(screen.getByRole("alert")).toBeVisible();
    expect(mfa.verified).toEqual(["factor-1:000000"]);
    await expect
      .element(
        screen.getByRole("heading", { name: "Verificação em duas etapas" }),
      )
      .toBeVisible();
  });

  it("shows the plain signed-out state when no second factor is missing, or no session is left", async () => {
    for (const status of [
      { needsSecondFactor: false, factorId: "factor-1" },
      null,
    ]) {
      const mfa = createFakeMfa(status, () => true);
      const session = createFakeSession(USER_A, { mfa: mfa.port });
      withAssurance(session);
      const { screen } = await renderApp(session);

      await expect
        .element(screen.getByRole("heading", { name: "Você saiu" }))
        .toBeVisible();
      expect(mfa.verified).toEqual([]);
      await screen.unmount();
    }
  });
});
