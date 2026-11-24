import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { ShellTitlebarStrip } from "./titlebar-strip";
import {
  InstanceAccentValueProvider,
  type InstanceAccent,
} from "@/contexts/instance-accent-context";
import { ThemeProvider } from "@/contexts/theme-context";
import { ToastProvider } from "@/components/toast";
import { deriveUIColors, DEFAULT_DARK_THEME } from "@/themes";
import { HOST_MENU_OPEN_EVENT, HOST_STRIP_FOCUS_EVENT, SHELL_STRIP_MARKER_CLASS } from "@/lib/shell-strip";

// ThemeProvider makes no real HTTP calls in tests.
vi.mock("@/api/client", () => ({
  getThemePreference: vi.fn().mockRejectedValue(new Error("no API in test")),
  setThemePreference: vi.fn().mockResolvedValue(undefined),
  getHealth: vi.fn().mockResolvedValue({ status: "ok", hostname: "box", sshUser: "sahil", os: "linux" }),
}));

function mockMatchMedia() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: true,
      media: "(prefers-color-scheme: dark)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    }),
  );
}

function accentValue(overrides: Partial<InstanceAccent> = {}): InstanceAccent {
  return {
    color: null,
    isExplicit: false,
    stripeHex: null,
    washHex: null,
    titlebarHex: null,
    setColor: vi.fn(),
    ...overrides,
  };
}

/** Install a bridge whose `servers.list` resolves the given list (`null` =
 *  rejected call, i.e. an older shell / denial). `withAdd` includes the
 *  optional `add` invoker (newer shells — drives the `+ Add Host…` footer);
 *  `withAddDirect` includes the additive `addDirect` invoker (the in-place
 *  Add Host dialog fork); `withReorder` includes the optional `reorder`
 *  invoker (drives the drag grip + ⌥↑/⌥↓ move); `withRemove`/`withRename`
 *  include the optional `remove`/`rename` invokers (the Disconnect icon +
 *  inline rename). Returns the spies for call-count/payload assertions. */
function shellBridge(
  servers: unknown[] | null,
  platform = "darwin",
  withAdd = false,
  withReorder = false,
  withRemove = false,
  withRename = false,
  withRemoveConfirmed = withRemove,
  withSetUrl = withRename,
  withAddDirect = false,
) {
  const list = vi.fn(() =>
    servers === null
      ? Promise.reject(new Error("ipc gone"))
      : Promise.resolve({ ok: true, servers }),
  );
  const switchFn = vi.fn(() => Promise.resolve({ ok: true }));
  const add = vi.fn(() => Promise.resolve({ ok: true }));
  // Typed Promise<unknown> so both { ok: true } and { ok: false, error } mock
  // resolutions assign cleanly (the footer-fork failure test).
  const addDirect = vi.fn((): Promise<unknown> => Promise.resolve({ ok: true }));
  const reorder = vi.fn(() => Promise.resolve({ ok: true }));
  const remove = vi.fn(() => Promise.resolve({ ok: true }));
  const removeConfirmed = vi.fn(() => Promise.resolve({ ok: true }));
  const rename = vi.fn(() => Promise.resolve({ ok: true }));
  const setUrl = vi.fn(() => Promise.resolve({ ok: true }));
  window.runkitShell = {
    version: "1.2.3",
    platform,
    servers: {
      list,
      switch: switchFn,
      ...(withAdd ? { add } : {}),
      ...(withAddDirect ? { addDirect } : {}),
      ...(withReorder ? { reorder } : {}),
      ...(withRemove ? { remove } : {}),
      ...(withRemoveConfirmed ? { removeConfirmed } : {}),
      ...(withRename ? { rename } : {}),
      ...(withSetUrl ? { setUrl } : {}),
    },
  };
  return { list, switch: switchFn, add, addDirect, reorder, remove, removeConfirmed, rename, setUrl };
}

function renderStrip(accent: InstanceAccent = accentValue(), title?: string) {
  return render(
    <ThemeProvider>
      <ToastProvider>
        <InstanceAccentValueProvider value={accent}>
          <ShellTitlebarStrip title={title} />
        </InstanceAccentValueProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
}

const hosts = [
  { id: "a", name: "studio-mac", url: "http://a:3000", active: true },
  { id: "b", name: "lab", url: "http://b:3000", active: false },
];

/** Render with a populated bridge and wait for the mount fetch to enable the
 *  switcher trigger. */
async function renderInteractive(
  list: unknown[] = hosts,
  platform = "darwin",
  withAdd = false,
  withReorder = false,
  withRemove = false,
  withRename = false,
  withRemoveConfirmed = withRemove,
  withSetUrl = withRename,
  withAddDirect = false,
) {
  const bridge = shellBridge(
    list,
    platform,
    withAdd,
    withReorder,
    withRemove,
    withRename,
    withRemoveConfirmed,
    withSetUrl,
    withAddDirect,
  );
  renderStrip();
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Host menu" })).toBeInTheDocument();
  });
  return bridge;
}

beforeEach(() => {
  localStorage.clear();
  mockMatchMedia();
});

afterEach(() => {
  cleanup();
  delete window.runkitShell;
  vi.unstubAllGlobals();
  document.documentElement.classList.remove(SHELL_STRIP_MARKER_CLASS);
});

describe("ShellTitlebarStrip", () => {
  it("marks <html> with the rk-shell-strip class while mounted (version-skew fallback key)", () => {
    shellBridge([]);
    const { unmount } = renderStrip();
    expect(document.documentElement.classList.contains(SHELL_STRIP_MARKER_CLASS)).toBe(true);
    unmount();
    expect(document.documentElement.classList.contains(SHELL_STRIP_MARKER_CLASS)).toBe(false);
  });

  it("names the active shell host in the nameplate from servers.list", async () => {
    shellBridge(hosts);
    renderStrip();
    await waitFor(() => {
      expect(screen.getByTestId("shell-nameplate-name")).toHaveTextContent("studio-mac");
    });
  });

  it("falls back to location.hostname when the list call fails (older shell / denial)", async () => {
    shellBridge(null);
    renderStrip();
    await waitFor(() => {
      expect(screen.getByText(window.location.hostname)).toBeInTheDocument();
    });
  });

  it("paints the interactive band neutral chrome — the host color is the light, not the fill", async () => {
    await renderInteractive();
    const strip = screen.getByTestId("shell-titlebar-strip");
    const chrome = deriveUIColors(DEFAULT_DARK_THEME.palette, "dark").bgChrome;
    const n = parseInt(chrome.slice(1), 16);
    expect(strip.style.backgroundColor).toBe(`rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`);
    expect(strip.className).toContain("rk-shell-drag");
  });

  it("keeps today's accent blend on the degraded (no switcher) band", () => {
    shellBridge([]);
    renderStrip(accentValue({ color: "4", titlebarHex: "#3a2b4c" }));
    const strip = screen.getByTestId("shell-titlebar-strip");
    expect(strip.style.backgroundColor).toBe("rgb(58, 43, 76)");
  });

  it("falls back to the derived chrome (still draggable) on the degraded band when no accent is set", () => {
    shellBridge([]);
    renderStrip();
    const strip = screen.getByTestId("shell-titlebar-strip");
    const chrome = deriveUIColors(DEFAULT_DARK_THEME.palette, "dark").bgChrome;
    const n = parseInt(chrome.slice(1), 16);
    expect(strip.style.backgroundColor).toBe(`rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`);
    expect(strip.className).toContain("rk-shell-drag");
  });

  it("insets the row 80px from the left on darwin (traffic lights) and keeps a right gutter", async () => {
    await renderInteractive();
    const strip = screen.getByTestId("shell-titlebar-strip");
    expect(strip.style.paddingLeft).toBe("80px");
    expect(strip.style.paddingRight).toBe("12px");
  });
});

