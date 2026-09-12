import { useGetList } from "ra-core";
import { MemoryRouter } from "react-router";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  buildContact,
  createCrmDb,
  createTestAuthProvider,
} from "@/test/StoryWrapper";
import { testI18nProvider } from "../providers/commons/i18nProvider";
import { createDataProvider } from "../providers/fakerest";
import { QUERY_CACHE_STORAGE_KEY } from "../providers/queryCacheKey";
import type { Contact, ContactNote, LeadProfile } from "../types";
import { CRM } from "./CRM";

// Regression tests for the closure of SEC-1BS-01 (docs/SECURITY_AUDIT_1BS_REPORT.md).
//
// The mobile app used to persist its whole React Query cache to localStorage:
// every contact, note, email address and do_not_contact flag the user had
// viewed, for 24 hours, across browser restarts. The persister is gone. These
// tests hold the property it violated where it actually matters — in browser
// storage, after the REAL <CRM> root has loaded clinic-shaped records through
// its own query client — rather than by checking that some import is absent.
// `authProvider.security.test.ts` keeps covering logout.

const PATIENT_NAME = "Sentinelpatient";
const PATIENT_EMAIL = "sentinel.patient@clinic.invalid";
const NOTE_BODY = "Sentinel session note: reports panic attacks at work";
// A serialised lead profile carries its consent flag under this field name.
const CONSENT_FIELD = "do_not_contact";
const SENTINELS = [PATIENT_NAME, PATIENT_EMAIL, NOTE_BODY, CONSENT_FIELD];

// What may remain in storage, and why none of it is CRM response data:
//   RaStoreCRM.*  ra-core's preference store: theme, sidebar and column state,
//                 saved list filters, and the tenant's configuration vocabulary.
//   user          the FakeRest DEMO auth provider's signed-in user. The Supabase
//                 build has no such key.
// Keys are checked as well as content: a persister that compressed or
// encrypted the cache would sail straight past a plain-text search.
const PERMITTED_KEYS = [/^RaStoreCRM\./, /^user$/];

// createAsyncStoragePersister writes on a throttle (1000 ms by default). The
// tests wait past it before reading storage, so a persister cannot pass merely
// by not having written yet. Measured by mutation, a restored persister had
// already written by the time the records rendered: the wait is a margin for a
// slower machine, not what makes the test sensitive. Restoring the persister
// turns the mobile case red with or without it.
const PERSISTER_THROTTLE_MS = 1000;
const outlastPersisterThrottle = () =>
  new Promise((resolve) => setTimeout(resolve, PERSISTER_THROTTLE_MS * 2));

const clinicDb = () =>
  createCrmDb({
    contacts: [
      buildContact({
        id: 1,
        first_name: PATIENT_NAME,
        email_jsonb: [{ email: PATIENT_EMAIL, type: "Work" }],
      }),
    ],
    contact_notes: [
      {
        id: 1,
        contact_id: 1,
        text: NOTE_BODY,
        date: "2026-09-01T10:00:00.000Z",
        sales_id: 0,
        status: "warm",
      },
    ],
    lead_profiles: [
      {
        id: 1,
        contact_id: 1,
        acquired_at: "2026-08-01T10:00:00.000Z",
        operational_status: "paused",
        do_not_contact: true,
        created_at: "2026-08-01T10:00:00.000Z",
        updated_at: "2026-09-01T10:00:00.000Z",
      },
    ],
  });

/** Stands in for any screen: it views the records through the app's own query client. */
const ViewsClinicalRecords = () => {
  const { data: contacts } = useGetList<Contact>("contacts");
  const { data: notes } = useGetList<ContactNote>("contact_notes");
  const { data: leads } = useGetList<LeadProfile>("lead_profiles");

  if (!contacts?.length || !notes?.length || !leads?.length) {
    return <p>Loading records</p>;
  }
  return (
    <section aria-label="Viewed records">
      <p>{contacts[0].first_name}</p>
      <p>{contacts[0].email_jsonb[0].email}</p>
      <p>{notes[0].text}</p>
      <p>{leads[0].do_not_contact ? "Do not contact" : "Contactable"}</p>
    </section>
  );
};

