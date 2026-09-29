import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { IframeWindow } from "./iframe-window";
import { StandaloneSessionContextProvider } from "@/contexts/session-context";
import { useLocalStorageBoolean } from "@/hooks/use-local-storage-boolean";
import {
  WEB_NATIVE_ENGINE_DEFAULT,
  WEB_NATIVE_ENGINE_PREF_KEY,
} from "@/lib/web-engine-pref";
import { WEB_INSPECT_EVENT } from "@/lib/web-url";
import type { FrameChromeState } from "@/lib/web-frame-engine";

// The chrome's engine boundary is module-mocked: the stub below registers a
// spy handle and reports whatever FrameChromeState the test pushes, so these
// cases exercise the chrome's per-capability rendering and handle routing
// without a real frame. (The real engine's behavior is covered by
// web-frame-iframe.test.tsx; the chrome-over-real-engine cases stay in
// iframe-window.test.tsx.)
const mockEngine = vi.hoisted(() => {
  const handle = {
    kind: "iframe" as const,
    reload: vi.fn(),
    retry: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    find: vi.fn(),
    stopFind: vi.fn(),
    openDevTools: vi.fn(),
    destroy: vi.fn(),
  };
  return {
    listeners: new Set<() => void>(),
    state: null as FrameChromeState | null,
    handle,
    // The two engine-agnostic props the chrome passes every engine: captured
    // so the pass-through is assertable.
    chordTable: undefined as unknown,
    onZoomStep: undefined as unknown,
    // The LAST `active` prop rendered per tab URL — the draft-deactivation
    // rule asserts every engine renders inactive while a draft is selected.
    activeByUrl: new Map<string, boolean>(),
  };
});

vi.mock("@/components/web-frame-iframe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/web-frame-iframe")>();
  const React = await import("react");
  return {
    // The real default-capabilities constant — re-exported so the stub can
    // never drift from the engine.
    WEB_FRAME_IFRAME_DEFAULT_CAPABILITIES: actual.WEB_FRAME_IFRAME_DEFAULT_CAPABILITIES,
    WebFrameIframe: (props: import("@/lib/web-frame-engine").WebFrameEngineProps) => {
      const [, force] = React.useReducer((x: number) => x + 1, 0);
      mockEngine.chordTable = props.chordTable;
      mockEngine.onZoomStep = props.onZoomStep;
      mockEngine.activeByUrl.set(props.url, props.active);
      React.useEffect(() => {
        const listener = () => force();
        mockEngine.listeners.add(listener);
        return () => {
          mockEngine.listeners.delete(listener);
        };
      }, []);
      React.useEffect(() => {
        props.registerHandle(props.url, mockEngine.handle);
        return () => props.unregisterHandle(props.url);
      }, [props.url]);
      React.useEffect(() => {
        if (mockEngine.state) props.onState(props.url, mockEngine.state);
      });
      return React.createElement("div", { "data-testid": "stub-engine" });
    },
  };
});

// The native engine is module-mocked with a recording stub beside the iframe
// stub: mounts/unmounts per tab URL are recorded so the kind-flip remount is
// assertable; the stub reports NO state, so the chrome renders the kind's
// pre-report capability seed (WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES).
const mockNative = vi.hoisted(() => ({
  mounts: [] as string[],
  unmounts: [] as string[],
  handle: {
    kind: "native" as const,
    reload: vi.fn(),
    retry: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    find: vi.fn(),
    stopFind: vi.fn(),
    openDevTools: vi.fn(),
    destroy: vi.fn(),
  },
  chordTable: undefined as unknown,
  onZoomStep: undefined as unknown,
  activeByUrl: new Map<string, boolean>(),
}));

vi.mock("@/components/web-frame-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/web-frame-native")>();
  const React = await import("react");
  return {
    WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES: actual.WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES,
    WebFrameNative: (props: import("@/lib/web-frame-engine").WebFrameEngineProps) => {
      mockNative.chordTable = props.chordTable;
      mockNative.onZoomStep = props.onZoomStep;
      mockNative.activeByUrl.set(props.url, props.active);
      React.useEffect(() => {
        mockNative.mounts.push(props.url);
        props.registerHandle(props.url, mockNative.handle);
        return () => {
          mockNative.unmounts.push(props.url);
          props.unregisterHandle(props.url);
        };
      }, [props.url]);
      return React.createElement("div", { "data-testid": "stub-native-engine" });
    },
  };
});