// A popout window's strip is its visible title bar: it names the popped tab,
// session and server, and offers no host switcher.
describe("ShellTitlebarStrip in a popout window", () => {
  it("shows the popout title instead of the host and renders no switcher", async () => {
    const { list } = shellBridge(hosts);
    renderStrip(accentValue(), "beta #2 \u2014 session main \u00b7 server work");
    await waitFor(() => {
      expect(list).toHaveBeenCalled();
    });
    expect(screen.getByTestId("shell-titlebar-popout-title")).toHaveTextContent(
      "beta #2 \u2014 session main \u00b7 server work",
    );
    expect(screen.queryByText("studio-mac")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Host menu" })).not.toBeInTheDocument();
  });
});

describe("ShellTitlebarStrip host switcher (260731-4bqi)", () => {
  it("keeps the static non-interactive label on an older shell without the servers group", async () => {
    window.runkitShell = { version: "0.9.0", platform: "darwin" };
    renderStrip();
    await waitFor(() => {
      expect(screen.getByText(window.location.hostname)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps the static label when the bridge answers an empty list (nothing to switch to)", async () => {
    const { list } = shellBridge([]);
    renderStrip();
    await waitFor(() => {
      expect(list).toHaveBeenCalled();
    });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders the `+` square as the menu opener — a no-drag island with haspopup", async () => {
    await renderInteractive();
    const plus = screen.getByRole("button", { name: "Host menu" });
    expect(plus).toHaveAttribute("aria-haspopup", "menu");
    expect(plus.parentElement?.className).toContain("rk-shell-no-drag");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens the menu on click and refetches the host list (fresh servers.list call)", async () => {
    const bridge = await renderInteractive();
    expect(bridge.list).toHaveBeenCalledTimes(1); // mount fetch (label + gate)
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    expect(bridge.list).toHaveBeenCalledTimes(2); // refetch on open
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
  });

  it("renders row anatomy: accent ✓ on the active host, dimmed origin, darwin accelerator hints", async () => {
    await renderInteractive();
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    const rows = screen.getAllByRole("menuitemradio");
    // Active row: ✓ marker + accent color + name + origin + ⌥⌘1, with the
    // single-select state exposed to AT via aria-checked (menuitemradio).
    expect(rows[0].textContent).toContain("✓");
    expect(rows[0]).toHaveAttribute("aria-checked", "true");
    expect(rows[1]).toHaveAttribute("aria-checked", "false");
    expect(rows[0].className).toContain("text-accent");
    expect(rows[0].textContent).toContain("studio-mac");
    expect(rows[0].textContent).toContain("http://a:3000");
    expect(rows[0].textContent).toContain("⌥⌘1");
    // Inactive row: no ✓, no accent, second hint.
    expect(rows[1].textContent).not.toContain("✓");
    expect(rows[1].className).not.toContain("text-accent");
    expect(rows[1].textContent).toContain("lab");
    expect(rows[1].textContent).toContain("http://b:3000");
    expect(rows[1].textContent).toContain("⌥⌘2");
  });

  it("renders Alt hints on non-darwin platforms (from the bridge's platform field)", async () => {
    await renderInteractive(hosts, "win32");
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    const rows = screen.getAllByRole("menuitemradio");
    expect(rows[0].textContent).toContain("Alt+1");
    expect(rows[1].textContent).toContain("Alt+2");
  });

  it("selecting a host closes the menu and hands off to servers.switch (no optimistic UI)", async () => {
    const bridge = await renderInteractive();
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    fireEvent.click(screen.getAllByRole("menuitemradio")[1]);
    expect(bridge.switch).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    // The nameplate still names the active host — the page swap is shell-side.
    expect(screen.getByTestId("shell-nameplate-name")).toHaveTextContent("studio-mac");
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    await renderInteractive();
    const trigger = screen.getByRole("button", { name: "Host menu" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("moves focus with ArrowDown, wrapping over the row set", async () => {
    await renderInteractive();
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    const rows = screen.getAllByRole("menuitemradio");
    // Focus lands on the active row (index 0) on open.
    await waitFor(() => {
      expect(document.activeElement).toBe(rows[0]);
    });
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[0]); // wraparound
  });

  it("closes on an outside mousedown", async () => {
    await renderInteractive();
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("keeps the last known list when the open-time refetch is denied (null keeps rows)", async () => {
    // list resolves the full set once (mount), then rejects (open refetch).
    const list = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => Promise.resolve({ ok: true, servers: hosts }))
      .mockImplementation(() => Promise.reject(new Error("ipc gone")));
    const switchFn = vi.fn(() => Promise.resolve({ ok: true }));
    window.runkitShell = {
      version: "1.2.3",
      platform: "darwin",
      servers: { list, switch: switchFn },
    };
    renderStrip();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Host menu" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    expect(list).toHaveBeenCalledTimes(2);
    // The denied refetch resolves null shell-wrapper-side; the menu keeps the
    // mount-time rows rather than blanking.
    await waitFor(() => {
      expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
    });
  });

  it("re-clamps the roving tabindex when the open-time refetch shrinks the list", async () => {
    // Active host LAST so the focus seat opens at index 2 — beyond the
    // refetched single-row list. Without the clamp no row carries tabIndex=0
    // and focus falls to <body> (review cycle 1, must-fix a).
    const three = [
      { id: "a", name: "alpha", url: "http://a:3000", active: false },
      { id: "b", name: "beta", url: "http://b:3000", active: false },
      { id: "c", name: "gamma", url: "http://c:3000", active: true },
    ];
    const one = [{ id: "a", name: "alpha", url: "http://a:3000", active: false }];
    const list = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => Promise.resolve({ ok: true, servers: three }))
      .mockImplementation(() => Promise.resolve({ ok: true, servers: one }));
    window.runkitShell = {
      version: "1.2.3",
      platform: "darwin",
      servers: { list, switch: vi.fn(() => Promise.resolve({ ok: true })) },
    };
    renderStrip();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Host menu" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    await waitFor(() => {
      expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
    });
    // The seat clamps onto the surviving row: it stays the roving-tabindex
    // stop and receives focus.
    const row = screen.getAllByRole("menuitemradio")[0];
    await waitFor(() => {
      expect(row).toHaveAttribute("tabindex", "0");
      expect(document.activeElement).toBe(row);
    });
  });

  it("closes and releases key handling when the open-time refetch empties the list", async () => {
    const list = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => Promise.resolve({ ok: true, servers: hosts }))
      .mockImplementation(() => Promise.resolve({ ok: true, servers: [] }));
    window.runkitShell = {
      version: "1.2.3",
      platform: "darwin",
      servers: { list, switch: vi.fn(() => Promise.resolve({ ok: true })) },
    };
    renderStrip();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Host menu" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    // The emptied list downgrades the strip to the static label AND releases
    // the open state (no phantom open menu, review cycle 1, must-fix b).
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });
    // Arrow keys are NOT swallowed app-wide: the capture-phase handler is
    // torn down / guarded, so the event keeps its default behavior
    // (fireEvent returns false when a handler called preventDefault).
    expect(fireEvent.keyDown(document.body, { key: "ArrowDown" })).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: "ArrowUp" })).toBe(true);
  });

  it("drops an out-of-order stale refetch resolution (freshest list wins)", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const list = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    window.runkitShell = {
      version: "1.2.3",
      platform: "darwin",
      servers: { list, switch: vi.fn(() => Promise.resolve({ ok: true })) },
    };
    renderStrip();
    // Mount fetch resolves the two-host list.
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolvers[0]({ ok: true, servers: hosts });
    });
    const trigger = screen.getByRole("button", { name: "Host menu" });
    // Open #1 leaves its refetch in flight; close; open #2 refetches again.
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(list).toHaveBeenCalledTimes(3);
    // Open #2's refetch resolves FIRST, with the fresh three-host list.
    const fresh = [...hosts, { id: "c", name: "extra", url: "http://c:3000", active: false }];
    await act(async () => {
      resolvers[2]({ ok: true, servers: fresh });
    });
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
    // The STALE open-#1 refetch resolves LAST — the sequence guard drops it
    // (review cycle 1, should-fix c: freshest list stays rendered).
    await act(async () => {
      resolvers[1]({ ok: true, servers: hosts });
    });
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
  });

  it("surfaces an error toast when the switch is denied", async () => {
    const switchFn = vi.fn(() => Promise.resolve({ ok: false, error: "Unknown host" }));
    const list = vi.fn(() => Promise.resolve({ ok: true, servers: hosts }));
    window.runkitShell = {
      version: "1.2.3",
      platform: "darwin",
      servers: { list, switch: switchFn },
    };
    renderStrip();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Host menu" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    fireEvent.click(screen.getAllByRole("menuitemradio")[1]);
    await waitFor(() => {
      expect(screen.getByText("Host switch failed")).toBeInTheDocument();
    });
  });

  it("omits the Add Host footer when the bridge lacks the add invoker (older shell)", async () => {
    await renderInteractive();
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Add Host…" })).not.toBeInTheDocument();
  });

  it("renders the Add Host footer when the bridge carries add; click closes and invokes it", async () => {
    const bridge = await renderInteractive(hosts, "darwin", true);
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    const footer = screen.getByRole("menuitem", { name: "Add Host…" });
    fireEvent.click(footer);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(bridge.add).toHaveBeenCalledTimes(1);
    expect(bridge.switch).not.toHaveBeenCalled();
  });

  it("includes the Add Host footer in the arrow-key roving cycle (the `+` opener seats it first)", async () => {
    await renderInteractive(hosts, "darwin", true);
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    const rows = screen.getAllByRole("menuitemradio");
    const footer = screen.getByRole("menuitem", { name: "Add Host…" });
    // `+` opens with the footer focused when an add path exists.
    await waitFor(() => {
      expect(document.activeElement).toBe(footer);
    });
    // ArrowDown from the footer (the cycle's last stop) wraps to the first row.
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(footer);
  });

  it("surfaces an error toast when the add call is denied", async () => {
    const bridge = await renderInteractive(hosts, "darwin", true);
    bridge.add.mockResolvedValue({ ok: false });
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add Host…" }));
    await waitFor(() => {
      expect(screen.getByText("Shell add host failed")).toBeInTheDocument();
    });
  });

  it("opens the shared dialog in add mode on an addDirect shell — no page swap, menu stays open", async () => {
    const bridge = await renderInteractive(
      hosts, "darwin", false, false, false, false, false, false, true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    // The union gate renders the footer without the `add` invoker.
    const footer = screen.getByRole("menuitem", { name: "Add Host…" });
    fireEvent.click(footer);
    const dialog = screen.getByRole("dialog", { name: "Add host" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("");
    expect(within(dialog).getByRole("textbox", { name: "URL" })).toHaveValue("");
    // In place: the menu never closed and nothing navigated away.
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(bridge.switch).not.toHaveBeenCalled();
  });

  it("submits through addDirect and closes the dialog on success", async () => {
    const bridge = await renderInteractive(
      hosts, "darwin", false, false, false, false, false, false, true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add Host…" }));
    const dialog = screen.getByRole("dialog", { name: "Add host" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "URL" }), {
      target: { value: "http://c:3000" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Host" }));
    await waitFor(() => {
      expect(bridge.addDirect).toHaveBeenCalledWith("", "http://c:3000");
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("a main-side add failure renders inline in the dialog — no toast, dialog stays open", async () => {
    const bridge = await renderInteractive(
      hosts, "darwin", false, false, false, false, false, false, true,
    );
    bridge.addDirect.mockResolvedValue({ ok: false, error: "No response from http://c:3000 within 5s" });
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add Host…" }));
    const dialog = screen.getByRole("dialog", { name: "Add host" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "URL" }), {
      target: { value: "http://c:3000" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Host" }));
    await waitFor(() => {
      expect(screen.getByText("No response from http://c:3000 within 5s")).toBeInTheDocument();
    });
    expect(screen.getByRole("dialog", { name: "Add host" })).toBeInTheDocument();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("prefers the in-place dialog when the shell carries both add paths", async () => {
    const bridge = await renderInteractive(
      hosts, "darwin", true, false, false, false, false, false, true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add Host…" }));
    expect(screen.getByRole("dialog", { name: "Add host" })).toBeInTheDocument();
    expect(bridge.add).not.toHaveBeenCalled();
  });

  it("closing the menu also closes the add dialog", async () => {
    await renderInteractive(hosts, "darwin", false, false, false, false, false, false, true);
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add Host…" }));
    expect(screen.getByRole("dialog", { name: "Add host" })).toBeInTheDocument();
    fireEvent.mouseDown(document.body); // outside close while the dialog is up
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("ShellTitlebarStrip host menu — accent bars, waiting counts, reorder (1i7j)", () => {
  const coloredHosts = [
    { id: "a", name: "studio-mac", url: "http://a:3000", active: true, accentColor: "#8b7ff0" },
    { id: "b", name: "lab", url: "http://b:3000", active: false },
    { id: "c", name: "buildbox", url: "http://c:3000", active: false, accentColor: "#4a4468" },
  ];

  it("renders the accent edge bar for hosts with a color, none for colorless rows", async () => {
    await renderInteractive(coloredHosts);
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    const rows = screen.getAllByRole("menuitemradio");
    const barA = rows[0].querySelector("[data-testid='shell-host-accent-bar']");
    expect(barA).not.toBeNull();
    expect((barA as HTMLElement).style.backgroundColor).toBe("rgb(139, 127, 240)");
    expect(rows[1].querySelector("[data-testid='shell-host-accent-bar']")).toBeNull();
    const barC = rows[2].querySelector("[data-testid='shell-host-accent-bar']");
    expect((barC as HTMLElement).style.backgroundColor).toBe("rgb(74, 68, 104)");
    // The bar overlays the left edge — the row content keeps its alignment.
    expect(rows[1].textContent).toContain("lab");
    expect(rows[1].textContent).toContain("http://b:3000");
  });

  it("renders no bar for a non-hex accentColor (never reaches style interpolation)", async () => {
    await renderInteractive([
      { id: "a", name: "evil", url: "http://a:3000", active: true, accentColor: "javascript:alert(1)" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    expect(screen.queryByTestId("shell-host-accent-bar")).not.toBeInTheDocument();
  });

  it("renders the amber waiting chip on background rows only, before the hint", async () => {
    await renderInteractive([
      { id: "a", name: "studio-mac", url: "http://a:3000", active: true, waiting: 2 },
      { id: "b", name: "lab", url: "http://b:3000", active: false, waiting: 3 },
      { id: "c", name: "quiet", url: "http://c:3000", active: false },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    const rows = screen.getAllByRole("menuitemradio");
    // Active row: the count is suppressed (the dock badge is its surface).
    expect(rows[0].textContent).not.toContain("●");
    // Background row: amber ● N between the origin and the accelerator hint.
    expect(rows[1].textContent).toContain("● 3");
    const chip = screen.getByText("● 3");
    expect(chip.className).toContain("text-amber-600");
    expect(rows[1].textContent?.indexOf("● 3")).toBeLessThan(
      rows[1].textContent?.indexOf("⌥⌘2") ?? Infinity,
    );
    // Absent count renders nothing extra.
    expect(rows[2].textContent).not.toContain("●");
  });

  it("⌥↑ moves the focused row with one invoke per press, live hint re-numbering, focus follows", async () => {
    const four = [
      { id: "a", name: "alpha", url: "http://a:3000", active: true },
      { id: "b", name: "beta", url: "http://b:3000", active: false },
      { id: "c", name: "gamma", url: "http://c:3000", active: false },
      { id: "d", name: "delta", url: "http://d:3000", active: false },
    ];
    const bridge = await renderInteractive(four, "darwin", false, true);
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    let rows = screen.getAllByRole("menuitemradio");
    await waitFor(() => {
      expect(document.activeElement).toBe(rows[0]); // active row seeded
    });
    fireEvent.keyDown(document, { key: "ArrowDown" }); // focus beta (index 1)
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(document, { key: "ArrowUp", altKey: true });
    expect(bridge.reorder).toHaveBeenCalledTimes(1);
    expect(bridge.reorder).toHaveBeenCalledWith("b", 0);
    // Optimistic local reorder: beta first, hints re-numbered.
    rows = screen.getAllByRole("menuitemradio");
    expect(rows[0].textContent).toContain("beta");
    expect(rows[0].textContent).toContain("⌥⌘1");
    expect(rows[1].textContent).toContain("alpha");
    expect(rows[1].textContent).toContain("⌥⌘2");
    // Focus stays on the moved row.
    expect(document.activeElement).toBe(rows[0]);
    expect(rows[0]).toHaveAttribute("tabindex", "0");
  });

  it("⌥↑/⌥↓ at the list edges is a no-op (no invoke, no wrap, key swallowed)", async () => {
    const bridge = await renderInteractive(hosts, "darwin", false, true);
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    const rows = screen.getAllByRole("menuitemradio");
    await waitFor(() => {
      expect(document.activeElement).toBe(rows[0]);
    });
    // First row, move up: swallowed, no invoke (fireEvent false = preventDefaulted).
    expect(fireEvent.keyDown(document, { key: "ArrowUp", altKey: true })).toBe(false);
    expect(bridge.reorder).not.toHaveBeenCalled();
    expect(screen.getAllByRole("menuitemradio")[0].textContent).toContain("studio-mac");
    // Last row, move down: same.
    fireEvent.keyDown(document, { key: "ArrowDown" }); // focus lab (index 1)
    expect(fireEvent.keyDown(document, { key: "ArrowDown", altKey: true })).toBe(false);
    expect(bridge.reorder).not.toHaveBeenCalled();
  });

  it("⌥↑/⌥↓ on the Add-Host footer falls through to the roving cycle (footer not movable)", async () => {
    const bridge = await renderInteractive(hosts, "darwin", true, true);
    fireEvent.contextMenu(screen.getAllByTestId("shell-host-square")[0]);
    const rows = screen.getAllByRole("menuitemradio");
    const footer = screen.getByRole("menuitem", { name: "Add Host…" });
    await waitFor(() => {
      expect(document.activeElement).toBe(rows[0]);
    });
    fireEvent.keyDown(document, { key: "ArrowUp" }); // wrap to footer
    expect(document.activeElement).toBe(footer);
    fireEvent.keyDown(document, { key: "ArrowDown", altKey: true }); // roves, never moves
    expect(bridge.reorder).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(rows[0]);
  });

  it("without the reorder capability, ⌥↑/⌥↓ fall through to today's roving focus (no grips)", async () => {
    await renderInteractive(hosts); // no reorder invoker
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    const rows = screen.getAllByRole("menuitemradio");
    await waitFor(() => {
      expect(document.activeElement).toBe(rows[0]);
    });
    expect(screen.queryByText("⋮⋮")).not.toBeInTheDocument();
    for (const row of rows) expect(row).toHaveAttribute("draggable", "false");
    fireEvent.keyDown(document, { key: "ArrowDown", altKey: true });
    expect(document.activeElement).toBe(rows[1]); // plain roving move
  });

  it("drag-drop commits exactly one reorder invocation with optimistic order", async () => {
    const four = [
      { id: "a", name: "alpha", url: "http://a:3000", active: true },
      { id: "b", name: "beta", url: "http://b:3000", active: false },
      { id: "c", name: "gamma", url: "http://c:3000", active: false },
      { id: "d", name: "delta", url: "http://d:3000", active: false },
    ];
    const bridge = await renderInteractive(four, "darwin", false, true);
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    // Grips render (hover-revealed) and rows are draggable.
    expect(screen.getAllByText("⋮⋮")).toHaveLength(4);
    const rows = screen.getAllByRole("menuitemradio");
    for (const row of rows) expect(row).toHaveAttribute("draggable", "true");
    const dataTransfer = {
      setData: vi.fn(),
      types: ["application/x-shell-host-reorder"],
      effectAllowed: "",
      dropEffect: "",
    };
    // Drag row 4 (delta) onto row 1 (alpha) — insert-before → index 0.
    fireEvent.dragStart(rows[3], { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith("application/x-shell-host-reorder", "d");
    fireEvent.dragOver(rows[0], { dataTransfer });
    fireEvent.drop(rows[0], { dataTransfer });
    fireEvent.dragEnd(rows[3], { dataTransfer });
    expect(bridge.reorder).toHaveBeenCalledTimes(1);
    expect(bridge.reorder).toHaveBeenCalledWith("d", 0);
    // Optimistic order renders with re-numbered hints.
    const reordered = screen.getAllByRole("menuitemradio");
    expect(reordered[0].textContent).toContain("delta");
    expect(reordered[0].textContent).toContain("⌥⌘1");
    expect(reordered[1].textContent).toContain("alpha");
  });

  it("a drag started from the ⋮⋮ grip itself commits the reorder (the grip is a real handle)", async () => {
    const four = [
      { id: "a", name: "alpha", url: "http://a:3000", active: true },
      { id: "b", name: "beta", url: "http://b:3000", active: false },
      { id: "c", name: "gamma", url: "http://c:3000", active: false },
      { id: "d", name: "delta", url: "http://d:3000", active: false },
    ];
    const bridge = await renderInteractive(four, "darwin", false, true);
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    const grips = screen.getAllByTestId("shell-host-grip");
    expect(grips).toHaveLength(4);
    // The grip must be draggable itself and must NOT swallow pointer events:
    // it sits on the cluster (a sibling of the row button), so a
    // pointer-events-none grip has no draggable ancestor and can never
    // start a drag.
    for (const grip of grips) {
      expect(grip).toHaveAttribute("draggable", "true");
      expect(grip.className).not.toContain("pointer-events-none");
    }
    const dataTransfer = {
      setData: vi.fn(),
      types: ["application/x-shell-host-reorder"],
      effectAllowed: "",
      dropEffect: "",
    };
    // Drag row 4 (delta) BY ITS GRIP onto row 1 (alpha) — the dragstart
    // bubbles from the grip to the row wrapper's shared handler.
    fireEvent.dragStart(grips[3], { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith("application/x-shell-host-reorder", "d");
    const rows = screen.getAllByRole("menuitemradio");
    fireEvent.dragOver(rows[0], { dataTransfer });
    fireEvent.drop(rows[0], { dataTransfer });
    fireEvent.dragEnd(grips[3], { dataTransfer });
    expect(bridge.reorder).toHaveBeenCalledTimes(1);
    expect(bridge.reorder).toHaveBeenCalledWith("d", 0);
    expect(screen.getAllByRole("menuitemradio")[0].textContent).toContain("delta");
  });

  it("a denied drag-drop reorder surfaces the error toast and refetches the list", async () => {
    const bridge = await renderInteractive(hosts, "darwin", false, true);
    bridge.reorder.mockResolvedValue({ ok: false });
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    expect(bridge.list).toHaveBeenCalledTimes(2); // mount + open refetch
    const rows = screen.getAllByRole("menuitemradio");
    const dataTransfer = {
      setData: vi.fn(),
      types: ["application/x-shell-host-reorder"],
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(rows[1], { dataTransfer });
    fireEvent.dragOver(rows[0], { dataTransfer });
    fireEvent.drop(rows[0], { dataTransfer });
    await waitFor(() => {
      expect(screen.getByText("Shell host reorder failed")).toBeInTheDocument();
    });
    expect(bridge.list).toHaveBeenCalledTimes(3); // failure refetch reconciles
  });

  it("older-shell degradation: a plain 4-field projection renders today's menu with no affordances", async () => {
    // list/switch only (no add, no reorder), entries without accentColor/waiting.
    await renderInteractive(hosts);
    fireEvent.click(screen.getByRole("button", { name: "Host menu" }));
    const rows = screen.getAllByRole("menuitemradio");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("✓");
    expect(rows[0].textContent).toContain("⌥⌘1");
    expect(rows[1].textContent).toContain("⌥⌘2");
    expect(screen.queryByTestId("shell-host-accent-bar")).not.toBeInTheDocument();
    expect(screen.queryByText("⋮⋮")).not.toBeInTheDocument();
    expect(screen.queryByText(/●/)).not.toBeInTheDocument();
    for (const row of rows) expect(row).toHaveAttribute("draggable", "false");
    expect(screen.queryByRole("menuitem", { name: "Add Host…" })).not.toBeInTheDocument();
  });
});

describe("ShellTitlebarStrip host menu — Remove + Edit Host dialog", () => {
  /** Bridge carrying every optional invoker. */
  const renderFull = (list: unknown[] = hosts) =>
    renderInteractive(list, "darwin", true, true, true, true);

  // Right-click the first square: the menu opens with that host's row focused
  // (the `+` opener seats the Add Host footer first on a shell with an add path).
  const openMenu = () => fireEvent.contextMenu(screen.getAllByTestId("shell-host-square")[0]);

  it("renders the Edit and Remove icons per row when the bridge carries both invokers", async () => {
    await renderFull();
    openMenu();
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(2);
  });

  it("gates each icon on its own capability (remove without rename renders only Remove)", async () => {
    await renderInteractive(hosts, "darwin", false, false, true, false);
    openMenu();
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("renders plain rows on an older shell — no icons, and the keys fall through unswallowed", async () => {
    await renderInteractive(hosts); // list/switch only
    openMenu();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    const rows = screen.getAllByRole("menuitemradio");
    await waitFor(() => expect(document.activeElement).toBe(rows[0]));
    expect(fireEvent.keyDown(document, { key: "Backspace" })).toBe(true);
    expect(fireEvent.keyDown(document, { key: "F2" })).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Remove icon opens the themed confirm; confirming invokes removeConfirmed (menu stays open)", async () => {
    const bridge = await renderFull();
    openMenu();
    expect(bridge.list).toHaveBeenCalledTimes(2); // mount + open refetch
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]);
    const dialog = screen.getByRole("dialog", { name: "Remove host" });
    expect(dialog.textContent).toContain("lab");
    expect(bridge.removeConfirmed).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(bridge.removeConfirmed).toHaveBeenCalledTimes(1);
    expect(bridge.removeConfirmed).toHaveBeenCalledWith("b");
    expect(bridge.remove).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(bridge.switch).not.toHaveBeenCalled();
  });

  it("cancelling the remove confirm invokes nothing and keeps the menu open", async () => {
    const bridge = await renderFull();
    openMenu();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Remove host" });
    // Focus trap seats on Cancel — the Cancel-default contract.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(bridge.removeConfirmed).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
  });

  it("falls back to the native-confirm channel on a shell without removeConfirmed (no SPA dialog)", async () => {
    const bridge = await renderInteractive(hosts, "darwin", false, false, true, false, false);
    openMenu();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(bridge.remove).toHaveBeenCalledTimes(1);
    expect(bridge.remove).toHaveBeenCalledWith("b");
    expect(bridge.removeConfirmed).not.toHaveBeenCalled();
    const rows = screen.getAllByRole("menuitemradio");
    rows[0].focus();
    expect(fireEvent.keyDown(document, { key: "Delete" })).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(bridge.remove).toHaveBeenCalledTimes(2);
    expect(bridge.remove).toHaveBeenLastCalledWith("a");
  });

  it("a failed remove surfaces the toast and refetches", async () => {
    const bridge = await renderFull();
    bridge.removeConfirmed.mockResolvedValue({ ok: false });
    openMenu();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Shell host remove failed")).toBeInTheDocument();
    });
    await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(3));
  });

  it("Delete/Backspace opens the focused row's remove confirm; keys suspend while it is up; the footer is not bound", async () => {
    const bridge = await renderFull();
    openMenu();
    const rows = screen.getAllByRole("menuitemradio");
    await waitFor(() => expect(document.activeElement).toBe(rows[0]));
    expect(fireEvent.keyDown(document, { key: "Backspace" })).toBe(false); // swallowed
    const dialog = screen.getByRole("dialog", { name: "Remove host" });
    expect(dialog.textContent).toContain("studio-mac");
    fireEvent.keyDown(document, { key: "Delete" }); // suspended — no new target
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getAllByRole("menuitemradio")[0]),
    );
    expect(bridge.removeConfirmed).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Delete" });
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }),
    );
    expect(bridge.removeConfirmed).toHaveBeenCalledTimes(1);
    expect(bridge.removeConfirmed).toHaveBeenCalledWith("a");
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Add Host…" }));
    expect(fireEvent.keyDown(document, { key: "Delete" })).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(bridge.removeConfirmed).toHaveBeenCalledTimes(1);
  });

  it("the Edit icon opens the Edit Host dialog with name and URL prefilled", async () => {
    await renderFull();
    openMenu();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    const dialog = screen.getByRole("dialog", { name: "Edit host" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("lab");
    expect(within(dialog).getByRole("textbox", { name: "URL" })).toHaveValue("http://b:3000");
  });

  it("F2 on a focused row opens its Edit Host dialog", async () => {
    await renderFull();
    openMenu();
    const rows = screen.getAllByRole("menuitemradio");
    await waitFor(() => expect(document.activeElement).toBe(rows[0]));
    expect(fireEvent.keyDown(document, { key: "F2" })).toBe(false);
    const dialog = screen.getByRole("dialog", { name: "Edit host" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("studio-mac");
  });

  it("Save commits a changed name: trimmed rename invoke, optimistic update, refetch, menu open", async () => {
    const bridge = await renderFull();
    openMenu();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Edit host" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "  studio  " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(bridge.rename).toHaveBeenCalledTimes(1);
    expect(bridge.rename).toHaveBeenCalledWith("a", "studio");
    expect(bridge.setUrl).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getAllByRole("menuitemradio")[0].textContent).toContain("studio");
    await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("Save commits a changed URL through setUrl (normalized to the origin)", async () => {
    const bridge = await renderFull();
    openMenu();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Edit host" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "URL" }), {
      target: { value: "http://new-box:4100/some/path" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(bridge.setUrl).toHaveBeenCalledTimes(1);
    expect(bridge.setUrl).toHaveBeenCalledWith("a", "http://new-box:4100");
    expect(bridge.rename).not.toHaveBeenCalled();
  });

  it("an invalid URL keeps the dialog open with an inline error and no invoke", async () => {
    const bridge = await renderFull();
    openMenu();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Edit host" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "URL" }), {
      target: { value: "not-a-url" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(screen.getByRole("dialog", { name: "Edit host" })).toBeInTheDocument();
    expect(dialog.textContent).toContain("Enter a full http(s) URL");
    expect(bridge.rename).not.toHaveBeenCalled();
    expect(bridge.setUrl).not.toHaveBeenCalled();
  });

  it("Save with nothing changed (or an emptied name) invokes nothing", async () => {
    const bridge = await renderFull();
    openMenu();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    let dialog = screen.getByRole("dialog", { name: "Edit host" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(bridge.rename).not.toHaveBeenCalled();
    expect(bridge.setUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    dialog = screen.getByRole("dialog", { name: "Edit host" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "   " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(bridge.rename).not.toHaveBeenCalled();
  });

  it("Save returns focus to the edited row (F2 → Enter round-trip)", async () => {
    await renderFull();
    openMenu();
    const rows = screen.getAllByRole("menuitemradio");
    await waitFor(() => expect(document.activeElement).toBe(rows[0]));
    fireEvent.keyDown(document, { key: "F2" });
    const dialog = screen.getByRole("dialog", { name: "Edit host" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "renamed" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getAllByRole("menuitemradio")[0]),
    );
  });

  it("an untouched URL prefill is never parsed — a malformed stored url cannot block a name-only Save", async () => {
    const bridge = await renderInteractive(
      [{ id: "a", name: "studio-mac", url: "bad url", active: true }],
      "darwin",
      true,
      true,
      true,
      true,
    );
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit host" });
    // The origin column falls back to the raw string for a malformed url.
    expect(within(dialog).getByRole("textbox", { name: "URL" })).toHaveValue("bad url");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "renamed" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(bridge.rename).toHaveBeenCalledWith("a", "renamed");
    expect(bridge.setUrl).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("without setUrl the URL field is disabled and Save edits the name only", async () => {
    const bridge = await renderInteractive(hosts, "darwin", true, true, true, true, true, false);
    openMenu();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Edit host" });
    expect(within(dialog).getByRole("textbox", { name: "URL" })).toBeDisabled();
    expect(dialog.textContent).toContain("URL editing needs a newer desktop app");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "renamed" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(bridge.rename).toHaveBeenCalledWith("a", "renamed");
    expect(bridge.setUrl).not.toHaveBeenCalled();
  });

  it("a failed rename surfaces the toast and refetches", async () => {
    const bridge = await renderFull();
    bridge.rename.mockResolvedValue({ ok: false });
    openMenu();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Edit host" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), {
      target: { value: "renamed" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.getByText("Shell host rename failed")).toBeInTheDocument();
    });
    await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(3));
  });

  it("closing the menu cancels an open Edit dialog — the row is whole again on reopen", async () => {
    const bridge = await renderFull();
    openMenu();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(screen.getByRole("dialog", { name: "Edit host" })).toBeInTheDocument();
    fireEvent.mouseDown(document.body); // outside close while the dialog is up
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    openMenu();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
    expect(bridge.rename).not.toHaveBeenCalled();
  });

  it("a remove-shrunk refetch reconciles in place and keeps the focus re-clamp guard", async () => {
    const list = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => Promise.resolve({ ok: true, servers: hosts }))
      .mockImplementationOnce(() => Promise.resolve({ ok: true, servers: hosts }))
      .mockImplementation(() => Promise.resolve({ ok: true, servers: [hosts[1]] }));
    const remove = vi.fn(() => Promise.resolve({ ok: true }));
    window.runkitShell = {
      version: "1.2.3",
      platform: "darwin",
      servers: { list, switch: vi.fn(() => Promise.resolve({ ok: true })), removeConfirmed: remove },
    };
    renderStrip();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Host menu" })).toBeInTheDocument();
    });
    openMenu();
    let rows = screen.getAllByRole("menuitemradio");
    await waitFor(() => expect(document.activeElement).toBe(rows[0]));
    fireEvent.keyDown(document, { key: "ArrowDown" }); // seat on row 1 (out of bounds post-shrink)
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }),
    );
    expect(remove).toHaveBeenCalledWith("a");
    await waitFor(() => expect(screen.getAllByRole("menuitemradio")).toHaveLength(1));
    rows = screen.getAllByRole("menuitemradio");
    await waitFor(() => {
      expect(rows[0]).toHaveAttribute("tabindex", "0");
      expect(document.activeElement).toBe(rows[0]);
    });
    expect(rows[0].textContent).toContain("lab");
  });

  it("a remove-emptied refetch closes the menu and releases arrow keys app-wide", async () => {
    const list = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => Promise.resolve({ ok: true, servers: hosts }))
      .mockImplementationOnce(() => Promise.resolve({ ok: true, servers: hosts }))
      .mockImplementation(() => Promise.resolve({ ok: true, servers: [] }));
    const remove = vi.fn(() => Promise.resolve({ ok: true }));
    window.runkitShell = {
      version: "1.2.3",
      platform: "darwin",
      servers: { list, switch: vi.fn(() => Promise.resolve({ ok: true })), removeConfirmed: remove },
    };
    renderStrip();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Host menu" })).toBeInTheDocument();
    });
    openMenu();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }),
    );
    // The emptied list downgrades the strip to the static label (close-on-empty).
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Host menu" })).not.toBeInTheDocument();
    });
    expect(fireEvent.keyDown(document, { key: "ArrowDown" })).toBe(true);
  });
});

describe("ShellTitlebarStrip host-menu seams + digit select inside the menu", () => {
  const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "Host menu" }));

  it("the HOST_MENU_OPEN_EVENT document seam opens the menu (the palette body's path)", async () => {
    await renderInteractive();
    act(() => {
      document.dispatchEvent(new CustomEvent(HOST_MENU_OPEN_EVENT));
    });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("the HOST_MENU_OPEN_EVENT seam is inert while the switcher is not interactive", async () => {
    shellBridge([]);
    renderStrip();
    await waitFor(() => {
      expect(screen.getByText(window.location.hostname)).toBeInTheDocument();
    });
    act(() => {
      document.dispatchEvent(new CustomEvent(HOST_MENU_OPEN_EVENT));
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("a plain digit selects the Nth rendered host (accelerator order) and closes the menu", async () => {
    const bridge = await renderInteractive();
    openMenu();
    fireEvent.keyDown(document, { key: "2", code: "Digit2" });
    expect(bridge.switch).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("a digit past the host count is a no-op that releases the key", async () => {
    const bridge = await renderInteractive();
    openMenu();
    expect(fireEvent.keyDown(document, { key: "7", code: "Digit7" })).toBe(true);
    expect(bridge.switch).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("modified digits are not treated as select (the shell's own accelerators stay untouched)", async () => {
    const bridge = await renderInteractive();
    openMenu();
    fireEvent.keyDown(document, { key: "2", code: "Digit2", altKey: true, metaKey: true });
    fireEvent.keyDown(document, { key: "2", code: "Digit2", shiftKey: true, ctrlKey: true });
    expect(bridge.switch).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("digits reach an open Edit dialog untouched (the dialogOpen guard)", async () => {
    // (list, platform, withAdd, withReorder, withRemove, withRename)
    const bridge = await renderInteractive(hosts, "darwin", false, false, false, true);
    openMenu();
    const rows = screen.getAllByRole("menuitemradio");
    await waitFor(() => {
      expect(document.activeElement).toBe(rows[0]);
    });
    fireEvent.keyDown(document, { key: "F2" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "1", code: "Digit1" });
    expect(bridge.switch).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("the action cluster reveals on hover + :focus-visible, never plain focus-within (issue 3)", async () => {
    await renderInteractive(hosts, "darwin", false, false, true, true);
    openMenu();
    // The cluster chip reveals via the has(:focus-visible) variant, so the
    // programmatic focus a pointer open places on the active row shows the
    // ⌥⌘n hint, not the pencil/minus cluster; keyboard focus still reveals.
    expect(
      document.querySelector('[class*="group-has-[:focus-visible]:visible"]'),
    ).not.toBeNull();
    // The hint/waiting zones yield under exactly the same conditions.
    expect(
      document.querySelector('[class*="group-has-[:focus-visible]:invisible"]'),
    ).not.toBeNull();
    expect(document.querySelector('[class*="group-focus-within"]')).toBeNull();
  });
});

// ── Host squares, nameplate, key hints, lit band ─────────────────────────────

const threeHosts = [
  { id: "a", name: "studio-mac", url: "http://a:3000", active: true },
  { id: "b", name: "lab", url: "http://b:3000", active: false },
  { id: "c", name: "ws-01", url: "http://c:3000", active: false },
];

interface SquaresBridgeOptions {
  servers?: unknown[];
  platform?: string;
  reorder?: boolean;
  add?: boolean;
  onChanged?: boolean;
  onAttached?: boolean;
  prefs?: { effect: string; motion: string };
}

/** A bridge for the squares/light suites: the base `servers` group plus the
 *  optional reorder/add invokers, the push subscriptions, and the prefs group,
 *  each capturing its callback so a test can fire it. */
function squaresBridge(opts: SquaresBridgeOptions = {}) {
  const list = vi.fn(() => Promise.resolve({ ok: true, servers: opts.servers ?? threeHosts }));
  const switchFn = vi.fn(() => Promise.resolve({ ok: true }));
  const reorder = vi.fn((): Promise<unknown> => Promise.resolve({ ok: true }));
  const add = vi.fn(() => Promise.resolve({ ok: true }));
  const pushed: { changed?: () => void; attached?: (p: unknown) => void } = {};
  const off = vi.fn();
  const servers = {
    list,
    switch: switchFn,
    ...(opts.reorder ? { reorder } : {}),
    ...(opts.add ? { add } : {}),
    ...(opts.onChanged
      ? {
          onChanged: (cb: () => void) => {
            pushed.changed = cb;
            return off;
          },
        }
      : {}),
    ...(opts.onAttached
      ? {
          onAttached: (cb: (p: unknown) => void) => {
            pushed.attached = cb;
            return off;
          },
        }
      : {}),
  };
  window.runkitShell = {
    version: "1.2.3",
    platform: opts.platform ?? "darwin",
    servers,
    ...(opts.prefs
      ? {
          prefs: {
            get: () => Promise.resolve({ ok: true, prefs: { strip: opts.prefs } }),
            set: vi.fn(() => Promise.resolve({ ok: true })),
          },
        }
      : {}),
  };
  return { list, switch: switchFn, reorder, add, pushed, off };
}

async function renderSquares(opts: SquaresBridgeOptions = {}, accent: InstanceAccent = accentValue()) {
  const bridge = squaresBridge(opts);
  renderStrip(accent);
  await waitFor(() => {
    expect(screen.getAllByTestId("shell-host-square").length).toBeGreaterThan(0);
  });
  return bridge;
}

const squareEls = () => screen.getAllByTestId("shell-host-square");
const labels = () => squareEls().map((el) => el.getAttribute("aria-label"));

/** jsdom's matchMedia with an explicit reduced-motion answer. */
function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? reduced : true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })),
  );
}

describe("ShellTitlebarStrip host squares", () => {
  it("renders one square per host in list order inside a labelled toolbar, the active one ringed", async () => {
    await renderSquares();
    expect(screen.getByRole("toolbar", { name: "Hosts" })).toBeInTheDocument();
    expect(labels()).toEqual(["studio-mac", "lab", "ws-01"]);
    const [a, b] = squareEls();
    expect(a).toHaveAttribute("aria-current", "true");
    expect(a.className).toContain("rk-strip-sq-on");
    expect(b).not.toHaveAttribute("aria-current");
    expect(b.className).not.toContain("rk-strip-sq-on");
  });

  it("never draws monogram letters in a square (digits only, revealed on demand)", async () => {
    await renderSquares();
    for (const el of squareEls()) {
      expect(el.textContent).toMatch(/^\d?$/);
    }
    expect(squareEls().map((el) => el.textContent)).toEqual(["1", "2", "3"]);
  });

  it("past the ninth host a square carries no digit (no accelerator)", async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      id: `h${i}`,
      name: `host-${i}`,
      url: `http://h${i}:3000`,
      active: i === 0,
    }));
    await renderSquares({ servers: many });
    const digits = squareEls().map((el) => el.textContent);
    expect(digits.slice(0, 9)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(digits.slice(9)).toEqual(["", ""]);
  });

  it("fills a square with the host's projected color, outlined and neutral when it has none or a non-hex one", async () => {
    await renderSquares({
      servers: [
        { ...threeHosts[0], accentColor: "#8b7ff0" },
        { ...threeHosts[1], accentColor: "#ff00ff" },
        { ...threeHosts[2], accentColor: "red; background: url(x)" },
      ],
    });
    const [a, b, c] = squareEls();
    expect(b.style.backgroundColor).toBe("rgb(255, 0, 255)");
    expect(a.style.backgroundColor).toBe("rgb(139, 127, 240)");
    expect(c.className).toContain("rk-strip-sq-uncolored");
    expect(c.style.backgroundColor).toBe("");
  });

  it("paints THIS view's own square with the live accent so a Settings pick repaints at once", async () => {
    await renderSquares(
      { servers: [{ ...threeHosts[0], accentColor: "#8b7ff0" }, threeHosts[1]] },
      accentValue({ stripeHex: "#112233" }),
    );
    expect(squareEls()[0].style.backgroundColor).toBe("rgb(17, 34, 51)");
  });

  it("marks only background hosts that are waiting with an amber dot and names the count for AT", async () => {
    await renderSquares({
      servers: [
        { ...threeHosts[0], waiting: 5 },
        { ...threeHosts[1], waiting: 3 },
        threeHosts[2],
      ],
    });
    const dots = screen.getAllByTestId("shell-host-waiting-dot");
    expect(dots).toHaveLength(1);
    expect(squareEls()[1]).toContainElement(dots[0]);
    expect(labels()).toEqual(["studio-mac", "lab, 3 waiting", "ws-01"]);
  });

  it("makes the squares and `+` no-drag islands while the nameplate stays part of the drag band", async () => {
    await renderSquares();
    expect(screen.getByTestId("shell-host-squares").className).toContain("rk-shell-no-drag");
    expect(screen.getByTestId("shell-titlebar-strip").className).toContain("rk-shell-drag");
    expect(screen.getByTestId("shell-nameplate").className).toContain("rk-shell-drag");
    expect(screen.getByTestId("shell-key-hint-pill").className).toContain("rk-shell-no-drag");
  });

  it("resolves the ringed square from the per-view `current` flag, not the cosmetic `active` record", async () => {
    await renderSquares({
      servers: [
        { ...threeHosts[0], active: true, current: false },
        { ...threeHosts[1], active: false, current: true },
      ],
    });
    expect(squareEls()[1]).toHaveAttribute("aria-current", "true");
    expect(squareEls()[0]).not.toHaveAttribute("aria-current");
    expect(screen.getByTestId("shell-nameplate-name")).toHaveTextContent("lab");
  });

  it("clicking a square hands off to servers.switch once; a denial surfaces the error toast", async () => {
    const bridge = await renderSquares();
    fireEvent.click(squareEls()[1]);
    expect(bridge.switch).toHaveBeenCalledTimes(1);
    expect(bridge.switch).toHaveBeenCalledWith("b");
    bridge.switch.mockResolvedValueOnce({ ok: false });
    fireEvent.click(squareEls()[2]);
    await waitFor(() => {
      expect(screen.getByText("Host switch failed")).toBeInTheDocument();
    });
  });

  it("hovering a square previews that host in the nameplate (dimmed, `→` prefix) without switching", async () => {
    const bridge = await renderSquares();
    const nameplate = screen.getByTestId("shell-nameplate");
    expect(nameplate).toHaveAttribute("data-peek", "false");
    fireEvent.pointerEnter(squareEls()[1]);
    expect(nameplate).toHaveAttribute("data-peek", "true");
    expect(screen.getByTestId("shell-nameplate-name").textContent).toBe("→ lab");
    fireEvent.pointerLeave(screen.getByTestId("shell-host-squares"));
    expect(nameplate).toHaveAttribute("data-peek", "false");
    expect(screen.getByTestId("shell-nameplate-name").textContent).toBe("studio-mac");
    expect(bridge.switch).not.toHaveBeenCalled();
  });

  it("previews a host's reported machine/os/agents beside its name, the bare name when it reported none", async () => {
    await renderSquares({
      servers: [
        threeHosts[0],
        { ...threeHosts[1], machine: "sahil@lab-box", os: "darwin", agents: 3 },
        threeHosts[2],
      ],
    });
    fireEvent.pointerEnter(squareEls()[1]);
    const nameplate = screen.getByTestId("shell-nameplate");
    expect(nameplate).toHaveTextContent("sahil@lab-box");
    expect(nameplate).toHaveTextContent("macOS");
    expect(nameplate).toHaveTextContent("3 agents");
    fireEvent.pointerEnter(squareEls()[2]);
    expect(screen.getByTestId("shell-nameplate")).not.toHaveTextContent("agents");
  });

  it("shows the active host's own facts: user@machine from health, OS, a labelled kind glyph and the link", async () => {
    await renderSquares({ servers: [{ ...threeHosts[0], url: "http://127.0.0.1:3142" }, threeHosts[1]] });
    await waitFor(() => {
      expect(screen.getByTestId("shell-nameplate")).toHaveTextContent("sahil@box");
    });
    const nameplate = screen.getByTestId("shell-nameplate");
    expect(nameplate).toHaveTextContent("linux");
    expect(nameplate).toHaveTextContent("ssh tunnel :3142");
    expect(within(nameplate).getAllByRole("img", { name: "rk remote · SSH tunnel" }).length).toBeGreaterThan(0);
  });
});

describe("ShellTitlebarStrip key hints", () => {
  it("always renders the pill (space reserved) with the platform's chord label", async () => {
    await renderSquares();
    expect(screen.getByTestId("shell-key-hint-pill")).toHaveTextContent("⌥⌘");
    expect(screen.getByTestId("shell-titlebar-strip")).toHaveAttribute("data-hints", "off");
    cleanup();
    await renderSquares({ platform: "win32" });
    expect(screen.getByTestId("shell-key-hint-pill")).toHaveTextContent("Alt");
  });

  it("holding ⌥⌘ on darwin turns the hints on; keyup and window blur turn them off", async () => {
    await renderSquares();
    const strip = screen.getByTestId("shell-titlebar-strip");
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    expect(strip).toHaveAttribute("data-hints", "off"); // Option alone is not the chord
    fireEvent.keyDown(window, { key: "Meta", altKey: true, metaKey: true });
    expect(strip).toHaveAttribute("data-hints", "on");
    expect(strip).toHaveAttribute("data-hold", "true");
    fireEvent.keyUp(window, { key: "Meta", altKey: true, metaKey: false });
    expect(strip).toHaveAttribute("data-hints", "off");
    fireEvent.keyDown(window, { key: "Meta", altKey: true, metaKey: true });
    expect(strip).toHaveAttribute("data-hints", "on");
    fireEvent.blur(window);
    expect(strip).toHaveAttribute("data-hints", "off");
  });

  it("holding bare Alt turns the hints on off-darwin", async () => {
    await renderSquares({ platform: "linux" });
    const strip = screen.getByTestId("shell-titlebar-strip");
    fireEvent.keyDown(window, { key: "Alt", altKey: true });
    expect(strip).toHaveAttribute("data-hints", "on");
    fireEvent.keyUp(window, { key: "Alt", altKey: false });
    expect(strip).toHaveAttribute("data-hints", "off");
  });

  it("hovering the pill shows the digits too", async () => {
    await renderSquares();
    const strip = screen.getByTestId("shell-titlebar-strip");
    fireEvent.pointerEnter(screen.getByTestId("shell-key-hint-pill"));
    expect(strip).toHaveAttribute("data-hints", "on");
    fireEvent.pointerLeave(screen.getByTestId("shell-key-hint-pill"));
    expect(strip).toHaveAttribute("data-hints", "off");
  });

  it("revealing the hints re-renders no square and no nameplate — the same elements stay in place", async () => {
    await renderSquares();
    const before = [...squareEls(), screen.getByTestId("shell-nameplate")];
    fireEvent.keyDown(window, { key: "Meta", altKey: true, metaKey: true });
    fireEvent.pointerEnter(screen.getByTestId("shell-key-hint-pill"));
    const after = [...squareEls(), screen.getByTestId("shell-nameplate")];
    expect(after).toEqual(before);
    after.forEach((el, i) => expect(el).toBe(before[i]));
  });
});

describe("ShellTitlebarStrip focus-the-squares chord and keys", () => {
  // The shifted tier matches Shift + (Meta OR Ctrl) on every platform, so the
  // Ctrl spelling works regardless of the jsdom-detected host platform.
  const chord = (target: Document | Element = document) =>
    fireEvent.keyDown(target, { key: "H", code: "KeyH", shiftKey: true, ctrlKey: true });

  it("⇧⌘H focuses the active square; a second press returns focus to where it was", async () => {
    await renderSquares();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    chord();
    expect(document.activeElement).toBe(squareEls()[0]);
    chord();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("the chord falls through untouched when the strip is not interactive (empty list)", async () => {
    shellBridge([]);
    renderStrip();
    await waitFor(() => {
      expect(screen.getByText(window.location.hostname)).toBeInTheDocument();
    });
    expect(chord()).toBe(true);
  });

  it("the chord is suppressed while a real text input owns focus", async () => {
    await renderSquares();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "H", code: "KeyH", shiftKey: true, ctrlKey: true });
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it("the HOST_STRIP_FOCUS_EVENT seam (the palette's Host: Focus Squares) focuses the squares", async () => {
    await renderSquares();
    act(() => {
      document.dispatchEvent(new CustomEvent(HOST_STRIP_FOCUS_EVENT));
    });
    expect(document.activeElement).toBe(squareEls()[0]);
  });

  it("arrows and Home/End rove focus with no wrap, Escape releases it", async () => {
    await renderSquares();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    chord();
    const [a, b, c] = squareEls();
    fireEvent.keyDown(a, { key: "ArrowRight" });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b, { key: "End" });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c, { key: "ArrowRight" }); // no wrap
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c, { key: "Home" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: "Escape" });
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("a plain digit on a focused square switches to the Nth host; modified digits and out-of-range ones do not", async () => {
    const bridge = await renderSquares();
    squareEls()[0].focus();
    fireEvent.keyDown(squareEls()[0], { key: "3", code: "Digit3" });
    expect(bridge.switch).toHaveBeenCalledWith("c");
    bridge.switch.mockClear();
    fireEvent.keyDown(squareEls()[0], { key: "2", code: "Digit2", altKey: true, metaKey: true });
    expect(fireEvent.keyDown(squareEls()[0], { key: "9", code: "Digit9" })).toBe(true);
    expect(bridge.switch).not.toHaveBeenCalled();
  });

  it("Enter/Space activate natively: a click on the focused square switches", async () => {
    const bridge = await renderSquares();
    fireEvent.click(squareEls()[2]);
    expect(bridge.switch).toHaveBeenCalledWith("c");
  });

  it("Shift+F10 and ContextMenu open the host menu with the focused host's row focused", async () => {
    await renderSquares();
    squareEls()[1].focus();
    fireEvent.keyDown(squareEls()[1], { key: "F10", shiftKey: true });
    const rows = await screen.findAllByRole("menuitemradio");
    await waitFor(() => {
      expect(document.activeElement).toBe(rows[1]);
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(squareEls()[1]);
    fireEvent.keyDown(squareEls()[1], { key: "ContextMenu" });
    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });
});

describe("ShellTitlebarStrip host menu anchors", () => {
  it("right-clicking a square opens the menu focused on that host's row", async () => {
    await renderSquares({ add: true });
    fireEvent.contextMenu(squareEls()[2]);
    const rows = await screen.findAllByRole("menuitemradio");
    await waitFor(() => {
      expect(document.activeElement).toBe(rows[2]);
    });
  });

  it("right-clicking another square re-anchors the open menu on that row", async () => {
    await renderSquares();
    fireEvent.contextMenu(squareEls()[0]);
    await screen.findByRole("menu");
    fireEvent.contextMenu(squareEls()[1]);
    const rows = await screen.findAllByRole("menuitemradio");
    await waitFor(() => {
      expect(document.activeElement).toBe(rows[1]);
    });
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });

  it("the `+` square toggles the menu, and an outside mousedown on a square does not double-close it", async () => {
    await renderSquares();
    const plus = screen.getByRole("button", { name: "Host menu" });
    fireEvent.click(plus);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(plus); // an anchor: not an "outside" click
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(plus);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("ShellTitlebarStrip reorder (squares)", () => {
  it("⌥→ moves the focused square one slot: one commit per keypress, optimistic order, focus follows", async () => {
    const bridge = await renderSquares({ reorder: true });
    squareEls()[0].focus();
    fireEvent.keyDown(squareEls()[0], { key: "ArrowRight", altKey: true });
    expect(bridge.reorder).toHaveBeenCalledTimes(1);
    expect(bridge.reorder).toHaveBeenCalledWith("a", 1);
    expect(labels()).toEqual(["lab", "studio-mac", "ws-01"]);
    expect(squareEls().map((el) => el.textContent)).toEqual(["1", "2", "3"]);
    await waitFor(() => {
      expect(document.activeElement).toBe(squareEls()[1]);
    });
  });

  it("⌥←/⌥→ at the row's edges swallow the key without invoking the shell (no wrap)", async () => {
    const bridge = await renderSquares({ reorder: true });
    fireEvent.keyDown(squareEls()[0], { key: "ArrowLeft", altKey: true });
    fireEvent.keyDown(squareEls()[2], { key: "ArrowRight", altKey: true });
    expect(bridge.reorder).not.toHaveBeenCalled();
    expect(labels()).toEqual(["studio-mac", "lab", "ws-01"]);
  });

  it("a pointer drag past the 4px threshold commits exactly ONE reorder at drop and suppresses the trailing click", async () => {
    const bridge = await renderSquares({ reorder: true });
    const strip = screen.getByTestId("shell-titlebar-strip");
    const a = squareEls()[0];
    fireEvent.pointerDown(a, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(a, { clientX: 102, pointerId: 1 });
    expect(strip).toHaveAttribute("data-dragging", "false"); // under the threshold
    fireEvent.pointerMove(a, { clientX: 152, pointerId: 1 });
    expect(strip).toHaveAttribute("data-dragging", "true");
    // Digits renumber live as the drop slot changes: studio-mac now sits third.
    expect(a.textContent).toBe("3");
    expect(squareEls()[1].textContent).toBe("1");
    expect(bridge.reorder).not.toHaveBeenCalled();
    fireEvent.pointerUp(a, { clientX: 152, pointerId: 1 });
    expect(bridge.reorder).toHaveBeenCalledTimes(1);
    expect(bridge.reorder).toHaveBeenCalledWith("a", 2);
    expect(strip).toHaveAttribute("data-dragging", "false");
    expect(labels()).toEqual(["lab", "ws-01", "studio-mac"]);
    fireEvent.click(squareEls()[2]); // the click that ends a drag is swallowed
    expect(bridge.switch).not.toHaveBeenCalled();
  });

  it("a press-release under the threshold is a click: it switches and never reorders", async () => {
    const bridge = await renderSquares({ reorder: true });
    const b = squareEls()[1];
    fireEvent.pointerDown(b, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(b, { clientX: 103, pointerId: 1 });
    fireEvent.pointerUp(b, { clientX: 103, pointerId: 1 });
    fireEvent.click(b);
    expect(bridge.reorder).not.toHaveBeenCalled();
    expect(bridge.switch).toHaveBeenCalledWith("b");
  });

  it("dropping back on the original slot commits nothing", async () => {
    const bridge = await renderSquares({ reorder: true });
    const a = squareEls()[0];
    fireEvent.pointerDown(a, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(a, { clientX: 130, pointerId: 1 });
    fireEvent.pointerMove(a, { clientX: 101, pointerId: 1 });
    fireEvent.pointerMove(a, { clientX: 106, pointerId: 1 });
    fireEvent.pointerUp(a, { clientX: 106, pointerId: 1 });
    expect(bridge.reorder).not.toHaveBeenCalled();
  });

  it("without the reorder invoker squares neither drag nor ⌥-move, and click still switches", async () => {
    const bridge = await renderSquares();
    const strip = screen.getByTestId("shell-titlebar-strip");
    const a = squareEls()[0];
    fireEvent.pointerDown(a, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(a, { clientX: 160, pointerId: 1 });
    fireEvent.pointerUp(a, { clientX: 160, pointerId: 1 });
    expect(strip).toHaveAttribute("data-dragging", "false");
    fireEvent.keyDown(a, { key: "ArrowRight", altKey: true });
    expect(labels()).toEqual(["studio-mac", "lab", "ws-01"]);
    fireEvent.click(squareEls()[1]);
    expect(bridge.switch).toHaveBeenCalledWith("b");
  });

  it("a denied commit surfaces the error toast and refetches the list", async () => {
    const bridge = await renderSquares({ reorder: true });
    bridge.reorder.mockResolvedValueOnce({ ok: false });
    const callsBefore = bridge.list.mock.calls.length;
    fireEvent.keyDown(squareEls()[0], { key: "ArrowRight", altKey: true });
    await waitFor(() => {
      expect(screen.getByText("Shell host reorder failed")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(bridge.list.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });
});

describe("ShellTitlebarStrip lit band", () => {
  const lit = accentValue({ stripeHex: "#7d9afb" });

  it("lights the band with the default Glow + Light slides from the active square's host color", async () => {
    stubReducedMotion(false);
    await renderSquares({}, lit);
    const strip = screen.getByTestId("shell-titlebar-strip");
    expect(strip.className).toContain("rk-strip-fx-glow");
    expect(strip.className).toContain("rk-strip-motion-slide");
    expect(strip.style.getPropertyValue("--rk-acc")).toBe("#7d9afb");
    expect(strip.style.getPropertyValue("--rk-ax")).not.toBe("");
    expect(strip.style.getPropertyValue("--rk-dx")).not.toBe("");
    expect(strip.style.getPropertyValue("--rk-strip-bg")).toMatch(/^#/);
  });

  it("applies no treatment when the host has no color — the band stays neutral chrome", async () => {
    stubReducedMotion(false);
    await renderSquares();
    expect(screen.getByTestId("shell-titlebar-strip").className).not.toMatch(/rk-strip-fx-/);
  });

  it("follows the shell's stored effect and motion", async () => {
    stubReducedMotion(false);
    await renderSquares({ prefs: { effect: "hex", motion: "sweep" } }, lit);
    await waitFor(() => {
      expect(screen.getByTestId("shell-titlebar-strip").className).toContain("rk-strip-fx-hex");
    });
    expect(screen.getByTestId("shell-titlebar-strip").className).toContain("rk-strip-motion-sweep");
  });

  it("prefers-reduced-motion forces Cut whatever the stored motion", async () => {
    stubReducedMotion(true);
    await renderSquares({ prefs: { effect: "glow", motion: "sweep" } }, lit);
    await waitFor(() => {
      expect(screen.getByTestId("shell-titlebar-strip").className).toContain("rk-strip-motion-cut");
    });
    expect(screen.getByTestId("shell-titlebar-strip").className).not.toContain("rk-strip-motion-sweep");
  });

  it("a cross-view attach signal re-seats the light at the previous square and (with Slide + sweep) fires the sweep", async () => {
    stubReducedMotion(false);
    const bridge = await renderSquares({ onAttached: true, prefs: { effect: "glow", motion: "sweep" } }, lit);
    await waitFor(() => {
      expect(screen.getByTestId("shell-titlebar-strip").className).toContain("rk-strip-motion-sweep");
    });
    await waitFor(() => {
      expect(bridge.pushed.attached).toBeDefined();
    });
    act(() => bridge.pushed.attached?.({ previousId: "c" }));
    const sweep = document.querySelector(".rk-strip-sweep");
    expect(sweep?.classList.contains("rk-strip-sweep-go")).toBe(true);
    expect(sweep instanceof HTMLElement && sweep.style.getPropertyValue("--rk-from")).not.toBe("");
    // The no-transition seat is released again.
    expect(screen.getByTestId("shell-titlebar-strip").classList.contains("rk-strip-notrans")).toBe(false);
  });

  it("an attach signal for an unknown host is ignored (degrades to a cut)", async () => {
    stubReducedMotion(false);
    const bridge = await renderSquares({ onAttached: true }, lit);
    await waitFor(() => {
      expect(bridge.pushed.attached).toBeDefined();
    });
    expect(() => act(() => bridge.pushed.attached?.({ previousId: "gone" }))).not.toThrow();
    expect(document.querySelector(".rk-strip-sweep-go")).toBeNull();
  });
});

describe("ShellTitlebarStrip live projection", () => {
  it("refetches the list once per servers:changed push and unsubscribes on unmount", async () => {
    const bridge = await renderSquares({ onChanged: true });
    await waitFor(() => {
      expect(bridge.pushed.changed).toBeDefined();
    });
    const before = bridge.list.mock.calls.length;
    act(() => bridge.pushed.changed?.());
    await waitFor(() => {
      expect(bridge.list.mock.calls.length).toBe(before + 1);
    });
    cleanup();
    expect(bridge.off).toHaveBeenCalled();
  });

  it("an older shell without the push refetches when the window regains focus", async () => {
    const bridge = await renderSquares();
    const before = bridge.list.mock.calls.length;
    fireEvent.focus(window);
    await waitFor(() => {
      expect(bridge.list.mock.calls.length).toBe(before + 1);
    });
  });
});

describe("ShellTitlebarStrip degraded branches", () => {
  it("a popout window renders only the title: no squares, no pill, no nameplate", async () => {
    squaresBridge();
    renderStrip(accentValue(), "beta #2 — session main · server work");
    expect(screen.getByTestId("shell-titlebar-popout-title")).toBeInTheDocument();
    expect(screen.queryByTestId("shell-host-square")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shell-key-hint-pill")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shell-nameplate")).not.toBeInTheDocument();
  });

  it("without the servers group the band shows the static name: no squares or pill, still draggable", async () => {
    window.runkitShell = { version: "0.9.0", platform: "darwin" };
    renderStrip();
    await waitFor(() => {
      expect(screen.getByTestId("shell-titlebar-host-name")).toHaveTextContent(window.location.hostname);
    });
    expect(screen.queryByTestId("shell-host-square")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shell-key-hint-pill")).not.toBeInTheDocument();
    expect(screen.getByTestId("shell-titlebar-strip").className).toContain("rk-shell-drag");
  });
});
