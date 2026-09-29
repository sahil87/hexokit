import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { Service, ProjectSession, MetricsSnapshot } from "@/types";
import type { ServerInfo } from "@/api/client";
import { ThemeProvider } from "@/contexts/theme-context";
import { ChromeProvider } from "@/contexts/chrome-context";
import { TopBarSlotProvider } from "@/contexts/top-bar-slot-context";
import { PaletteActionsProvider } from "@/contexts/palette-actions-context";
import { stubMatchMedia } from "@/test-utils/match-media";

// --- Router mock: capture navigate calls. ---
const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

// --- API client mock. Partial (importActual) so the real theme-preference
// helpers used by the shared TopBar's ThemeProvider stay available; only the
// server/session/window create + fetch calls this page drives are stubbed. ---
vi.mock("@/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/api/client")>("@/api/client");
  return {
    ...actual,
    createServer: vi.fn().mockResolvedValue({ ok: true }),
    createSession: vi.fn().mockResolvedValue({ ok: true }),
    createWindow: vi.fn().mockResolvedValue({ ok: true }),
    getSessions: vi.fn().mockResolvedValue([]),
    splitWindow: vi.fn().mockResolvedValue({ ok: true }),
    closePane: vi.fn().mockResolvedValue({ ok: true }),
    // The RECOVERY zone mounts with the page; empty offers → zero footprint.
    getRecoveryOffers: vi.fn().mockResolvedValue([]),
  };
});

// --- Toast mock. ---
const addToastMock = vi.fn();
vi.mock("@/components/toast", () => ({
  useToast: () => ({ addToast: addToastMock }),
}));

// --- Context hooks mock: drive host services + the server list + session map
// directly. Since 260701-f4e5, HostOverviewPage reads `servers`/`serversLoaded`
// from SessionContext (not its own listServers() fetch), so the servers are
// supplied here rather than via an API mock. ---
let mockServices: Service[] = [];
let mockServers: ServerInfo[] = [];
let mockSessionsByServer: Map<string, ProjectSession[]> = new Map();
// Full snapshot shape (the status bar's compact metrics segment reads
// cpu/memory/load, not just the hostname).
let mockHostMetrics: MetricsSnapshot | null = null;
const refreshServersMock = vi.fn();
const markServerPendingMock = vi.fn();
const attachServerMock = vi.fn();
const restartNowMock = vi.fn().mockResolvedValue({ status: "ok" });
vi.mock("@/contexts/session-context", () => ({
  useHostMetrics: () => mockHostMetrics,
  useHostServices: () => mockServices,
  // The status bar (260814-ldbs) leaf-subscribes to these at the page bottom.
  useMetrics: () => null,
  useUpdateNotification: () => ({ daemonVersion: null }),
  useSessionContext: () => ({
    servers: mockServers,
    serversLoaded: true,
    refreshServers: refreshServersMock,
    markServerPending: markServerPendingMock,
    sessionsByServer: mockSessionsByServer,
    sessionOrderByServer: new Map<string, string[]>(),
    isConnectedByServer: new Map(mockServers.map((s) => [s.name, false])),
    attachServer: attachServerMock,
    daemonVersion: null,
    daemonStarted: null,
    daemonPort: null,
    restartNow: restartNowMock,
  }),
}));

// HostMetrics is rendered only when hostMetrics is non-null (it is null here),
// but import it lazily-safe by stubbing.
vi.mock("@/components/host-metrics", () => ({
  HostMetrics: () => null,
}));

// --- Boards hook mock: the BOARDS zone consumes useBoards(); the real hook
// needs the SessionContext SSE pool (attachServer/subscribeBoardChange), which
// the context mock above deliberately omits — mock at the hook seam instead. ---
let mockBoards: { name: string; pinCount: number }[] = [];
vi.mock("@/hooks/use-boards", () => ({
  useBoards: () => ({ boards: mockBoards, isLoading: false, error: null }),
}));

