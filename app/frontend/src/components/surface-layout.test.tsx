import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { useEffect } from "react";
import { render, screen, cleanup, fireEvent, act, within, waitFor } from "@testing-library/react";
import { SurfaceLayout } from "./surface-layout";
import type { CodeTileCommands } from "./surface-layout";
import { ToastProvider } from "@/components/toast";
import {
  parseLayoutTree,
  serializeLayoutTree,
  sizesStorageKey,
  type Layout,
  type Rect,
  type SurfaceKind,
} from "@/lib/surface-layout";
import type { WindowInfo } from "@/types";
import { stubMatchMedia } from "@/test-utils/match-media";
import { makeWindow } from "@/test-utils/fixtures";
import { COARSE_POINTER_QUERY } from "@/hooks/use-coarse-pointer";
import { entryKey, useWindowStore } from "@/store/window-store";
import type { CodeBridgeResult } from "@/api/client";
import type { GuiSurfaceCommands } from "./gui-surface";
import type { GuiPointerMode, GuiZoom } from "@/lib/gui-posture";
import type { GuiPaletteAction } from "@/lib/palette/gui";
import { focusMemoryKey, recallFocus, resetFocusMemory } from "@/lib/focus-memory";

// jsdom does not implement matchMedia — Tip's coarse-pointer check needs it.
// Default to the fine-pointer branch (tooltips enabled).
stubMatchMedia(() => false);

// Heavy children are mocked (the RightPanel/app-test precedent): TerminalClient
// opens websockets and pulls in xterm's import-time addon init; the iframe
// renderers are asserted by testid instead. `terminalSpy` records each mount's
// props so the duplicate-tty ref/focus rules are assertable; `codeSpy` does the
// same for the code tile's focus-seam prop (`onInteract`, 260812-wfic R2).
const terminalSpy = vi.hoisted(() => vi.fn());
const codeSpy = vi.hoisted(() => vi.fn());
const iframeSpy = vi.hoisted(() => vi.fn());
// The passive SearchAddon the real TerminalClient fills into searchAddonRef at
// init — mocked so find-state tests can assert decoration clearing across a
// window switch (the addon instance persists with the terminal's ride).
const searchAddonMock = vi.hoisted(() => ({
  clearDecorations: vi.fn(),
  onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
  findNext: vi.fn(() => true),
  findPrevious: vi.fn(() => true),
}));
vi.mock("@/components/terminal-client", () => ({
  TerminalClient: (props: Record<string, unknown>) => {
    terminalSpy(props);
    // Fill the addon seam from an effect, mirroring the real component's
    // init-time fill (never during render — the proxy setter setStates the
    // parent).
    const searchAddonRef = props.searchAddonRef as
      | { current: unknown }
      | undefined;
    useEffect(() => {
      if (!searchAddonRef) return;
      searchAddonRef.current = searchAddonMock;
      return () => {
        searchAddonRef.current = null;
      };
    }, [searchAddonRef]);
    return <div data-testid="mock-terminal" />;
  },
}));
vi.mock("@/components/code-surface", () => ({
  CodeSurface: (props: Record<string, unknown>) => {
    codeSpy(props);
    return <div data-testid="mock-code" />;
  },
}));
vi.mock("@/components/iframe-window", async () => {
  // The web tile additionally mirrors the layout's drag posture (the native
  // engine's live-resize/hide signal) onto the mock for assertion.
  const { useTileDragPosture } = await vi.importActual<
    typeof import("@/lib/tile-drag-context")
  >("@/lib/tile-drag-context");
  return {
    IframeWindow: (props: Record<string, unknown>) => {
      iframeSpy(props);
      return (
        <div data-testid="mock-iframe" data-tile-dragging={useTileDragPosture()} />
      );
    },
  };
});
// The gui tile is lazy-loaded (noVNC's weight); the mock's default export
// resolves the dynamic import instantly and records the seam props.
const guiSpy = vi.hoisted(() => vi.fn());
vi.mock("@/components/gui-surface", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    guiSpy(props);
    return <div data-testid="mock-gui" />;
  },
}));

// The web-tab strip verbs POST through the client; the optimistic-override
// tests assert the call shape and control the resolution timing.
const apiSpy = vi.hoisted(() => ({
  addWebTab: vi.fn(),
  moveWebTab: vi.fn(),
  removeWebTab: vi.fn(),
  selectWebTab: vi.fn(),
  setWindowOptions: vi.fn(),
}));
vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/client")>()),
  ...apiSpy,
}));

// jsdom lacks pointer capture — the divider drag handlers call it. Stub the
// trio (hasPointerCapture: false also exercises the release-guard branch).
beforeEach(() => {
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function () {};
    Element.prototype.releasePointerCapture = function () {};
    Element.prototype.hasPointerCapture = function () {
      return false;
    };
  }
});

const FULL_WINDOW = {
  webTabs: ["http://localhost:8080"],
  webActive: 1,
  gitRoot: "/repo",
};

/** Build a layout tree from its string form (tree grammar or legacy preset) —
 *  throws on a malformed fixture start, so a typo fails loud. */
function layoutOf(raw: string): Layout {
  const tree = parseLayoutTree(raw);
  if (!tree) throw new Error(`fixture layout ${JSON.stringify(raw)} does not parse`);
  return tree;
}

type LayoutOverrides = {
  layout?: Layout;
  server?: string;
  windowId?: string;
  window?: object | null;
  isMobile?: boolean;
  mobileActiveSlot?: number;
  onClose?: (leafId: string) => void;
  onApplyLayout?: (next: Layout) => void;
  onSendHome?: (from: string, leafAddr: string) => void;
  onGoToWindow?: (windowId: string) => void;
  onBorrowDrop?: (leafAddr: string, tree: Layout) => void;
  onSplitPane?: (horizontal: boolean) => void;
  onClosePane?: () => void;
  onRatioChange?: (index: number, pct: number) => void;
  onRatioCommit?: () => void;
  layoutRectsRef?: { current: (() => Map<string, Rect>) | null };
  onFocusedLeafChange?: (leafId: string) => void;
  onCodeFolderNavigated?: (folder: string) => void | Promise<void>;
  onCodeFollowTerminal?: (folder: string) => void | Promise<void>;
  codeCommandsRef?: { current: CodeTileCommands | null };
  shouldReclaimChord?: (kind: SurfaceKind) => (e: KeyboardEvent) => boolean;
  codeSrcFor?: (windowId: string) => string | null;
  liveWindowIds?: ReadonlySet<string>;
  codeRootForWindow?: (windowId: string) => string;
  fetchBridgeStatusFor?: Parameters<typeof SurfaceLayout>[0]["fetchBridgeStatusFor"];
  codeFollowSrc?: { src: string; nonce: number; root: string; windowId: string } | null;
  codeReachable?: boolean;
  zoomToggleRef?: { current: (() => void) | null };
  onZoomChange?: (zoomed: boolean) => void;
  onFocusedKindChange?: (kind: SurfaceKind) => void;
  focusTileRef?: { current: ((kind: SurfaceKind) => void) | null };
  statusWindow?: WindowInfo | null;
  windowsById?: ReadonlyMap<string, WindowInfo>;
  sessionNameByWindowId?: ReadonlyMap<string, string>;
  ttyDockContent?: React.ReactNode;
  popoutLeafId?: string;
  onPopBackIn?: () => void;
  popped?: string[];
  onPopOut?: (leafId: string, rect?: Rect) => void;
  revealedPoppedIds?: string[];
  onPopIn?: (leafId: string) => void;
  onFocusPopout?: (leafId: string) => void;
  onHidePopped?: (leafId: string) => void;
  gui?: Parameters<typeof SurfaceLayout>[0]["gui"];
  guiZoom?: GuiZoom;
  guiPointerMode?: GuiPointerMode;
  onGuiZoomChange?: (z: GuiZoom) => void;
  guiResizeLocked?: boolean;
  onGuiConnection?: (connected: boolean) => void;
  onGuiRestart?: () => Promise<{ ok: boolean; disabled?: boolean }>;
  onGuiOpenLogs?: () => void;
  guiCommandsRef?: { current: GuiSurfaceCommands | null };
  guiActions?: GuiPaletteAction[];
  guiToolbarVisible?: boolean;
  onGuiToolbarVisibleChange?: (visible: boolean) => void;
  webCapture?: boolean;
  onWebCaptureChange?: (on: boolean) => void;
};

/** The minimal WindowInfo the tty header's StatusDot consumes (260812-wfic
 *  R6) — `agentState: "active"` renders the sidebar's active-agent dot. */
const STATUS_WINDOW: WindowInfo = {
  windowId: "@1",
  index: 0,
  name: "win",
  worktreePath: "/repo",
  activity: "idle",
  isActiveWindow: true,
  activityTimestamp: 0,
  agentState: "active",
};

/** The SurfaceLayout element with test-default props (shared by renderLayout
 *  and rerender calls so a prop-driven layout change — e.g. a tile CLOSE —
 *  re-renders the SAME component tree). */
function layoutElement(overrides: LayoutOverrides = {}) {
  return (
    // SurfaceLayout toasts export failures — the provider is part of the
    // render contract (the production shell always mounts it).
    <ToastProvider>
      <SurfaceLayout
      layout={overrides.layout ?? layoutOf("tty")}
      server={overrides.server ?? "srv"}
      windowId={overrides.windowId ?? "@1"}
      sessionName="sess"
      window={overrides.window === undefined ? FULL_WINDOW : overrides.window}
      isMobile={overrides.isMobile ?? false}
      mobileActiveSlot={overrides.mobileActiveSlot}
      wsRef={{ current: null }}
      focusRef={{ current: null }}
      scrollLocked={false}
      onSessionNotFound={vi.fn()}
      codeReachable={overrides.codeReachable ?? true}
      onClose={overrides.onClose ?? vi.fn()}
      onApplyLayout={overrides.onApplyLayout ?? vi.fn()}
      onSendHome={overrides.onSendHome}
      onGoToWindow={overrides.onGoToWindow}
      onBorrowDrop={overrides.onBorrowDrop}
      onSplitPane={overrides.onSplitPane ?? vi.fn()}
      onClosePane={overrides.onClosePane ?? vi.fn()}
      onRatioChange={overrides.onRatioChange}
      onRatioCommit={overrides.onRatioCommit}
      layoutRectsRef={overrides.layoutRectsRef}
      onCodeFolderNavigated={overrides.onCodeFolderNavigated}
      onCodeFollowTerminal={overrides.onCodeFollowTerminal}
      codeCommandsRef={overrides.codeCommandsRef}
      shouldReclaimChord={overrides.shouldReclaimChord}
      codeSrcFor={overrides.codeSrcFor}
      liveWindowIds={overrides.liveWindowIds}
      codeRootForWindow={overrides.codeRootForWindow}
      fetchBridgeStatusFor={overrides.fetchBridgeStatusFor}
      codeFollowSrc={overrides.codeFollowSrc}
      zoomToggleRef={overrides.zoomToggleRef}
      onZoomChange={overrides.onZoomChange}
      onFocusedKindChange={overrides.onFocusedKindChange}
      onFocusedLeafChange={overrides.onFocusedLeafChange}
      focusTileRef={overrides.focusTileRef}
      statusWindow={overrides.statusWindow}
      windowsById={overrides.windowsById}
      sessionNameByWindowId={overrides.sessionNameByWindowId}
      ttyDockContent={overrides.ttyDockContent}
      popoutLeafId={overrides.popoutLeafId}
      onPopBackIn={overrides.onPopBackIn}
      popped={overrides.popped}
      onPopOut={overrides.onPopOut}
      revealedPoppedIds={overrides.revealedPoppedIds}
      onPopIn={overrides.onPopIn}
      onFocusPopout={overrides.onFocusPopout}
      onHidePopped={overrides.onHidePopped}
      gui={overrides.gui}
      guiZoom={overrides.guiZoom}
      guiPointerMode={overrides.guiPointerMode}
      onGuiZoomChange={overrides.onGuiZoomChange}
      guiResizeLocked={overrides.guiResizeLocked}
      onGuiConnection={overrides.onGuiConnection ?? vi.fn()}
      onGuiRestart={overrides.onGuiRestart ?? vi.fn()}
      onGuiOpenLogs={overrides.onGuiOpenLogs ?? vi.fn()}
      guiCommandsRef={overrides.guiCommandsRef}
      guiActions={overrides.guiActions}
      guiToolbarVisible={overrides.guiToolbarVisible}
      onGuiToolbarVisibleChange={overrides.onGuiToolbarVisibleChange}
      webCapture={overrides.webCapture}
      onWebCaptureChange={overrides.onWebCaptureChange}
      />
    </ToastProvider>
  );
}

function renderLayout(overrides: LayoutOverrides = {}) {
  return render(layoutElement(overrides));
}

/** Measure the layout container at w×h: the mount-time measure reads
 *  getBoundingClientRect ONCE (the stub ResizeObserver never fires), so the
 *  spy must be installed BEFORE render; every other element keeps jsdom's
 *  zero rect. Pair with `vi.restoreAllMocks()` in the describe's afterEach —
 *  the prototype-level spy must not leak into other suites. */
function measureGrid(w: number, h: number) {
  const gridRect = {
    left: 0, top: 0, width: w, height: h, right: w, bottom: h, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  const zero = {
    left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    return this instanceof HTMLElement && this.dataset.testid === "surface-layout"
      ? gridRect
      : zero;
  });
}

