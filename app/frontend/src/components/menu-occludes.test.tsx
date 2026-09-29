import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { BreadcrumbDropdown } from "./breadcrumb-dropdown";
import { OpenButton } from "./open-button";
import { ToastProvider } from "./toast";
import { LayoutChip } from "./layout-chip";
import { GuiToolbarMenu } from "./gui-toolbar-menu";
import { ComposeHistoryFlyout } from "./compose-history-flyout";
import { _resetForTests, count, isModalOpen, isOccludingOpen } from "@/lib/overlay-presence";
import type { BreadcrumbDropdownItem } from "@/contexts/chrome-context";
import type { OpenTarget } from "@/lib/open-in-app";
import type { Layout } from "@/lib/surface-layout";

// Click-opened menus register `transient` with the overlay-presence registry
// so a native web guest composited above the DOM hides while one is open.
// These cases prove acquire-on-open / release-on-close for a representative
// spread: a `useState`-gated dropdown, a split-button menu, a chip popover,
// and two mount-only-while-open menus. The registry itself is covered by
// overlay-presence.test.ts.
vi.mock("@/api/client", () => ({
  openInApp: vi.fn().mockResolvedValue({ ok: true }),
}));

const DROPDOWN_ITEMS: BreadcrumbDropdownItem[] = [
  { label: "project-a", href: "/project-a/0", current: true },
  { label: "project-b", href: "/project-b/0" },
];

const OPEN_TARGETS: OpenTarget[] = [
  {
    kind: "deeplink",
    id: "deeplink:vscode",
    label: "VS Code",
    url: "vscode://vscode-remote/ssh-remote+devbox/Users/x/proj",
  },
  { kind: "host", id: "host:iterm", label: "iTerm", appId: "iterm" },
];

const TWO_TILE_LAYOUT: Layout = { dir: "h", children: [{ leaf: "tty" }, { leaf: "web" }] };

describe("menu overlay-presence registration", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetForTests();
  });

  afterEach(() => {
    cleanup();
    _resetForTests();
  });

  it("BreadcrumbDropdown holds a transient count from open to close", () => {
    render(<BreadcrumbDropdown items={DROPDOWN_ITEMS} />);
    expect(count("transient")).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: /switch/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(count("transient")).toBe(1);
    expect(isOccludingOpen()).toBe(true);
    // A menu is not modal-class — the modal signal stays untouched.
    expect(isModalOpen()).toBe(false);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(count("transient")).toBe(0);
    expect(isOccludingOpen()).toBe(false);
  });

  it("OpenButton's chevron menu holds a transient count from open to outside-click close", () => {
    render(
      <ToastProvider>
        <OpenButton targets={OPEN_TARGETS} server="runkit" path="/Users/x/proj" />
      </ToastProvider>,
    );
    expect(count("transient")).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Open in… (choose app)" }));
    expect(screen.getByRole("menu", { name: "Open in app" })).toBeInTheDocument();
    expect(count("transient")).toBe(1);

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(count("transient")).toBe(0);
  });

  it("LayoutChip's template popover holds a transient count from open to close", () => {
    render(<LayoutChip layout={TWO_TILE_LAYOUT} onApply={vi.fn()} />);
    expect(count("transient")).toBe(0);

    fireEvent.click(screen.getByTestId("layout-chip"));
    expect(screen.getByRole("menu", { name: "Layout templates" })).toBeInTheDocument();
    expect(count("transient")).toBe(1);

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(count("transient")).toBe(0);
  });

  it("GuiToolbarMenu registers for its whole mount (it mounts only while open)", () => {
    const anchorRef = { current: null };
    const { unmount } = render(
      <GuiToolbarMenu
        kind="resolution"
        anchorRef={anchorRef}
        rows={[]}
        ariaLabel="Resolution"
        onClose={vi.fn()}
      />,
    );
    expect(count("transient")).toBe(1);
    expect(isOccludingOpen()).toBe(true);

    unmount();
    expect(count("transient")).toBe(0);
    expect(isOccludingOpen()).toBe(false);
  });

  it("ComposeHistoryFlyout registers for its whole mount (it mounts only while open)", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const { unmount } = render(
      <ComposeHistoryFlyout
        anchor={anchor}
        entries={["ls -la"]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(count("transient")).toBe(1);

    unmount();
    expect(count("transient")).toBe(0);
    anchor.remove();
  });
});
