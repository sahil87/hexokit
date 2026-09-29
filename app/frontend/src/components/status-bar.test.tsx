import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within, act } from "@testing-library/react";
import { StatusBar } from "./status-bar";
import { ChromeProvider } from "@/contexts/chrome-context";
import {
  InstanceNameValueProvider,
  type InstanceName,
} from "@/contexts/instance-name-context";
import { makeWindow, makeWindowWithPanes } from "@/test-utils/fixtures";
import type { MetricsSnapshot } from "@/types";

// Controllable session-context seams: StatusBar leaf-subscribes to the two
// metrics contexts and the tolerant update-notification hook (the HostPanel /
// SidebarFooter precedent) — mocked here so tests need no SessionProvider.
// The clock chip's two reads ride the same mock boundary.
let mockMetrics: MetricsSnapshot | null = null;
let mockHostMetrics: MetricsSnapshot | null = null;
let mockDaemonVersion: string | null = null;
let mockSessionsByServer: Map<string, { operatorStale?: boolean; operatorLastTickAt?: number }[]> = new Map();
vi.mock("@/contexts/session-context", () => ({
  useMetrics: () => mockMetrics,
  useHostMetrics: () => mockHostMetrics,
  useUpdateNotification: () => ({ daemonVersion: mockDaemonVersion }),
  useSessionContext: () => ({ sessionsByServer: mockSessionsByServer }),
}));

// The clock chip's cron data — mocked so no fetch fires and entries are
// controllable per test.
let mockCronEntries: { id: string; name?: string; nextFire?: number }[] = [];
vi.mock("@/hooks/use-cron", () => ({
  useCronData: () => ({ entries: mockCronEntries, deliveries: [] }),
}));

// Copy seam: the segments copy through the shared clipboard lib (via
// useCopyFeedback) — mocked so tests assert the RAW value handed over.
const { mockCopyToClipboard } = vi.hoisted(() => ({ mockCopyToClipboard: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: mockCopyToClipboard }));

function makeMetrics(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  return {
    hostname: "mba",
    cpu: { samples: [10, 17], current: 17, cores: 8 },
    memory: { used: 24 * 1024 ** 3, total: 59 * 1024 ** 3 },
    load: { avg1: 1.12, avg5: 0.9, avg15: 0.7, cpus: 8 },
    disk: { used: 100 * 1024 ** 3, total: 500 * 1024 ** 3 },
    uptime: 3600,
    ...overrides,
  };
}

function renderBar(overrides: Partial<React.ComponentProps<typeof StatusBar>> = {}) {
  const name: InstanceName = {
    hostname: "",
    instanceName: null,
    displayName: "",
    setInstanceName: vi.fn(),
  };
  return render(
    <ChromeProvider>
      <InstanceNameValueProvider value={name}>
        <StatusBar window={null} isConnected={true} {...overrides} />
      </InstanceNameValueProvider>
    </ChromeProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  mockMetrics = null;
  mockHostMetrics = null;
  mockDaemonVersion = null;
  mockSessionsByServer = new Map();
  mockCronEntries = [];
  mockCopyToClipboard.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Drive the fold in jsdom: the probe children's `data-fold` widths come
 *  from `widths`; the bar root's clientWidth is `available`. The
 *  ResizeObserver stub never fires, so the measure runs once at mount —
 *  mount a fresh bar per width case. */
function mockWidths(available: number, widths: Record<string, number>) {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    const key = this.getAttribute("data-fold");
    if (key !== null && key in widths) return widths[key];
    return 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute("data-testid") === "status-bar" ? available : 0;
  });
}

/** Re-mount against new mocked widths (the measure is mount-time only). */
function renderFolded(
  overrides: Partial<React.ComponentProps<typeof StatusBar>>,
  available: number,
  widths: Record<string, number> = PROBE,
) {
  cleanup();
  vi.restoreAllMocks();
  mockWidths(available, widths);
  return renderBar(overrides);
}

/** Round-number probe widths per `data-fold` id. Only present segments are
 *  probed, so unused keys are inert. With the full fixture (all window
 *  layers + metrics + version + server + compose, no zen/clock) the natural
 *  width is left 650 + right 484 (the host/version pair charges its rendered
 *  4px gap, not the cluster's 12) + the 36px fixed charge = 1170. */
const PROBE = {
  git: 80,
  pr: 90,
  fab: 200,
  agt: 90,
  tmx: 50,
  cwd: 80,
  zen: 50,
  metrics: 110,
  ld: 50,
  clock: 70,
  server: 60,
  host: 70,
  version: 50,
  palette: 40,
  compose: 40,
  chevron: 24,
};

/** The full-fold-budget fixture: every window layer plus the whole right
 *  cluster (natural width 1170 at the PROBE widths). */
