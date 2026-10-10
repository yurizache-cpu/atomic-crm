import { render } from "vitest-browser-react";

import type { MfaPort } from "../ports";
import { TotpCodeForm } from "./SecondFactorFlow";

// The provider's code form, as the browser inbox's reply reuses it (ADR 0026
// §E): `onVerified` runs once for a code the provider verified, and never for
// a refused one or a failed check, which keep the form and say so. All data
// synthetic; the code is fake.

const CODE = "246810";

const fakeMfa = (
  verify: (code: string) => Promise<boolean>,
): MfaPort & { readonly verified: string[] } => {
  const verified: string[] = [];
  return {
    verified,
    status: async () => ({ needsSecondFactor: false, factorId: "factor-1" }),
    enrollTotp: async () => {
      throw new Error("not used");
    },
    verifyTotp: async (factorId, code) => {
      verified.push(`${factorId}:${code}`);
      return verify(code);
    },
  };
};

const submit = async (
  screen: Awaited<ReturnType<typeof render>>,
  code: string,
) => {
  await screen.getByLabelText("Código de 6 dígitos").fill(code);
  await screen.getByRole("button", { name: "Verificar" }).click();
};

describe("the authenticator code form", () => {
  it("calls onVerified once for a verified code", async () => {
    const mfa = fakeMfa(async (code) => code === CODE);
    let calls = 0;
    const screen = await render(
      <TotpCodeForm
        mfa={mfa}
        factorId="factor-1"
        onVerified={() => {
          calls += 1;
        }}
      />,
    );

    await submit(screen, CODE);

    await expect.poll(() => calls).toBe(1);
    expect(mfa.verified).toEqual([`factor-1:${CODE}`]);
    expect(screen.getByRole("alert").elements()).toHaveLength(0);
  });

  it("never calls onVerified for a refused code or a failed check, and says the code was not accepted", async () => {
    let failing = false;
    const mfa = fakeMfa(async () => {
      if (failing) throw new Error("synthetic provider failure");
      return false;
    });
    let calls = 0;
    const screen = await render(
      <TotpCodeForm
        mfa={mfa}
        factorId="factor-1"
        onVerified={() => {
          calls += 1;
        }}
      />,
    );

    await submit(screen, "111111");
    await expect
      .element(screen.getByText(/O código não foi aceito/))
      .toBeVisible();
    failing = true;
    await submit(screen, "222222");
    await expect.poll(() => mfa.verified).toHaveLength(2);
    await expect
      .element(screen.getByText(/O código não foi aceito/))
      .toBeVisible();

    expect(calls).toBe(0);
  });
});
