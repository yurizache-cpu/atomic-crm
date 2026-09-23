import { render } from "vitest-browser-react";

import CompanyOsApp from "./CompanyOsApp";
import { DATA_BANNER_TEXT } from "./shell/DataBanner";
import {
  createFakeSession,
  ok,
  refused,
  type FakeSession,
} from "./testing/fakeSession";
import { cachedText, createStopsProbe } from "./testing/probes";
import { createRecordedSession } from "./testing/recorded";
import { renderCompanyOs } from "./testing/renderCompanyOs";
import {
  TENANT_A,
  TENANT_B,
  USER_A,
  USER_B,
  operatorContext,
  stopList,
  syntheticId,
} from "./testing/samples";

// The session rules of docs/PHASE_2C_BRIEF.md §6.2 (OD-10), through the real
// shell, adapter, contracts and query client, with a fake SessionPort: the
// first call is always operator_context; no session is signed out and calls
// nothing; a refused operator_context is "no access" and nothing else is
// read; a later OS401 clears the cache and signs out; a later OS403 clears it
// and reads operator_context again; every data answer is kept only once a
// later operator_context confirms the tenant and principal it is shown under
// (session/generation.ts), so a call sequence reads data, then
// operator_context; an explicit sign-out stays final for the mount. All data
// is synthetic.

const REVIEW_DEEP_LINK = `#/company-os/reviews/${syntheticId(7)}`;

/** Long enough for any query a render would start to have been sent. */
const outlastStrayQueries = () =>
  new Promise((resolve) => setTimeout(resolve, 150));

const operations = (session: FakeSession) =>
  session.calls.map((call) => call.operation);

/** Answers `operation` with each response in turn, repeating the last. */
const inTurn =
  (...responses: ReturnType<typeof ok>[]) =>
  () =>
    responses.length > 1 ? responses.shift()! : responses[0];

const signedInAsA = (): FakeSession => {
  const session = createFakeSession(USER_A);
  session.answer("operator_context", () =>
    ok(operatorContext(TENANT_A, "Synthetic Clinic A")),
  );
  return session;
};

const renderShell = async (
  session: FakeSession,
  { hash = "#/company-os", probe = createStopsProbe() } = {},
) => {
  history.replaceState(null, "", hash);
  const screen = await render(
    <CompanyOsApp
      session={session.port}
      screens={{ overview: probe.Screen }}
    />,
  );
  return { screen, probe };
};