import { HostOverviewPage } from "./host-overview-page";
import { createSession, createWindow, getSessions } from "@/api/client";
import {
  InstanceNameValueProvider,
  type InstanceName,
} from "@/contexts/instance-name-context";

function nameValue(overrides: Partial<InstanceName> = {}): InstanceName {
  return {
    hostname: "",
    instanceName: null,
    displayName: "",
    setInstanceName: vi.fn(),
    ...overrides,
  };
}

/**
 * Render the page inside the providers the shared host-mode TopBar depends on
 * (Theme + Chrome). Toast + router are module-mocked above.
 */
function renderPage(instanceNameValue: InstanceName = nameValue()) {
  return render(
    <ThemeProvider>
      <ChromeProvider>
        <InstanceNameValueProvider value={instanceNameValue}>
          <TopBarSlotProvider>
            {/* The page registers its recovery palette verbs into the slot
                (Constitution V); an empty-globals provider suffices here. */}
            <PaletteActionsProvider globalActions={[]}>
              <HostOverviewPage />
            </PaletteActionsProvider>
          </TopBarSlotProvider>
        </InstanceNameValueProvider>
      </ChromeProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockServices = [];
  mockServers = [];
  mockBoards = [];
  mockSessionsByServer = new Map();
  mockHostMetrics = null;
  // ThemeProvider reads matchMedia on mount. Query-sensitive on the coarse
  // pointer: everything matches EXCEPT the coarse-pointer queries (both
  // `(pointer: coarse)` and `(any-pointer: coarse)` are false), or every Tip
  // would self-suppress (fine-pointer is the test default; tip.test.tsx covers
  // coarse).
  stubMatchMedia((query) => !query.includes("pointer: coarse"));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HostOverviewPage — system card (HOST HEALTH zone)", () => {
  it("renders the HexoKit system card inside the Host health zone even with no metrics", () => {
    mockHostMetrics = null;
    renderPage();

    const zone = screen.getByRole("region", { name: "Host health" });
    // The card renders independently of the metrics stream (the daemon serving
    // the page is up by definition) — with the context's null fields it
    // degrades to the version placeholder and not-running rows.
    expect(zone.querySelector('[aria-label="HexoKit system"]')).not.toBeNull();
    expect(within(zone).getByText("HexoKit")).toBeInTheDocument();
  });

  it("attaches the rk-daemon server so the service rows are live", () => {
    renderPage();
    expect(attachServerMock).toHaveBeenCalledWith("rk-daemon");
  });

  it("shows live service rows derived from the rk-daemon server's sessions", () => {
    mockSessionsByServer = new Map([
      [
        "rk-daemon",
        [
          {
            name: "rk-jobs",
            windows: [
              {
                windowId: "@7",
                index: 0,
                name: "job-a",
                worktreePath: "/tmp",
                activity: "idle" as const,
                isActiveWindow: true,
                activityTimestamp: 0,
              },
            ],
          },
        ],
      ],
    ]);
    renderPage();

    const card = screen.getByLabelText("HexoKit system");
    expect(within(card).getByText("1 job")).toBeInTheDocument();
    expect(within(card).getAllByText("not running")).toHaveLength(2);
    expect(within(card).getByRole("button", { name: "View" })).toBeInTheDocument();
  });

  it("Restart routes through the context's restartNow", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(restartNowMock).toHaveBeenCalledTimes(1);
  });
});

