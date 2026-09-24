import type { RenderResult } from "vitest-browser-react";

import { COMPANY_OS_OPERATION_NAMES } from "../../../contracts/company-os-api/index.ts";
import { NOT_FOUND_TEXT } from "../components/queryErrors";
import * as COPY from "../copy";
import { eventSentence } from "../format/ptBR";
import { STATE_UNKNOWN_AFTER_MS } from "../query/freshness";
import { DATA_BANNER_TEXT } from "../shell/DataBanner";
import { refused, type FakeSession } from "../testing/fakeSession";
import { createRecordedSession } from "../testing/recorded";
import { renderCompanyOs } from "../testing/renderCompanyOs";
import {
  ADVICE_REVIEW,
  EVERY_ROUTE,
  openAdvice,
  visit,
} from "../testing/routes";
import { WITHHELD_TEXT } from "./reviews/reviewLabels";

// docs/PHASE_2C_BRIEF.md §12 (OD-11), §7.5 and §16 (B: no trip, clear, send,
// resend, draft, channel or limit control; acceptance never presented as
// approval to send). Every page of the module is visited over the recorded
// tenant (its tabs included), then again with every answer too old to be
// current, then with every read failing, and the pages no screen owns; the
// pending review with its advice open too. Everything a person could press,
// follow or type into is collected from the live DOM on each.
//
// The two exceptions: the decision surface of an open review (S7.1), on a
// review's own page only, inside its "Registrar decisão" group, offering at
// most the three decisions; and the trip surface (S7.2), on the stops page
// only, inside its "Interromper execução" group, offering only "Interromper
// execução" for one named target at a time. Neither ever offers a clear.
// Visiting never calls an act: each needs a click and a confirmation
// (reviews/ReviewsScreen.test.tsx, stops/TripStopPanel.test.tsx).

/** The only buttons the module may render: session handling and reads. */
const READ_CONTROLS = [
  "Sair",
  "Tentar de novo",
  "Carregar mais",
  "Ver análise",
  "Ocultar análise",
];
/** The one act's controls (S7.1), allowed only inside the decision group. */
const DECISION_CONTROLS = ["Aceitar", "Precisa de ajuste", "Rejeitar"];
const DECISION_GROUP = "[role='group'][aria-label='Registrar decisão']";
const REVIEW_PAGE = /^#\/company-os\/reviews\/[0-9a-f-]{36}$/;
/** The second act's controls (S7.2): one per named target, inside the trip group. */
const TRIP_CONTROL = /^Interromper execução: \S.*$/;
const TRIP_GROUP = "[role='group'][aria-label='Interromper execução']";
const STOPS_PAGE = /^#\/company-os\/stops(\?include=cleared)?$/;

/** Causation links move the focus to an entry on the page; they read nothing. */
const FOCUS_LINK =
  /^Ir para o evento [0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** The list filters: each narrows a read. */
const FILTER_LABELS = [
  "Situação estrutural",
  "Agente",
  "Situação",
  "Atenção",
  "Atividade",
  "Disponibilidade",
];

/** The one plain anchor that leaves the module: the constant CRM root. */
const CRM_LINKS = ["#/"];
const INSIDE_THE_MODULE = /^#\/company-os(\/|\?|$)/;

/** Wording that would present a review decision as approval to send. */
const SEND_APPROVAL_WORDING =
  /approved for sending|approved to send|message approved|reply approved|draft approved|send approved|awaiting (a )?send|waiting to be sent|ready to send|(acceptance|review|decision) authori[sz]|authori[sz]ed by (the |a )?(acceptance|review|decision)|aprovad[ao] para (o )?envi|mensagem aprovada|resposta aprovada|rascunho aprovado|envio aprovado|aguardando (o )?envio|pront[ao] para (o )?envi|(aceita[çc][ãa]o|revis[ãa]o|decis[ãa]o) autoriz|autorizad[ao] pela (aceita[çc][ãa]o|revis[ãa]o|decis[ãa]o)/i;

/**
 * "authorized" appears on a page only inside the explicit wording of the
 * outbound state, or inside an event type the page prints as data
 * (communication.outbound_authorized): never on its own, where it could read
 * as "the acceptance authorized a send".
 */
const bareAuthorized = (text: string): boolean =>
  /authori[sz]|autoriz/i.test(
    text
      .replaceAll(COPY.OUTBOUND_AUTHORIZED_TEXT, "")
      .replaceAll(eventSentence("communication.outbound_authorized"), "")
      .replace(/\b[a-z_]+(\.[a-z_]+)+\b/g, ""),
  );

/** Each text node of the page on its own: a cell's text, never its neighbours'. */
const textNodes = (): string[] => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const texts: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    texts.push(node.textContent ?? "");
  }
  return texts;
};

