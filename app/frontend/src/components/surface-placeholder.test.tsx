import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { SurfacePlaceholder } from "./surface-placeholder";
import { makeWindow } from "@/test-utils/fixtures";

afterEach(() => {
  cleanup();
});

describe("SurfacePlaceholder — popped variant", () => {
  it("reads '<Surface> is popped out' with the tty status dot, bring back / go to window, and ✕", () => {
    render(
      <SurfacePlaceholder
        variant="popped"
        kind="tty"
        statusWindow={makeWindow()}
        showClose={true}
        onBringBack={vi.fn()}
        onGoTo={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const placeholder = screen.getByTestId("surface-placeholder");
    expect(placeholder.textContent).toContain("Terminal is popped out");
    expect(within(placeholder).getByRole("img")).toBeTruthy();
    expect(within(placeholder).getByRole("button", { name: "bring back" })).toBeTruthy();
    expect(within(placeholder).getByRole("button", { name: "go to window" })).toBeTruthy();
    expect(within(placeholder).getByRole("button", { name: "Close Terminal" })).toBeTruthy();
  });

  it("fires the bring back / go to window / close callbacks", () => {
    const onBringBack = vi.fn();
    const onGoTo = vi.fn();
    const onClose = vi.fn();
    render(
      <SurfacePlaceholder
        variant="popped"
        kind="web"
        showClose={true}
        onBringBack={onBringBack}
        onGoTo={onGoTo}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "bring back" }));
    fireEvent.click(screen.getByRole("button", { name: "go to window" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Web" }));
    expect(onBringBack).toHaveBeenCalledTimes(1);
    expect(onGoTo).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hides ✕ when showClose is false (single-leaf placeholder)", () => {
    render(
      <SurfacePlaceholder
        variant="popped"
        kind="tty"
        showClose={false}
        onBringBack={vi.fn()}
        onGoTo={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Close Terminal" })).toBeNull();
    expect(screen.getByRole("button", { name: "bring back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "go to window" })).toBeTruthy();
  });

  it("carries no status dot for non-tty kinds", () => {
    render(
      <SurfacePlaceholder
        variant="popped"
        kind="web"
        statusWindow={makeWindow()}
        showClose={true}
        onBringBack={vi.fn()}
        onGoTo={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("SurfacePlaceholder — away variant (default)", () => {
  it("keeps the holder-tab message and go-to label when no variant is passed", () => {
    render(
      <SurfacePlaceholder
        kind="tty"
        holderName="api"
        statusWindow={makeWindow()}
        showClose={true}
        onBringBack={vi.fn()}
        onGoTo={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const placeholder = screen.getByTestId("surface-placeholder");
    expect(placeholder.textContent).toContain("Terminal is in tab api");
    expect(within(placeholder).getByRole("button", { name: "go to api" })).toBeTruthy();
    expect(within(placeholder).getByRole("img")).toBeTruthy();
  });
});
