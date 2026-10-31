import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { BreadcrumbDropdown } from "./breadcrumb-dropdown";
import type { BreadcrumbDropdownItem } from "@/contexts/chrome-context";

const items: BreadcrumbDropdownItem[] = [
  { label: "project-a", href: "/project-a/0", current: true },
  { label: "project-b", href: "/project-b/0" },
  { label: "project-c", href: "/project-c/0" },
];

function clickChevron() {
  fireEvent.click(screen.getByRole("button", { name: /switch/i }));
}

describe("BreadcrumbDropdown", () => {
  afterEach(cleanup);

  it("renders a chevron button", () => {
    render(<BreadcrumbDropdown items={items} />);
    expect(screen.getByRole("button", { name: /switch/i })).toBeInTheDocument();
  });

  it("renders the bare caret as trigger content", () => {
    render(<BreadcrumbDropdown items={items} />);
    expect(screen.getByRole("button", { name: /switch/i }).textContent).toBe("▾");
  });

  it("dropdown is hidden by default", () => {
    render(<BreadcrumbDropdown items={items} />);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens dropdown on chevron click", () => {
    render(<BreadcrumbDropdown items={items} />);
    clickChevron();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
  });

  it("closes dropdown on second chevron click", () => {
    render(<BreadcrumbDropdown items={items} />);
    clickChevron();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    clickChevron();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes dropdown on Escape", () => {
    render(<BreadcrumbDropdown items={items} />);
    clickChevron();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes dropdown on outside click", () => {
    render(
      <div>
        <span data-testid="outside">outside</span>
        <BreadcrumbDropdown items={items} />
      </div>,
    );
    clickChevron();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("marks the current item with the checked treatment (primary ink + trailing green ✓)", () => {
    render(<BreadcrumbDropdown items={items} />);
    clickChevron();
    const currentItem = screen.getByRole("menuitem", { name: "project-a" });
    expect(currentItem.className).toContain("text-text-primary");
    expect(currentItem.className).not.toContain("text-accent");
    const check = currentItem.querySelector("span[aria-hidden='true']");
    expect(check?.textContent).toBe("✓");
    expect(check?.className).toContain("text-accent-green");
  });

  it("non-current items have secondary color", () => {
    render(<BreadcrumbDropdown items={items} />);
    clickChevron();
    const otherItem = screen.getByRole("menuitem", { name: "project-b" });
    expect(otherItem.className).toContain("text-text-secondary");
  });

  it("renders an optional item icon before its label", () => {
    render(
      <BreadcrumbDropdown
        items={[
          {
            label: "coordinator",
            href: "/coordinator/0",
            icon: (
              <span data-testid="item-icon" aria-hidden="true">
                icon
              </span>
            ),
          },
          { label: "worker", href: "/worker/0" },
        ]}
      />,
    );
    clickChevron();

    const icon = screen.getByTestId("item-icon");
    const label = screen.getByText("coordinator");
    // The icon slot carries no color of its own — it rides the row's ink.
    expect(icon.parentElement).toHaveClass("shrink-0");
    expect(
      icon.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Icon-less rows render the label span only.
    expect(screen.getByRole("menuitem", { name: "worker" }).childElementCount).toBe(1);
  });

  it("a current item with an icon reads primary ink throughout, with no accent tint", () => {
    render(
      <BreadcrumbDropdown
        items={[
          {
            label: "coordinator",
            href: "/coordinator/0",
            current: true,
            icon: <span data-testid="current-item-icon" aria-hidden="true" />,
          },
        ]}
      />,
    );
    clickChevron();

    const item = screen.getByRole("menuitem", { name: "coordinator" });
    const iconSlot = screen.getByTestId("current-item-icon").parentElement;
    expect(item).toHaveClass("text-text-primary");
    expect(item).not.toHaveClass("text-accent");
    expect(iconSlot).not.toHaveClass("text-accent");
    expect(iconSlot).not.toHaveClass("text-text-secondary");
  });

  it("calls onNavigate with correct href when item is clicked", () => {
    const onNavigate = vi.fn();
    render(<BreadcrumbDropdown items={items} onNavigate={onNavigate} />);
    clickChevron();
    fireEvent.click(screen.getByText("project-b"));
    expect(onNavigate).toHaveBeenCalledWith("/project-b/0");
  });

  it("auto-focuses current item on open", async () => {
    render(<BreadcrumbDropdown items={items} />);
    clickChevron();
    const currentItem = screen.getAllByRole("menuitem")[0];
    await waitFor(() => expect(document.activeElement).toBe(currentItem));
  });

  it("navigates items with ArrowDown", () => {
    render(<BreadcrumbDropdown items={items} />);
    clickChevron();
    fireEvent.keyDown(document, { key: "ArrowDown" });
    const secondItem = screen.getAllByRole("menuitem")[1];
    expect(document.activeElement).toBe(secondItem);
  });

  it("navigates items with ArrowUp wrapping", () => {
    render(<BreadcrumbDropdown items={items} />);
    clickChevron();
    fireEvent.keyDown(document, { key: "ArrowUp" });
    const lastItem = screen.getAllByRole("menuitem")[2];
    expect(document.activeElement).toBe(lastItem);
  });

  it("uses contextual aria-label when label prop provided", () => {
    render(<BreadcrumbDropdown items={items} label="session" />);
    expect(screen.getByRole("button", { name: "Switch session" })).toBeInTheDocument();
  });

  it("sets aria-expanded correctly", () => {
    render(<BreadcrumbDropdown items={items} />);
    const button = screen.getByRole("button", { name: /switch/i });
    expect(button).toHaveAttribute("aria-expanded", "false");
    clickChevron();
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("menu container className includes overflow-y-auto and max-h-60", () => {
    render(<BreadcrumbDropdown items={items} />);
    clickChevron();
    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("overflow-y-auto");
    expect(menu.className).toContain("max-h-60");
  });

  it("closes dropdown when item is clicked", () => {
    render(<BreadcrumbDropdown items={items} />);
    clickChevron();
    fireEvent.click(screen.getByText("project-b"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