describe("the Company OS session lifecycle", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("renders the signed-out state and calls nothing without a session, even on a deep link", async () => {
    const session = createFakeSession(null);

    const { screen } = await renderShell(session, { hash: REVIEW_DEEP_LINK });

    await expect
      .element(screen.getByRole("heading", { name: "Signed out" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Sign in through the CRM" }))
      .toHaveAttribute("href", "#/");
    await expect.element(screen.getByText(DATA_BANNER_TEXT)).toBeVisible();
    await outlastStrayQueries();
    expect(session.calls).toEqual([]);
  });

  it("renders no access and reads nothing else when operator_context is refused", async () => {
    const session = createFakeSession(USER_A);
    session.answer("operator_context", () => refused("OS403"));

    const { screen } = await renderShell(session, { hash: REVIEW_DEEP_LINK });

    await expect
      .element(screen.getByRole("heading", { name: "No Company OS access" }))
      .toBeVisible();
    await outlastStrayQueries();
    expect(session.calls.map((call) => call.operation)).toEqual([
      "operator_context",
    ]);
    expect(
      screen.getByRole("navigation", { name: "Company OS" }).query(),
    ).toBeNull();
  });

  it("shows the tenant, the data policy and the role enum, and nothing about the person", async () => {
    const session = signedInAsA();
    session.answer("list_stops", () => ok(stopList("Synthetic stop")));

    const { screen } = await renderShell(session);

    const header = screen.getByRole("definition");
    await expect.element(screen.getByText("Synthetic Clinic A")).toBeVisible();
    await expect
      .element(screen.getByText("Synthetic or test data only"))
      .toBeVisible();
    await expect.element(screen.getByText("tenant_operator")).toBeVisible();
    expect(header.elements()).toHaveLength(3);
    expect(session.calls[0].operation).toBe("operator_context");
  });

  it("clears the cache and signs out when a later read answers OS401", async () => {
    const session = signedInAsA();
    session.answer(
      "list_stops",
      inTurn(ok(stopList("Sentinel stop before expiry")), refused("OS401")),
    );
    const { screen, probe } = await renderShell(session);
    await expect
      .element(screen.getByText("Sentinel stop before expiry"))
      .toBeVisible();

    await screen.getByRole("button", { name: "Read stops again" }).click();

    await expect
      .element(screen.getByRole("heading", { name: "Signed out" }))
      .toBeVisible();
    expect(probe.client().getQueryCache().getAll()).toEqual([]);
  });

  it("clears the cache and reads operator_context again when a later read answers OS403", async () => {
    const session = signedInAsA();
    session.answer(
      "list_stops",
      inTurn(
        ok(stopList("Sentinel stop before the refusal")),
        refused("OS403"),
        ok(stopList("Stop after the re-read")),
      ),
    );
    const { screen, probe } = await renderShell(session);
    await expect
      .element(screen.getByText("Sentinel stop before the refusal"))
      .toBeVisible();

    await screen.getByRole("button", { name: "Read stops again" }).click();

    await expect
      .element(screen.getByText("Stop after the re-read"))
      .toBeVisible();
    // Gate, read, confirmation; the refused read; then a new epoch: gate
    // again, the read again, its confirmation.
    expect(operations(session)).toEqual([
      "operator_context",
      "list_stops",
      "operator_context",
      "list_stops",
      "operator_context",
      "list_stops",
      "operator_context",
    ]);
    expect(cachedText(probe.client())).not.toContain("before the refusal");
  });

  it("stops at no access when a read is refused again right after the re-read", async () => {
    const session = signedInAsA();
    session.answer(
      "list_stops",
      inTurn(ok(stopList("Synthetic stop")), refused("OS403")),
    );
    const { screen, probe } = await renderShell(session);
    await expect.element(screen.getByText("Synthetic stop")).toBeVisible();

    await screen.getByRole("button", { name: "Read stops again" }).click();

    await expect
      .element(screen.getByRole("heading", { name: "No Company OS access" }))
      .toBeVisible();
    await outlastStrayQueries();
    // Gate, read, confirmation; the refused read; one re-read of the gate;
    // the read refused again, and nothing after it.
    expect(operations(session)).toEqual([
      "operator_context",
      "list_stops",
      "operator_context",
      "list_stops",
      "operator_context",
      "list_stops",
    ]);
    expect(probe.client().getQueryCache().getAll()).toEqual([]);
  });

  it("re-reads operator_context once, then stops at no access, when one read of a screen is refused and answers after the others", async () => {
    const session = createRecordedSession();
    session.answer(
      "list_agents",
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(refused("OS403")), 30),
        ),
    );

    const screen = await renderCompanyOs(session, "#/company-os/tasks");

    await expect
      .element(screen.getByRole("heading", { name: "No Company OS access" }))
      .toBeVisible();
    await expect
      .element(screen.getByText(/refused again right after access was checked/))
      .toBeVisible();
    await outlastStrayQueries();
    await outlastStrayQueries();
    // Each epoch: its gate, and one confirmation of the list_tasks answer
    // (list_agents is refused 30 ms later, so it is never confirmed). Two
    // epochs: one re-read, then no access.
    expect(session.callsOf("operator_context")).toHaveLength(4);
    expect(session.callsOf("list_agents")).toHaveLength(2);
    expect(session.callsOf("list_tasks")).toHaveLength(2);
  });

  it("clears the cache and reads operator_context for the new user when the user changes", async () => {
    const session = createFakeSession(USER_A);
    session.answer("operator_context", () =>
      ok(operatorContext(TENANT_A, "Synthetic Clinic A")),
    );
    session.answer("list_stops", () => ok(stopList("Sentinel stop of user A")));
    const { screen, probe } = await renderShell(session);
    await expect
      .element(screen.getByText("Sentinel stop of user A"))
      .toBeVisible();

    session.answer("operator_context", () =>
      ok(operatorContext(TENANT_B, "Synthetic Clinic B")),
    );
    session.answer("list_stops", () => ok(stopList("Stop of user B")));
    session.emit("SIGNED_IN", USER_B);

    await expect.element(screen.getByText("Stop of user B")).toBeVisible();
    await expect.element(screen.getByText("Synthetic Clinic B")).toBeVisible();
    const cached = cachedText(probe.client());
    expect(cached).not.toContain("Sentinel stop of user A");
    expect(cached).not.toContain(USER_A.userId);
  });

  it("clears the cache before it ends the session when the operator signs out", async () => {
    const session = signedInAsA();
    session.answer("list_stops", () => ok(stopList("Sentinel stop")));
    const { screen, probe } = await renderShell(session);
    await expect.element(screen.getByText("Sentinel stop")).toBeVisible();
    let cachedAtSignOut: number | undefined;
    session.onSignOut(() => {
      cachedAtSignOut = probe.client().getQueryCache().getAll().length;
    });

    await screen.getByRole("button", { name: "Sign out" }).click();

    await expect
      .element(screen.getByRole("heading", { name: "Signed out" }))
      .toBeVisible();
    expect(session.signOutRequests).toBe(1);
    expect(cachedAtSignOut).toBe(0);
  });

  it("stays signed out, and says so, when the server does not end the session", async () => {
    const session = signedInAsA();
    session.answer("list_stops", () => ok(stopList("Sentinel stop")));
    const { screen, probe } = await renderShell(session);
    await expect.element(screen.getByText("Sentinel stop")).toBeVisible();
    session.onSignOut(() => {
      throw new Error("synthetic network failure");
    });

    await screen.getByRole("button", { name: "Sign out" }).click();

    await expect
      .element(screen.getByText(/the session may still be active in the CRM/))
      .toBeVisible();
    expect(probe.client().getQueryCache().getAll()).toEqual([]);
  });

  it("stays signed out after a sign-out the server refused, whatever the session reports for the same person, until a new person signs in", async () => {
    const session = signedInAsA();
    session.answer("list_stops", () => ok(stopList("Sentinel stop")));
    const { screen } = await renderShell(session);
    await expect.element(screen.getByText("Sentinel stop")).toBeVisible();
    session.onSignOut(() => {
      throw new Error("synthetic network failure");
    });
    await screen.getByRole("button", { name: "Sign out" }).click();
    await expect
      .element(screen.getByText(/the session may still be active in the CRM/))
      .toBeVisible();
    const callsAtSignOut = session.calls.length;

    session.emit("TOKEN_REFRESHED", USER_A);
    session.emit("SIGNED_IN", USER_A);
    session.emit("USER_UPDATED", USER_A);
    await outlastStrayQueries();

    await expect
      .element(screen.getByRole("heading", { name: "Signed out" }))
      .toBeVisible();
    expect(screen.getByText("Sentinel stop").query()).toBeNull();
    expect(session.calls).toHaveLength(callsAtSignOut);

    session.answer("operator_context", () =>
      ok(operatorContext(TENANT_B, "Synthetic Clinic B")),
    );
    session.emit("SIGNED_IN", USER_B);

    await expect.element(screen.getByText("Synthetic Clinic B")).toBeVisible();
  });

  it("never shows a data answer produced after the membership moved under the old tenant's name, and reads it again for the new tenant", async () => {
    // The server moves the member's membership to tenant B between the stops
    // read and its confirmation: the answer was B's, the page still says A.
    const session = createFakeSession(USER_A);
    let tenant: "A" | "B" = "A";
    session.answer("operator_context", () =>
      ok(
        tenant === "A"
          ? operatorContext(TENANT_A, "Synthetic Clinic A")
          : operatorContext(TENANT_B, "Synthetic Clinic B"),
      ),
    );
    session.answer("list_stops", () =>
      ok(stopList(tenant === "A" ? "Stop of tenant A" : "Stop of tenant B")),
    );
    const { screen } = await renderShell(session);
    await expect.element(screen.getByText("Stop of tenant A")).toBeVisible();
    const mixed: string[] = [];
    const watch = new MutationObserver(() => {
      const text = document.body.textContent ?? "";
      if (text.includes("Stop of tenant B") && text.includes("Clinic A")) {
        mixed.push(text);
      }
    });
    watch.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });

    tenant = "B";
    await screen.getByRole("button", { name: "Read stops again" }).click();

    await expect.element(screen.getByText("Stop of tenant B")).toBeVisible();
    await expect.element(screen.getByText("Synthetic Clinic B")).toBeVisible();
    watch.disconnect();
    expect(mixed).toEqual([]);
    expect(screen.getByText("Stop of tenant A").query()).toBeNull();
  });

  it("retries an operator_context that failed on the server once, then offers to try again", async () => {
    const session = createFakeSession(USER_A);
    session.answer("operator_context", () => refused("OS500"));

    const { screen } = await renderShell(session);

    await expect
      .element(screen.getByRole("heading", { name: "Company OS unavailable" }))
      .toBeVisible();
    expect(session.callsOf("operator_context")).toHaveLength(2);

    session.answer("operator_context", () =>
      ok(operatorContext(TENANT_A, "Synthetic Clinic A")),
    );
    session.answer("list_stops", () => ok(stopList("Synthetic stop")));
    await screen.getByRole("button", { name: "Try again" }).click();

    await expect.element(screen.getByText("Synthetic Clinic A")).toBeVisible();
  });

  it("renders an operator_context that broke its contract as an error, not as the value", async () => {
    const session = createFakeSession(USER_A);
    session.answer("operator_context", () =>
      ok({
        ...operatorContext(TENANT_A, "Sentinel Clinic Name"),
        displayName: "Synthetic Person",
      }),
    );

    const { screen } = await renderShell(session);

    await expect
      .element(screen.getByRole("heading", { name: "Company OS unavailable" }))
      .toBeVisible();
    expect(screen.getByText("Sentinel Clinic Name").query()).toBeNull();
    expect(screen.getByText("Synthetic Person").query()).toBeNull();
    expect(session.callsOf("operator_context")).toHaveLength(1);
  });

  it("clears the cache when the Company OS unmounts", async () => {
    const session = signedInAsA();
    session.answer("list_stops", () => ok(stopList("Sentinel stop")));
    const { screen, probe } = await renderShell(session);
    await expect.element(screen.getByText("Sentinel stop")).toBeVisible();

    await screen.unmount();

    expect(probe.client().getQueryCache().getAll()).toEqual([]);
  });
});
