import { StrictMode } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, act, waitFor } from "@testing-library/react";
import { Sidebar, SESSION_COLLAPSED_STORAGE_KEY } from "./index";
import { OptimisticProvider } from "@/contexts/optimistic-context";
import { HostMetricsProvider, MetricsProvider, StandaloneSessionContextProvider } from "@/contexts/session-context";
import { FocusedPaneProvider, useRegisterFocusedPane, type FocusedPane } from "@/contexts/focused-pane-context";
import { ThemeProvider } from "@/contexts/theme-context";
import { InstanceAccentValueProvider, type InstanceAccent } from "@/contexts/instance-accent-context";
import { InstanceNameValueProvider, type InstanceName } from "@/contexts/instance-name-context";
import { ChromeProvider } from "@/contexts/chrome-context";
import { SettingsDialogProvider } from "@/contexts/settings-dialog-context";
import { ToastProvider } from "@/components/toast";
import { useWindowStore } from "@/store/window-store";
import { useSelectionStore } from "@/store/selection-store";
import { getAllServerColors, setServerColor, getAllServerFlairs, setServerFlair, setServerProtected, DAEMON_SERVER } from "@/api/client";
import { stubMatchMedia } from "@/test-utils/match-media";
import { resetFlyoutWarmState } from "./row-flyout-card";
import { focusSidebarCurrentRow, registerWindowFocusRestorer } from "@/lib/sidebar-events";
import { QUAKE_TERMINAL_EVENT } from "@/lib/quake-terminal";
import {
  computeRowTints,
  computeRowBorders,
  deriveUIColors,
  UNCOLORED_SELECTED_KEY,
  DEFAULT_DARK_THEME,
} from "@/themes";
import type { MetricsSnapshot, ProjectSession } from "@/types";
import type { UpdateAvailable } from "@/contexts/session-context";

// HostPanel (inside Sidebar) consumes the instance-accent context; inject a
// static null accent so sidebar tests need no fetching provider (1etw).
const NULL_ACCENT: InstanceAccent = {
  color: null,
  isExplicit: false,
  stripeHex: null,
  washHex: null,
  titlebarHex: null,
  setColor: () => {},
};

// HostPanel also consumes the instance-name context (o7q8); inject a static
// empty value so these tests need no fetching provider.
const NULL_NAME: InstanceName = {
  hostname: "",
  instanceName: null,
  displayName: "",
  setInstanceName: () => {},
};


const mockNavigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/" } }),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    getAllServerColors: vi.fn().mockResolvedValue({}),
    setServerColor: vi.fn().mockResolvedValue({ ok: true }),
    getAllServerFlairs: vi.fn().mockResolvedValue({}),
    setServerFlair: vi.fn().mockResolvedValue({ ok: true }),
    setServerProtected: vi.fn().mockResolvedValue({ ok: true }),
  };
});

// Footer version click-to-copy (260724-6j1v) — deterministic clipboard seam
// (jsdom has no navigator.clipboard).
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn().mockResolvedValue(true),
}));
import { copyToClipboard } from "@/lib/clipboard";

// jsdom does not implement matchMedia — ThemeProvider + media-query hooks need it.
stubMatchMedia((query) => query.includes("prefers-color-scheme: dark"));

const SERVERS = [
  { name: "primary", sessionCount: 1 },
  { name: "alpha", sessionCount: 0 },
  { name: "beta", sessionCount: 0 },
];

const PRIMARY_SESSIONS: ProjectSession[] = [
  {
    name: "main",
    windows: [
      {
        index: 0,
        windowId: "@0",
        name: "shell",
        worktreePath: "~/code/run-kit",
        activity: "active",
        isActiveWindow: true,
        paneCommand: "zsh",
        activityTimestamp: Math.floor(Date.now() / 1000),
      },
    ],
  },
];

type RenderOpts = {
  currentServer?: string | null;
  /** Override the route selection (defaults: session "main" / window "@0" when
   *  a current server exists). Pass null for the no-current-window route state
   *  (`/$server` dashboard, board route) — needed by tests that fold a session
   *  and assert its rows leave the DOM, since the CURRENT session renders
   *  expanded regardless of its collapsed exception (derived expand). */
  currentSession?: string | null;
  currentWindowId?: string | null;
  servers?: { name: string; sessionCount: number; protected?: boolean; managed?: boolean }[];
  /** Wrap the tree in <StrictMode> to surface impure state updaters (the
   *  double-invocation the real app gets via main.tsx). Off by default so the
   *  coupling tests keep their single-pass render. */
  strict?: boolean;
  /** Publish a focused board pane into the FocusedPaneProvider (260720-zx4i) —
   *  simulates BoardPage's registration. `undefined` = no registrant mounted. */
  focusedPane?: FocusedPane;
  /** Override the derived per-server sessions map (board-route tests need
   *  session data on a NON-current server). */
  sessionsByServer?: Map<string, ProjectSession[]>;
  /** Per-page connection state fed to the footer dot (defaults false). */
  isConnected?: boolean;
  /** Daemon version fed to the footer version readout (defaults null = hidden). */
  daemonVersion?: string | null;
  /** Pending-update payload fed to the footer status slot (defaults null = no
   *  update → the slot renders nothing). */
  updateAvailable?: UpdateAvailable | null;
  /** Host-global metrics snapshot fed to HostMetricsProvider (defaults null). */
  hostMetrics?: MetricsSnapshot | null;
  /** Override the Sidebar's onKillServer prop (x4sf) — the header ✕ routes
   *  through it; tests assert the invocation, never a direct kill call. */
  onKillServer?: (name: string) => void;
  /** Override the Sidebar's onCreateSession prop — the header + and the
   *  server card's New session row route through it. */
  onCreateSession?: (server: string) => void;
  onWindowMarkerChange?: (
    server: string,
    session: string,
    windowId: string,
    marker: string | null,
  ) => void;
  /** Override the Sidebar's onSelectWindow prop — tests assert the invocation. */
  onSelectWindow?: (server: string, session: string, windowId: string) => void;
  /** Wire the operator placeholder row's activation handler (the shell's
   *  drawer opener) — absent ⇒ no placeholder renders (the board route). */
  onOperatorPlaceholder?: (server: string) => void;
};

/** Mounts BoardPage's registration seam inside the provider (260720-zx4i). */
function FocusedPaneRegistrant({ pane }: { pane: FocusedPane }) {
  useRegisterFocusedPane(pane);
  return null;
}

function sidebarTree(opts: RenderOpts = {}) {
  const currentServer = opts.currentServer === undefined ? "primary" : opts.currentServer;
  const servers = opts.servers ?? SERVERS;
  const sessionsByServer = opts.sessionsByServer ?? new Map(
    servers.map((s) => [s.name, s.name === currentServer ? PRIMARY_SESSIONS : []]),
  );
  const tree = (
    <ThemeProvider>
      <InstanceAccentValueProvider value={NULL_ACCENT}>
      <InstanceNameValueProvider value={NULL_NAME}>
      <ToastProvider>
        <OptimisticProvider>
          <StandaloneSessionContextProvider
            value={{
              sessionsByServer,
              sessionOrderByServer: new Map(servers.map((s) => [s.name, []])),
              isConnectedByServer: new Map(servers.map((s) => [s.name, false])),
              daemonVersion: opts.daemonVersion ?? null,
              updateAvailable: opts.updateAvailable ?? null,
              metricsByServer: new Map(),
              currentServer,
              servers,
              refreshServers: vi.fn(),
            }}
          >
            <MetricsProvider value={null}>
              <HostMetricsProvider value={opts.hostMetrics ?? null}>
                <FocusedPaneProvider>
                  {opts.focusedPane !== undefined && (
                    <FocusedPaneRegistrant pane={opts.focusedPane} />
                  )}
                  <ChromeProvider>
                    <SettingsDialogProvider>
                      <Sidebar
                        currentServer={currentServer}
                        currentSession={opts.currentSession !== undefined ? opts.currentSession : currentServer ? "main" : null}
                        currentWindowId={opts.currentWindowId !== undefined ? opts.currentWindowId : currentServer ? "@0" : null}
                        isConnected={opts.isConnected ?? false}
                        onSelectWindow={opts.onSelectWindow ?? vi.fn()}
                        onCreateWindow={vi.fn()}
                        onCreateSession={opts.onCreateSession ?? vi.fn()}
                        onWindowMarkerChange={opts.onWindowMarkerChange}
                        onCreateServer={vi.fn()}
                        onKillServer={opts.onKillServer ?? vi.fn()}
                        onOperatorPlaceholder={opts.onOperatorPlaceholder}
                      />
                    </SettingsDialogProvider>
                  </ChromeProvider>
                </FocusedPaneProvider>
              </HostMetricsProvider>
            </MetricsProvider>
          </StandaloneSessionContextProvider>
        </OptimisticProvider>
      </ToastProvider>
      </InstanceNameValueProvider>
    </InstanceAccentValueProvider>
    </ThemeProvider>
  );
  return opts.strict ? <StrictMode>{tree}</StrictMode> : tree;
}

function renderSidebar(opts: RenderOpts = {}) {
  return render(sidebarTree(opts));
}

/** Re-render the same tree with new props — used to simulate an SSE snapshot
 *  change (a window disappearing) without remounting the sidebar. */
function rerenderSidebar(
  rerender: ReturnType<typeof render>["rerender"],
  opts: RenderOpts = {},
) {
  rerender(sidebarTree(opts));
}

