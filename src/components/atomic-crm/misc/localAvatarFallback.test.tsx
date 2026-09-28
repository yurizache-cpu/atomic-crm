import { RecordContextProvider } from "ra-core";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { CompanyAvatar } from "../companies/CompanyAvatar";
import { Avatar } from "../contacts/Avatar";
import type { Company, Contact } from "../types";

// Production Security Gate A.1 removed every automatic avatar and favicon
// lookup: nothing derives a picture from an email or a website, so a contact or
// company without a stored one must show a local mark, and never a request.
// All data synthetic.

describe("a contact or company with no stored picture (Production Security Gate A.1)", () => {
  it("shows the contact's initials, and requests no image", async () => {
    const contact = {
      id: 1,
      first_name: "Ada",
      last_name: "Lovelace",
      email_jsonb: [{ email: "ada@example.test", type: "Work" }],
    } as unknown as Contact;

    const screen = await render(
      <RecordContextProvider value={contact}>
        <Avatar />
      </RecordContextProvider>,
    );

    await expect.element(screen.getByText("AL")).toBeVisible();
    expect(document.querySelector("img")).toBeNull();
  });

  it("shows the company's first letter, and requests no image", async () => {
    const company = {
      id: 1,
      name: "Synthetic Company",
      website: "https://synthetic.example.test",
    } as unknown as Company;

    const screen = await render(
      <RecordContextProvider value={company}>
        <CompanyAvatar />
      </RecordContextProvider>,
    );

    await expect.element(screen.getByText("S")).toBeVisible();
    expect(document.querySelector("img")).toBeNull();
  });

  it("keeps a stored picture as it was stored", async () => {
    const company = {
      id: 2,
      name: "Stored Logo Company",
      logo: {
        src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        title: "x",
      },
    } as unknown as Company;

    await render(
      <RecordContextProvider value={company}>
        <CompanyAvatar />
      </RecordContextProvider>,
    );

    await expect
      .poll(() => document.querySelector("img")?.getAttribute("src"))
      .toBe(
        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      );
  });
});