beforeEach(() => {
  localStorage.clear();
  terminalSpy.mockClear();
  codeSpy.mockClear();
  iframeSpy.mockClear();
  guiSpy.mockClear();
  searchAddonMock.clearDecorations.mockClear();
  searchAddonMock.onDidChangeResults.mockClear();
  searchAddonMock.findNext.mockClear();
  searchAddonMock.findPrevious.mockClear();
  resetFocusMemory();
  for (const spy of Object.values(apiSpy)) spy.mockReset();
  useWindowStore.setState({ entries: new Map(), ghosts: [] });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("SurfaceLayout tree rendering", () => {
  it("a bare leaf renders one tile, no dividers, and NO verb buttons", () => {
    renderLayout();
    expect(screen.getByTestId("surface-layout")).toBeTruthy();
    expect(screen.getByTestId("surface-tile-tty")).toBeTruthy();
    expect(screen.queryByTestId("surface-divider-0")).toBeNull();
    // A bare leaf renders no ⛶/◧/⇄/✕ (zoom is arity>1-only; closing the last
    // tile is disallowed).
    expect(screen.queryByRole("button", { name: "Expand Terminal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Promote Terminal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Swap Terminal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close Terminal" })).toBeNull();
  });

  it("an h split renders two tiles and one divider", () => {
    renderLayout({ layout: layoutOf("h(tty,code)") });
    expect(screen.getByTestId("surface-tile-tty")).toBeTruthy();
    expect(screen.getByTestId("surface-tile-code")).toBeTruthy();
    expect(screen.getByTestId("surface-divider-0")).toBeTruthy();
    expect(screen.queryByTestId("surface-divider-1")).toBeNull();
    expect(screen.getByTestId("mock-terminal")).toBeTruthy();
    expect(screen.getByTestId("mock-code")).toBeTruthy();
  });

  it("a v split renders two tiles and one divider", () => {
    renderLayout({ layout: layoutOf("v(tty,web)") });
    expect(screen.getByTestId("surface-tile-tty")).toBeTruthy();
    expect(screen.getByTestId("surface-tile-web")).toBeTruthy();
    expect(screen.getByTestId("surface-divider-0")).toBeTruthy();
    expect(screen.queryByTestId("surface-divider-1")).toBeNull();
    expect(screen.getByTestId("mock-iframe")).toBeTruthy();
  });

  it("every 3-leaf template structure renders three tiles and two dividers", () => {
    for (const raw of [
      "h(tty,code,web)",
      "v(tty,code,web)",
      "h(tty,v(code,web))",
      "h(v(code,web),tty)",
      "v(tty,h(code,web))",
      "v(h(code,web),tty)",
    ]) {
      cleanup();
      renderLayout({ layout: layoutOf(raw) });
      expect(screen.getByTestId("surface-tile-tty")).toBeTruthy();
      expect(screen.getByTestId("surface-tile-code")).toBeTruthy();
      expect(screen.getByTestId("surface-tile-web")).toBeTruthy();
      expect(screen.getByTestId("surface-divider-0")).toBeTruthy();
      expect(screen.getByTestId("surface-divider-1")).toBeTruthy();
      expect(screen.queryByTestId("surface-divider-2")).toBeNull();
    }
  });

  it("renders tile meta: git-root basename for code, web-url host for web", () => {
    renderLayout({ layout: layoutOf("h(code,web)") });
    const codeTile = screen.getByTestId("surface-tile-code");
    expect(codeTile.textContent).toContain("repo");
    const webTile = screen.getByTestId("surface-tile-web");
    expect(webTile.textContent).toContain("localhost:8080");
  });

  it("lays tiles out as ONE flat list of absolutely positioned leaves placed from their rects", () => {
    // jsdom never measures the container (zero rects, stub ResizeObserver), so
    // the tiles render the NOMINAL_BOX proportions as percentage styles —
    // h(tty,web) at equal shares over 1600×1000 with the 6px gutter: each
    // leaf is (1600-6)/2 = 797 wide → 49.8125%; web starts at 803 → 50.1875%.
    renderLayout({ layout: layoutOf("h(tty,web)") });
    const grid = screen.getByTestId("surface-layout");
    const tty = screen.getByTestId("surface-tile-tty");
    const web = screen.getByTestId("surface-tile-web");
    // Flat: every tile is a DIRECT child of the one container (no nested
    // split wrappers), absolutely positioned.
    for (const tile of [tty, web]) {
      expect(tile.parentElement).toBe(grid);
      expect(tile.className).toContain("absolute");
    }
    expect(parseFloat(tty.style.left)).toBeCloseTo(0, 5);
    expect(parseFloat(tty.style.width)).toBeCloseTo(49.8125, 3);
    expect(parseFloat(tty.style.height)).toBeCloseTo(100, 5);
    expect(parseFloat(web.style.left)).toBeCloseTo(50.1875, 3);
    expect(parseFloat(web.style.width)).toBeCloseTo(49.8125, 3);
  });

  // Web tile header (260819-v6y4 R10): kind badge (design-study hues) + the
  // reported page title, falling back to the address's display form. The
  // tileMeta web branch derives through web-url.ts — relative `/present/…` /
  // `/proxy/…` addresses get header meta instead of the old `new URL` throw.
  describe("web tile header badge + title (260819-v6y4 R10)", () => {
    it("a presented file gets the green present badge and the basename display form", () => {
      renderLayout({
        layout: layoutOf("h(tty,web)"),
        window: { webTabs: ["/present/@320/tmux-version-floor.html?server=runKit&v=1"], webActive: 1 },
      });
      const webTile = screen.getByTestId("surface-tile-web");
      const badge = within(webTile).getByTestId("web-kind-badge");
      expect(badge.textContent).toBe("present");
      expect(badge.className).toContain("text-accent-green");
      // No page title reported (IframeWindow is mocked) → display-form fallback.
      expect(webTile.textContent).toContain("tmux-version-floor.html");
    });

    it("a proxied port gets the amber :{port} proxy badge (relative URL — the old new URL throw)", () => {
      renderLayout({
        layout: layoutOf("h(tty,web)"),
        window: { webTabs: ["/proxy/3000/board/runKit"], webActive: 1 },
      });
      const webTile = screen.getByTestId("surface-tile-web");
      const badge = within(webTile).getByTestId("web-kind-badge");
      expect(badge.textContent).toBe(":3000 proxy");
      expect(badge.className).toContain("text-signal-yellow");
      expect(webTile.textContent).toContain("localhost:3000/board/runKit");
    });

    it("an external URL gets the blue external badge", () => {
      renderLayout({
        layout: layoutOf("h(tty,web)"),
        window: { webTabs: ["https://shll.ai/rk/skill"], webActive: 1 },
      });
      const webTile = screen.getByTestId("surface-tile-web");
      const badge = within(webTile).getByTestId("web-kind-badge");
      expect(badge.textContent).toBe("external");
      expect(badge.className).toContain("text-signal-blue");
      expect(webTile.textContent).toContain("shll.ai/rk/skill");
    });

    it("the reported page title replaces the display form via the onPageMeta seam", () => {
      renderLayout({ layout: layoutOf("h(tty,web)") });
      const props = iframeSpy.mock.lastCall?.[0] as {
        onPageMeta?: (meta: { title: string | null }) => void;
      };
      expect(props.onPageMeta).toBeTruthy();
      act(() => props.onPageMeta!({ title: "tmux Version Floor" }));
      const webTile = screen.getByTestId("surface-tile-web");
      expect(webTile.textContent).toContain("tmux Version Floor");
      // A null report (cross-origin / empty) falls back to the display form.
      act(() => props.onPageMeta!({ title: null }));
      expect(webTile.textContent).toContain("localhost:8080");
    });
  });
});

describe("SurfaceLayout tile verbs", () => {
  it("the header verb cluster is zoom + close only — rearrangement is the header drag and the palette", () => {
    const onClose = vi.fn();
    renderLayout({ layout: layoutOf("h(tty,code)"), onClose });
    expect(screen.getByRole("button", { name: "Expand Code" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Promote Code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Swap Terminal" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close Code" }));
    expect(onClose).toHaveBeenCalledWith("code");
  });

  it("verb buttons are boxed and visible at rest at full opacity", () => {
    renderLayout({ layout: layoutOf("h(tty,code)") });
    const close = screen.getByRole("button", { name: "Close Code" });
    // Full-opacity 24×24 boxed buttons (26×26 coarse) — no rest-state alpha
    // dim (the retired 65% dim failed WCAG SC 1.4.11 over bg-card), and the
    // even older pattern was hover-revealed (`opacity-0 group-hover:…`).
    expect(close.className).not.toContain("opacity-");
    expect(close.className).toContain("h-[24px]");
    expect(close.className).toContain("w-[24px]");
    expect(close.className).toContain("coarse:h-[26px]");
    expect(close.className).toContain("coarse:w-[26px]");
    expect(close.className).not.toContain("group-hover");
    // The destructive verb reddens on hover; the safe verbs brighten.
    expect(close.className).toContain("hover:text-signal-red");
    const zoom = screen.getByRole("button", { name: "Expand Code" });
    expect(zoom.className).toContain("hover:bg-bg-card");
  });
});

describe("SurfaceLayout pane segment (260813-w1lf content verbs)", () => {
  it("tty at arity 1 renders the bordered pane segment and zero layout verbs", () => {
    renderLayout({ layout: layoutOf("tty") });
    const ttyTile = screen.getByTestId("surface-tile-tty");
    const segment = within(ttyTile).getByTestId("pane-segment");
    expect(segment.className).toContain("border");
    expect(segment.className).toContain("rounded");
    expect(within(segment).getByRole("button", { name: "Split pane horizontally" })).toBeTruthy();
    expect(within(segment).getByRole("button", { name: "Split pane vertically" })).toBeTruthy();
    expect(within(segment).getByRole("button", { name: "Close pane" })).toBeTruthy();
    // The layout-verb family stays arity-gated — none render at arity 1.
    expect(screen.queryByRole("button", { name: "Expand Terminal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Promote Terminal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Swap Terminal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close Terminal" })).toBeNull();
  });

  it("renders only on tty tiles — code/web headers carry no segment", () => {
    renderLayout({ layout: layoutOf("h(code,web)") });
    expect(screen.queryByTestId("pane-segment")).toBeNull();
    cleanup();
    renderLayout({ layout: layoutOf("h(tty,code)") });
    expect(screen.getAllByTestId("pane-segment")).toHaveLength(1);
    expect(within(screen.getByTestId("surface-tile-code")).queryByTestId("pane-segment")).toBeNull();
  });

  it("stays visible while the tty tile is zoomed (✕/⛶ stay)", () => {
    renderLayout({ layout: layoutOf("h(tty,code)") });
    fireEvent.click(screen.getByRole("button", { name: "Expand Terminal" }));
    const ttyTile = screen.getByTestId("surface-tile-tty");
    expect(within(ttyTile).getByTestId("pane-segment")).toBeTruthy();
    expect(within(ttyTile).getByRole("button", { name: "Split pane horizontally" })).toBeTruthy();
    expect(within(ttyTile).getByRole("button", { name: "Close Terminal" })).toBeTruthy();
  });

  it("both duplicate tty tiles carry the segment", () => {
    renderLayout({ layout: layoutOf("h(tty,tty)") });
    expect(screen.getAllByTestId("pane-segment")).toHaveLength(2);
    expect(within(screen.getByTestId("surface-tile-tty")).getByTestId("pane-segment")).toBeTruthy();
    expect(within(screen.getByTestId("surface-tile-tty-2")).getByTestId("pane-segment")).toBeTruthy();
  });

  it("clicks fire the parent's pane callbacks with the tile's window id", () => {
    const onSplitPane = vi.fn();
    const onClosePane = vi.fn();
    renderLayout({ onSplitPane, onClosePane });
    fireEvent.click(screen.getByRole("button", { name: "Split pane horizontally" }));
    expect(onSplitPane).toHaveBeenCalledWith(true, "@1");
    fireEvent.click(screen.getByRole("button", { name: "Split pane vertically" }));
    expect(onSplitPane).toHaveBeenCalledWith(false, "@1");
    fireEvent.click(screen.getByRole("button", { name: "Close pane" }));
    expect(onClosePane).toHaveBeenCalledWith("@1");
  });

  it("Close Pane renders the boxed ⊠ glyph (not the bare ✕) with a red hover; splits use the standard verb hover", () => {
    renderLayout({ layout: layoutOf("h(tty,code)") });
    const close = screen.getByRole("button", { name: "Close pane" });
    expect(close.querySelector('[data-icon="close-pane-boxed"]')).toBeTruthy();
    expect(close.querySelector('[data-icon="close-pane"]')).toBeNull();
    expect(close.className).toContain("hover:text-signal-red");
    const split = screen.getByRole("button", { name: "Split pane horizontally" });
    expect(split.querySelector('[data-icon="split-horizontal"]')).toBeTruthy();
    expect(split.className).toContain("hover:text-text-primary");
    expect(split.className).not.toContain("accent-green");
    expect(
      screen.getByRole("button", { name: "Split pane vertically" }).querySelector('[data-icon="split-vertical"]'),
    ).toBeTruthy();
  });
});

describe("SurfaceLayout zoom", () => {
  it("a shared reorder moves the zoom with its surface KIND, never the slot index", () => {
    const { rerender } = renderLayout({ layout: layoutOf("h(tty,code)") });
    fireEvent.click(screen.getByRole("button", { name: "Expand Code" }));
    expect(screen.getByTestId("surface-tile-tty").classList.contains("hidden")).toBe(true);
    expect(localStorage.getItem("rk-layout-zoom:srv:@1")).toBe("code");
    // Another viewer promotes code: slot 0 is now code, slot 1 is tty. The
    // zoom must follow code (still zoomed, tty still hidden) rather than stay
    // on slot 1 and zoom the terminal.
    rerender(layoutElement({ layout: layoutOf("h(code,tty)") }));
    expect(screen.getByTestId("surface-tile-tty").classList.contains("hidden")).toBe(true);
    expect(screen.getByTestId("surface-tile-code").classList.contains("hidden")).toBe(false);
    expect(localStorage.getItem("rk-layout-zoom:srv:@1")).toBe("code");
    // The zoomed kind leaving the layout clears the zoom and the key.
    rerender(layoutElement({ layout: layoutOf("h(tty,web)") }));
    expect(screen.getByTestId("surface-tile-tty").classList.contains("hidden")).toBe(false);
    expect(localStorage.getItem("rk-layout-zoom:srv:@1")).toBeNull();
  });

  it("zoom hides the other tiles at display level WITHOUT unmounting", () => {
    renderLayout({ layout: layoutOf("h(tty,code)") });
    fireEvent.click(screen.getByRole("button", { name: "Expand Code" }));
    const ttyTile = screen.getByTestId("surface-tile-tty");
    expect(ttyTile.classList.contains("hidden")).toBe(true);
    // Still mounted — the terminal's state survives the zoom.
    expect(screen.getByTestId("mock-terminal")).toBeTruthy();
    // Dividers do not render while zoomed.
    expect(screen.queryByTestId("surface-divider-0")).toBeNull();
    // Un-zoom restores the tile.
    fireEvent.click(screen.getByRole("button", { name: "Restore Code" }));
    expect(screen.getByTestId("surface-tile-tty").classList.contains("hidden")).toBe(false);
    expect(screen.getByTestId("surface-divider-0")).toBeTruthy();
  });

  it("zoomed tile shows the latch well on its zoom verb; ✕ stays", () => {
    renderLayout({ layout: layoutOf("h(tty,code)") });
    fireEvent.click(screen.getByRole("button", { name: "Expand Code" }));
    const unzoom = screen.getByRole("button", { name: "Restore Code" });
    expect(unzoom.querySelector('[data-icon="zoom"]')).toBeTruthy();
    expect(unzoom.className).toContain("text-accent-green-ink");
    expect(unzoom.className).toContain("rk-latch-well");
    expect(unzoom.className).not.toContain("ring-accent-green");
    expect(unzoom).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Close Code" })).toBeTruthy();
    // Restore returns the default glyph color.
    fireEvent.click(unzoom);
    const zoom = screen.getByRole("button", { name: "Expand Code" });
    expect(zoom.className).not.toContain("text-accent-green");
    expect(zoom).toHaveAttribute("aria-pressed", "false");
  });
});

describe("SurfaceLayout web header keyboard capture", () => {
  const SPLIT: Layout = layoutOf("h(tty,web)");

  it("renders the capture verb in the web header beside Expand/Close, flipping the latch on click", () => {
    const onWebCaptureChange = vi.fn();
    const { rerender } = renderLayout({ layout: SPLIT, onWebCaptureChange });
    const header = screen.getByTestId("surface-tile-web");
    const btn = within(header).getByTestId("web-capture-toggle");
    expect(btn).toHaveAttribute("aria-pressed", "false");
    // It shares the header rail with the layout verbs — same row, before Expand.
    const expand = within(header).getByRole("button", { name: "Expand Web" });
    expect(btn.parentElement).toBe(expand.parentElement);
    expect(btn.compareDocumentPosition(expand) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("web-capture-chip")).toBeNull();
    fireEvent.click(btn);
    expect(onWebCaptureChange).toHaveBeenCalledWith(true);

    rerender(layoutElement({ layout: SPLIT, onWebCaptureChange, webCapture: true }));
    expect(screen.getByTestId("web-capture-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("web-capture-chip").textContent).toBe("keys → page");
    fireEvent.click(screen.getByTestId("web-capture-toggle"));
    expect(onWebCaptureChange).toHaveBeenLastCalledWith(false);
  });

  it("renders at arity 1 too (no layout verbs) — capture is a content verb", () => {
    renderLayout({ layout: layoutOf("web"), onWebCaptureChange: vi.fn() });
    expect(screen.getByTestId("web-capture-toggle")).toBeTruthy();
  });

  it("is absent on an onboarding tile (no URL), on mobile, and when unwired", () => {
    const { unmount } = renderLayout({
      layout: SPLIT,
      window: { webTabs: [], webActive: 0 },
      onWebCaptureChange: vi.fn(),
    });
    expect(screen.queryByTestId("web-capture-toggle")).toBeNull();
    unmount();
    const second = renderLayout({ layout: SPLIT, isMobile: true, onWebCaptureChange: vi.fn() });
    expect(screen.queryByTestId("web-capture-toggle")).toBeNull();
    second.unmount();
    renderLayout({ layout: SPLIT });
    expect(screen.queryByTestId("web-capture-toggle")).toBeNull();
  });

  it("never renders on non-web tiles", () => {
    renderLayout({ layout: layoutOf("h(tty,code)"), onWebCaptureChange: vi.fn() });
    expect(screen.queryByTestId("web-capture-toggle")).toBeNull();
  });
});

describe("SurfaceLayout per-window reset (server-keyed grid, windowId prop change)", () => {
  const SPLIT: Layout = layoutOf("h(tty,web)");

  it("resets the zoom from the NEW window's stored key — and never writes the old window's key", () => {
    // @1 zoomed on web; @2 has no stored zoom.
    const { rerender } = renderLayout({ layout: SPLIT });
    fireEvent.click(screen.getByRole("button", { name: "Expand Web" }));
    expect(screen.getByTestId("surface-tile-tty").classList.contains("hidden")).toBe(true);
    expect(localStorage.getItem("rk-layout-zoom:srv:@1")).toBe("web");

    rerender(layoutElement({ layout: SPLIT, windowId: "@2" }));
    // @2's stored key is empty → unzoomed, both tiles visible.
    expect(screen.getByTestId("surface-tile-tty").classList.contains("hidden")).toBe(false);
    expect(screen.getByTestId("surface-tile-web").classList.contains("hidden")).toBe(false);
    // The reset re-DERIVES, it does not write: @1 keeps its zoom, @2 gets none.
    expect(localStorage.getItem("rk-layout-zoom:srv:@1")).toBe("web");
    expect(localStorage.getItem("rk-layout-zoom:srv:@2")).toBeNull();

    // @3 has web zoomed in its stored key → the switch re-derives the zoom.
    localStorage.setItem("rk-layout-zoom:srv:@3", "web");
    rerender(layoutElement({ layout: SPLIT, windowId: "@3" }));
    expect(screen.getByTestId("surface-tile-tty").classList.contains("hidden")).toBe(true);
    expect(screen.getByTestId("surface-tile-web").classList.contains("hidden")).toBe(false);
  });

  it("keeps the NEW window's stored zoom when the OLD window's zoomed kind is absent from the new layout", () => {
    // @1 is zoomed on web. @2's layout has no web tile but a valid stored
    // zoom on code. The zoom reconciliation effect must not treat @1's
    // now-homeless zoom as @2's and write `null` under @2's key.
    const { rerender } = renderLayout({ layout: SPLIT });
    fireEvent.click(screen.getByRole("button", { name: "Expand Web" }));
    expect(localStorage.getItem("rk-layout-zoom:srv:@1")).toBe("web");

    localStorage.setItem("rk-layout-zoom:srv:@2", "code");
    rerender(
      layoutElement({ layout: layoutOf("h(tty,code)"), windowId: "@2" }),
    );
    expect(localStorage.getItem("rk-layout-zoom:srv:@2")).toBe("code");
    expect(screen.getByTestId("surface-tile-tty").classList.contains("hidden")).toBe(true);
    expect(screen.getByTestId("surface-tile-code").classList.contains("hidden")).toBe(false);
    // @1's own key is untouched too.
    expect(localStorage.getItem("rk-layout-zoom:srv:@1")).toBe("web");
  });

  it("resets the focused slot to slot A and re-reports the kind exactly once", () => {
    const kindSpy = vi.fn();
    const { rerender } = renderLayout({ layout: SPLIT, onFocusedKindChange: kindSpy });
    // Mount reports slot A's kind once.
    expect(kindSpy).toHaveBeenCalledTimes(1);
    expect(kindSpy).toHaveBeenLastCalledWith("tty");

    // Focus the web tile (pointerdown capture on the tile wrapper).
    fireEvent.pointerDown(screen.getByTestId("surface-tile-web"));
    expect(kindSpy).toHaveBeenLastCalledWith("web");
    expect(
      screen.getByTestId("surface-tile-web").className.includes("border-accent-green"),
    ).toBe(true);

    kindSpy.mockClear();
    rerender(layoutElement({ layout: SPLIT, windowId: "@2", onFocusedKindChange: kindSpy }));
    // Slot A is focused again and re-reported — exactly once.
    expect(kindSpy).toHaveBeenCalledTimes(1);
    expect(kindSpy).toHaveBeenLastCalledWith("tty");
    expect(
      screen.getByTestId("surface-tile-tty").className.includes("border-accent-green"),
    ).toBe(true);
  });

  it("resets the hide-never-unmount set to the new window's layout kinds", () => {
    const { rerender } = renderLayout({ layout: SPLIT });
    // Close the web tile on @1: the parent collapses the layout, but
    // hide-never-unmount keeps the iframe mounted-hidden.
    rerender(layoutElement({ layout: layoutOf("tty") }));
    expect(screen.getByTestId("mock-iframe")).toBeTruthy();
    expect(screen.getByTestId("surface-tile-web").classList.contains("hidden")).toBe(true);

    // A window switch re-seeds everOpened from @2's layout: the stale web
    // tile unmounts.
    rerender(
      layoutElement({ layout: layoutOf("tty"), windowId: "@2" }),
    );
    expect(screen.queryByTestId("mock-iframe")).toBeNull();
  });

  it("closes and clears the find state, clearing decorations on the persistent addon (no focus grab)", () => {
    const { rerender } = renderLayout();
    // The primary tty's search addon seam is filled by the mock TerminalClient.
    expect(searchAddonMock.onDidChangeResults).toHaveBeenCalled();

    // Open the bar and run a search (decorations now live on the buffer).
    fireEvent.click(screen.getByRole("button", { name: "Find in terminal" }));
    const bar = screen.getByTestId("terminal-find-bar");
    fireEvent.change(within(bar).getByRole("textbox"), { target: { value: "needle" } });
    expect(searchAddonMock.findNext).toHaveBeenCalled();
    searchAddonMock.clearDecorations.mockClear();

    rerender(layoutElement({ windowId: "@2" }));
    expect(screen.queryByTestId("terminal-find-bar")).toBeNull();
    // The addon instance persists with the terminal across the ride, so the
    // old window's decorations must be dropped explicitly by the reset.
    expect(searchAddonMock.clearDecorations).toHaveBeenCalled();
  });

  it("clears the web page title reported by the old window's iframe", () => {
    const { rerender } = renderLayout({ layout: SPLIT });
    const props = iframeSpy.mock.lastCall?.[0] as {
      onPageMeta?: (m: { title: string | null }) => void;
    };
    act(() => {
      props.onPageMeta?.({ title: "Old Window Doc" });
    });
    expect(screen.getByText("Old Window Doc")).toBeTruthy();

    rerender(layoutElement({ layout: SPLIT, windowId: "@2" }));
    expect(screen.queryByText("Old Window Doc")).toBeNull();
  });

  it("resets the tty progress line + chip to idle", async () => {
    const { rerender } = renderLayout();
    const props = terminalSpy.mock.lastCall?.[0] as {
      onProgressChange?: (state: number, value: number) => void;
    };
    act(() => {
      props.onProgressChange?.(1, 42);
    });
    // The commit is rAF-coalesced — wait for the frame.
    await waitFor(() => expect(screen.queryByTestId("progress-chip")).toBeTruthy());

    rerender(layoutElement({ windowId: "@2" }));
    expect(screen.queryByTestId("progress-line")).toBeNull();
    expect(screen.queryByTestId("progress-chip")).toBeNull();
  });

  it("keeps the tty tile's and the code frame's DOM nodes across the switch; the web tile's node remounts", () => {
    const LAYOUT: Layout = layoutOf("h(tty,code,web)");
    const codeSrcFor = (id: string) => `/code/?workspace=/ws${id}`;
    const { rerender } = renderLayout({ layout: LAYOUT, codeSrcFor });
    const ttyNode = screen.getByTestId("mock-terminal");
    const codeNode = screen.getByTestId("mock-code");
    const webNode = screen.getByTestId("mock-iframe");

    rerender(layoutElement({ layout: LAYOUT, windowId: "@2", codeSrcFor }));
    // The whole point of the server-keyed grid: the tty tile (and its
    // TerminalClient) is the SAME instance after a same-server switch — and
    // the code frame now survives too, retained display-hidden while @2's own
    // frame shows.
    expect(screen.getByTestId("mock-terminal")).toBe(ttyNode);
    expect(screen.getAllByTestId("mock-code")).toHaveLength(2);
    expect(screen.getAllByTestId("mock-code")).toContain(codeNode);
    expect(codeNode.isConnected).toBe(true);
    expect(
      within(screen.getByTestId("surface-tile-code")).getByTestId("mock-code"),
    ).not.toBe(codeNode);
    // web/gui tiles still carry `windowId` in their key — content identity
    // changes with the window, so the web tile remounts.
    expect(screen.getByTestId("mock-iframe")).not.toBe(webNode);

    // Back to @1: the retained frame becomes visible as the IDENTICAL node
    // (no remount, no reload — the switch-back fast path).
    rerender(layoutElement({ layout: LAYOUT, windowId: "@1", codeSrcFor }));
    expect(screen.getAllByTestId("mock-code")).toHaveLength(2);
    expect(
      within(screen.getByTestId("surface-tile-code")).getByTestId("mock-code"),
    ).toBe(codeNode);
  });

  it("first mount fires NO reset side effects (no duplicate kind report, no key writes)", () => {
    const kindSpy = vi.fn();
    renderLayout({ layout: SPLIT, onFocusedKindChange: kindSpy });
    // Exactly the mount-time slot-A report — the reset effect's first-mount
    // guard must not double it.
    expect(kindSpy).toHaveBeenCalledTimes(1);
    expect(kindSpy).toHaveBeenLastCalledWith("tty");
    // No zoom key written by a mount with no stored zoom.
    expect(localStorage.getItem("rk-layout-zoom:srv:@1")).toBeNull();
  });
});

describe("SurfaceLayout code tile folder (260813-if5d)", () => {
  it("renders the tile body and header basename from the window's folder (the latch)", () => {
    // The parent hands down the LATCHED folder as `gitRoot`; the tile can no
    // longer see the live derivation, so a pane switch cannot reach these.
    renderLayout({
      layout: layoutOf("h(tty,code)"),
      window: { gitRoot: "/home/user/latched" },
    });
    expect(screen.getByTestId("mock-code")).toBeTruthy();
    expect(codeSpy.mock.calls.at(-1)?.[0]?.gitRoot).toBe("/home/user/latched");
    expect(screen.getByTestId("surface-tile-code").textContent).toContain("latched");
  });

  it("renders no code body (and no meta) when the window carries no folder", () => {
    // Never latched AND nothing derivable — exactly the pre-latch behavior.
    renderLayout({
      layout: layoutOf("h(tty,code)"),
      window: { gitRoot: "" },
    });
    expect(screen.queryByTestId("mock-code")).toBeNull();
  });

  it("passes onCodeFolderNavigated straight through to the code tile", () => {
    const onCodeFolderNavigated = vi.fn();
    renderLayout({
      layout: layoutOf("h(tty,code)"),
      onCodeFolderNavigated,
    });
    const reported = codeSpy.mock.calls.at(-1)?.[0]?.onFolderNavigated;
    expect(typeof reported).toBe("function");
    reported("/home/user/other");
    expect(onCodeFolderNavigated).toHaveBeenCalledWith("/home/user/other");
  });

  it("carries the workspace src and follow override down to the code tile", () => {
    // Mount gating + the follow rule are parent-orchestrated (app.tsx); the
    // layout layer only carries the props — a null lookup ⇒ the tile pends.
    const followSrc = { src: "/code/?workspace=%2Fstate%2F%407-bbbbbb.code-workspace", nonce: 2, root: "/other", windowId: "@1" };
    renderLayout({
      layout: layoutOf("h(tty,code)"),
      codeSrcFor: () => "/code/?workspace=%2Fstate%2F%407-3fa1c9.code-workspace",
      codeFollowSrc: followSrc,
    });
    const props = codeSpy.mock.calls.at(-1)?.[0];
    expect(props?.workspaceSrc).toBe("/code/?workspace=%2Fstate%2F%407-3fa1c9.code-workspace");
    expect(props?.followSrc).toEqual(followSrc);
  });

  it("hands the code tile a null workspace src when the parent passes none (pending)", () => {
    renderLayout({ layout: layoutOf("h(tty,code)") });
    const props = codeSpy.mock.calls.at(-1)?.[0];
    expect(props?.workspaceSrc).toBeNull();
    expect(props?.followSrc).toBeNull();
  });
});

describe("SurfaceLayout code-tile header verbs (Follow terminal / Reload editor)", () => {
  const CODE_LAYOUT: Layout = layoutOf("h(tty,code)");
  const codeSrcForAll = (id: string) => `/code/?workspace=/ws${id}`;
  const codeTile = () => screen.getByTestId("surface-tile-code");
  const followVerb = () => within(codeTile()).queryByRole("button", { name: "Follow terminal" });
  const reloadVerb = () => within(codeTile()).queryByRole("button", { name: "Reload editor" });
  /** Props of the currently mounted frames since the last mockClear. */
  const mountedCodeProps = () =>
    codeSpy.mock.calls.map(([props]) => props as Record<string, unknown>);

  it("Follow terminal renders exactly under drift on the active window's tile", () => {
    renderLayout({
      layout: CODE_LAYOUT,
      window: { gitRoot: "/repo.worktrees/x", codeRoot: "/repo" },
    });
    expect(followVerb()).toBeTruthy();
  });

  it("no Follow verb when the roots agree, when codeRoot is empty (pre-seed), or when gitRoot is empty", () => {
    const { rerender } = renderLayout({
      layout: CODE_LAYOUT,
      window: { gitRoot: "/repo", codeRoot: "/repo" },
    });
    expect(followVerb()).toBeNull();
    rerender(layoutElement({ layout: CODE_LAYOUT, window: { gitRoot: "/repo" } }));
    expect(followVerb()).toBeNull();
    rerender(layoutElement({ layout: CODE_LAYOUT, window: { gitRoot: "", codeRoot: "/repo" } }));
    expect(followVerb()).toBeNull();
  });

  it("a retained (other-window) frame's hidden wrapper offers no code verbs", () => {
    const { rerender } = renderLayout({
      layout: CODE_LAYOUT,
      codeSrcFor: codeSrcForAll,
      window: { gitRoot: "/repo.worktrees/x", codeRoot: "/repo" },
    });
    expect(followVerb()).toBeTruthy();
    expect(reloadVerb()).toBeTruthy();

    // Switch to a drift-free window: @1's frame demotes to the retained
    // wrapper, which renders no header verbs (slot -1).
    rerender(layoutElement({
      layout: CODE_LAYOUT,
      windowId: "@2",
      codeSrcFor: codeSrcForAll,
      window: { gitRoot: "/repo", codeRoot: "/repo" },
    }));
    const retained = screen.getByTestId("surface-tile-code-retained");
    expect(within(retained).queryByRole("button", { name: "Follow terminal" })).toBeNull();
    expect(within(retained).queryByRole("button", { name: "Reload editor" })).toBeNull();
    expect(followVerb()).toBeNull(); // @2 has no drift
  });

  it("Reload editor renders once the active window's frame record exists — absent while pending or unreachable", () => {
    // Pending: no src resolved, no frame record.
    const { rerender } = renderLayout({ layout: CODE_LAYOUT });
    expect(reloadVerb()).toBeNull();
    // Resolved: the show bookkeeping creates the record — the verb appears.
    rerender(layoutElement({ layout: CODE_LAYOUT, codeSrcFor: codeSrcForAll }));
    expect(reloadVerb()).toBeTruthy();
    // Unreachable: every frame drops with the host — nothing to reload.
    rerender(layoutElement({ layout: CODE_LAYOUT, codeSrcFor: codeSrcForAll, codeReachable: false }));
    expect(reloadVerb()).toBeNull();
  });

  it("clicking Follow terminal runs the shared wrapper: gitRoot to the parent, pending target recorded, guard held until settle", async () => {
    let settle: () => void = () => {};
    const onCodeFollowTerminal = vi.fn(() => new Promise<void>((r) => { settle = r; }));
    const { rerender } = renderLayout({
      layout: CODE_LAYOUT,
      codeSrcFor: codeSrcForAll,
      codeRootForWindow: () => "/repo",
      window: { gitRoot: "/other", codeRoot: "/repo" },
      onCodeFollowTerminal,
    });
    const node1 = within(codeTile()).getByTestId("mock-code");
    fireEvent.click(followVerb()!);
    expect(onCodeFollowTerminal).toHaveBeenCalledWith("/other");
    // The payload still reads the old root: the in-flight guard blocks a
    // second POST/nonce.
    expect(followVerb()).toBeDisabled();

    // The follow's own latch write lands (payload-first ordering): the
    // pending target marks it a follow — the frame survives with its baseline
    // moved in place, and the verb disappears once the roots agree.
    rerender(layoutElement({
      layout: CODE_LAYOUT,
      codeSrcFor: codeSrcForAll,
      codeRootForWindow: () => "/other",
      window: { gitRoot: "/other", codeRoot: "/other" },
      onCodeFollowTerminal,
    }));
    expect(node1.isConnected).toBe(true);
    expect(within(codeTile()).getByTestId("mock-code")).toBe(node1);
    expect(followVerb()).toBeNull();
    await act(async () => {
      settle();
    });
  });

  it("a rejected follow re-enables the verb — the payload never moved and the target cleared", async () => {
    const onCodeFollowTerminal = vi.fn(() => Promise.reject(new Error("latch failed")));
    renderLayout({
      layout: CODE_LAYOUT,
      window: { gitRoot: "/other", codeRoot: "/repo" },
      onCodeFollowTerminal,
    });
    await act(async () => {
      fireEvent.click(followVerb()!);
    });
    expect(onCodeFollowTerminal).toHaveBeenCalledWith("/other");
    expect(followVerb()).toBeEnabled();
  });

  it("clicking Reload editor bumps the reloadNonce of the ACTIVE window's frame only — a frame created later never replays it", () => {
    const { rerender } = renderLayout({ layout: CODE_LAYOUT, codeSrcFor: codeSrcForAll });
    fireEvent.click(reloadVerb()!);
    expect(mountedCodeProps().at(-1)?.reloadNonce).toBe(1);

    // Switch to @2: its frame is created AFTER @1's reload and receives
    // undefined (the nonce targets @1).
    codeSpy.mockClear();
    rerender(layoutElement({ layout: CODE_LAYOUT, windowId: "@2", codeSrcFor: codeSrcForAll }));
    const forSrc = (src: string) =>
      mountedCodeProps().filter((p) => p.workspaceSrc === src).at(-1);
    expect(forSrc("/code/?workspace=/ws@2")?.reloadNonce).toBeUndefined();

    // Reload on the now-active @2: only its frame's nonce moves.
    fireEvent.click(reloadVerb()!);
    expect(forSrc("/code/?workspace=/ws@2")?.reloadNonce).toBe(2);
    expect(forSrc("/code/?workspace=/ws@1")?.reloadNonce).toBeUndefined();
  });

  it("codeCommandsRef runs the same bodies as the header verbs; null when the code tile leaves the layout", async () => {
    const codeCommandsRef: { current: CodeTileCommands | null } = { current: null };
    const onCodeFollowTerminal = vi.fn(() => Promise.resolve());
    const { rerender } = renderLayout({
      layout: CODE_LAYOUT,
      codeSrcFor: codeSrcForAll,
      window: { gitRoot: "/other", codeRoot: "/repo" },
      onCodeFollowTerminal,
      codeCommandsRef,
    });
    expect(codeCommandsRef.current).not.toBeNull();
    await act(async () => codeCommandsRef.current?.followTerminal());
    expect(onCodeFollowTerminal).toHaveBeenCalledWith("/other");
    codeSpy.mockClear();
    act(() => codeCommandsRef.current?.reload());
    expect(mountedCodeProps().at(-1)?.reloadNonce).toBe(1);

    rerender(layoutElement({
      layout: layoutOf("tty"),
      window: { gitRoot: "/other", codeRoot: "/repo" },
      codeSrcFor: codeSrcForAll,
      onCodeFollowTerminal,
      codeCommandsRef,
    }));
    expect(codeCommandsRef.current).toBeNull();
  });
});

describe("SurfaceLayout code-frame retention (cross-window LRU)", () => {
  const CODE_LAYOUT: Layout = layoutOf("h(tty,code)");
  // Every window resolves immediately, to a src that embeds its id.
  const srcFor = (id: string) => `/code/?workspace=/ws${id}`;
  const codeSrcForAll = (id: string) => srcFor(id);
  const codeNodes = () => screen.getAllByTestId("mock-code");
  /** The visible code tile's frame node (retained wrappers carry a distinct
   *  testid, so `surface-tile-code` is unique). */
  const visibleCodeNode = () =>
    within(screen.getByTestId("surface-tile-code")).getByTestId("mock-code");
  /** Props of the CURRENTLY mounted frames — valid only for the render pass
   *  since the last `codeSpy.mockClear()` (the spy accumulates across renders,
   *  and an evicted frame's stale props must never read as current). */
  const mountedCodeProps = () =>
    codeSpy.mock.calls.map(([props]) => props as Record<string, unknown>);

  it("a fourth distinct window's frame evicts the least-recently-shown (cap 3); a re-show bumps", () => {
    const { rerender } = renderLayout({ layout: CODE_LAYOUT, codeSrcFor: codeSrcForAll });
    const node1 = visibleCodeNode();
    rerender(layoutElement({ layout: CODE_LAYOUT, windowId: "@2", codeSrcFor: codeSrcForAll }));
    const node2 = visibleCodeNode();
    rerender(layoutElement({ layout: CODE_LAYOUT, windowId: "@3", codeSrcFor: codeSrcForAll }));
    expect(codeNodes()).toHaveLength(3);

    // Re-show @1: it bumps to most-recently-shown as the IDENTICAL node.
    rerender(layoutElement({ layout: CODE_LAYOUT, windowId: "@1", codeSrcFor: codeSrcForAll }));
    expect(visibleCodeNode()).toBe(node1);

    // @4's frame overflows the cap: the least-recently-shown (@2) evicts;
    // @1 (just re-shown) and @3 persist.
    rerender(layoutElement({ layout: CODE_LAYOUT, windowId: "@4", codeSrcFor: codeSrcForAll }));
    expect(codeNodes()).toHaveLength(3);
    expect(node1.isConnected).toBe(true);
    expect(node2.isConnected).toBe(false);
  });

  it("isMobile caps at 1: a new window's frame evicts the previous one — but a frame survives a switch to a window with no code tile", () => {
    const { rerender } = renderLayout({
      layout: CODE_LAYOUT,
      isMobile: true,
      mobileActiveSlot: 1,
      codeSrcFor: codeSrcForAll,
    });
    const node1 = visibleCodeNode();
    // @2 never creates a frame (no code tile in its layout): @1's survives.
    rerender(layoutElement({
      layout: layoutOf("tty"),
      isMobile: true,
      windowId: "@2",
      codeSrcFor: codeSrcForAll,
    }));
    expect(codeNodes()).toHaveLength(1);
    expect(node1.isConnected).toBe(true);
    // @3 creates one: at cap 1 the previous frame evicts.
    rerender(layoutElement({
      layout: CODE_LAYOUT,
      isMobile: true,
      mobileActiveSlot: 1,
      windowId: "@3",
      codeSrcFor: codeSrcForAll,
    }));
    expect(codeNodes()).toHaveLength(1);
    expect(node1.isConnected).toBe(false);
  });

  it("codeReachable true→false drops every frame; the recovery mounts a FRESH frame at the current src", () => {
    const { rerender } = renderLayout({ layout: CODE_LAYOUT, codeSrcFor: codeSrcForAll });
    const node1 = visibleCodeNode();
    rerender(layoutElement({ layout: CODE_LAYOUT, windowId: "@2", codeSrcFor: codeSrcForAll }));
    const node2 = visibleCodeNode();
    expect(codeNodes()).toHaveLength(2);

    // The host went away: both frames drop; the active tile falls back to the
    // no-record render (reachable=false, no workspace src). The drop lands via
    // an effect after a render pass, so the LAST pass's props are the settled
    // ones.
    codeSpy.mockClear();
    rerender(layoutElement({ layout: CODE_LAYOUT, windowId: "@2", codeSrcFor: codeSrcForAll, codeReachable: false }));
    expect(node1.isConnected).toBe(false);
    expect(node2.isConnected).toBe(false);
    expect(codeNodes()).toHaveLength(1);
    const downProps = mountedCodeProps().at(-1)!;
    expect(downProps.reachable).toBe(false);
    expect(downProps.workspaceSrc).toBeNull();

    // The recovery starts from an empty LRU: @2's frame is a NEW node.
    rerender(layoutElement({ layout: CODE_LAYOUT, windowId: "@2", codeSrcFor: codeSrcForAll }));
    expect(codeNodes()).toHaveLength(1);
    expect(visibleCodeNode()).not.toBe(node2);
  });

  it("a window leaving the live set drops its frame (kill while hidden), the active one untouched", () => {
    const { rerender } = renderLayout({
      layout: CODE_LAYOUT,
      codeSrcFor: codeSrcForAll,
      liveWindowIds: new Set(["@1", "@2"]),
    });
    const node1 = visibleCodeNode();
    rerender(layoutElement({
      layout: CODE_LAYOUT,
      windowId: "@2",
      codeSrcFor: codeSrcForAll,
      liveWindowIds: new Set(["@1", "@2"]),
    }));
    const node2 = visibleCodeNode();
    expect(codeNodes()).toHaveLength(2);

    // @1 was killed while hidden: its frame unmounts through the ordinary
    // path; @2's frame is untouched.
    rerender(layoutElement({
      layout: CODE_LAYOUT,
      windowId: "@2",
      codeSrcFor: codeSrcForAll,
      liveWindowIds: new Set(["@2"]),
    }));
    expect(node1.isConnected).toBe(false);
    expect(node2.isConnected).toBe(true);
    expect(codeNodes()).toHaveLength(1);
  });

  it("a non-follow root change evicts the frame; it re-mounts fresh at the new root", () => {
    // The lookup keys on the window's CURRENT root: a root change resolves a
    // DIFFERENT src, so a re-created frame that reused the stale source fails
    // the workspaceSrc assertion below.
    let currentRoot = "/repo";
    const codeSrcForByRoot = (id: string) => srcFor(`${id}:${currentRoot}`);
    const { rerender } = renderLayout({
      layout: CODE_LAYOUT,
      codeSrcFor: codeSrcForByRoot,
      codeRootForWindow: () => currentRoot,
    });
    const node1 = visibleCodeNode();

    // `rk tab code set /other` moved the shared root — no follow nonce, so
    // the divergence evicts; the record re-creates at the CURRENT src and the
    // frame remounts (the editor was pointing at the wrong folder).
    codeSpy.mockClear();
    currentRoot = "/other";
    rerender(layoutElement({
      layout: CODE_LAYOUT,
      window: { gitRoot: "/other", codeRoot: "/other" },
      codeSrcFor: codeSrcForByRoot,
      codeRootForWindow: () => currentRoot,
    }));
    expect(node1.isConnected).toBe(false);
    // The eviction/re-creation takes several render passes on one rerender
    // (drop → pending → re-create); the LAST pass's frame is the fresh mount
    // at the new root.
    const remounted = mountedCodeProps().at(-1)!;
    expect(remounted.gitRoot).toBe("/other");
    expect(remounted.workspaceSrc).toBe(srcFor("@1:/other"));
    expect(visibleCodeNode()).toBeTruthy();
  });

  it("a follow is never evicted by its own latch write — the payload tick can outrun the nonce", () => {
    const { rerender } = renderLayout({
      layout: CODE_LAYOUT,
      codeSrcFor: codeSrcForAll,
      codeRootForWindow: () => "/repo",
    });
    const node1 = visibleCodeNode();

    // The editor navigated itself (File > Open Folder): the frame's load seam
    // reports the folder, and the pending-follow target is recorded
    // synchronously with the report — before the parent's latch POST.
    const report = codeSpy.mock.calls.at(-1)?.[0]?.onFolderNavigated;
    expect(typeof report).toBe("function");
    act(() => report("/other"));

    // The payload's codeRoot tick lands BEFORE the follow nonce (the latch
    // POST's option write wakes the SSE hub ahead of the POST response + the
    // re-derivation GET): the divergence reads as the follow's own write, the
    // baseline moves in place, and the live frame is NOT evicted.
    codeSpy.mockClear();
    rerender(layoutElement({
      layout: CODE_LAYOUT,
      codeSrcFor: codeSrcForAll,
      codeRootForWindow: () => "/other",
    }));
    expect(visibleCodeNode()).toBe(node1);
    expect(mountedCodeProps().at(-1)?.gitRoot).toBe("/other");

    // The nonce lands last (both orderings are safe): still the same frame,
    // and the follow override reached it.
    rerender(layoutElement({
      layout: CODE_LAYOUT,
      codeSrcFor: codeSrcForAll,
      codeRootForWindow: () => "/other",
      codeFollowSrc: { src: srcFor("@1"), nonce: 1, root: "/other", windowId: "@1" },
    }));
    expect(visibleCodeNode()).toBe(node1);
    expect(codeSpy.mock.calls.at(-1)?.[0]?.followSrc).toEqual({
      src: srcFor("@1"),
      nonce: 1,
      root: "/other",
      windowId: "@1",
    });
  });

  it("a nonce-first follow keeps its pending target until the payload observes it — an interim tick never evicts", () => {
    let current = "/repo";
    const { rerender } = renderLayout({
      layout: CODE_LAYOUT,
      codeSrcFor: codeSrcForAll,
      codeRootForWindow: () => current,
    });
    const node1 = visibleCodeNode();
    const report = codeSpy.mock.calls.at(-1)?.[0]?.onFolderNavigated;
    expect(typeof report).toBe("function");
    act(() => report("/other"));

    // The re-derivation GET lands BEFORE the payload tick: the nonce moves
    // the baseline to /other while the live root still reads /repo.
    rerender(layoutElement({
      layout: CODE_LAYOUT,
      codeSrcFor: codeSrcForAll,
      codeRootForWindow: () => current,
      codeFollowSrc: { src: srcFor("@1"), nonce: 1, root: "/other", windowId: "@1" },
    }));
    expect(visibleCodeNode()).toBe(node1);

    // An unrelated session update re-runs reconciliation with the root still
    // unmoved: the kept target (== the moved baseline) marks the follow
    // in-flight — no eviction.
    rerender(layoutElement({
      layout: CODE_LAYOUT,
      codeSrcFor: codeSrcForAll,
      codeRootForWindow: () => current,
      codeFollowSrc: { src: srcFor("@1"), nonce: 1, root: "/other", windowId: "@1" },
    }));
    expect(visibleCodeNode()).toBe(node1);

    // The payload tick observes the follow: the target consumes, the frame
    // stays the same node.
    current = "/other";
    rerender(layoutElement({
      layout: CODE_LAYOUT,
      codeSrcFor: codeSrcForAll,
      codeRootForWindow: () => current,
      codeFollowSrc: { src: srcFor("@1"), nonce: 1, root: "/other", windowId: "@1" },
    }));
    expect(visibleCodeNode()).toBe(node1);
  });

  it("overlapping follows keep per-window pending targets — a switch mid-follow loses neither", () => {
    const rootOf: Record<string, string> = { "@1": "/repo", "@2": "/repo" };
    const { rerender } = renderLayout({
      layout: CODE_LAYOUT,
      codeSrcFor: codeSrcForAll,
      codeRootForWindow: (id) => rootOf[id] ?? "",
    });
    const node1 = visibleCodeNode();
    const report1 = codeSpy.mock.calls.at(-1)?.[0]?.onFolderNavigated;
    expect(typeof report1).toBe("function");
    act(() => report1("/other-a"));

    // Switch to @2 before @1's payload tick; @2 follows as well. A single
    // shared target slot would lose @1's target here.
    rerender(layoutElement({
      layout: CODE_LAYOUT,
      windowId: "@2",
      codeSrcFor: codeSrcForAll,
      codeRootForWindow: (id) => rootOf[id] ?? "",
    }));
    const report2 = codeSpy.mock.calls
      .filter(([props]) => typeof (props as Record<string, unknown>).onFolderNavigated === "function")
      .at(-1)?.[0]?.onFolderNavigated;
    expect(typeof report2).toBe("function");
    act(() => report2("/other-b"));

    // @1's latch write lands while @2 is active: @1's divergence TOWARD its
    // own target is its follow — the baseline moves, the frame is kept.
    rootOf["@1"] = "/other-a";
    rerender(layoutElement({
      layout: CODE_LAYOUT,
      windowId: "@2",
      codeSrcFor: codeSrcForAll,
      codeRootForWindow: (id) => rootOf[id] ?? "",
    }));
    expect(node1.isConnected).toBe(true);
    expect(codeNodes()).toHaveLength(2);
  });

  it("a rejected latch POST clears the pending target — a later same-folder update evicts as a divergence", async () => {
    const onCodeFolderNavigated = vi.fn(() => Promise.reject(new Error("latch failed")));
    const { rerender } = renderLayout({
      layout: CODE_LAYOUT,
      codeSrcFor: codeSrcForAll,
      codeRootForWindow: () => "/repo",
      onCodeFolderNavigated,
    });
    const node1 = visibleCodeNode();

    // The editor navigated itself; the parent's latch POST REJECTS. The
    // pending target recorded at report time clears once the rejection lands.
    const report = codeSpy.mock.calls.at(-1)?.[0]?.onFolderNavigated;
    expect(typeof report).toBe("function");
    await act(async () => report("/other"));
    expect(onCodeFolderNavigated).toHaveBeenCalledWith("/other");

    // An external update to the same folder arrives later: with the target
    // cleared it reads as a non-follow divergence and evicts (the frame
    // points at a folder the shared root never adopted).
    rerender(layoutElement({
      layout: CODE_LAYOUT,
      codeSrcFor: codeSrcForAll,
      codeRootForWindow: () => "/other",
      onCodeFolderNavigated,
    }));
    expect(node1.isConnected).toBe(false);
  });

  it("returning to a window whose code tile is closed keeps its frame mounted-hidden", () => {
    const { rerender } = renderLayout({ layout: CODE_LAYOUT, codeSrcFor: codeSrcForAll });
    const node1 = visibleCodeNode();
    // Close @1's tile, switch away and back: the per-window reset reseeds
    // everOpened from @1's layout (no `code`), but the record must still
    // render as a hidden tile — the close-tile rule keeps it retained.
    rerender(layoutElement({ layout: layoutOf("tty"), codeSrcFor: codeSrcForAll }));
    expect(node1.isConnected).toBe(true);
    rerender(layoutElement({ layout: CODE_LAYOUT, windowId: "@2", codeSrcFor: codeSrcForAll }));
    expect(codeNodes()).toHaveLength(2);
    rerender(layoutElement({ layout: layoutOf("tty"), codeSrcFor: codeSrcForAll }));
    expect(node1.isConnected).toBe(true);
    expect(codeNodes()).toHaveLength(2);
  });

  it("a runtime cap decrease evicts the oldest NON-ACTIVE records — the active window's closed-tile frame is protected", () => {
    const { rerender } = renderLayout({ layout: CODE_LAYOUT, codeSrcFor: codeSrcForAll });
    const node1 = visibleCodeNode();
    // Close @1's tile, then fill the desktop cap from other windows.
    rerender(layoutElement({ layout: layoutOf("tty"), codeSrcFor: codeSrcForAll }));
    expect(node1.isConnected).toBe(true);
    rerender(layoutElement({ layout: CODE_LAYOUT, windowId: "@2", codeSrcFor: codeSrcForAll }));
    rerender(layoutElement({ layout: CODE_LAYOUT, windowId: "@3", codeSrcFor: codeSrcForAll }));
    expect(codeNodes()).toHaveLength(3);

    // Back on @1 (tile still closed) the isMobile flip drops the cap to 1:
    // @2 and @3 evict; @1's record survives — a head-slice would evict the
    // ACTIVE window's record (the show effect can't bump it to the tail
    // while its tile is closed) and leave @3's. The flip remounts the grid's
    // nodes (the branch switch does that to every tile, tty included), so
    // survival is asserted at RECORD level: the one mounted frame reads @1's
    // creation src, through the active window's hidden-tile slot.
    codeSpy.mockClear();
    rerender(layoutElement({
      layout: layoutOf("tty"),
      isMobile: true,
      mobileActiveSlot: 0,
      codeSrcFor: codeSrcForAll,
    }));
    expect(codeNodes()).toHaveLength(1);
    expect(mountedCodeProps().at(-1)?.workspaceSrc).toBe(srcFor("@1"));
    expect(screen.getByTestId("surface-tile-code")).toBeTruthy();
  });

  it("closing the code tile keeps its frame retained and counting toward the cap", () => {
    const { rerender } = renderLayout({ layout: CODE_LAYOUT, codeSrcFor: codeSrcForAll });
    const node1 = visibleCodeNode();
    // Close the tile (the parent collapses the layout): the frame stays
    // mounted-hidden, the identical node.
    rerender(layoutElement({ layout: layoutOf("tty"), codeSrcFor: codeSrcForAll }));
    expect(node1.isConnected).toBe(true);
    expect(codeNodes()).toHaveLength(1);

    // It still counts toward the cap: @2 and @3 fill it, @4 overflows @1 out.
    for (const id of ["@2", "@3"]) {
      rerender(layoutElement({ layout: CODE_LAYOUT, windowId: id, codeSrcFor: codeSrcForAll }));
    }
    expect(codeNodes()).toHaveLength(3);
    expect(node1.isConnected).toBe(true);
    rerender(layoutElement({ layout: CODE_LAYOUT, windowId: "@4", codeSrcFor: codeSrcForAll }));
    expect(codeNodes()).toHaveLength(3);
    expect(node1.isConnected).toBe(false);
  });

  it("a window whose src is still pending creates no frame and does not count toward the cap", () => {
    // @2 never resolves (its GET is in flight): no record, no cap slot.
    const sparse = (id: string) => (id === "@2" ? null : srcFor(id));
    const { rerender } = renderLayout({ layout: CODE_LAYOUT, codeSrcFor: sparse });
    const node1 = visibleCodeNode();
    codeSpy.mockClear();
    rerender(layoutElement({ layout: CODE_LAYOUT, windowId: "@2", codeSrcFor: sparse }));
    // The active tile pends (workspace src null) and mounts no frame — the
    // mounted set is @1's retained frame plus @2's pending placeholder (a
    // window switch renders in more than one pass, so assert the SET).
    const pendingSrcs = new Set(mountedCodeProps().map((p) => p.workspaceSrc));
    expect(pendingSrcs).toEqual(new Set([srcFor("@1"), null]));
    rerender(layoutElement({ layout: CODE_LAYOUT, windowId: "@3", codeSrcFor: sparse }));
    rerender(layoutElement({ layout: CODE_LAYOUT, windowId: "@4", codeSrcFor: sparse }));
    // Three real frames (@1, @3, @4) — @2's pending tile never counted, so @1
    // was never evicted.
    expect(codeNodes()).toHaveLength(3);
    expect(node1.isConnected).toBe(true);
  });

  it("a retained frame keeps its own window's seams (per-frame bridge fetcher; no active-window focus closures)", () => {
    const fetchers: Record<string, () => Promise<CodeBridgeResult>> = {
      "@1": vi.fn(),
      "@2": vi.fn(),
    };
    const factorySpy = vi.fn((id: string) => fetchers[id]);
    const { rerender } = renderLayout({
      layout: CODE_LAYOUT,
      codeSrcFor: codeSrcForAll,
      fetchBridgeStatusFor: factorySpy,
    });
    codeSpy.mockClear();
    rerender(layoutElement({
      layout: CODE_LAYOUT,
      windowId: "@2",
      codeSrcFor: codeSrcForAll,
      fetchBridgeStatusFor: factorySpy,
    }));
    expect(factorySpy).toHaveBeenCalledWith("@1");
    expect(factorySpy).toHaveBeenCalledWith("@2");
    const bySrc = new Map(mountedCodeProps().map((p) => [p.workspaceSrc, p]));
    // The retained frame (@1): its rescue verdict reads ITS OWN window's
    // bridge status, and its focus/follow seams are unbound — a hidden frame
    // can neither receive focus nor navigate, so nothing may ever record
    // against the ACTIVE window's focus-memory key from it.
    const retained = bySrc.get(srcFor("@1"))!;
    expect(retained.fetchBridgeStatus).toBe(fetchers["@1"]);
    expect(retained.followSrc).toBeNull();
    expect(retained.onInteract).toBeUndefined();
    expect(retained.onProgrammaticFocus).toBeUndefined();
    expect(retained.onFolderNavigated).toBeUndefined();
    // The active frame keeps the ordinary wiring.
    const active = bySrc.get(srcFor("@2"))!;
    expect(active.fetchBridgeStatus).toBe(fetchers["@2"]);
    expect(typeof active.onInteract).toBe("function");
  });
});

describe("SurfaceLayout focused tile (260812-wfic R2)", () => {
  it("defaults to slot A: accent border + glyph there, and the callback reports its kind", () => {
    const onFocusedKindChange = vi.fn();
    renderLayout({
      layout: layoutOf("h(tty,code)"),
      onFocusedKindChange,
    });
    expect(screen.getByTestId("surface-tile-tty").className).toContain("border-accent-green");
    expect(screen.getByTestId("surface-tile-code").className).toContain("rk-card-border");
    expect(screen.getByTestId("surface-tile-code").className).not.toContain(
      "border-accent-green",
    );
    expect(onFocusedKindChange).toHaveBeenLastCalledWith("tty");
  });

  it("pointerdown in a tile moves the accent border and reports the kind", () => {
    const onFocusedKindChange = vi.fn();
    renderLayout({
      layout: layoutOf("h(tty,code)"),
      onFocusedKindChange,
    });
    fireEvent.pointerDown(screen.getByTestId("surface-tile-code"));
    expect(screen.getByTestId("surface-tile-code").className).toContain("border-accent-green");
    expect(screen.getByTestId("surface-tile-tty").className).not.toContain(
      "border-accent-green",
    );
    expect(onFocusedKindChange).toHaveBeenLastCalledWith("code");
  });

  it("focusin on a tile (e.g. the code iframe gaining focus) moves the focus", () => {
    renderLayout({ layout: layoutOf("h(tty,code)") });
    fireEvent.focusIn(screen.getByTestId("surface-tile-code"));
    expect(screen.getByTestId("surface-tile-code").className).toContain("border-accent-green");
  });

  it("the code tile's onInteract seam (editor keydown/pointerdown) moves the focus", () => {
    renderLayout({ layout: layoutOf("h(tty,code)") });
    const onInteract = codeSpy.mock.calls.at(-1)?.[0]?.onInteract;
    expect(typeof onInteract).toBe("function");
    act(() => onInteract());
    expect(screen.getByTestId("surface-tile-code").className).toContain("border-accent-green");
  });

  it("the web tile's onInteract seam (in-iframe click/keydown) moves the focus", () => {
    const onFocusedKindChange = vi.fn();
    renderLayout({
      layout: layoutOf("h(tty,web)"),
      onFocusedKindChange,
    });
    const onInteract = iframeSpy.mock.calls.at(-1)?.[0]?.onInteract;
    expect(typeof onInteract).toBe("function");
    act(() => onInteract());
    expect(screen.getByTestId("surface-tile-web").className).toContain("border-accent-green");
    expect(onFocusedKindChange).toHaveBeenLastCalledWith("web");
  });

  it("closing the focused tile falls back to slot A (no stale highlight)", () => {
    const { rerender } = renderLayout({
      layout: layoutOf("h(tty,v(code,web))"),
    });
    fireEvent.pointerDown(screen.getByTestId("surface-tile-web"));
    expect(screen.getByTestId("surface-tile-web").className).toContain("border-accent-green");
    // The parent applies the close: web leaves, the layout collapses 3→2.
    rerender(layoutElement({ layout: layoutOf("h(tty,code)") }));
    expect(screen.getByTestId("surface-tile-tty").className).toContain("border-accent-green");
    expect(screen.getByTestId("surface-tile-code").className).not.toContain(
      "border-accent-green",
    );
  });

  it("arity 1 suppresses the highlight but still reports the kind (single:tty reads tty-focused)", () => {
    const onFocusedKindChange = vi.fn();
    renderLayout({ layout: layoutOf("tty"), onFocusedKindChange });
    expect(screen.getByTestId("surface-tile-tty").className).not.toContain(
      "border-accent-green",
    );
    expect(onFocusedKindChange).toHaveBeenLastCalledWith("tty");
  });

  it("the focusTileRef seam focuses the first slot of a kind (the palette's path)", () => {
    const focusTileRef: { current: ((kind: SurfaceKind) => void) | null } = { current: null };
    const onFocusedKindChange = vi.fn();
    renderLayout({
      layout: layoutOf("h(tty,code)"),
      focusTileRef,
      onFocusedKindChange,
    });
    expect(focusTileRef.current).not.toBeNull();
    act(() => focusTileRef.current?.("code"));
    expect(screen.getByTestId("surface-tile-code").className).toContain("border-accent-green");
    expect(onFocusedKindChange).toHaveBeenLastCalledWith("code");
    // A kind that is not open is a no-op.
    act(() => focusTileRef.current?.("web"));
    expect(screen.getByTestId("surface-tile-code").className).toContain("border-accent-green");
  });
});

describe("SurfaceLayout header chrome (260812-wfic R3)", () => {
  it("renders the kind glyph, a 35px header on the tile surface, and the meta as a card chip", () => {
    renderLayout({ layout: layoutOf("h(code,web)") });
    const codeTile = screen.getByTestId("surface-tile-code");
    const header = codeTile.firstElementChild!;
    expect(header.className).toContain("h-[35px]");
    expect(header.className).toContain("bg-bg-primary");
    expect(header.className).not.toContain("bg-bg-card");
    expect(header.className).toContain("text-[11px]");
    // The SURFACE_GLYPH kind glyph precedes the label.
    expect(header.textContent).toContain("{}");
    expect(header.textContent).toContain("Code");
    // The meta text is an inset chip, subordinate to the label.
    const chip = within(codeTile as HTMLElement).getByText("repo");
    expect(chip.className).toContain("bg-bg-card");
    expect(chip.className).toContain("rounded");
    expect(chip.className).toContain("px-1.5");
    expect(chip.className).toContain("text-[10px]");
    expect(chip.className).toContain("truncate");
  });
});

describe("SurfaceLayout tty header status dot (260812-wfic R6)", () => {
  it("renders the StatusDot in tty headers only, and only when statusWindow is set", () => {
    renderLayout({
      layout: layoutOf("h(tty,code)"),
      statusWindow: STATUS_WINDOW,
    });
    expect(
      within(screen.getByTestId("surface-tile-tty")).getByRole("img"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("surface-tile-code")).queryByRole("img"),
    ).toBeNull();
  });

  it("a null statusWindow renders no dot", () => {
    renderLayout({
      layout: layoutOf("h(tty,code)"),
      statusWindow: null,
    });
    expect(
      within(screen.getByTestId("surface-tile-tty")).queryByRole("img"),
    ).toBeNull();
  });
});

describe("SurfaceLayout close/reopen identity (P3)", () => {
  it("a closed tile hides WITHOUT unmounting and reopens as the SAME element", () => {
    // Regression guard for the two-array render pitfall: visible + hidden
    // tiles must come from ONE flat keyed array — split `{arr1}{arr2}`
    // expression slots reconcile positionally and would remount a tile that
    // moves between them, discarding iframe/terminal state (caught by the
    // right-panel e2e element-identity assertion).
    const { rerender } = renderLayout({
      layout: layoutOf("h(tty,web)"),
    });
    const before = screen.getByTestId("mock-iframe");
    // Close the web tile (the parent re-renders with the collapsed layout).
    rerender(layoutElement({ layout: layoutOf("tty") }));
    expect(screen.getByTestId("surface-tile-web").classList.contains("hidden")).toBe(true);
    expect(screen.getByTestId("mock-iframe")).toBe(before);
    // Reopen — still the identical element.
    rerender(layoutElement({ layout: layoutOf("h(tty,web)") }));
    expect(screen.getByTestId("surface-tile-web").classList.contains("hidden")).toBe(false);
    expect(screen.getByTestId("mock-iframe")).toBe(before);
  });

  it("a RESTRUCTURE (add/close) keeps a surviving tile's DOM node — no re-parent, no reload (A-020)", () => {
    // The flat-render contract's whole point: a nested split DOM would
    // re-parent the web iframe when the tree restructures around it, reloading
    // its content. Keyed by leaf id in ONE flat list, the node survives.
    const { rerender } = renderLayout({ layout: layoutOf("h(tty,web)") });
    const webNode = screen.getByTestId("mock-iframe");
    const ttyNode = screen.getByTestId("mock-terminal");

    // Add code: h(tty,web) → h(tty,v(web,code)) — the web leaf moves from a
    // root child to a nested child, but its tile must be the SAME DOM node.
    rerender(layoutElement({ layout: layoutOf("h(tty,v(web,code))") }));
    expect(screen.getByTestId("mock-code")).toBeTruthy();
    expect(screen.getByTestId("mock-iframe")).toBe(webNode);
    expect(screen.getByTestId("mock-terminal")).toBe(ttyNode);

    // Close code again: the structure reverts; still the same nodes (the
    // closed code tile stays mounted-hidden — hide-never-unmount).
    rerender(layoutElement({ layout: layoutOf("h(tty,web)") }));
    expect(screen.getByTestId("surface-tile-code").classList.contains("hidden")).toBe(true);
    expect(screen.getByTestId("mock-iframe")).toBe(webNode);
    expect(screen.getByTestId("mock-terminal")).toBe(ttyNode);
  });
});

describe("SurfaceLayout degradation + availability guards", () => {
  it("a tile whose capability vanished renders an empty body, never a broken iframe", () => {
    // The ladder's degradation should have dropped `code` already; the
    // component is the second line of defense.
    renderLayout({
      layout: layoutOf("h(tty,code)"),
      window: { webTabs: ["http://localhost:8080"], webActive: 1 }, // no gitRoot
    });
    expect(screen.getByTestId("surface-tile-code")).toBeTruthy();
    expect(screen.queryByTestId("mock-code")).toBeNull();
  });
});

describe("SurfaceLayout duplicate tty tiles", () => {
  it("mounts two TerminalClients; only the first owns the shared refs/focus", () => {
    const wsRef: { current: WebSocket | null } = { current: null };
    const focusRef: { current: (() => void) | null } = { current: null };
    render(
      <ToastProvider>
      <SurfaceLayout
        layout={layoutOf("h(tty,tty)")}
        server="srv"
        windowId="@1"
        sessionName="sess"
        window={FULL_WINDOW}
        isMobile={false}
        wsRef={wsRef}
        focusRef={focusRef}
        scrollLocked={false}
        onSessionNotFound={vi.fn()}
        codeReachable
        onClose={vi.fn()}
        onApplyLayout={vi.fn()}
      />,
      </ToastProvider>,
    );
    expect(screen.getByTestId("surface-tile-tty")).toBeTruthy();
    expect(screen.getByTestId("surface-tile-tty-2")).toBeTruthy();
    // Two mounted terminals (the spy fires per RENDER — count DOM mounts and
    // assert against the final render's two calls, in tile order).
    expect(screen.getAllByTestId("mock-terminal")).toHaveLength(2);
    const [primary, duplicate] = terminalSpy.mock.calls.slice(-2).map(([props]) => props);
    expect(primary.wsRef).toBe(wsRef);
    expect(primary.focusRef).toBe(focusRef);
    expect(primary.registerFocus).toBe(true);
    // The export seams follow the same primary-only rule (260819-shqo).
    expect(primary.serializeAddonRef).toBeDefined();
    expect(primary.terminalRef).toBeDefined();
    // The duplicate gets a dummy ws bucket, no focusRef, and must not fight
    // over the shell's focused-terminal slot.
    expect(duplicate.wsRef).not.toBe(wsRef);
    expect(duplicate.focusRef).toBeUndefined();
    expect(duplicate.registerFocus).toBe(false);
    expect(duplicate.serializeAddonRef).toBeUndefined();
    expect(duplicate.terminalRef).toBeUndefined();
  });
});

describe("SurfaceLayout tty dock slot (260813-j3jb)", () => {
  const dock = <div data-testid="tty-dock">dock</div>;

  it("renders ttyDockContent inside the tty tile, after the terminal body", () => {
    renderLayout({
      layout: layoutOf("h(tty,web)"),
      ttyDockContent: dock,
    });
    const tile = screen.getByTestId("surface-tile-tty");
    const mounted = within(tile).getByTestId("tty-dock");
    // Inside the tile frame — and the LAST child of the tile's flex column
    // (below the terminal body, above the tile's bottom edge).
    expect(mounted.parentElement).toBe(
      screen.getByTestId("mock-terminal").parentElement!.parentElement,
    );
    expect(mounted.parentElement!.lastElementChild).toBe(mounted);
    // The other tile hosts nothing.
    expect(
      within(screen.getByTestId("surface-tile-web")).queryByTestId("tty-dock"),
    ).toBeNull();
  });

  it("duplicate tty tiles: only the FIRST hosts the dock", () => {
    renderLayout({
      layout: layoutOf("h(tty,tty)"),
      ttyDockContent: dock,
    });
    expect(
      within(screen.getByTestId("surface-tile-tty")).getByTestId("tty-dock"),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("surface-tile-tty-2")).queryByTestId("tty-dock"),
    ).toBeNull();
  });

  it("renders nothing extra when ttyDockContent is absent", () => {
    renderLayout({ layout: layoutOf("h(tty,web)") });
    expect(screen.queryByTestId("tty-dock")).toBeNull();
  });

  it("mobile never renders the dock (tile chrome is off there)", () => {
    renderLayout({
      layout: layoutOf("h(tty,web)"),
      isMobile: true,
      ttyDockContent: dock,
    });
    expect(screen.queryByTestId("tty-dock")).toBeNull();
  });
});

describe("SurfaceLayout hide-never-unmount (P3)", () => {
  it("a closed tile stays mounted at display level for the route's lifetime", () => {
    const { rerender } = render(
      <ToastProvider>
      <SurfaceLayout
        layout={layoutOf("h(tty,web)")}
        server="srv"
        windowId="@1"
        sessionName="sess"
        window={FULL_WINDOW}
        isMobile={false}
        wsRef={{ current: null }}
        focusRef={{ current: null }}
        scrollLocked={false}
        onSessionNotFound={vi.fn()}
        codeReachable
        onClose={vi.fn()}
        onApplyLayout={vi.fn()}
      />,
      </ToastProvider>,
    );
    expect(screen.getByTestId("mock-iframe")).toBeTruthy();

    rerender(
      <ToastProvider>
      <SurfaceLayout
        layout={layoutOf("tty")}
        server="srv"
        windowId="@1"
        sessionName="sess"
        window={FULL_WINDOW}
        isMobile={false}
        wsRef={{ current: null }}
        focusRef={{ current: null }}
        scrollLocked={false}
        onSessionNotFound={vi.fn()}
        codeReachable
        onClose={vi.fn()}
        onApplyLayout={vi.fn()}
      />,
      </ToastProvider>,
    );
    const webTile = screen.getByTestId("surface-tile-web");
    expect(webTile.classList.contains("hidden")).toBe(true);
    // The iframe is STILL MOUNTED — its in-memory state survives the close.
    expect(screen.getByTestId("mock-iframe")).toBeTruthy();
  });
});

describe("SurfaceLayout dividers (R15: signature-keyed sizes, release-only writes)", () => {
  it("persists sizes per (window, structure signature) on drag RELEASE only", () => {
    const onRatioCommit = vi.fn();
    renderLayout({
      layout: layoutOf("h(tty,code)"),
      onRatioCommit,
    });
    const divider = screen.getByTestId("surface-divider-0");
    const key = sizesStorageKey("srv", "@1", "h(0,1)");
    // jsdom's getBoundingClientRect is all zeros, so the move no-ops on the
    // unmeasured container; the release still commits the resolved (equal)
    // fractions — one fraction array per split, pre-order.
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 300 });
    expect(localStorage.getItem(key)).toBeNull();
    expect(onRatioCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(divider, { pointerId: 1 });
    expect(onRatioCommit).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual([[0.5, 0.5]]);
  });

  it("restores persisted sizes for the (window, signature) — the first sibling's % of the pair", () => {
    localStorage.setItem(sizesStorageKey("srv", "@1", "h(0,1)"), JSON.stringify([[0.7, 0.3]]));
    renderLayout({ layout: layoutOf("h(tty,code)") });
    expect(
      screen.getByTestId("surface-divider-0").getAttribute("aria-valuenow"),
    ).toBe("70");
  });

  it("sizes key on STRUCTURE, not on which leaf sits where — a swap keeps them", () => {
    // h(tty,code) and h(code,tty) share the signature h(0,1): the positions
    // keep their sizes across a shared swap (R13).
    localStorage.setItem(sizesStorageKey("srv", "@1", "h(0,1)"), JSON.stringify([[0.7, 0.3]]));
    const { rerender } = renderLayout({ layout: layoutOf("h(tty,code)") });
    expect(screen.getByTestId("surface-divider-0").getAttribute("aria-valuenow")).toBe("70");
    rerender(layoutElement({ layout: layoutOf("h(code,tty)") }));
    expect(screen.getByTestId("surface-divider-0").getAttribute("aria-valuenow")).toBe("70");
  });
});

describe("SurfaceLayout divider drag (R15: only the two siblings' fractions move)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a divider drag changes only its two siblings' fractions and persists under the sig key on release", () => {
    measureGrid(1200, 1200);
    const onRatioCommit = vi.fn();
    renderLayout({ layout: layoutOf("h(tty,v(code,web))"), onRatioCommit });
    const key = sizesStorageKey("srv", "@1", "h(0,v(1,2))");
    // main-left template defaults: outer [0.58, 0.42], inner v [0.5, 0.5].
    expect(screen.getByTestId("surface-divider-0").getAttribute("aria-valuenow")).toBe("58");
    expect(screen.getByTestId("surface-divider-1").getAttribute("aria-valuenow")).toBe("50");

    const divider = screen.getByTestId("surface-divider-0");
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 695 });
    // The pair spans 1194px (1200 − the 6px gutter): x=480 → 40.2% for tty.
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 480 });
    expect(screen.getByTestId("surface-divider-0").getAttribute("aria-valuenow")).toBe("40");
    // The OTHER split's fractions are untouched (the pair's sum stays 1).
    expect(screen.getByTestId("surface-divider-1").getAttribute("aria-valuenow")).toBe("50");
    // Nothing persists mid-drag.
    expect(localStorage.getItem(key)).toBeNull();
    expect(onRatioCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(divider, { pointerId: 1 });
    expect(onRatioCommit).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(localStorage.getItem(key) ?? "null") as number[][];
    expect(stored).toHaveLength(2);
    expect(stored[0][0]).toBeCloseTo(480 / 1194, 4);
    expect(stored[0][1]).toBeCloseTo(1 - 480 / 1194, 4);
    expect(stored[1]).toEqual([0.5, 0.5]);

    // The 280px floor clamps both sides on the divider's own axis:
    // 280/1194 = 23.45%.
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 480 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 0 });
    expect(screen.getByTestId("surface-divider-0").getAttribute("aria-valuenow")).toBe("23");
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 1200 });
    expect(screen.getByTestId("surface-divider-0").getAttribute("aria-valuenow")).toBe("77");
    fireEvent.pointerUp(divider, { pointerId: 1 });
  });

  it("the layoutRectsRef seam reports the live leaf rects (the add/directional-swap geometry)", () => {
    measureGrid(1200, 1200);
    const layoutRectsRef: { current: (() => Map<string, Rect>) | null } = { current: null };
    renderLayout({ layout: layoutOf("h(tty,v(code,web))"), layoutRectsRef });
    expect(layoutRectsRef.current).not.toBeNull();
    const rects = layoutRectsRef.current!();
    // h(tty,v(code,web)) at 1200×1200, outer [0.58, 0.42]: tty spans the
    // left column full height; code/web stack in the right column.
    expect(rects.get("tty")).toEqual({ x: 0, y: 0, w: 692.52, h: 1200 });
    expect(rects.get("code")?.y).toBe(0);
    expect(rects.get("web")?.y).toBeCloseTo(597 + 6, 5);
    expect(rects.get("code")?.x).toBeCloseTo(698.52, 5);
  });
});

