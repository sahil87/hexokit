import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { OpenButton, OpenMenuRows } from "./open-button";
import { ToastProvider } from "./toast";
import { TIP_OPEN_DELAY_MS } from "@/components/tip";
import { openInApp } from "@/api/client";
import { LAST_USED_OPEN_TARGET_KEY, type OpenTarget } from "@/lib/open-in-app";

vi.mock("@/api/client", () => ({
  openInApp: vi.fn().mockResolvedValue({ ok: true }),
}));

const deeplinkTarget: OpenTarget = {
  kind: "deeplink",
  id: "deeplink:vscode",
  label: "VS Code",
  url: "vscode://vscode-remote/ssh-remote+devbox/Users/x/proj",
};
const hostTarget: OpenTarget = {
  kind: "host",
  id: "host:iterm",
  label: "iTerm",
  appId: "iterm",
};

function renderButton(targets: OpenTarget[]) {
  return render(
    <ToastProvider>
      <OpenButton targets={targets} server="runkit" path="/Users/x/proj" />
    </ToastProvider>,
  );
}

/** Stub window.location.href assignment (jsdom navigation is unimplemented). */
function stubLocation(): { get href(): string } {
  const state = { href: "" };
  const original = window.location;
  Object.defineProperty(window, "location", {
    value: {
      ...original,
      get href() {
        return state.href;
      },
      set href(v: string) {
        state.href = v;
      },
    },
    writable: true,
    configurable: true,
  });
  return state;
}

describe("OpenButton", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(openInApp).mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing with zero targets", () => {
    const { container } = renderButton([]);
    expect(container.querySelector("button")).toBeNull();
  });

  it("primary click opens the menu when no last-used preference is stored", () => {
    renderButton([deeplinkTarget, hostTarget]);
    fireEvent.click(screen.getByRole("button", { name: "Open in app" }));
    expect(screen.getByRole("menu", { name: "Open in app" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "VS Code" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "iTerm" })).toBeInTheDocument();
  });

  it("chevron always opens the menu", () => {
    localStorage.setItem(LAST_USED_OPEN_TARGET_KEY, "host:iterm");
    renderButton([deeplinkTarget, hostTarget]);
    fireEvent.click(screen.getByRole("button", { name: "Open in… (choose app)" }));
    expect(screen.getByRole("menu", { name: "Open in app" })).toBeInTheDocument();
  });

  it("primary click re-runs a stored last-used host target without opening the menu", () => {
    localStorage.setItem(LAST_USED_OPEN_TARGET_KEY, "host:iterm");
    renderButton([deeplinkTarget, hostTarget]);
    fireEvent.click(screen.getByRole("button", { name: "Open in iTerm" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(openInApp).toHaveBeenCalledWith("runkit", "/Users/x/proj", "iterm");
  });

  it("primary click falls back to the menu when the stored target is stale", () => {
    localStorage.setItem(LAST_USED_OPEN_TARGET_KEY, "deeplink:windsurf");
    renderButton([deeplinkTarget, hostTarget]);
    fireEvent.click(screen.getByRole("button", { name: "Open in app" }));
    expect(screen.getByRole("menu", { name: "Open in app" })).toBeInTheDocument();
    expect(openInApp).not.toHaveBeenCalled();
  });

  it("a deeplink menu item navigates via location.href and persists last-used", () => {
    const loc = stubLocation();
    renderButton([deeplinkTarget, hostTarget]);
    fireEvent.click(screen.getByRole("button", { name: "Open in… (choose app)" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "VS Code" }));
    expect(loc.href).toBe("vscode://vscode-remote/ssh-remote+devbox/Users/x/proj");
    expect(localStorage.getItem(LAST_USED_OPEN_TARGET_KEY)).toBe("deeplink:vscode");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a host menu item POSTs and persists last-used", () => {
    renderButton([deeplinkTarget, hostTarget]);
    fireEvent.click(screen.getByRole("button", { name: "Open in… (choose app)" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "iTerm" }));
    expect(openInApp).toHaveBeenCalledWith("runkit", "/Users/x/proj", "iterm");
    expect(localStorage.getItem(LAST_USED_OPEN_TARGET_KEY)).toBe("host:iterm");
  });

  it("labels the host section when the menu carries both kinds", () => {
    renderButton([deeplinkTarget, hostTarget]);
    fireEvent.click(screen.getByRole("button", { name: "Open in… (choose app)" }));
    expect(screen.getByText("on host")).toBeInTheDocument();
  });

  it("omits the host section header for a single-kind (local) list", () => {
    renderButton([hostTarget]);
    fireEvent.click(screen.getByRole("button", { name: "Open in app" }));
    expect(screen.queryByText("on host")).toBeNull();
  });

  it("shows an error toast when the host launch fails", async () => {
    vi.mocked(openInApp).mockRejectedValueOnce(new Error("unknown app"));
    renderButton([hostTarget]);
    fireEvent.click(screen.getByRole("button", { name: "Open in app" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "iTerm" }));
    expect(await screen.findByText("unknown app")).toBeInTheDocument();
  });

  it("primary segment leads with the last-used target's glyph (260723-l317)", () => {
    localStorage.setItem(LAST_USED_OPEN_TARGET_KEY, "deeplink:vscode");
    renderButton([deeplinkTarget, hostTarget]);
    // Accessible name unchanged — the glyph is aria-hidden decoration.
    const primary = screen.getByRole("button", { name: "Open in VS Code" });
    const icon = primary.querySelector("svg[data-icon='vscode']");
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute("aria-hidden")).toBe("true");
    // The "Open" text label is kept — the icon is additive.
    expect(primary).toHaveTextContent("Open");
  });

  it("primary segment carries no glyph when no last-used preference is stored", () => {
    renderButton([deeplinkTarget, hostTarget]);
    const primary = screen.getByRole("button", { name: "Open in app" });
    expect(primary.querySelector("svg")).toBeNull();
  });

  it("primary segment carries no glyph when the stored last-used id is stale", () => {
    localStorage.setItem(LAST_USED_OPEN_TARGET_KEY, "deeplink:windsurf");
    renderButton([deeplinkTarget, hostTarget]);
    const primary = screen.getByRole("button", { name: "Open in app" });
    expect(primary.querySelector("svg")).toBeNull();
  });

  it("leads every menu row with its resolved glyph (260722-fc3b)", () => {
    renderButton([deeplinkTarget, hostTarget]);
    fireEvent.click(screen.getByRole("button", { name: "Open in… (choose app)" }));
    // Deeplink vscode → the VS Code brand glyph; host iTerm (kind terminal,
    // carried as appKind) has no appKind on this fixture → neutral fallback.
    const vscodeRow = screen.getByRole("menuitem", { name: "VS Code" });
    expect(vscodeRow.querySelector("svg[data-icon='vscode']")).not.toBeNull();
    const itermRow = screen.getByRole("menuitem", { name: "iTerm" });
    expect(itermRow.querySelector("svg[data-icon='app']")).not.toBeNull();
  });

  it("maps the wt host id `code` to the VS Code glyph and falls back by kind for unknown ids", () => {
    const codeHost: OpenTarget = {
      kind: "host",
      id: "host:code",
      label: "VSCode",
      appId: "code",
      appKind: "editor",
    };
    const ghostty: OpenTarget = {
      kind: "host",
      id: "host:ghostty_macos",
      label: "Ghostty",
      appId: "ghostty_macos",
      appKind: "terminal",
    };
    const finder: OpenTarget = {
      kind: "host",
      id: "host:finder",
      label: "Finder",
      appId: "finder",
      appKind: "file-manager",
    };
    renderButton([codeHost, ghostty, finder]);
    fireEvent.click(screen.getByRole("button", { name: "Open in app" }));
    expect(
      screen.getByRole("menuitem", { name: "VSCode" }).querySelector("svg[data-icon='vscode']"),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("menuitem", { name: "Ghostty" })
        .querySelector("svg[data-icon='terminal']"),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("menuitem", { name: "Finder" })
        .querySelector("svg[data-icon='file-manager']"),
    ).not.toBeNull();
  });
});

