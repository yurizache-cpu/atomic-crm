import { UNROUTED_DELIVERIES_NOTE } from "../../../../contracts/company-os-api/index.ts";
import {
  ACCEPTED_WITHOUT_SEND_LABEL,
  COMMUNICATIONS_SCOPE_NOTE,
  OUTBOUND_AUTHORIZED_TEXT,
} from "../../copy";
import { ok } from "../../testing/fakeSession";
import { createRecordedSession, recorded } from "../../testing/recorded";
import { renderCompanyOs } from "../../testing/renderCompanyOs";

// The optional Communications status view (docs/PHASE_2C_BRIEF.md §9, §12,
// §16 "End to end"), fed with the status the real projection returned: an
// active test channel and an inactive production channel, both shown and
// neither changeable; counts only; the fixed note that unrouted deliveries are
// never stored; nothing labelled as approved or waiting to be sent, and an
// authorized record named by the operator send request that authorized it.

const rowOf = (text: string) =>
  [...document.querySelectorAll("article")].find((row) =>
    row.textContent?.includes(text),
  );

describe("the Communications status view", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("shows a test channel and an inactive production channel as labels and states only", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os/communications",
    );

    await expect
      .element(screen.getByText("Production line", { exact: true }))
      .toBeVisible();
    expect(rowOf("Synthetic test line")?.textContent).toContain("TesteAtivo");
    expect(rowOf("Production line")?.textContent).toContain("ProduçãoInativo");
    await expect
      .element(
        screen.getByText(
          "Entregas que não chegam a um canal configurado nunca são guardadas.",
        ),
      )
      .toBeVisible();
    // The server's own fixed note stays on the page, in the technical details.
    expect(document.body.textContent).toContain(UNROUTED_DELIVERIES_NOTE);
    await expect
      .element(screen.getByText(COMMUNICATIONS_SCOPE_NOTE))
      .toBeVisible();
  });

  it("shows the outbound counts without calling anything approved or waiting to be sent", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os/communications",
    );

    await expect
      .element(screen.getByLabelText("Atenção nos envios"))
      .toHaveTextContent(`${ACCEPTED_WITHOUT_SEND_LABEL}0`);
    await expect
      .element(screen.getByLabelText("Envios por situação"))
      .toHaveTextContent("Envio bloqueado1Envio falhou1Envio incerto1");
    await expect
      .element(screen.getByLabelText("Envios bloqueados por motivo"))
      .toHaveTextContent("contact not found1");
    await expect
      .element(screen.getByLabelText("Recusadas hoje por motivo"))
      .toHaveTextContent("empty body1");
    expect(document.body.textContent).not.toMatch(
      /approved|awaiting|waiting to be sent|ready to send|aprovad|aguardando (o )?envio|pront[ao] para (o )?envi/i,
    );
  });

  it("names an authorized outbound record by the operator send request that authorized it", async () => {
    // The recorded tenant has no record left in `authorized`: each of its
    // sends moved on. This is the recorded status with one count moved there.
    const session = createRecordedSession();
    const status = recorded("communication_status");
    session.answer("communication_status", () =>
      ok({
        ...status,
        outbound: { ...status.outbound, byStatus: { authorized: 1 } },
      }),
    );
    const screen = await renderCompanyOs(
      session,
      "#/company-os/communications",
    );

    await expect
      .element(screen.getByLabelText("Envios por situação"))
      .toHaveTextContent(`${OUTBOUND_AUTHORIZED_TEXT}1`);
  });
});