// canShellWeb() is the chrome's bridge-presence read; mocked so the selection
// rule runs without installing a bridge on window.
const mockShell = vi.hoisted(() => ({ canShellWeb: vi.fn(() => false) }));
vi.mock("@/lib/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/shell")>()),
  canShellWeb: mockShell.canShellWeb,
}));

const ALL_SUPPORT = {
  history: true,
  find: true,
  meta: true,
  zoomGestures: true,
  devtools: false,
} as const;

const NO_SUPPORT = {
  history: false,
  find: false,
  meta: false,
  zoomGestures: false,
  devtools: false,
} as const;

function chromeState(overrides: Partial<FrameChromeState> = {}): FrameChromeState {
  return {
    loading: false,
    supports: { ...ALL_SUPPORT },
    trackedLocation: null,
    title: null,
    favicon: null,
    tileError: null,
    canGoBack: true,
    canGoForward: true,
    find: null,
    ...overrides,
  };
}

/** Push a new report through every mounted stub engine. */
function pushState(state: FrameChromeState) {
  act(() => {
    mockEngine.state = state;
    mockEngine.listeners.forEach((listener) => listener());
  });
}

function renderChrome(props: React.ComponentProps<typeof IframeWindow> = { tabs: [] }) {
  return render(
    <StandaloneSessionContextProvider
      value={{
        sessionsByServer: new Map([["runkit", []]]),
        sessionOrderByServer: new Map([["runkit", []]]),
        isConnectedByServer: new Map([["runkit", false]]),
        metricsByServer: new Map(),
        currentServer: "runkit",
        servers: [{ name: "runkit", sessionCount: 0 }],
        refreshServers: vi.fn(),
      }}
    >
      <IframeWindow {...props} />
    </StandaloneSessionContextProvider>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockEngine.state = chromeState();
  mockEngine.activeByUrl.clear();
  mockNative.mounts = [];
  mockNative.unmounts = [];
  mockNative.activeByUrl.clear();
  mockShell.canShellWeb.mockReturnValue(false);
  localStorage.clear();
});