const nameOf = (control: HTMLElement): string =>
  control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "";

const controlsOnPage = () => {
  const body = document.body;
  const pressable = [
    ...body.querySelectorAll<HTMLElement>(
      "button, [role='button'], input[type='button'], input[type='submit']",
    ),
  ];
  return {
    buttons: pressable
      .filter(
        (control) =>
          control.closest(DECISION_GROUP) === null &&
          control.closest(TRIP_GROUP) === null,
      )
      .map(nameOf),
    decisions: pressable
      .filter((control) => control.closest(DECISION_GROUP) !== null)
      .map(nameOf),
    trips: pressable
      .filter((control) => control.closest(TRIP_GROUP) !== null)
      .map(nameOf),
    links: [...body.querySelectorAll("a")].map((link) =>
      link.getAttribute("href"),
    ),
    editable: body.querySelectorAll(
      "input, textarea, [contenteditable='true'], [contenteditable='']",
    ).length,
    forms: body.querySelectorAll("form").length,
    selects: [...body.querySelectorAll("select")].map(
      (select) => select.labels?.[0]?.textContent ?? "",
    ),
  };
};

const expectReadOnly = (where: string) => {
  const controls = controlsOnPage();
  expect(
    controls.buttons.filter(
      (name) => !READ_CONTROLS.includes(name) && !FOCUS_LINK.test(name),
    ),
    `buttons on ${where}`,
  ).toEqual([]);
  // The decision surface: on a review's own page only, the three decisions
  // at most, and no confirmation is open until a person asks for one.
  expect(
    controls.decisions.filter(
      (name) =>
        !DECISION_CONTROLS.includes(name) ||
        !REVIEW_PAGE.test(window.location.hash),
    ),
    `decision controls on ${where}`,
  ).toEqual([]);
  // The trip surface: on the stops page only, one "Interromper execução" per
  // named target, and never a clear or a resume.
  expect(
    controls.trips.filter(
      (name) =>
        !TRIP_CONTROL.test(name) || !STOPS_PAGE.test(window.location.hash),
    ),
    `trip controls on ${where}`,
  ).toEqual([]);
  expect(
    [...controls.buttons, ...controls.decisions, ...controls.trips].filter(
      (name) =>
        /encerrar|retomar|remover|desfazer|liberar|clear|resume/i.test(name),
    ),
    `a clear or resume control on ${where}`,
  ).toEqual([]);
  expect(
    document.querySelectorAll("[role='alertdialog']").length,
    `an open confirmation on ${where}`,
  ).toBe(0);
  expect(
    controls.links.filter(
      (href) =>
        href === null ||
        !(INSIDE_THE_MODULE.test(href) || CRM_LINKS.includes(href)),
    ),
    `links on ${where}`,
  ).toEqual([]);
  expect(controls.editable, `text fields on ${where}`).toBe(0);
  expect(controls.forms, `forms on ${where}`).toBe(0);
  expect(
    controls.selects.filter((label) => !FILTER_LABELS.includes(label)),
    `selects on ${where}`,
  ).toEqual([]);
  const text = document.body.textContent ?? "";
  expect(text, `text on ${where}`).not.toMatch(SEND_APPROVAL_WORDING);
  expect(
    textNodes().filter(bareAuthorized),
    `a bare "authorized" on ${where}`,
  ).toEqual([]);
};

/** Every page, then the pending review with its advice open. */
const sweep = async (
  screen: RenderResult,
  onEachPage: (where: string) => void,
) => {
  for (const route of EVERY_ROUTE) {
    await visit(screen, route);
    onEachPage(route.hash);
  }
  const pending = EVERY_ROUTE.find((route) =>
    route.hash.endsWith(ADVICE_REVIEW),
  );
  await visit(screen, pending!);
  await openAdvice(screen);
  onEachPage("the opened advice");
};

/** A sweep visits every page, some twice: far longer than one read. */
const SWEEP_TIMEOUT_MS = 90_000;

const operationsCalled = (session: FakeSession) =>
  [...new Set(session.calls.map((call) => call.operation))].sort();

/** Navigates to `hash` and waits for the page's h1. */
const reach = async (screen: RenderResult, hash: string, heading: string) => {
  if (window.location.hash !== hash) window.location.hash = hash;
  await expect
    .element(screen.getByRole("heading", { name: heading, level: 1 }))
    .toBeVisible();
};

