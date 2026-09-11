import { composeStories } from "@storybook/react-vite";
import { render } from "vitest-browser-react";
import * as stories from "./NoteInputs.stories";
import { NoteInputsStory } from "./NoteInputs.stories";

const { Default, WithAttachmentDefault, WithSaveButton } =
  composeStories(stories);

describe("NoteInputs", () => {
  it("renders the note textarea", async () => {
    const screen = await render(<Default />);

    await expect.element(screen.getByPlaceholder("Add a note")).toBeVisible();
  });

  it("shows the 'Show options' button on desktop when displayMore is false", async () => {
    const screen = await render(<Default />);

    await expect
      .element(screen.getByRole("button", { name: "Show options" }))
      .toBeVisible();
  });

  it("reveals the extra options section after clicking 'Show options'", async () => {
    const screen = await render(<Default />);

    const showOptionsButton = screen.getByRole("button", {
      name: "Show options",
    });
    await showOptionsButton.click();

    await expect
      .element(screen.getByRole("button", { name: "Show options" }))
      .not.toBeInTheDocument();

    await expect.element(screen.getByText("Date")).toBeVisible();
    // Attachments were deliberately removed from note inputs: the revealed
    // section must expose the date control and no file input.
    await expect
      .element(screen.getByText("Attachments"))
      .not.toBeInTheDocument();
  });

  it("renders the status selector when showStatus is true", async () => {
    const screen = await render(<NoteInputsStory showStatus />);

    // Click 'Show options' to reveal the hidden section
    await screen.getByRole("button", { name: "Show options" }).click();

    await expect.element(screen.getByText("Status")).toBeVisible();
  });

  it("defaults the status selector to the current contact status", async () => {
    const screen = await render(
      <NoteInputsStory defaultStatus="hot" showStatus />,
    );

    await screen.getByRole("button", { name: "Show options" }).click();

    await expect.element(screen.getByRole("combobox")).toHaveTextContent("Hot");
  });

  it("does not render the status selector when showStatus is false", async () => {
    const screen = await render(<Default />);

    // Reveal the options section first. While collapsed, the options hint
    // ("(change status or date)") is in the DOM and matches the
    // case-insensitive substring lookup below, masking the real assertion.
    await screen.getByRole("button", { name: "Show options" }).click();

    await expect.element(screen.getByText("Status")).not.toBeInTheDocument();
  });

  it("renders the contact reference selector when selectReference is contacts", async () => {
    const screen = await render(
      <NoteInputsStory reference="contacts" selectReference />,
    );

    await expect.element(screen.getByText("Contact")).toBeVisible();
  });

  it("renders the deal reference selector when selectReference is deals", async () => {
    const screen = await render(
      <NoteInputsStory reference="deals" selectReference />,
    );

    await expect.element(screen.getByText("Deal")).toBeVisible();
  });

  it("does not render a reference selector when selectReference is not set", async () => {
    const screen = await render(<Default />);

    await expect.element(screen.getByText("Contact")).not.toBeInTheDocument();
    await expect.element(screen.getByText("Deal")).not.toBeInTheDocument();
  });

  it("should have the current date as default value for the date input", async () => {
    const screen = await render(<Default />);

    await screen.getByRole("button", { name: "Show options" }).click();

    const dateInput = screen.getByLabelText("Date");
    const currentDate = new Date();
    const offset = currentDate.getTimezoneOffset();
    const localDate = new Date(currentDate.getTime() - offset * 60 * 1000);
    const expectedValue = localDate.toISOString().slice(0, 16);

    await expect(dateInput).toHaveValue(expectedValue);
  });

  it("should use the note date instead of the current date when it is set", async () => {
    const screen = await render(
      <NoteInputsStory defaultValues={{ date: "2024-01-01T12:00" }} />,
    );

    await screen.getByRole("button", { name: "Show options" }).click();

    const dateInput = screen.getByLabelText("Date");

    await expect(dateInput).toHaveValue("2024-01-01T12:00");
  });

  it("shows a validation error when submitting an empty note", async () => {
    const screen = await render(<WithSaveButton />);

    await screen.getByRole("button", { name: "Save" }).click();

    await expect
      .element(screen.getByText("A commercial note is required"))
      .toBeVisible();
  });

  it("treats whitespace-only note text as empty", async () => {
    const screen = await render(<WithSaveButton />);

    await screen.getByPlaceholder("Add a note").fill("   ");
    await screen.getByRole("button", { name: "Save" }).click();

    await expect
      .element(screen.getByText("A commercial note is required"))
      .toBeVisible();
  });

  it("allows submitting a note with text only", async () => {
    const screen = await render(<WithSaveButton />);

    await screen.getByPlaceholder("Add a note").fill("Call summary");
    await screen.getByRole("button", { name: "Save" }).click();

    await expect
      .element(screen.getByText("A commercial note is required"))
      .not.toBeInTheDocument();
  });

  it("still requires text when a legacy attachments value is present", async () => {
    const screen = await render(<WithAttachmentDefault />);

    await screen.getByRole("button", { name: "Save" }).click();

    await expect
      .element(screen.getByText("A commercial note is required"))
      .toBeVisible();
  });
});