describe("IframeWindow over a stub engine", () => {
  it("an all-false capability report hides back/forward, keeps refresh and the ⌕ button enabled, and disables the open bar with the hint", () => {
    mockEngine.state = chromeState({ supports: { ...NO_SUPPORT }, canGoBack: false, canGoForward: false });
    renderChrome({ tabs: ["/proxy/8080/docs"] });
    expect(screen.queryByLabelText("Back")).toBeNull();
    expect(screen.queryByLabelText("Forward")).toBeNull();
    expect(screen.getByLabelText("Refresh")).toBeTruthy();

    const findButton = screen.getByLabelText("Find in page") as HTMLButtonElement;
    expect(findButton.disabled).toBe(false);
    fireEvent.click(findButton);
    expect(screen.getByText("page is cross-origin — find unavailable")).toBeTruthy();
    expect((screen.getByLabelText("Find query") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Match count")).toBeNull();
  });

  it("history support with canGoBack false renders Back disabled and Forward enabled", () => {
    mockEngine.state = chromeState({ canGoBack: false, canGoForward: true });
    renderChrome({ tabs: ["/proxy/8080/docs"] });
    expect((screen.getByLabelText("Back") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Forward") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a pushed title renders as the tab label and reaches onPageMeta", () => {
    const onPageMeta = vi.fn();
    renderChrome({ tabs: ["/proxy/8080/docs"], onPageMeta });
    pushState(chromeState({ title: "Docs" }));
    expect(screen.getByTestId("web-tab").textContent).toContain("Docs");
    expect(onPageMeta).toHaveBeenLastCalledWith({ title: "Docs" });
  });

  it("Refresh/Back/Forward/Retry drive the registered handle; a pushed dead-port error renders its surface", () => {
    renderChrome({ tabs: ["/proxy/8080/docs"] });
    fireEvent.click(screen.getByLabelText("Refresh"));
    expect(mockEngine.handle.reload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Back"));
    expect(mockEngine.handle.back).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Forward"));
    expect(mockEngine.handle.forward).toHaveBeenCalledTimes(1);

    pushState(chromeState({ tileError: { kind: "dead-port", port: 4000 } }));
    const box = screen.getByTestId("web-tile-error");
    expect(box.textContent).toContain("nothing listening on :4000");
    fireEvent.click(screen.getByLabelText("Retry"));
    expect(mockEngine.handle.retry).toHaveBeenCalledTimes(1);
  });

  it("a pushed refused error renders the refusal copy with the Open in browser escape hatch (no Retry)", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      renderChrome({ tabs: ["/proxy/8080/docs"] });
      pushState(
        chromeState({
          tileError: { kind: "refused", host: "github.com", reason: "X-Frame-Options: DENY" },
        }),
      );
      const box = screen.getByTestId("web-tile-error");
      expect(box.textContent).toContain("github.com refuses embedding");
      expect(box.textContent).toContain(
        "X-Frame-Options: DENY — this site can't render inside a tile",
      );
      expect(within(box).queryByLabelText("Retry")).toBeNull();
      fireEvent.click(within(box).getByLabelText("Open in browser"));
      expect(open).toHaveBeenCalledWith("/proxy/8080/docs", "_blank", "noopener");
    } finally {
      open.mockRestore();
    }
  });

  it("a pushed unreachable error renders the connection-error copy with the Open in browser escape hatch (no Retry)", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      renderChrome({ tabs: ["/proxy/8080/docs"] });
      pushState(
        chromeState({
          tileError: {
            kind: "unreachable",
            host: "dead.example",
            reason: "connect failed: connection refused",
          },
        }),
      );
      const box = screen.getByTestId("web-tile-error");
      expect(box.textContent).toContain("dead.example can't be reached");
      expect(box.textContent).toContain("connect failed: connection refused");
      expect(within(box).queryByLabelText("Retry")).toBeNull();
      fireEvent.click(within(box).getByLabelText("Open in browser"));
      expect(open).toHaveBeenCalledWith("/proxy/8080/docs", "_blank", "noopener");
    } finally {
      open.mockRestore();
    }
  });

  it("the find bar drives find/stopFind on the handle and renders a pushed match counter", () => {
    renderChrome({ tabs: ["/proxy/8080/docs"] });
    fireEvent.click(screen.getByLabelText("Find in page"));
    const input = screen.getByLabelText("Find query");

    // Typing (re)starts the search on the engine.
    fireEvent.change(input, { target: { value: "foo" } });
    expect(mockEngine.handle.find).toHaveBeenLastCalledWith("foo", {
      forward: true,
      findNext: false,
    });
    // Enter steps forward, ⇧Enter backward.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockEngine.handle.find).toHaveBeenLastCalledWith("foo", {
      forward: true,
      findNext: true,
    });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(mockEngine.handle.find).toHaveBeenLastCalledWith("foo", {
      forward: false,
      findNext: true,
    });

    // The counter renders the engine's reported {active, total} (0-based in,
    // 1-based out).
    pushState(chromeState({ find: { active: 1, total: 3 } }));
    expect(screen.getByLabelText("Match count").textContent).toBe("2/3");

    // Closing the bar stops the search.
    mockEngine.handle.stopFind.mockClear();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("web-find-bar")).toBeNull();
    expect(mockEngine.handle.stopFind).toHaveBeenCalledTimes(1);
  });

  it("passes the registry-derived chord table and the zoom bucket stepper to every engine", () => {
    renderChrome({ tabs: ["/proxy/8080/docs", "https://github.com/x"] });
    // The enumerated kind-"web" reclaim table: the ⌘K ctrl/meta arms and the
    // always-last Escape focus-return spec.
    const table = mockEngine.chordTable as readonly { code: string }[];
    expect(Array.isArray(table)).toBe(true);
    expect(table.some((s) => s.code === "KeyK")).toBe(true);
    expect(table[table.length - 1]?.code).toBe("Escape");

    // onZoomStep is the chrome's ladder stepper (the native engine's ctrl-
    // wheel relay rides it): "in" from the 100% default lands on 110%.
    const readout = screen.getByLabelText("Reset zoom");
    expect(readout.textContent).toBe("100%");
    act(() => {
      (mockEngine.onZoomStep as (direction: "in" | "out") => void)("in");
    });
    expect(readout.textContent).toBe("110%");
  });

  it("the web-inspect document event reaches the ACTIVE handle's openDevTools", () => {
    renderChrome({ tabs: ["/proxy/8080/docs"] });
    act(() => {
      document.dispatchEvent(new CustomEvent(WEB_INSPECT_EVENT));
    });
    expect(mockEngine.handle.openDevTools).toHaveBeenCalledTimes(1);
  });

  it("a selected draft renders EVERY engine active={false} and shows the blank new-tab panel", () => {
    renderChrome({ tabs: ["/proxy/8080/docs", "https://github.com/x"], active: 1, onAddTab: vi.fn() });
    expect(mockEngine.activeByUrl.get("/proxy/8080/docs")).toBe(true);
    expect(mockEngine.activeByUrl.get("https://github.com/x")).toBe(false);

    fireEvent.click(screen.getByTestId("web-tab-add"));
    expect(mockEngine.activeByUrl.get("/proxy/8080/docs")).toBe(false);
    expect(mockEngine.activeByUrl.get("https://github.com/x")).toBe(false);
    expect(screen.getByTestId("web-draft-panel")).toBeTruthy();
    // Both engines stay mounted (P3) — the wrapper never unmounts them.
    expect(screen.getAllByTestId("stub-engine")).toHaveLength(2);
  });

  it("the native engine also renders active={false} while a draft is selected", () => {
    localStorage.setItem(WEB_NATIVE_ENGINE_PREF_KEY, "true");
    mockShell.canShellWeb.mockReturnValue(true);
    renderChrome({ tabs: ["/proxy/8080/docs", "https://github.com/x"], active: 2, onAddTab: vi.fn() });
    expect(mockNative.activeByUrl.get("/proxy/8080/docs")).toBe(false);
    expect(mockNative.activeByUrl.get("https://github.com/x")).toBe(true);

    fireEvent.click(screen.getByTestId("web-tab-add"));
    expect(mockNative.activeByUrl.get("/proxy/8080/docs")).toBe(false);
    expect(mockNative.activeByUrl.get("https://github.com/x")).toBe(false);
    expect(screen.getByTestId("web-draft-panel")).toBeTruthy();
  });

  it("the Inspect page button renders only on a devtools-capable report and drives the handle's openDevTools", () => {
    renderChrome({ tabs: ["/proxy/8080/docs"] });
    expect(screen.queryByLabelText("Inspect page")).toBeNull();

    pushState(chromeState({ supports: { ...ALL_SUPPORT, devtools: true } }));
    const button = screen.getByLabelText("Inspect page");
    expect(button.querySelector('svg[data-icon="inspect"]')).toBeTruthy();
    fireEvent.click(button);
    expect(mockEngine.handle.openDevTools).toHaveBeenCalledTimes(1);
  });

  it("the native engine's capability seed shows the Inspect page button, routed to the native handle", () => {
    localStorage.setItem(WEB_NATIVE_ENGINE_PREF_KEY, "true");
    mockShell.canShellWeb.mockReturnValue(true);
    renderChrome({ tabs: ["/proxy/8080/docs"] });
    fireEvent.click(screen.getByLabelText("Inspect page"));
    expect(mockNative.handle.openDevTools).toHaveBeenCalledTimes(1);
    expect(mockEngine.handle.openDevTools).not.toHaveBeenCalled();
  });

  it("the web-inspect document event reaches the native handle when that engine is mounted", () => {
    localStorage.setItem(WEB_NATIVE_ENGINE_PREF_KEY, "true");
    mockShell.canShellWeb.mockReturnValue(true);
    renderChrome({ tabs: ["/proxy/8080/docs"] });
    act(() => {
      document.dispatchEvent(new CustomEvent(WEB_INSPECT_EVENT));
    });
    expect(mockNative.handle.openDevTools).toHaveBeenCalledTimes(1);
    expect(mockEngine.handle.openDevTools).not.toHaveBeenCalled();
  });
});