describe("SurfaceLayout gap-seam tile chrome (260814-011r R1/R5; inset cede 260814-ldbs R8)", () => {
  it("the desktop grid is a flat relative container — the 6px gutter lives inside the leaf rects, and the ground inset + ground stay ceded to the Shell stage", () => {
    renderLayout({ layout: layoutOf("h(tty,code)") });
    const grid = screen.getByTestId("surface-layout");
    // Flat rect-positioned leaves: the container is `relative`, and the gap
    // between sibling rects (SPLIT_GAP_PX) does the separating — no flex/grid
    // gap utility.
    expect(grid.className).toContain("relative");
    expect(grid.className.split(" ")).not.toContain("gap-[6px]");
    // 260814-ldbs: the stage owns the 6px ground inset + the bg-bg-inset
    // ground now — the tile grid carries NEITHER (no double inset). Token
    // match: `gap-[6px]` would false-positive a naive `p-[6px]` substring.
    expect(grid.className.split(" ")).not.toContain("p-[6px]");
    expect(grid.className).not.toContain("bg-bg-inset");
    expect(grid.className).not.toContain("gap-[3px]");
  });

  it("the flat container applies at EVERY arity, including a bare leaf (the stage supplies the inset)", () => {
    renderLayout({ layout: layoutOf("tty") });
    const grid = screen.getByTestId("surface-layout");
    expect(grid.className).toContain("relative");
    expect(grid.className.split(" ")).not.toContain("p-[6px]");
    expect(grid.className.split(" ")).not.toContain("gap-[6px]");
  });

  it("desktop tiles are 6px-radius cards with the dimmed rest border; the focused tile keeps full accent-green", () => {
    renderLayout({ layout: layoutOf("h(tty,code)") });
    const ttyTile = screen.getByTestId("surface-tile-tty"); // focused (slot A default)
    const codeTile = screen.getByTestId("surface-tile-code");
    for (const tile of [ttyTile, codeTile]) {
      expect(tile.className).toContain("rounded-md");
    }
    expect(ttyTile.className).toContain("border-accent-green");
    expect(ttyTile.className).not.toContain("rk-card-border");
    expect(codeTile.className).toContain("rk-card-border");
    expect(codeTile.className).not.toContain("border-accent-green");
  });

  it("the mobile branch stays chrome-free (R5): flex-1 only, no gutter/inset/radius/border", () => {
    renderLayout({
      layout: layoutOf("h(tty,code)"),
      isMobile: true,
    });
    const grid = screen.getByTestId("surface-layout");
    expect(grid.className).not.toContain("gap-[6px]");
    expect(grid.className).not.toContain("p-[6px]");
    const ttyTile = screen.getByTestId("surface-tile-tty");
    expect(ttyTile.className).toContain("flex-1");
    expect(ttyTile.className).not.toContain("rounded-md");
    expect(ttyTile.className).not.toContain("rk-card-border");
  });
});

