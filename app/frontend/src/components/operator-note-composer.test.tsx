import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { postOperatorNote, postOperatorWake } from "@/api/client";
import {
  NOTE_SAVED_DEFERRED,
  NOTE_SAVED_QUEUED,
  OperatorNoteComposer,
} from "./operator-note-composer";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, postOperatorNote: vi.fn(), postOperatorWake: vi.fn() };
});

const mockedNote = vi.mocked(postOperatorNote);
const mockedWake = vi.mocked(postOperatorWake);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function renderComposer() {
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  render(<OperatorNoteComposer server="work" itemId="pr-41" onSaved={onSaved} onCancel={onCancel} />);
  return { onSaved, onCancel, input: screen.getByTestId("operator-note-input") };
}

describe("OperatorNoteComposer", () => {
  it("autofocuses its textarea", () => {
    const { input } = renderComposer();
    expect(document.activeElement).toBe(input);
  });

  it("Enter writes the note, then wakes with note:<id>, then reports the queued status", async () => {
    mockedNote.mockResolvedValue({ at: 1, by: "user", text: "merge it" });
    mockedWake.mockResolvedValue(undefined);
    const { onSaved, input } = renderComposer();
    fireEvent.change(input, { target: { value: "merge it" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(NOTE_SAVED_QUEUED));
    expect(mockedNote).toHaveBeenCalledWith("work", "pr-41", "merge it");
    expect(mockedWake).toHaveBeenCalledWith("work", "note:pr-41");
    expect(mockedNote.mock.invocationCallOrder[0]).toBeLessThan(mockedWake.mock.invocationCallOrder[0]);
  });

  it("the Save button submits the same way", async () => {
    mockedNote.mockResolvedValue({ at: 1, by: "user", text: "x" });
    mockedWake.mockResolvedValue(undefined);
    const { onSaved, input } = renderComposer();
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("operator-note-save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(NOTE_SAVED_QUEUED));
  });

  it("a write failure keeps the composer open with its text and the message, and never wakes", async () => {
    mockedNote.mockRejectedValue(new Error("note text is 1100 characters, over the 1000-character cap"));
    const { onSaved, input } = renderComposer();
    fireEvent.change(input, { target: { value: "too long" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("over the 1000-character cap");
    expect((screen.getByTestId("operator-note-input") as HTMLTextAreaElement).value).toBe("too long");
    expect(onSaved).not.toHaveBeenCalled();
    expect(mockedWake).not.toHaveBeenCalled();
  });

  it("a wake failure still closes, with the next-check status", async () => {
    mockedNote.mockResolvedValue({ at: 1, by: "user", text: "x" });
    mockedWake.mockRejectedValue(new Error("boom"));
    const { onSaved, input } = renderComposer();
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(NOTE_SAVED_DEFERRED));
  });

  it("Shift+Enter does not submit", () => {
    const { input } = renderComposer();
    fireEvent.change(input, { target: { value: "line" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(mockedNote).not.toHaveBeenCalled();
  });

  it("Esc cancels without writing", () => {
    const { onCancel, input } = renderComposer();
    fireEvent.change(input, { target: { value: "draft" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(mockedNote).not.toHaveBeenCalled();
  });

  it("Cancel button cancels", () => {
    const { onCancel } = renderComposer();
    fireEvent.click(screen.getByTestId("operator-note-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("whitespace-only text cannot be submitted", () => {
    const { input } = renderComposer();
    expect((screen.getByTestId("operator-note-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "   " } });
    expect((screen.getByTestId("operator-note-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockedNote).not.toHaveBeenCalled();
  });

  it("shows the length counter only near the cap", () => {
    const { input } = renderComposer();
    expect(screen.queryByTestId("operator-note-counter")).toBeNull();
    fireEvent.change(input, { target: { value: "a".repeat(950) } });
    expect(screen.getByTestId("operator-note-counter").textContent).toBe("950/1000");
  });
});