/** A sibling control flipping the engine preference through the same
 *  production path the palette entry uses (the hook's same-tab pub/sub). */
function PrefToggle() {
  const [, setNativeEnabled] = useLocalStorageBoolean(
    WEB_NATIVE_ENGINE_PREF_KEY,
    WEB_NATIVE_ENGINE_DEFAULT,
  );
  return (
    <button data-testid="pref-toggle" onClick={() => setNativeEnabled(false)}>
      toggle
    </button>
  );
}

describe("IframeWindow chrome-owned destroys", () => {
  // The destroy rule keys on the FAMILY diff while the window key is
  // unchanged: a URL leaving the family (close / slot rewrite / external
  // removal) destroys its guest through the registered handle; a window
  // switch (window key change) parks instead of destroying.
  const SCOPE = { server: "runkit", windowId: "@3" };

  function chromeElement(props: React.ComponentProps<typeof IframeWindow>) {
    return (
      <StandaloneSessionContextProvider
        value={{
          sessionsByServer: new Map([["runkit", []]]),
          sessionOrderByServer: new Map([["runkit", []]]),
          isConnectedByServer: new Map([["runkit", false]]),
          metricsByServer: new Map(),
          currentServer: "runkit",
          servers: [{ name: "runkit", sessionCount: 0 }],
          refreshServers: vi.fn(),
        }}
      >
        <IframeWindow {...props} />
      </StandaloneSessionContextProvider>
    );
  }

  it("closing a tab destroys the closed tab's handle (the click drives onCloseTab; the destroy lands when the family shrinks)", () => {
    const onCloseTab = vi.fn();
    const view = render(
      chromeElement({
        tabs: ["/proxy/8080/docs", "https://github.com/x"],
        active: 1,
        onCloseTab,
        ...SCOPE,
      }),
    );
    const closeButtons = screen.getAllByTestId("web-tab-close");
    fireEvent.click(closeButtons[1]);
    expect(onCloseTab).toHaveBeenCalledWith(2);
    // The caller's optimistic remove lands as the next tabs prop — the
    // destroy fires with that shrink, before the engine's unmount park.
    expect(mockEngine.handle.destroy).not.toHaveBeenCalled();
    view.rerender(
      chromeElement({ tabs: ["/proxy/8080/docs"], active: 1, onCloseTab, ...SCOPE }),
    );
    expect(mockEngine.handle.destroy).toHaveBeenCalledTimes(1);
  });

  it("a URL-slot rewrite destroys the outgoing URL's handle", () => {
    const view = render(
      chromeElement({ tabs: ["/proxy/8080/docs", "https://github.com/x"], active: 1, ...SCOPE }),
    );
    view.rerender(
      chromeElement({ tabs: ["/proxy/8080/docs", "https://example.com/new"], active: 1, ...SCOPE }),
    );
    expect(mockEngine.handle.destroy).toHaveBeenCalledTimes(1);
    // The surviving slot's engine is untouched.
    expect(screen.getAllByTestId("stub-engine")).toHaveLength(2);
  });

  it("a reorder keeps every guest (no URL left the family)", () => {
    const view = render(
      chromeElement({ tabs: ["/proxy/8080/docs", "https://github.com/x"], active: 1, ...SCOPE }),
    );
    view.rerender(
      chromeElement({ tabs: ["https://github.com/x", "/proxy/8080/docs"], active: 2, ...SCOPE }),
    );
    expect(mockEngine.handle.destroy).not.toHaveBeenCalled();
  });

  it("a window switch destroys nothing — the departing tabs park for adoption on return", () => {
    const view = render(
      chromeElement({ tabs: ["/proxy/8080/docs"], active: 1, ...SCOPE }),
    );
    view.rerender(
      chromeElement({
        tabs: ["/proxy/9999/other"],
        active: 1,
        server: "runkit",
        windowId: "@7",
      }),
    );
    expect(mockEngine.handle.destroy).not.toHaveBeenCalled();
  });

  it("the destroy reaches the native engine's handle too", () => {
    localStorage.setItem(WEB_NATIVE_ENGINE_PREF_KEY, "true");
    mockShell.canShellWeb.mockReturnValue(true);
    const onCloseTab = vi.fn();
    const view = render(
      chromeElement({ tabs: ["/proxy/8080/docs", "https://github.com/x"], onCloseTab, ...SCOPE }),
    );
    view.rerender(
      chromeElement({ tabs: ["/proxy/8080/docs"], onCloseTab, ...SCOPE }),
    );
    expect(mockNative.handle.destroy).toHaveBeenCalledTimes(1);
    expect(mockEngine.handle.destroy).not.toHaveBeenCalled();
  });
});

