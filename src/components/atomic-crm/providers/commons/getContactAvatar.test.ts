import type { Contact, EmailAndType } from "../../types";
import { getContactAvatar, hash } from "./getContactAvatar";

/** The one address the stubbed Gravatar service knows about. */
const EMAIL_WITH_GRAVATAR = "anthony@marmelab.com";
const FAVICON_URL = "https://gravatar.com/favicon.ico";

const gravatarUrlFor = async (email: string) =>
  `https://www.gravatar.com/avatar/${await hash(email)}?d=404`;

/**
 * `getContactAvatar` probes Gravatar through the global `fetch`, and probes
 * the domain favicon through `fetchWithTimeout` — which is itself a thin
 * wrapper over the same global `fetch`. Stubbing `fetch` therefore makes both
 * branches deterministic with one seam, and avoids `vi.mock`, which does not
 * mock this module under the browser-mode runner (the previous version of
 * this file failed with "vi.mocked(...).mockResolvedValue is not a function"
 * for exactly that reason, and its remaining cases silently hit the network).
 *
 * The stubbed service: Gravatar has an avatar only for EMAIL_WITH_GRAVATAR,
 * and only gravatar.com serves a favicon.
 */
const stubNetwork = async () => {
  const knownGravatarUrl = await gravatarUrlFor(EMAIL_WITH_GRAVATAR);
  const fetchStub = vi.fn(
    async (input: RequestInfo | URL) =>
      ({
        ok: [knownGravatarUrl, FAVICON_URL].includes(String(input)),
      }) as Response,
  );
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
};

describe("getContactAvatar", () => {
  let fetchStub: Awaited<ReturnType<typeof stubNetwork>>;

  beforeEach(async () => {
    // Re-stubbed per test, so no `it` depends on the order it runs in.
    fetchStub = await stubNetwork();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should return gravatar URL for an email that has one", async () => {
    const email: EmailAndType[] = [
      { email: EMAIL_WITH_GRAVATAR, type: "Work" },
    ];
    const record: Partial<Contact> = { email_jsonb: email };

    const avatarUrl = await getContactAvatar(record);
    expect(avatarUrl).toBe(await gravatarUrlFor(EMAIL_WITH_GRAVATAR));
  });

  it("should return favicon URL if gravatar does not exist", async () => {
    const email: EmailAndType[] = [
      { email: "no-gravatar@gravatar.com", type: "Work" },
    ];
    const record: Partial<Contact> = { email_jsonb: email };

    const avatarUrl = await getContactAvatar(record);
    expect(avatarUrl).toBe(FAVICON_URL);
  });

  it("should not return favicon URL if not domain not allowed", async () => {
    const email: EmailAndType[] = [
      { email: "no-gravatar@gmail.com", type: "Work" },
    ];
    const record: Partial<Contact> = { email_jsonb: email };

    const avatarUrl = await getContactAvatar(record);
    expect(avatarUrl).toBeNull();
    // gmail.com is in DOMAINS_NOT_SUPPORTING_FAVICON, so the favicon branch
    // short-circuits without ever making the request.
    expect(fetchStub.mock.calls.map(([input]) => String(input))).not.toContain(
      "https://gmail.com/favicon.ico",
    );
  });

  it("should return null if no email is provided", async () => {
    const record: Partial<Contact> = {};

    const avatarUrl = await getContactAvatar(record);
    expect(avatarUrl).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("should return null if an empty array is provided", async () => {
    const email: EmailAndType[] = [];
    const record: Partial<Contact> = { email_jsonb: email };

    const avatarUrl = await getContactAvatar(record);
    expect(avatarUrl).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("should return null if email has no gravatar or validate domain", async () => {
    const email: EmailAndType[] = [
      { email: "anthony@fake-domain-marmelab.com", type: "Work" },
    ];
    const record: Partial<Contact> = { email_jsonb: email };

    const avatarUrl = await getContactAvatar(record);
    expect(avatarUrl).toBeNull();
  });

  it("should return gravatar URL for 2nd email if 1st email has no gravatar nor valid domain", async () => {
    const email: EmailAndType[] = [
      { email: "anthony@fake-domain-marmelab.com", type: "Work" },
      { email: EMAIL_WITH_GRAVATAR, type: "Work" },
    ];
    const record: Partial<Contact> = { email_jsonb: email };

    const avatarUrl = await getContactAvatar(record);
    expect(avatarUrl).toBe(await gravatarUrlFor(EMAIL_WITH_GRAVATAR));
  });
});
