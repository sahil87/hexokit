import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SessionNamePrompt } from "./session-name-prompt";
import { makeSession } from "@/test-utils/fixtures";
import type { ProjectSession } from "@/types";

function renderPrompt(overrides?: {
  sessions?: ProjectSession[];
  defaultName?: string;
  onSubmit?: () => void;
  onClose?: () => void;
}) {
  const onSubmit = overrides?.onSubmit ?? vi.fn();
  const onClose = overrides?.onClose ?? vi.fn();
  render(
    <SessionNamePrompt
      sessions={overrides?.sessions ?? [makeSession({ name: "existing", windows: [] })]}
      defaultName={overrides?.defaultName ?? "run_kit"}
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );
  return { onSubmit, onClose };
}

function input(): HTMLInputElement {
  return screen.getByRole("textbox", { name: "Group name" });
}

describe("SessionNamePrompt", () => {
  afterEach(cleanup);

  it("opens prefilled with the default name, focused and select-all'd", () => {
    renderPrompt({ defaultName: "run_kit" });
    const el = input();
    expect(el.value).toBe("run_kit");
    expect(document.activeElement).toBe(el);
    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe("run_kit".length);
  });

  it("Enter on the untouched default submits it", () => {
    const { onSubmit } = renderPrompt({ defaultName: "run_kit" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("run_kit");
  });

  it("typed input live-converts via the safe-name transform and submits finalized", () => {
    const { onSubmit } = renderPrompt();
    fireEvent.change(input(), { target: { value: "api work" } });
    expect(input().value).toBe("api_work");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("api_work");
  });

  it("empty input disables Create and Enter is a no-op", () => {
    const { onSubmit } = renderPrompt();
    fireEvent.change(input(), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("a colliding name blocks submit and shows the inline hint", () => {
    const { onSubmit } = renderPrompt({ sessions: [makeSession({ name: "existing", windows: [] })] });
    fireEvent.change(input(), { target: { value: "existing" } });
    expect(input()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText('Session "existing" already exists')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Escape closes without submitting", () => {
    const { onSubmit, onClose } = renderPrompt();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clicking Create submits the current value", () => {
    const { onSubmit } = renderPrompt({ defaultName: "run_kit" });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("run_kit");
  });
});