describe("IframeWindow engine selection", () => {
  it("mounts the iframe engine with no bridge regardless of the preference", () => {
    localStorage.setItem(WEB_NATIVE_ENGINE_PREF_KEY, "true");
    mockShell.canShellWeb.mockReturnValue(false);
    renderChrome({ tabs: ["/proxy/8080/docs"] });
    expect(screen.getByTestId("stub-engine")).toBeTruthy();
    expect(screen.queryByTestId("stub-native-engine")).toBeNull();
  });

  it("mounts the native engine on bridge + preference, seeding its full-parity capabilities (◀ ▶ shown, find bar live)", () => {
    localStorage.setItem(WEB_NATIVE_ENGINE_PREF_KEY, "true");
    mockShell.canShellWeb.mockReturnValue(true);
    renderChrome({ tabs: ["/proxy/8080/docs"] });
    expect(screen.getByTestId("stub-native-engine")).toBeTruthy();
    expect(screen.queryByTestId("stub-engine")).toBeNull();
    expect(mockNative.mounts).toEqual(["/proxy/8080/docs"]);
    // The stub reports nothing, so the chrome renders the native pre-report
    // seed — the parity set: history and find are live from the first paint.
    expect(screen.getByLabelText("Back")).toBeTruthy();
    expect(screen.getByLabelText("Forward")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Find in page"));
    expect(screen.queryByText("page is cross-origin — find unavailable")).toBeNull();
    expect((screen.getByLabelText("Find query") as HTMLInputElement).disabled).toBe(false);
  });

  it("mounts the iframe engine on bridge + preference off", () => {
    localStorage.setItem(WEB_NATIVE_ENGINE_PREF_KEY, "false");
    mockShell.canShellWeb.mockReturnValue(true);
    renderChrome({ tabs: ["/proxy/8080/docs"] });
    expect(screen.getByTestId("stub-engine")).toBeTruthy();
    expect(screen.queryByTestId("stub-native-engine")).toBeNull();
    expect(mockNative.mounts).toEqual([]);
  });

  it("flipping the preference through the hook's setter remounts every tab on the other engine", () => {
    localStorage.setItem(WEB_NATIVE_ENGINE_PREF_KEY, "true");
    mockShell.canShellWeb.mockReturnValue(true);
    render(
      <StandaloneSessionContextProvider
        value={{
          sessionsByServer: new Map([["runkit", []]]),
          sessionOrderByServer: new Map([["runkit", []]]),
          isConnectedByServer: new Map([["runkit", false]]),
          metricsByServer: new Map(),
          currentServer: "runkit",
          servers: [{ name: "runkit", sessionCount: 0 }],
          refreshServers: vi.fn(),
        }}
      >
        <IframeWindow tabs={["/proxy/8080/docs", "https://github.com/x"]} />
        <PrefToggle />
      </StandaloneSessionContextProvider>,
    );
    expect(screen.getAllByTestId("stub-native-engine")).toHaveLength(2);
    expect(mockNative.mounts).toEqual(["/proxy/8080/docs", "https://github.com/x"]);
    act(() => {
      fireEvent.click(screen.getByTestId("pref-toggle"));
    });
    expect(mockNative.unmounts).toEqual(["/proxy/8080/docs", "https://github.com/x"]);
    expect(screen.queryByTestId("stub-native-engine")).toBeNull();
    expect(screen.getAllByTestId("stub-engine")).toHaveLength(2);
  });
});