describe("the Company OS screens are read-only, except the review decision and the trip", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it(
    "no page, tab or opened advice renders a clear, send, draft or configuration control, only an open review offers its decisions and only the stops page its trips, and no link leaves the module except to the CRM",
    async () => {
      const session = createRecordedSession();
      const screen = await renderCompanyOs(session, EVERY_ROUTE[0].hash);

      await sweep(screen, expectReadOnly);

      await expect.element(screen.getByText(DATA_BANNER_TEXT)).toBeVisible();
      expect(session.unmatched).toEqual([]);
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    "no page offers a control once its answer is too old to be current",
    async () => {
      let skew = 0;
      const screen = await renderCompanyOs(
        createRecordedSession(),
        EVERY_ROUTE[0].hash,
        { clock: () => Date.now() + skew },
      );

      const unknown: string[] = [];
      for (const route of EVERY_ROUTE) {
        skew = 0;
        await visit(screen, route);
        skew = STATE_UNKNOWN_AFTER_MS + 1_000;
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        expectReadOnly(`${route.hash} once stale`);
        if (document.body.textContent?.includes(COPY.STATE_UNKNOWN_NOTE)) {
          unknown.push(route.hash);
        }
      }
      // The pages that show live state did turn "unknown".
      expect(unknown).toEqual(
        expect.arrayContaining([
          "#/company-os",
          "#/company-os/agents",
          "#/company-os/runs",
          "#/company-os/tasks",
        ]),
      );
    },
    SWEEP_TIMEOUT_MS,
  );

  it(
    "no page offers more than a retry when every read fails",
    async () => {
      const session = createRecordedSession();
      for (const operation of COMPANY_OS_OPERATION_NAMES) {
        if (operation !== "operator_context") {
          session.answer(operation, () => refused("OS500"));
        }
      }
      const screen = await renderCompanyOs(session, EVERY_ROUTE[0].hash);

      for (const route of EVERY_ROUTE) {
        await reach(screen, route.hash, route.heading);
        await expect
          .element(
            screen.getByRole("button", { name: "Tentar de novo" }).first(),
          )
          .toBeVisible();
        expectReadOnly(`${route.hash} failing`);
      }
    },
    SWEEP_TIMEOUT_MS,
  );

  it("the pages no screen owns and a malformed record id offer nothing but links back", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os/no-such-screen",
    );
    await expect
      .element(screen.getByRole("heading", { name: "Página não encontrada" }))
      .toBeVisible();
    expectReadOnly("an unknown page");

    await reach(screen, "#/company-os/tasks/not-a-uuid", "Tarefa");
    await expect.element(screen.getByText(NOT_FOUND_TEXT)).toBeVisible();
    expectReadOnly("a malformed record id");
  });

  it(
    "calls only the 15 catalogued read operations, each of them somewhere, and never an act while visiting",
    async () => {
      const session = createRecordedSession();
      const screen = await renderCompanyOs(session, EVERY_ROUTE[0].hash);

      await sweep(screen, () => {});

      expect(COMPANY_OS_OPERATION_NAMES).toHaveLength(15);
      expect(operationsCalled(session)).toEqual(
        [...COMPANY_OS_OPERATION_NAMES].sort(),
      );
      expect(operationsCalled(session)).not.toContain("decide_review");
      expect(operationsCalled(session)).not.toContain("trip_stop");
    },
    SWEEP_TIMEOUT_MS,
  );

  it("no fixed text of the module presents a review decision as approval to send, or says authorized on its own", () => {
    const texts = [
      ...(Object.values(COPY) as unknown[]).filter(
        (value): value is string => typeof value === "string",
      ),
      ...COPY.DECISION_ACTIONS.map((action) => action.label),
      ...Object.values(COPY.DECISION_CONFIRM_TITLE),
      ...Object.values(COPY.TRIP_CONFIRM_TITLE),
      ...Object.values(WITHHELD_TEXT),
      DATA_BANNER_TEXT,
    ];

    for (const text of texts) {
      expect(text).not.toMatch(SEND_APPROVAL_WORDING);
      expect(bareAuthorized(text), text).toBe(false);
    }
    expect(COPY.REVIEW_NOT_A_SEND_NOTE).toBe(
      "Registrar uma decisão nunca aprova nem envia uma resposta.",
    );
    expect(COPY.OUTBOUND_AUTHORIZED_TEXT).toBe(
      "envio autorizado por um pedido de envio do operador",
    );
  });
});
