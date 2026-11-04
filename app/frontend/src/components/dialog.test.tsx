import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Dialog } from "./dialog";
import { _resetForTests as resetOverlayPresence, count as overlayCount } from "@/lib/overlay-presence";

afterEach(cleanup);

describe("Dialog", () => {
  it("registers as a modal overlay while mounted and releases on unmount", () => {
    resetOverlayPresence();
    const { unmount } = render(
      <Dialog title="Confirm" onClose={() => {}}>
        <p>body</p>
      </Dialog>,
    );
    expect(overlayCount("modal")).toBe(1);
    unmount();
    expect(overlayCount("modal")).toBe(0);
  });

  it("renders title and children", () => {
    render(
      <Dialog title="Kill window?" onClose={() => {}}>
        <p>Are you sure?</p>
      </Dialog>,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Kill window?")).toBeInTheDocument();
    expect(screen.getByText("Are you sure?")).toBeInTheDocument();
  });

  it("labels the dialog with the title", () => {
    render(
      <Dialog title="Kill window?" onClose={() => {}}>
        <p>body</p>
      </Dialog>,
    );
    expect(screen.getByRole("dialog", { name: "Kill window?" })).toBeInTheDocument();
  });

  it("focuses the first focusable element on mount", () => {
    render(
      <Dialog title="Confirm" onClose={() => {}}>
        <button type="button">Cancel</button>
        <button type="button">Kill</button>
      </Dialog>,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(
      <Dialog title="Confirm" onClose={onClose}>
        <button type="button">Cancel</button>
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("wraps Tab from the last focusable to the first", () => {
    render(
      <Dialog title="Confirm" onClose={() => {}}>
        <button type="button">Cancel</button>
        <button type="button">Kill</button>
      </Dialog>,
    );
    const kill = screen.getByRole("button", { name: "Kill" });
    kill.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("wraps Shift+Tab from the first focusable to the last", () => {
    render(
      <Dialog title="Confirm" onClose={() => {}}>
        <button type="button">Cancel</button>
        <button type="button">Kill</button>
      </Dialog>,
    );
    // Mount focus already put us on the first focusable (Cancel).
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Kill" })).toHaveFocus();
  });

  it("defaults to the sm width variant (max-w-sm) when no size is passed", () => {
    render(
      <Dialog title="Confirm" onClose={() => {}}>
        <p>body</p>
      </Dialog>,
    );
    const panel = screen.getByRole("dialog");
    expect(panel.className).toContain("max-w-sm");
    expect(panel.className).not.toContain("max-w-2xl");
  });

  it("renders the lg width variant (max-w-2xl) when size='lg' (260724-6j1v)", () => {
    render(
      <Dialog title="Settings" onClose={() => {}} size="lg">
        <p>body</p>
      </Dialog>,
    );
    const panel = screen.getByRole("dialog");
    expect(panel.className).toContain("max-w-2xl");
    expect(panel.className).not.toContain("max-w-sm");
  });

  it("renders the xl variant as a fixed-height non-scrolling panel (max-w-4xl)", () => {
    render(
      <Dialog title="Settings" onClose={() => {}} size="xl">
        <p>body</p>
      </Dialog>,
    );
    const panel = screen.getByRole("dialog");
    expect(panel.className).toContain("max-w-4xl");
    expect(panel.className).toContain("h-[min(40rem,calc(100vh-2rem))]");
    // The panel itself never scrolls on xl — each tab panel owns its scroll.
    expect(panel.className).toContain("overflow-hidden");
    expect(panel.className).not.toContain("overflow-y-auto");
  });

  it("carries the short-viewport scroll path on both size variants (260724-6j1v)", () => {
    // Tall dialogs (the lg settings pane) must scroll inside short viewports
    // instead of clipping off-screen: the panel caps its height and scrolls,
    // and the backdrop container keeps padding so the panel never touches the
    // viewport edges.
    for (const size of ["sm", "lg"] as const) {
      const { container, unmount } = render(
        <Dialog title="Confirm" onClose={() => {}} size={size}>
          <p>body</p>
        </Dialog>,
      );
      const panel = screen.getByRole("dialog");
      expect(panel.className).toContain("max-h-[calc(100vh-2rem)]");
      expect(panel.className).toContain("overflow-y-auto");
      expect((container.firstElementChild as HTMLElement).className).toContain("p-4");
      unmount();
    }
  });

  it("renders the sheet variant as a 520px panel that bottom-docks below sm", () => {
    const { container } = render(
      <Dialog title="New" onClose={() => {}} size="sheet">
        <button type="button">Create</button>
      </Dialog>,
    );
    const panel = screen.getByRole("dialog");
    expect(panel.className).toContain("sm:max-w-[520px]");
    expect(panel.className).toContain("overflow-y-auto");
    const overlay = (container.firstElementChild as HTMLElement).className;
    expect(overlay).toContain("items-end");
    expect(overlay).toContain("sm:items-center");
  });

  it("calls onClose on backdrop click but not on dialog-body click", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Dialog title="Confirm" onClose={onClose}>
        <button type="button">Cancel</button>
      </Dialog>,
    );
    fireEvent.click(screen.getByText("Confirm"));
    expect(onClose).not.toHaveBeenCalled();
    // The outermost overlay div carries the close-on-click handler.
    fireEvent.click(container.firstElementChild as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