function getServerGroupHeader(name: string): HTMLElement | null {
  return screen.queryByRole("button", { name: new RegExp(`Collapse ${name} sessions|Expand ${name} sessions`) });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function getScopeChip(): HTMLElement {
  return screen.getByRole("button", { name: "Toggle sessions scope" });
}

describe("Sidebar — sessions-pane scope (hexokit-panel-sessions-scope)", () => {
  it("marks the tree as the row-discoverable sidebar scroll container", () => {
    renderSidebar();
    expect(screen.getByRole("tree")).toHaveAttribute("data-sidebar-scroll", "");
  });

  it("threads the optional marker seam to rows", () => {
    renderSidebar({ onWindowMarkerChange: vi.fn() });
    expect(screen.getByTestId("marker-strip")).toBeInTheDocument();
  });

  it("renders no marker strip for a board-shaped sidebar without the seam", () => {
    renderSidebar({
      currentServer: null,
      currentSession: null,
      currentWindowId: null,
      sessionsByServer: new Map([
        ["primary", PRIMARY_SESSIONS],
        ["alpha", []],
        ["beta", []],
      ]),
    });
    fireEvent.click(screen.getByRole("button", { name: /Expand primary sessions/ }));
    expect(screen.queryByTestId("marker-strip")).toBeNull();
  });

  it("renders all ServerGroups by default (scope `all`, no stored value)", () => {
    renderSidebar();

    expect(getServerGroupHeader("primary")).toBeInTheDocument();
    expect(getServerGroupHeader("alpha")).toBeInTheDocument();
    expect(getServerGroupHeader("beta")).toBeInTheDocument();
    expect(getScopeChip()).toHaveTextContent("ALL");
  });

  it("renders only the current server's ServerGroup in `current` scope, force-opened", () => {
    localStorage.setItem("hexokit-panel-sessions-scope", "current");
    renderSidebar({ currentServer: "primary" });

    expect(getServerGroupHeader("primary")).toBeInTheDocument();
    expect(getServerGroupHeader("alpha")).not.toBeInTheDocument();
    expect(getServerGroupHeader("beta")).not.toBeInTheDocument();
    expect(getScopeChip()).toHaveTextContent("CUR");

    // Force-open: primary's group header reads "Collapse" (chevron points down).
    const primaryHeader = screen.getByRole("button", { name: /Collapse primary sessions/ });
    expect(primaryHeader).toHaveAttribute("aria-expanded", "true");
  });

  it("falls back to all servers in `current` scope when currentServer is null (board route) — no hint", () => {
    localStorage.setItem("hexokit-panel-sessions-scope", "current");
    renderSidebar({ currentServer: null });

    expect(getServerGroupHeader("primary")).toBeInTheDocument();
    expect(getServerGroupHeader("alpha")).toBeInTheDocument();
    expect(getServerGroupHeader("beta")).toBeInTheDocument();
    expect(
      screen.queryByText("Select a server above to see its sessions."),
    ).not.toBeInTheDocument();
  });

  it("falls back to all servers in `current` scope when currentServer is missing from the list", () => {
    localStorage.setItem("hexokit-panel-sessions-scope", "current");
    // Stale/deleted route param: currentServer names a server not in `servers`.
    renderSidebar({ currentServer: "gone" });

    expect(getServerGroupHeader("primary")).toBeInTheDocument();
    expect(getServerGroupHeader("alpha")).toBeInTheDocument();
    expect(getServerGroupHeader("beta")).toBeInTheDocument();
  });

  it("treats an unrecognized stored scope value as `all`", () => {
    localStorage.setItem("hexokit-panel-sessions-scope", "bogus");
    renderSidebar({ currentServer: "primary" });

    expect(getServerGroupHeader("primary")).toBeInTheDocument();
    expect(getServerGroupHeader("alpha")).toBeInTheDocument();
    expect(getScopeChip()).toHaveTextContent("ALL");
  });

  it("does not overwrite persisted per-server collapse keys when force-opening the current group", () => {
    // User has the primary group collapsed in the multi-server tree.
    localStorage.setItem("hexokit-panel-sessions-primary", "false");
    localStorage.setItem("hexokit-panel-sessions-scope", "current");
    renderSidebar({ currentServer: "primary" });

    // The persisted value is unchanged after rendering with force-open in effect.
    expect(localStorage.getItem("hexokit-panel-sessions-primary")).toBe("false");

    // And the rendered state is open (force-open dominates).
    const primaryHeader = screen.getByRole("button", { name: /Collapse primary sessions/ });
    expect(primaryHeader).toHaveAttribute("aria-expanded", "true");
  });

  it("chip click narrows the tree, persists `current`, and a second click restores `all`", () => {
    renderSidebar({ currentServer: "primary" });

    // Initially scope `all` → all groups visible.
    expect(getServerGroupHeader("alpha")).toBeInTheDocument();
    expect(getServerGroupHeader("beta")).toBeInTheDocument();

    fireEvent.click(getScopeChip());

    // Narrowed to the current server; value persisted; chip reflects state.
    expect(localStorage.getItem("hexokit-panel-sessions-scope")).toBe("current");
    expect(getScopeChip()).toHaveTextContent("CUR");
    expect(getServerGroupHeader("primary")).toBeInTheDocument();
    expect(getServerGroupHeader("alpha")).not.toBeInTheDocument();
    expect(getServerGroupHeader("beta")).not.toBeInTheDocument();

    fireEvent.click(getScopeChip());

    // Restored: all groups return, value persisted back to `all`.
    expect(localStorage.getItem("hexokit-panel-sessions-scope")).toBe("all");
    expect(getScopeChip()).toHaveTextContent("ALL");
    expect(getServerGroupHeader("alpha")).toBeInTheDocument();
    expect(getServerGroupHeader("beta")).toBeInTheDocument();
  });

  it("SERVER panel expansion no longer affects the sessions tree (delink regression)", () => {
    // The old coupling filtered the tree when the SERVER panel was open. The
    // scope state is now the only filter input — the panel key must be inert.
    localStorage.setItem("hexokit-panel-server", "true");
    renderSidebar({ currentServer: "primary" });

    expect(getServerGroupHeader("primary")).toBeInTheDocument();
    expect(getServerGroupHeader("alpha")).toBeInTheDocument();
    expect(getServerGroupHeader("beta")).toBeInTheDocument();

    // Toggling the SERVER panel live changes nothing in the tree either.
    const serverPaneToggle = screen.getByRole("button", { name: /^Server/ });
    fireEvent.click(serverPaneToggle);
    expect(getServerGroupHeader("alpha")).toBeInTheDocument();
    fireEvent.click(serverPaneToggle);
    expect(getServerGroupHeader("alpha")).toBeInTheDocument();
  });

  it("falls back to 'No servers' when the server list is empty regardless of scope", () => {
    localStorage.setItem("hexokit-panel-sessions-scope", "current");
    renderSidebar({ servers: [], currentServer: null });

    // Two "No servers" empty-states render: ServerPanel's tile grid and the
    // Sessions Pane's group list. The Sessions Pane variant has the centered
    // `py-4 text-center` classes; the ServerPanel variant uses `py-1`.
    const sessionsEmpty = screen.getAllByText("No servers").find(
      (el) => el.className.includes("py-4") && el.className.includes("text-center"),
    );
    expect(sessionsEmpty).toBeDefined();
  });
});

describe("Sidebar — selection pruning on ServerGroup unmount (260807-nf9f)", () => {
  // Regression guard for review cycle-1 must-fix 2: selection pruning is gated
  // on `rowsVersion`, which `registerGroupRows` bumps only when a SURVIVING
  // group's row-set signature changes. A whole ServerGroup leaving the tree
  // changed no surviving signature, so `rowsVersion` never bumped, the prune
  // effect never re-ran, and the departed group's keys stayed selected
  // (violating R4/A-004/A-022). The fix adds an `unregisterGroupRows` unmount
  // counterpart that drops the group's slice + signature and bumps.
  const ALPHA_SESSIONS: ProjectSession[] = [
    {
      name: "work",
      windows: [
        {
          index: 0,
          windowId: "@7",
          name: "feature",
          worktreePath: "~/code/alpha",
          activity: "idle",
          isActiveWindow: false,
          paneCommand: "zsh",
          activityTimestamp: Math.floor(Date.now() / 1000),
        },
      ],
    },
  ];

  const MULTI_SESSIONS = new Map<string, ProjectSession[]>([
    ["primary", PRIMARY_SESSIONS],
    ["alpha", ALPHA_SESSIONS],
    ["beta", []],
  ]);

  beforeEach(() => {
    useSelectionStore.setState({ selected: new Set(), anchor: null });
  });

  afterEach(() => {
    useSelectionStore.setState({ selected: new Set(), anchor: null });
  });

  it("prunes a departed group's keys when the sessions-scope narrows ALL→CURRENT", async () => {
    renderSidebar({ currentServer: "primary", sessionsByServer: MULTI_SESSIONS });

    // Open alpha's group so its window row paints (non-current groups start
    // collapsed), then Cmd-click that row into the selection.
    fireEvent.click(screen.getByRole("button", { name: /Expand alpha sessions/ }));
    const alphaRow = await screen.findByText("feature");
    fireEvent.click(alphaRow, { metaKey: true });

    expect([...useSelectionStore.getState().selected]).toEqual(["alpha:@7"]);

    // Narrow the scope: alpha's whole ServerGroup unmounts. No surviving group's
    // signature changes, so ONLY the unmount unregister can drive the prune.
    fireEvent.click(getScopeChip());
    expect(getServerGroupHeader("alpha")).not.toBeInTheDocument();

    await waitFor(() => {
      expect([...useSelectionStore.getState().selected]).toEqual([]);
    });
    expect(useSelectionStore.getState().anchor).toBeNull();
  });

  it("keeps a surviving group's keys selected across the same unmount", async () => {
    renderSidebar({ currentServer: "primary", sessionsByServer: MULTI_SESSIONS });

    // Select one row on alpha (departs) and one on primary (survives).
    fireEvent.click(screen.getByRole("button", { name: /Expand alpha sessions/ }));
    fireEvent.click(await screen.findByText("feature"), { metaKey: true });
    // Scope to the tree — the window name also appears outside it (board/pin
    // surfaces), so a bare getByText is ambiguous. The click seam is the row's
    // inner activation button, not the treeitem root.
    const primaryRow = document.querySelector<HTMLElement>(
      '[role="tree"] [data-row-key="primary:@0"] button',
    );
    expect(primaryRow).not.toBeNull();
    fireEvent.click(primaryRow!, { metaKey: true });
    expect([...useSelectionStore.getState().selected].sort()).toEqual([
      "alpha:@7",
      "primary:@0",
    ]);

    fireEvent.click(getScopeChip());

    // The prune is scoped to rows that actually left — it is not a blanket clear.
    await waitFor(() => {
      expect([...useSelectionStore.getState().selected]).toEqual(["primary:@0"]);
    });
  });

  it("drops the anchor with the departed group so a later shift-click cannot use it", async () => {
    renderSidebar({ currentServer: "primary", sessionsByServer: MULTI_SESSIONS });

    fireEvent.click(screen.getByRole("button", { name: /Expand alpha sessions/ }));
    fireEvent.click(await screen.findByText("feature"), { metaKey: true });
    // The Cmd-click parked the range anchor on the alpha row.
    expect(useSelectionStore.getState().anchor).toBe("alpha:@7");

    fireEvent.click(getScopeChip());

    // A stale anchor pointing at a vanished row would silently yield an empty
    // range on the next shift-click; the prune clears it alongside the key.
    await waitFor(() => {
      expect(useSelectionStore.getState().anchor).toBeNull();
    });
  });
});

describe("Sidebar — selection survives collapse/expand (260807-nf9f R4)", () => {
  // Regression guard for review cycle-2 must-fix: the prune derived liveness
  // from a DOM/visible-row walk, which equates "not rendered" with "gone".
  // Collapsing a session removed its window rows from the DOM and bumped the
  // visible-row signature, so the prune silently dropped those still-live
  // windows (and the anchor) from the selection — and `Select all merged`,
  // which deliberately selects windows inside COLLAPSED sessions, lost them on
  // the next unrelated signature change. Liveness now derives from the session
  // DATA (every window the SSE snapshot knows for the rendered groups), so only
  // a genuine departure prunes.
  const TWO_SESSION_SERVER: ProjectSession[] = [
    {
      name: "main",
      windows: [
        {
          index: 0,
          windowId: "@0",
          name: "shell",
          worktreePath: "~/code/run-kit",
          activity: "active",
          isActiveWindow: true,
          paneCommand: "zsh",
          activityTimestamp: Math.floor(Date.now() / 1000),
        },
      ],
    },
    {
      name: "side",
      windows: [
        {
          index: 0,
          windowId: "@5",
          name: "docs",
          worktreePath: "~/code/run-kit",
          activity: "idle",
          isActiveWindow: false,
          paneCommand: "zsh",
          activityTimestamp: Math.floor(Date.now() / 1000),
        },
      ],
    },
  ];

  const SESSIONS = new Map<string, ProjectSession[]>([["primary", TWO_SESSION_SERVER]]);

  function collapseChipFor(session: string): HTMLElement {
    return screen.getByRole("button", { name: new RegExp(`(Collapse|Expand) ${session}$`) });
  }

  function selectWindowRow(key: string) {
    const row = document.querySelector<HTMLElement>(`[role="tree"] [data-row-key="${key}"] button`);
    expect(row).not.toBeNull();
    fireEvent.click(row!, { metaKey: true });
  }

  beforeEach(() => {
    useSelectionStore.setState({ selected: new Set(), anchor: null });
  });

  afterEach(() => {
    useSelectionStore.setState({ selected: new Set(), anchor: null });
  });

  it("keeps the selection and anchor when the selected window's OWN session collapses", async () => {
    // No-current-window route state (`/$server` dashboard): these tests fold
    // sessions and assert their rows leave the DOM, which a session exempts
    // itself from while it is the current route's session (derived expand).
    renderSidebar({ currentServer: "primary", sessionsByServer: SESSIONS, currentSession: null, currentWindowId: null });

    selectWindowRow("primary:@0");
    expect([...useSelectionStore.getState().selected]).toEqual(["primary:@0"]);
    expect(useSelectionStore.getState().anchor).toBe("primary:@0");

    // Fold the row out of view. The window is still very much alive in tmux.
    fireEvent.click(collapseChipFor("main"));
    await waitFor(() => {
      expect(document.querySelector('[role="tree"] [data-row-key="primary:@0"]')).toBeNull();
    });

    expect([...useSelectionStore.getState().selected]).toEqual(["primary:@0"]);
    expect(useSelectionStore.getState().anchor).toBe("primary:@0");

    // Re-expanding shows the row still selected.
    fireEvent.click(collapseChipFor("main"));
    await waitFor(() => {
      expect(
        document.querySelector('[role="tree"] [data-row-key="primary:@0"]'),
      ).not.toBeNull();
    });
    expect([...useSelectionStore.getState().selected]).toEqual(["primary:@0"]);
    expect(
      document
        .querySelector('[role="tree"] [data-row-key="primary:@0"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("keeps a key that sits INSIDE a collapsed session when an UNRELATED session collapses", async () => {
    // The `Select all merged` shape: the builder derives keys from session DATA,
    // so it legitimately selects windows inside collapsed sessions. Under
    // visibility-keyed liveness the very next unrelated signature change wiped
    // them, losing part of the selection before the user reached the palette.
    // No-current-window route state (`/$server` dashboard): these tests fold
    // sessions and assert their rows leave the DOM, which a session exempts
    // itself from while it is the current route's session (derived expand).
    renderSidebar({ currentServer: "primary", sessionsByServer: SESSIONS, currentSession: null, currentWindowId: null });

    selectWindowRow("primary:@5");
    fireEvent.click(collapseChipFor("side")); // @5's own session folds away
    await waitFor(() => {
      expect(document.querySelector('[role="tree"] [data-row-key="primary:@5"]')).toBeNull();
    });

    // Now an UNRELATED session collapses — a signature change @5 had no part in.
    fireEvent.click(collapseChipFor("main"));
    await waitFor(() => {
      expect(document.querySelector('[role="tree"] [data-row-key="primary:@0"]')).toBeNull();
    });

    expect([...useSelectionStore.getState().selected]).toEqual(["primary:@5"]);
    expect(useSelectionStore.getState().anchor).toBe("primary:@5");
  });

  it("still prunes a window that genuinely leaves the SSE data", async () => {
    const { rerender } = renderSidebar({
      currentServer: "primary",
      sessionsByServer: SESSIONS,
    });

    selectWindowRow("primary:@0");
    selectWindowRow("primary:@5");
    expect([...useSelectionStore.getState().selected].sort()).toEqual([
      "primary:@0",
      "primary:@5",
    ]);

    // @5 is killed: it disappears from the snapshot entirely (not merely folded).
    const killed = new Map<string, ProjectSession[]>([
      ["primary", [TWO_SESSION_SERVER[0], { name: "side", windows: [] }]],
    ]);
    rerenderSidebar(rerender, { currentServer: "primary", sessionsByServer: killed });

    await waitFor(() => {
      expect([...useSelectionStore.getState().selected]).toEqual(["primary:@0"]);
    });
    // The anchor sat on the killed row — a stale anchor would silently yield an
    // empty range on the next shift-click, so it is dropped with the key.
    expect(useSelectionStore.getState().anchor).toBeNull();
  });
});

describe("Sidebar — per-server group toggle under StrictMode (mss7)", () => {
  // Regression guard for mss7: clicking Expand on a non-current server's group
  // did nothing because `toggleServerSection` performed a `localStorage.setItem`
  // INSIDE the `setServerSectionsOpen` updater. React 19 StrictMode (active in
  // the real app via main.tsx, and in e2e) double-invokes state updaters; the
  // second pass observed the first pass's localStorage write and inverted the
  // computed `next`, so a single click was a net no-op and the group never
  // opened. This test renders under <StrictMode> — the exact condition the
  // existing coupling tests omit — and would fail against the pre-fix impure
  // updater. The fix moves the side-effects out of the updater (pure commit).
  it("opens a collapsed non-current group on first click and collapses it on the second", () => {
    // Server Pane key unset → defaults collapsed → all groups render, and
    // non-current groups (alpha) start collapsed (aria-expanded="false").
    renderSidebar({ currentServer: "primary", strict: true });

    const alphaToggle = screen.getByRole("button", { name: /Expand alpha sessions/ });
    expect(alphaToggle).toHaveAttribute("aria-expanded", "false");

    // First click: the group must open (the no-op bug manifested here).
    fireEvent.click(alphaToggle);
    expect(
      screen.getByRole("button", { name: /Collapse alpha sessions/ }),
    ).toHaveAttribute("aria-expanded", "true");
    // Side-effect ran exactly once and agrees with the rendered state.
    expect(localStorage.getItem("hexokit-panel-sessions-alpha")).toBe("true");

    // Second click: the group must collapse again (full toggle cycle).
    fireEvent.click(screen.getByRole("button", { name: /Collapse alpha sessions/ }));
    expect(
      screen.getByRole("button", { name: /Expand alpha sessions/ }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(localStorage.getItem("hexokit-panel-sessions-alpha")).toBe("false");
  });
});

describe("Sidebar — per-session collapse persistence (kddk)", () => {
  // Per-session collapse used to be plain React state, so every refresh reset
  // every session to expanded. It now rides one localStorage key holding a JSON
  // map of collapsed EXCEPTIONS — expanded sessions carry no entry, so the
  // default (expanded) still applies to sessions the user never collapsed.

  /** The chevron on the SESSION row (`Collapse main` / `Expand main`) — the
   *  `$` anchor keeps it distinct from the server group header's
   *  `Collapse primary sessions`. */
  function collapseChipFor(session: string): HTMLElement {
    return screen.getByRole("button", { name: new RegExp(`(Collapse|Expand) ${session}$`) });
  }

  function storedMap(): unknown {
    const raw = localStorage.getItem(SESSION_COLLAPSED_STORAGE_KEY);
    return raw === null ? null : JSON.parse(raw);
  }

  function windowRow(key: string): Element | null {
    return document.querySelector(`[role="tree"] [data-row-key="${key}"]`);
  }

  it("persists a collapse and restores it on a remount (refresh)", () => {
    renderSidebar({ currentServer: "primary", currentSession: null, currentWindowId: null });
    expect(collapseChipFor("main")).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(collapseChipFor("main"));

    expect(collapseChipFor("main")).toHaveAttribute("aria-expanded", "false");
    expect(windowRow("primary:@0")).toBeNull();
    expect(storedMap()).toEqual({ "primary:main": true });

    // Remount with the same storage — the refresh the feature exists for.
    cleanup();
    renderSidebar({ currentServer: "primary", currentSession: null, currentWindowId: null });

    expect(collapseChipFor("main")).toHaveAttribute("aria-expanded", "false");
    expect(windowRow("primary:@0")).toBeNull();
  });

  it("removes the entry when the session is expanded again (exceptions-only)", () => {
    localStorage.setItem(
      SESSION_COLLAPSED_STORAGE_KEY,
      JSON.stringify({ "primary:main": true }),
    );
    renderSidebar({ currentServer: "primary", currentSession: null, currentWindowId: null });
    expect(collapseChipFor("main")).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(collapseChipFor("main"));

    expect(collapseChipFor("main")).toHaveAttribute("aria-expanded", "true");
    expect(windowRow("primary:@0")).not.toBeNull();
    // Not `{"primary:main": false}` — and an emptied map drops the key outright.
    expect(localStorage.getItem(SESSION_COLLAPSED_STORAGE_KEY)).toBeNull();
  });

  it("leaves unrelated entries alone, including sessions not currently rendered", () => {
    // Stale entries for killed/other-server sessions are deliberately not pruned
    // (the client cannot enumerate sessions on non-attached servers).
    localStorage.setItem(
      SESSION_COLLAPSED_STORAGE_KEY,
      JSON.stringify({ "other:archived": true }),
    );
    renderSidebar({ currentServer: "primary", currentSession: null, currentWindowId: null });

    fireEvent.click(collapseChipFor("main"));

    expect(storedMap()).toEqual({ "other:archived": true, "primary:main": true });
  });

  it("renders every session expanded when the stored value is malformed JSON", () => {
    localStorage.setItem(SESSION_COLLAPSED_STORAGE_KEY, "{not json");

    expect(() => renderSidebar({ currentServer: "primary", currentSession: null, currentWindowId: null })).not.toThrow();

    expect(collapseChipFor("main")).toHaveAttribute("aria-expanded", "true");
    expect(windowRow("primary:@0")).not.toBeNull();
  });

  it("ignores a non-object root and non-`true` entry values", () => {
    localStorage.setItem(
      SESSION_COLLAPSED_STORAGE_KEY,
      JSON.stringify(["primary:main"]),
    );
    renderSidebar({ currentServer: "primary", currentSession: null, currentWindowId: null });
    expect(collapseChipFor("main")).toHaveAttribute("aria-expanded", "true");

    cleanup();
    // A truthy-but-not-`true` value must not resurrect as an exception.
    localStorage.setItem(
      SESSION_COLLAPSED_STORAGE_KEY,
      JSON.stringify({ "primary:main": "yes" }),
    );
    renderSidebar({ currentServer: "primary", currentSession: null, currentWindowId: null });
    expect(collapseChipFor("main")).toHaveAttribute("aria-expanded", "true");
  });

  it("renders a session with no stored entry expanded (default preserved)", () => {
    localStorage.setItem(
      SESSION_COLLAPSED_STORAGE_KEY,
      JSON.stringify({ "primary:other": true }),
    );
    renderSidebar({ currentServer: "primary", currentSession: null, currentWindowId: null });

    expect(collapseChipFor("main")).toHaveAttribute("aria-expanded", "true");
    expect(windowRow("primary:@0")).not.toBeNull();
  });

  it("toggles exactly once per click under StrictMode", () => {
    // The mss7 failure mode, one level down: a localStorage write INSIDE the
    // state updater runs twice under React 19 StrictMode and the second pass
    // observes the first pass's write, making a single click a net no-op.
    renderSidebar({ currentServer: "primary", currentSession: null, currentWindowId: null, strict: true });

    fireEvent.click(collapseChipFor("main"));
    expect(collapseChipFor("main")).toHaveAttribute("aria-expanded", "false");
    expect(storedMap()).toEqual({ "primary:main": true });

    fireEvent.click(collapseChipFor("main"));
    expect(collapseChipFor("main")).toHaveAttribute("aria-expanded", "true");
    expect(localStorage.getItem(SESSION_COLLAPSED_STORAGE_KEY)).toBeNull();
  });

  it("renders and toggles when localStorage throws (privacy mode)", () => {
    // Scoped to this key so the throw exercises the collapse seam only — the
    // rest of the tree's preferences keep their real storage.
    const realGet = Storage.prototype.getItem;
    const realSet = Storage.prototype.setItem;
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(function (this: Storage, key: string) {
        if (key === SESSION_COLLAPSED_STORAGE_KEY) throw new Error("access denied");
        return realGet.call(this, key);
      });
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if (key === SESSION_COLLAPSED_STORAGE_KEY) throw new Error("access denied");
        realSet.call(this, key, value);
      });

    try {
      expect(() => renderSidebar({ currentServer: "primary", currentSession: null, currentWindowId: null })).not.toThrow();
      expect(collapseChipFor("main")).toHaveAttribute("aria-expanded", "true");

      // The toggle still works in-session; only the persistence is lost.
      expect(() => fireEvent.click(collapseChipFor("main"))).not.toThrow();
      expect(collapseChipFor("main")).toHaveAttribute("aria-expanded", "false");
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

describe("Sidebar — mobile drawer current-row focus bonus (R9 / T007)", () => {
  // The global matchMedia stub (top of file) reports non-mobile, so the bonus
  // effect never runs in the other suites. Here we force mobile + an open
  // drawer and drive the deferred (requestAnimationFrame) focus synchronously
  // to prove the scoped selector focuses the selected WINDOW row — and, by the
  // selector's construction, would NOT match the active BoardsSection row
  // (which carries aria-current="page" but has no [data-window-id] ancestor).

  function makeMatchMedia(mobile: boolean) {
    return vi.fn().mockImplementation((query: string) => ({
      // ThemeProvider always needs prefers-color-scheme; in mobile mode the
      // width/coarse queries also match so useIsMobile() reports mobile.
      matches:
        query.includes("prefers-color-scheme: dark") ||
        (mobile && (query.includes("max-width") || query.includes("pointer: coarse"))),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
    }));
  }

  function stubMobileMatchMedia() {
    vi.stubGlobal("matchMedia", makeMatchMedia(true));
  }

  // Restore the file-default non-mobile matchMedia stub so this block's mobile
  // override never leaks into a later-running test (the file's shared afterEach
  // does not unstub globals).
  afterEach(() => {
    vi.stubGlobal("matchMedia", makeMatchMedia(false));
  });

  it("scroll+focuses the [aria-current=\"page\"] window row when the drawer is open on mobile", () => {
    stubMobileMatchMedia();
    // ChromeProvider seeds sidebarOpen from this key — open the drawer.
    localStorage.setItem("hexokit-sidebar-open", "true");
    // Run the deferred focus synchronously instead of waiting a real frame.
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });

    try {
      // currentWindowId "@0" → that window row's button gets aria-current="page".
      renderSidebar({ currentServer: "primary" });

      const row = document.querySelector<HTMLElement>(
        '[data-window-id] [aria-current="page"]',
      );
      expect(row).not.toBeNull();
      // The match is the row button, nested under a [data-window-id] wrapper —
      // i.e. a window row, not the BoardsSection active row (which has no such
      // ancestor and is therefore excluded by the scoped selector).
      expect(row!.closest("[data-window-id]")).not.toBeNull();
      // The bonus moved focus to the selected window row.
      expect(document.activeElement).toBe(row);
      expect(rafSpy).toHaveBeenCalled();
    } finally {
      rafSpy.mockRestore();
    }
  });
});

describe("Sidebar — tree ARIA + roving keyboard navigation (wt1v)", () => {
  // A single server with one session "main" carrying two windows, plus a second
  // session "other" with one window — enough to exercise cross-session traversal,
  // expand/collapse, and end-of-list stops.
  const KB_SESSIONS: ProjectSession[] = [
    {
      name: "main",
      windows: [
        { index: 0, windowId: "@0", name: "edit", worktreePath: "~/a", activity: "idle", isActiveWindow: false, activityTimestamp: 0 },
        { index: 1, windowId: "@1", name: "test", worktreePath: "~/a", activity: "idle", isActiveWindow: false, activityTimestamp: 0 },
      ],
    },
    {
      name: "other",
      windows: [
        { index: 0, windowId: "@2", name: "run", worktreePath: "~/b", activity: "idle", isActiveWindow: false, activityTimestamp: 0 },
      ],
    },
  ];

  const onSelectWindow = vi.fn();

  // Build the provider tree for a given sessions snapshot so a test can
  // `rerender` with a CHANGED sessions Map (simulating a passive SSE tick).
  function treeUI(sessions: ProjectSession[]) {
    const servers = [{ name: "primary", sessionCount: 2 }];
    const sessionsByServer = new Map([["primary", sessions]]);
    return (
      <ThemeProvider>
        <InstanceAccentValueProvider value={NULL_ACCENT}>
        <InstanceNameValueProvider value={NULL_NAME}>
        <ToastProvider>
          <OptimisticProvider>
            <StandaloneSessionContextProvider
              value={{
                sessionsByServer,
                sessionOrderByServer: new Map([["primary", []]]),
                isConnectedByServer: new Map([["primary", true]]),
                metricsByServer: new Map(),
                currentServer: "primary",
                servers,
                refreshServers: vi.fn(),
              }}
            >
              <MetricsProvider value={null}>
                <HostMetricsProvider value={null}>
                  <FocusedPaneProvider>
                    <ChromeProvider>
                      <SettingsDialogProvider>
                      <Sidebar
                        currentServer="primary"
                        currentSession={null}
                        currentWindowId={null}
                        isConnected={false}
                        onSelectWindow={onSelectWindow}
                        onCreateWindow={vi.fn()}
                        onCreateSession={vi.fn()}
                        onCreateServer={vi.fn()}
                        onKillServer={vi.fn()}
                      />
                      </SettingsDialogProvider>
                    </ChromeProvider>
                  </FocusedPaneProvider>
                </HostMetricsProvider>
              </MetricsProvider>
            </StandaloneSessionContextProvider>
          </OptimisticProvider>
        </ToastProvider>
        </InstanceNameValueProvider>
        </InstanceAccentValueProvider>
      </ThemeProvider>
    );
  }

  function renderTree() {
    return render(treeUI(KB_SESSIONS));
  }

  function tree(): HTMLElement {
    return screen.getByRole("tree");
  }

  function visibleRows(): HTMLElement[] {
    return Array.from(tree().querySelectorAll<HTMLElement>('[role="treeitem"]'));
  }

  function rowKey(el: HTMLElement): string | null {
    // Mirrors production rowKeyOf: the globally-unique roving handle is
    // `data-row-key` (window rows, `${server}:${windowId}`) or `data-session-row`
    // (session rows, `${server}:${name}`) — NOT the bare `data-window-id`.
    return el.getAttribute("data-row-key") ?? el.getAttribute("data-session-row");
  }

  function rovingKeyNow(): string | null {
    const tabbable = visibleRows().find((r) => r.getAttribute("tabindex") === "0");
    return tabbable ? rowKey(tabbable) : null;
  }

  beforeEach(() => {
    localStorage.clear();
    onSelectWindow.mockClear();
    useWindowStore.setState({ entries: new Map(), ghosts: [] });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    useWindowStore.setState({ entries: new Map(), ghosts: [] });
  });

  it("renders a role=tree inside the Sessions nav landmark", () => {
    renderTree();
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    const treeEl = within(nav).getByRole("tree");
    expect(treeEl).toBeInTheDocument();
    expect(treeEl).toHaveAttribute("aria-label", "Session tree");
  });

  it("marks each per-server section wrapper role=presentation with no aria-labelledby", () => {
    renderTree();
    // Presentational wrappers keep the tree semantically transparent: a
    // <section> with an accessible name would map to a `region` landmark —
    // an invalid interposed node between the tree and its treeitems. The
    // aria-labelledby removal is spec-required (WAI-ARIA presentational
    // conflict resolution: a global ARIA property voids the presentation role).
    const wrappers = Array.from(
      tree().querySelectorAll<HTMLElement>(":scope > section"),
    );
    expect(wrappers.length).toBeGreaterThan(0);
    for (const w of wrappers) {
      expect(w).toHaveAttribute("role", "presentation");
      expect(w).not.toHaveAttribute("aria-labelledby");
    }
  });

  it("wires each session row's aria-controls to a role=group window list with the matching id", () => {
    renderTree();
    const sessionRows = visibleRows().filter((r) => r.getAttribute("aria-level") === "1");
    expect(sessionRows.length).toBe(2);
    for (const sr of sessionRows) {
      const controls = sr.getAttribute("aria-controls");
      expect(controls).toBeTruthy();
      const group = document.getElementById(controls!);
      expect(group).not.toBeNull();
      expect(group).toHaveAttribute("role", "group");
    }
  });

  it("establishes exactly one tab stop (tabIndex=0) — the first visible row", () => {
    renderTree();
    const tabbable = visibleRows().filter((r) => r.getAttribute("tabindex") === "0");
    expect(tabbable.length).toBe(1);
    // First visible row is the "main" session header.
    expect(rowKey(tabbable[0])).toBe("primary:main");
  });

  it("ArrowDown/ArrowUp move the roving tab stop and stop at the ends (no wrap)", () => {
    renderTree();
    const t = tree();
    // Order: main (session) → @0 → @1 → other (session) → @2
    expect(rovingKeyNow()).toBe("primary:main");

    act(() => { fireEvent.keyDown(t, { key: "ArrowDown" }); });
    expect(rovingKeyNow()).toBe("primary:@0");
    act(() => { fireEvent.keyDown(t, { key: "ArrowDown" }); });
    expect(rovingKeyNow()).toBe("primary:@1");

    // ArrowUp moves back.
    act(() => { fireEvent.keyDown(t, { key: "ArrowUp" }); });
    expect(rovingKeyNow()).toBe("primary:@0");

    // Up at... walk to the very top and assert it stops (no wrap to the bottom).
    act(() => { fireEvent.keyDown(t, { key: "ArrowUp" }); }); // → main
    expect(rovingKeyNow()).toBe("primary:main");
    act(() => { fireEvent.keyDown(t, { key: "ArrowUp" }); }); // stop
    expect(rovingKeyNow()).toBe("primary:main");
  });

  it("Home/End jump to the first/last visible row", () => {
    renderTree();
    const t = tree();
    act(() => { fireEvent.keyDown(t, { key: "End" }); });
    expect(rovingKeyNow()).toBe("primary:@2"); // last visible row (other's only window)
    act(() => { fireEvent.keyDown(t, { key: "Home" }); });
    expect(rovingKeyNow()).toBe("primary:main");
  });

  it("ArrowRight expands a collapsed session, then descends to its first window", () => {
    renderTree();
    const t = tree();
    // Collapse "main" first via its chevron so we can re-expand by keyboard.
    const mainChevron = screen.getByRole("button", { name: /Collapse main/ });
    act(() => { fireEvent.click(mainChevron); });
    // "main" is collapsed → its windows are gone; roving stays on "main".
    expect(rovingKeyNow()).toBe("primary:main");
    let mainRow = visibleRows().find((r) => rowKey(r) === "primary:main")!;
    expect(mainRow).toHaveAttribute("aria-expanded", "false");

    // ArrowRight expands it (focus stays on the session row).
    act(() => { fireEvent.keyDown(t, { key: "ArrowRight" }); });
    mainRow = visibleRows().find((r) => rowKey(r) === "primary:main")!;
    expect(mainRow).toHaveAttribute("aria-expanded", "true");
    expect(rovingKeyNow()).toBe("primary:main");

    // ArrowRight again descends to the first window child.
    act(() => { fireEvent.keyDown(t, { key: "ArrowRight" }); });
    expect(rovingKeyNow()).toBe("primary:@0");
  });

  it("ArrowLeft collapses an expanded session and moves a window to its parent", () => {
    renderTree();
    const t = tree();
    // Move roving to @0 then ArrowLeft → parent session "main".
    act(() => { fireEvent.keyDown(t, { key: "ArrowDown" }); }); // @0
    expect(rovingKeyNow()).toBe("primary:@0");
    act(() => { fireEvent.keyDown(t, { key: "ArrowLeft" }); }); // → parent main
    expect(rovingKeyNow()).toBe("primary:main");

    // ArrowLeft on the expanded session collapses it.
    act(() => { fireEvent.keyDown(t, { key: "ArrowLeft" }); });
    const mainRow = visibleRows().find((r) => rowKey(r) === "primary:main")!;
    expect(mainRow).toHaveAttribute("aria-expanded", "false");
  });

  it("Enter on a window row activates onSelectWindow with (server, session, windowId)", () => {
    renderTree();
    const t = tree();
    act(() => { fireEvent.keyDown(t, { key: "ArrowDown" }); }); // → @0
    act(() => { fireEvent.keyDown(t, { key: "Enter" }); });
    expect(onSelectWindow).toHaveBeenCalledWith("primary", "main", "@0");
  });

  it("Space on a window row also activates it", () => {
    renderTree();
    const t = tree();
    act(() => { fireEvent.keyDown(t, { key: "ArrowDown" }); }); // → @0
    act(() => { fireEvent.keyDown(t, { key: " " }); });
    expect(onSelectWindow).toHaveBeenCalledWith("primary", "main", "@0");
  });

  it("does not hijack arrows originating from a rename input", () => {
    renderTree();
    const t = tree();
    const before = rovingKeyNow();
    // Enter rename mode on the "main" session via double-click on its name.
    const nameBtn = screen.getByRole("button", { name: "Navigate to main" });
    act(() => { fireEvent.doubleClick(nameBtn); });
    const input = screen.getByLabelText("Rename session") as HTMLInputElement;
    // An ArrowDown whose target is the input must NOT move the roving cursor.
    act(() => { fireEvent.keyDown(input, { key: "ArrowDown" }); });
    expect(rovingKeyNow()).toBe(before);
  });

  // T014(b): the focus-movement half of R6 — an arrow keypress must move
  // document.activeElement onto the new roving row's DOM node.
  it("moves document.activeElement onto the roving row after an arrow keypress", () => {
    renderTree();
    const t = tree();
    act(() => { fireEvent.keyDown(t, { key: "ArrowDown" }); }); // → @0
    expect(rovingKeyNow()).toBe("primary:@0");
    const focused = document.activeElement as HTMLElement | null;
    expect(focused).not.toBeNull();
    // The focused element is the @0 window-row treeitem. (data-window-id stays
    // the bare tmux id; the globally-unique roving handle is data-row-key.)
    expect(focused!.getAttribute("data-window-id")).toBe("@0");
    expect(focused!.getAttribute("data-row-key")).toBe("primary:@0");
  });

  // T014(a): the SSE-tick invariant (would have caught MF-1). A passive SSE tick
  // re-renders the tree with a CHANGED sessions Map but the SAME visible-row SET.
  // It must NOT change the roving row and must NOT pull focus into the tree.
  it("a passive SSE tick (changed sessions Map, no keypress) does not change roving or steal focus", () => {
    const { rerender } = renderTree();
    // Initial roving row is the first visible row ("main"); no keypress yet, so
    // focus is NOT in the tree.
    expect(rovingKeyNow()).toBe("primary:main");
    expect(tree().contains(document.activeElement)).toBe(false);

    // Simulate a passive SSE tick: a NEW sessions Map + new window objects (the
    // SSE snapshot is always fresh refs) with the SAME windowId set — only an
    // activity field churns, the visible-row SET is unchanged.
    const ticked: ProjectSession[] = KB_SESSIONS.map((s) => ({
      ...s,
      windows: s.windows.map((w) => ({ ...w, activityTimestamp: w.activityTimestamp + 1 })),
    }));
    act(() => { rerender(treeUI(ticked)); });

    // Roving row + the single tabIndex=0 row are unchanged.
    expect(rovingKeyNow()).toBe("primary:main");
    expect(visibleRows().filter((r) => r.getAttribute("tabindex") === "0").length).toBe(1);
    // Focus was NOT pulled into the tree by the passive tick.
    expect(tree().contains(document.activeElement)).toBe(false);
  });

  // T015 (SF-2): Enter on a REAL window row calls onSelectWindow with the
  // (server, session, windowId) derived from the roving identity — a direct
  // handler call, not a synthesized DOM click.
  it("Enter on a real window row calls onSelectWindow with the roving identity", () => {
    renderTree();
    const t = tree();
    act(() => { fireEvent.keyDown(t, { key: "End" }); }); // → @2 (other's window)
    expect(rovingKeyNow()).toBe("primary:@2");
    act(() => { fireEvent.keyDown(t, { key: "Enter" }); });
    expect(onSelectWindow).toHaveBeenCalledWith("primary", "other", "@2");
  });

  // T015 (SF-3): Enter/Space on a ghost/optimistic window row (key `ghost-…`,
  // empty windowId) is a no-op — no onSelectWindow call.
  it("Enter/Space on a ghost window row does not call onSelectWindow", () => {
    // Seed the window store's real "main" windows FIRST, then add the ghost.
    // The ghost captures @0/@1 in its snapshot, so the mount-time
    // setWindowsForSession sees NO new windowIds and preserves the ghost
    // (ghosts are otherwise consumed when an unknown real window arrives).
    const store = useWindowStore.getState();
    store.setWindowsForSession("primary", "main", KB_SESSIONS[0].windows);
    const ghostId = store.addGhostWindow("primary", "main", "deploying");
    // Roving key is the globally-unique handle: `${server}:ghost-${optimisticId}`.
    const ghostKey = `primary:ghost-${ghostId}`;

    renderTree();
    const t = tree();
    // The ghost row is the last child of "main"'s window group (after @0, @1).
    const ghostRow = visibleRows().find((r) => rowKey(r) === ghostKey);
    expect(ghostRow, "ghost window row should be rendered").toBeTruthy();

    // Walk roving onto the ghost row: main → @0 → @1 → ghost.
    act(() => { fireEvent.keyDown(t, { key: "ArrowDown" }); }); // @0
    act(() => { fireEvent.keyDown(t, { key: "ArrowDown" }); }); // @1
    act(() => { fireEvent.keyDown(t, { key: "ArrowDown" }); }); // ghost
    expect(rovingKeyNow()).toBe(ghostKey);

    act(() => { fireEvent.keyDown(t, { key: "Enter" }); });
    act(() => { fireEvent.keyDown(t, { key: " " }); });
    expect(onSelectWindow).not.toHaveBeenCalled();
  });
});

describe("Sidebar — session-reorder self-target drop acceptance (i41e snap-back fix)", () => {
  // Mirror of use-server-reorder.test.ts's self-target case for the sidebar
  // session-reorder handler (`handleSessionReorderOver`). The bug: a dragover on
  // the dragged row itself bailed BEFORE preventDefault, so HTML5 DnD played the
  // native cancelled-drag snap-back. The fix hoists preventDefault/dropEffect
  // above the self-name check. fireEvent.dragOver returns `false` when the
  // handler called preventDefault() (the event was cancelled), so drop
  // acceptance is observable without stubbing the native method.

  /** A minimal mutable dataTransfer bag, mirroring the hook test's makeDragEvent. */
  function makeDataTransfer(types: string[] = []) {
    const store = new Map<string, string>();
    const t = [...types];
    return {
      setData: (type: string, data: string) => {
        store.set(type, data);
        if (!t.includes(type)) t.push(type);
      },
      getData: (type: string) => store.get(type) ?? "",
      get types() {
        return t;
      },
      dropEffect: "none",
      effectAllowed: "none",
    };
  }

  it("accepts a session-reorder dragover on the dragged row itself (preventDefault called, dropEffect move)", () => {
    // PRIMARY_SESSIONS has one session "main" in the (force-open current)
    // "primary" group, rendered as a draggable row with data-session-row.
    renderSidebar({ currentServer: "primary" });

    const row = document.querySelector('[data-session-row="primary:main"]');
    expect(row).toBeTruthy();

    // dragStart seeds sessionDragSource = { server: "primary", name: "main" }.
    // Shared dataTransfer bag so the dragover sees the session-reorder MIME the
    // start handler wrote.
    const dataTransfer = makeDataTransfer();
    act(() => {
      fireEvent.dragStart(row!, { dataTransfer });
    });
    expect(dataTransfer.types).toContain("application/x-session-reorder");

    // dragover on the SAME row (self-target). The handler must still accept the
    // drop: fireEvent returns false when preventDefault() was called.
    let notPrevented: boolean;
    act(() => {
      notPrevented = fireEvent.dragOver(row!, { dataTransfer });
    });
    expect(notPrevented!).toBe(false); // preventDefault() was called → drop accepted
    expect(dataTransfer.dropEffect).toBe("move");
  });

  it("does not accept a session-reorder dragover before any drag started (source guard)", () => {
    renderSidebar({ currentServer: "primary" });
    const row = document.querySelector('[data-session-row="primary:main"]');
    expect(row).toBeTruthy();

    // No dragStart → sessionDragSource is null → the source guard rejects before
    // acceptance (no preventDefault).
    const dataTransfer = makeDataTransfer(["application/x-session-reorder"]);
    let notPrevented: boolean;
    act(() => {
      notPrevented = fireEvent.dragOver(row!, { dataTransfer });
    });
    expect(notPrevented!).toBe(true); // default NOT prevented → not accepted
  });
});

describe("Sidebar — window drag-to-pin marker MIME (g0t1)", () => {
  /** A minimal mutable dataTransfer bag, mirroring the session-reorder block. */
  function makeDataTransfer(types: string[] = []) {
    const store = new Map<string, string>();
    const t = [...types];
    return {
      setData: (type: string, data: string) => {
        store.set(type, data);
        if (!t.includes(type)) t.push(type);
      },
      getData: (type: string) => store.get(type) ?? "",
      get types() {
        return t;
      },
      dropEffect: "none",
      effectAllowed: "none",
    };
  }

  function windowRow(): HTMLElement {
    const row = document.querySelector('[data-window-id="@0"]');
    expect(row).toBeTruthy();
    return row as HTMLElement;
  }

  it("window drag start sets the x-window-drag marker MIME and widens effectAllowed to copyMove", () => {
    renderSidebar({ currentServer: "primary" });

    const dataTransfer = makeDataTransfer();
    act(() => {
      fireEvent.dragStart(windowRow(), { dataTransfer });
    });

    // Marker for foreign drop targets (board rows) rides alongside the existing
    // JSON payload, which keeps its {server, session, index, windowId, name}
    // shape so the reorder/move handlers stay untouched.
    expect(dataTransfer.types).toContain("application/x-window-drag");
    expect(dataTransfer.types).toContain("application/json");
    expect(dataTransfer.getData("application/x-window-drag")).toBe("@0");
    expect(JSON.parse(dataTransfer.getData("application/json"))).toEqual({
      server: "primary",
      session: "main",
      index: 0,
      windowId: "@0",
      name: "shell",
    });
    // Widened from "move" so board rows can offer the copy (link) cursor.
    expect(dataTransfer.effectAllowed).toBe("copyMove");
  });

  it("within-session reorder dragover still accepts with dropEffect move", () => {
    renderSidebar({ currentServer: "primary" });
    const row = windowRow();

    const dataTransfer = makeDataTransfer();
    act(() => {
      fireEvent.dragStart(row, { dataTransfer });
    });

    // Self-target dragover (single-window session): the reorder handler accepts
    // with a move cursor — unchanged under the widened "copyMove" allowance.
    let notPrevented: boolean;
    act(() => {
      notPrevented = fireEvent.dragOver(row, { dataTransfer });
    });
    expect(notPrevented!).toBe(false); // preventDefault() was called → accepted
    expect(dataTransfer.dropEffect).toBe("move");
  });
});

describe("BottomPanels — board-route focused-pane fallback + HOST dot (zx4i)", () => {
  // Sessions live on server "boardsrv" (NOT the current server — the board
  // route has currentServer=null). The enriched window @9 carries fab data the
  // thin fallback could never synthesize, so its presence proves the lookup hit.
  const BOARD_SESSIONS: ProjectSession[] = [
    {
      name: "home",
      windows: [
        {
          index: 0,
          windowId: "@9",
          name: "pinned-live",
          worktreePath: "/home/u/code/live",
          activity: "idle",
          isActiveWindow: false,
          activityTimestamp: 0,
          fabChange: "260720-zx4i-board-route-pane-host-panels",
          fabStage: "apply",
          panes: [
            {
              paneId: "%77",
              paneIndex: 0,
              cwd: "/home/u/code/live",
              command: "zsh",
              isActive: true,
              gitBranch: "zx4i-branch",
            },
          ],
        },
      ],
    },
  ];

  const boardServers = [{ name: "boardsrv", sessionCount: 1 }];
  const boardSessionsMap = new Map([["boardsrv", BOARD_SESSIONS]]);

  function paneHeader(): HTMLElement {
    return screen.getByRole("button", { name: /^Pane/ });
  }

  // Panels are visibility-gated per section (iha5 R5) with BOTH defaulting
  // off — the 260814-ldbs drawer-only fork became a DEFAULT, not a hard
  // `isMobile` gate. These tests exercise the panels themselves, so they opt
  // both sections in via the persisted keys. They still force the mobile
  // viewport (the drawer's panel layout is the canonical home); the
  // desktop-opt-in case lives in the section-visibility gating suite below.
  // The file-default non-mobile stub is restored afterwards so the override
  // never leaks into later suites.
  function stubMobilePanels() {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches:
          query.includes("prefers-color-scheme: dark") ||
          query.includes("max-width") ||
          query.includes("pointer: coarse"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
      })),
    );
  }
  beforeEach(() => {
    stubMobilePanels();
    localStorage.setItem("hexokit-sidebar-section-pane", "true");
    localStorage.setItem("hexokit-sidebar-section-host", "true");
  });
  afterEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("prefers-color-scheme: dark"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
      })),
    );
  });

  it("renders NO PANE/HOST panels under the DEFAULT section visibility (both default off — the drawer-only fork is now a default, iha5 R5)", () => {
    // Drop this block's opt-in seeds to exercise the defaults: with nothing
    // stored, neither panel mounts even in the mobile drawer (the drawer's
    // default is pure nav + footer).
    localStorage.removeItem("hexokit-sidebar-section-pane");
    localStorage.removeItem("hexokit-sidebar-section-host");
    renderSidebar({
      currentServer: null,
      servers: boardServers,
      sessionsByServer: boardSessionsMap,
      focusedPane: null,
      hostMetrics: null,
    });
    expect(screen.queryByRole("button", { name: /^Pane/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Host/ })).not.toBeInTheDocument();
    expect(screen.queryByText("No tab selected")).not.toBeInTheDocument();
  });

  it("renders the ENRICHED home-session copy when the focused pane resolves by windowId", () => {
    renderSidebar({
      currentServer: null,
      servers: boardServers,
      sessionsByServer: boardSessionsMap,
      focusedPane: {
        server: "boardsrv",
        windowId: "@9",
        windowName: "pinned-live",
        panes: [
          { paneId: "%77", paneIndex: 0, cwd: "/tmp/thin", command: "zsh", isActive: true },
        ],
      },
    });
    expect(screen.queryByText("No tab selected")).not.toBeInTheDocument();
    // The fab register renders — only the enriched SSE copy carries fabChange,
    // so this proves the windowId lookup (not the thin fallback) supplied it.
    // The key line carries the decisive tokens; the slug rides the
    // continuation line (the enriched copy's branch does not carry it).
    expect(screen.getByText("zx4i · apply")).toBeInTheDocument();
    expect(screen.getByTestId("fab-line-cont")).toHaveTextContent("board-route-pane-host-panels");
    // Identity from the enriched copy, not the thin panes (cwd differs:
    // /home/u/code/live vs the thin pane's /tmp/thin). The cwd row renders its
    // value as two spans (dim parent + basename), so assert on the row's
    // `title`, which carries the full path, and on the basename span.
    expect(screen.getByTitle("/home/u/code/live")).toBeInTheDocument();
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.queryByTitle("/tmp/thin")).not.toBeInTheDocument();
  });

  it("thin-renders from the board entry's panes when the lookup misses (pin-only window)", () => {
    renderSidebar({
      currentServer: null,
      servers: boardServers,
      sessionsByServer: boardSessionsMap,
      focusedPane: {
        server: "boardsrv",
        windowId: "@404", // absent from BOARD_SESSIONS
        windowName: "pin-only",
        panes: [
          {
            paneId: "%88",
            paneIndex: 0,
            cwd: "/srv/pin-only",
            command: "vim",
            isActive: true,
            gitBranch: "orphan-branch",
          },
        ],
      },
    });
    expect(screen.queryByText("No tab selected")).not.toBeInTheDocument();
    // Identity rows from the entry's own pane data.
    expect(paneHeader().textContent).toContain("pin-only");
    expect(screen.getByText(/%88/)).toBeInTheDocument();
    expect(screen.getByText("orphan-branch")).toBeInTheDocument();
    // Enrichment-only registers honestly absent.
    expect(screen.queryByTestId("register-agent")).not.toBeInTheDocument();
    expect(screen.queryByText(/· apply/)).not.toBeInTheDocument();
  });

  it("never falls back to the focused pane on a server route (unresolved route window)", () => {
    // Server route (currentServer set) whose route window can't resolve yet —
    // the sessions snapshot hasn't arrived (empty list). A stale focused pane
    // is still published (clear-on-unmount lands a commit later). The PANE
    // panel must show the empty state, NOT the board-focused window: the
    // fallback is gated on the board route itself, not on `!routeWindow`.
    renderSidebar({
      currentServer: "primary",
      servers: [{ name: "primary", sessionCount: 0 }, ...boardServers],
      sessionsByServer: new Map([["primary", []], ["boardsrv", BOARD_SESSIONS]]),
      focusedPane: {
        server: "boardsrv",
        windowId: "@9",
        windowName: "pinned-live",
        panes: [
          { paneId: "%77", paneIndex: 0, cwd: "/tmp/thin", command: "zsh", isActive: true },
        ],
      },
    });
    expect(screen.getByText("No tab selected")).toBeInTheDocument();
    expect(paneHeader().textContent).not.toContain("pinned-live");
  });

  it("keeps 'No tab selected' when no focused pane is published (empty board)", () => {
    renderSidebar({
      currentServer: null,
      servers: boardServers,
      sessionsByServer: boardSessionsMap,
      focusedPane: null,
    });
    expect(screen.getByText("No tab selected")).toBeInTheDocument();
  });

  const HOST_METRICS: MetricsSnapshot = {
    hostname: "board-host",
    cpu: { samples: [10], current: 10, cores: 4 },
    memory: { used: 1024 ** 3, total: 8 * 1024 ** 3 },
    load: { avg1: 0.1, avg5: 0.1, avg15: 0.1, cpus: 4 },
    disk: { used: 10 * 1024 ** 3, total: 100 * 1024 ** 3 },
    uptime: 60,
  };

  it("HOST panel fills from the host-global broadcast on the board route, with no connection dot", () => {
    renderSidebar({
      currentServer: null,
      servers: boardServers,
      sessionsByServer: boardSessionsMap,
      focusedPane: null,
      hostMetrics: HOST_METRICS,
    });
    // The host-global fallback fills the panel (no server-scoped metrics on a
    // board route). The HOST header carries no connection dot — the sidebar
    // FOOTER dot owns the per-page signal (260724-6j1v).
    expect(screen.getByText("board-host")).toBeInTheDocument();
    expect(screen.queryByText("No metrics")).not.toBeInTheDocument();
    expect(screen.queryByTitle(/SSE (dis)?connected/)).not.toBeInTheDocument();
  });
});