describe("SurfaceLayout divider sash + grips (260814-011r R2)", () => {
  it("each divider carries the axis-aware sash pill and 3 pointer-events-none grip dots on a 14px hit zone", () => {
    renderLayout({ layout: layoutOf("h(tty,code)") });
    const divider = screen.getByTestId("surface-divider-0");
    expect(divider.className).toContain("rk-divider");
    expect(divider.className).toContain("w-3.5"); // 14px hit zone (was w-1.5)
    expect(divider.className).toContain("cursor-col-resize");
    const sash = divider.querySelector(".rk-sash")!;
    expect(sash.className).toContain("rk-sash-v"); // x-axis divider → vertical pill
    expect(sash.className).toContain("pointer-events-none");
    const grips = divider.querySelector(".rk-grips")!;
    expect(grips.className).toContain("rk-grips-v");
    expect(grips.className).toContain("pointer-events-none");
    expect(grips.querySelectorAll("i")).toHaveLength(3);
    // Nothing is lit at rest — dots only, no sash.
    expect(divider.className).not.toContain("rk-sash-lit");
  });

  it("a y-axis divider orients the pill and dots horizontally", () => {
    renderLayout({ layout: layoutOf("v(tty,web)") });
    const divider = screen.getByTestId("surface-divider-0");
    expect(divider.className).toContain("h-3.5");
    expect(divider.className).toContain("cursor-row-resize");
    expect(divider.querySelector(".rk-sash")!.className).toContain("rk-sash-h");
    expect(divider.querySelector(".rk-grips")!.className).toContain("rk-grips-h");
  });

  it("dragging lights the sash immediately (rk-sash-lit, zero delay); release unlights", () => {
    renderLayout({ layout: layoutOf("h(tty,code)") });
    const divider = screen.getByTestId("surface-divider-0");
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500 });
    expect(divider.className).toContain("rk-sash-lit");
    fireEvent.pointerUp(divider, { pointerId: 1 });
    expect(divider.className).not.toContain("rk-sash-lit");
  });
});

