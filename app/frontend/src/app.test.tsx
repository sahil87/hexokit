import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act, within } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { useEffect } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { CommandPalette, type PaletteAction } from "@/components/command-palette";
import {
  buildTabPickerActions,
  buildWindowSwitchActions,
  resolveServerView,
  ServerShell,
  AppLayout,
} from "@/app";
import { availableViews, hasCode } from "@/lib/window-view";
import type { ServerInfo } from "@/api/client";
import { operatorRequestToast, QUEUED_OPERATOR_TOAST } from "@/lib/operator-request";
import {
  urlSegmentToWindowId,
  validateTerminalSearch,
  windowIdToUrlSegment,
} from "@/lib/router-url";
import { ThemeProvider } from "@/contexts/theme-context";
import { ToastProvider } from "@/components/toast";
import { InstanceNameProvider } from "@/contexts/instance-name-context";
import { InstanceAccentValueProvider } from "@/contexts/instance-accent-context";
import type { InstanceAccent } from "@/contexts/instance-accent-context";
import { ChromeProvider } from "@/contexts/chrome-context";
import { ZenProvider, useZenDispatch } from "@/contexts/zen-context";
import { FocusedTerminalProvider } from "@/contexts/focused-terminal-context";
import { OptimisticProvider } from "@/contexts/optimistic-context";
import { TopBarSlotProvider, useTopBarSlot } from "@/contexts/top-bar-slot-context";
import { FocusedPaneProvider } from "@/contexts/focused-pane-context";
import { ServerDialogsProvider } from "@/contexts/server-dialogs-context";
import { PaletteActionsProvider } from "@/contexts/palette-actions-context";
import { GuiOffRequestProvider } from "@/contexts/gui-off-context";
import {
  HostMetricsProvider,
  MetricsProvider,
  StandaloneSessionContextProvider,
} from "@/contexts/session-context";
import { stubMatchMedia } from "@/test-utils/match-media";
import { makeSession, makeWindow } from "@/test-utils/fixtures";

// `@/app` transitively imports terminal-client → @xterm/addon-unicode-graphemes,
// whose import-time trie init is a documented CI flake ("Data error" — see
// lib/router-url.test.ts). Mock the addon (the terminal-client.test.tsx
// pattern) so this suite never loads the real module.
vi.mock("@xterm/addon-unicode-graphemes", () => ({
  UnicodeGraphemesAddon: vi.fn(),
}));

// ── Terminal-route harness mocks (the grid-key block at the bottom) ─────────
// The grid-key test renders ServerShell (AppShell) under a memory router. The
// SurfaceLayout child is replaced by a mount-spying stub: the block asserts
// the KEY behavior at the app.tsx seam (the tty-DOM survival inside the grid
// is surface-layout.test.tsx's; the end-to-end form is the e2e spec's).
const surfaceLayoutSpy = vi.hoisted(() => ({
  mounts: [] as Array<"mount" | "unmount">,
  props: vi.fn(),
}));
vi.mock("@/components/surface-layout", async () => {
  const tree = await vi.importActual<typeof import("@/lib/layout-tree")>(
    "@/lib/layout-tree",
  );
  const { useRef: useLatestRef } = await vi.importActual<typeof import("react")>("react");
  return {
    SurfaceLayout: (props: {
      server: string;
      windowId: string;
      layout?: import("@/lib/layout-tree").LayoutNode;
      revealedPoppedIds?: string[];
      layoutRectsRef?: { current: (() => Map<string, import("@/lib/layout-tree").Rect>) | null };
      onFocusedKindChange?: (kind: import("@/lib/layout-tree").SurfaceKind) => void;
      onFocusedLeafChange?: (leafId: string) => void;
    }) => {
      surfaceLayoutSpy.props({ server: props.server, windowId: props.windowId });
      const { layout, layoutRectsRef, onFocusedKindChange, onFocusedLeafChange, windowId } =
        props;
      // The child's per-window seams, simulated: refill the rects getter and
      // re-report the focused leaf (the LAST leaf, the stand-in for user
      // interaction) once per window — the real component's
      // `[server, windowId]` reset effect re-reports the same way.
      const latest = useLatestRef({ layout, layoutRectsRef, onFocusedKindChange, onFocusedLeafChange });
      latest.current = { layout, layoutRectsRef, onFocusedKindChange, onFocusedLeafChange };
      useEffect(() => {
        const {
          layout: current,
          layoutRectsRef: rectsRef,
          onFocusedKindChange: reportKind,
          onFocusedLeafChange: reportLeaf,
        } = latest.current;
        if (!current) return;
        if (rectsRef) {
          rectsRef.current = () => tree.layoutRects(current, tree.NOMINAL_BOX);
        }
        const ids = tree.leafIds(current);
        const kinds = tree.leaves(current);
        reportKind?.(kinds[kinds.length - 1]);
        reportLeaf?.(ids[ids.length - 1]);
        // Once per window AND layout arrival: the parent's report callbacks
        // change identity per render, so depending on them would loop
        // (report → re-render → re-report); the latest props ride the ref.
      }, [windowId, layout]);
      useEffect(() => {
        surfaceLayoutSpy.mounts.push("mount");
        return () => {
          surfaceLayoutSpy.mounts.push("unmount");
        };
      }, []);
      return (
        <div
          data-testid="mock-surface-layout"
          data-leaves={layout ? tree.leafIds(layout).join(",") : ""}
          data-revealed={(props.revealedPoppedIds ?? []).join(",")}
        />
      );
    },
  };
});

// The host-global signal hooks read nested contexts only the real
// SessionProvider fills (it owns the state socket — never opened in tests).
// Everything else in the module stays real: the controlled session value
// arrives through the real StandaloneSessionContextProvider below. `useGui`
// reads a hoisted mutable (default null — every pre-existing test's posture)
// so a test can arm the gui tile's availability gate.
const guiSignalMock = vi.hoisted(() => ({
  current: null as import("@/contexts/session-context").GuiSignal | null,
}));
vi.mock("@/contexts/session-context", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/contexts/session-context")>();
  return {
    ...mod,
    useCodeServer: () => ({ reachable: false }),
    useGui: () => guiSignalMock.current,
  };
});

// Every network call routes through these two modules. Keep the real modules
// (constants, error classes, pure helpers) and stub only the fetchers that
// fire on this route's mount/navigation: list getters resolve [], the rest
// resolve a benign `{ ok: true }`.
const apiSpies = vi.hoisted(() => ({
  setWindowOptions: vi.fn(),
}));
vi.mock("@/api/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/api/client")>();
  const ok = () => Promise.resolve({ ok: true });
  return {
    ...mod,
    getHealth: () => Promise.resolve({}),
    getOpenApps: () => Promise.resolve([]),
    getCron: () => Promise.resolve({ entries: [], deliveries: [] }),
    listClosedWindows: () => Promise.resolve([]),
    getSessions: () => Promise.resolve([]),
    getDirectories: () => Promise.resolve([]),
    selectWindow: ok,
    setWindowOptions: (...args: unknown[]) => {
      apiSpies.setWindowOptions(...args);
      return ok();
    },
    postSettings: ok,
  };
});
vi.mock("@/api/boards", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/api/boards")>();
  return {
    ...mod,
    listBoards: () => Promise.resolve([]),
    getBoard: () => Promise.resolve([]),
  };
});

/**
 * Tests for move window CmdK actions (T010).
 *
 * These test the action generation logic as it would appear in the palette:
 * - "Window: Move up" present when not at min index, absent at min
 * - "Window: Move down" present when not at max index, absent at max
 * - onSelect calls the expected move function
 */

function openPalette() {
  fireEvent.keyDown(document, { key: "k", code: "KeyK", metaKey: true });
}

describe("operator request toast outcomes", () => {
  it("keeps the action-specific copy for immediate delivery", () => {
    expect(operatorRequestToast({ outcome: "delivered" }, "Sent to operator — done shortly")).toBe(
      "Sent to operator — done shortly",
    );
  });

  it("uses the shared queued copy for every queued action", () => {
    expect(operatorRequestToast({ outcome: "queued" }, "Sent to operator — done shortly")).toBe(
      QUEUED_OPERATOR_TOAST,
    );
  });
});

describe("tab picker palette actions", () => {
  it("registers the label and marker entries through the production builder", () => {
    const actions = buildTabPickerActions("srv", "@7");
    expect(actions.map((action) => action.id)).toEqual([
      "window-label",
      "window-marker",
    ]);
    expect(actions.map((action) => action.label)).toEqual([
      "Tab: Label",
      "Tab: Marker",
    ]);
  });

  it("dispatches the matching marker-pad opener detail", () => {
    const listener = vi.fn();
    document.addEventListener("marker-pad:open", listener);
    const markerAction = buildTabPickerActions("srv", "@7").find(
      (action) => action.id === "window-marker",
    );
    expect(markerAction).toBeDefined();
    markerAction?.onSelect();
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      server: "srv",
      windowId: "@7",
    });
    document.removeEventListener("marker-pad:open", listener);
  });
});

/** Build windowActions matching the pattern in app.tsx. */
function buildWindowActions(opts: {
  currentWindowIndex: number;
  minIndex: number;
  maxIndex: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
}): PaletteAction[] {
  const actions: PaletteAction[] = [];
  if (opts.currentWindowIndex > opts.minIndex) {
    actions.push({
      id: "window-move-up",
      label: "Window: Move up",
      onSelect: opts.onMoveUp,
    });
  }
  if (opts.currentWindowIndex < opts.maxIndex) {
    actions.push({
      id: "window-move-down",
      label: "Window: Move down",
      onSelect: opts.onMoveDown,
    });
  }
  return actions;
}