function fullProps() {
  mockHostMetrics = makeMetrics();
  mockDaemonVersion = "0.9.3";
  return {
    window: makeWindowWithPanes({
      agentState: "waiting",
      agentIdleDuration: "3m",
      fabChange: "260814-ldbs-shell-stage-status-bar",
      fabStage: "apply",
      prNumber: 603,
      prState: "open",
      prChecks: "pass",
      prUrl: "https://github.com/sahil87/run-kit/pull/603",
    }),
    server: "alpha",
    onOpenCompose: vi.fn(),
  } as const;
}

const windowCluster = () => screen.getByTestId("status-bar-window");
const hostCluster = () => screen.getByTestId("status-bar-host");
const openMenu = () => {
  fireEvent.click(screen.getByTestId("status-bar-overflow"));
  return screen.getByRole("menu", { name: "Overflow status segments" });
};
const menuRowTexts = (menu: HTMLElement) =>
  Array.from(menu.querySelectorAll("[role='menuitem']")).map((el) => el.textContent);

describe("StatusBar (260814-ldbs)", () => {
  it("renders the attached frame strip with status semantics", () => {
    renderBar();
    const bar = screen.getByTestId("status-bar");
    expect(bar).toHaveAttribute("role", "region");
    expect(bar.className).toContain("border-t");
    expect(bar.className).toContain("bg-bg-chrome");
  });

  describe("left window cluster (terminal route)", () => {
    it("renders nothing when there is no window", () => {
      renderBar({ window: null });
      expect(screen.queryByTestId("status-bar-window")).not.toBeInTheDocument();
    });

    it("tmx renders the pane id alone for a single pane — strip and overflow row agree", () => {
      // paneIndex 1 models tmux's pane-base-index 1; a single pane must read
      // its id with no ordinal everywhere the bar renders the tmx value.
      const win = makeWindow({
        panes: [{ paneId: "%5", paneIndex: 1, cwd: "/home/user/wt", command: "zsh", isActive: true }],
      });
      renderBar({ window: win });
      expect(within(windowCluster()).getByText("%5")).toBeInTheDocument();
      expect(within(windowCluster()).queryByText(/1\/1/)).toBeNull();
      // Folded into the menu, the row reads the same one string.
      renderFolded({ window: win }, 100);
      const menu = openMenu();
      const tmxRow = within(menu).getByRole("menuitem", { name: "Copy tmux pane id" });
      expect(tmxRow).toHaveTextContent("tmx %5");
      expect(tmxRow.textContent).not.toContain("1/1");
    });

    it("renders the git/tmx/cwd identity registers in descending-relevance order", () => {
      renderBar({ window: makeWindowWithPanes() });
      expect(within(windowCluster()).getByText("%5")).toBeInTheDocument();
      // cwd renders as the BASENAME with the full path in the tooltip.
      expect(within(windowCluster()).getByText("run-kit")).toBeInTheDocument();
      expect(within(windowCluster()).getByText("main")).toBeInTheDocument();
      // There is no out register in the strip (deleted outright).
      expect(within(windowCluster()).queryByText("zsh")).not.toBeInTheDocument();
      // Strip order is descending relevance: git → tmx → cwd.
      const text = windowCluster().textContent ?? "";
      expect(text.indexOf("main")).toBeLessThan(text.indexOf("%5"));
      expect(text.indexOf("%5")).toBeLessThan(text.indexOf("run-kit"));
    });

    it("dims the branch's six-digit date prefix on the ⑂ segment; the overflow row stays plain", () => {
      const win = makeWindow({
        panes: [{ paneId: "%5", paneIndex: 0, cwd: "/home/user/wt", command: "zsh", isActive: true, gitBranch: "260913-png4-compose-default-on" }],
      });
      renderBar({ window: win });
      expect(within(windowCluster()).getByText("260913-").className).toContain("text-text-secondary");
      expect(within(windowCluster()).getByText("png4-compose-default-on")).toBeInTheDocument();
      // Fold git into the menu: the row is a menu item and stays plain.
      renderFolded({ window: win }, 100);
      const menu = openMenu();
      const gitRow = within(menu).getByRole("menuitem", { name: "Copy git branch" });
      expect(gitRow).toHaveTextContent("⑂ 260913-png4-compose-default-on");
      expect(gitRow.querySelector(".text-text-secondary")).toBeNull();
    });

    it("renders agt/fab/PR registers when those layers are present", () => {
      const win = makeWindowWithPanes({
        agentState: "waiting",
        agentIdleDuration: "3m",
        fabChange: "260814-ldbs-shell-stage-status-bar",
        fabStage: "apply",
        prNumber: 603,
        prState: "open",
        prChecks: "pass",
        prUrl: "https://github.com/sahil87/run-kit/pull/603",
      });
      renderBar({ window: win });
      expect(within(windowCluster()).getByText("waiting 3m")).toBeInTheDocument();
      expect(within(windowCluster()).getByText("ldbs shell-stage-status-bar · apply")).toBeInTheDocument();
      // PR renders as an open-first anchor (native open semantics).
      const pr = screen.getByRole("link", { name: "Open PR #603 in a new tab" });
      expect(pr).toHaveAttribute("href", "https://github.com/sahil87/run-kit/pull/603");
      expect(pr).toHaveAttribute("target", "_blank");
      // The ↗ glyph marks the open affordance and rides the anchor.
      expect(within(pr).getByText("↗")).toBeInTheDocument();
      // Full descending-relevance order: git → pr → fab → agt (→ tmx → cwd).
      const text = windowCluster().textContent ?? "";
      expect(text.indexOf("main")).toBeLessThan(text.indexOf("#603"));
      expect(text.indexOf("#603")).toBeLessThan(text.indexOf("ldbs shell-stage-status-bar"));
      expect(text.indexOf("ldbs shell-stage-status-bar")).toBeLessThan(text.indexOf("waiting 3m"));
    });

    it("renders the PR register as plain text when no URL exists", () => {
      const win = makeWindowWithPanes({ prNumber: 604, prState: "merged" });
      renderBar({ window: win });
      expect(screen.queryByRole("link", { name: /Open PR/ })).not.toBeInTheDocument();
      expect(within(windowCluster()).getByText("#604")).toBeInTheDocument();
      expect(within(windowCluster()).getByText("merged")).toBeInTheDocument();
      // Nothing to open ⇒ no open-affordance glyph on the passive span.
      expect(within(windowCluster()).queryByText("↗")).not.toBeInTheDocument();
    });

    it("a branch carrying the fab change drops the slug from the segment; the state token is coloured", () => {
      const win = makeWindow({
        fabChange: "260814-ldbs-shell-stage-status-bar",
        fabStage: "apply",
        fabDisplayState: "failed",
        panes: [
          { paneId: "%5", paneIndex: 0, cwd: "/home/user/wt", command: "claude", isActive: true, gitBranch: "260814-ldbs-shell-stage-status-bar" },
        ],
      });
      renderBar({ window: win });
      // The branch (⑂) already spells the slug — the fab segment shows the id form.
      expect(within(windowCluster()).getByText("ldbs · apply")).toBeInTheDocument();
      const fabText = windowCluster().textContent ?? "";
      expect(fabText).not.toContain("ldbs shell-stage-status-bar · apply");
      // The displayState token renders in the fab hue vocabulary.
      expect(within(windowCluster()).getByText("· failed").className).toContain("text-signal-red");
    });

    it("an off-change branch keeps the slug (the off-branch signal)", () => {
      // makeWindowWithPanes pins gitBranch "main" — the slug stays.
      const win = makeWindowWithPanes({
        fabChange: "260814-ldbs-shell-stage-status-bar",
        fabStage: "apply",
      });
      renderBar({ window: win });
      expect(within(windowCluster()).getByText("ldbs shell-stage-status-bar · apply")).toBeInTheDocument();
    });

    it("an unknown fab displayState renders the token with no colour class", () => {
      const win = makeWindowWithPanes({
        fabChange: "260814-ldbs-shell-stage-status-bar",
        fabStage: "apply",
        fabDisplayState: "dancing",
      });
      renderBar({ window: win });
      const token = within(windowCluster()).getByText("· dancing");
      expect(token.className).not.toContain("text-signal");
      expect(token.className).not.toContain("text-accent-green");
    });

    it("marks a deleted cwd in red with the (deleted) tag", () => {
      const win = makeWindow({
        worktreePath: "/home/user/wt/gone",
        panes: [
          { paneId: "%5", paneIndex: 0, cwd: "/home/user/wt/gone", command: "zsh", isActive: true, cwdMissing: true },
        ],
      });
      renderBar({ window: win });
      const cwd = within(windowCluster()).getByText(/gone \(deleted\)/);
      expect(cwd.className).toContain("text-signal-red");
    });
  });

  describe("right host cluster (every desktop route)", () => {
    it("renders compact host metrics, host+version, and the connection dot", () => {
      mockHostMetrics = makeMetrics();
      mockDaemonVersion = "0.9.3";
      renderBar({ server: "alpha" });
      const host = hostCluster();
      expect(within(host).getByText("cpu")).toBeInTheDocument();
      expect(within(host).getByText("17%")).toBeInTheDocument();
      // mem renders as a PERCENTAGE (24G/59G → 41%); the absolute form lives
      // in the flyout only.
      expect(within(host).getByText("41%")).toBeInTheDocument();
      expect(within(host).queryByText("24G/59G")).toBeNull();
      // ld is the normalized 1-minute percentage (112/8 → 14%).
      expect(within(host).getByText("14%")).toBeInTheDocument();
      expect(host).toHaveTextContent("alpha");
      expect(host).toHaveTextContent("mba");
      expect(host).toHaveTextContent("v0.9.3");
      expect(screen.getByLabelText("Connected")).toBeInTheDocument();
    });

    it("host and version are one visual pair of two independent fold items — the wrapper never truncates", () => {
      mockHostMetrics = makeMetrics();
      mockDaemonVersion = "0.9.3";
      renderBar({ server: "alpha" });
      const hostBtn = screen.getByRole("button", { name: "Copy host name" });
      const versionBtn = screen.getByRole("button", { name: "Copy version" });
      // One visual pair (shared wrapper), but the wrapper itself never
      // truncates — the fold, not an ellipsis, decides when a segment leaves.
      expect(hostBtn.parentElement).toBe(versionBtn.parentElement);
      expect(hostBtn.parentElement!.className).not.toContain("truncate");
      expect(hostBtn.className).not.toContain("truncate");
      expect(versionBtn.className).toContain("shrink-0");
      // No breakpoint gating remains — the measured fold decides visibility.
      expect(versionBtn.className).not.toContain("min-[700px]");
    });

    it("metrics numerals are fixed-width, so the metrics tick cannot change a probed width", () => {
      mockHostMetrics = makeMetrics();
      renderBar({ server: "alpha" });
      const host = hostCluster();
      for (const text of ["17%", "41%", "14%"]) {
        const span = within(host).getByText(text);
        expect(span.className).toContain("tabular-nums");
        expect(span.className).toContain("min-w-[4ch]");
      }
    });

    it("ld is its own passive segment — no copy button, no flyout trigger", () => {
      mockHostMetrics = makeMetrics();
      renderBar({ server: "alpha" });
      const ldLabel = within(hostCluster()).getByText("ld");
      expect(ldLabel.closest("button")).toBeNull();
      expect(ldLabel.closest('[aria-label="Host metrics — details on hover"]')).toBeNull();
    });

    it("server-scoped metrics win over the host broadcast (the HostPanel rule)", () => {
      mockMetrics = makeMetrics({ hostname: "scoped", cpu: { samples: [40], current: 40, cores: 4 } });
      mockHostMetrics = makeMetrics({ hostname: "global" });
      renderBar();
      expect(hostCluster()).toHaveTextContent("40%");
      expect(hostCluster()).not.toHaveTextContent("global");
    });

    it("omits the metrics and version fragments before the first events (no placeholders)", () => {
      renderBar({ server: "alpha" });
      const host = hostCluster();
      expect(host).not.toHaveTextContent("cpu");
      expect(host).not.toHaveTextContent(/vundefined/);
      expect(host).toHaveTextContent("alpha");
    });

    it("shows the disconnected dot state", () => {
      renderBar({ isConnected: false });
      expect(screen.getByLabelText("Disconnected")).toBeInTheDocument();
    });

    it("opens the host-metrics flyout (the shared HostMetrics graphs) on trigger focus", () => {
      mockHostMetrics = makeMetrics();
      renderBar();
      fireEvent.focus(screen.getByLabelText("Host metrics — details on hover"));
      // The flyout renders the shared HostMetrics rows (the uptime proves it —
      // the strip itself renders no uptime) and keeps the ABSOLUTE mem value.
      expect(screen.getByText("1h 0m")).toBeInTheDocument();
      expect(screen.getByText("24G/59G")).toBeInTheDocument();
    });
  });

  describe("hints (the deleted bottom bar's desktop remnants)", () => {
    it("dispatches palette:open from the ⌘K hint", () => {
      const listener = vi.fn();
      document.addEventListener("palette:open", listener);
      renderBar();
      fireEvent.click(screen.getByRole("button", { name: "Open command palette" }));
      expect(listener).toHaveBeenCalled();
      document.removeEventListener("palette:open", listener);
    });

    it("fires onOpenCompose from the a▏ hint and mirrors the strip's pressed state", () => {
      const onOpenCompose = vi.fn();
      // The preference is on by default; seed the explicit opt-out so the
      // chip's pressed state has an "off" to mirror.
      localStorage.setItem("hexokit-compose-strip", "false");
      renderBar({ onOpenCompose });
      const chip = screen.getByTestId("status-bar-compose");
      expect(chip).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(chip);
      expect(onOpenCompose).toHaveBeenCalled();
    });
  });

  it("survives the metrics stream arriving mid-render — both metric hooks are called unconditionally (rework: Rules-of-Hooks fix)", () => {
    // Regression guard for the `useMetrics() ?? useHostMetrics()` conditional
    // call: with the short-circuit, the first tick (server metrics arriving)
    // changed the hook ORDER and React threw. Now both hooks always run and
    // the coalesce happens after.
    const tree = (window: React.ComponentProps<typeof StatusBar>["window"]) => (
      <ChromeProvider>
        <InstanceNameValueProvider
          value={{ hostname: "", instanceName: null, displayName: "", setInstanceName: vi.fn() }}
        >
          <StatusBar window={window} isConnected={true} />
        </InstanceNameValueProvider>
      </ChromeProvider>
    );
    const { rerender } = render(tree(null));
    expect(screen.queryByText(/cpu/)).not.toBeInTheDocument();
    // Host-global metrics arrive first (every route)…
    mockHostMetrics = makeMetrics({ cpu: { samples: [11], current: 11, cores: 8 } });
    rerender(tree(null));
    expect(within(hostCluster()).getByText("11%")).toBeInTheDocument();
    // …then the server-scoped slice lands and WINS (the HostPanel rule).
    mockMetrics = makeMetrics({ cpu: { samples: [42], current: 42, cores: 4 } });
    rerender(tree(null));
    expect(within(hostCluster()).getByText("42%")).toBeInTheDocument();
    // …and a window record arriving later (SSE snapshot) adds the cluster.
    rerender(tree(makeWindowWithPanes()));
    expect(screen.getByTestId("status-bar-window")).toBeInTheDocument();
  });

  describe("measured priority fold", () => {
    it("the hidden probe carries no accessible identity — every labelled control resolves exactly once", () => {
      // aria-hidden + inert on the probe container do NOT hide raw attributes
      // from label-text queries (Playwright getByLabel, Testing Library
      // getByLabelText), so a labelled probe copy would make each strip
      // control resolve twice — a strict-mode violation in e2e.
      mockHostMetrics = makeMetrics();
      mockDaemonVersion = "0.9.3";
      mockCronEntries = [{ id: "a1", name: "deploy", nextFire: Math.floor(Date.now() / 1000) + 300 }];
      const win = makeWindowWithPanes({
        agentState: "waiting",
        agentIdleDuration: "3m",
        fabChange: "260814-ldbs-shell-stage-status-bar",
        fabStage: "apply",
        prNumber: 603,
        prState: "open",
        prChecks: "pass",
        prUrl: "https://github.com/sahil87/run-kit/pull/603",
      });
      renderBar({ window: win, server: "alpha", onOpenCompose: vi.fn(), zenActive: true, onExitZen: vi.fn() });
      const probe = screen.getByTestId("status-bar-probe");
      // Every candidate (15 segments + the chevron) is probed …
      expect(probe.querySelectorAll("[data-fold]")).toHaveLength(16);
      // … and no copy is addressable by label, testid, title, link, pressed state, or role.
      expect(probe.querySelectorAll("[aria-label],[data-testid],[title],[href],[aria-pressed],[role]")).toHaveLength(0);
      for (const name of [
        "Open command palette",
        "Compose",
        "Copy git branch",
        "Copy tmux pane id",
        "Copy working directory path",
        "Copy fab change id",
        "Copy server name",
        "Copy host name",
        "Copy version",
        "Cron list",
        "Exit zen mode",
        "Open PR #603 in a new tab",
      ]) {
        expect(screen.getAllByLabelText(name), name).toHaveLength(1);
      }
    });

    it("a jsdom render with no width mocks lands on the cold default — every segment, no chevron", () => {
      // All probe widths read 0, so the fold keeps the fully-expanded cold
      // default (the safe cold answer) and no … button exists.
      renderBar(fullProps());
      expect(within(windowCluster()).getByText("%5")).toBeInTheDocument();
      expect(within(hostCluster()).getByText("41%")).toBeInTheDocument();
      expect(screen.queryByTestId("status-bar-overflow")).toBeNull();
    });

    it("a wide budget renders every segment in the strip and no chevron", () => {
      mockWidths(1170, PROBE);
      renderBar(fullProps());
      expect(within(windowCluster()).getByText("%5")).toBeInTheDocument();
      expect(within(windowCluster()).getByText("run-kit")).toBeInTheDocument();
      expect(within(hostCluster()).getByText("ld")).toBeInTheDocument();
      expect(screen.getByTestId("status-bar-compose")).toBeInTheDocument();
      expect(screen.queryByTestId("status-bar-overflow")).toBeNull();
    });

    it("a budget short by one ld folds ld first — the chevron appears with exactly one informational row", () => {
      // ld is priority 0, the first to die.
      mockWidths(1169, PROBE);
      renderBar(fullProps());
      expect(within(hostCluster()).queryByText("ld")).toBeNull();
      const menu = openMenu();
      const rows = menu.querySelectorAll("[role='menuitem']");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveTextContent("ld 14%");
      expect(rows[0].tagName).toBe("SPAN");
    });

    it("a narrow budget folds tmx/cwd/ld/hints in strip order — copy segments stay copy buttons", () => {
      mockWidths(920, PROBE);
      renderBar(fullProps());
      // Folded out of the strip…
      expect(within(windowCluster()).queryByText("%5")).toBeNull();
      expect(within(windowCluster()).queryByText("run-kit")).toBeNull();
      expect(within(windowCluster()).getByText("main")).toBeInTheDocument();
      expect(within(hostCluster()).queryByText("ld")).toBeNull();
      expect(screen.queryByTestId("status-bar-compose")).toBeNull();
      // …and into the menu, in strip order (left cluster first).
      const menu = openMenu();
      expect(menuRowTexts(menu)).toEqual([
        "tmx %5",
        "cwd run-kit",
        "ld 14%",
        "⌘K Command palette",
        "a▏ Compose",
      ]);
      const tmxRow = within(menu).getByRole("menuitem", { name: "Copy tmux pane id" });
      expect(tmxRow.tagName).toBe("BUTTON");
      fireEvent.click(tmxRow);
      expect(mockCopyToClipboard).toHaveBeenCalledWith("%5");
      const cwdRow = within(menu).getByRole("menuitem", { name: "Copy working directory path" });
      fireEvent.click(cwdRow);
      expect(mockCopyToClipboard).toHaveBeenCalledWith("/home/user/code/run-kit");
      // Copy rows keep the menu open.
      expect(screen.getByRole("menu", { name: "Overflow status segments" })).toBeInTheDocument();
      // Escape closes and refocuses the trigger.
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("menu", { name: "Overflow status segments" })).not.toBeInTheDocument();
      expect(document.activeElement).toBe(screen.getByTestId("status-bar-overflow"));
    });

    it("the … menu lists exactly the folded ids in strip order — window, metrics, identity, and hint rows", () => {
      mockWidths(500, PROBE);
      const listener = vi.fn();
      document.addEventListener("palette:open", listener);
      renderBar(fullProps());
      const menu = openMenu();
      expect(menuRowTexts(menu)).toEqual([
        "⑂ main",
        "agt waiting 3m",
        "tmx %5",
        "cwd run-kit",
        "cpu 17% · mem 41%",
        "ld 14%",
        "alpha",
        "v0.9.3",
        "⌘K Command palette",
        "a▏ Compose",
      ]);
      // No out row — the out register is deleted from the bar.
      expect(menuRowTexts(menu).some((t) => t?.startsWith("out "))).toBe(false);
      // Row kinds: copy buttons, informational spans, action rows.
      expect(within(menu).getByRole("menuitem", { name: "Copy server name" }).tagName).toBe("BUTTON");
      expect(within(menu).getByRole("menuitem", { name: "Copy version" }).tagName).toBe("BUTTON");
      // The palette row fires the real action and closes the menu.
      fireEvent.click(within(menu).getByRole("menuitem", { name: "⌘K Command palette" }));
      expect(listener).toHaveBeenCalled();
      expect(screen.queryByRole("menu", { name: "Overflow status segments" })).not.toBeInTheDocument();
      document.removeEventListener("palette:open", listener);
    });

    it("a never-fold-only overflow truncates the fab value span and nothing else", () => {
      // Every foldable segment folds; the never-fold set (pr + fab) still
      // overflows, so the rightmost truncatable survivor takes the ellipsis.
      mockWidths(300, PROBE);
      renderBar(fullProps());
      const truncating = windowCluster().querySelectorAll(".truncate");
      expect(truncating).toHaveLength(1);
      expect(truncating[0]).toHaveTextContent("ldbs shell-stage-status-bar · apply");
      // pr never folds and is not the survivor — fab sits right of it.
      expect(within(windowCluster()).getByText("#603")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Open PR #603 in a new tab" }).className).not.toContain("truncate");
      // Truncation is strip-only: the probe measures natural widths, so the
      // fold's truncateId never reaches it.
      expect(screen.getByTestId("status-bar-probe").querySelectorAll(".truncate")).toHaveLength(0);
    });

    it("a paneId-less tmx folds to an informational span, not a copy button", () => {
      mockWidths(100, PROBE);
      renderBar({ window: makeWindow() });
      const menu = openMenu();
      const tmxRow = Array.from(menu.querySelectorAll<HTMLElement>("[role='menuitem']")).find((el) =>
        el.textContent?.startsWith("tmx "),
      );
      expect(tmxRow?.tagName).toBe("SPAN");
    });

    it("roves focus through the folded rows with ArrowDown/ArrowUp — informational rows included", async () => {
      // Most rows are informational spans (`role="menuitem" tabIndex={-1}`), so
      // arrow-nav is what makes them reachable at all: without it a keyboard
      // user could open the menu and never read a segment (Constitution V).
      // Mirrors `top-bar-overflow-menu.tsx`'s contract.
      mockWidths(700, PROBE);
      renderBar(fullProps());
      const menu = openMenu();
      const rows = Array.from(menu.querySelectorAll<HTMLElement>("[role='menuitem']"));
      // tmx · cwd · cpu·mem · ld · server · palette · compose
      expect(rows).toHaveLength(7);

      // Opening moves focus into the panel (rAF-deferred, like the top bar).
      await waitFor(() => expect(document.activeElement).toBe(rows[0]));

      fireEvent.keyDown(document, { key: "ArrowDown" });
      expect(document.activeElement).toBe(rows[1]);

      fireEvent.keyDown(document, { key: "ArrowUp" });
      expect(document.activeElement).toBe(rows[0]);

      // Wraps backwards from the first row to the last.
      fireEvent.keyDown(document, { key: "ArrowUp" });
      expect(document.activeElement).toBe(rows[rows.length - 1]);
    });
  });

  describe("clock chip (260910-6ehs)", () => {
    it("is omitted with zero entries and no staleness", () => {
      renderBar({ server: "alpha" });
      expect(screen.queryByTestId("status-bar-clock")).not.toBeInTheDocument();
    });

    it("shows ◷ in {rel} for the soonest nextFire — a foldable segment (prio 4), never breakpoint-hidden", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      mockCronEntries = [
        { id: "b2", name: "nightly", nextFire: nowSec + 3600 },
        { id: "a1", name: "deploy", nextFire: nowSec + 300 },
      ];
      renderBar({ server: "alpha" });

      const chip = screen.getByTestId("status-bar-clock");
      // The soonest fire wins, not the first listed.
      expect(chip).toHaveTextContent("◷ in 5m");
      expect(chip.className).toContain("flex");
      expect(chip.className).not.toContain("hidden");
    });

    it("stale wins over entries: ◷ stale {age} in yellow, never folded", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      mockCronEntries = [{ id: "a1", name: "deploy", nextFire: nowSec + 300 }];
      mockSessionsByServer = new Map([
        ["alpha", [{ operatorStale: true, operatorLastTickAt: nowSec - 120 }]],
      ]);
      renderBar({ server: "alpha" });

      const chip = screen.getByTestId("status-bar-clock");
      expect(chip).toHaveTextContent("◷ stale 2m");
      expect(chip.className).toContain("text-signal-yellow");
      expect(chip.className).toContain("flex");
      expect(chip.className).not.toContain("hidden");
    });

    it("the stale chip survives a budget that folds the next-fire chip — and never gets a clk row", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      // Next-fire: the chip folds at this budget (prio 4) and its row shows.
      mockCronEntries = [{ id: "a1", name: "deploy", nextFire: nowSec + 300 }];
      renderFolded({ server: "alpha" }, 170);
      expect(screen.queryByTestId("status-bar-clock")).toBeNull();
      expect(within(openMenu()).getByRole("menuitem", { name: "◷ Cron List" })).toBeInTheDocument();

      // Stale: the chip never folds (the connection-dot alarm precedent), so
      // it stays in the strip at the same budget and needs no menu row.
      mockSessionsByServer = new Map([
        ["alpha", [{ operatorStale: true, operatorLastTickAt: nowSec - 120 }]],
      ]);
      renderFolded({ server: "alpha" }, 170);
      expect(screen.getByTestId("status-bar-clock")).toHaveTextContent("◷ stale 2m");
      expect(within(openMenu()).queryByRole("menuitem", { name: "◷ Cron List" })).toBeNull();
    });

    it("clicking the chip dispatches the quake terminal request with segment: list", () => {
      const nowSec = Math.floor(Date.now() / 1000);
      mockCronEntries = [{ id: "a1", name: "deploy", nextFire: nowSec + 300 }];
      const seen: unknown[] = [];
      const listener = (e: Event) => seen.push((e as CustomEvent<unknown>).detail);
      document.addEventListener("rk:quake-terminal", listener);
      try {
        renderBar({ server: "alpha" });
        fireEvent.click(screen.getByTestId("status-bar-clock"));
      } finally {
        document.removeEventListener("rk:quake-terminal", listener);
      }

      expect(seen).toEqual([{ action: "open", segment: "list" }]);
    });
  });

  describe("copy affordances (the Pane panel's CopyableRow contract)", () => {
    it("left-cluster segments copy RAW values (branch, change id, pane id, full path) with the copied ✓ label swap and 1s revert", () => {
      vi.useFakeTimers();
      const win = makeWindowWithPanes({ fabChange: "260814-ldbs-shell-stage-status-bar", fabStage: "apply" });
      renderBar({ window: win });

      // git — copies the branch name, label (⑂) swaps to copied ✓, then reverts.
      fireEvent.click(screen.getByRole("button", { name: "Copy git branch" }));
      expect(mockCopyToClipboard).toHaveBeenCalledWith("main");
      const cluster = windowCluster();
      expect(within(cluster).getByText("copied ✓")).toBeInTheDocument();
      // The swap is strip-only: the probe keeps the natural label, so the
      // transient feedback can never change a probed width.
      const probe = screen.getByTestId("status-bar-probe");
      expect(within(probe).queryByText("copied ✓")).not.toBeInTheDocument();
      expect(within(probe).getByText("⑂")).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1000));
      expect(within(cluster).queryByText("copied ✓")).not.toBeInTheDocument();

      // fab — copies the 4-char change id, never the display line.
      fireEvent.click(screen.getByRole("button", { name: "Copy fab change id" }));
      expect(mockCopyToClipboard).toHaveBeenCalledWith("ldbs");
      // tmx — copies the pane id, not the pane N/M text.
      fireEvent.click(screen.getByRole("button", { name: "Copy tmux pane id" }));
      expect(mockCopyToClipboard).toHaveBeenCalledWith("%5");
      // cwd — copies the FULL path (the strip shows the basename).
      fireEvent.click(screen.getByRole("button", { name: "Copy working directory path" }));
      expect(mockCopyToClipboard).toHaveBeenCalledWith("/home/user/code/run-kit");
      vi.useRealTimers();
    });

    it("an in-progress text selection short-circuits the copy (the select gesture wins)", () => {
      renderBar({ window: makeWindowWithPanes() });
      vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "picked text" } as Selection);
      fireEvent.click(screen.getByRole("button", { name: "Copy git branch" }));
      expect(mockCopyToClipboard).not.toHaveBeenCalled();
      expect(screen.queryByText("copied ✓")).not.toBeInTheDocument();
    });

    it("right-cluster identity fragments copy their displayed strings; the fragment text swaps to copied ✓", () => {
      mockHostMetrics = makeMetrics();
      mockDaemonVersion = "0.9.3";
      renderBar({ server: "alpha" });
      fireEvent.click(screen.getByRole("button", { name: "Copy server name" }));
      expect(mockCopyToClipboard).toHaveBeenCalledWith("alpha");
      fireEvent.click(screen.getByRole("button", { name: "Copy host name" }));
      expect(mockCopyToClipboard).toHaveBeenCalledWith("mba");
      fireEvent.click(screen.getByRole("button", { name: "Copy version" }));
      expect(mockCopyToClipboard).toHaveBeenCalledWith("v0.9.3");
      // Unlabeled fragment: its own text is the feedback slot.
      expect(screen.getByRole("button", { name: "Copy version" })).toHaveTextContent("copied ✓");
      // The swap is strip-only here too — the probe's fragments stay natural.
      const probe = screen.getByTestId("status-bar-probe");
      expect(within(probe).queryByText("copied ✓")).not.toBeInTheDocument();
      expect(within(probe).getByText("v0.9.3")).toBeInTheDocument();
    });

    it("segments without a stable raw value stay passive — agt, metrics, the connection dot, and a paneId-less tmx", () => {
      mockHostMetrics = makeMetrics();
      const win = makeWindowWithPanes({ agentState: "waiting", agentIdleDuration: "3m" });
      renderBar({ window: win });
      expect(within(windowCluster()).getByText("waiting 3m").closest("button")).toBeNull();
      expect(within(hostCluster()).getByText("cpu").closest("button")).toBeNull();
      expect(screen.getByLabelText("Connected").closest("button")).toBeNull();
      cleanup();
      // No panes ⇒ no pane id ⇒ the tmx segment renders but is not a button.
      renderBar({ window: makeWindow() });
      expect(within(windowCluster()).getByText("tmx").closest("button")).toBeNull();
    });

    it("overflow rows mirroring copyable segments are copy-action buttons — full raw value, menu stays open, keyboard-reachable", async () => {
      mockWidths(500, PROBE);
      renderBar(fullProps());
      const menu = openMenu();

      // Roving focus lands on the first row — the git COPY row, a real button
      // (natively Enter/Space activatable — Constitution V).
      const gitRow = within(menu).getByRole("menuitem", { name: "Copy git branch" });
      await waitFor(() => expect(document.activeElement).toBe(gitRow));
      expect(gitRow.tagName).toBe("BUTTON");

      // The cwd row displays the basename but copies the FULL path; the row's
      // register key swaps to copied ✓ and the menu does NOT close.
      const cwdRow = within(menu).getByRole("menuitem", { name: "Copy working directory path" });
      fireEvent.click(cwdRow);
      expect(mockCopyToClipboard).toHaveBeenCalledWith("/home/user/code/run-kit");
      expect(cwdRow).toHaveTextContent("copied ✓ run-kit");
      expect(screen.getByRole("menu", { name: "Overflow status segments" })).toBeInTheDocument();

      // The right-cluster copy fragments gain rows under the fold: version,
      // server, and host copy their displayed strings from the menu too.
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy version" }));
      expect(mockCopyToClipboard).toHaveBeenCalledWith("v0.9.3");
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy server name" }));
      expect(mockCopyToClipboard).toHaveBeenCalledWith("alpha");

      // Metrics rows mirror the strip's passive segments: informational spans.
      const ldRow = Array.from(menu.querySelectorAll<HTMLElement>("[role='menuitem']")).find((el) =>
        el.textContent?.startsWith("ld "),
      );
      expect(ldRow?.tagName).toBe("SPAN");
    });
  });
});