describe("HostOverviewPage — protected-server shield glyph (TMUX SERVERS tiles)", () => {
  it("renders the shield glyph for @rk_srv_protected servers and the rk-daemon server, absent otherwise", () => {
    mockServers = [
      { name: "runkit", sessionCount: 1 },
      { name: "guarded", sessionCount: 0, protected: true },
      { name: "rk-daemon", sessionCount: 2 },
    ];
    renderPage();

    expect(screen.getByTestId("shield-guarded")).toBeInTheDocument();
    expect(screen.getByTestId("shield-rk-daemon")).toBeInTheDocument();
    expect(screen.queryByTestId("shield-runkit")).not.toBeInTheDocument();
  });

  it("rk-daemon keeps its dim (grey-name) treatment with the glyph additive", () => {
    mockServers = [{ name: "rk-daemon", sessionCount: 2 }];
    renderPage();

    const shield = screen.getByTestId("shield-rk-daemon");
    // The name container keeps the infra grey (text-text-secondary).
    const nameDiv = shield.closest("div.font-medium");
    expect(nameDiv).toHaveClass("text-text-secondary");
    expect(nameDiv).toHaveTextContent("rk-daemon");
  });

  it("no server carries a glyph when nothing is protected (zero drift)", () => {
    mockServers = [{ name: "runkit", sessionCount: 1 }];
    renderPage();

    expect(screen.queryByTestId(/^shield-/)).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-icon="shield"]')).toHaveLength(0);
  });
});

describe("HostOverviewPage — external-server glyph (TMUX SERVERS tiles)", () => {
  it("renders ↗ + grey name for managed === false only; managed true and absent field render no treatment", () => {
    mockServers = [
      { name: "ext", sessionCount: 1, managed: false },
      { name: "own", sessionCount: 1, managed: true },
      { name: "old", sessionCount: 1 }, // old backend: no `managed`
    ];
    renderPage();

    expect(screen.getByTestId("external-ext")).toBeInTheDocument();
    const extName = screen.getByTestId("external-ext").closest("div.font-medium")!;
    expect(extName).toHaveClass("text-text-secondary");

    for (const name of ["own", "old"]) {
      expect(screen.queryByTestId(`external-${name}`)).not.toBeInTheDocument();
      const nameDiv = screen.getByText(name, { selector: "div.font-medium" });
      expect(nameDiv).toHaveClass("text-text-primary");
      expect(nameDiv).not.toHaveClass("text-text-secondary");
    }
  });

  it("renders ↗ before the name, after the shield when both classes apply", () => {
    mockServers = [{ name: "ext", sessionCount: 1, managed: false, protected: true }];
    renderPage();

    const nameDiv = screen.getByTestId("external-ext").closest("div.font-medium")!;
    const glyphs = nameDiv.querySelectorAll("[data-testid^='shield-'], [data-testid^='external-']");
    expect([...glyphs].map((g) => g.getAttribute("data-testid"))).toEqual([
      "shield-ext",
      "external-ext",
    ]);
    expect(nameDiv).toHaveTextContent("ext");
  });
});