describe("SurfaceLayout intersection zone (260814-011r R3, generalised to every divider junction)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The 20px zone: jsdom needs it measured for the release-point hit test. */
  function mockZoneRect(zone: HTMLElement, left: number, top: number) {
    vi.spyOn(zone, "getBoundingClientRect").mockReturnValue({
      left,
      top,
      width: 20,
      height: 20,
      right: left + 20,
      bottom: top + 20,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect);
  }

  it("renders wherever a divider's end meets a perpendicular divider (the nested-split trees, never the flat ones)", () => {
    // The four nested 3-leaf structures (the main-* templates) each have one
    // junction; the flat trees (single leaf, 2-leaf splits, row, col) have
    // none.
    for (const raw of [
      "h(tty,v(code,web))",
      "h(v(code,web),tty)",
      "v(tty,h(code,web))",
      "v(h(code,web),tty)",
    ]) {
      cleanup();
      renderLayout({ layout: layoutOf(raw) });
      expect(screen.getByTestId("surface-divider-intersection")).toBeTruthy();
    }
    for (const raw of ["tty", "h(tty,code)", "v(tty,code)", "h(tty,code,web)", "v(tty,code,web)"]) {
      cleanup();
      renderLayout({ layout: layoutOf(raw) });
      expect(screen.queryByTestId("surface-divider-intersection")).toBeNull();
    }
  });

  it("never renders while zoomed or on mobile", () => {
    renderLayout({ layout: layoutOf("h(tty,v(code,web))") });
    fireEvent.click(screen.getByRole("button", { name: "Expand Terminal" }));
    expect(screen.queryByTestId("surface-divider-intersection")).toBeNull();
    cleanup();
    renderLayout({
      layout: layoutOf("h(tty,v(code,web))"),
      isMobile: true,
    });
    expect(screen.queryByTestId("surface-divider-intersection")).toBeNull();
  });

  it("sits centered on the junction of the two dividers, z-ordered above them, with cursor: move", () => {
    // Unmeasured (jsdom): the junction renders at its NOMINAL_BOX proportion.
    // main-left template defaults [0.58, 0.42] × [0.5, 0.5] over 1600×1000
    // with the 6px gutter: the vertical sash centers at 0.58×1594+3 = 927.52
    // (57.97%), the horizontal one at 0.5×994+3 = 500 (50%).
    renderLayout({ layout: layoutOf("h(tty,v(code,web))") });
    const zone = screen.getByTestId("surface-divider-intersection");
    expect(parseFloat(zone.style.left)).toBeCloseTo(57.97, 2);
    expect(parseFloat(zone.style.top)).toBeCloseTo(50, 5);
    expect(zone.className).toContain("z-20"); // above the z-10 dividers
    expect(zone.className).toContain("-translate-x-1/2");
    expect(zone.className).toContain("-translate-y-1/2");
    expect(zone.className).toContain("w-5"); // the ~20px hit zone
    expect(zone.className).toContain("h-5");
    expect(zone.className).toContain("cursor-move");
    expect(zone.style.touchAction).toBe("none");
  });

  it("hovering the zone lights BOTH sashes (150ms-delayed hot state); leaving unlights them", () => {
    renderLayout({ layout: layoutOf("h(tty,v(code,web))") });
    const zone = screen.getByTestId("surface-divider-intersection");
    // React synthesizes pointerenter/leave from native pointerover/out.
    fireEvent.pointerOver(zone);
    expect(screen.getByTestId("surface-divider-0").className).toContain("rk-sash-hot");
    expect(screen.getByTestId("surface-divider-1").className).toContain("rk-sash-hot");
    expect(screen.getByTestId("surface-divider-0").className).not.toContain("rk-sash-lit");
    fireEvent.pointerOut(zone, { relatedTarget: document.body });
    expect(screen.getByTestId("surface-divider-0").className).not.toContain("rk-sash-hot");
    expect(screen.getByTestId("surface-divider-1").className).not.toContain("rk-sash-hot");
  });

  it("a diagonal drag moves BOTH fraction pairs and persists both on RELEASE only (main-left: x → the h pair, y → the v pair)", () => {
    measureGrid(1200, 1200);
    const onRatioCommit = vi.fn();
    renderLayout({
      layout: layoutOf("h(tty,v(code,web))"),
      onRatioCommit,
    });
    const zone = screen.getByTestId("surface-divider-intersection");
    const key = sizesStorageKey("srv", "@1", "h(0,v(1,2))");
    fireEvent.pointerDown(zone, { pointerId: 1, clientX: 400, clientY: 800 });
    // Both sashes light the moment the drag starts (zero delay).
    expect(screen.getByTestId("surface-divider-0").className).toContain("rk-sash-lit");
    expect(screen.getByTestId("surface-divider-1").className).toContain("rk-sash-lit");
    // (480, 720) over the 1194px pairs (1200 − the 6px gutter) → 40.2% / 60.3%
    // (both inside their clamps).
    fireEvent.pointerMove(zone, { pointerId: 1, clientX: 480, clientY: 720 });
    expect(screen.getByTestId("surface-divider-0").getAttribute("aria-valuenow")).toBe("40");
    expect(screen.getByTestId("surface-divider-1").getAttribute("aria-valuenow")).toBe("60");
    // Mid-drag: nothing persisted, no commit callback.
    expect(localStorage.getItem(key)).toBeNull();
    expect(onRatioCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(zone, { pointerId: 1 });
    expect(onRatioCommit).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(localStorage.getItem(key) ?? "null") as number[][];
    expect(stored).toHaveLength(2);
    expect(stored[0][0]).toBeCloseTo(480 / 1194, 4);
    expect(stored[0][1]).toBeCloseTo(1 - 480 / 1194, 4);
    expect(stored[1][0]).toBeCloseTo(720 / 1194, 4);
    expect(stored[1][1]).toBeCloseTo(1 - 720 / 1194, 4);
  });

  it("clamps each axis independently at the 280px floor", () => {
    measureGrid(1200, 1200);
    renderLayout({ layout: layoutOf("h(tty,v(code,web))") });
    const zone = screen.getByTestId("surface-divider-intersection");
    fireEvent.pointerDown(zone, { pointerId: 1, clientX: 400, clientY: 800 });
    // Drag to the extremes: x → the 280/1194 = 23.45% floor, y → the 76.55%
    // ceiling.
    fireEvent.pointerMove(zone, { pointerId: 1, clientX: 0, clientY: 1200 });
    expect(screen.getByTestId("surface-divider-0").getAttribute("aria-valuenow")).toBe("23");
    expect(screen.getByTestId("surface-divider-1").getAttribute("aria-valuenow")).toBe("77");
    fireEvent.pointerUp(zone, { pointerId: 1 });
  });

  it("a drag released OFF the junction unlights both sashes (capture eats pointerleave)", () => {
    renderLayout({ layout: layoutOf("h(tty,v(code,web))") });
    const zone = screen.getByTestId("surface-divider-intersection");
    mockZoneRect(zone, 390, 790);
    fireEvent.pointerOver(zone);
    fireEvent.pointerDown(zone, { pointerId: 1, clientX: 400, clientY: 800 });
    // Drag past both clamps: the junction stops following, so the release
    // lands far from the zone with no leave event to clear the hot state.
    fireEvent.pointerMove(zone, { pointerId: 1, clientX: 0, clientY: 1200 });
    fireEvent.pointerUp(zone, { pointerId: 1, clientX: 0, clientY: 1200 });
    for (const id of ["surface-divider-0", "surface-divider-1"]) {
      expect(screen.getByTestId(id).className).not.toContain("rk-sash-hot");
      expect(screen.getByTestId(id).className).not.toContain("rk-sash-lit");
    }
  });

  it("a drag released ON the junction keeps both sashes hot", () => {
    renderLayout({ layout: layoutOf("h(tty,v(code,web))") });
    const zone = screen.getByTestId("surface-divider-intersection");
    mockZoneRect(zone, 390, 790);
    fireEvent.pointerOver(zone);
    fireEvent.pointerDown(zone, { pointerId: 1, clientX: 400, clientY: 800 });
    fireEvent.pointerUp(zone, { pointerId: 1, clientX: 400, clientY: 800 });
    for (const id of ["surface-divider-0", "surface-divider-1"]) {
      expect(screen.getByTestId(id).className).toContain("rk-sash-hot");
      expect(screen.getByTestId(id).className).not.toContain("rk-sash-lit");
    }
  });

  it("a mid-drag pointercancel releases cleanly without stranding drag state", () => {
    renderLayout({ layout: layoutOf("h(tty,v(code,web))") });
    const zone = screen.getByTestId("surface-divider-intersection");
    fireEvent.pointerDown(zone, { pointerId: 1, clientX: 400, clientY: 800 });
    fireEvent.pointerCancel(zone, { pointerId: 1 });
    // The cancel ran the end path: sashes unlit, and a stray move is a no-op
    // (aria-valuenow keeps the 58% template default — nothing moved).
    expect(screen.getByTestId("surface-divider-0").className).not.toContain("rk-sash-lit");
    fireEvent.pointerMove(zone, { pointerId: 1, clientX: 480, clientY: 720 });
    expect(screen.getByTestId("surface-divider-0").getAttribute("aria-valuenow")).toBe("58");
  });

  it("main-top maps the y axis to the outer v pair and the x axis to the inner h pair", () => {
    measureGrid(1200, 1200);
    renderLayout({ layout: layoutOf("v(tty,h(code,web))") });
    const zone = screen.getByTestId("surface-divider-intersection");
    fireEvent.pointerDown(zone, { pointerId: 1, clientX: 800, clientY: 400 });
    fireEvent.pointerMove(zone, { pointerId: 1, clientX: 720, clientY: 480 });
    // Over the 1194px pairs: y → 40.2% for the outer v pair's first sibling,
    // x → 60.3% for the inner h pair's first.
    expect(screen.getByTestId("surface-divider-0").getAttribute("aria-valuenow")).toBe("40");
    expect(screen.getByTestId("surface-divider-1").getAttribute("aria-valuenow")).toBe("60");
    fireEvent.pointerUp(zone, { pointerId: 1 });
    const stored = JSON.parse(
      localStorage.getItem(sizesStorageKey("srv", "@1", "v(0,h(1,2))")) ?? "null",
    ) as number[][];
    expect(stored[0][0]).toBeCloseTo(480 / 1194, 4);
    expect(stored[1][0]).toBeCloseTo(720 / 1194, 4);
  });
});

describe("SurfaceLayout mobile (R13 seam)", () => {
  it("renders only slot A full-width — no dividers, no verb chrome", () => {
    renderLayout({
      layout: layoutOf("h(tty,v(code,web))"),
      isMobile: true,
    });
    const ttyTile = screen.getByTestId("surface-tile-tty");
    expect(ttyTile.classList.contains("hidden")).toBe(false);
    // The remaining resolved surfaces stay mounted-hidden (reachable via the
    // top-bar switch group).
    expect(screen.getByTestId("surface-tile-code").classList.contains("hidden")).toBe(true);
    expect(screen.getByTestId("surface-tile-web").classList.contains("hidden")).toBe(true);
    expect(screen.queryByTestId("surface-divider-0")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close Code" })).toBeNull();
  });

  it("mobileActiveSlot swaps the shown surface WITHOUT touching the layout (T014)", () => {
    renderLayout({
      layout: layoutOf("h(tty,v(code,web))"),
      isMobile: true,
      mobileActiveSlot: 1,
    });
    // Slot 1 (code) shows; the rest stay mounted-hidden.
    expect(screen.getByTestId("surface-tile-code").classList.contains("hidden")).toBe(false);
    expect(screen.getByTestId("surface-tile-tty").classList.contains("hidden")).toBe(true);
    expect(screen.getByTestId("surface-tile-web").classList.contains("hidden")).toBe(true);
  });

  it("an out-of-range mobileActiveSlot falls back to slot A", () => {
    renderLayout({
      layout: layoutOf("h(tty,code)"),
      isMobile: true,
      mobileActiveSlot: 9,
    });
    expect(screen.getByTestId("surface-tile-tty").classList.contains("hidden")).toBe(false);
    expect(screen.getByTestId("surface-tile-code").classList.contains("hidden")).toBe(true);
  });
});

describe("SurfaceLayout zoom palette seam (T012/R11)", () => {
  it("registers a toggle for the FOCUSED slot (260819-qwr7 R7) and reports zoom flips via onZoomChange", () => {
    const zoomToggleRef: { current: (() => void) | null } = { current: null };
    const onZoomChange = vi.fn();
    renderLayout({
      layout: layoutOf("h(tty,code)"),
      zoomToggleRef,
      onZoomChange,
    });
    expect(zoomToggleRef.current).not.toBeNull();
    // Focus slot B (the code tile) via its pointerdown-capture seam, then
    // toggle: the FOCUSED slot zooms — tty (slot A) is the one that hides.
    fireEvent.pointerDown(screen.getByTestId("surface-tile-code"));
    act(() => zoomToggleRef.current!());
    expect(onZoomChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByTestId("surface-tile-tty").classList.contains("hidden")).toBe(true);
    expect(screen.getByTestId("surface-tile-code").classList.contains("hidden")).toBe(false);
    act(() => zoomToggleRef.current!());
    expect(onZoomChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByTestId("surface-tile-tty").classList.contains("hidden")).toBe(false);
  });

  it("zooms slot A when no interaction moved the focus (the default focused slot)", () => {
    const zoomToggleRef: { current: (() => void) | null } = { current: null };
    renderLayout({
      layout: layoutOf("h(tty,code)"),
      zoomToggleRef,
    });
    act(() => zoomToggleRef.current!());
    expect(screen.getByTestId("surface-tile-code").classList.contains("hidden")).toBe(true);
    act(() => zoomToggleRef.current!());
    expect(screen.getByTestId("surface-tile-code").classList.contains("hidden")).toBe(false);
  });
});

describe("SurfaceLayout tty progress (260819-1vxq)", () => {
  // Deterministic rAF: the consumer coalesces onProgressChange events to one
  // state commit per frame, so tests queue callbacks and flush explicitly
  // (the terminal-client.test.tsx pattern). Restored per-test — a blanket
  // unstubAllGlobals would also drop the module-level matchMedia stub.
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextRafId: number;
  const realRaf = window.requestAnimationFrame;
  const realCaf = window.cancelAnimationFrame;

  beforeEach(() => {
    rafCallbacks = new Map();
    nextRafId = 1;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number) => {
      rafCallbacks.delete(id);
    }) as typeof window.cancelAnimationFrame;
  });

  afterEach(() => {
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCaf;
  });

  /** Fire the captured onProgressChange (the scaffold seam) and flush the
   *  coalescing frame in one step. */
  function fireProgress(state: number, value: number) {
    const props = terminalSpy.mock.lastCall?.[0] as {
      onProgressChange?: (state: number, value: number) => void;
    };
    expect(props.onProgressChange).toBeTypeOf("function");
    act(() => {
      props.onProgressChange!(state, value);
      for (const cb of [...rafCallbacks.values()]) cb(0);
      rafCallbacks.clear();
    });
  }

  it("state 1 renders the green determinate line at value% and a percent chip", () => {
    renderLayout();
    expect(screen.queryByTestId("progress-line")).toBeNull();
    expect(screen.queryByTestId("progress-chip")).toBeNull();
    fireProgress(1, 42);
    const line = screen.getByTestId("progress-line");
    expect(line.getAttribute("aria-valuenow")).toBe("42");
    const bar = line.querySelector("span")!;
    expect(bar.className).toContain("bg-accent-green");
    expect(bar.style.width).toBe("42%");
    const chip = screen.getByTestId("progress-chip");
    expect(chip.textContent).toBe("42%");
    expect(chip.className).toContain("text-accent-green");
  });

  it("state 2 renders red at the last-known width; state 4 renders amber", () => {
    renderLayout();
    fireProgress(1, 61);
    fireProgress(2, 0);
    let bar = screen.getByTestId("progress-line").querySelector("span")!;
    expect(bar.className).toContain("bg-signal-red");
    expect(bar.style.width).toBe("61%");
    expect(screen.getByTestId("progress-chip").className).toContain("text-signal-red");
    expect(screen.getByTestId("progress-chip").textContent).toBe("61%");
    fireProgress(4, 0);
    bar = screen.getByTestId("progress-line").querySelector("span")!;
    expect(bar.className).toContain("bg-signal-yellow");
    expect(screen.getByTestId("progress-chip").className).toContain("text-signal-yellow");
  });

  it("state 3 sweeps with no chip; state 0 removes line and chip", () => {
    renderLayout();
    fireProgress(3, 0);
    const line = screen.getByTestId("progress-line");
    expect(line.getAttribute("aria-valuenow")).toBeNull();
    expect(line.querySelector("span")!.className).toContain(
      "rk-tty-progress-indeterminate",
    );
    expect(screen.queryByTestId("progress-chip")).toBeNull();
    fireProgress(0, 0);
    expect(screen.queryByTestId("progress-line")).toBeNull();
    expect(screen.queryByTestId("progress-chip")).toBeNull();
  });

  it("coalesces a burst to one committed frame (latest event wins)", () => {
    renderLayout();
    const props = terminalSpy.mock.lastCall?.[0] as {
      onProgressChange: (state: number, value: number) => void;
    };
    act(() => {
      for (let i = 1; i <= 100; i++) props.onProgressChange(1, i);
    });
    // Nothing commits before the frame, and the burst scheduled ONE callback.
    expect(screen.queryByTestId("progress-line")).toBeNull();
    expect(rafCallbacks.size).toBe(1);
    act(() => {
      for (const cb of [...rafCallbacks.values()]) cb(0);
      rafCallbacks.clear();
    });
    expect(screen.getByTestId("progress-chip").textContent).toBe("100%");
  });

  it("renders progress on tty tiles only, and every tty tile shares the slot", () => {
    renderLayout({ layout: layoutOf("h(tty,code)") });
    fireProgress(1, 30);
    const ttyTile = screen.getByTestId("surface-tile-tty");
    const codeTile = screen.getByTestId("surface-tile-code");
    expect(within(ttyTile).getByTestId("progress-line")).toBeTruthy();
    expect(within(codeTile).queryByTestId("progress-line")).toBeNull();
    expect(within(codeTile).queryByTestId("progress-chip")).toBeNull();
  });

  it("mobile renders the line but no chip (no tile header chrome)", () => {
    renderLayout({ isMobile: true });
    fireProgress(1, 55);
    expect(screen.getByTestId("progress-line")).toBeTruthy();
    expect(screen.queryByTestId("progress-chip")).toBeNull();
  });
});

describe("SurfaceLayout export menu (260819-shqo)", () => {
  it("renders the ⇩ button on the tty header, opening the two-section menu", () => {
    renderLayout({ layout: layoutOf("tty"), statusWindow: STATUS_WINDOW });

    const button = screen.getByRole("button", { name: "Export terminal output" });
    fireEvent.click(button);

    const menu = screen.getByTestId("export-menu");
    expect(within(menu).getByText("This view — client buffer")).toBeTruthy();
    expect(within(menu).getByText("Full history — server capture")).toBeTruthy();
    const rows = within(menu).getAllByRole("menuitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "Download snapshot.html · colors kept",
      "Download transcript.txt · buffer text",
      "Copy visible screen",
      "Download pane history.txt · capture-pane -S -",
    ]);
  });

  it("closes on Escape and on outside click", () => {
    renderLayout({ layout: layoutOf("tty"), statusWindow: STATUS_WINDOW });
    fireEvent.click(screen.getByRole("button", { name: "Export terminal output" }));
    expect(screen.getByTestId("export-menu")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("export-menu")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Export terminal output" }));
    expect(screen.getByTestId("export-menu")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("export-menu")).toBeNull();
  });

  it("disables the history row with the alt-screen hint when the window is altScreen (260820-4le0)", () => {
    renderLayout({
      layout: layoutOf("tty"),
      statusWindow: { ...STATUS_WINDOW, altScreen: true },
    });

    fireEvent.click(screen.getByRole("button", { name: "Export terminal output" }));

    const menu = screen.getByTestId("export-menu");
    // Section header and client rows stay; only the server row changes state.
    expect(within(menu).getByText("Full history — server capture")).toBeTruthy();
    const historyRow = within(menu)
      .getAllByRole("menuitem")
      .find((r) => r.textContent?.includes("Download pane history"));
    expect(historyRow).toBeTruthy();
    expect(historyRow).toHaveProperty("disabled", true);
    expect(historyRow?.getAttribute("aria-disabled")).toBe("true");
    expect(historyRow?.textContent).toContain(
      "agent TUI on alternate screen — tmux holds no scrollback",
    );
    expect(historyRow?.textContent).not.toContain(".txt · capture-pane -S -");

    // A click fires nothing — no fetch, and the menu stays open.
    fireEvent.click(historyRow!);
    expect(screen.getByTestId("export-menu")).toBeTruthy();
  });

  it("does not render on non-tty tiles", () => {
    renderLayout({ layout: layoutOf("web") });
    expect(screen.queryByRole("button", { name: "Export terminal output" })).toBeNull();
  });
});