describe("BottomPanels — opr register owning-session lookup", () => {
  // The `opr` register's stale/tick facts live on the OWNING SESSION
  // (`operatorStale` / `operatorLastTickAt`), threaded to the PANE panel via
  // routeSession on a server route and via the focused-pane fallbackSession
  // lookup on a board route. The StatusPanel unit tests inject `operator`
  // directly, so these cases cover the selection seam itself.
  const tickSecsAgo = (secs: number) => Math.floor(Date.now() / 1000) - secs;

  function stubMobilePanels() {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches:
          query.includes("prefers-color-scheme: dark") ||
          query.includes("max-width") ||
          query.includes("pointer: coarse"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
      })),
    );
  }
  afterEach(() => {
    stubMatchMedia((query) => query.includes("prefers-color-scheme: dark"));
  });

  it("server route: the route session's stale/tick facts land on the opr register", () => {
    localStorage.setItem("hexokit-sidebar-section-pane", "true");
    const sessions: ProjectSession[] = [
      {
        name: "main",
        operatorStale: true,
        operatorLastTickAt: tickSecsAgo(120),
        windows: [
          {
            index: 0,
            windowId: "@0",
            name: "shell",
            worktreePath: "~/code/run-kit",
            activity: "active",
            isActiveWindow: true,
            paneCommand: "zsh",
            activityTimestamp: tickSecsAgo(0),
            monitored: true,
            monitoredStage: "apply",
          },
        ],
      },
    ];
    renderSidebar({
      sessionsByServer: new Map([["primary", sessions], ["alpha", []], ["beta", []]]),
    });
    const opr = screen.getByTestId("register-operator");
    expect(opr).toHaveTextContent(/^opr watched · apply · tick \d+m ago$/);
    expect(opr).toHaveAttribute("data-stale", "true");
  });

  it("board route: the focused pane's home session supplies fresh tick facts (no stale mark)", () => {
    stubMobilePanels();
    localStorage.setItem("hexokit-sidebar-section-pane", "true");
    const sessions: ProjectSession[] = [
      {
        name: "home",
        operatorStale: false,
        operatorLastTickAt: tickSecsAgo(45),
        windows: [
          {
            index: 0,
            windowId: "@9",
            name: "watched-win",
            worktreePath: "/home/u/code/live",
            activity: "idle",
            isActiveWindow: false,
            activityTimestamp: 0,
            monitored: true,
            monitoredStage: "review",
            panes: [
              { paneId: "%77", paneIndex: 0, cwd: "/home/u/code/live", command: "zsh", isActive: true },
            ],
          },
        ],
      },
    ];
    renderSidebar({
      currentServer: null,
      servers: [{ name: "boardsrv", sessionCount: 1 }],
      sessionsByServer: new Map([["boardsrv", sessions]]),
      focusedPane: {
        server: "boardsrv",
        windowId: "@9",
        windowName: "watched-win",
        panes: [
          { paneId: "%77", paneIndex: 0, cwd: "/tmp/thin", command: "zsh", isActive: true },
        ],
      },
    });
    const opr = screen.getByTestId("register-operator");
    expect(opr).toHaveTextContent(/^opr watched · review · tick \d+s ago$/);
    expect(opr.getAttribute("data-stale")).toBeNull();
  });

  it("omits the register's tick segment when the owning session never ticked", () => {
    localStorage.setItem("hexokit-sidebar-section-pane", "true");
    const sessions: ProjectSession[] = [
      {
        name: "main",
        windows: [
          {
            index: 0,
            windowId: "@0",
            name: "shell",
            worktreePath: "~/code/run-kit",
            activity: "active",
            isActiveWindow: true,
            paneCommand: "zsh",
            activityTimestamp: tickSecsAgo(0),
            monitored: true,
          },
        ],
      },
    ];
    renderSidebar({
      sessionsByServer: new Map([["primary", sessions], ["alpha", []], ["beta", []]]),
    });
    const opr = screen.getByTestId("register-operator");
    expect(opr).toHaveTextContent(/^opr watched$/);
    expect(opr.getAttribute("data-stale")).toBeNull();
  });
});