describe("HostOverviewPage — Services zone", () => {
  it("renders a 'No services' fallback when the services list is empty", async () => {
    mockServices = [];
    renderPage();
    expect(
      screen.getByText(/^No services/),
    ).toBeTruthy();
  });

  it("renders a tile per service with port primary and process secondary", async () => {
    mockServices = [{ port: 5173 }, { port: 8080, process: "api" }];
    renderPage();

    expect(screen.getByText(":5173")).toBeTruthy();
    expect(screen.getByText(":8080")).toBeTruthy();
    expect(screen.getByText("api")).toBeTruthy();
  });

  it("disables 'Open in tab' with a hint when zero servers exist", async () => {
    mockServices = [{ port: 5173 }];
    mockServers = [];
    renderPage();
    expect(screen.getByText(":5173")).toBeTruthy();

    const btn = screen.getByRole("button", { name: "Open in tab" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // The "why disabled" hint is a styled Tip now (260722-73al) — no native
    // title attribute on the button in either state.
    expect(btn.title).toBe("");
    fireEvent.focus(btn);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Create a server first");
  });

  it("creates an instant session + iframe window and navigates when a server genuinely has no sessions", async () => {
    mockServices = [{ port: 5173 }];
    mockServers = [{ name: "runkit", sessionCount: 0 }];
    // SSE cache empty AND the authoritative fetch confirms no sessions.
    vi.mocked(getSessions).mockResolvedValue([]);
    renderPage();
    expect(screen.getByText(":5173")).toBeTruthy();

    const btn = screen.getByRole("button", { name: "Open in tab" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);

    await waitFor(() => expect(vi.mocked(createWindow)).toHaveBeenCalled());
    // The authoritative fetch was consulted before creating anything.
    expect(vi.mocked(getSessions)).toHaveBeenCalledWith("runkit");
    // Then a session was created (server had none, confirmed by the fetch).
    expect(vi.mocked(createSession)).toHaveBeenCalledWith("runkit", "services");
    // The iframe window points at the proxy for that port.
    expect(vi.mocked(createWindow)).toHaveBeenCalledWith(
      "runkit",
      "services",
      "port-5173",
      undefined,
      "/proxy/5173/",
    );
    expect(navigateMock).toHaveBeenCalledWith({ to: "/$server", params: { server: "runkit" } });
  });

  it("fetches an existing session (no createSession) when the SSE cache is empty on a fresh load", async () => {
    // The bug: on a fresh `/` load no per-server stream is attached, so
    // `sessionsByServer` is empty even though the server HAS a session. The old
    // code would then createSession("services"), which 500s if it already
    // exists. The fix falls back to an authoritative getSessions() fetch.
    mockServices = [{ port: 3000 }];
    mockServers = [{ name: "runkit", sessionCount: 1 }];
    mockSessionsByServer = new Map(); // SSE cache not yet populated
    vi.mocked(getSessions).mockResolvedValue([{ name: "existing", windows: [] }]);
    renderPage();
    expect(screen.getByText(":3000")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open in tab" }));

    await waitFor(() => expect(vi.mocked(createWindow)).toHaveBeenCalled());
    expect(vi.mocked(getSessions)).toHaveBeenCalledWith("runkit");
    // No session created — the fetch surfaced the existing one.
    expect(vi.mocked(createSession)).not.toHaveBeenCalled();
    expect(vi.mocked(createWindow)).toHaveBeenCalledWith(
      "runkit",
      "existing",
      "port-3000",
      undefined,
      "/proxy/3000/",
    );
  });

  it("reuses the SSE-cached session (no fetch, no createSession) when the target server has one", async () => {
    mockServices = [{ port: 8080 }];
    mockServers = [{ name: "runkit", sessionCount: 1 }];
    mockSessionsByServer = new Map([["runkit", [{ name: "main", windows: [] }]]]);
    renderPage();
    expect(screen.getByText(":8080")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open in tab" }));

    await waitFor(() => expect(vi.mocked(createWindow)).toHaveBeenCalled());
    // Cache hit short-circuits the fallback fetch entirely.
    expect(vi.mocked(getSessions)).not.toHaveBeenCalled();
    expect(vi.mocked(createSession)).not.toHaveBeenCalled();
    expect(vi.mocked(createWindow)).toHaveBeenCalledWith(
      "runkit",
      "main",
      "port-8080",
      undefined,
      "/proxy/8080/",
    );
  });

  it("enables 'Open in tab' for ANY listed port when a server exists (all listening ports broadcast — no denylist; the iframe load is the on-demand probe)", async () => {
    // 5432 (PostgreSQL) was formerly on the NON_HTTP_PORTS denylist. The backend
    // now passively enumerates and broadcasts ALL listening ports (no HTTP probe,
    // no filter) — a tile is not guaranteed to speak HTTP. Opening a non-HTTP port
    // is harmless: the iframe load IS the on-demand probe (user-initiated, visible),
    // so the only gate is server existence. No denylist remains anywhere (neither
    // the client NON_HTTP_PORTS list nor its "Not a web service" gate).
    mockServices = [{ port: 5432 }, { port: 6379 }];
    mockServers = [{ name: "runkit", sessionCount: 1 }];
    mockSessionsByServer = new Map([["runkit", [{ name: "main", windows: [] }]]]);
    renderPage();
    expect(screen.getByText(":5432")).toBeTruthy();
    expect(screen.getByText(":6379")).toBeTruthy();

    const buttons = screen.getAllByRole("button", { name: "Open in tab" }) as HTMLButtonElement[];
    for (const btn of buttons) {
      expect(btn.disabled).toBe(false);
      // No "Not a web service" hint remains — the only gate is server existence.
      expect(btn.title).toBe("");
    }
  });

  it("de-emphasizes well-known ports (< 1024): grey text + sorted last as a class (260715-vfcz)", async () => {
    // ALL listening ports are now shown (no HTTP filter). System listeners
    // (sshd:22, smtp:25) are de-emphasized like infra servers: grey port text
    // and sorted AFTER regular ports, which keep their port-ascending order.
    mockServices = [
      { port: 22, process: "sshd" },
      { port: 8080 },
      { port: 25, process: "smtp" },
      { port: 3000, process: "node" },
    ];
    mockServers = [{ name: "runkit", sessionCount: 1 }];
    renderPage();

    // Regular ports first (3000, 8080 ascending), then well-known (22, 25).
    const portSpans = screen
      .getAllByText(/^:\d+$/)
      .map((el) => el.textContent);
    expect(portSpans).toEqual([":3000", ":8080", ":22", ":25"]);

    // Well-known port text is grey (text-text-secondary); regular is primary.
    expect(screen.getByText(":22").className).toContain("text-text-secondary");
    expect(screen.getByText(":25").className).toContain("text-text-secondary");
    expect(screen.getByText(":3000").className).toContain("text-text-primary");
    expect(screen.getByText(":8080").className).toContain("text-text-primary");

    // Every tile — well-known included — still has an enabled "Open in tab".
    const buttons = screen.getAllByRole("button", {
      name: "Open in tab",
    }) as HTMLButtonElement[];
    expect(buttons).toHaveLength(4);
    for (const btn of buttons) expect(btn.disabled).toBe(false);
  });

  it("names the iframe window without colons or periods (tmux ValidateName rejects them)", async () => {
    // Regression: the window name was `:${port}`, which tmux rejects ("Window
    // name cannot contain colons or periods"). It must be a valid tmux name.
    mockServices = [{ port: 5173 }];
    mockServers = [{ name: "runkit", sessionCount: 1 }];
    mockSessionsByServer = new Map([["runkit", [{ name: "main", windows: [] }]]]);
    renderPage();
    expect(screen.getByText(":5173")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open in tab" }));

    await waitFor(() => expect(vi.mocked(createWindow)).toHaveBeenCalled());
    const windowName = vi.mocked(createWindow).mock.calls[0][2];
    expect(windowName).toBe("port-5173");
    expect(windowName).not.toContain(":");
    expect(windowName).not.toContain(".");
  });
});

describe("HostOverviewPage — TopBar mount moved to root (260707-4vq2)", () => {
  // The host-mode TopBar mount was lifted to the persistent root layout
  // (`RootTopBar` in app.tsx). `HostOverviewPage` no longer renders a TopBar of
  // its own and (since 260724-6j1v) publishes nothing into the slot context —
  // the connection dot it used to feed moved to the sidebar footer, and `/`
  // has no sidebar.
  // The TopBar's own rendering (brand crumb, controls, `Host` heading,
  // no-hamburger) is now covered by top-bar.test.tsx (which renders TopBar in
  // host mode directly) and the top-bar-persistence e2e; asserting those
  // internals on this component — which no longer mounts them — would be a
  // false test (Test Integrity: tests conform to the current structure).

  it("renders NO TopBar of its own — the brand crumb / controls / heading are not this component's DOM", () => {
    renderPage();
    // None of the shared TopBar's landmarks render from HostOverviewPage now.
    expect(screen.queryByLabelText("HexoKit home")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Refresh page")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Host")).not.toBeInTheDocument();
  });

  it("still renders no in-page PageHeading <h1> row — page identity lives in the root top-bar center heading (260704-pr0p)", () => {
    renderPage();
    // The old `[ host ]` <h1> PageHeading row remains gone; the page body
    // carries no level-1 heading of its own (page identity rides the root bar).
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });

  it("renders the in-page `Host Overview` section heading above the zones (260715-zs1y)", () => {
    renderPage();
    // The page-level long-form name is an <h2> SectionHeading (bracket +
    // typed-sweep idiom), rendered above the HOST HEALTH zone.
    const overview = screen.getByRole("heading", { level: 2, name: "Host Overview" });
    expect(overview).toBeInTheDocument();
    // It is the FIRST level-2 heading (sits above Host Health).
    const h2s = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(h2s[0]).toBe("Host Overview");
  });
});

describe("HostOverviewPage — page root ground", () => {
  it("paints the page root on the chrome ground shared with every Shell route", () => {
    const { container } = renderPage();
    // The host page sits on the same flush stage ground as every other route
    // (the chrome itself, under the chrome top bar); the retired inset token
    // must not return.
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("bg-bg-chrome");
    expect(root.className).not.toContain("bg-bg-chrome-raised");
    expect(root.className).not.toContain("bg-bg-inset");
  });
});

describe("HostOverviewPage — BOARDS zone", () => {
  it("renders board tiles above TMUX SERVERS and navigates on click", () => {
    mockBoards = [
      { name: "main", pinCount: 3 },
      { name: "review", pinCount: 1 },
    ];
    renderPage();

    // Heading order: the "Host Overview" page heading, then the zones
    // Host Health → Boards → Tmux Servers → Services.
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toEqual([
      "Host Overview",
      "Host Health",
      "Boards",
      "Tmux Servers",
      "Services",
    ]);

    expect(screen.getByText("2 boards")).toBeInTheDocument();
    expect(screen.getByText("3 pins")).toBeInTheDocument();

    fireEvent.click(screen.getByText("main"));
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/board/$name",
      params: { name: "main" },
    });
  });

  it("shows the pin-to-start hint when no boards exist (section stays visible)", () => {
    renderPage();
    expect(screen.getByText("0 boards")).toBeInTheDocument();
    expect(
      screen.getByText(/^No boards yet — hover a sidebar tab row/),
    ).toBeInTheDocument();
    // Fine pointer (the beforeEach default): the derived palette chord clause
    // rides along — the chord itself is registry-derived, so match its shape.
    expect(screen.getByText(/^No boards yet — .*→ Pin:$/)).toBeInTheDocument();
  });

  it("drops the palette chord from the boards hint on a coarse pointer", () => {
    // Chord hints never render on touch (the app's chord-hints-off-touch rule,
    // 260811-ke2s) — the pin-icon path is all a touch user can act on.
    stubMatchMedia(() => true);
    renderPage();
    expect(
      screen.getByText("No boards yet — hover a sidebar tab row and click its 📌"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/→ Pin:/)).not.toBeInTheDocument();
  });

  it("makes board tiles draggable for reorder (board-list-reorder wiring)", () => {
    mockBoards = [
      { name: "main", pinCount: 3 },
      { name: "review", pinCount: 1 },
    ];
    renderPage();
    // Each board tile is a draggable button (the useBoardListReorder wiring).
    const mainTile = screen.getByText("main").closest("button");
    expect(mainTile).not.toBeNull();
    expect(mainTile).toHaveAttribute("draggable", "true");
    const reviewTile = screen.getByText("review").closest("button");
    expect(reviewTile).toHaveAttribute("draggable", "true");
  });
});

describe("HostOverviewPage — TMUX SERVERS scratch badge (@rk_srv_ephemeral)", () => {
  it("renders the scratch chip + greyed name on a marked tile; unmarked tiles render unchanged", () => {
    mockServers = [
      { name: "alpha", sessionCount: 1 },
      { name: "scratch-box", sessionCount: 1, ephemeral: true },
    ];
    renderPage();

    const chip = screen.getByText("scratch");
    expect(chip).toBeInTheDocument();

    // The marked tile's name is greyed via the shared de-emphasis treatment.
    const markedName = screen.getByText("scratch-box");
    expect(markedName).toHaveClass("text-text-secondary");

    // The unmarked tile keeps the normal emphasis and gets no chip.
    const plainName = screen.getByText("alpha");
    expect(plainName).toHaveClass("text-text-primary");
    expect(plainName.querySelector("span")).toBeNull();
  });

  it("keeps a marked tile clickable — clicking still switches to the server", () => {
    mockServers = [{ name: "scratch-box", sessionCount: 1, ephemeral: true }];
    renderPage();

    fireEvent.click(screen.getByText("scratch-box").closest("button")!);
    // No session data (empty SSE cache + no session order) → bare `/$server`.
    expect(navigateMock).toHaveBeenCalledWith({ to: "/$server", params: { server: "scratch-box" } });
  });
});

describe("status bar gate (260814-ldbs; rework cycle 1)", () => {
  // The page's own beforeEach stubs matchMedia as "everything matches except
  // the coarse-pointer queries" — i.e. NARROW (mobile). These tests re-stub
  // per case.

  it("renders the status bar on a desktop (fine pointer, wide) host page", () => {
    stubMatchMedia(() => false);
    renderPage();
    expect(screen.getByTestId("status-bar")).toBeInTheDocument();
  });

  it("renders NO status bar for a coarse pointer at desktop width — coarse is the mobile experience everywhere", () => {
    // The revised device rule: useIsMobile() is width-OR-coarse, so a coarse
    // desktop-width device (iPad) gets the mobile grid, the chip bar, and the
    // drawer panels — and NO status bar. The gate is `!isMobile`, identical
    // to Shell's, so every route agrees. The stub answers both coarse-pointer
    // queries: a touch-primary device matches `(pointer: coarse)` and
    // `(any-pointer: coarse)` alike, and the tree reads both hooks.
    stubMatchMedia((query) => query.includes("pointer: coarse"));
    renderPage();
    expect(screen.queryByTestId("status-bar")).not.toBeInTheDocument();
  });

  it("renders no status bar on a narrow viewport either", () => {
    stubMatchMedia((query) => query.includes("max-width"));
    renderPage();
    expect(screen.queryByTestId("status-bar")).not.toBeInTheDocument();
  });
});

describe("HOST HEALTH hostname line — instance display name (260723-o7q8)", () => {
  // Full MetricsSnapshot — the status bar (260814-ldbs) reads cpu/mem/ld too.
  function hostSnapshot(hostname: string): MetricsSnapshot {
    return {
      hostname,
      cpu: { samples: [10], current: 10, cores: 4 },
      memory: { used: 1024 ** 3, total: 8 * 1024 ** 3 },
      load: { avg1: 0.1, avg5: 0.1, avg15: 0.1, cpus: 4 },
      disk: { used: 10 * 1024 ** 3, total: 100 * 1024 ** 3 },
      uptime: 60,
    };
  }

  it("prefers the instance-name override over the metrics hostname", () => {
    mockHostMetrics = hostSnapshot("mac-mini");
    renderPage(nameValue({ hostname: "mac-mini", instanceName: "my-box", displayName: "my-box" }));
    // Both the HOST HEALTH zone line and the status bar's host segment show
    // the override (the status bar follows the HOST panel's display rule).
    expect(screen.getAllByText("my-box").length).toBeGreaterThan(0);
    expect(screen.queryByText("mac-mini")).not.toBeInTheDocument();
  });

  it("falls back to the metrics hostname when no override is set", () => {
    mockHostMetrics = hostSnapshot("mac-mini");
    renderPage();
    expect(screen.getAllByText("mac-mini").length).toBeGreaterThan(0);
  });
});