describe("OpenMenuRows", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(openInApp).mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  function renderRows(targets: OpenTarget[]) {
    return render(
      <ToastProvider>
        <div role="menu" aria-label="More controls">
          <OpenMenuRows targets={targets} server="runkit" path="/Users/x/proj" />
        </div>
      </ToastProvider>,
    );
  }

  it("renders one Open: row per target, suffixing host rows when both kinds present", () => {
    renderRows([deeplinkTarget, hostTarget]);
    expect(screen.getByRole("menuitem", { name: "Open: VS Code" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Open: iTerm (on host)" }),
    ).toBeInTheDocument();
  });

  it("drops the suffix for a single-kind list", () => {
    renderRows([hostTarget]);
    expect(screen.getByRole("menuitem", { name: "Open: iTerm" })).toBeInTheDocument();
  });

  it("renders nothing with zero targets", () => {
    const { container } = renderRows([]);
    expect(container.querySelector("[role=menuitem]")).toBeNull();
  });

  it("a row click runs the target", () => {
    renderRows([hostTarget]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open: iTerm" }));
    expect(openInApp).toHaveBeenCalledWith("runkit", "/Users/x/proj", "iterm");
  });

  it("leads overflow rows with the same resolved glyphs (260722-fc3b)", () => {
    renderRows([deeplinkTarget, hostTarget]);
    expect(
      screen
        .getByRole("menuitem", { name: "Open: VS Code" })
        .querySelector("svg[data-icon='vscode']"),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("menuitem", { name: "Open: iTerm (on host)" })
        .querySelector("svg[data-icon='app']"),
    ).not.toBeNull();
  });
});

describe("OpenButton primary tip kbd (260811-ke2s)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(openInApp).mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("carries the registry-resolved open-last-used keycap on the primary tip", () => {
    localStorage.setItem(LAST_USED_OPEN_TARGET_KEY, "host:iterm");
    renderButton([deeplinkTarget, hostTarget]);
    const primary = screen.getByRole("button", { name: "Open in iTerm" });
    act(() => {
      fireEvent.mouseEnter(primary);
      vi.advanceTimersByTime(TIP_OPEN_DELAY_MS);
    });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Open in iTerm");
    // jsdom's platform resolves "other" — ⇧O default renders as Shift+Ctrl+O.
    expect(tooltip.querySelector("kbd")).toHaveTextContent("Shift+Ctrl+O");
  });

  it("omits the keycap chip when open-last-used is unbound — a dead chord would lie", () => {
    localStorage.setItem("hexokit-keybindings", JSON.stringify({ "open-last-used": null }));
    localStorage.setItem(LAST_USED_OPEN_TARGET_KEY, "host:iterm");
    renderButton([deeplinkTarget, hostTarget]);
    const primary = screen.getByRole("button", { name: "Open in iTerm" });
    act(() => {
      fireEvent.mouseEnter(primary);
      vi.advanceTimersByTime(TIP_OPEN_DELAY_MS);
    });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Open in iTerm");
    expect(tooltip.querySelector("kbd")).toBeNull();
  });
});