describe("CmdK Move Window Actions", () => {
  afterEach(cleanup);

  it("shows Move up and Move down when window is in the middle", () => {
    const onMoveUp = vi.fn();
    const onMoveDown = vi.fn();
    const actions = buildWindowActions({
      currentWindowIndex: 1,
      minIndex: 0,
      maxIndex: 2,
      onMoveUp,
      onMoveDown,
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.getByText("Window: Move up")).toBeInTheDocument();
    expect(screen.getByText("Window: Move down")).toBeInTheDocument();
  });

  it("hides Move up when window is at min index", () => {
    const actions = buildWindowActions({
      currentWindowIndex: 0,
      minIndex: 0,
      maxIndex: 2,
      onMoveUp: vi.fn(),
      onMoveDown: vi.fn(),
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.queryByText("Window: Move up")).not.toBeInTheDocument();
    expect(screen.getByText("Window: Move down")).toBeInTheDocument();
  });

  it("hides Move down when window is at max index", () => {
    const actions = buildWindowActions({
      currentWindowIndex: 2,
      minIndex: 0,
      maxIndex: 2,
      onMoveUp: vi.fn(),
      onMoveDown: vi.fn(),
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.getByText("Window: Move up")).toBeInTheDocument();
    expect(screen.queryByText("Window: Move down")).not.toBeInTheDocument();
  });

  it("hides both when session has only one window", () => {
    const actions = buildWindowActions({
      currentWindowIndex: 0,
      minIndex: 0,
      maxIndex: 0,
      onMoveUp: vi.fn(),
      onMoveDown: vi.fn(),
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.queryByText("Window: Move up")).not.toBeInTheDocument();
    expect(screen.queryByText("Window: Move down")).not.toBeInTheDocument();
  });

  it("Move up onSelect fires correctly", () => {
    const onMoveUp = vi.fn();
    const actions = buildWindowActions({
      currentWindowIndex: 1,
      minIndex: 0,
      maxIndex: 2,
      onMoveUp,
      onMoveDown: vi.fn(),
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    // Filter to Move up, then Enter
    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Move up" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onMoveUp).toHaveBeenCalledOnce();
  });

  it("Move down onSelect fires correctly", () => {
    const onMoveDown = vi.fn();
    const actions = buildWindowActions({
      currentWindowIndex: 1,
      minIndex: 0,
      maxIndex: 2,
      onMoveUp: vi.fn(),
      onMoveDown,
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Move down" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onMoveDown).toHaveBeenCalledOnce();
  });
});

/** Build move-to-session actions matching the pattern in app.tsx. */
function buildMoveToSessionActions(opts: {
  sessions: { name: string }[];
  currentSession: string | null;
  hasCurrentWindow: boolean;
  onMove: (targetSession: string) => void;
}): PaletteAction[] {
  if (!opts.hasCurrentWindow || !opts.currentSession || opts.sessions.length < 2) {
    return [];
  }
  return opts.sessions
    .filter((s) => s.name !== opts.currentSession)
    .map((s) => ({
      id: `move-window-to-session-${s.name}`,
      label: `Window: Move to ${s.name}`,
      onSelect: () => opts.onMove(s.name),
    }));
}

describe("CmdK Move Window to Session Actions", () => {
  afterEach(cleanup);

  it("shows one Move to action when two sessions exist", () => {
    const onMove = vi.fn();
    const actions = buildMoveToSessionActions({
      sessions: [{ name: "alpha" }, { name: "bravo" }],
      currentSession: "alpha",
      hasCurrentWindow: true,
      onMove,
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.getByText("Window: Move to bravo")).toBeInTheDocument();
    expect(screen.queryByText("Window: Move to alpha")).not.toBeInTheDocument();
  });

  it("shows two Move to actions when three sessions exist", () => {
    const onMove = vi.fn();
    const actions = buildMoveToSessionActions({
      sessions: [{ name: "alpha" }, { name: "bravo" }, { name: "charlie" }],
      currentSession: "alpha",
      hasCurrentWindow: true,
      onMove,
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.getByText("Window: Move to bravo")).toBeInTheDocument();
    expect(screen.getByText("Window: Move to charlie")).toBeInTheDocument();
    expect(screen.queryByText("Window: Move to alpha")).not.toBeInTheDocument();
  });

  it("shows no Move to actions when only one session exists", () => {
    const onMove = vi.fn();
    const actions = buildMoveToSessionActions({
      sessions: [{ name: "alpha" }],
      currentSession: "alpha",
      hasCurrentWindow: true,
      onMove,
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.queryByText(/Window: Move to/)).not.toBeInTheDocument();
  });

  it("shows no Move to actions when no window is selected", () => {
    const onMove = vi.fn();
    const actions = buildMoveToSessionActions({
      sessions: [{ name: "alpha" }, { name: "bravo" }],
      currentSession: "alpha",
      hasCurrentWindow: false,
      onMove,
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.queryByText(/Window: Move to/)).not.toBeInTheDocument();
  });

  it("onSelect fires with correct target session", () => {
    const onMove = vi.fn();
    const actions = buildMoveToSessionActions({
      sessions: [{ name: "alpha" }, { name: "bravo" }],
      currentSession: "alpha",
      hasCurrentWindow: true,
      onMove,
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Move to bravo" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onMove).toHaveBeenCalledWith("bravo");
  });
});

/**
 * Tests for quick session/window launch actions (260405-gle4-quick-session-launch).
 *
 * These test the session/window creation action generation logic as it would
 * appear in the palette — mirrors the pattern used by the move-window tests above.
 */

/** Build sessionActions matching the pattern in app.tsx. */
function buildSessionActions(opts: {
  sessionName: string | undefined;
  onCreate: () => void;
  onRenameSession?: () => void;
  onKillSession?: () => void;
}): PaletteAction[] {
  const actions: PaletteAction[] = [
    { id: "create-session", label: "Session: Create", onSelect: opts.onCreate },
  ];
  if (opts.sessionName) {
    actions.push(
      { id: "rename-session", label: "Session: Rename", onSelect: opts.onRenameSession ?? vi.fn() },
      { id: "kill-session", label: "Session: Kill", onSelect: opts.onKillSession ?? vi.fn() },
    );
  }
  return actions;
}

/** Build window creation actions matching the pattern in app.tsx. */
function buildWindowCreationActions(opts: {
  sessionName: string | undefined;
  onCreateWindow: () => void;
  onCreateWindowAtFolder: () => void;
}): PaletteAction[] {
  if (!opts.sessionName) return [];
  return [
    { id: "create-window", label: "Window: Create", onSelect: opts.onCreateWindow },
    { id: "create-window-at-folder", label: "Window: Create at Folder", onSelect: opts.onCreateWindowAtFolder },
  ];
}

describe("CmdK Session Creation Actions", () => {
  afterEach(cleanup);

  it("Session: Create fires its onSelect (the name-prompt opener)", () => {
    const onCreate = vi.fn();
    const actions = buildSessionActions({ sessionName: undefined, onCreate });

    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Session: Create" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCreate).toHaveBeenCalledOnce();
  });

  it("Session: Create at Folder is gone — searching 'create' finds only the remaining entries", () => {
    const actions = buildSessionActions({
      sessionName: "my-session",
      onCreate: vi.fn(),
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "create" } });

    expect(screen.getByText("Session: Create")).toBeInTheDocument();
    expect(screen.queryByText("Session: Create at Folder")).not.toBeInTheDocument();
  });
});

describe("CmdK Window At-Folder Action", () => {
  afterEach(cleanup);

  it("Window: Create at Folder appears when session is active", () => {
    const onCreateWindowAtFolder = vi.fn();
    const actions = buildWindowCreationActions({
      sessionName: "my-session",
      onCreateWindow: vi.fn(),
      onCreateWindowAtFolder,
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.getByText("Window: Create at Folder")).toBeInTheDocument();
  });

  it("Window: Create at Folder is absent when no session is active", () => {
    const actions = buildWindowCreationActions({
      sessionName: undefined,
      onCreateWindow: vi.fn(),
      onCreateWindowAtFolder: vi.fn(),
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.queryByText("Window: Create at Folder")).not.toBeInTheDocument();
  });

  it("Window: Create at Folder onSelect fires correctly", () => {
    const onCreateWindowAtFolder = vi.fn();
    const actions = buildWindowCreationActions({
      sessionName: "my-session",
      onCreateWindow: vi.fn(),
      onCreateWindowAtFolder,
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Window: Create at Folder" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onCreateWindowAtFolder).toHaveBeenCalledOnce();
  });
});

/** Tests for the production per-window switch palette builder. */

const NBSP_ANGLE = "›"; // U+203A — the label separator used in app.tsx

describe("CmdK Window Switch Actions", () => {
  afterEach(cleanup);

  it("renders one Tab: Switch to entry per window with the › separator and (current) on the active window", () => {
    const actions = buildWindowSwitchActions({
      flatWindows: [
        { session: "alpha", window: { windowId: "@1", name: "edit" } },
        { session: "alpha", window: { windowId: "@2", name: "serve" } },
        { session: "bravo", window: { windowId: "@3", name: "logs" } },
      ],
      windowParam: "@2",
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    // Non-active windows: plain `<session> › <name>` label, no suffix.
    expect(screen.getByText(`Tab: Switch to alpha ${NBSP_ANGLE} edit`)).toBeInTheDocument();
    expect(screen.getByText(`Tab: Switch to bravo ${NBSP_ANGLE} logs`)).toBeInTheDocument();
    // Active window (windowId === windowParam): carries the (current) suffix.
    expect(screen.getByText(`Tab: Switch to alpha ${NBSP_ANGLE} serve (current)`)).toBeInTheDocument();
    // Only one entry is marked current.
    expect(screen.getAllByText(/\(current\)/)).toHaveLength(1);
  });

  it("marks no entry (current) when windowParam matches no window (e.g. dashboard route)", () => {
    const actions = buildWindowSwitchActions({
      flatWindows: [
        { session: "alpha", window: { windowId: "@1", name: "edit" } },
        { session: "alpha", window: { windowId: "@2", name: "serve" } },
      ],
      windowParam: undefined,
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.getByText(`Tab: Switch to alpha ${NBSP_ANGLE} edit`)).toBeInTheDocument();
    expect(screen.getByText(`Tab: Switch to alpha ${NBSP_ANGLE} serve`)).toBeInTheDocument();
    expect(screen.queryByText(/\(current\)/)).not.toBeInTheDocument();
  });

  it("onSelect fires with the window's id", () => {
    const onSelectWindow = vi.fn();
    const actions = buildWindowSwitchActions({
      flatWindows: [
        { session: "alpha", window: { windowId: "@1", name: "edit" } },
        { session: "bravo", window: { windowId: "@3", name: "logs" } },
      ],
      windowParam: "@1",
      onSelectWindow,
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "logs" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelectWindow).toHaveBeenCalledWith("@3");
  });

  it("decorates only operator windows with the headset and operator description", () => {
    const actions = buildWindowSwitchActions({
      flatWindows: [
        {
          session: "system",
          window: {
            windowId: "@1",
            name: "coordinator",
            role: "operator",
          },
        },
        {
          session: "work",
          window: { windowId: "@2", name: "worker" },
        },
      ],
      windowParam: "@1",
    });

    expect(actions[0].description).toBe("operator");
    expect(actions[0].icon).toBeTruthy();
    expect(actions[1].description).toBeUndefined();
    expect(actions[1].icon).toBeUndefined();

    render(<CommandPalette actions={actions} />);
    openPalette();
    fireEvent.change(screen.getByPlaceholderText(/^Type a command/), {
      target: { value: "operator" },
    });
    expect(screen.getByTestId("operator-headset-icon")).toBeInTheDocument();
    expect(screen.getByText("Tab: Switch to system › coordinator (current)")).toBeInTheDocument();
    expect(screen.queryByText("Tab: Switch to work › worker")).not.toBeInTheDocument();
  });
});

/**
 * Tests for the three-way server route guard (260602-3i5d).
 *
 * `resolveServerView` is the pure decision behind the AppShell guard:
 *   - server in list                              → "view"
 *   - server absent, === pendingServer            → "waiting"
 *   - server absent, !== pendingServer, loaded    → "not-found"
 *   - server absent, !== pendingServer, !loaded   → "view" (don't flash not-found)
 */
describe("resolveServerView — three-way route guard", () => {
  const srv = (...names: string[]): ServerInfo[] =>
    names.map((name) => ({ name, sessionCount: 0 }));

  it("returns 'view' when the server is in the list", () => {
    expect(resolveServerView("alpha", srv("alpha", "bravo"), null, true)).toBe("view");
  });

  it("returns 'waiting' for a just-created server absent from the list (=== pendingServer)", () => {
    // Pre-existing servers present and list loaded — the old `servers.length > 0`
    // proxy would have wrongly returned not-found here. The pending marker must win.
    expect(resolveServerView("newsrv", srv("alpha"), "newsrv", true)).toBe("waiting");
  });

  it("swaps 'waiting' → 'view' once the refreshed list includes the pending server", () => {
    // Same pending marker, but now the server has appeared in the list.
    expect(resolveServerView("newsrv", srv("alpha", "newsrv"), "newsrv", true)).toBe("view");
  });

  it("returns 'not-found' immediately for a genuinely-unknown name once loaded", () => {
    expect(resolveServerView("typo", srv("alpha"), null, true)).toBe("not-found");
    // A different pending server must not rescue an unrelated unknown name.
    expect(resolveServerView("typo", srv("alpha"), "other", true)).toBe("not-found");
  });

  it("does NOT return 'not-found' for an unknown non-pending name before the first fetch resolves", () => {
    expect(resolveServerView("typo", [], null, false)).toBe("view");
    expect(resolveServerView("typo", srv("alpha"), null, false)).toBe("view");
  });
});

/**
 * `codeRoot` (the shared `@rk_win_code_root`) keeps a window code-capable
 * after its active pane leaves the repo — the stable-availability contract the
 * retired per-browser latch enforced.
 */
describe("hasCode — the code-root availability contract", () => {
  it("keeps the code lens available when the live derivation went empty (the pane-switch case)", () => {
    // The intake's screenshot scenario: the active pane leaves the repo, so the
    // next SSE tick derives "". The shared code root is what stops the strobe.
    const win = { gitRoot: "", codeRoot: "/home/user/latched" };
    expect(hasCode({ gitRoot: "" })).toBe(false);
    expect(hasCode(win)).toBe(true);
    expect(availableViews(win)).toEqual([
      "code",
      "web",
      "tty",
    ]);
  });
});

/**
 * Tests for the ungated `View:` palette entries (R4) — `toggle-fixed-width`
 * from `viewActions` in `app.tsx` (AppShell's route list) plus the global
 * "View: Refresh Page" (`use-global-palette-actions.ts`, layout-level since
 * 260811-239r), the full-page-reload recovery affordance (constitution V).
 * Mirrors the action-construction logic in production so the test catches
 * drift if either side changes.
 */
function buildViewStaticActions(opts: {
  fixedWidth?: boolean;
  onToggleFixedWidth?: () => void;
  onRefresh?: () => void;
}): PaletteAction[] {
  return [
    {
      id: "toggle-fixed-width",
      label: opts.fixedWidth ? "View: Full Width" : "View: Fixed Width (900px)",
      onSelect: () => opts.onToggleFixedWidth?.(),
    },
    {
      id: "refresh-page",
      label: "View: Refresh Page",
      onSelect: () => opts.onRefresh?.(),
    },
  ];
}

describe("CmdK View Actions (AppShell palette)", () => {
  afterEach(cleanup);

  it("renders the ungated 'View: Refresh Page' entry", () => {
    const actions = buildViewStaticActions({});
    render(<CommandPalette actions={actions} />);
    openPalette();
    expect(screen.getByText("View: Refresh Page")).toBeInTheDocument();
  });

  it("invokes reload when 'View: Refresh Page' is selected", () => {
    const onRefresh = vi.fn();
    const actions = buildViewStaticActions({ onRefresh });
    render(<CommandPalette actions={actions} />);
    openPalette();
    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Refresh Page" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});

/**
 * Tests for the operator mark/unmark palette pair (260813-ifya), from
 * `windowActions` in app.tsx. "Window: Mark as Operator" is listed when a
 * current window exists and is NOT the operator; "Window: Unmark Operator"
 * when it IS. Mirrors the action-construction logic in app.tsx so the test
 * catches drift if either side changes the gating/label rules.
 */

/** Build the operator mark/unmark actions matching the pattern in app.tsx. */
function buildOperatorActions(opts: {
  hasCurrentWindow: boolean;
  currentRole?: string;
  onMark: () => void;
  onUnmark: () => void;
}): PaletteAction[] {
  if (!opts.hasCurrentWindow) return [];
  return opts.currentRole === "operator"
    ? [{ id: "window-unmark-operator", label: "Window: Unmark Operator", onSelect: opts.onUnmark }]
    : [{ id: "window-mark-operator", label: "Window: Mark as Operator", onSelect: opts.onMark }];
}

describe("CmdK Operator Role Actions", () => {
  afterEach(cleanup);

  it("shows Mark as Operator (not Unmark) when the current window is not the operator", () => {
    const actions = buildOperatorActions({
      hasCurrentWindow: true,
      currentRole: undefined,
      onMark: vi.fn(),
      onUnmark: vi.fn(),
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.getByText("Window: Mark as Operator")).toBeInTheDocument();
    expect(screen.queryByText("Window: Unmark Operator")).not.toBeInTheDocument();
  });

  it("shows Unmark Operator (not Mark) when the current window IS the operator", () => {
    const actions = buildOperatorActions({
      hasCurrentWindow: true,
      currentRole: "operator",
      onMark: vi.fn(),
      onUnmark: vi.fn(),
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.getByText("Window: Unmark Operator")).toBeInTheDocument();
    expect(screen.queryByText("Window: Mark as Operator")).not.toBeInTheDocument();
  });

  it("shows neither when there is no current window", () => {
    const actions = buildOperatorActions({
      hasCurrentWindow: false,
      onMark: vi.fn(),
      onUnmark: vi.fn(),
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.queryByText("Window: Mark as Operator")).not.toBeInTheDocument();
    expect(screen.queryByText("Window: Unmark Operator")).not.toBeInTheDocument();
  });

  it("Mark as Operator onSelect fires the mark seam", () => {
    const onMark = vi.fn();
    const actions = buildOperatorActions({
      hasCurrentWindow: true,
      onMark,
      onUnmark: vi.fn(),
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Mark as Operator" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onMark).toHaveBeenCalledOnce();
  });

  it("Unmark Operator onSelect fires the unmark seam", () => {
    const onUnmark = vi.fn();
    const actions = buildOperatorActions({
      hasCurrentWindow: true,
      currentRole: "operator",
      onMark: vi.fn(),
      onUnmark,
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Unmark Operator" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onUnmark).toHaveBeenCalledOnce();
  });
});

/**
 * Tests for the terminal-export palette gate (260820-4le0 R6) — `Terminal:
 * Download full history` is ABSENT (the availability idiom, not disabled) when
 * the current window's active pane is on the alternate screen, since tmux
 * holds no scrollback for a server capture there. The other three export
 * actions are unaffected.
 *
 * These mirror the action-generation pattern in app.tsx (the
 * buildSessionActions/buildOperatorActions precedent).
 */

/** Build the terminal-export palette entries matching app.tsx's gate. */
function buildTerminalExportActions(opts: {
  hasTtyTile: boolean;
  altScreen: boolean;
}): PaletteAction[] {
  if (!opts.hasTtyTile) return [];
  return (
    [
      ["terminal-export-snapshot", "Terminal: Download snapshot (HTML)", "snapshot"],
      ["terminal-export-transcript", "Terminal: Download transcript", "transcript"],
      ["terminal-export-copy", "Terminal: Copy visible screen", "copy-visible"],
      ...(opts.altScreen
        ? []
        : [["terminal-export-history", "Terminal: Download full history", "history"] as const]),
    ] as const
  ).map(([id, label, action]) => ({
    id,
    label,
    onSelect: () =>
      document.dispatchEvent(new CustomEvent("terminal-export", { detail: { action } })),
  }));
}

describe("CmdK Terminal Export Actions (altScreen gate)", () => {
  afterEach(cleanup);

  it("all four export entries appear on a normal-screen window", () => {
    const actions = buildTerminalExportActions({ hasTtyTile: true, altScreen: false });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.getByText("Terminal: Download snapshot (HTML)")).toBeInTheDocument();
    expect(screen.getByText("Terminal: Download transcript")).toBeInTheDocument();
    expect(screen.getByText("Terminal: Copy visible screen")).toBeInTheDocument();
    expect(screen.getByText("Terminal: Download full history")).toBeInTheDocument();
  });

  it("Download full history is absent on an altScreen window; the other three remain", () => {
    const actions = buildTerminalExportActions({ hasTtyTile: true, altScreen: true });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.queryByText("Terminal: Download full history")).not.toBeInTheDocument();
    expect(screen.getByText("Terminal: Download snapshot (HTML)")).toBeInTheDocument();
    expect(screen.getByText("Terminal: Download transcript")).toBeInTheDocument();
    expect(screen.getByText("Terminal: Copy visible screen")).toBeInTheDocument();
  });

  it("no export entries when the layout has no tty tile", () => {
    const actions = buildTerminalExportActions({ hasTtyTile: false, altScreen: false });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.queryByText(/^Terminal: Download/)).not.toBeInTheDocument();
    expect(screen.queryByText("Terminal: Copy visible screen")).not.toBeInTheDocument();
  });
});

/**
 * Tests for the Fix tab name palette entry (260822-fih1 R10) — `Tab: Fix name
 * (ask operator)` is ABSENT (omit-not-disable) unless the same three-part
 * availability rule as the flyout row holds: an operator window on the server,
 * the current window carrying an agent session ref, and the current window not
 * being the operator itself. Mirrors the action-generation pattern in app.tsx
 * (the buildOperatorActions precedent).
 */

/** Build the Fix tab name palette entry matching app.tsx's gate. */
function buildFixTabNameActions(opts: {
  hasOperator: boolean;
  conversationAvailable?: boolean;
  currentRole?: string;
  onFix: () => void;
}): PaletteAction[] {
  if (!opts.hasOperator || !opts.conversationAvailable || opts.currentRole === "operator") return [];
  return [{ id: "window-fix-name-operator", label: "Tab: Fix name (ask operator)", onSelect: opts.onFix }];
}

describe("CmdK Fix Tab Name Action (operator-request gate)", () => {
  afterEach(cleanup);

  it("is listed when the rule holds and selecting it fires the fix seam", () => {
    const onFix = vi.fn();
    const actions = buildFixTabNameActions({ hasOperator: true, conversationAvailable: true, onFix });

    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Fix name" } });
    expect(screen.getByText("Tab: Fix name (ask operator)")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onFix).toHaveBeenCalledOnce();
  });

  it("is absent without an operator on the server", () => {
    const actions = buildFixTabNameActions({ hasOperator: false, conversationAvailable: true, onFix: vi.fn() });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.queryByText("Tab: Fix name (ask operator)")).not.toBeInTheDocument();
  });

  it("is absent when the current window has no conversation capability", () => {
    const actions = buildFixTabNameActions({ hasOperator: true, onFix: vi.fn() });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.queryByText("Tab: Fix name (ask operator)")).not.toBeInTheDocument();
  });

  it("is absent on the operator's own window", () => {
    const actions = buildFixTabNameActions({
      hasOperator: true,
      conversationAvailable: true,
      currentRole: "operator",
      onFix: vi.fn(),
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.queryByText("Tab: Fix name (ask operator)")).not.toBeInTheDocument();
  });
});

/**
 * Tests for the Operator compose palette entries (260822-wyn3 R6) —
 * `Operator: Spawn task…` / `Operator: Find discussion…` are present only when
 * the server has an operator window (omit-not-disable, the
 * `buildFixTabNameActions` precedent), each opening the shared compose dialog
 * with its mode pre-selected.
 */

/** Build the operator compose palette entries matching app.tsx's gate. */
function buildOperatorComposeActions(opts: {
  hasOperator: boolean;
  onOpen: (mode: "spawn" | "find") => void;
}): PaletteAction[] {
  if (!opts.hasOperator) return [];
  return [
    { id: "operator-spawn-task", label: "Operator: Spawn task…", onSelect: () => opts.onOpen("spawn") },
    { id: "operator-find-discussion", label: "Operator: Find discussion…", onSelect: () => opts.onOpen("find") },
  ];
}

describe("CmdK Operator Compose Actions (hasOperatorWindow gate)", () => {
  afterEach(cleanup);

  it("both entries are listed with an operator, each pre-selecting its mode", () => {
    const onOpen = vi.fn();
    const actions = buildOperatorComposeActions({ hasOperator: true, onOpen });

    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Operator:" } });
    expect(screen.getByText("Operator: Spawn task…")).toBeInTheDocument();
    expect(screen.getByText("Operator: Find discussion…")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Operator: Spawn task…"));
    expect(onOpen).toHaveBeenCalledWith("spawn");

    openPalette();
    fireEvent.change(screen.getByPlaceholderText(/^Type a command/), { target: { value: "Operator:" } });
    fireEvent.click(screen.getByText("Operator: Find discussion…"));
    expect(onOpen).toHaveBeenCalledWith("find");
  });

  it("neither entry is listed without an operator on the server", () => {
    const actions = buildOperatorComposeActions({ hasOperator: false, onOpen: vi.fn() });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.queryByText("Operator: Spawn task…")).not.toBeInTheDocument();
    expect(screen.queryByText("Operator: Find discussion…")).not.toBeInTheDocument();
  });
});

/**
 * Tests for the Operator digest/triage/labeling palette entries (260822-rfz2
 * R6) — `Operator: Brief me` / `Operator: What's stuck` / `Operator: Color
 * tabs` ride the same hasOperatorWindow omit-not-disable gate as the compose
 * entries and fire directly (no dialog). Mirrors the action-generation pattern
 * in app.tsx.
 */

/** Build the server-scoped digest/triage/labeling palette entries matching app.tsx's gate. */
function buildOperatorDigestActions(opts: {
  hasOperator: boolean;
  onFire: (template: string) => void;
}): PaletteAction[] {
  if (!opts.hasOperator) return [];
  return [
    { id: "operator-brief-me", label: "Operator: Brief me", onSelect: () => opts.onFire("brief-me") },
    { id: "operator-whats-stuck", label: "Operator: What's stuck", onSelect: () => opts.onFire("whats-stuck") },
    { id: "operator-color-tabs", label: "Operator: Color tabs", onSelect: () => opts.onFire("color-tabs") },
    { id: "operator-update-annotations", label: "Operator: Update annotations", onSelect: () => opts.onFire("update-annotations") },
  ];
}

describe("CmdK Operator Digest Actions (hasOperatorWindow gate)", () => {
  afterEach(cleanup);

  it("all entries are listed with an operator, each firing its template directly", () => {
    const onFire = vi.fn();
    const actions = buildOperatorDigestActions({ hasOperator: true, onFire });

    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Operator:" } });
    expect(screen.getByText("Operator: Brief me")).toBeInTheDocument();
    expect(screen.getByText("Operator: What's stuck")).toBeInTheDocument();
    expect(screen.getByText("Operator: Color tabs")).toBeInTheDocument();
    expect(screen.getByText("Operator: Update annotations")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Operator: Brief me"));
    expect(onFire).toHaveBeenCalledWith("brief-me");

    openPalette();
    fireEvent.change(screen.getByPlaceholderText(/^Type a command/), { target: { value: "Operator:" } });
    fireEvent.click(screen.getByText("Operator: What's stuck"));
    expect(onFire).toHaveBeenCalledWith("whats-stuck");

    openPalette();
    fireEvent.change(screen.getByPlaceholderText(/^Type a command/), { target: { value: "Operator:" } });
    fireEvent.click(screen.getByText("Operator: Color tabs"));
    expect(onFire).toHaveBeenCalledWith("color-tabs");

    openPalette();
    fireEvent.change(screen.getByPlaceholderText(/^Type a command/), { target: { value: "Operator:" } });
    fireEvent.click(screen.getByText("Operator: Update annotations"));
    expect(onFire).toHaveBeenCalledWith("update-annotations");
  });

  it("no entry is listed without an operator on the server", () => {
    const actions = buildOperatorDigestActions({ hasOperator: false, onFire: vi.fn() });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.queryByText("Operator: Brief me")).not.toBeInTheDocument();
    expect(screen.queryByText("Operator: What's stuck")).not.toBeInTheDocument();
    expect(screen.queryByText("Operator: Color tabs")).not.toBeInTheDocument();
    expect(screen.queryByText("Operator: Update annotations")).not.toBeInTheDocument();
  });
});

/**
 * Tests for the Set note palette entry (260824-bb5n R5) — `Window: Set note…`
 * is registered for the current window on the terminal route (Constitution V),
 * opening the note prompt pre-filled with the current note; an empty submit
 * clears it. Mirrors the action-generation pattern in app.tsx.
 */

/** Build the Set note palette entry matching app.tsx's wiring. */
function buildSetNoteActions(opts: {
  currentNote?: string;
  onOpen: (prefill: string) => void;
}): PaletteAction[] {
  return [
    {
      id: "window-set-note",
      label: "Window: Set note…",
      onSelect: () => opts.onOpen(opts.currentNote ?? ""),
    },
  ];
}

describe("CmdK Set Note Action (260824-bb5n)", () => {
  afterEach(cleanup);

  it("is listed and selecting it opens the prompt pre-filled with the current note", () => {
    const onOpen = vi.fn();
    const actions = buildSetNoteActions({ currentNote: "blocked on flaky e2e", onOpen });

    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Set note" } });
    expect(screen.getByText("Window: Set note…")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("blocked on flaky e2e");
  });

  it("opens with an empty prefill when the window carries no note", () => {
    const onOpen = vi.fn();
    const actions = buildSetNoteActions({ onOpen });

    render(<CommandPalette actions={actions} />);
    openPalette();

    fireEvent.change(screen.getByPlaceholderText(/^Type a command/), { target: { value: "Set note" } });
    fireEvent.keyDown(screen.getByPlaceholderText(/^Type a command/), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("");
  });
});

/**
 * Tests for the Annotate tab palette entry (260824-bb5n R6) — `Operator:
 * Annotate tab` is gated by the SAME three-part availability rule as fix-name
 * (operator on the server, agent session ref on the current window, not the
 * operator's own window) and fires the annotate-tab operator-request template. Mirrors
 * the buildFixTabNameActions precedent.
 */

/** Build the Annotate tab palette entry matching app.tsx's gate. */
function buildAnnotateTabActions(opts: {
  hasOperator: boolean;
  conversationAvailable?: boolean;
  currentRole?: string;
  onAnnotate: () => void;
}): PaletteAction[] {
  if (!opts.hasOperator || !opts.conversationAvailable || opts.currentRole === "operator") return [];
  return [{ id: "window-annotate-operator", label: "Operator: Annotate tab", onSelect: opts.onAnnotate }];
}

describe("CmdK Annotate Tab Action (operator-request gate)", () => {
  afterEach(cleanup);

  it("is listed when the rule holds and selecting it fires the annotate seam", () => {
    const onAnnotate = vi.fn();
    const actions = buildAnnotateTabActions({ hasOperator: true, conversationAvailable: true, onAnnotate });

    render(<CommandPalette actions={actions} />);
    openPalette();

    const input = screen.getByPlaceholderText(/^Type a command/);
    fireEvent.change(input, { target: { value: "Annotate" } });
    expect(screen.getByText("Operator: Annotate tab")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAnnotate).toHaveBeenCalledOnce();
  });

  it("is absent without an operator on the server", () => {
    const actions = buildAnnotateTabActions({ hasOperator: false, conversationAvailable: true, onAnnotate: vi.fn() });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.queryByText("Operator: Annotate tab")).not.toBeInTheDocument();
  });

  it("is absent when the current window carries no agent session ref", () => {
    const actions = buildAnnotateTabActions({ hasOperator: true, onAnnotate: vi.fn() });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.queryByText("Operator: Annotate tab")).not.toBeInTheDocument();
  });

  it("is absent on the operator's own window", () => {
    const actions = buildAnnotateTabActions({
      hasOperator: true,
      conversationAvailable: true,
      currentRole: "operator",
      onAnnotate: vi.fn(),
    });

    render(<CommandPalette actions={actions} />);
    openPalette();

    expect(screen.queryByText("Operator: Annotate tab")).not.toBeInTheDocument();
  });
});

describe("operator page — the operator window's route wears the quake surface on desktop", () => {
  // The form-factor-neutral gate: `operatorPage` drops the old mobile-only
  // term, so a DESKTOP operator route mounts the segment strip, swaps the
  // body on `?tab=`, and force-mounts the footer-docked compose strip; a
  // non-operator route stays byte-identical. The SurfaceLayout child is the
  // mount-spying stub above; the strip/compose/swap assertions read the DOM
  // around it.
  stubMatchMedia(() => false);

  function OperatorRouteRoot() {
    return (
      <ThemeProvider>
        <ToastProvider>
          <InstanceNameProvider>
            <ChromeProvider>
              <ZenProvider>
                <FocusedTerminalProvider>
                  <OptimisticProvider>
                    <TopBarSlotProvider>
                      <FocusedPaneProvider>
                        <ServerDialogsProvider>
                          <PaletteActionsProvider globalActions={[]}>
                            <GuiOffRequestProvider value={undefined}>
                              <MetricsProvider value={null}>
                                <HostMetricsProvider value={null}>
                                  <StandaloneSessionContextProvider
                                value={{
                                  currentServer: null,
                                  servers: [{ name: "srv", sessionCount: 1 }] as ServerInfo[],
                                  serversLoaded: true,
                                  sessionsByServer: new Map([
                                    [
                                      "srv",
                                      [
                                        makeSession({
                                          name: "alpha",
                                          windows: [
                                            makeWindow({
                                              windowId: "@0",
                                              index: 0,
                                              isActiveWindow: true,
                                            }),
                                          ],
                                        }),
                                        makeSession({
                                          name: "_rk-operator",
                                          hidden: true,
                                          windows: [
                                            makeWindow({
                                              windowId: "@9",
                                              index: 0,
                                              name: "operator",
                                              role: "operator",
                                              isActiveWindow: true,
                                            }),
                                          ],
                                        }),
                                      ],
                                    ],
                                  ]),
                                  isConnectedByServer: new Map([["srv", true]]),
                                }}
                              >
                                <Outlet />
                                  </StandaloneSessionContextProvider>
                                </HostMetricsProvider>
                              </MetricsProvider>
                            </GuiOffRequestProvider>
                          </PaletteActionsProvider>
                        </ServerDialogsProvider>
                      </FocusedPaneProvider>
                    </TopBarSlotProvider>
                  </OptimisticProvider>
                </FocusedTerminalProvider>
              </ZenProvider>
            </ChromeProvider>
          </InstanceNameProvider>
        </ToastProvider>
      </ThemeProvider>
    );
  }

  const opRootRoute = createRootRoute({ component: OperatorRouteRoot });
  const opServerRoute = createRoute({
    getParentRoute: () => opRootRoute,
    path: "/$server",
    component: ServerShell,
  });
  const opServerIndexRoute = createRoute({
    getParentRoute: () => opServerRoute,
    path: "/",
  });
  const opTerminalRoute = createRoute({
    getParentRoute: () => opServerRoute,
    path: "/$window",
    validateSearch: validateTerminalSearch,
    params: {
      parse: (params) => ({ window: urlSegmentToWindowId(params.window) }),
      stringify: (params) => ({ window: windowIdToUrlSegment(params.window) }),
    },
  });
  const opRouteTree = opRootRoute.addChildren([
    opServerRoute.addChildren([opServerIndexRoute, opTerminalRoute]),
  ]);

  function renderAt(entries: string[]) {
    const router = createRouter({
      routeTree: opRouteTree,
      history: createMemoryHistory({ initialEntries: entries }),
    });
    render(<RouterProvider router={router} />);
    return router;
  }

  afterEach(() => {
    cleanup();
    surfaceLayoutSpy.mounts.length = 0;
    surfaceLayoutSpy.props.mockClear();
    localStorage.clear();
  });

  it("the desktop operator route mounts the segment strip and the forced compose strip (preference off)", async () => {
    renderAt(["/srv/9"]);

    await waitFor(() => screen.getByTestId("mock-surface-layout"));
    expect(screen.getByTestId("terminal-activity-tabs")).toBeInTheDocument();
    // The strip is the page's input by definition — the `hexokit-compose-strip`
    // preference (absent here) does not gate it on the operator page.
    expect(localStorage.getItem("hexokit-compose-strip")).toBeNull();
    expect(screen.getByTestId("compose-strip-input")).toBeInTheDocument();
  });

  it("?tab=tasks hides (never unmounts) the terminal column and mounts the tracked list", async () => {
    renderAt(["/srv/9?tab=tasks"]);

    await waitFor(() => screen.getByTestId("watched-tasks"));
    const column = screen.getByTestId("mock-surface-layout").parentElement!;
    expect(column.className).toContain("hidden");
    // Still mounted — the hide-never-unmount posture.
    expect(surfaceLayoutSpy.mounts).toEqual(["mount"]);
  });

  it("a cold desktop ?tab= arrival dispatches no quake-terminal seam event (the handoff is gone)", async () => {
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push(e);
    document.addEventListener("rk:quake-terminal", listener);
    try {
      renderAt(["/srv/9?tab=list"]);
      await waitFor(() => screen.getByTestId("mock-surface-layout"));
      // The param is retained — it IS the page's segment state now.
      expect(screen.getByTestId("terminal-activity-tabs")).toBeInTheDocument();
      expect(seen).toHaveLength(0);
    } finally {
      document.removeEventListener("rk:quake-terminal", listener);
    }
  });

  it("a desktop non-operator route renders neither strip nor forced compose", async () => {
    renderAt(["/srv/0"]);

    await waitFor(() => screen.getByTestId("mock-surface-layout"));
    expect(screen.queryByTestId("terminal-activity-tabs")).toBeNull();
    expect(screen.queryByTestId("compose-strip-input")).toBeNull();
  });
});

describe("terminal route grid key — SurfaceLayout keyed by server", () => {
  // The terminal route's tile grid mounts ONCE per server: a same-server
  // window switch re-renders the mounted grid with the new windowId prop (the
  // tty tile's terminal rides its session connection), and only a SERVER
  // change remounts. The child is the mount-spying stub above; the assertions
  // read its mount/unmount record and the windowId prop stream.
  stubMatchMedia(() => false);

  // Zen is transient provider state (no storage seam), so the harness exposes
  // its dispatch through a probe child — the status-bar gate tests flip zen
  // the way the chord/palette body would, without driving keybindings.
  const zenDispatchRef: { current: ((active: boolean) => void) | null } = { current: null };
  function ZenProbe() {
    const { setZenActive } = useZenDispatch();
    zenDispatchRef.current = setZenActive;
    return null;
  }

  // The registered top-bar slot, mirrored per render — the popped-toggle
  // wiring test drives `surfaceToggles.onToggle` (AppShell's `togglePanel`
  // seam) and reads the open/popped derivations without mounting a TopBar.
  const topBarSlotRef: { current: ReturnType<typeof useTopBarSlot> } = { current: null };
  function TopBarSlotProbe() {
    topBarSlotRef.current = useTopBarSlot();
    return null;
  }

  // Per-test overlay on the harness's session context (reset in afterEach) —
  // the popout-posture tests model a server whose slice exists before its
  // first real snapshot.
  let sessionCtxOverride: Partial<import("@/contexts/session-context").SessionContextType> = {};

  function TerminalRouteRoot() {
    return (
      <ThemeProvider>
        <ToastProvider>
          <InstanceNameProvider>
            <ChromeProvider>
              <ZenProvider>
                <ZenProbe />
                <FocusedTerminalProvider>
                  <OptimisticProvider>
                    <TopBarSlotProvider>
                      <TopBarSlotProbe />
                      <FocusedPaneProvider>
                        <ServerDialogsProvider>
                          <PaletteActionsProvider globalActions={[]}>
                            <GuiOffRequestProvider value={undefined}>
                              <MetricsProvider value={null}>
                                <HostMetricsProvider value={null}>
                                  <StandaloneSessionContextProvider
                                value={{
                                  // `currentServer: null` so AppShell falls
                                  // back to the URL param per route.
                                  currentServer: null,
                                  servers: [
                                    { name: "srv", sessionCount: 1 },
                                    { name: "other", sessionCount: 1 },
                                  ] as ServerInfo[],
                                  serversLoaded: true,
                                  sessionsByServer: new Map([
                                    [
                                      "srv",
                                      [
                                        makeSession({
                                          name: "alpha",
                                          windows: [
                                            makeWindow({
                                              windowId: "@0",
                                              index: 0,
                                              isActiveWindow: true,
                                              layout: "h(tty,web)",
                                            }),
                                            makeWindow({
                                              windowId: "@1",
                                              index: 1,
                                              layout: "h(tty,web)",
                                            }),
                                            makeWindow({
                                              windowId: "@2",
                                              index: 2,
                                              codeRoot: "/home/user/code/run-kit",
                                              layout: "h(tty,code)",
                                            }),
                                          ],
                                        }),
                                      ],
                                    ],
                                    [
                                      "other",
                                      [
                                        makeSession({
                                          name: "beta",
                                          windows: [
                                            makeWindow({
                                              windowId: "@1",
                                              index: 0,
                                              isActiveWindow: true,
                                            }),
                                          ],
                                        }),
                                      ],
                                    ],
                                  ]),
                                  isConnectedByServer: new Map([
                                    ["srv", true],
                                    ["other", true],
                                  ]),
                                  ...sessionCtxOverride,
                                }}
                              >
                                <Outlet />
                                  </StandaloneSessionContextProvider>
                                </HostMetricsProvider>
                              </MetricsProvider>
                            </GuiOffRequestProvider>
                          </PaletteActionsProvider>
                        </ServerDialogsProvider>
                      </FocusedPaneProvider>
                    </TopBarSlotProvider>
                  </OptimisticProvider>
                </FocusedTerminalProvider>
              </ZenProvider>
            </ChromeProvider>
          </InstanceNameProvider>
        </ToastProvider>
      </ThemeProvider>
    );
  }

  const testRootRoute = createRootRoute({ component: TerminalRouteRoot });
  const testServerRoute = createRoute({
    getParentRoute: () => testRootRoute,
    path: "/$server",
    component: ServerShell,
  });
  const testServerIndexRoute = createRoute({
    getParentRoute: () => testServerRoute,
    path: "/",
  });
  const testTerminalRoute = createRoute({
    getParentRoute: () => testServerRoute,
    path: "/$window",
    validateSearch: validateTerminalSearch,
    params: {
      parse: (params) => ({ window: urlSegmentToWindowId(params.window) }),
      stringify: (params) => ({ window: windowIdToUrlSegment(params.window) }),
    },
  });
  const testRouteTree = testRootRoute.addChildren([
    testServerRoute.addChildren([testServerIndexRoute, testTerminalRoute]),
  ]);

  afterEach(() => {
    cleanup();
    surfaceLayoutSpy.mounts.length = 0;
    surfaceLayoutSpy.props.mockClear();
    sessionCtxOverride = {};
  });

  it("a same-server window switch does NOT remount the grid; a server change does", async () => {
    const router = createRouter({
      routeTree: testRouteTree,
      history: createMemoryHistory({ initialEntries: ["/srv/0"] }),
    });
    render(<RouterProvider router={router} />);

    await waitFor(() => screen.getByTestId("mock-surface-layout"));
    expect(surfaceLayoutSpy.mounts).toEqual(["mount"]);
    expect(surfaceLayoutSpy.props).toHaveBeenLastCalledWith({
      server: "srv",
      windowId: "@0",
    });

    // Same-server switch @0 → @1: the grid re-renders with the new windowId
    // prop and stays mounted.
    await act(async () => {
      await router.navigate({
        to: "/$server/$window",
        params: { server: "srv", window: "@1" },
        search: {},
      });
    });
    await waitFor(() =>
      expect(surfaceLayoutSpy.props).toHaveBeenLastCalledWith({
        server: "srv",
        windowId: "@1",
      }),
    );
    expect(surfaceLayoutSpy.mounts).toEqual(["mount"]);

    // Cross-server switch: the key changes, so the grid remounts.
    await act(async () => {
      await router.navigate({
        to: "/$server/$window",
        params: { server: "other", window: "@1" },
        search: {},
      });
    });
    await waitFor(() =>
      expect(surfaceLayoutSpy.props).toHaveBeenLastCalledWith({
        server: "other",
        windowId: "@1",
      }),
    );
    expect(surfaceLayoutSpy.mounts).toEqual(["mount", "unmount", "mount"]);
  });

  it("the focused-tile mirror survives mount AND a same-server window switch — the palette's directional swap targets the REPORTED leaf", async () => {
    // The child reports its focused leaf stamped with the window key; the
    // mirror counts the report only for that window (a clearing effect would
    // wipe the child's fresh report — parent effects run after child
    // effects). The stub reports the LAST leaf (web in h(tty,web)); the
    // slot-A fallback would be tty, whose only swap row is "Tile: Swap Right"
    // — "Tile: Swap Left" exists only while web's report holds.
    // The palette mounts in AppLayout (ServerShell's parent layout route), so
    // this test's tree interposes it — the rest of the harness is unchanged.
    // AppLayout also reads the instance accent (the wash-wrapper harness's
    // provider).
    const noAccent: InstanceAccent = {
      color: null,
      isExplicit: false,
      stripeHex: null,
      washHex: null,
      titlebarHex: null,
      setColor: () => {},
    };
    const paletteRootRoute = createRootRoute({
      component: () => (
        <InstanceAccentValueProvider value={noAccent}>
          <TerminalRouteRoot />
        </InstanceAccentValueProvider>
      ),
    });
    const appLayoutRoute = createRoute({
      getParentRoute: () => paletteRootRoute,
      id: "app-layout",
      component: AppLayout,
    });
    const paletteServerRoute = createRoute({
      getParentRoute: () => appLayoutRoute,
      path: "/$server",
      component: ServerShell,
    });
    const paletteTerminalRoute = createRoute({
      getParentRoute: () => paletteServerRoute,
      path: "/$window",
      validateSearch: validateTerminalSearch,
      params: {
        parse: (params) => ({ window: urlSegmentToWindowId(params.window) }),
        stringify: (params) => ({ window: windowIdToUrlSegment(params.window) }),
      },
    });
    const paletteRouteTree = paletteRootRoute.addChildren([
      appLayoutRoute.addChildren([paletteServerRoute.addChildren([paletteTerminalRoute])]),
    ]);
    const router = createRouter({
      routeTree: paletteRouteTree,
      history: createMemoryHistory({ initialEntries: ["/srv/0"] }),
    });
    render(<RouterProvider router={router} />);
    await waitFor(() => screen.getByTestId("mock-surface-layout"));

    // The palette is lazy-mounted — press the chord until its input appears
    // (an early press can precede the listener's mount).
    const openAppPalette = async () => {
      await waitFor(
        () => {
          if (!screen.queryByPlaceholderText(/^Type a command/)) openPalette();
          expect(screen.queryByPlaceholderText(/^Type a command/)).toBeTruthy();
        },
        { timeout: 5000 },
      );
    };

    await openAppPalette();
    await waitFor(() => screen.getByRole("option", { name: /^Tile: Swap Left/ }));
    expect(screen.queryByRole("option", { name: /^Tile: Swap Right/ })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });

    // Same-server switch @0 → @1: the child's fresh report for the new
    // window must hold (its key stamp matches), so the rows still target web.
    await act(async () => {
      await router.navigate({
        to: "/$server/$window",
        params: { server: "srv", window: "@1" },
        search: {},
      });
    });
    await waitFor(() =>
      expect(surfaceLayoutSpy.props).toHaveBeenLastCalledWith({
        server: "srv",
        windowId: "@1",
      }),
    );
    await openAppPalette();
    await waitFor(() => screen.getByRole("option", { name: /^Tile: Swap Left/ }));
    expect(screen.queryByRole("option", { name: /^Tile: Swap Right/ })).toBeNull();
  });

  describe("status bar window cluster yields to an on-screen PANE panel", () => {
    // The register view has one desktop home at a time: the bar's window
    // cluster (`status-bar-window`) renders iff the PANE panel is NOT on
    // screen — section toggled on AND the panel expanded AND sidebar open
    // (zen off). The host cluster renders in every state. The three inputs
    // are localStorage-backed booleans, seeded here before render and flipped
    // at runtime through the rail's real toggle and the panel's own header
    // chevron.
    afterEach(() => {
      localStorage.clear();
    });

    async function renderTerminalRoute() {
      const router = createRouter({
        routeTree: testRouteTree,
        history: createMemoryHistory({ initialEntries: ["/srv/0"] }),
      });
      render(<RouterProvider router={router} />);
      await waitFor(() => screen.getByTestId("status-bar-host"));
    }

    it("renders the window cluster by default (PANE section off)", async () => {
      await renderTerminalRoute();
      expect(screen.getByTestId("status-bar-window")).toBeInTheDocument();
      expect(screen.getByTestId("status-bar-host")).toBeInTheDocument();
    });

    it("yields the window cluster while the PANE section is on and the sidebar open; the host cluster stays", async () => {
      localStorage.setItem("hexokit-sidebar-section-pane", "true");
      await renderTerminalRoute();
      expect(screen.queryByTestId("status-bar-window")).toBeNull();
      expect(screen.getByTestId("status-bar-host")).toBeInTheDocument();
    });

    it("keeps the window cluster when the PANE section is on but the sidebar is collapsed", async () => {
      localStorage.setItem("hexokit-sidebar-section-pane", "true");
      localStorage.setItem("hexokit-sidebar-open", "false");
      await renderTerminalRoute();
      expect(screen.getByTestId("status-bar-window")).toBeInTheDocument();
    });

    it("keeps the window cluster when the PANE section is on but the panel is collapsed", async () => {
      // A collapsed panel header shows no registers, so the panel is not "on
      // screen" — the bar must keep the cluster exactly as when the section
      // is off. Seeds the panel's own persisted open state.
      localStorage.setItem("hexokit-sidebar-section-pane", "true");
      localStorage.setItem("hexokit-panel-window", "false");
      await renderTerminalRoute();
      expect(screen.getByTestId("status-bar-window")).toBeInTheDocument();
      expect(screen.getByTestId("status-bar-host")).toBeInTheDocument();
    });

    it("flips live with the PANE header chevron — collapse hands the cluster back, expand yields it", async () => {
      localStorage.setItem("hexokit-sidebar-section-pane", "true");
      await renderTerminalRoute();
      expect(screen.queryByTestId("status-bar-window")).toBeNull();
      const header = screen.getByRole("button", { name: /^Pane/ });
      expect(header).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(header);
      await waitFor(() => expect(screen.getByTestId("status-bar-window")).toBeInTheDocument());
      expect(header).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(header);
      await waitFor(() => expect(screen.queryByTestId("status-bar-window")).toBeNull());
      // The grid never remounted across the flips.
      expect(surfaceLayoutSpy.mounts).toEqual(["mount"]);
    });

    it("flips live with the rail toggle — no remount", async () => {
      await renderTerminalRoute();
      expect(screen.getByTestId("status-bar-window")).toBeInTheDocument();
      const toggle = screen.getByRole("button", { name: "Toggle Pane section" });
      fireEvent.click(toggle);
      await waitFor(() => expect(screen.queryByTestId("status-bar-window")).toBeNull());
      fireEvent.click(toggle);
      await waitFor(() => expect(screen.getByTestId("status-bar-window")).toBeInTheDocument());
      // The grid never remounted across the flips.
      expect(surfaceLayoutSpy.mounts).toEqual(["mount"]);
    });

    it("zen hands the registers back to the bar while the PANE section stays on", async () => {
      // Zen hides the sidebar without touching the section preference, so the
      // panel is off screen: the bar must show the cluster (host cluster too)
      // or zen would be the one desktop state with no register view.
      localStorage.setItem("hexokit-sidebar-section-pane", "true");
      await renderTerminalRoute();
      expect(screen.queryByTestId("status-bar-window")).toBeNull();
      act(() => zenDispatchRef.current?.(true));
      await waitFor(() => expect(screen.getByTestId("status-bar-window")).toBeInTheDocument());
      expect(screen.getByTestId("status-bar-host")).toBeInTheDocument();
      expect(localStorage.getItem("hexokit-sidebar-section-pane")).toBe("true");
      act(() => zenDispatchRef.current?.(false));
      await waitFor(() => expect(screen.queryByTestId("status-bar-window")).toBeNull());
    });
  });

  describe("popout posture — waits for the server's first real sessions snapshot", () => {
    const EMPTY_SRV = new Map([["srv", []], ["other", []]]);

    it("holds the popout posture on a seeded slice with no snapshot yet (no shared-layout tty mount)", async () => {
      sessionCtxOverride = {
        sessionsByServer: EMPTY_SRV,
        sessionsReceivedByServer: new Map([["srv", false]]),
      };
      const router = createRouter({
        routeTree: testRouteTree,
        history: createMemoryHistory({ initialEntries: ["/srv/0?pop=web"] }),
      });
      render(<RouterProvider router={router} />);
      await waitFor(() => screen.getByTestId("mock-surface-layout"));
      expect(screen.getByTestId("mock-surface-layout").dataset.leaves).toBe("web");
    });

    it("degrades to the ordinary render once a snapshot arrived without the popped window", async () => {
      sessionCtxOverride = {
        sessionsByServer: EMPTY_SRV,
        sessionsReceivedByServer: new Map([["srv", true]]),
      };
      const router = createRouter({
        routeTree: testRouteTree,
        history: createMemoryHistory({ initialEntries: ["/srv/0?pop=web"] }),
      });
      render(<RouterProvider router={router} />);
      await waitFor(() => screen.getByTestId("mock-surface-layout"));
      expect(screen.getByTestId("mock-surface-layout").dataset.leaves).not.toBe("web");
    });
  });

  describe("popped-toggle wiring — togglePanel guards the shared layout", () => {
    // Drives the registered top-bar slot's `onToggle` (AppShell's
    // `togglePanel`) against a viewer-popped leaf: the guard must flip the
    // leaf's revealed membership and NEVER write `@rk_win_layout`. The popped
    // mark is seeded in the viewer key (`rk-layout-popped:srv:@0`) — jsdom has
    // no BroadcastChannel, so the hook runs storage-only.
    afterEach(() => {
      localStorage.clear();
      apiSpies.setWindowOptions.mockClear();
    });

    const toggleSlot = () => {
      const toggles = topBarSlotRef.current?.surfaceToggles;
      if (!toggles || toggles.mode !== "toggle") {
        throw new Error("expected the desktop surface-toggle slot");
      }
      return toggles;
    };

    it("toggle on a popped close-target leaf reveals then hides the placeholder — no layout write; a non-popped kind still writes", async () => {
      localStorage.setItem("rk-layout-popped:srv:@0", JSON.stringify(["tty"]));
      const router = createRouter({
        routeTree: testRouteTree,
        history: createMemoryHistory({ initialEntries: ["/srv/0"] }),
      });
      render(<RouterProvider router={router} />);
      await waitFor(() => screen.getByTestId("mock-surface-layout"));
      await waitFor(() => toggleSlot());

      // Popped and unrevealed: the kind reads CLOSED in the toggle group, the
      // rendered tree is reduced (tty absent), and the popped predicate marks it.
      expect(toggleSlot().open).toEqual(["web"]);
      expect(toggleSlot().popped?.("tty")).toBe(true);
      expect(toggleSlot().popped?.("web")).toBe(false);
      expect(screen.getByTestId("mock-surface-layout").dataset.leaves).toBe("web");
      apiSpies.setWindowOptions.mockClear();

      // Toggle → reveal: no `@rk_win_layout` write; the leaf returns to the
      // rendered tree carrying its revealed mark, and the kind reads open.
      act(() => toggleSlot().onToggle("tty"));
      expect(apiSpies.setWindowOptions).not.toHaveBeenCalled();
      expect(screen.getByTestId("mock-surface-layout").dataset.leaves).toBe("tty,web");
      expect(screen.getByTestId("mock-surface-layout").dataset.revealed).toBe("tty");
      expect(toggleSlot().open).toEqual(["tty", "web"]);

      // Toggle → hide: still no write, back to the reduced render.
      act(() => toggleSlot().onToggle("tty"));
      expect(apiSpies.setWindowOptions).not.toHaveBeenCalled();
      expect(screen.getByTestId("mock-surface-layout").dataset.leaves).toBe("web");
      expect(screen.getByTestId("mock-surface-layout").dataset.revealed).toBe("");
      expect(toggleSlot().open).toEqual(["web"]);

      // A non-popped kind keeps the shared toggle semantics: the close writes
      // `@rk_win_layout`.
      act(() => toggleSlot().onToggle("web"));
      expect(apiSpies.setWindowOptions).toHaveBeenCalledWith("srv", "@0", {
        "@rk_win_layout": "tty",
      });
    });
  });

  describe("focus-hop reveals a popped code tile", () => {
    // ⌃`/⇧Ctrl+` judges code's visibility against the RENDERED tree: a popped,
    // unrevealed code leaf is absent from it, so the chord routes through
    // `togglePanel`'s popped guard (reveal — no layout write) instead of
    // dead-ending on the focus seam. The chord fires through the real
    // keybinding dispatch (jsdom resolves the non-mac shifted tier,
    // ⇧Ctrl+Backquote); window @2 carries the code-capable h(tty,code)
    // layout, with the code leaf marked popped for this viewer.
    afterEach(() => {
      localStorage.clear();
      apiSpies.setWindowOptions.mockClear();
    });

    it("focus-hop on a popped, unrevealed code leaf reveals its placeholder — no layout write", async () => {
      localStorage.setItem("rk-layout-popped:srv:@2", JSON.stringify(["code"]));
      const router = createRouter({
        routeTree: testRouteTree,
        history: createMemoryHistory({ initialEntries: ["/srv/2"] }),
      });
      render(<RouterProvider router={router} />);
      await waitFor(() => screen.getByTestId("mock-surface-layout"));

      // Popped and unrevealed: the rendered tree is reduced (code absent).
      await waitFor(() =>
        expect(screen.getByTestId("mock-surface-layout").dataset.leaves).toBe("tty"),
      );
      expect(screen.getByTestId("mock-surface-layout").dataset.revealed).toBe("");
      apiSpies.setWindowOptions.mockClear();

      // The chord reveals the placeholder: code returns to the rendered tree
      // carrying its revealed mark, and `@rk_win_layout` is never written.
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            code: "Backquote",
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await waitFor(() =>
        expect(screen.getByTestId("mock-surface-layout").dataset.leaves).toBe("tty,code"),
      );
      expect(screen.getByTestId("mock-surface-layout").dataset.revealed).toBe("code");
      expect(apiSpies.setWindowOptions).not.toHaveBeenCalled();
    });
  });
});

describe("top-bar wash wrapper — chrome paint + inline wash precedence", () => {
  // The wrapper div (AppLayout) carries BOTH the bar's surface class and the
  // inline accent wash, so the wash overrides the class when an accent is set
  // and the chrome shows when it is not. Asserted on the real AppLayout render
  // (a host route is enough — the wrapper is route-agnostic).
  stubMatchMedia(() => false);

  const noAccent: InstanceAccent = {
    color: null,
    isExplicit: false,
    stripeHex: null,
    washHex: null,
    titlebarHex: null,
    setColor: () => {},
  };

  function WrapperRouteRoot({ accent }: { accent: InstanceAccent }) {
    return (
      <ThemeProvider>
        <ToastProvider>
          <InstanceAccentValueProvider value={accent}>
            <InstanceNameProvider>
              <ChromeProvider>
                <ZenProvider>
                  <FocusedTerminalProvider>
                    <OptimisticProvider>
                      <TopBarSlotProvider>
                        <FocusedPaneProvider>
                          <MetricsProvider value={null}>
                            <HostMetricsProvider value={null}>
                              <StandaloneSessionContextProvider
                                value={{
                                  currentServer: null,
                                  servers: [],
                                  serversLoaded: true,
                                  sessionsByServer: new Map(),
                                  isConnectedByServer: new Map(),
                                }}
                              >
                                <Outlet />
                              </StandaloneSessionContextProvider>
                            </HostMetricsProvider>
                          </MetricsProvider>
                        </FocusedPaneProvider>
                      </TopBarSlotProvider>
                    </OptimisticProvider>
                  </FocusedTerminalProvider>
                </ZenProvider>
              </ChromeProvider>
            </InstanceNameProvider>
          </InstanceAccentValueProvider>
        </ToastProvider>
      </ThemeProvider>
    );
  }

  function renderLayout(accent: InstanceAccent) {
    const rootRoute = createRootRoute({
      component: () => <WrapperRouteRoot accent={accent} />,
    });
    const layoutRoute = createRoute({
      getParentRoute: () => rootRoute,
      id: "app",
      component: AppLayout,
    });
    const indexRoute = createRoute({
      getParentRoute: () => layoutRoute,
      path: "/",
      component: () => <div data-testid="leaf" />,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([layoutRoute.addChildren([indexRoute])]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={router} />);
  }

  /** The wrapper is the banner landmark's parent (TopBar renders its own
   *  `<header>`; the wrapper is the plain div above the content region). */
  async function washWrapper(): Promise<HTMLElement> {
    const banner = await screen.findByRole("banner");
    return banner.parentElement!;
  }

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("paints bg-bg-chrome with no inline background when no instance accent is set", async () => {
    renderLayout(noAccent);
    const wrapper = await washWrapper();
    expect(wrapper.className).toContain("bg-bg-chrome");
    expect(wrapper.style.backgroundColor).toBe("");
  });

  it("the inline washHex overrides the chrome class when an accent is set", async () => {
    renderLayout({ ...noAccent, color: "4", isExplicit: true, washHex: "#112233", stripeHex: "#334455", titlebarHex: "#223344" });
    const wrapper = await washWrapper();
    expect(wrapper.className).toContain("bg-bg-chrome");
    expect(wrapper.style.backgroundColor).toBe("rgb(17, 34, 51)");
  });
});

describe("absent-server route — the not-found fallback settles", () => {
  // Renders ServerShell (AppShell) on a route whose server is NOT in the
  // session context's server list (serversLoaded: true → the guard resolves
  // "not-found"). The loop contract: the fallback commits once and the tree
  // then STOPS re-rendering. The probe is a TopBarSlot consumer sibling —
  // the slot registration channel is the loop's closing edge (a per-render
  // unstable slot re-fires `setSlot`, which re-renders every consumer), so
  // its render count over an idle window is the observable property. An
  // unstable-identity regression drives the count unbounded; the fixed tree
  // settles at zero growth.
  stubMatchMedia(() => false);

  let probeRenders = 0;
  function SlotProbe() {
    useTopBarSlot();
    probeRenders++;
    return null;
  }

  function MissingServerRoot() {
    return (
      <ThemeProvider>
        <ToastProvider>
          <InstanceNameProvider>
            <ChromeProvider>
              <ZenProvider>
                <FocusedTerminalProvider>
                  <OptimisticProvider>
                    <TopBarSlotProvider>
                      <SlotProbe />
                      <FocusedPaneProvider>
                        <ServerDialogsProvider>
                          <PaletteActionsProvider globalActions={[]}>
                            <GuiOffRequestProvider value={undefined}>
                              <MetricsProvider value={null}>
                                <HostMetricsProvider value={null}>
                                  <StandaloneSessionContextProvider
                                    value={{
                                      currentServer: null,
                                      servers: [
                                        { name: "srv", sessionCount: 1 },
                                      ] as ServerInfo[],
                                      serversLoaded: true,
                                      sessionsByServer: new Map(),
                                      isConnectedByServer: new Map(),
                                    }}
                                  >
                                    <Outlet />
                                  </StandaloneSessionContextProvider>
                                </HostMetricsProvider>
                              </MetricsProvider>
                            </GuiOffRequestProvider>
                          </PaletteActionsProvider>
                        </ServerDialogsProvider>
                      </FocusedPaneProvider>
                    </TopBarSlotProvider>
                  </OptimisticProvider>
                </FocusedTerminalProvider>
              </ZenProvider>
            </ChromeProvider>
          </InstanceNameProvider>
        </ToastProvider>
      </ThemeProvider>
    );
  }

  const missingRootRoute = createRootRoute({ component: MissingServerRoot });
  const missingServerRoute = createRoute({
    getParentRoute: () => missingRootRoute,
    path: "/$server",
    component: ServerShell,
  });
  const missingServerIndexRoute = createRoute({
    getParentRoute: () => missingServerRoute,
    path: "/",
  });
  const missingTerminalRoute = createRoute({
    getParentRoute: () => missingServerRoute,
    path: "/$window",
    validateSearch: validateTerminalSearch,
    params: {
      parse: (params) => ({ window: urlSegmentToWindowId(params.window) }),
      stringify: (params) => ({ window: windowIdToUrlSegment(params.window) }),
    },
  });
  const missingRouteTree = missingRootRoute.addChildren([
    missingServerRoute.addChildren([missingServerIndexRoute, missingTerminalRoute]),
  ]);

  // Mount WITHOUT testing-library's act(): act drains React's work queue until
  // it is empty, so an unbounded registration loop (the regression this block
  // guards) would hang the test inside render() instead of failing it. A plain
  // createRoot mount lets the cascade run as scheduler macrotasks — as in the
  // browser — so the render-count assertion below fails fast. The
  // act-environment flag is restored in afterEach.
  const ACT_ENV_KEY = "IS_REACT_ACT_ENVIRONMENT";
  let mounted: { root: Root; container: HTMLElement }[] = [];
  let prevActEnv: unknown;

  beforeEach(() => {
    prevActEnv = Reflect.get(globalThis, ACT_ENV_KEY);
    Reflect.set(globalThis, ACT_ENV_KEY, false);
  });

  function renderMissing(entries: string[]): HTMLElement {
    const router = createRouter({
      routeTree: missingRouteTree,
      history: createMemoryHistory({ initialEntries: entries }),
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    root.render(<RouterProvider router={router} />);
    mounted.push({ root, container });
    return container;
  }

  /** Poll for rendered text with plain macrotasks (no act, no waitFor). */
  async function awaitText(container: HTMLElement, text: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (container.textContent?.includes(text)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for "${text}"`);
  }

  /** Let one settle turn pass, then count probe renders over an idle window. */
  async function countProbeRendersOver(windowMs: number): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = probeRenders;
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    return probeRenders - before;
  }

  afterEach(() => {
    for (const { root, container } of mounted) {
      root.unmount();
      container.remove();
    }
    mounted = [];
    Reflect.set(globalThis, ACT_ENV_KEY, prevActEnv);
    probeRenders = 0;
    localStorage.clear();
  });

  it("renders 'Server not found' and the slot-consumer tree then stops re-rendering", async () => {
    const container = renderMissing(["/missing"]);

    await awaitText(container, "Server not found");
    expect(within(container).getByRole("heading", { name: "Server not found" })).toBeInTheDocument();
    expect(within(container).getByText(/No tmux server named/)).toHaveTextContent("missing");

    // A settled tree accrues no renders over an idle window. The bound is
    // loose by design — the loop this guards grows the count by hundreds over
    // the same window, so any small ceiling catches it without flaking on a
    // late one-shot effect.
    expect(await countProbeRendersOver(300)).toBeLessThanOrEqual(1);
  });

  it("the /$server/$window form settles the same way", async () => {
    const container = renderMissing(["/missing/0"]);

    await awaitText(container, "Server not found");
    expect(await countProbeRendersOver(300)).toBeLessThanOrEqual(1);
  });
});

describe("⇧Ctrl+G capture chord — gui-capture-toggle / web-capture-toggle flip only the focused tile kind's latch", () => {
  // Both bindings claim ⇧⌘G/⇧Ctrl+G, surface-gated (guiOnly / webOnly), so
  // at most one handler is present for the focused tile. The SurfaceLayout
  // module mock above reports the LAST layout leaf as the focused tile kind,
  // so the fixture layout selects the arm: `h(tty,web)` → web focus (the
  // web handler also needs page content — `webTabs`), `h(tty,gui)` → gui
  // focus (the gui leaf survives degradeLayout only with the host signal
  // armed through guiSignalMock), and bare `tty` / `h(tty,code)` → no
  // handler. The latch writes land in localStorage (`rk-gui-capture` /
  // `rk-web-capture`) synchronously inside the chord handler.
  stubMatchMedia(() => false);

  const GUI_ON: import("@/contexts/session-context").GuiSignal = {
    id: "gui",
    enabled: true,
    backend: "test",
    reachable: true,
    display: ":0",
    width: 1280,
    height: 800,
    viewers: 0,
    wm: "",
    locked: false,
    geometry: "",
  };

  function CaptureRouteRoot({
    layout,
    gitRoot,
    webTabs,
  }: {
    layout: string;
    gitRoot?: string;
    webTabs?: string[];
  }) {
    return (
      <ThemeProvider>
        <ToastProvider>
          <InstanceNameProvider>
            <ChromeProvider>
              <ZenProvider>
                <FocusedTerminalProvider>
                  <OptimisticProvider>
                    <TopBarSlotProvider>
                      <FocusedPaneProvider>
                        <ServerDialogsProvider>
                          <PaletteActionsProvider globalActions={[]}>
                            <GuiOffRequestProvider value={undefined}>
                              <MetricsProvider value={null}>
                                <HostMetricsProvider value={null}>
                                  <StandaloneSessionContextProvider
                                    value={{
                                      currentServer: null,
                                      servers: [{ name: "srv", sessionCount: 1 }] as ServerInfo[],
                                      serversLoaded: true,
                                      sessionsByServer: new Map([
                                        [
                                          "srv",
                                          [
                                            makeSession({
                                              name: "alpha",
                                              windows: [
                                                makeWindow({
                                                  windowId: "@0",
                                                  index: 0,
                                                  isActiveWindow: true,
                                                  layout,
                                                  ...(gitRoot ? { gitRoot } : {}),
                                                  ...(webTabs ? { webTabs, webActive: 1 } : {}),
                                                }),
                                              ],
                                            }),
                                          ],
                                        ],
                                      ]),
                                      isConnectedByServer: new Map([["srv", true]]),
                                    }}
                                  >
                                    <Outlet />
                                  </StandaloneSessionContextProvider>
                                </HostMetricsProvider>
                              </MetricsProvider>
                            </GuiOffRequestProvider>
                          </PaletteActionsProvider>
                        </ServerDialogsProvider>
                      </FocusedPaneProvider>
                    </TopBarSlotProvider>
                  </OptimisticProvider>
                </FocusedTerminalProvider>
              </ZenProvider>
            </ChromeProvider>
          </InstanceNameProvider>
        </ToastProvider>
      </ThemeProvider>
    );
  }

  function renderCaptureRoute(layout: string, opts: { gitRoot?: string; webTabs?: string[] } = {}) {
    const rootRoute = createRootRoute({
      component: () => (
        <CaptureRouteRoot layout={layout} gitRoot={opts.gitRoot} webTabs={opts.webTabs} />
      ),
    });
    const serverRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/$server",
      component: ServerShell,
    });
    const serverIndexRoute = createRoute({
      getParentRoute: () => serverRoute,
      path: "/",
    });
    const terminalRoute = createRoute({
      getParentRoute: () => serverRoute,
      path: "/$window",
      validateSearch: validateTerminalSearch,
      params: {
        parse: (params) => ({ window: urlSegmentToWindowId(params.window) }),
        stringify: (params) => ({ window: windowIdToUrlSegment(params.window) }),
      },
    });
    const routeTree = rootRoute.addChildren([
      serverRoute.addChildren([serverIndexRoute, terminalRoute]),
    ]);
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/srv/0"] }),
    });
    render(<RouterProvider router={router} />);
  }

  const pressToggleChord = () =>
    fireEvent.keyDown(document, { key: "G", code: "KeyG", ctrlKey: true, shiftKey: true });

  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    guiSignalMock.current = null;
    localStorage.clear();
  });

  it("web-tile focus flips ONLY rk-web-capture (and toggles it back off)", async () => {
    renderCaptureRoute("h(tty,web)", { webTabs: ["http://localhost:4000/"] });
    await waitFor(() => screen.getByTestId("mock-surface-layout"));
    await act(async () => {});

    pressToggleChord();
    expect(localStorage.getItem("rk-web-capture")).toBe("1");
    expect(localStorage.getItem("rk-gui-capture")).toBeNull();

    pressToggleChord();
    expect(localStorage.getItem("rk-web-capture")).toBeNull();
    expect(localStorage.getItem("rk-gui-capture")).toBeNull();
  });

  it("gui-tile focus flips ONLY rk-gui-capture", async () => {
    guiSignalMock.current = GUI_ON;
    renderCaptureRoute("h(tty,gui)");
    await waitFor(() => screen.getByTestId("mock-surface-layout"));
    await act(async () => {});

    pressToggleChord();
    expect(localStorage.getItem("rk-gui-capture")).toBe("1");
    expect(localStorage.getItem("rk-web-capture")).toBeNull();
  });

  it("an onboarding web tile (no page) mounts no handler — no latch change", async () => {
    renderCaptureRoute("h(tty,web)");
    await waitFor(() => screen.getByTestId("mock-surface-layout"));
    await act(async () => {});

    pressToggleChord();
    expect(localStorage.getItem("rk-web-capture")).toBeNull();
    expect(localStorage.getItem("rk-gui-capture")).toBeNull();
  });

  it("tty focus mounts no handler — the chord falls through with no latch change", async () => {
    renderCaptureRoute("tty");
    await waitFor(() => screen.getByTestId("mock-surface-layout"));
    await act(async () => {});

    pressToggleChord();
    expect(localStorage.getItem("rk-gui-capture")).toBeNull();
    expect(localStorage.getItem("rk-web-capture")).toBeNull();
  });

  it("code-tile focus mounts no handler — the chord falls through with no latch change", async () => {
    renderCaptureRoute("h(tty,code)", { gitRoot: "/repo" });
    await waitFor(() => screen.getByTestId("mock-surface-layout"));
    await act(async () => {});

    pressToggleChord();
    expect(localStorage.getItem("rk-gui-capture")).toBeNull();
    expect(localStorage.getItem("rk-web-capture")).toBeNull();
  });
});
