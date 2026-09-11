import { composeStories } from "@storybook/react-vite";
import { render } from "vitest-browser-react";
import * as stories from "./NoteInputsMobile.stories";

const { Default, WithAttachmentDefault, WithSelectContact } =
  composeStories(stories);

describe("NoteInputsMobile", () => {
  it("renders the note textarea", async () => {
    const screen = await render(<Default />);

    await expect.element(screen.getByPlaceholder("Add a note")).toBeVisible();
  });

  it("does not offer an attachment control", async () => {
    // File uploads are disabled in the clinical profile, so the mobile note
    // form must not offer a way to attach one.
    const screen = await render(<Default />);

    await expect
      .element(screen.getByRole("button", { name: "Attach document" }))
      .not.toBeInTheDocument();
    await expect
      .poll(() => screen.container.querySelector('input[type="file"]'))
      .toBeNull();
  });

  it("does not render the contact selector by default", async () => {
    const screen = await render(<Default />);

    await expect.element(screen.getByText("Contact")).not.toBeInTheDocument();
  });

  it("renders the contact selector when selectContact is true", async () => {
    const screen = await render(<WithSelectContact />);

    await expect.element(screen.getByText("Contact")).toBeVisible();
  });

  it("shows a validation error when submitting an empty note", async () => {
    const screen = await render(<Default />);

    await screen.getByRole("button", { name: "Save" }).click();

    await expect
      .element(screen.getByText("A commercial note is required"))
      .toBeVisible();
  });

  it("treats whitespace-only note text as empty", async () => {
    const screen = await render(<Default />);

    await screen.getByPlaceholder("Add a note").fill("   ");
    await screen.getByRole("button", { name: "Save" }).click();

    await expect
      .element(screen.getByText("A commercial note is required"))
      .toBeVisible();
  });

  it("allows submitting a note with text only", async () => {
    const screen = await render(<Default />);

    await screen.getByPlaceholder("Add a note").fill("Call summary");
    await screen.getByRole("button", { name: "Save" }).click();

    await expect
      .element(screen.getByText("A commercial note is required"))
      .not.toBeInTheDocument();
  });

  it("still requires text when an attachment is present", async () => {
    // An attachment used to satisfy the validator on its own. It no longer
    // does, and nothing in the form can create one — this pins that change
    // so a future edit cannot quietly restore the escape hatch.
    const screen = await render(<WithAttachmentDefault />);

    await screen.getByRole("button", { name: "Save" }).click();

    await expect
      .element(screen.getByText("A commercial note is required"))
      .toBeVisible();
  });
});