describe("SurfaceLayout web-tab strip wiring", () => {
  type IframeProps = {
    tabs?: string[];
    active?: number;
    onWriteUrl?: (url: string) => Promise<unknown>;
    onSelectTab?: (n: number) => Promise<unknown>;
    onCloseTab?: (n: number) => Promise<unknown>;
    onMoveTab?: (n: number, to: number) => Promise<unknown>;
    onAddTab?: (target: string) => Promise<{ index: number; existed: boolean }>;
  };
  const lastIframeProps = () => iframeSpy.mock.lastCall?.[0] as IframeProps;
  /** The store entry the optimistic overrides ride (server/session match the
   *  renderLayout defaults). */
  const seedWindowEntry = () => {
    useWindowStore
      .getState()
      .setWindowsForSession("srv", "sess", [makeWindow({ windowId: "@1" })]);
  };
  const storedOverride = () =>
    useWindowStore.getState().entries.get(entryKey("srv", "@1"))?.webOverride;

  const TWO_TABS = ["/proxy/3001/", "/proxy/3002/"];

  it("passes the tab family through and onWriteUrl writes the active slot's option", async () => {
    renderLayout({
      layout: layoutOf("h(tty,web)"),
      window: { webTabs: TWO_TABS, webActive: 2 },
    });
    const props = lastIframeProps();
    expect(props.tabs).toEqual(TWO_TABS);
    expect(props.active).toBe(2);
    await act(async () => {
      await props.onWriteUrl?.("http://localhost:9000/");
    });
    expect(apiSpy.setWindowOptions).toHaveBeenCalledWith("srv", "@1", {
      "@rk_win_web_2": "http://localhost:9000/",
    });
  });

  it("onWriteUrl falls back to slot 1 while the active pointer is unset", async () => {
    renderLayout({
      layout: layoutOf("h(tty,web)"),
      window: { webTabs: TWO_TABS },
    });
    await act(async () => {
      await lastIframeProps().onWriteUrl?.("http://localhost:9000/");
    });
    expect(apiSpy.setWindowOptions).toHaveBeenCalledWith("srv", "@1", {
      "@rk_win_web_1": "http://localhost:9000/",
    });
  });

  it("onSelectTab applies an optimistic webActive override while the POST is in flight", async () => {
    seedWindowEntry();
    let resolveSelect!: (value: { ok: boolean }) => void;
    apiSpy.selectWebTab.mockReturnValue(
      new Promise((resolve) => {
        resolveSelect = resolve;
      }),
    );
    const { rerender } = renderLayout({
      layout: layoutOf("h(tty,web)"),
      window: { webTabs: TWO_TABS, webActive: 1 },
    });

    await act(async () => {
      await lastIframeProps().onSelectTab?.(2);
    });
    expect(apiSpy.selectWebTab).toHaveBeenCalledWith("srv", "@1", 2);
    // In flight: the strip repaints from the override, not the stale payload.
    expect(lastIframeProps().active).toBe(2);
    expect(storedOverride()).toEqual({ webActive: 2 });

    // The POST resolves, then the confirming SSE tick (a rerender carrying
    // the written value) drops the override.
    await act(async () => {
      resolveSelect({ ok: true });
    });
    rerender(
      layoutElement({
        layout: layoutOf("h(tty,web)"),
        window: { webTabs: TWO_TABS, webActive: 2 },
      }),
    );
    expect(storedOverride()).toBeUndefined();
    expect(lastIframeProps().active).toBe(2);
  });

  it("onCloseTab optimistically shifts the family and repoints the active slot", async () => {
    seedWindowEntry();
    apiSpy.removeWebTab.mockReturnValue(new Promise(() => {}));
    renderLayout({
      layout: layoutOf("h(tty,web)"),
      window: { webTabs: ["/a", "/b", "/c"], webActive: 3 },
    });

    await act(async () => {
      await lastIframeProps().onCloseTab?.(2);
    });
    expect(apiSpy.removeWebTab).toHaveBeenCalledWith("srv", "@1", 2);
    // The display-only repointActive mirror: slot 2 leaves, the former tab 3
    // slides into slot 2 and stays active.
    expect(lastIframeProps().tabs).toEqual(["/a", "/c"]);
    expect(lastIframeProps().active).toBe(2);
  });

  it("rapid moves compound optimistically and serialize their POSTs", async () => {
    seedWindowEntry();
    let resolveFirst!: (value: { ok: boolean }) => void;
    let resolveSecond!: (value: { ok: boolean }) => void;
    apiSpy.moveWebTab
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveSecond = resolve;
      }));
    renderLayout({
      layout: layoutOf("h(tty,web)"),
      window: { webTabs: ["/a", "/b", "/c"], webActive: 1 },
    });

    act(() => {
      void lastIframeProps().onMoveTab?.(1, 2);
      void lastIframeProps().onMoveTab?.(2, 3);
    });
    expect(lastIframeProps().tabs).toEqual(["/b", "/c", "/a"]);
    expect(lastIframeProps().active).toBe(3);

    await act(async () => {
      await Promise.resolve();
    });
    expect(apiSpy.moveWebTab).toHaveBeenCalledTimes(1);
    expect(apiSpy.moveWebTab).toHaveBeenNthCalledWith(1, "srv", "@1", 1, 2);

    await act(async () => {
      resolveFirst({ ok: true });
      await Promise.resolve();
    });
    expect(apiSpy.moveWebTab).toHaveBeenCalledTimes(2);
    expect(apiSpy.moveWebTab).toHaveBeenNthCalledWith(2, "srv", "@1", 2, 3);

    await act(async () => {
      resolveSecond({ ok: true });
    });
  });

  it("a rejected move restores the family and toasts the error", async () => {
    seedWindowEntry();
    apiSpy.moveWebTab.mockRejectedValue(new Error("move failed"));
    renderLayout({
      layout: layoutOf("h(tty,web)"),
      window: { webTabs: ["/a", "/b", "/c"], webActive: 1 },
    });

    act(() => {
      void lastIframeProps().onMoveTab?.(1, 2);
    });
    expect(lastIframeProps().tabs).toEqual(["/b", "/a", "/c"]);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("move failed"));
    expect(lastIframeProps().tabs).toEqual(["/a", "/b", "/c"]);
    expect(lastIframeProps().active).toBe(1);
    expect(storedOverride()).toBeUndefined();
  });

  it("a rejected move cancels queued dependents and toasts only once", async () => {
    seedWindowEntry();
    let rejectFirst!: (reason: Error) => void;
    apiSpy.moveWebTab
      .mockReturnValueOnce(new Promise((_, reject) => {
        rejectFirst = reject;
      }))
      .mockResolvedValue({ ok: true });
    renderLayout({
      layout: layoutOf("h(tty,web)"),
      window: { webTabs: ["/a", "/b", "/c"], webActive: 1 },
    });

    act(() => {
      void lastIframeProps().onMoveTab?.(1, 2);
      void lastIframeProps().onMoveTab?.(2, 3);
    });
    expect(lastIframeProps().tabs).toEqual(["/b", "/c", "/a"]);

    await act(async () => {
      await Promise.resolve();
    });
    expect(apiSpy.moveWebTab).toHaveBeenCalledTimes(1);
    expect(apiSpy.moveWebTab).toHaveBeenCalledWith("srv", "@1", 1, 2);

    await act(async () => {
      rejectFirst(new Error("first move failed"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiSpy.moveWebTab).toHaveBeenCalledTimes(1);
    expect(lastIframeProps().tabs).toEqual(["/a", "/b", "/c"]);
    expect(lastIframeProps().active).toBe(1);
    expect(storedOverride()).toBeUndefined();
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain("first move failed");

    act(() => {
      void lastIframeProps().onMoveTab?.(1, 3);
    });
    await waitFor(() => expect(apiSpy.moveWebTab).toHaveBeenCalledTimes(2));
    expect(apiSpy.moveWebTab).toHaveBeenNthCalledWith(2, "srv", "@1", 1, 3);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("a rejected select reverts the override and toasts the error", async () => {
    seedWindowEntry();
    apiSpy.selectWebTab.mockRejectedValue(new Error("no such tab"));
    renderLayout({
      layout: layoutOf("h(tty,web)"),
      window: { webTabs: TWO_TABS, webActive: 1 },
    });

    await act(async () => {
      await lastIframeProps().onSelectTab?.(2);
    });
    expect(lastIframeProps().active).toBe(1);
    expect(storedOverride()).toBeUndefined();
    expect(screen.getByRole("alert").textContent).toContain("no such tab");
  });

  it("a rejected remove restores the family and toasts the error", async () => {
    seedWindowEntry();
    apiSpy.removeWebTab.mockRejectedValue(new Error("web tabs busy"));
    renderLayout({
      layout: layoutOf("h(tty,web)"),
      window: { webTabs: ["/a", "/b", "/c"], webActive: 3 },
    });

    await act(async () => {
      await lastIframeProps().onCloseTab?.(2);
    });
    expect(lastIframeProps().tabs).toEqual(["/a", "/b", "/c"]);
    expect(lastIframeProps().active).toBe(3);
    expect(storedOverride()).toBeUndefined();
    expect(screen.getByRole("alert").textContent).toContain("web tabs busy");
  });

  it("onAddTab re-expresses the relative proxy draft as a loopback target — no optimistic override", async () => {
    seedWindowEntry();
    apiSpy.addWebTab.mockResolvedValue({ index: 3, existed: false, url: "/proxy/3003/" });
    renderLayout({
      layout: layoutOf("h(tty,web)"),
      window: { webTabs: TWO_TABS, webActive: 1 },
    });

    let result: { index: number; existed: boolean } | undefined;
    await act(async () => {
      result = await lastIframeProps().onAddTab?.("/proxy/3003/");
    });
    expect(apiSpy.addWebTab).toHaveBeenCalledWith("srv", "@1", "http://localhost:3003/");
    expect(result).toEqual({ index: 3, existed: false, url: "/proxy/3003/" });
    expect(storedOverride()).toBeUndefined();
    expect(lastIframeProps().tabs).toEqual(TWO_TABS);
  });
});

describe("SurfaceLayout gui tile", () => {
  const GUI_ON = {
    id: "host",
    enabled: true,
    backend: "Xtigervnc",
    reachable: true,
    display: ":10",
    width: 1920,
    height: 1080,
    viewers: 1,
    wm: "icewm-session",
    locked: false,
    geometry: "1920x1080",
  };
  const lastGuiProps = () => guiSpy.mock.calls.at(-1)?.[0];

  it("renders the lazy GuiSurface with glyph [] + label GUI and the seam props", async () => {
    renderLayout({
      layout: layoutOf("h(tty,gui)"),
      gui: GUI_ON,
      guiZoom: 150,
      guiPointerMode: "trackpad",
      onGuiZoomChange: vi.fn(),
      guiResizeLocked: true,
      shouldReclaimChord: () => () => true,
    });
    expect(await screen.findByTestId("mock-gui")).toBeTruthy();
    const tile = screen.getByTestId("surface-tile-gui");
    expect(tile.textContent).toContain("[]");
    expect(tile.textContent).toContain("GUI");
    const props = lastGuiProps();
    expect(props?.gui).toEqual(GUI_ON);
    expect(props?.zoom).toBe(150);
    expect(props?.pointerMode).toBe("trackpad");
    expect(typeof props?.onZoomChange).toBe("function");
    expect(props?.resizeLocked).toBe(true);
    expect(props?.visible).toBe(true);
    // Fine-pointer matchMedia stub → coarsePointer false; slot 1 is not the
    // default focused slot.
    expect(props?.coarsePointer).toBe(false);
    expect(props?.focused).toBe(false);
    expect(typeof props?.onConnectionChange).toBe("function");
    expect(typeof props?.onRestart).toBe("function");
    expect(typeof props?.onOpenLogs).toBe("function");
    expect(typeof props?.shouldReclaimChord).toBe("function");
  });

  it("renders nothing for the gui kind when the signal has not arrived", () => {
    renderLayout({ layout: layoutOf("h(tty,gui)"), gui: null });
    expect(screen.getByTestId("surface-tile-gui")).toBeTruthy();
    expect(screen.queryByTestId("mock-gui")).toBeNull();
  });

  it("zooming the tty tile away keeps the gui tile mounted with visible=false", async () => {
    const zoomToggleRef: { current: (() => void) | null } = { current: null };
    renderLayout({
      layout: layoutOf("h(tty,gui)"),
      gui: GUI_ON,
      zoomToggleRef,
    });
    expect(await screen.findByTestId("mock-gui")).toBeTruthy();
    act(() => zoomToggleRef.current?.());
    // Hide-never-unmount: the tile stays in the DOM, hidden, and the seam
    // reports visible=false (GuiSurface's 15s hidden-disconnect owns the rest).
    const tile = screen.getByTestId("surface-tile-gui");
    expect(tile.className).toContain("hidden");
    expect(lastGuiProps()?.visible).toBe(false);
  });

  it("onInteract focuses the slot and records gui in focus memory", async () => {
    const onFocusedKindChange = vi.fn();
    renderLayout({
      layout: layoutOf("h(tty,gui)"),
      gui: GUI_ON,
      onFocusedKindChange,
    });
    expect(await screen.findByTestId("mock-gui")).toBeTruthy();
    act(() => lastGuiProps()?.onInteract?.());
    expect(onFocusedKindChange).toHaveBeenLastCalledWith("gui");
    expect(recallFocus(focusMemoryKey("srv", "@1"))).toBe("gui");
    expect(lastGuiProps()?.focused).toBe(true);
  });

  it("the header spring carries the measured fold cluster and the ⤢ rail verb fires gui-fullscreen by id", async () => {
    const onFullscreen = vi.fn();
    renderLayout({
      layout: layoutOf("h(tty,gui)"),
      gui: GUI_ON,
      guiActions: [
        { id: "gui-fullscreen", label: "GUI: Fullscreen", onSelect: onFullscreen },
        {
          id: "gui-res-1920x1080",
          label: "GUI: Resolution → 1920×1080",
          description: "current",
          onSelect: vi.fn(),
        },
      ],
    });
    expect(await screen.findByTestId("mock-gui")).toBeTruthy();
    const tile = screen.getByTestId("surface-tile-gui");
    const cluster = within(tile).getByTestId("gui-toolbar");
    // jsdom's zero-width probes keep the cold default: fully expanded.
    expect(within(cluster).getByTestId("gui-toolbar-resolution")).toHaveTextContent("1920×1080 ▾");
    expect(within(cluster).getByLabelText("Zoom in")).toBeTruthy();
    expect(within(cluster).getByLabelText("Toggle stats")).toBeTruthy();
    fireEvent.click(within(tile).getByLabelText("Enter fullscreen"));
    expect(onFullscreen).toHaveBeenCalledOnce();
  });

  it("fullscreen latches ⤢ and suppresses the layout verbs; the exit report restores them", async () => {
    renderLayout({
      layout: layoutOf("h(tty,gui)"),
      gui: GUI_ON,
      guiActions: [{ id: "gui-fullscreen", label: "GUI: Fullscreen", onSelect: vi.fn() }],
    });
    expect(await screen.findByTestId("mock-gui")).toBeTruthy();
    const tile = screen.getByTestId("surface-tile-gui");
    expect(within(tile).getByLabelText("Expand GUI")).toBeTruthy();
    act(() => lastGuiProps()?.onFullscreenChange?.(true));
    const latch = within(tile).getByLabelText("Exit fullscreen");
    expect(latch.getAttribute("aria-pressed")).toBe("true");
    expect(within(tile).queryByLabelText("Expand GUI")).toBeNull();
    expect(within(tile).queryByLabelText("Close GUI")).toBeNull();
    // The fold cluster travels into fullscreen (the header serves it).
    expect(within(tile).getByTestId("gui-toolbar")).toBeTruthy();
    act(() => lastGuiProps()?.onFullscreenChange?.(false));
    expect(within(tile).getByLabelText("Expand GUI")).toBeTruthy();
    expect(within(tile).getByLabelText("Enter fullscreen").getAttribute("aria-pressed")).toBe("false");
  });

  it("the gui header carries a `wm · display` meta chip", async () => {
    renderLayout({ layout: layoutOf("h(tty,gui)"), gui: GUI_ON });
    expect(await screen.findByTestId("mock-gui")).toBeTruthy();
    const tile = screen.getByTestId("surface-tile-gui");
    expect(within(tile).getByText("icewm-session · :10")).toBeTruthy();
  });

  it("the meta chip degrades to the display alone in the bare-WM state, and vanishes with both empty", async () => {
    renderLayout({
      layout: layoutOf("h(tty,gui)"),
      gui: { ...GUI_ON, wm: "" },
    });
    expect(await screen.findByTestId("mock-gui")).toBeTruthy();
    const tile = screen.getByTestId("surface-tile-gui");
    expect(within(tile).getByText(":10")).toBeTruthy();
    expect(within(tile).queryByText(/·/)).toBeNull();
    cleanup();

    renderLayout({
      layout: layoutOf("h(tty,gui)"),
      gui: { ...GUI_ON, wm: "", display: "" },
    });
    expect(await screen.findByTestId("mock-gui")).toBeTruthy();
    // No meta chip: the `bg-bg-card` span is the meta chip's alone in this header.
    expect(
      screen.getByTestId("surface-tile-gui").querySelectorAll(".bg-bg-card"),
    ).toHaveLength(0);
  });
});

describe("SurfaceLayout TileDragContext (the native web engine's drag-posture signal)", () => {
  it("a divider drag moves the web tile's posture idle → resize → idle", () => {
    renderLayout({ layout: layoutOf("h(tty,web)") });
    const tile = () => screen.getByTestId("mock-iframe");
    expect(tile().dataset.tileDragging).toBe("idle");
    const divider = screen.getByTestId("surface-divider-0");
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500 });
    expect(tile().dataset.tileDragging).toBe("resize");
    fireEvent.pointerUp(divider, { pointerId: 1 });
    expect(tile().dataset.tileDragging).toBe("idle");
  });

  it("the intersection drag publishes resize the same way", () => {
    renderLayout({ layout: layoutOf("h(tty,v(code,web))") });
    // jsdom's rects are all zeros — mock the grid's box so the two-axis drag
    // math has a measured container.
    vi.spyOn(screen.getByTestId("surface-layout"), "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 1200,
      height: 1200,
      right: 1200,
      bottom: 1200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const tile = () => screen.getByTestId("mock-iframe");
    expect(tile().dataset.tileDragging).toBe("idle");
    const zone = screen.getByTestId("surface-divider-intersection");
    fireEvent.pointerDown(zone, { pointerId: 1, clientX: 400, clientY: 800 });
    expect(tile().dataset.tileDragging).toBe("resize");
    fireEvent.pointerUp(zone, { pointerId: 1 });
    expect(tile().dataset.tileDragging).toBe("idle");
  });
});

describe("SurfaceLayout header drag (drop to snap)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // The coarse-pointer test re-stubs matchMedia; restore the fine default.
    stubMatchMedia(() => false);
  });

  // The desktop tile's first child is its 35px header (the drag grip
  // surface). jsdom has no layout — measureGrid supplies the container box.
  const headerOf = (tile: HTMLElement): HTMLElement => {
    const header = tile.firstElementChild;
    if (!(header instanceof HTMLElement)) throw new Error("tile has no header element");
    return header;
  };

  /** Press + drag + release on a tile's header, via the window-level mid-drag
   *  routing (moves bubble to the window listeners). */
  function dragHeader(
    tile: HTMLElement,
    from: { x: number; y: number },
    moves: { x: number; y: number }[],
    opts: { release?: boolean } = {},
  ) {
    fireEvent.pointerDown(headerOf(tile), {
      button: 0,
      pointerId: 1,
      clientX: from.x,
      clientY: from.y,
    });
    for (const m of moves) {
      fireEvent.pointerMove(headerOf(tile), { pointerId: 1, clientX: m.x, clientY: m.y });
    }
    if (opts.release !== false) {
      fireEvent.pointerUp(headerOf(tile), { pointerId: 1, clientX: moves[moves.length - 1]?.x, clientY: moves[moves.length - 1]?.y });
    }
  }

  it("a below-threshold header press focuses the tile and never starts a drag", () => {
    measureGrid(1200, 800);
    const onApplyLayout = vi.fn();
    renderLayout({ layout: layoutOf("h(tty,code)"), onApplyLayout });
    const codeTile = screen.getByTestId("surface-tile-code");
    // Focus follows the press (the pointerdown-capture seam)…
    dragHeader(codeTile, { x: 700, y: 15 }, [{ x: 702, y: 16 }]);
    expect(codeTile.className).toContain("border-accent-green");
    // …and nothing else: no overlay, no write.
    expect(screen.queryByTestId("tile-drop-overlay")).toBeNull();
    expect(onApplyLayout).not.toHaveBeenCalled();
  });

  it("past the threshold the overlay previews the result tree; release commits one apply + one sizes write under the new signature", () => {
    measureGrid(1200, 800);
    const onApplyLayout = vi.fn();
    renderLayout({ layout: layoutOf("h(tty,code)"), onApplyLayout });
    const ttyTile = screen.getByTestId("surface-tile-tty");
    // tty's center is ~(300, 400); code's center is ~(900, 400).
    dragHeader(ttyTile, { x: 100, y: 15 }, [{ x: 300, y: 100 }, { x: 900, y: 400 }], {
      release: false,
    });
    // Mid-drag: the overlay draws the swapped result, the dragged tile dims,
    // and the destination rect carries the dragged tile's label.
    const overlay = screen.getByTestId("tile-drop-overlay");
    expect(overlay).toBeTruthy();
    expect(screen.getByTestId("tile-drop-dest").textContent).toContain("Terminal");
    expect(ttyTile.className).toContain("opacity-50");
    expect(onApplyLayout).not.toHaveBeenCalled();
    expect(localStorage.getItem(sizesStorageKey("srv", "@1", "h(0,1)"))).toBeNull();

    fireEvent.pointerUp(headerOf(ttyTile), { pointerId: 1, clientX: 900, clientY: 400 });
    // Commit: exactly one apply with the result tree; the viewer's sizes were
    // written FIRST, under the result's structure signature.
    expect(onApplyLayout).toHaveBeenCalledTimes(1);
    expect(serializeLayoutTree(onApplyLayout.mock.calls[0][0])).toBe("h(code,tty)");
    expect(
      JSON.parse(localStorage.getItem(sizesStorageKey("srv", "@1", "h(0,1)")) ?? "null"),
    ).toEqual([[0.5, 0.5]]);
    expect(screen.queryByTestId("tile-drop-overlay")).toBeNull();
    // Focus moved to the dragged tile at its new position.
    expect(ttyTile.className).toContain("border-accent-green");
  });

  it("a header drag publishes the move posture to the web tile's context", () => {
    measureGrid(1200, 800);
    renderLayout({ layout: layoutOf("h(tty,web)") });
    const frame = () => screen.getByTestId("mock-iframe");
    expect(frame().dataset.tileDragging).toBe("idle");
    const ttyTile = screen.getByTestId("surface-tile-tty");
    dragHeader(ttyTile, { x: 100, y: 15 }, [{ x: 900, y: 400 }], { release: false });
    expect(frame().dataset.tileDragging).toBe("move");
    fireEvent.pointerUp(headerOf(ttyTile), { pointerId: 1, clientX: 900, clientY: 400 });
    expect(frame().dataset.tileDragging).toBe("idle");
  });

  it("Escape cancels: the overlay disappears and nothing is written", () => {
    measureGrid(1200, 800);
    const onApplyLayout = vi.fn();
    renderLayout({ layout: layoutOf("h(tty,code)"), onApplyLayout });
    const ttyTile = screen.getByTestId("surface-tile-tty");
    dragHeader(ttyTile, { x: 100, y: 15 }, [{ x: 900, y: 400 }], { release: false });
    expect(screen.getByTestId("tile-drop-overlay")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("tile-drop-overlay")).toBeNull();
    expect(ttyTile.className).not.toContain("opacity-50");
    fireEvent.pointerUp(headerOf(ttyTile), { pointerId: 1, clientX: 900, clientY: 400 });
    expect(onApplyLayout).not.toHaveBeenCalled();
    expect(localStorage.getItem(sizesStorageKey("srv", "@1", "h(0,1)"))).toBeNull();
  });

  it("release outside the layout or over the dragged tile itself cancels", () => {
    measureGrid(1200, 800);
    const onApplyLayout = vi.fn();
    renderLayout({ layout: layoutOf("h(tty,code)"), onApplyLayout });
    const ttyTile = screen.getByTestId("surface-tile-tty");
    // Outside the box.
    dragHeader(ttyTile, { x: 100, y: 15 }, [{ x: -50, y: 400 }]);
    expect(onApplyLayout).not.toHaveBeenCalled();
    // Over the dragged tile's own rect.
    dragHeader(ttyTile, { x: 100, y: 15 }, [{ x: 300, y: 100 }, { x: 200, y: 400 }]);
    expect(onApplyLayout).not.toHaveBeenCalled();
    expect(localStorage.getItem(sizesStorageKey("srv", "@1", "h(0,1)"))).toBeNull();
  });

  it("a noop drop (the same arrangement back) shows the neutral region and writes nothing", () => {
    measureGrid(1200, 800);
    const onApplyLayout = vi.fn();
    renderLayout({ layout: layoutOf("h(tty,code)"), onApplyLayout });
    const ttyTile = screen.getByTestId("surface-tile-tty");
    // code's LEFT edge band: merging tty beside code's left rebuilds h(tty,code).
    dragHeader(ttyTile, { x: 100, y: 15 }, [{ x: 300, y: 100 }, { x: 610, y: 400 }], {
      release: false,
    });
    expect(screen.getByTestId("tile-drop-noop")).toBeTruthy();
    fireEvent.pointerUp(headerOf(ttyTile), { pointerId: 1, clientX: 610, clientY: 400 });
    expect(onApplyLayout).not.toHaveBeenCalled();
    expect(localStorage.getItem(sizesStorageKey("srv", "@1", "h(0,1)"))).toBeNull();
  });

  it("a mid-drag layout prop change (another viewer's write) cancels the drag", () => {
    measureGrid(1200, 800);
    const onApplyLayout = vi.fn();
    const { rerender } = renderLayout({ layout: layoutOf("h(tty,code)"), onApplyLayout });
    const ttyTile = screen.getByTestId("surface-tile-tty");
    dragHeader(ttyTile, { x: 100, y: 15 }, [{ x: 900, y: 400 }], { release: false });
    expect(screen.getByTestId("tile-drop-overlay")).toBeTruthy();
    rerender(layoutElement({ layout: layoutOf("h(code,tty)"), onApplyLayout }));
    expect(screen.queryByTestId("tile-drop-overlay")).toBeNull();
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 900, clientY: 400 });
    expect(onApplyLayout).not.toHaveBeenCalled();
  });

  it("no drag arms on a coarse pointer, while zoomed, or on a single-leaf layout", () => {
    measureGrid(1200, 800);
    const onApplyLayout = vi.fn();
    // Coarse pointer.
    stubMatchMedia((query) => query.includes("coarse"));
    renderLayout({ layout: layoutOf("h(tty,code)"), onApplyLayout });
    dragHeader(screen.getByTestId("surface-tile-tty"), { x: 100, y: 15 }, [{ x: 900, y: 400 }]);
    expect(screen.queryByTestId("tile-drop-overlay")).toBeNull();
    expect(onApplyLayout).not.toHaveBeenCalled();
    cleanup();
    // Zoomed.
    stubMatchMedia(() => false);
    renderLayout({ layout: layoutOf("h(tty,code)"), onApplyLayout });
    fireEvent.click(screen.getByRole("button", { name: "Expand Code" }));
    dragHeader(screen.getByTestId("surface-tile-code"), { x: 100, y: 15 }, [{ x: 900, y: 400 }]);
    expect(screen.queryByTestId("tile-drop-overlay")).toBeNull();
    expect(onApplyLayout).not.toHaveBeenCalled();
    cleanup();
    // Single leaf.
    renderLayout({ layout: layoutOf("tty"), onApplyLayout });
    dragHeader(screen.getByTestId("surface-tile-tty"), { x: 100, y: 15 }, [{ x: 900, y: 400 }]);
    expect(screen.queryByTestId("tile-drop-overlay")).toBeNull();
    expect(onApplyLayout).not.toHaveBeenCalled();
  });

  it("a press on a header BUTTON never arms a drag", () => {
    measureGrid(1200, 800);
    const onApplyLayout = vi.fn();
    const onClose = vi.fn();
    renderLayout({ layout: layoutOf("h(tty,code)"), onApplyLayout, onClose });
    const closeButton = screen.getByRole("button", { name: "Close Code" });
    fireEvent.pointerDown(closeButton, { button: 0, pointerId: 1, clientX: 700, clientY: 15 });
    fireEvent.pointerMove(closeButton, { pointerId: 1, clientX: 300, clientY: 400 });
    fireEvent.pointerUp(closeButton, { pointerId: 1 });
    expect(screen.queryByTestId("tile-drop-overlay")).toBeNull();
    expect(onApplyLayout).not.toHaveBeenCalled();
  });

  it("pointercancel mid-drag cancels: no commit, overlay gone, posture back to idle", () => {
    measureGrid(1200, 800);
    const onApplyLayout = vi.fn();
    renderLayout({ layout: layoutOf("h(tty,web)"), onApplyLayout });
    const frame = () => screen.getByTestId("mock-iframe");
    const ttyTile = screen.getByTestId("surface-tile-tty");
    dragHeader(ttyTile, { x: 100, y: 15 }, [{ x: 900, y: 400 }], { release: false });
    expect(screen.getByTestId("tile-drop-overlay")).toBeTruthy();
    expect(frame().dataset.tileDragging).toBe("move");
    fireEvent.pointerCancel(window, { pointerId: 1 });
    expect(screen.queryByTestId("tile-drop-overlay")).toBeNull();
    expect(frame().dataset.tileDragging).toBe("idle");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 900, clientY: 400 });
    expect(onApplyLayout).not.toHaveBeenCalled();
    expect(localStorage.getItem(sizesStorageKey("srv", "@1", "h(0,1)"))).toBeNull();
  });

  it("unmount mid-drag cancels cleanly: the release after unmount writes nothing", () => {
    measureGrid(1200, 800);
    const onApplyLayout = vi.fn();
    const { unmount } = renderLayout({ layout: layoutOf("h(tty,code)"), onApplyLayout });
    const ttyTile = screen.getByTestId("surface-tile-tty");
    dragHeader(ttyTile, { x: 100, y: 15 }, [{ x: 900, y: 400 }], { release: false });
    expect(screen.getByTestId("tile-drop-overlay")).toBeTruthy();
    unmount();
    // Listeners went down with the component — a late pointerup is inert.
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 900, clientY: 400 });
    expect(onApplyLayout).not.toHaveBeenCalled();
    expect(localStorage.getItem(sizesStorageKey("srv", "@1", "h(0,1)"))).toBeNull();
  });

  it("a window switch mid-drag cancels the drag (the in-flight gesture belongs to the window it started on)", () => {
    measureGrid(1200, 800);
    const onApplyLayout = vi.fn();
    const { rerender } = renderLayout({ layout: layoutOf("h(tty,code)"), onApplyLayout });
    const ttyTile = screen.getByTestId("surface-tile-tty");
    dragHeader(ttyTile, { x: 100, y: 15 }, [{ x: 900, y: 400 }], { release: false });
    expect(screen.getByTestId("tile-drop-overlay")).toBeTruthy();
    rerender(layoutElement({ layout: layoutOf("h(tty,code)"), windowId: "@2", onApplyLayout }));
    expect(screen.queryByTestId("tile-drop-overlay")).toBeNull();
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 900, clientY: 400 });
    expect(onApplyLayout).not.toHaveBeenCalled();
    expect(localStorage.getItem(sizesStorageKey("srv", "@1", "h(0,1)"))).toBeNull();
    expect(localStorage.getItem(sizesStorageKey("srv", "@2", "h(0,1)"))).toBeNull();
  });

  it("release on a too-small result writes nothing (the drop was never offered)", () => {
    // A 400×180 box: a bottom span would leave ~87px rows — under the floor.
    measureGrid(400, 180);
    const onApplyLayout = vi.fn();
    renderLayout({ layout: layoutOf("h(tty,web)"), onApplyLayout });
    const frame = () => screen.getByTestId("mock-iframe");
    const ttyTile = screen.getByTestId("surface-tile-tty");
    dragHeader(ttyTile, { x: 100, y: 15 }, [{ x: 200, y: 174 }], { release: false });
    expect(screen.getByTestId("tile-drop-too-small")).toBeTruthy();
    expect(frame().dataset.tileDragging).toBe("move");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 200, clientY: 174 });
    expect(onApplyLayout).not.toHaveBeenCalled();
    expect(localStorage.getItem(sizesStorageKey("srv", "@1", "v(0,1)"))).toBeNull();
    expect(screen.queryByTestId("tile-drop-overlay")).toBeNull();
    expect(frame().dataset.tileDragging).toBe("idle");
  });
});

