import {
  CONVERSATION_HASH,
  WAITING,
  createInboxSession,
} from "../screens/inbox/inboxTesting";
import { DEFAULT_SCREENS } from "../screens/screens";
import {
  cachedOperations,
  createCacheCapture,
  goTo,
  renderCompanyOs,
} from "../testing/renderCompanyOs";
import { POLL_INTERVAL_MS } from "./queryClient";

// ADR 0026 §E, SI-87: an open conversation is read on its explicit open only,
// again every 15 s and when the tab becomes visible again while it stays
// open (never on a reconnect alone), and it leaves the in-memory cache the
// moment the member leaves it. The list never reads it.

/** Lets the fetches an interval started reach the fake port. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("the conversation read", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("is read on open, every 15 s and on a visible tab, never on a reconnect, and is dropped when the member leaves", async () => {
    const capture = createCacheCapture();
    const session = createInboxSession();
    const reads = () => session.callsOf("get_conversation").length;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const screen = await renderCompanyOs(session, CONVERSATION_HASH, {
        screens: { inbox: capture.wrap(DEFAULT_SCREENS.inbox) },
      });
      await expect.element(screen.getByText("Ana-Maria")).toBeVisible();
      expect(reads()).toBe(1);
      expect(session.callsOf("get_conversation")[0].args).toEqual({
        p_task_id: WAITING,
      });

      vi.advanceTimersByTime(POLL_INTERVAL_MS - 1);
      await settle();
      expect(reads()).toBe(1);
      vi.advanceTimersByTime(1);
      await expect.poll(reads).toBe(2);

      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("online"));
      await settle();
      expect(reads()).toBe(2);

      window.dispatchEvent(new Event("visibilitychange"));
      await expect.poll(reads).toBe(3);
      expect(cachedOperations(capture.client())).toContain("get_conversation");

      goTo("#/company-os/inbox");
      await expect
        .element(
          screen.getByRole("heading", {
            name: "Fila de atendimento",
            level: 1,
          }),
        )
        .toBeVisible();
      await expect
        .poll(() => cachedOperations(capture.client()))
        .not.toContain("get_conversation");
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 2);
      await settle();
      expect(reads()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