// No `store` and no `layout`: the real localStorage-backed store and the real
// layouts, so what lands in storage is what the shipped app would write.
const renderCrm = () =>
  render(
    <MemoryRouter>
      <CRM
        dataProvider={createDataProvider({
          db: clinicDb(),
          silent: true,
          latency: 0,
        })}
        authProvider={createTestAuthProvider()}
        i18nProvider={testI18nProvider}
        dashboard={ViewsClinicalRecords}
        disableTelemetry
      />
    </MemoryRouter>,
  );

const storedEntries = () =>
  (
    [
      ["localStorage", window.localStorage],
      ["sessionStorage", window.sessionStorage],
    ] as const
  ).flatMap(([area, storage]) =>
    Object.keys(storage).map((key) => ({
      area,
      key,
      value: storage.getItem(key) ?? "",
    })),
  );

const storedText = () =>
  storedEntries()
    .map(({ area, key, value }) => `${area}:${key}=${value}`)
    .join("\n");

describe("viewing CRM records leaves none of them in browser storage", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it.each([
    { app: "mobile", width: 375, height: 812 },
    { app: "desktop", width: 1600, height: 900 },
  ])(
    "the $app app keeps contacts, notes, emails and consent state out of storage",
    async ({ app, width, height }) => {
      await page.viewport(width, height);

      const screen = await renderCrm();
      await expect.element(screen.getByText(NOTE_BODY)).toBeVisible();
      await expect.element(screen.getByText(PATIENT_EMAIL)).toBeVisible();
      await expect.element(screen.getByText("Do not contact")).toBeVisible();
      // The two apps are different trees with different query clients, and the
      // persister lived in only one of them. Prove which tree is mounted, not
      // just how wide the viewport is: only MobileLayout renders this navigation.
      const mobileNavigation = screen.getByRole("navigation", {
        name: "CRM navigation",
      });
      if (app === "mobile") {
        await expect.element(mobileNavigation).toBeVisible();
      } else {
        expect(mobileNavigation.query()).toBeNull();
      }
      await outlastPersisterThrottle();

      const stored = storedText();
      for (const sentinel of SENTINELS) {
        expect(stored, `"${sentinel}" reached browser storage`).not.toContain(
          sentinel,
        );
      }
      const unexpectedKeys = storedEntries()
        .filter(
          ({ key }) => !PERMITTED_KEYS.some((allowed) => allowed.test(key)),
        )
        .map(({ area, key }) => `${area}:${key}`);
      expect(unexpectedKeys).toEqual([]);
    },
  );

  it("purges a cache that an earlier build left on the device", async () => {
    localStorage.setItem(
      QUERY_CACHE_STORAGE_KEY,
      JSON.stringify({
        clientState: {
          queries: [
            {
              queryKey: ["contacts", "getList"],
              state: {
                data: {
                  data: [
                    {
                      first_name: PATIENT_NAME,
                      email_jsonb: [{ email: PATIENT_EMAIL }],
                    },
                  ],
                },
              },
            },
          ],
        },
      }),
    );
    await page.viewport(375, 812);

    await renderCrm();

    await expect
      .poll(() => localStorage.getItem(QUERY_CACHE_STORAGE_KEY))
      .toBeNull();
    expect(storedText()).not.toContain(PATIENT_EMAIL);
  });

  it("still starts when the browser refuses access to storage", async () => {
    // Site data disabled or a sandboxed frame: the startup purge must not take
    // the application down with it.
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    await page.viewport(375, 812);

    const screen = await renderCrm();

    await expect.element(screen.getByText(NOTE_BODY)).toBeVisible();
  });
});