describe("SurfaceLayout cross-tab tiles (foreign leaves)", () => {
  const HOME = makeWindow({
    windowId: "@3",
    name: "api",
    worktreePath: "/home/user/api",
    gitRoot: "/home/user/api",
    webTabs: ["http://localhost:3000"],
    webActive: 1,
  });
  const foreignMaps = {
    windowsById: new Map([["@3", HOME]]) as ReadonlyMap<string, WindowInfo>,
    sessionNameByWindowId: new Map([["@3", "home-sess"]]) as ReadonlyMap<string, string>,
  };
  /** Latest TerminalClient props for mounts of the given window id. */
  const terminalPropsFor = (id: string) =>
    terminalSpy.mock.calls
      .map(([p]) => p as Record<string, unknown>)
      .filter((p) => p.windowId === id)
      .at(-1);

  it("a foreign tty tile opens its relay stream on the home window, isolated, with its own ws bucket", () => {
    const wsRef: { current: WebSocket | null } = { current: null };
    render(
      <ToastProvider>
        <SurfaceLayout
          layout={layoutOf("h(tty,@3/tty)")}
          server="srv"
          windowId="@1"
          sessionName="sess"
          window={FULL_WINDOW}
          isMobile={false}
          wsRef={wsRef}
          focusRef={{ current: null }}
          scrollLocked={false}
          onSessionNotFound={vi.fn()}
          codeReachable
          onClose={vi.fn()}
          onApplyLayout={vi.fn()}
          windowsById={foreignMaps.windowsById}
          sessionNameByWindowId={foreignMaps.sessionNameByWindowId}
        />
      </ToastProvider>,
    );
    expect(screen.getByTestId("surface-tile-tty")).toBeTruthy();
    expect(screen.getByTestId("surface-tile-tty-@3")).toBeTruthy();
    const bare = terminalPropsFor("@1");
    const foreign = terminalPropsFor("@3");
    expect(bare?.isolate).toBe(false);
    expect(bare?.sessionName).toBe("sess");
    expect(bare?.wsRef).toBe(wsRef);
    expect(foreign?.isolate).toBe(true);
    expect(foreign?.sessionName).toBe("home-sess");
    expect(foreign?.wsRef).not.toBe(wsRef);
    // The shared-ref seams stay with the bare primary: no focusRef, no
    // switch-receipt, no not-found redirect on the foreign mount.
    expect(foreign?.focusRef).toBeUndefined();
    expect(foreign?.switchReceiptSource).toBe(false);
    expect(foreign?.onSessionNotFound).toBeUndefined();
  });

  it("the focused tty tile registers focus; a foreign tile registers with its own window/session/bucket", () => {
    renderLayout({ layout: layoutOf("h(tty,@3/tty,web)"), ...foreignMaps });
    // Default focus is the first leaf — the bare primary registers.
    expect(terminalPropsFor("@1")?.registerFocus).toBe(true);
    expect(terminalPropsFor("@3")?.registerFocus).toBe(false);

    // Focus the foreign tile: registration flips to it.
    fireEvent.pointerDown(screen.getByTestId("surface-tile-tty-@3"));
    expect(terminalPropsFor("@3")?.registerFocus).toBe(true);
    expect(terminalPropsFor("@1")?.registerFocus).toBe(false);

    // Focus a non-tty tile: the primary bare tty holds the slot again.
    fireEvent.pointerDown(screen.getByTestId("surface-tile-web"));
    expect(terminalPropsFor("@1")?.registerFocus).toBe(true);
    expect(terminalPropsFor("@3")?.registerFocus).toBe(false);
  });

  it("the primary tty is the first BARE tty even when a foreign tty leads reading order", () => {
    const dock = <div data-testid="tty-dock">dock</div>;
    renderLayout({ layout: layoutOf("h(@3/tty,tty)"), ttyDockContent: dock, ...foreignMaps });
    const bareTile = screen.getByTestId("surface-tile-tty");
    const foreignTile = screen.getByTestId("surface-tile-tty-@3");
    // Find/export affordances and the dock live on the bare primary.
    expect(within(bareTile).getByRole("button", { name: "Find in terminal" })).toBeTruthy();
    expect(within(foreignTile).queryByRole("button", { name: "Find in terminal" })).toBeNull();
    expect(within(bareTile).getByTestId("tty-dock")).toBeTruthy();
    expect(within(foreignTile).queryByTestId("tty-dock")).toBeNull();
    // The foreign tile's header names its home window's status dot record.
    expect(terminalPropsFor("@3")?.focusRef).toBeUndefined();
  });

  it("a layout of only a foreign tty still mounts, registers focus, and hosts the dock", () => {
    const dock = <div data-testid="tty-dock">dock</div>;
    renderLayout({ layout: layoutOf("@3/tty"), ttyDockContent: dock, ...foreignMaps });
    const foreignTile = screen.getByTestId("surface-tile-tty-@3");
    const props = terminalPropsFor("@3");
    expect(props?.isolate).toBe(true);
    expect(props?.registerFocus).toBe(true);
    // No bare tty exists — the strip docks in the foreign tile.
    expect(within(foreignTile).getByTestId("tty-dock")).toBeTruthy();
    expect(props?.wsRef).toBeDefined();
  });

  it("pane verbs target the TILE's window: the foreign tile splits/closes @3", () => {
    const onSplitPane = vi.fn();
    const onClosePane = vi.fn();
    renderLayout({ layout: layoutOf("h(tty,@3/tty)"), onSplitPane, onClosePane, ...foreignMaps });
    const foreignTile = screen.getByTestId("surface-tile-tty-@3");
    fireEvent.click(within(foreignTile).getByRole("button", { name: "Split pane horizontally" }));
    expect(onSplitPane).toHaveBeenCalledWith(true, "@3");
    fireEvent.click(within(foreignTile).getByRole("button", { name: "Close pane" }));
    expect(onClosePane).toHaveBeenCalledWith("@3");
    const bareTile = screen.getByTestId("surface-tile-tty");
    fireEvent.click(within(bareTile).getByRole("button", { name: "Split pane vertically" }));
    expect(onSplitPane).toHaveBeenCalledWith(false, "@1");
  });

  it("zoom persists the foreign leaf's address id and restores it", () => {
    renderLayout({ layout: layoutOf("h(tty,@3/tty)"), ...foreignMaps });
    const foreignTile = screen.getByTestId("surface-tile-tty-@3");
    fireEvent.click(within(foreignTile).getByRole("button", { name: "Expand Terminal" }));
    expect(localStorage.getItem("rk-layout-zoom:srv:@1")).toBe("@3/tty");
    expect(screen.getByTestId("surface-tile-tty").classList.contains("hidden")).toBe(true);
    expect(foreignTile.classList.contains("hidden")).toBe(false);
    fireEvent.click(within(foreignTile).getByRole("button", { name: "Restore Terminal" }));
    expect(localStorage.getItem("rk-layout-zoom:srv:@1")).toBeNull();
  });

  it("a stored foreign zoom id resolves on mount; a dead kind clears", () => {
    localStorage.setItem("rk-layout-zoom:srv:@1", "@3/tty");
    renderLayout({ layout: layoutOf("h(tty,@3/tty)"), ...foreignMaps });
    expect(screen.getByTestId("surface-tile-tty").classList.contains("hidden")).toBe(true);
    expect(screen.getByTestId("surface-tile-tty-@3").classList.contains("hidden")).toBe(false);
  });

  describe("per-window progress slots", () => {
    // Deterministic rAF (the progress describe's pattern): progress commits
    // coalesce to one frame.
    let rafCallbacks: Map<number, FrameRequestCallback>;
    let nextRafId: number;
    const realRaf = window.requestAnimationFrame;
    const realCaf = window.cancelAnimationFrame;

    beforeEach(() => {
      rafCallbacks = new Map();
      nextRafId = 1;
      window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        const id = nextRafId++;
        rafCallbacks.set(id, cb);
        return id;
      }) as typeof window.requestAnimationFrame;
      window.cancelAnimationFrame = ((id: number) => {
        rafCallbacks.delete(id);
      }) as typeof window.cancelAnimationFrame;
    });

    afterEach(() => {
      window.requestAnimationFrame = realRaf;
      window.cancelAnimationFrame = realCaf;
    });

    function fireProgressFor(id: string, state: number, value: number) {
      const props = terminalPropsFor(id) as {
        onProgressChange?: (state: number, value: number) => void;
      };
      expect(props.onProgressChange).toBeTypeOf("function");
      act(() => {
        props.onProgressChange!(state, value);
        for (const cb of [...rafCallbacks.values()]) cb(0);
        rafCallbacks.clear();
      });
    }

    it("a foreign tty's chip/line render on its own tile, never the route window's slot", () => {
      renderLayout({ layout: layoutOf("h(tty,@3/tty)"), ...foreignMaps });
      const bareTile = screen.getByTestId("surface-tile-tty");
      const foreignTile = screen.getByTestId("surface-tile-tty-@3");

      fireProgressFor("@3", 1, 42);
      expect(within(foreignTile).getByTestId("progress-line")).toBeTruthy();
      expect(within(foreignTile).getByTestId("progress-chip").textContent).toBe("42%");
      expect(within(bareTile).queryByTestId("progress-line")).toBeNull();
      expect(within(bareTile).queryByTestId("progress-chip")).toBeNull();

      fireProgressFor("@1", 1, 7);
      expect(within(bareTile).getByTestId("progress-chip").textContent).toBe("7%");
      // The foreign slot is untouched by the route window's event.
      expect(within(foreignTile).getByTestId("progress-chip").textContent).toBe("42%");
    });
  });

  describe("foreign web tile (home window state)", () => {
    type IframeProps = {
      tabs?: string[];
      active?: number;
      onWriteUrl?: (url: string) => Promise<unknown>;
      onSelectTab?: (n: number) => Promise<unknown>;
      onAddTab?: (target: string) => Promise<{ index: number; existed: boolean }>;
    };
    const lastIframeProps = () => iframeSpy.mock.lastCall?.[0] as IframeProps;
    const seedHomeEntry = () => {
      useWindowStore.getState().setWindowsForSession("srv", "home-sess", [HOME]);
    };
    const storedHomeOverride = () =>
      useWindowStore.getState().entries.get(entryKey("srv", "@3"))?.webOverride;

    it("reads the home window's tab family and writes its options", async () => {
      renderLayout({ layout: layoutOf("h(tty,@3/web)"), ...foreignMaps });
      expect(screen.getByTestId("surface-tile-web-@3")).toBeTruthy();
      const props = lastIframeProps();
      expect(props.tabs).toEqual(["http://localhost:3000"]);
      expect(props.active).toBe(1);
      await act(async () => {
        await props.onWriteUrl?.("http://localhost:4000/");
      });
      expect(apiSpy.setWindowOptions).toHaveBeenCalledWith("srv", "@3", {
        "@rk_win_web_1": "http://localhost:4000/",
      });
      await act(async () => {
        await props.onAddTab?.("http://localhost:5000");
      });
      expect(apiSpy.addWebTab).toHaveBeenCalledWith("srv", "@3", "http://localhost:5000");
    });

    it("select keys the optimistic override by the home window", async () => {
      seedHomeEntry();
      apiSpy.selectWebTab.mockReturnValue(new Promise(() => {}));
      renderLayout({
        layout: layoutOf("h(tty,@3/web)"),
        ...foreignMaps,
        windowsById: new Map([
          ["@3", { ...HOME, webTabs: ["/a", "/b"], webActive: 1 }],
        ]),
      });
      await act(async () => {
        await lastIframeProps().onSelectTab?.(2);
      });
      expect(apiSpy.selectWebTab).toHaveBeenCalledWith("srv", "@3", 2);
      expect(storedHomeOverride()).toEqual({ webActive: 2 });
      expect(lastIframeProps().active).toBe(2);
      // The route window's entry carries nothing.
      expect(
        useWindowStore.getState().entries.get(entryKey("srv", "@1"))?.webOverride,
      ).toBeUndefined();
    });
  });

  describe("foreign code tile (home window state)", () => {
    const codeSrcForHome = (id: string) => (id === "@3" ? "/code/?workspace=/ws@3" : null);

    it("resolves root and frame from the home window's record", () => {
      renderLayout({
        layout: layoutOf("h(tty,@3/code)"),
        codeSrcFor: codeSrcForHome,
        ...foreignMaps,
      });
      const tile = screen.getByTestId("surface-tile-code-@3");
      // The header meta names the HOME window's code root basename.
      expect(tile.textContent).toContain("api");
      const props = codeSpy.mock.calls.at(-1)?.[0];
      expect(props?.gitRoot).toBe("/home/user/api");
      expect(props?.workspaceSrc).toBe("/code/?workspace=/ws@3");
    });

    it("the Follow verb reads the home window's drift and reports through the shared wrapper", async () => {
      const onCodeFollowTerminal = vi.fn(() => Promise.resolve());
      renderLayout({
        layout: layoutOf("h(tty,@3/code)"),
        codeSrcFor: codeSrcForHome,
        codeRootForWindow: () => "/home/user/api",
        windowsById: new Map([
          ["@3", { ...HOME, codeRoot: "/latched/root", gitRoot: "/home/user/api" }],
        ]),
        sessionNameByWindowId: foreignMaps.sessionNameByWindowId,
        onCodeFollowTerminal,
      });
      const tile = screen.getByTestId("surface-tile-code-@3");
      const verb = within(tile).getByRole("button", { name: "Follow terminal" });
      await act(async () => {
        fireEvent.click(verb);
      });
      expect(onCodeFollowTerminal).toHaveBeenCalledWith("/home/user/api");
    });

    it("the borrowed code tile reuses the home window's retained frame across a route switch", () => {
      const codeSrcForAll = (id: string) => `/code/?workspace=/ws${id}`;
      const { rerender } = renderLayout({
        layout: layoutOf("h(tty,code)"),
        codeSrcFor: codeSrcForAll,
        liveWindowIds: new Set(["@1", "@3"]),
        ...foreignMaps,
      });
      const node1 = screen.getByTestId("mock-code");
      // Switch to a route whose layout borrows @3's code surface — wait, @3's
      // frame never existed; first build @3's frame by visiting @3's own tab.
      rerender(
        layoutElement({
          layout: layoutOf("h(tty,code)"),
          windowId: "@3",
          codeSrcFor: codeSrcForAll,
          liveWindowIds: new Set(["@1", "@3"]),
          ...foreignMaps,
        }),
      );
      const node3 = within(screen.getByTestId("surface-tile-code")).getByTestId("mock-code");
      // Now borrow @3's code into @1: the visible tile is the SAME frame node.
      rerender(
        layoutElement({
          layout: layoutOf("h(tty,@3/code)"),
          windowId: "@1",
          codeSrcFor: codeSrcForAll,
          liveWindowIds: new Set(["@1", "@3"]),
          ...foreignMaps,
        }),
      );
      const borrowed = within(screen.getByTestId("surface-tile-code-@3")).getByTestId("mock-code");
      expect(borrowed).toBe(node3);
      expect(node1.isConnected).toBe(true);
    });
  });
});