describe("Sidebar — section-visibility rail + gating (iha5)", () => {
  const railToggle = (name: string) =>
    screen.getByRole("button", { name: `Toggle ${name} section` });
  const paneHeader = () => screen.queryByRole("button", { name: /^Pane/ });
  const hostHeader = () => screen.queryByRole("button", { name: /^Host/ });
  const boardsHeader = () => screen.queryByRole("button", { name: /^Boards/ });
  const serverHeader = () => screen.queryByRole("button", { name: /^Server/ });

  function stubMobileViewport() {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches:
          query.includes("prefers-color-scheme: dark") ||
          query.includes("max-width") ||
          query.includes("pointer: coarse"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
      })),
    );
  }
  function stubDesktopViewport() {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("prefers-color-scheme: dark"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
      })),
    );
  }
  afterEach(() => {
    stubDesktopViewport();
  });

  it("default render matches the pre-rail behavior: rail + Boards + Server present, Pane/Host absent", () => {
    renderSidebar();
    expect(screen.getByTestId("section-rail")).toBeInTheDocument();
    expect(railToggle("Boards").getAttribute("aria-pressed")).toBe("true");
    expect(railToggle("Servers").getAttribute("aria-pressed")).toBe("true");
    expect(railToggle("Pane").getAttribute("aria-pressed")).toBe("false");
    expect(railToggle("Host").getAttribute("aria-pressed")).toBe("false");
    expect(boardsHeader()).toBeInTheDocument();
    expect(serverHeader()).toBeInTheDocument();
    expect(paneHeader()).not.toBeInTheDocument();
    expect(hostHeader()).not.toBeInTheDocument();
  });

  it("mobile drawer defaults to pure nav + footer (no PANE/HOST panels)", () => {
    stubMobileViewport();
    renderSidebar();
    expect(paneHeader()).not.toBeInTheDocument();
    expect(hostHeader()).not.toBeInTheDocument();
    // The footer keeps its own isMobile gate (NOT a toggleable section).
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("mounts PANE + HOST on the DESKTOP sidebar when their sections are toggled on (opt-in return of the ldbs panels)", () => {
    localStorage.setItem("hexokit-sidebar-section-pane", "true");
    localStorage.setItem("hexokit-sidebar-section-host", "true");
    renderSidebar();
    expect(paneHeader()).toBeInTheDocument();
    expect(hostHeader()).toBeInTheDocument();
  });

  it("rail toggle fully unmounts/remounts a section (Boards header gone, then back)", () => {
    renderSidebar();
    fireEvent.click(railToggle("Boards"));
    expect(boardsHeader()).not.toBeInTheDocument();
    expect(localStorage.getItem("hexokit-sidebar-section-boards")).toBe("false");
    fireEvent.click(railToggle("Boards"));
    expect(boardsHeader()).toBeInTheDocument();
  });

  it("collapse state survives a visibility round-trip untouched", () => {
    localStorage.setItem("hexokit-sidebar-section-pane", "true");
    renderSidebar();
    const header = paneHeader()!;
    expect(header.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(header); // collapse via the chevron
    expect(localStorage.getItem("hexokit-panel-window")).toBe("false");

    const toggle = railToggle("Pane");
    fireEvent.click(toggle); // section off — fully unmounts
    expect(paneHeader()).not.toBeInTheDocument();
    // The collapse storage key is NOT touched by visibility toggling.
    expect(localStorage.getItem("hexokit-panel-window")).toBe("false");

    fireEvent.click(toggle); // section on — remounts exactly as left
    expect(paneHeader()!.getAttribute("aria-expanded")).toBe("false");
  });

  it("ignores a stored hexokit-sidebar-section-clock value (retired section — no panel, no rail toggle, no error)", () => {
    localStorage.setItem("hexokit-sidebar-section-clock", "true");
    renderSidebar();
    expect(screen.queryByRole("button", { name: /^Clock/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Toggle Clock section" })).not.toBeInTheDocument();
  });
});

describe("Sidebar — tinted server-group header fill (t1ca)", () => {
  // Variant D: each SESSIONS-pane server-group header is a filled bar carrying
  // the server's color, resolved through the SAME precomputed maps the SERVER
  // panel tiles use (computeRowTints/computeRowBorders — dual-keyed under
  // family names and legacy descriptors). Expected values are computed from
  // the default dark theme (the theme the jsdom matchMedia stub resolves), so
  // no hex is hardcoded here either.
  const palette = DEFAULT_DARK_THEME.palette;
  const tints = computeRowTints(palette, deriveUIColors(palette, DEFAULT_DARK_THEME.category).bgChrome);
  const borders = computeRowBorders(palette, DEFAULT_DARK_THEME.category);

  /** jsdom normalizes inline style colors to `rgb(r, g, b)`. */
  function rgb(hex: string): string {
    const h = hex.replace("#", "");
    return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
  }

  function headerContainer(server: string): HTMLElement {
    const el = document.querySelector<HTMLElement>(`[data-server='${server}']`);
    expect(el, `header container for ${server}`).toBeTruthy();
    return el!;
  }

  function toggleButton(server: string): HTMLElement {
    return within(headerContainer(server)).getByRole("button", {
      name: new RegExp(`(Collapse|Expand) ${server} sessions`),
    });
  }

  /** Render and flush the getAllServerColors effect promise. */
  async function renderWithColors(colors: Record<string, string>, currentServer = "primary") {
    vi.mocked(getAllServerColors).mockResolvedValue(colors);
    renderSidebar({ currentServer });
    await act(async () => {});
  }

  afterEach(() => {
    // Restore the file-default empty color map so this block's colors never
    // leak into other suites.
    vi.mocked(getAllServerColors).mockResolvedValue({});
  });

  it("colored non-current header carries the base tint fill, accent text, and accent top border", async () => {
    await renderWithColors({ alpha: "4" });

    const container = headerContainer("alpha");
    expect(container.style.backgroundColor).toBe(rgb(tints.get("4")!.base));
    expect(container.style.borderTopWidth).toBe("1px");
    expect(container.style.borderTopColor).toBe(rgb(borders.get("4")!));

    // Header text is the contrast-guarded accent, not text-secondary classes.
    const button = toggleButton("alpha");
    expect(button.style.color).toBe(rgb(borders.get("4")!));
    expect(button.className).not.toContain("text-text-primary");
  });

  it("current server reads deeper: selected tint fill + text-text-primary (no inline accent)", async () => {
    await renderWithColors({ primary: "4", alpha: "1" });

    // Current server: deeper selected shade + brightest text.
    const current = headerContainer("primary");
    expect(current.style.backgroundColor).toBe(rgb(tints.get("4")!.selected));
    const currentButton = toggleButton("primary");
    expect(currentButton.className).toContain("text-text-primary");
    expect(currentButton.style.color).toBe("");

    // Non-current sits at base with accent text — the strength distinction.
    expect(headerContainer("alpha").style.backgroundColor).toBe(rgb(tints.get("1")!.base));
    expect(toggleButton("alpha").style.color).toBe(rgb(borders.get("1")!));
  });

  it("uncolored server falls back to the gray sentinel with the same heavier treatment", async () => {
    await renderWithColors({}); // no colors assigned at all

    const container = headerContainer("beta");
    const grayTint = tints.get(UNCOLORED_SELECTED_KEY)!;
    const grayBorder = borders.get(UNCOLORED_SELECTED_KEY)!;
    expect(container.style.backgroundColor).toBe(rgb(grayTint.base));
    expect(container.style.borderTopColor).toBe(rgb(grayBorder));

    // Identical heavier element class: taller header, weight 600, coarse floor.
    const button = toggleButton("beta");
    expect(button.className).toContain("min-h-[26px]");
    expect(button.className).toContain("coarse:min-h-[28px]");
    expect(button.className).toContain("font-semibold");
  });

  it("unrecognized color descriptors degrade to the gray sentinel, never an unstyled header", async () => {
    await renderWithColors({ alpha: "bogus-color" });

    const container = headerContainer("alpha");
    expect(container.style.backgroundColor).toBe(rgb(tints.get(UNCOLORED_SELECTED_KEY)!.base));
    expect(container.style.borderTopColor).toBe(rgb(borders.get(UNCOLORED_SELECTED_KEY)!));
  });

  it("non-current header deepens to the hover shade on mouseenter and restores on leave; current stays flat", async () => {
    await renderWithColors({ primary: "4", alpha: "1" });

    const alpha = headerContainer("alpha");
    fireEvent.mouseEnter(alpha);
    expect(alpha.style.backgroundColor).toBe(rgb(tints.get("1")!.hover));
    fireEvent.mouseLeave(alpha);
    expect(alpha.style.backgroundColor).toBe(rgb(tints.get("1")!.base));

    // Current server: no hover swap — selected is already the deepest shade.
    const primary = headerContainer("primary");
    fireEvent.mouseEnter(primary);
    expect(primary.style.backgroundColor).toBe(rgb(tints.get("4")!.selected));
  });

  it("keeps header semantics: aria labels and expand/collapse on the tinted bar", async () => {
    await renderWithColors({ alpha: "4" });

    // Toggle still works on the tinted header.
    const toggle = screen.getByRole("button", { name: /Expand alpha sessions/ });
    fireEvent.click(toggle);
    expect(
      screen.getByRole("button", { name: /Collapse alpha sessions/ }),
    ).toHaveAttribute("aria-expanded", "true");

    // New session lives on the header's flyout card now — no in-header + button.
    expect(
      within(headerContainer("alpha")).queryByRole("button", { name: "New session on alpha" }),
    ).toBeNull();
  });
});

describe("Sidebar — server-group header card + color picker (x4sf)", () => {
  // The header's server actions live in the shared flyout card (fine-pointer
  // hover/focus + coarse rail): Change color… opens the portalled
  // SwatchPopover on the shared onServerColorChange seam, Kill server rides
  // the lifted onKillServer confirmation flow. Queries are scoped WITHIN the
  // header container ([data-server]) because the SERVER-panel tiles carry the
  // same aria wording for the same actions.
  const palette = DEFAULT_DARK_THEME.palette;
  const tints = computeRowTints(palette, deriveUIColors(palette, DEFAULT_DARK_THEME.category).bgChrome);

  /** jsdom normalizes inline style colors to `rgb(r, g, b)`. */
  function rgb(hex: string): string {
    const h = hex.replace("#", "");
    return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
  }

  function headerContainer(server: string): HTMLElement {
    const el = document.querySelector<HTMLElement>(`[data-server='${server}']`);
    expect(el, `header container for ${server}`).toBeTruthy();
    return el!;
  }

  /** Render and flush the getAllServerColors effect promise. */
  async function renderWithColors(
    colors: Record<string, string>,
    opts: { currentServer?: string; onKillServer?: (name: string) => void } = {},
  ) {
    vi.mocked(getAllServerColors).mockResolvedValue(colors);
    renderSidebar({ currentServer: opts.currentServer ?? "primary", onKillServer: opts.onKillServer });
    await act(async () => {});
  }

  /** Open the server card on a fine pointer (keyboard focus opens
   *  immediately — no hover-delay timer to drive) and click its Change
   *  color… row: the close-then-open handoff to the header's popover. */
  function openColorPickerViaCard(server: string) {
    act(() => {
      fireEvent.focus(headerContainer(server));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("row-flyout-color-action"));
    });
  }

  afterEach(() => {
    // Restore the file-default mocks so this block's state never leaks.
    vi.mocked(getAllServerColors).mockResolvedValue({});
    vi.mocked(setServerColor).mockClear();
    resetFlyoutWarmState();
  });

  it("renders no hover action cluster in the header — the collapse toggle is its only button", async () => {
    await renderWithColors({ alpha: "4" });

    const container = headerContainer("alpha");
    const buttons = within(container).getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName(/(Expand|Collapse) alpha sessions/);
    // The palette/plus/close cluster is retired on every pointer class — its
    // actions are card rows now.
    expect(within(container).queryByRole("button", { name: "Set color for server alpha" })).toBeNull();
    expect(within(container).queryByRole("button", { name: "New session on alpha" })).toBeNull();
    expect(within(container).queryByRole("button", { name: "Kill server alpha" })).toBeNull();
  });

  it("header focus opens the server card on a fine pointer — title, facts, action rows; the group never toggles", async () => {
    await renderWithColors({ alpha: "4" });

    act(() => {
      fireEvent.focus(headerContainer("alpha"));
    });
    const card = screen.getByTestId("row-flyout-card");
    expect(screen.getByTestId("popup-title-bar")).toHaveTextContent("Server alpha");
    // alpha has no sessions in the default map.
    expect(card).toHaveTextContent("tmux -L alpha · 0 sessions");
    expect(screen.getByTestId("row-flyout-color-action")).toHaveTextContent("Change color…");
    expect(screen.getByTestId("row-flyout-create-action")).toHaveTextContent("New session");
    expect(screen.getByTestId("row-flyout-kill-action")).toHaveTextContent("Kill server");
    // Opening the card does not toggle the group.
    expect(
      within(headerContainer("alpha")).getByRole("button", { name: /Expand alpha sessions/ }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("the card's Change color… row opens the color + flair SwatchPopover portalled to document.body", async () => {
    await renderWithColors({ alpha: "4" });

    const container = headerContainer("alpha");
    openColorPickerViaCard("alpha");

    // The card closed on the handoff, and the label picker (color + flair) —
    // distinguished from the SERVER panel's role=listbox tile grid by its
    // accessible name — opened portalled: it escapes the header (and the
    // sessions list's overflow clip).
    expect(screen.queryByTestId("row-flyout-card")).toBeNull();
    const popover = screen.getByRole("listbox", { name: "Label picker" });
    expect(container.contains(popover)).toBe(false);
    expect(document.body.contains(popover)).toBe(true);
  });

  it("a swatch pick funnels through the shared seam: optimistic tint repaint + POST, popover stays open (live toggling)", async () => {
    await renderWithColors({}); // alpha starts uncolored (gray sentinel)

    const container = headerContainer("alpha");
    expect(container.style.backgroundColor).toBe(rgb(tints.get(UNCOLORED_SELECTED_KEY)!.base));

    openColorPickerViaCard("alpha");
    const popover = screen.getByRole("listbox", { name: "Label picker" });
    fireEvent.click(within(popover).getByRole("option", { name: "Color blue" }));

    // The single write seam maps the family to its legacy descriptor ("4")
    // and the shared handler POSTs + repaints the header tint optimistically
    // (non-current ⇒ base shade) without waiting for any poll.
    expect(vi.mocked(setServerColor)).toHaveBeenCalledExactlyOnceWith("alpha", "4");
    expect(container.style.backgroundColor).toBe(rgb(tints.get("4")!.base));
    // Selection does NOT dismiss (the picker's dismissal contract) — the ✕
    // cell is the explicit close, so tint combos can be compared live.
    expect(screen.getByRole("listbox", { name: "Label picker" })).toBeInTheDocument();
    fireEvent.click(within(popover).getByLabelText("Close picker"));
    expect(screen.queryByRole("listbox", { name: "Label picker" })).not.toBeInTheDocument();
  });

  it("Clear clears the optimistic entry back to the gray sentinel and POSTs null", async () => {
    await renderWithColors({ alpha: "4" });

    const container = headerContainer("alpha");
    expect(container.style.backgroundColor).toBe(rgb(tints.get("4")!.base));

    openColorPickerViaCard("alpha");
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Label picker" })).getByRole("option", {
        name: "Clear color",
      }),
    );

    expect(vi.mocked(setServerColor)).toHaveBeenCalledExactlyOnceWith("alpha", null);
    expect(container.style.backgroundColor).toBe(rgb(tints.get(UNCOLORED_SELECTED_KEY)!.base));
  });

  it("the card's Kill server row invokes the lifted onKillServer prop (confirmation is the parent's)", async () => {
    const onKillServer = vi.fn();
    await renderWithColors({ alpha: "4" }, { onKillServer });

    act(() => {
      fireEvent.focus(headerContainer("alpha"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("row-flyout-kill-action"));
    });

    expect(onKillServer).toHaveBeenCalledExactlyOnceWith("alpha");
    // No sidebar-owned dialog: the kill confirmation lives in the layout-
    // mounted ServerDialogs (server-dialogs-context `killServerTarget`,
    // 260811-239r), so nothing renders here.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the toggle dominant and the existing header semantics intact", async () => {
    await renderWithColors({ alpha: "4" });

    const container = headerContainer("alpha");
    const toggle = within(container).getByRole("button", { name: /Expand alpha sessions/ });
    expect(toggle.className).toContain("flex-1");
    fireEvent.click(toggle);
    expect(
      within(container).getByRole("button", { name: /Collapse alpha sessions/ }),
    ).toHaveAttribute("aria-expanded", "true");
  });
});

describe("Sidebar — server flair (group header + picker band)", () => {
  function headerContainer(server: string): HTMLElement {
    const el = document.querySelector<HTMLElement>(`[data-server='${server}']`);
    expect(el, `header container for ${server}`).toBeTruthy();
    return el!;
  }

  /** Render and flush both settings fetches (server colors + server flairs). */
  async function renderWithFlairs(flairs: Record<string, string>, currentServer = "primary") {
    vi.mocked(getAllServerFlairs).mockResolvedValue(flairs);
    renderSidebar({ currentServer });
    await act(async () => {});
    await act(async () => {});
  }

  /** Open the header's picker via the server card's Change color… row
   *  (fine-pointer focus opens the card immediately). */
  function openPickerViaCard(server: string) {
    act(() => {
      fireEvent.focus(headerContainer(server));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("row-flyout-color-action"));
    });
  }

  afterEach(() => {
    // Restore the file-default empty flair map so this block's state never leaks.
    vi.mocked(getAllServerFlairs).mockResolvedValue({});
    vi.mocked(setServerFlair).mockClear();
    resetFlyoutWarmState();
  });

  it("mounts a FlairOverlay (rk-flair-*) on a flaired server's group header, none on an unflaired one", async () => {
    await renderWithFlairs({ alpha: "matrix" });

    const alphaHeader = headerContainer("alpha");
    const flair = alphaHeader.querySelector(".rk-flair-matrix");
    expect(flair).not.toBeNull();
    expect(flair).toHaveAttribute("aria-hidden", "true");

    expect(headerContainer("beta").querySelector("[class*='rk-flair-']")).toBeNull();
  });

  it("the header overlay carries the guarded accent as --rk-flair-color when the server is colored", async () => {
    vi.mocked(getAllServerColors).mockResolvedValue({ alpha: "4" });
    await renderWithFlairs({ alpha: "rain" });

    const flair = headerContainer("alpha").querySelector<HTMLElement>(".rk-flair-rain")!;
    expect(flair).not.toBeNull();
    // jsdom normalizes inline hex to rgb() in the reflected custom property.
    expect(flair.style.getPropertyValue("--rk-flair-color")).not.toBe("");
  });

  it("the server picker renders the flair band (16 live cells) and a flair pick POSTs + mounts the overlay optimistically", async () => {
    await renderWithFlairs({}); // alpha starts unflaired

    openPickerViaCard("alpha");
    const popover = screen.getByRole("listbox", { name: "Label picker" });

    // The flair band is present — the 16 named states as data-flair-value cells.
    const cells = popover.querySelectorAll("[data-flair-value]");
    expect(cells).toHaveLength(16);
    expect(popover.querySelector("[data-flair-value='ironman']")).not.toBeNull();

    fireEvent.click(within(popover).getByRole("option", { name: "Flair cube" }));

    // Optimistic mount + POST through the shared seam; the popover stays open
    // (the dismissal contract).
    expect(headerContainer("alpha").querySelector(".rk-flair-cube")).not.toBeNull();
    expect(vi.mocked(setServerFlair)).toHaveBeenCalledExactlyOnceWith("alpha", "cube");
    expect(screen.getByRole("listbox", { name: "Label picker" })).toBeInTheDocument();
  });

  it("the flair band's − header cell clears: POSTs null and unmounts the overlay", async () => {
    await renderWithFlairs({ alpha: "nyan" });
    expect(headerContainer("alpha").querySelector(".rk-flair-nyan")).not.toBeNull();

    openPickerViaCard("alpha");
    const popover = screen.getByRole("listbox", { name: "Label picker" });
    fireEvent.click(within(popover).getByRole("option", { name: "Flair none" }));

    expect(vi.mocked(setServerFlair)).toHaveBeenCalledExactlyOnceWith("alpha", null);
    expect(headerContainer("alpha").querySelector("[class*='rk-flair-']")).toBeNull();
  });

  it("a failed POST surfaces a toast and keeps the optimistic overlay", async () => {
    vi.mocked(setServerFlair).mockRejectedValueOnce(new Error("nope"));
    await renderWithFlairs({});

    openPickerViaCard("alpha");
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Label picker" })).getByRole("option", { name: "Flair rain" }),
    );

    expect(headerContainer("alpha").querySelector(".rk-flair-rain")).not.toBeNull();
    // The toast region renders the failure message (aria-live polite region).
    expect(await screen.findByText("nope")).toBeInTheDocument();
  });
});

// Server-group rail + server card (260817-ve5m): the rail extends the one
// continuous strip to the group headers and its tap/scrub triggers the same
// card fine-pointer hover/focus opens; the card carries the title/facts/action
// rows bound to the existing onCreateSession/onKillServer/color seams. jsdom
// evaluates no media queries,
// so the pointer is stubbed and geometry is asserted as classes/inline styles.
describe("Sidebar — server-group rail + server card (260817-ve5m)", () => {
  function headerContainer(server: string): HTMLElement {
    const el = document.querySelector<HTMLElement>(`[data-server='${server}']`);
    expect(el, `header container for ${server}`).toBeTruthy();
    return el!;
  }

  /** Coarse pointer + dark scheme (ThemeProvider/SwatchPopover need the
   *  color-scheme query answered too). */
  function stubCoarse() {
    stubMatchMedia((q) => q.includes("pointer: coarse") || q.includes("prefers-color-scheme: dark"));
  }

  beforeEach(() => {
    resetFlyoutWarmState();
    stubCoarse();
  });
  afterEach(() => {
    // Restore the file-default desktop stub + clear the flyout coordinator.
    stubMatchMedia((q) => q.includes("prefers-color-scheme: dark"));
    resetFlyoutWarmState();
  });

  function tapRail(server: string) {
    act(() => {
      fireEvent.pointerDown(within(headerContainer(server)).getByTestId("status-rail"), {
        pointerId: 1,
        pointerType: "touch",
      });
    });
  }

  it("renders the 56px tier-tinted rail on the group header and no cluster buttons on coarse", async () => {
    vi.mocked(getAllServerColors).mockResolvedValue({ alpha: "4" });
    renderSidebar();
    await act(async () => {});
    try {
      const container = headerContainer("alpha");
      const rail = within(container).getByTestId("status-rail");
      expect(rail.style.width).toBe("56px");
      expect(rail.className).toContain("bg-bg-inset");
      expect(rail.className).toContain("border-l");
      expect(rail.className).toContain("touch-none");
      // Per-tier band tint: the header's family tint mixed into the inset base.
      expect(rail.style.backgroundColor).toContain("color-mix(in srgb, var(--color-bg-inset) 55%");
      // Empty 16px glyph slot + muted 12px chevron (column-aligned with the
      // window/session rails).
      const chevron = Array.from(rail.querySelectorAll("span")).find((s) => s.textContent === "›")!;
      expect(chevron.className).toContain("w-3");
      const glyphSlot = chevron.previousElementSibling as HTMLElement;
      expect(glyphSlot.className).toContain("w-4");
      expect(glyphSlot.children).toHaveLength(0);
      // The header carries the shared scrub hit-test handle (it is NOT a
      // treeitem — the attribute route is what covers this tier's shape).
      expect(container).toHaveAttribute("data-rail-row");
      // Render-gated, not CSS-hidden: no cluster buttons exist on coarse.
      expect(within(container).queryByRole("button", { name: "Set color for server alpha" })).toBeNull();
      expect(within(container).queryByRole("button", { name: "New session on alpha" })).toBeNull();
      expect(within(container).queryByRole("button", { name: "Kill server alpha" })).toBeNull();
      // The collapse toggle remains.
      expect(within(container).getByRole("button", { name: /Expand alpha sessions/ })).toBeInTheDocument();
    } finally {
      vi.mocked(getAllServerColors).mockResolvedValue({});
    }
  });

  it("renders no rail and no cluster on fine pointers — the hover/focus card is the surface", async () => {
    stubMatchMedia((q) => q.includes("prefers-color-scheme: dark")); // fine
    renderSidebar();
    await act(async () => {});
    const container = headerContainer("alpha");
    expect(within(container).queryByTestId("status-rail")).toBeNull();
    expect(within(container).queryByRole("button", { name: "Set color for server alpha" })).toBeNull();
    expect(within(container).queryByRole("button", { name: "New session on alpha" })).toBeNull();
    expect(within(container).queryByRole("button", { name: "Kill server alpha" })).toBeNull();
  });

  it("rail tap opens the server card — title, facts, action rows in fixed order; actions route; the header never toggles", async () => {
    const onKillServer = vi.fn();
    const onCreateSession = vi.fn();
    renderSidebar({ onKillServer, onCreateSession });
    await act(async () => {});

    tapRail("alpha");
    const card = screen.getByTestId("row-flyout-card");
    expect(screen.getByTestId("popup-title-bar")).toHaveTextContent("Server alpha");
    // Server names ARE socket names; the count derives from the group's data
    // (alpha has no sessions in the default map).
    expect(card).toHaveTextContent("tmux -L alpha · 0 sessions");
    const color = screen.getByTestId("row-flyout-color-action");
    const create = screen.getByTestId("row-flyout-create-action");
    const kill = screen.getByTestId("row-flyout-kill-action");
    expect(color).toHaveTextContent("Change color…");
    expect(create).toHaveTextContent("New session");
    expect(kill).toHaveTextContent("Kill server");
    expect(kill).toHaveTextContent("confirms first");
    expect(kill.className).toContain("hover:text-signal-red");
    expect(color.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(create.compareDocumentPosition(kill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    act(() => { fireEvent.click(create); });
    expect(onCreateSession).toHaveBeenCalledExactlyOnceWith("alpha");
    act(() => { fireEvent.click(kill); });
    // The existing lifted kill flow (the killServerTarget dialog is the
    // parent's — nothing renders here).
    expect(onKillServer).toHaveBeenCalledExactlyOnceWith("alpha");
    // Card interactions never toggled the group.
    expect(
      within(headerContainer("alpha")).getByRole("button", { name: /Expand alpha sessions/ }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("Change color… closes the card and opens the header-anchored color popover; the open popover inhibits re-opening", async () => {
    renderSidebar();
    await act(async () => {});

    tapRail("alpha");
    act(() => { fireEvent.click(screen.getByTestId("row-flyout-color-action")); });
    expect(screen.queryByTestId("row-flyout-card")).toBeNull();
    // The popover anchors at the header element on every pointer class.
    expect(screen.getByRole("listbox", { name: "Label picker" })).toBeInTheDocument();
    // Popover-over-card precedence: the suppressed gate holds while the
    // popover is open.
    tapRail("alpha");
    expect(screen.queryByTestId("row-flyout-card")).toBeNull();
  });

  it("lightens the rail only while the card is open (held treatment)", async () => {
    renderSidebar();
    await act(async () => {});
    const rail = within(headerContainer("alpha")).getByTestId("status-rail");
    const restBand = rail.style.backgroundColor;
    tapRail("alpha");
    expect(rail.style.backgroundColor).toContain("color-mix(in srgb, var(--color-bg-inset) 40%");
    expect(rail.style.borderColor).toBe("var(--color-text-secondary)");
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByTestId("row-flyout-card")).toBeNull();
    expect(rail.style.backgroundColor).toBe(restBand);
    expect(rail.style.borderColor).toBe("");
  });

  it("server card protect toggle: fires setServerProtected with the flipped state; rk-daemon's row is protected and inert", async () => {
    renderSidebar({
      servers: [
        { name: "primary", sessionCount: 1, protected: false },
        { name: "alpha", sessionCount: 0, protected: true },
        { name: DAEMON_SERVER, sessionCount: 2, protected: true },
      ],
    });
    await act(async () => {});

    // Unprotected server: the toggle reads "Protect" (off) and fires true.
    tapRail("primary");
    let toggle = screen.getByTestId("row-flyout-protect-toggle");
    expect(toggle).toHaveTextContent("Protect");
    expect(toggle).not.toBeDisabled();
    expect(toggle).toHaveAttribute("role", "switch");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    act(() => { fireEvent.click(toggle); });
    expect(setServerProtected).toHaveBeenCalledExactlyOnceWith("primary", true);
    act(() => { fireEvent.keyDown(document, { key: "Escape" }); });
    vi.mocked(setServerProtected).mockClear();

    // Protected server: the toggle reads "Unprotect" (on) and fires false.
    tapRail("alpha");
    toggle = screen.getByTestId("row-flyout-protect-toggle");
    expect(toggle).toHaveTextContent("Unprotect");
    expect(toggle).toHaveAttribute("role", "switch");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    act(() => { fireEvent.click(toggle); });
    expect(setServerProtected).toHaveBeenCalledExactlyOnceWith("alpha", false);
    act(() => { fireEvent.keyDown(document, { key: "Escape" }); });
    vi.mocked(setServerProtected).mockClear();

    // rk-daemon: visibly protected, toggle disabled — derived, not unmarkable.
    tapRail(DAEMON_SERVER);
    toggle = screen.getByTestId("row-flyout-protect-toggle");
    expect(toggle).toHaveTextContent("Unprotect");
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("role", "switch");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    act(() => { fireEvent.click(toggle); });
    expect(setServerProtected).not.toHaveBeenCalled();
  });

  it("server group headers render the shield glyph for protected servers (rk-daemon derived), absent otherwise", async () => {
    renderSidebar({
      servers: [
        { name: "primary", sessionCount: 1, protected: false },
        { name: "alpha", sessionCount: 0, protected: true },
        { name: DAEMON_SERVER, sessionCount: 2 },
      ],
    });
    await act(async () => {});

    // Scope to the tree — the SERVER panel's strip tiles render the same
    // `shield-<name>` idiom, so an unscoped query matches both surfaces.
    const tree = screen.getByRole("tree");
    expect(within(tree).getByTestId("shield-alpha")).toBeInTheDocument();
    // rk-daemon derives protected client-side even with the flag unset.
    expect(within(tree).getByTestId(`shield-${DAEMON_SERVER}`)).toBeInTheDocument();
    expect(within(tree).queryByTestId("shield-primary")).not.toBeInTheDocument();
  });

  it("server group headers render ↗ + dimmed name for external (managed === false) only; absent field renders no treatment", async () => {
    renderSidebar({
      servers: [
        { name: "primary", sessionCount: 1, managed: true },
        { name: "ext", sessionCount: 0, managed: false },
        { name: "old", sessionCount: 0 }, // old backend: no `managed`
      ],
    });
    await act(async () => {});

    // Scope to the tree — the strip tile also renders the `external-<name>`
    // idiom.
    const tree = screen.getByRole("tree");
    expect(within(tree).getByTestId("external-ext")).toBeInTheDocument();
    const extHeader = getServerGroupHeader("ext")!;
    expect(within(extHeader).getByText("ext")).toHaveClass("text-text-secondary");

    for (const name of ["primary", "old"]) {
      expect(within(tree).queryByTestId(`external-${name}`)).not.toBeInTheDocument();
      const header = getServerGroupHeader(name)!;
      expect(within(header).getByText(name)).not.toHaveClass("text-text-secondary");
    }
  });

  it("renders both glyphs shield-first when an external server is also protected; nested session rows untouched", async () => {
    // CURRENT server is the external one — its session rows render expanded.
    renderSidebar({
      currentServer: "ext",
      servers: [
        { name: "ext", sessionCount: 1, managed: false, protected: true },
        { name: "primary", sessionCount: 0, managed: true },
      ],
    });
    await act(async () => {});

    const header = getServerGroupHeader("ext")!;
    const headerSpan = within(header).getByText("ext");
    const glyphs = headerSpan.parentElement!.querySelectorAll("[data-testid^='shield-'], [data-testid^='external-']");
    expect([...glyphs].map((g) => g.getAttribute("data-testid"))).toEqual([
      "shield-ext",
      "external-ext",
    ]);

    // The nested session row renders unchanged (no glyph, primary text).
    const extTree = header.closest("[role='tree']")!;
    const sessionRow = within(extTree as HTMLElement).getByText("main");
    expect(sessionRow.querySelector("[data-testid^='external-']")).toBeNull();
    expect(sessionRow).not.toHaveClass("text-text-secondary");
  });
});

describe("Sidebar — sessions-tree bottom scroll-edge fade (260813-kvk7)", () => {
  /** Stub the scroll geometry jsdom leaves at 0 (same pattern as
   *  use-scroll-edge-fade.test.ts). */
  function stubScrollMetrics(
    el: HTMLElement,
    metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
  ) {
    Object.defineProperty(el, "scrollHeight", { value: metrics.scrollHeight, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: metrics.clientHeight, configurable: true });
    Object.defineProperty(el, "scrollTop", { value: metrics.scrollTop, writable: true, configurable: true });
  }

  it("toggles rk-scroll-fade-bottom on the tree viewport: off when it fits, on when more content sits below, off at the end", () => {
    renderSidebar();
    const tree = screen.getByRole("tree");
    // jsdom metrics are all 0 → the list fits → no fade by default.
    expect(tree.className).not.toContain("rk-scroll-fade-bottom");

    // Scrollable and NOT at the end → the fade appears.
    stubScrollMetrics(tree, { scrollHeight: 600, clientHeight: 200, scrollTop: 0 });
    act(() => {
      tree.dispatchEvent(new Event("scroll"));
    });
    expect(tree.className).toContain("rk-scroll-fade-bottom");

    // Scrolled to the end → the fade disappears.
    act(() => {
      tree.scrollTop = 400;
      tree.dispatchEvent(new Event("scroll"));
    });
    expect(tree.className).not.toContain("rk-scroll-fade-bottom");
  });
});

describe("sidebar footer status row (260812-d1at — readouts + quiet status slot)", () => {
  // The footer is MOBILE-ONLY now (the desktop status bar owns the dot +
  // version), so these content assertions run in a mobile-context render:
  // re-stub matchMedia to report the narrow-width query, then restore the
  // file-default desktop stub afterwards.
  beforeEach(() => {
    stubMatchMedia((q) => q.includes("max-width") || q.includes("prefers-color-scheme: dark"));
  });
  afterEach(() => {
    stubMatchMedia((q) => q.includes("prefers-color-scheme: dark"));
  });

  it("renders NO footer on desktop — the status bar owns the dot + version there", () => {
    stubMatchMedia((q) => q.includes("prefers-color-scheme: dark")); // desktop
    renderSidebar({ isConnected: true, daemonVersion: "0.9.3" });
    expect(screen.queryByLabelText("Connected")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
  });

  it("renders NO action buttons — Help/Keyboard/Theme/Gear relocated to the top bar (260812-d1at)", () => {
    renderSidebar();
    expect(screen.queryByLabelText("Help — HexoKit docs")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Keyboard shortcuts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: / theme$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open settings" })).not.toBeInTheDocument();
  });

  it("renders the connection dot as a left readout with the top-bar dot's exact semantics", () => {
    renderSidebar({ isConnected: true });
    const dot = screen.getByLabelText("Connected");
    expect(dot).toBeInTheDocument();
    expect(dot.className).toContain("bg-accent-green");
    // Status readout, not a control: role="status" live region, no tab stop.
    const region = dot.closest('[role="status"]')!;
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(dot.tagName).toBe("SPAN");
  });

  it("flips the dot to disconnected grey when the page's stream is down", () => {
    renderSidebar({ isConnected: false });
    const dot = screen.getByLabelText("Disconnected");
    expect(dot.className).toContain("bg-text-secondary");
    expect(screen.queryByLabelText("Connected")).not.toBeInTheDocument();
  });

  it("renders the version readout beside the dot and copies the displayed form on click", async () => {
    renderSidebar({ daemonVersion: "0.9.3" });
    const version = screen.getByRole("button", { name: "HexoKit v0.9.3 (copy)" });
    expect(version).toHaveTextContent("v0.9.3");
    fireEvent.click(version);
    await waitFor(() => expect(vi.mocked(copyToClipboard)).toHaveBeenCalledWith("v0.9.3"));
  });

  it("renders NO version element until the daemon reports a version (never vundefined)", () => {
    renderSidebar({ daemonVersion: null });
    expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/vundefined/)).not.toBeInTheDocument();
  });

  it("lays the footer out readouts-left with no action cluster (dot → version)", () => {
    renderSidebar({ isConnected: true, daemonVersion: "0.9.3" });
    const dot = screen.getByLabelText("Connected");
    const version = screen.getByRole("button", { name: "HexoKit v0.9.3 (copy)" });
    const follows = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(dot, version)).toBe(true);
    // One justify-between row holding the readouts; the version copy button is
    // the footer's ONLY interactive element now.
    const row = version.closest(".justify-between")!;
    expect(row).toContainElement(dot as HTMLElement);
    expect(row.querySelectorAll("button")).toHaveLength(1);
  });

  it("shows a quiet accent-green update hint in the status slot while an update qualifies", () => {
    renderSidebar({
      daemonVersion: "0.9.3",
      updateAvailable: {
        tools: [{ tool: "run-kit", current: "0.9.3", latest: "3.16.0" }],
        key: "run-kit@3.16.0",
        current: "0.9.3",
        latest: "3.16.0",
      },
    });
    const hint = screen.getByText("v3.16.0 available");
    expect(hint.className).toContain("text-accent-green");
    // Non-interactive readout — the overflow menu's version row stays the
    // update surface.
    expect(hint.tagName).toBe("SPAN");
    expect(hint.closest("button, a")).toBeNull();
  });

  it("uses the count form when the qualifying update is not a single run-kit bump", () => {
    renderSidebar({
      daemonVersion: "0.9.3",
      updateAvailable: {
        tools: [
          { tool: "run-kit", current: "0.9.3", latest: "3.16.0" },
          { tool: "shll", current: "1.0.0", latest: "1.1.0" },
        ],
        key: "run-kit@3.16.0,shll@1.1.0",
        current: "0.9.3",
        latest: "3.16.0",
      },
    });
    expect(screen.getByText("2 updates available")).toBeInTheDocument();
  });

  it("renders NO status-slot content when no update qualifies (quiet at rest)", () => {
    renderSidebar({ daemonVersion: "0.9.3", updateAvailable: null });
    expect(screen.queryByText(/available/)).not.toBeInTheDocument();
  });
});

describe("Sidebar — brand row (mobile-only)", () => {
  // The brand row renders ONLY on phones: on desktop the brand lives in the
  // top bar (the sidebar head while the sidebar is open, the left root crumb
  // while closed), so the section rail is the sidebar's first row there.
  // Mirrors the footer block's re-stub/restore pattern.
  afterEach(() => {
    stubMatchMedia((q) => q.includes("prefers-color-scheme: dark"));
  });

  it("renders the HexoKit wordmark anchor to / as the nav's first row on mobile", () => {
    stubMatchMedia((q) => q.includes("max-width") || q.includes("prefers-color-scheme: dark"));
    renderSidebar();
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    // The accessible name is the wordmark text — deliberately NOT the top
    // bar's "HexoKit home" aria-label, which e2e selects by label and must
    // stay unique on desktop.
    const brand = within(nav).getByRole("link", { name: "HexoKit" });
    expect(brand).toHaveAttribute("href", "/");
    expect(nav.firstElementChild).toContainElement(brand);
  });

  it("renders NO brand row on desktop", () => {
    // File-default stub: desktop (no max-width / coarse match).
    renderSidebar();
    const nav = screen.getByRole("navigation", { name: "Sessions" });
    expect(within(nav).queryByRole("link", { name: "HexoKit" })).not.toBeInTheDocument();
  });
});

describe("Sidebar — desktop selected-row autoscroll (nris)", () => {
  // The file-default matchMedia stub reports DESKTOP (fine pointer, wide), so
  // the mobile drawer scroll+focus effect never runs here — every scroll call
  // observed in this block comes from the selection-keyed desktop effect.
  //
  // jsdom has no scrollIntoView — define a prototype-level spy so the effect's
  // `typeof row.scrollIntoView === "function"` guard passes.
  let scrollSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollSpy = vi.fn();
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
      value: scrollSpy,
      configurable: true,
      writable: true,
    });
    useWindowStore.setState({ entries: new Map(), ghosts: [] });
    // The derived-expand tests write collapse exceptions via the chevron.
    localStorage.clear();
  });

  afterEach(() => {
    delete (window.HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView;
    useWindowStore.setState({ entries: new Map(), ghosts: [] });
    localStorage.clear();
  });

  const SCROLL_SESSIONS: ProjectSession[] = [
    {
      name: "main",
      windows: [
        { index: 0, windowId: "@0", name: "edit", worktreePath: "~/a", activity: "idle", isActiveWindow: false, activityTimestamp: 0 },
        { index: 1, windowId: "@1", name: "test", worktreePath: "~/a", activity: "idle", isActiveWindow: false, activityTimestamp: 0 },
      ],
    },
  ];

  /** Provider tree parameterized on sessions + route selection so tests can
   *  rerender across selection changes (including cross-session navigation,
   *  where `currentSession` moves with the window), passive SSE ticks, and
   *  data arrival. */
  function scrollTreeUI(
    sessions: ProjectSession[],
    currentWindowId: string | null,
    currentSession: string | null = "main",
    onSelectWindow: (server: string, session: string, windowId: string) => void = vi.fn(),
  ) {
    const servers = [{ name: "primary", sessionCount: sessions.length }];
    return (
      <ThemeProvider>
        <InstanceAccentValueProvider value={NULL_ACCENT}>
        <InstanceNameValueProvider value={NULL_NAME}>
        <ToastProvider>
          <OptimisticProvider>
            <StandaloneSessionContextProvider
              value={{
                sessionsByServer: new Map([["primary", sessions]]),
                sessionOrderByServer: new Map([["primary", []]]),
                isConnectedByServer: new Map([["primary", true]]),
                metricsByServer: new Map(),
                currentServer: "primary",
                servers,
                refreshServers: vi.fn(),
              }}
            >
              <MetricsProvider value={null}>
                <HostMetricsProvider value={null}>
                  <FocusedPaneProvider>
                    <ChromeProvider>
                      <SettingsDialogProvider>
                        <Sidebar
                          currentServer="primary"
                          currentSession={currentSession}
                          currentWindowId={currentWindowId}
                          isConnected={false}
                          onSelectWindow={onSelectWindow}
                          onCreateWindow={vi.fn()}
                          onCreateSession={vi.fn()}
                          onCreateServer={vi.fn()}
                          onKillServer={vi.fn()}
                        />
                      </SettingsDialogProvider>
                    </ChromeProvider>
                  </FocusedPaneProvider>
                </HostMetricsProvider>
              </MetricsProvider>
            </StandaloneSessionContextProvider>
          </OptimisticProvider>
        </ToastProvider>
        </InstanceNameValueProvider>
        </InstanceAccentValueProvider>
      </ThemeProvider>
    );
  }

  /** The selected window row's button (the desktop effect's query target). */
  function selectedRowButton(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-window-id] [aria-current="page"]');
  }

  /** Calls whose `this` was a WINDOW-ROW button (scoped like the effect's own
   *  selector) — the ServerPanel active-tile effect also scrolls via the same
   *  prototype spy, so tile calls are filtered out. */
  function rowScrollCalls(): unknown[] {
    return scrollSpy.mock.instances.filter(
      (el) => el instanceof HTMLElement && el.closest("[data-window-id]") !== null,
    );
  }

  it("scrolls the selected row into view on mount without moving focus or the roving tab stop", () => {
    render(scrollTreeUI(SCROLL_SESSIONS, "@0"));

    const row = selectedRowButton();
    expect(row).not.toBeNull();
    expect(rowScrollCalls()).toHaveLength(1);
    expect(rowScrollCalls()[0]).toBe(row);
    expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" });
    // Scroll-only: focus stays outside the tree (no focus() call)...
    expect(screen.getByRole("tree").contains(document.activeElement)).toBe(false);
    // ...and the roving tab stop is untouched (still the first visible row —
    // the "main" session header — NOT the selected window row).
    const tabbable = Array.from(
      screen.getByRole("tree").querySelectorAll('[role="treeitem"][tabindex="0"]'),
    );
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].getAttribute("data-session-row")).toBe("primary:main");
  });

  it("scrolls once per selection change and never again on passive SSE ticks", () => {
    const { rerender } = render(scrollTreeUI(SCROLL_SESSIONS, "@0"));
    expect(rowScrollCalls()).toHaveLength(1);

    // Selection change → exactly one more scroll, targeting the new row.
    act(() => { rerender(scrollTreeUI(SCROLL_SESSIONS, "@1")); });
    expect(rowScrollCalls()).toHaveLength(2);
    expect((rowScrollCalls()[1] as HTMLElement).closest("[data-window-id]"))
      .toHaveAttribute("data-window-id", "@1");

    // Passive SSE tick: fresh Map + fresh window objects, SAME visible-row set,
    // SAME selection — must not scroll (Wave-2 #262: no scroll state churn).
    const ticked: ProjectSession[] = SCROLL_SESSIONS.map((s) => ({
      ...s,
      windows: s.windows.map((w) => ({ ...w, activityTimestamp: w.activityTimestamp + 1 })),
    }));
    act(() => { rerender(scrollTreeUI(ticked, "@1")); });
    expect(rowScrollCalls()).toHaveLength(2);
  });

  it("deep-link retry: no row at mount, scrolls exactly once when the SSE data lands", () => {
    // Route resolved before SSE: selection is set but no rows exist yet.
    const { rerender } = render(scrollTreeUI([], "@1"));
    expect(selectedRowButton()).toBeNull();
    expect(rowScrollCalls()).toHaveLength(0);

    // SSE snapshot lands → rows render, rowsVersion bumps → one deferred scroll.
    act(() => { rerender(scrollTreeUI(SCROLL_SESSIONS, "@1")); });
    expect(rowScrollCalls()).toHaveLength(1);
    expect((rowScrollCalls()[0] as HTMLElement).closest("[data-window-id]"))
      .toHaveAttribute("data-window-id", "@1");

    // The pending ref is cleared: a later passive tick does not re-scroll.
    const ticked: ProjectSession[] = SCROLL_SESSIONS.map((s) => ({
      ...s,
      windows: s.windows.map((w) => ({ ...w, activityTimestamp: w.activityTimestamp + 1 })),
    }));
    act(() => { rerender(scrollTreeUI(ticked, "@1")); });
    expect(rowScrollCalls()).toHaveLength(1);
  });

  // Two sessions so a NON-current one exists: the current route's session
  // renders expanded regardless of its collapsed exception (derived expand),
  // so the fold-away behaviors below need a session that is not current.
  const TWO_SESSION_SCROLL: ProjectSession[] = [
    ...SCROLL_SESSIONS,
    {
      name: "other",
      windows: [
        { index: 0, windowId: "@5", name: "docs", worktreePath: "~/b", activity: "idle", isActiveWindow: false, activityTimestamp: 0 },
      ],
    },
  ];

  it("folding the current session takes effect immediately and writes the exception", () => {
    const { rerender } = render(scrollTreeUI(TWO_SESSION_SCROLL, "@0"));
    expect(rowScrollCalls()).toHaveLength(1);

    // Chevron on the CURRENT session "main": the manual-collapse latch wins
    // over the derived expand — the rows leave the DOM immediately — and the
    // exception is persisted.
    act(() => { fireEvent.click(screen.getByRole("button", { name: /Collapse main/ })); });
    expect(JSON.parse(localStorage.getItem(SESSION_COLLAPSED_STORAGE_KEY)!))
      .toEqual({ "primary:main": true });
    expect(selectedRowButton()).toBeNull();
    expect(screen.getByRole("button", { name: /Expand main/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    // Switching windows WITHIN the folded current session keeps it folded —
    // the latch keys on the session, not the window; the armed scroll defers.
    act(() => { rerender(scrollTreeUI(TWO_SESSION_SCROLL, "@1")); });
    expect(screen.getByRole("button", { name: /Expand main/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(rowScrollCalls()).toHaveLength(1);
  });

  it("a fold-while-current releases on navigate-away: re-entering the session reveals it again", () => {
    const { rerender } = render(scrollTreeUI(TWO_SESSION_SCROLL, "@0"));
    act(() => { fireEvent.click(screen.getByRole("button", { name: /Collapse main/ })); });
    expect(screen.getByRole("button", { name: /Expand main/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    // Navigate away: "main" stays folded, now as an ordinary non-current
    // session with an exception.
    act(() => { rerender(scrollTreeUI(TWO_SESSION_SCROLL, "@5", "other")); });
    expect(screen.getByRole("button", { name: /Expand main/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    // Navigate back in: the latch cleared on the session change, so
    // expand-on-entry applies afresh — rows reveal and the armed deferred
    // scroll completes on the selected row. The exception never left the map.
    act(() => { rerender(scrollTreeUI(TWO_SESSION_SCROLL, "@0", "main")); });
    expect(screen.getByRole("button", { name: /Collapse main/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(JSON.parse(localStorage.getItem(SESSION_COLLAPSED_STORAGE_KEY)!))
      .toEqual({ "primary:main": true });
    const calls = rowScrollCalls();
    expect((calls[calls.length - 1] as HTMLElement).closest("[data-window-id]"))
      .toHaveAttribute("data-window-id", "@0");
  });

  it("expanding the folded current session clears the exception and the latch", () => {
    render(scrollTreeUI(TWO_SESSION_SCROLL, "@0"));
    act(() => { fireEvent.click(screen.getByRole("button", { name: /Collapse main/ })); });
    expect(screen.getByRole("button", { name: /Expand main/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    act(() => { fireEvent.click(screen.getByRole("button", { name: /Expand main/ })); });
    expect(screen.getByRole("button", { name: /Collapse main/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(selectedRowButton()).not.toBeNull();
    // Exceptions-only map: the emptied map removes the storage key outright.
    expect(localStorage.getItem(SESSION_COLLAPSED_STORAGE_KEY)).toBeNull();

    // The latch is gone too — a fresh fold still takes effect immediately.
    act(() => { fireEvent.click(screen.getByRole("button", { name: /Collapse main/ })); });
    expect(screen.getByRole("button", { name: /Expand main/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keyboard ArrowLeft on the current session's row folds it (rides toggleSession)", () => {
    render(scrollTreeUI(TWO_SESSION_SCROLL, "@0"));
    const t = screen.getByRole("tree");
    // Roving starts on the first visible row — the "main" session header —
    // and ArrowLeft on an expanded session row collapses it.
    act(() => { fireEvent.keyDown(t, { key: "ArrowLeft" }); });
    expect(screen.getByRole("button", { name: /Expand main/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(JSON.parse(localStorage.getItem(SESSION_COLLAPSED_STORAGE_KEY)!))
      .toEqual({ "primary:main": true });
  });

  it("the exception re-applies on navigate-away: the session folds and the map entry is intact", () => {
    const { rerender } = render(scrollTreeUI(TWO_SESSION_SCROLL, "@0"));
    act(() => { fireEvent.click(screen.getByRole("button", { name: /Collapse main/ })); });
    expect(selectedRowButton()).toBeNull(); // manual fold takes effect immediately

    // Navigate to a window of "other": "main" stays folded — now as an
    // ordinary non-current session — and the entry never left the map.
    act(() => { rerender(scrollTreeUI(TWO_SESSION_SCROLL, "@5", "other")); });
    expect(screen.getByRole("button", { name: /Expand main/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(document.querySelector('[role="tree"] [data-row-key="primary:@0"]')).toBeNull();
    expect(JSON.parse(localStorage.getItem(SESSION_COLLAPSED_STORAGE_KEY)!))
      .toEqual({ "primary:main": true });
    // The @5 selection in the (expanded) "other" group scrolled once more.
    expect(rowScrollCalls()).toHaveLength(2);
    expect((rowScrollCalls()[1] as HTMLElement).closest("[data-window-id]"))
      .toHaveAttribute("data-window-id", "@5");
  });

  it("navigating into a collapsed session reveals it and completes the deferred scroll; non-current never auto-expands", () => {
    const onSelectWindow = vi.fn();
    const { rerender } = render(scrollTreeUI(TWO_SESSION_SCROLL, "@0", "main", onSelectWindow));
    expect(rowScrollCalls()).toHaveLength(1);

    // Collapse the NON-current session "other": its rows leave the DOM and
    // stay out — a non-current session never auto-expands.
    act(() => { fireEvent.click(screen.getByRole("button", { name: /Collapse other/ })); });
    expect(document.querySelector('[role="tree"] [data-row-key="primary:@5"]')).toBeNull();
    expect(screen.getByRole("button", { name: /Expand other/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    // Navigate into it: the derived override reveals the rows and the armed
    // deferred scroll completes exactly once, targeting the selected row.
    act(() => { rerender(scrollTreeUI(TWO_SESSION_SCROLL, "@5", "other", onSelectWindow)); });
    expect(screen.getByRole("button", { name: /Collapse other/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(rowScrollCalls()).toHaveLength(2);
    expect((rowScrollCalls()[1] as HTMLElement).closest("[data-window-id]"))
      .toHaveAttribute("data-window-id", "@5");
    // Navigation never mutates the map: the exception is intact.
    expect(JSON.parse(localStorage.getItem(SESSION_COLLAPSED_STORAGE_KEY)!))
      .toEqual({ "primary:other": true });

    // Roving/render agreement: Enter resolves the row through the registered
    // identity slice (not the DOM), so activation proves the visible-row slice
    // recomputed with the current session — not just the painted rows.
    const t = screen.getByRole("tree");
    // Order: main (session) → @0 → @1 → other (session) → @5.
    for (let i = 0; i < 4; i++) act(() => { fireEvent.keyDown(t, { key: "ArrowDown" }); });
    act(() => { fireEvent.keyDown(t, { key: "Enter" }); });
    expect(onSelectWindow).toHaveBeenCalledWith("primary", "other", "@5");
  });

  it("stays disarmed with no URL window selection (currentWindowId null)", () => {
    // isActiveWindow fallback may still paint aria-current on a row, but the
    // effect keys on the URL selection identity — null disarms it.
    const withActive: ProjectSession[] = [
      {
        name: "main",
        windows: [
          { index: 0, windowId: "@0", name: "edit", worktreePath: "~/a", activity: "idle", isActiveWindow: true, activityTimestamp: 0 },
        ],
      },
    ];
    render(scrollTreeUI(withActive, null));
    expect(selectedRowButton()).not.toBeNull(); // fallback highlight exists
    expect(rowScrollCalls()).toHaveLength(0); // but no scroll fires
  });
});

describe("Sidebar — operator pinned row (260813-ifya)", () => {
  // A window carrying `role: "operator"` (the `@rk_win_role` option) is pinned at
  // the top of its server group's session area — MOVED out of its session
  // group (rendered exactly once), with no badge/chrome, and not draggable.
  const OPERATOR_SESSIONS: ProjectSession[] = [
    {
      name: "main",
      windows: [
        { index: 0, windowId: "@0", name: "shell", worktreePath: "~/a", activity: "idle", isActiveWindow: true, activityTimestamp: 0 },
        { index: 1, windowId: "@1", name: "operator", worktreePath: "~/a", activity: "idle", isActiveWindow: false, activityTimestamp: 0, role: "operator" },
        { index: 2, windowId: "@2", name: "logs", worktreePath: "~/a", activity: "idle", isActiveWindow: false, activityTimestamp: 0 },
      ],
    },
  ];

  function renderOperatorSidebar(opts: RenderOpts = {}) {
    return renderSidebar({
      currentServer: "primary",
      sessionsByServer: new Map([
        ["primary", OPERATOR_SESSIONS],
        ["alpha", []],
        ["beta", []],
      ]),
      ...opts,
    });
  }

  function rowByKey(key: string): HTMLElement | null {
    return document.querySelector(`[role="tree"] [data-row-key="${key}"]`);
  }

  it("pins the operator window's row above all session groups, rendered exactly once", () => {
    renderOperatorSidebar();

    // Exactly one row for the operator window in the whole tree (move, not copy).
    const rows = document.querySelectorAll('[role="tree"] [data-row-key="primary:@1"]');
    expect(rows).toHaveLength(1);

    // The pinned row paints BEFORE the session group wrapper (directly under
    // the group content's top, above all session groups).
    const sessionGroup = document.querySelector('[data-session-group="main"]')!;
    expect(
      rows[0].compareDocumentPosition(sessionGroup) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("excludes the operator window from its session group's rows (one fewer row)", () => {
    renderOperatorSidebar();

    const sessionGroup = document.querySelector('[data-session-group="main"]')!;
    const inGroup = Array.from(sessionGroup.querySelectorAll("[data-row-key]")).map((el) =>
      el.getAttribute("data-row-key"),
    );
    expect(inGroup).toEqual(["primary:@0", "primary:@2"]);
  });

  it("renders the pinned row with the window name only (no session prefix)", () => {
    renderOperatorSidebar();
    const pinned = rowByKey("primary:@1")!;
    // The row's name span carries just the window name.
    const nameSpan = pinned.querySelector("button .truncate")!;
    expect(nameSpan).toHaveTextContent(/^operator$/);
  });

  it("renders no pinned row or placeholder when no window carries the role", () => {
    // Default fixture (PRIMARY_SESSIONS) has no role field.
    renderSidebar({ currentServer: "primary" });

    // One window row total, and the group content's FIRST child is the session
    // group wrapper itself — no placeholder/wrapper element above it.
    expect(document.querySelectorAll('[role="tree"] [data-row-key^="primary:@"]')).toHaveLength(1);
    const content = document.querySelector('[data-session-group="main"]')!.parentElement!;
    expect(content.firstElementChild).toBe(
      document.querySelector('[data-session-group="main"]'),
    );
  });

  it("is not draggable, while ordinary session-group rows stay draggable", () => {
    renderOperatorSidebar();

    expect(rowByKey("primary:@1")).toHaveAttribute("draggable", "false");
    expect(rowByKey("primary:@0")).toHaveAttribute("draggable", "true");
  });

  it("participates in roving tabindex as the first row of the group", () => {
    renderOperatorSidebar();

    // Initial tab stop is the pinned row (it leads the group's visible rows).
    const tabbable = Array.from(
      document.querySelectorAll('[role="tree"] [role="treeitem"][tabindex="0"]'),
    );
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(rowByKey("primary:@1"));

    // ArrowDown walks past it into the session row, exactly like any other row.
    const tree = screen.getByRole("tree");
    act(() => { fireEvent.keyDown(tree, { key: "ArrowDown" }); });
    expect(rowByKey("primary:@1")).toHaveAttribute("tabindex", "-1");
    const sessionRow = document.querySelector('[data-session-row="primary:main"]') ??
      document.querySelector('[role="treeitem"][tabindex="0"]');
    expect(sessionRow).not.toBeNull();
    expect(sessionRow).toHaveAttribute("tabindex", "0");
  });

  it("hides the pinned row when its server group is collapsed (no floating orphan)", () => {
    // Collapse the primary group via its persisted key (scope defaults to ALL,
    // so per-server collapse applies — the current server is not force-open).
    localStorage.setItem("hexokit-panel-sessions-primary", "false");
    renderOperatorSidebar();

    expect(
      screen.getByRole("button", { name: /Expand primary sessions/ }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(rowByKey("primary:@1")).toBeNull();

    // Expanding the group brings the pinned row back.
    fireEvent.click(screen.getByRole("button", { name: /Expand primary sessions/ }));
    expect(rowByKey("primary:@1")).not.toBeNull();
  });

  it("keeps the pinned row visible when its HOME SESSION is collapsed", () => {
    // The row no longer lives inside the session group, so per-session
    // collapse does not hide it (the group renders zero window rows).
    // No-current-window route state: the CURRENT session would render
    // expanded despite its exception (derived expand), defeating the fold
    // this test needs.
    localStorage.setItem(SESSION_COLLAPSED_STORAGE_KEY, JSON.stringify({ "primary:main": true }));
    renderOperatorSidebar({ currentSession: null, currentWindowId: null });

    expect(rowByKey("primary:@1")).not.toBeNull();
    expect(rowByKey("primary:@0")).toBeNull();
    expect(rowByKey("primary:@2")).toBeNull();
  });

  it("pins at the top of a non-current server's group on the multi-server tree", () => {
    renderSidebar({
      currentServer: "primary",
      sessionsByServer: new Map([
        ["primary", PRIMARY_SESSIONS],
        [
          "alpha",
          [
            {
              name: "ops",
              windows: [
                { index: 0, windowId: "@0", name: "worker", worktreePath: "~/a", activity: "idle", isActiveWindow: false, activityTimestamp: 0 },
                { index: 1, windowId: "@1", name: "operator", worktreePath: "~/a", activity: "idle", isActiveWindow: false, activityTimestamp: 0, role: "operator" },
              ],
            },
          ],
        ],
        ["beta", []],
      ]),
    });

    // Alpha's group starts collapsed on the ALL tree; open it.
    fireEvent.click(screen.getByRole("button", { name: /Expand alpha sessions/ }));

    const rows = document.querySelectorAll('[role="tree"] [data-row-key="alpha:@1"]');
    expect(rows).toHaveLength(1);
    const sessionGroup = document.querySelector('[data-session-group="ops"]')!;
    expect(
      rows[0].compareDocumentPosition(sessionGroup) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Excluded from its session group there too.
    const inGroup = Array.from(sessionGroup.querySelectorAll("[data-row-key]")).map((el) =>
      el.getAttribute("data-row-key"),
    );
    expect(inGroup).toEqual(["alpha:@0"]);
  });

  it("clicking the pinned row selects its operator window without dispatching the quake terminal", () => {
    const onSelectWindow = vi.fn();
    const onQuakeRequest = vi.fn();
    renderOperatorSidebar({ onSelectWindow });
    document.addEventListener(QUAKE_TERMINAL_EVENT, onQuakeRequest);

    fireEvent.click(rowByKey("primary:@1")!.querySelector("button")!);
    document.removeEventListener(QUAKE_TERMINAL_EVENT, onQuakeRequest);

    expect(onSelectWindow).toHaveBeenCalledWith("primary", "main", "@1");
    expect(onQuakeRequest).not.toHaveBeenCalled();
  });

  it("Enter/Space on the pinned row selects its operator window without dispatching the quake terminal", () => {
    const onSelectWindow = vi.fn();
    const onQuakeRequest = vi.fn();
    renderOperatorSidebar({ onSelectWindow });
    document.addEventListener(QUAKE_TERMINAL_EVENT, onQuakeRequest);

    // Walk the roving cursor onto the pinned row (it leads the group's rows,
    // one ArrowUp from the session row).
    const tree = screen.getByRole("tree");
    act(() => { fireEvent.keyDown(tree, { key: "ArrowUp" }); });
    expect(rowByKey("primary:@1")).toHaveAttribute("tabindex", "0");

    act(() => { fireEvent.keyDown(tree, { key: "Enter" }); });
    expect(onSelectWindow).toHaveBeenCalledWith("primary", "main", "@1");
    expect(onQuakeRequest).not.toHaveBeenCalled();

    onSelectWindow.mockClear();
    act(() => { fireEvent.keyDown(tree, { key: " " }); });
    document.removeEventListener(QUAKE_TERMINAL_EVENT, onQuakeRequest);

    expect(onSelectWindow).toHaveBeenCalledWith("primary", "main", "@1");
    expect(onQuakeRequest).not.toHaveBeenCalled();
  });

  it("renders the note pulse line under the pinned row when @rk_win_note is set", () => {
    renderOperatorSidebar({
      sessionsByServer: new Map([
        [
          "primary",
          [
            {
              name: "main",
              windows: [
                { index: 1, windowId: "@1", name: "operator", worktreePath: "~/a", activity: "idle", isActiveWindow: false, activityTimestamp: 0, role: "operator", note: "watching deploys", noteEpoch: Math.floor(Date.now() / 1000) },
              ],
            },
          ],
        ],
        ["alpha", []],
        ["beta", []],
      ]),
    });

    const pulse = screen.getByTestId("operator-note-pulse");
    expect(pulse).toHaveTextContent("watching deploys");
    // The pulse renders under the pinned row, not above it.
    const row = rowByKey("primary:@1")!;
    expect(row.compareDocumentPosition(pulse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders no pulse line (and reserves no space) when no note is set", () => {
    renderOperatorSidebar();
    expect(screen.queryByTestId("operator-note-pulse")).toBeNull();
  });
});

describe("Sidebar — operator placeholder row", () => {
  // No window on the server carries `role: "operator"` (PRIMARY_SESSIONS has
  // no role field): the pinned slot renders the placeholder — but only when
  // the shell wired `onOperatorPlaceholder`.
  const OPERATOR_CARRIER: ProjectSession[] = [
    {
      name: "main",
      windows: [
        { index: 0, windowId: "@0", name: "shell", worktreePath: "~/a", activity: "idle", isActiveWindow: true, activityTimestamp: 0 },
        { index: 1, windowId: "@1", name: "operator", worktreePath: "~/a", activity: "idle", isActiveWindow: false, activityTimestamp: 0, role: "operator" },
      ],
    },
  ];

  it("renders the placeholder in the pinned slot when wired, nothing when not", () => {
    renderSidebar({ onOperatorPlaceholder: vi.fn() });

    const placeholder = screen.getByTestId("operator-placeholder-row");
    expect(placeholder).toHaveTextContent("operator");
    expect(placeholder).toHaveTextContent("not running");
    expect(placeholder).toHaveAttribute("role", "treeitem");
    expect(placeholder).toHaveAttribute("aria-selected", "false");
    expect(placeholder).toHaveAttribute("draggable", "false");
    // It paints BEFORE the first session group wrapper — the pinned slot.
    const sessionGroup = document.querySelector('[data-session-group="main"]')!;
    expect(
      placeholder.compareDocumentPosition(sessionGroup) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    cleanup();
    renderSidebar();
    expect(screen.queryByTestId("operator-placeholder-row")).toBeNull();
  });

  it("calls the handler with the server on pointer click", () => {
    const onOperatorPlaceholder = vi.fn();
    renderSidebar({ onOperatorPlaceholder });

    fireEvent.click(screen.getByTestId("operator-placeholder-row"));

    expect(onOperatorPlaceholder).toHaveBeenCalledWith("primary");
  });

  it("leads the group's roving order and activates on Enter through the tree path", () => {
    const onOperatorPlaceholder = vi.fn();
    renderSidebar({ onOperatorPlaceholder });

    // The placeholder is the group's first tab stop.
    const tabbable = Array.from(
      document.querySelectorAll('[role="tree"] [role="treeitem"][tabindex="0"]'),
    );
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(screen.getByTestId("operator-placeholder-row"));

    // Enter on the roving row activates the handler — not window navigation.
    const tree = screen.getByRole("tree");
    act(() => { fireEvent.keyDown(tree, { key: "Enter" }); });
    expect(onOperatorPlaceholder).toHaveBeenCalledWith("primary");

    // ArrowDown walks past it into the session row, like any other row.
    act(() => { fireEvent.keyDown(tree, { key: "ArrowDown" }); });
    expect(screen.getByTestId("operator-placeholder-row")).toHaveAttribute("tabindex", "-1");
  });

  it("is excluded from the multi-select registry (x is a no-op on it)", () => {
    renderSidebar({ onOperatorPlaceholder: vi.fn() });

    const tree = screen.getByRole("tree");
    act(() => { fireEvent.keyDown(tree, { key: "x" }); });

    expect(screen.queryByTestId("selection-bar")).toBeNull();
  });

  it("ArrowRight treats the placeholder as a leaf — no phantom collapse entry", () => {
    renderSidebar({ onOperatorPlaceholder: vi.fn() });

    const tree = screen.getByRole("tree");
    act(() => { fireEvent.keyDown(tree, { key: "ArrowRight" }); });

    // A session-shaped ArrowRight would persist "primary:operator-placeholder".
    expect(localStorage.getItem(SESSION_COLLAPSED_STORAGE_KEY)).toBeNull();
    // Focus never moved off the placeholder.
    expect(screen.getByTestId("operator-placeholder-row")).toHaveAttribute("tabindex", "0");
  });

  it("swaps to the ordinary pinned row once a carrier appears (no animation, no overlap)", () => {
    const view = renderSidebar({ onOperatorPlaceholder: vi.fn() });
    expect(screen.getByTestId("operator-placeholder-row")).toBeInTheDocument();

    rerenderSidebar(view.rerender, {
      onOperatorPlaceholder: vi.fn(),
      sessionsByServer: new Map([
        ["primary", OPERATOR_CARRIER],
        ["alpha", []],
        ["beta", []],
      ]),
    });

    expect(screen.queryByTestId("operator-placeholder-row")).toBeNull();
    expect(
      document.querySelectorAll('[role="tree"] [data-row-key="primary:@1"]'),
    ).toHaveLength(1);
  });

  it("hides with its server group when the group is collapsed", () => {
    localStorage.setItem("hexokit-panel-sessions-primary", "false");
    renderSidebar({ onOperatorPlaceholder: vi.fn() });

    expect(screen.queryByTestId("operator-placeholder-row")).toBeNull();
  });
});

describe("Sidebar — hidden operator-home sessions (skcr)", () => {
  // A session carrying `hidden: true` (the backend's content-conditional
  // `_rk-operator` marker — every window operator) is excluded from the
  // SESSIONS groups while its windows still source the pinned operator row.
  const HIDDEN_SESSIONS: ProjectSession[] = [
    {
      name: "work",
      windows: [
        { index: 0, windowId: "@0", name: "shell", worktreePath: "~/a", activity: "idle", isActiveWindow: true, activityTimestamp: 0 },
        { index: 1, windowId: "@2", name: "logs", worktreePath: "~/a", activity: "idle", isActiveWindow: false, activityTimestamp: 0 },
      ],
    },
    {
      name: "_rk-operator",
      hidden: true,
      windows: [
        { index: 0, windowId: "@1", name: "operator", worktreePath: "~/a", activity: "idle", isActiveWindow: false, activityTimestamp: 0, role: "operator" },
      ],
    },
  ];

  function renderHiddenSidebar(opts: RenderOpts = {}) {
    return renderSidebar({
      currentServer: "primary",
      sessionsByServer: new Map([
        ["primary", HIDDEN_SESSIONS],
        ["alpha", []],
        ["beta", []],
      ]),
      ...opts,
    });
  }

  function rowByKey(key: string): HTMLElement | null {
    return document.querySelector(`[role="tree"] [data-row-key="${key}"]`);
  }

  it("renders no session group for the hidden session, but keeps the visible ones", () => {
    renderHiddenSidebar();

    expect(document.querySelector('[data-session-group="_rk-operator"]')).toBeNull();
    expect(document.querySelector('[data-session-group="work"]')).not.toBeNull();
  });

  it("still sources the pinned operator row from the hidden session's window", () => {
    renderHiddenSidebar();

    const rows = document.querySelectorAll('[role="tree"] [data-row-key="primary:@1"]');
    expect(rows).toHaveLength(1);
    // The pinned row paints above the remaining (visible) session group.
    const sessionGroup = document.querySelector('[data-session-group="work"]')!;
    expect(
      rows[0].compareDocumentPosition(sessionGroup) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("leads roving order with the pinned row, followed by the visible session row", () => {
    renderHiddenSidebar();

    const tabbable = Array.from(
      document.querySelectorAll('[role="tree"] [role="treeitem"][tabindex="0"]'),
    );
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(rowByKey("primary:@1"));

    // ArrowDown walks from the pinned row onto the visible session row — the
    // hidden session contributes no row to the walk.
    const tree = screen.getByRole("tree");
    act(() => { fireEvent.keyDown(tree, { key: "ArrowDown" }); });
    expect(rowByKey("primary:@1")).toHaveAttribute("tabindex", "-1");
    const sessionRow = document.querySelector('[data-session-row="primary:work"]') ??
      document.querySelector('[role="treeitem"][tabindex="0"]');
    expect(sessionRow).not.toBeNull();
    expect(sessionRow).toHaveAttribute("tabindex", "0");
  });

  it("keeps a mixed (not hidden) _rk-operator session visible, with the operator row pinned only", () => {
    renderSidebar({
      currentServer: "primary",
      sessionsByServer: new Map([
        [
          "primary",
          [
            {
              name: "_rk-operator",
              windows: [
                { index: 0, windowId: "@1", name: "operator", worktreePath: "~/a", activity: "idle", isActiveWindow: true, activityTimestamp: 0, role: "operator" },
                { index: 1, windowId: "@3", name: "worker", worktreePath: "~/a", activity: "idle", isActiveWindow: false, activityTimestamp: 0 },
              ],
            },
          ],
        ],
        ["alpha", []],
        ["beta", []],
      ]),
    });

    const sessionGroup = document.querySelector('[data-session-group="_rk-operator"]');
    expect(sessionGroup).not.toBeNull();
    // The operator window's row renders exactly once (pinned), and the group
    // keeps only the non-operator row — the retained move-don't-copy skip.
    expect(document.querySelectorAll('[role="tree"] [data-row-key="primary:@1"]')).toHaveLength(1);
    const inGroup = Array.from(sessionGroup!.querySelectorAll("[data-row-key]")).map((el) =>
      el.getAttribute("data-row-key"),
    );
    expect(inGroup).toEqual(["primary:@3"]);
  });
});

describe("Sidebar — ⌘B row-focuser registry + Escape return (260819-qwr7 R5)", () => {
  // The shell's stateful sidebar chord drives these seams through the
  // `lib/sidebar-events.ts` module registries; this suite pins the SIDEBAR
  // side of the contract (which row takes focus, the roving sync, the Escape
  // return). Branch selection in the chord itself is covered in
  // `components/shell/shell-sidebar-chord.test.tsx`.
  let unregisterRestorer: (() => void) | undefined;
  afterEach(() => {
    unregisterRestorer?.();
    unregisterRestorer = undefined;
  });

  const sessionsNav = () => screen.getByRole("navigation", { name: "Sessions" });

  it("focusSidebarCurrentRow focuses the aria-current window row and syncs the roving tab stop", () => {
    // Default fixture: currentServer "primary", currentWindowId "@0" — that
    // row's button carries aria-current="page". The initial roving tab stop is
    // the FIRST row (the "main" session header), so the focus arm must MOVE it.
    renderSidebar({ currentServer: "primary" });
    const row = document.querySelector<HTMLElement>('[data-window-id] [aria-current="page"]')!;
    expect(row).not.toBeNull();
    const treeItem = row.closest<HTMLElement>("[data-window-id]")!;
    expect(treeItem).toHaveAttribute("tabindex", "-1");

    let focused = false;
    act(() => {
      focused = focusSidebarCurrentRow();
    });

    expect(focused).toBe(true);
    expect(document.activeElement).toBe(row);
    // Roving sync (the Wave-2 #262 invariant): the tab stop moved to the
    // focused row's treeitem, and exactly one tab stop exists.
    expect(treeItem).toHaveAttribute("tabindex", "0");
    const tabbable = Array.from(
      document.querySelectorAll<HTMLElement>('[role="tree"] [role="treeitem"][tabindex="0"]'),
    );
    expect(tabbable).toEqual([treeItem]);
  });

  it("with no aria-current window row (board/host routes) it focuses the tree's roving tab stop", () => {
    // currentServer null (the board route) makes EVERY group non-current, so
    // all render collapsed by default — expand one to have visible rows. The
    // harness's default sessions map keys its fixture rows on the current
    // server, so the sessions must be passed explicitly here.
    localStorage.setItem("hexokit-panel-sessions-primary", "true");
    renderSidebar({
      currentServer: null,
      sessionsByServer: new Map([["primary", PRIMARY_SESSIONS]]),
    });
    expect(
      document.querySelector('[data-window-id] [aria-current="page"]'),
    ).toBeNull();
    const tabStop = document.querySelector<HTMLElement>(
      '[role="tree"] [role="treeitem"][tabindex="0"]',
    )!;
    expect(tabStop).not.toBeNull();

    let focused = false;
    act(() => {
      focused = focusSidebarCurrentRow();
    });

    expect(focused).toBe(true);
    expect(document.activeElement).toBe(tabStop);
  });

  it("reports false once unmounted (the focuser slot clears on unmount)", () => {
    const { unmount } = renderSidebar({ currentServer: "primary" });
    unmount();
    expect(focusSidebarCurrentRow()).toBe(false);
  });

  it("Escape inside the nav returns focus via the registered restorer WITHOUT hiding the sidebar", () => {
    const restore = vi.fn();
    unregisterRestorer = registerWindowFocusRestorer(restore);
    renderSidebar({ currentServer: "primary" });
    const row = document.querySelector<HTMLElement>('[data-window-id] [aria-current="page"]')!;
    act(() => {
      row.focus();
    });
    expect(document.activeElement).toBe(row);

    // Fire on the nav itself: the listener is nav-scoped bubble-phase (the
    // tree's selection-clear capture and the row flyout's dismiss get first
    // refusal on row-targeted presses — not under test here).
    fireEvent.keyDown(sessionsNav(), { key: "Escape" });

    expect(restore).toHaveBeenCalledTimes(1);
    // No hiding: the tree (and the focused row) stay mounted.
    expect(screen.getByRole("tree")).toBeInTheDocument();
    expect(row.isConnected).toBe(true);
  });

  it("Escape blurs when no restorer is registered (board/host routes)", () => {
    renderSidebar({ currentServer: "primary" });
    const row = document.querySelector<HTMLElement>('[data-window-id] [aria-current="page"]')!;
    act(() => {
      row.focus();
    });
    expect(document.activeElement).toBe(row);

    fireEvent.keyDown(sessionsNav(), { key: "Escape" });

    expect(document.activeElement).toBe(document.body);
    expect(screen.getByRole("tree")).toBeInTheDocument();
  });

  it("Escape skips editable targets (a rename input's Escape cancels the rename)", () => {
    const restore = vi.fn();
    unregisterRestorer = registerWindowFocusRestorer(restore);
    renderSidebar({ currentServer: "primary" });
    const input = document.createElement("input");
    sessionsNav().appendChild(input);

    fireEvent.keyDown(input, { key: "Escape" });

    expect(restore).not.toHaveBeenCalled();
    input.remove();
  });
});