describe("SurfaceLayout away placeholder (home slot of a borrowed surface)", () => {
  const HOLDER = makeWindow({ windowId: "@3", name: "api" });
  const ROUTE = makeWindow({
    windowId: "@1",
    name: "editor",
    agentState: "active",
    awayIn: { tty: "@3" },
  });
  const awayMaps = {
    windowsById: new Map([
      ["@1", ROUTE],
      ["@3", HOLDER],
    ]) as ReadonlyMap<string, WindowInfo>,
    sessionNameByWindowId: new Map([["@3", "home-sess"]]) as ReadonlyMap<string, string>,
  };

  it("an away bare leaf renders the placeholder with message, verbs, and the status dot — and mounts NO terminal", () => {
    const onSendHome = vi.fn();
    const onGoToWindow = vi.fn();
    const onClose = vi.fn();
    renderLayout({
      layout: layoutOf("h(tty,web)"),
      statusWindow: ROUTE,
      onSendHome,
      onGoToWindow,
      onClose,
      ...awayMaps,
    });
    const tile = screen.getByTestId("surface-tile-tty");
    const placeholder = within(tile).getByTestId("surface-placeholder");
    expect(placeholder.textContent).toContain("Terminal is in tab api");
    // The tty status dot reads the route window's record, as the sidebar row
    // shows it.
    expect(within(placeholder).getByRole("img")).toBeTruthy();
    // The surface is not mounted — no relay stream for the away tty.
    expect(screen.queryByTestId("mock-terminal")).toBeNull();
    expect(screen.getByTestId("mock-iframe")).toBeTruthy();

    fireEvent.click(within(placeholder).getByRole("button", { name: "bring back" }));
    expect(onSendHome).toHaveBeenCalledWith("@3", "@1/tty");
    fireEvent.click(within(placeholder).getByRole("button", { name: "go to api" }));
    expect(onGoToWindow).toHaveBeenCalledWith("@3");
    fireEvent.click(within(placeholder).getByRole("button", { name: "Close Terminal" }));
    expect(onClose).toHaveBeenCalledWith("tty");
  });

  it("a sole-leaf placeholder fills the tab and hides its ✕", () => {
    renderLayout({ layout: layoutOf("tty"), statusWindow: ROUTE, ...awayMaps });
    const placeholder = screen.getByTestId("surface-placeholder");
    expect(placeholder.textContent).toContain("Terminal is in tab api");
    expect(within(placeholder).queryByRole("button", { name: "Close Terminal" })).toBeNull();
    expect(within(placeholder).getByRole("button", { name: "bring back" })).toBeTruthy();
    expect(screen.queryByTestId("mock-terminal")).toBeNull();
  });

  it("mobile renders the placeholder when the shown slot is away", () => {
    renderLayout({
      layout: layoutOf("h(tty,web)"),
      isMobile: true,
      mobileActiveSlot: 0,
      statusWindow: ROUTE,
      ...awayMaps,
    });
    expect(screen.getByTestId("surface-placeholder").textContent).toContain(
      "Terminal is in tab api",
    );
    expect(screen.queryByTestId("mock-terminal")).toBeNull();
  });

  it("a dead holder renders the surface live again (awayIn is stale)", () => {
    renderLayout({
      layout: layoutOf("h(tty,web)"),
      windowsById: new Map([["@1", ROUTE]]),
    });
    expect(screen.queryByTestId("surface-placeholder")).toBeNull();
    expect(screen.getByTestId("mock-terminal")).toBeTruthy();
  });
});

describe("SurfaceLayout ↩ send-home header button (foreign tiles)", () => {
  const HOME = makeWindow({ windowId: "@3", name: "api" });
  const maps = {
    windowsById: new Map([["@3", HOME]]) as ReadonlyMap<string, WindowInfo>,
    sessionNameByWindowId: new Map([["@3", "home-sess"]]) as ReadonlyMap<string, string>,
  };

  it("shows ↩ only on a foreign tile, names the home tab, and sends the leaf home from the route window", () => {
    const onSendHome = vi.fn();
    renderLayout({ layout: layoutOf("h(tty,@3/tty)"), onSendHome, ...maps });
    const foreignTile = screen.getByTestId("surface-tile-tty-@3");
    // The header identifies the home tab.
    expect(within(foreignTile).getByTestId("tile-home").textContent).toBe("api");
    const verb = within(foreignTile).getByRole("button", { name: "Send Terminal back to api" });
    expect(verb).toHaveProperty("disabled", false);
    fireEvent.click(verb);
    expect(onSendHome).toHaveBeenCalledWith("@1", "@3/tty");
    // Bare leaves carry no ↩ and no home chip.
    const bareTile = screen.getByTestId("surface-tile-tty");
    expect(within(bareTile).queryByRole("button", { name: /Send .* back to/ })).toBeNull();
    expect(within(bareTile).queryByTestId("tile-home")).toBeNull();
  });

  it("disables ↩ while the home window is dead (not in the window map)", () => {
    renderLayout({
      layout: layoutOf("h(tty,@3/tty)"),
      onSendHome: vi.fn(),
      windowsById: new Map(),
    });
    const foreignTile = screen.getByTestId("surface-tile-tty-@3");
    expect(
      within(foreignTile).getByRole("button", { name: "Send Terminal back to @3" }),
    ).toHaveProperty("disabled", true);
  });
});

describe("SurfaceLayout sidebar row-drag borrow (drop-catcher)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    stubMatchMedia(() => false);
  });

  const WINDOW_DRAG_MIME = "application/x-window-drag";

  /** A minimal mutable dataTransfer bag (the boards-section test's shape). */
  function makeDataTransfer() {
    const store = new Map<string, string>();
    const types: string[] = [];
    return {
      setData: (type: string, data: string) => {
        store.set(type, data);
        if (!types.includes(type)) types.push(type);
      },
      getData: (type: string) => store.get(type) ?? "",
      get types() {
        return types;
      },
      dropEffect: "none",
      effectAllowed: "copyMove",
    };
  }

  function makeRowDrag(overrides: Partial<{
    server: string;
    session: string;
    index: number;
    windowId: string;
    name: string;
  }> = {}) {
    const dt = makeDataTransfer();
    const payload = {
      server: "srv",
      session: "sess",
      index: 1,
      windowId: "@3",
      name: "api",
      ...overrides,
    };
    dt.setData("application/json", JSON.stringify(payload));
    dt.setData(WINDOW_DRAG_MIME, payload.windowId);
    return dt;
  }

  /** jsdom has no DragEvent constructor — a plain bubbling Event with the
   *  dataTransfer/coordinates defined reaches both the native window
   *  listeners (dragstart/dragend) and React's root-registered dragover/drop. */
  function fireDrag(target: Element | Window, type: string, dt: object, x = 0, y = 0) {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    Object.defineProperty(ev, "clientX", { value: x });
    Object.defineProperty(ev, "clientY", { value: y });
    act(() => {
      target.dispatchEvent(ev);
    });
  }

  const startRowDrag = (dt: object) => fireDrag(document.body, "dragstart", dt);

  it("a window-row drag arms the catcher with the mid-drag seam; a tile-edge drop borrows @3/tty", () => {
    measureGrid(1200, 800);
    const onBorrowDrop = vi.fn();
    renderLayout({ layout: layoutOf("h(tty,web)"), onBorrowDrop });
    expect(screen.queryByTestId("row-drop-catcher")).toBeNull();

    startRowDrag(makeRowDrag());
    const catcher = screen.getByTestId("row-drop-catcher");
    // The mid-drag seam: the native web engine's posture flips to move.
    expect(screen.getByTestId("mock-iframe").dataset.tileDragging).toBe("move");
    expect(onBorrowDrop).not.toHaveBeenCalled();

    // The tty tile is the left half (0..597); its right-edge band is a split
    // zone — the overlay previews the result tree with the borrowed tile.
    fireDrag(catcher, "dragover", makeRowDrag(), 590, 400);
    expect(screen.getByTestId("tile-drop-overlay")).toBeTruthy();
    expect(screen.getByTestId("tile-drop-dest").textContent).toContain("Terminal");

    fireDrag(catcher, "drop", makeRowDrag(), 590, 400);
    expect(onBorrowDrop).toHaveBeenCalledTimes(1);
    const [addr, tree] = onBorrowDrop.mock.calls[0] as [string, Layout];
    expect(addr).toBe("@3/tty");
    expect(serializeLayoutTree(tree)).toBe("h(tty,@3/tty,web)");
    // Sizes went down under the result's structure signature, and the
    // catcher/preview are gone after the drop.
    expect(
      localStorage.getItem(sizesStorageKey("srv", "@1", "h(0,1,2)")),
    ).not.toBeNull();
    expect(screen.queryByTestId("row-drop-catcher")).toBeNull();
    expect(screen.queryByTestId("tile-drop-overlay")).toBeNull();
    expect(screen.getByTestId("mock-iframe").dataset.tileDragging).toBe("idle");
  });

  it("dragend without a drop disarms the catcher and writes nothing", () => {
    measureGrid(1200, 800);
    const onBorrowDrop = vi.fn();
    renderLayout({ layout: layoutOf("h(tty,web)"), onBorrowDrop });
    startRowDrag(makeRowDrag());
    expect(screen.getByTestId("row-drop-catcher")).toBeTruthy();
    fireDrag(window, "dragend", makeRowDrag());
    expect(screen.queryByTestId("row-drop-catcher")).toBeNull();
    expect(onBorrowDrop).not.toHaveBeenCalled();
  });

  it("a center-zone hover previews 'no change' and the drop writes nothing", () => {
    measureGrid(1200, 800);
    const onBorrowDrop = vi.fn();
    renderLayout({ layout: layoutOf("h(tty,web)"), onBorrowDrop });
    const dt = makeRowDrag();
    startRowDrag(dt);
    const catcher = screen.getByTestId("row-drop-catcher");
    // (300, 400) is the tty tile's center — a no-op zone for external leaves.
    fireDrag(catcher, "dragover", dt, 300, 400);
    expect(screen.getByTestId("tile-drop-noop").textContent).toBe("No change");
    fireDrag(catcher, "drop", dt, 300, 400);
    expect(onBorrowDrop).not.toHaveBeenCalled();
  });

  it("refused drops preview 'no change': the route window's own row, an address already in the layout, a cross-server drag", () => {
    measureGrid(1200, 800);
    const onBorrowDrop = vi.fn();
    renderLayout({ layout: layoutOf("h(tty,web)"), onBorrowDrop });

    // The route window's own row.
    let dt = makeRowDrag({ windowId: "@1", name: "editor" });
    startRowDrag(dt);
    fireDrag(screen.getByTestId("row-drop-catcher"), "dragover", dt, 590, 400);
    expect(screen.getByTestId("tile-drop-noop").textContent).toBe("No change");
    fireDrag(screen.getByTestId("row-drop-catcher"), "drop", dt, 590, 400);
    expect(onBorrowDrop).not.toHaveBeenCalled();

    // A cross-server row.
    dt = makeRowDrag({ server: "other" });
    startRowDrag(dt);
    fireDrag(screen.getByTestId("row-drop-catcher"), "dragover", dt, 590, 400);
    expect(screen.getByTestId("tile-drop-noop").textContent).toBe("No change");
    fireDrag(window, "dragend", dt);
    expect(onBorrowDrop).not.toHaveBeenCalled();
  });

  it("refuses a row whose @N/tty is already in the layout", () => {
    measureGrid(1200, 800);
    const onBorrowDrop = vi.fn();
    renderLayout({
      layout: layoutOf("h(tty,@3/tty)"),
      onBorrowDrop,
      windowsById: new Map([["@3", makeWindow({ windowId: "@3", name: "api" })]]),
      sessionNameByWindowId: new Map([["@3", "home-sess"]]),
    });
    const dt = makeRowDrag();
    startRowDrag(dt);
    fireDrag(screen.getByTestId("row-drop-catcher"), "dragover", dt, 590, 400);
    expect(screen.getByTestId("tile-drop-noop").textContent).toBe("No change");
    fireDrag(screen.getByTestId("row-drop-catcher"), "drop", dt, 590, 400);
    expect(onBorrowDrop).not.toHaveBeenCalled();
  });

  it("ignores drags that are not window rows (no catcher)", () => {
    measureGrid(1200, 800);
    renderLayout({ layout: layoutOf("h(tty,web)") });
    const dt = makeDataTransfer();
    dt.setData("application/json", JSON.stringify({ server: "srv", windowId: "@3" }));
    startRowDrag(dt);
    expect(screen.queryByTestId("row-drop-catcher")).toBeNull();
  });
});

describe("SurfaceLayout popout (header Pop out / popout posture / popped-set posture)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    stubMatchMedia(() => false);
    localStorage.clear();
  });

  const headerOf = (tile: HTMLElement): HTMLElement => {
    const header = tile.firstElementChild;
    if (!(header instanceof HTMLElement)) throw new Error("tile has no header element");
    return header;
  };

  it("offers Pop out in each tile's content-verb family, firing with the leaf id", () => {
    const onPopOut = vi.fn();
    renderLayout({ layout: layoutOf("h(tty,code)"), onPopOut });
    const tty = screen.getByTestId("surface-tile-tty");
    const code = screen.getByTestId("surface-tile-code");
    fireEvent.click(within(tty).getByLabelText("Pop out Terminal"));
    fireEvent.click(within(code).getByLabelText("Pop out Code"));
    expect(onPopOut.mock.calls.map(([id]) => id)).toEqual(["tty", "code"]);
    // The tile's rendered rect rides along for the popup size (the nominal
    // box under jsdom).
    expect(onPopOut.mock.calls[0][1]).toMatchObject({ w: expect.any(Number), h: expect.any(Number) });
  });

  it("offers Pop out alone on a single-tile layout (no Expand/Close cluster)", () => {
    const onPopOut = vi.fn();
    renderLayout({ layout: layoutOf("tty"), onPopOut });
    const tty = screen.getByTestId("surface-tile-tty");
    fireEvent.click(within(tty).getByLabelText("Pop out Terminal"));
    expect(onPopOut).toHaveBeenCalledWith("tty", expect.objectContaining({ w: expect.any(Number) }));
    expect(within(tty).queryByLabelText("Expand Terminal")).toBeNull();
    expect(within(tty).queryByLabelText("Close Terminal")).toBeNull();
  });

  it("offers no Pop out when the seam is absent (the caller's mobile / shell-without-popout-channel gate)", () => {
    renderLayout({ layout: layoutOf("h(tty,code)") });
    expect(screen.queryByLabelText("Pop out Terminal")).toBeNull();
    expect(screen.queryByLabelText("Pop out Code")).toBeNull();
  });

  it("offers no Pop out on a coarse pointer or on mobile", () => {
    stubMatchMedia((query) => query === COARSE_POINTER_QUERY);
    const coarse = renderLayout({ layout: layoutOf("tty"), onPopOut: vi.fn() });
    expect(screen.queryByLabelText("Pop out Terminal")).toBeNull();
    coarse.unmount();
    stubMatchMedia(() => false);
    renderLayout({ layout: layoutOf("tty"), isMobile: true, onPopOut: vi.fn() });
    expect(screen.queryByLabelText("Pop out Terminal")).toBeNull();
  });

  it("offers no Pop out on the away placeholder or a dead-home foreign tile", () => {
    // tty away at @3 → its bare leaf renders the placeholder (no header); the
    // @12/tty home is absent from the window map (dead) → its header carries
    // no Pop out.
    renderLayout({
      layout: layoutOf("h(tty,@12/tty,web)"),
      window: { webTabs: ["http://localhost:8080"], webActive: 1, awayIn: { tty: "@3" } },
      windowsById: new Map([
        ["@1", makeWindow({ windowId: "@1", name: "win", awayIn: { tty: "@3" } })],
        ["@3", makeWindow({ windowId: "@3", name: "holder" })],
      ]),
      onPopOut: vi.fn(),
    });
    expect(screen.queryByLabelText("Pop out Terminal")).toBeNull();
    expect(screen.getByTestId("surface-placeholder")).toBeTruthy();
    expect(screen.getByLabelText("Pop out Web")).toBeTruthy();
    const foreignTile = screen.getByTestId("surface-tile-tty-@12");
    expect(within(foreignTile).queryByLabelText("Pop out Terminal")).toBeNull();
  });

  it("the popout posture renders the tile with Pop back in and no layout-verb cluster", () => {
    const onPopBackIn = vi.fn();
    renderLayout({
      layout: layoutOf("code"),
      popoutLeafId: "code",
      onPopBackIn,
      codeSrcFor: (id) => `/code/?workspace=/ws${id}`,
    });
    const tile = screen.getByTestId("surface-tile-code");
    fireEvent.click(within(tile).getByLabelText("Pop Code back in"));
    expect(onPopBackIn).toHaveBeenCalledTimes(1);
    expect(within(tile).queryByLabelText("Expand Code")).toBeNull();
    expect(within(tile).queryByLabelText("Close Code")).toBeNull();
    expect(within(tile).queryByLabelText("Pop out Code")).toBeNull();
  });

  it("the popout posture isolates the tty tile's relay stream and keeps the pane segment", () => {
    terminalSpy.mockClear();
    renderLayout({ layout: layoutOf("tty"), popoutLeafId: "tty", onPopBackIn: vi.fn() });
    expect(terminalSpy).toHaveBeenCalled();
    expect(terminalSpy.mock.calls[0][0].isolate).toBe(true);
    // Content verbs survive the popout posture (the layout cluster is what
    // gets replaced).
    expect(screen.getByLabelText("Split pane horizontally")).toBeTruthy();
    expect(screen.getByLabelText("Pop Terminal back in")).toBeTruthy();
    expect(screen.queryByLabelText("Close Terminal")).toBeNull();
  });

  it("a bare (home-tab) tty tile outside the popout posture never isolates", () => {
    terminalSpy.mockClear();
    renderLayout({ layout: layoutOf("h(tty,code)") });
    expect(terminalSpy.mock.calls[0][0].isolate).toBe(false);
  });

  it("the header drag never arms while a leaf is popped", () => {
    measureGrid(1200, 800);
    const onApplyLayout = vi.fn();
    renderLayout({ layout: layoutOf("h(tty,code)"), popped: ["code"], onApplyLayout });
    const ttyTile = screen.getByTestId("surface-tile-tty");
    const header = headerOf(ttyTile);
    expect(header.className).not.toContain("cursor-grab");
    fireEvent.pointerDown(header, { button: 0, pointerId: 1, clientX: 100, clientY: 15 });
    fireEvent.pointerMove(header, { pointerId: 1, clientX: 900, clientY: 400 });
    fireEvent.pointerUp(header, { pointerId: 1, clientX: 900, clientY: 400 });
    expect(screen.queryByTestId("tile-drop-overlay")).toBeNull();
    expect(onApplyLayout).not.toHaveBeenCalled();
  });

  it("a popped leaf renders hidden when the tree still contains it (the all-popped placeholder render)", () => {
    renderLayout({ layout: layoutOf("h(tty,code)"), popped: ["tty", "code"] });
    expect(screen.getByTestId("surface-tile-tty").className).toContain("hidden");
    expect(screen.getByTestId("surface-tile-code").className).toContain("hidden");
  });

  it("a popped zoomed leaf clears the zoom (state and stored key)", () => {
    localStorage.setItem("rk-layout-zoom:srv:@1", "tty");
    const onZoomChange = vi.fn();
    // h(tty,tty) with the FIRST tty zoomed; popping `tty` reduces the render
    // to the remaining tty tile (whose id is again `tty` — only the
    // popped-set rule, not the leaf-left-tree rule, can clear this zoom).
    const { rerender } = renderLayout({ layout: layoutOf("h(tty,tty)"), onZoomChange });
    onZoomChange.mockClear();
    rerender(layoutElement({ layout: layoutOf("tty"), popped: ["tty"], onZoomChange }));
    expect(onZoomChange).toHaveBeenCalledWith(false);
    expect(localStorage.getItem("rk-layout-zoom:srv:@1")).toBeNull();
  });

  it("a popped code leaf evicts the opener's retained frame", () => {
    const srcFor = (id: string) => `/code/?workspace=/ws${id}`;
    const { rerender } = renderLayout({
      layout: layoutOf("h(tty,code)"),
      codeSrcFor: srcFor,
    });
    expect(screen.getByTestId("mock-code")).toBeTruthy();
    rerender(
      layoutElement({ layout: layoutOf("tty"), popped: ["code"], codeSrcFor: srcFor }),
    );
    expect(screen.queryByTestId("mock-code")).toBeNull();
  });

  it("the borrow row-drag stays disarmed while a leaf is popped", () => {
    measureGrid(1200, 800);
    renderLayout({ layout: layoutOf("h(tty,code)"), popped: ["code"] });
    const dt = {
      types: ["application/x-window-drag"],
      getData: (type: string) =>
        type === "application/json"
          ? JSON.stringify({ server: "srv", session: "sess", index: 1, windowId: "@3", name: "api" })
          : "",
      setData: () => {},
    };
    const event = new Event("dragstart", { bubbles: true });
    Object.defineProperty(event, "dataTransfer", { value: dt });
    window.dispatchEvent(event);
    expect(screen.queryByTestId("row-drop-catcher")).toBeNull();
  });

  it("a revealed popped leaf renders the popped placeholder in its slot — no header, no surface mount, no hidden tile", () => {
    const onPopIn = vi.fn();
    const onFocusPopout = vi.fn();
    const onHidePopped = vi.fn();
    // The parent hands the tree reduced by popped − revealed: the revealed
    // `tty` leaf is present, mounted as the placeholder.
    renderLayout({
      layout: layoutOf("h(tty,web)"),
      window: { webTabs: ["http://localhost:8080"], webActive: 1 },
      popped: ["tty"],
      revealedPoppedIds: ["tty"],
      statusWindow: STATUS_WINDOW,
      onPopIn,
      onFocusPopout,
      onHidePopped,
    });
    const tile = screen.getByTestId("surface-tile-tty");
    // The slot is visible (no hidden-tile retention entry for a revealed leaf).
    expect(tile.classList.contains("hidden")).toBe(false);
    expect(screen.getAllByTestId("surface-tile-tty")).toHaveLength(1);
    const placeholder = within(tile).getByTestId("surface-placeholder");
    expect(placeholder.textContent).toContain("Terminal is popped out");
    // The tty status dot reads the tile window's record, as the header would.
    expect(within(placeholder).getByRole("img")).toBeTruthy();
    // No header (no Pop out / Expand / Close) and no relay stream.
    expect(within(tile).queryByLabelText("Pop out Terminal")).toBeNull();
    expect(screen.queryByTestId("mock-terminal")).toBeNull();
    // The sibling surface mounts live.
    expect(screen.getByTestId("mock-iframe")).toBeTruthy();

    fireEvent.click(within(placeholder).getByRole("button", { name: "bring back" }));
    expect(onPopIn).toHaveBeenCalledWith("tty");
    fireEvent.click(within(placeholder).getByRole("button", { name: "go to window" }));
    expect(onFocusPopout).toHaveBeenCalledWith("tty");
    // ✕ at arity > 1: hide only, never a layout close.
    fireEvent.click(within(placeholder).getByRole("button", { name: "Close Terminal" }));
    expect(onHidePopped).toHaveBeenCalledWith("tty");
  });

  it("a sole revealed popped leaf fills the tab with the popped placeholder and hides its ✕", () => {
    renderLayout({
      layout: layoutOf("tty"),
      popped: ["tty"],
      revealedPoppedIds: ["tty"],
      onPopIn: vi.fn(),
      onFocusPopout: vi.fn(),
      onHidePopped: vi.fn(),
    });
    const placeholder = screen.getByTestId("surface-placeholder");
    expect(placeholder.textContent).toContain("Terminal is popped out");
    expect(within(placeholder).queryByRole("button", { name: "Close Terminal" })).toBeNull();
    expect(within(placeholder).getByRole("button", { name: "bring back" })).toBeTruthy();
    expect(screen.queryByTestId("mock-terminal")).toBeNull();
  });

  it("a revealed popped code leaf renders the placeholder and mounts no frame", () => {
    const srcFor = (id: string) => `/code/?workspace=/ws${id}`;
    const { rerender } = renderLayout({
      layout: layoutOf("h(tty,code)"),
      codeSrcFor: srcFor,
    });
    expect(screen.getByTestId("mock-code")).toBeTruthy();
    // Pop code out (evicting the frame), then reveal it: the slot mounts the
    // placeholder — no frame mount, no show-bookkeeping re-create (the
    // popout owns the live frame).
    rerender(
      layoutElement({
        layout: layoutOf("h(tty,code)"),
        popped: ["code"],
        revealedPoppedIds: ["code"],
        codeSrcFor: srcFor,
        onPopIn: vi.fn(),
      }),
    );
    expect(screen.queryByTestId("mock-code")).toBeNull();
    expect(screen.queryByTestId("surface-tile-code-retained")).toBeNull();
    expect(screen.getByTestId("surface-placeholder").textContent).toContain("Code is popped out");
  });
});
