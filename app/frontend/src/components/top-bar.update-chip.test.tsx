import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { TopBar } from "./top-bar";
import { ChromeProvider } from "@/contexts/chrome-context";
import { ThemeProvider } from "@/contexts/theme-context";
import { ToastProvider } from "@/components/toast";
import { SettingsDialogProvider } from "@/contexts/settings-dialog-context";
import {
  StandaloneSessionContextProvider,
  shouldReloadOnVersion,
} from "@/contexts/session-context";
import type { SessionContextType, UpdateAvailable, UpdateTool } from "@/contexts/session-context";

beforeEach(() => {
  // ThemeProvider reads matchMedia; jsdom doesn't provide it.
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: true,
      media: "(prefers-color-scheme: dark)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// updateAvailable builds an UpdateAvailable payload from matched tools, deriving
// the composite key (sorted tool@latest) and the legacy current/latest from the
// run-kit row (mirroring the backend).
function updateAvailable(tools: UpdateTool[]): UpdateAvailable {
  const key = tools
    .map((t) => `${t.tool}@${t.latest}`)
    .sort()
    .join(",");
  const rk = tools.find((t) => t.tool === "run-kit");
  return { tools, key, current: rk?.current ?? "", latest: rk?.latest ?? "" };
}

const runKit = (current: string, latest: string): UpdateTool => ({ tool: "run-kit", current, latest });

function renderChip(sessionValue: Partial<SessionContextType>) {
  return render(
    <ToastProvider>
      <ThemeProvider>
        <ChromeProvider>
          {/* The top bar's Settings gear (260812-d1at) consumes this context. */}
          <SettingsDialogProvider>
            <StandaloneSessionContextProvider value={sessionValue}>
            <TopBar
              mode="server"
              sessions={[]}
              currentSession={null}
              currentWindow={null}
              sessionName=""
              windowName=""
              sidebarOpen={false}
              server="runkit"
              onNavigate={vi.fn()}
              onToggleSidebar={vi.fn()}
              onCreateWindow={vi.fn()}
            />
            </StandaloneSessionContextProvider>
          </SettingsDialogProvider>
        </ChromeProvider>
      </ThemeProvider>
    </ToastProvider>,
  );
}

describe("UpdateChip", () => {
  it("renders `⬆ v{latest}` and the v{current} → v{latest} transition title for a single run-kit match", () => {
    renderChip({
      daemonVersion: "0.5.3",
      updateAvailable: updateAvailable([runKit("0.5.3", "0.6.0")]),
    });
    // The rest-state aria shows the transition (both versions), not only
    // the target (260715-ifco R9). The hover hint is a styled Tip now
    // (260722-73al) — no native title attribute.
    const chip = screen.getByLabelText("Update HexoKit: v0.5.3 → v0.6.0");
    expect(chip).toBeInTheDocument();
    expect(chip).not.toHaveAttribute("title");
    // The visible chip label is unchanged — still `⬆ v{latest}`.
    expect(screen.getByText("⬆ v0.6.0")).toBeInTheDocument();
  });

  it("keeps the single-version `⬆ v{latest}` form for a self row named `hexokit` (shll >= v0.1.34 roster name)", () => {
    renderChip({
      daemonVersion: "0.5.3",
      updateAvailable: updateAvailable([{ tool: "hexokit", current: "0.5.3", latest: "0.6.0" }]),
    });
    expect(screen.getByText("⬆ v0.6.0")).toBeInTheDocument();
    expect(screen.getByLabelText("Update HexoKit: v0.5.3 → v0.6.0")).toBeInTheDocument();
  });

  it("renders a count form + per-tool transitions in the title for a multi-tool match", () => {
    renderChip({
      daemonVersion: "3.8.0",
      updateAvailable: updateAvailable([
        runKit("3.8.0", "3.9.0"),
        { tool: "fab-kit", current: "2.16.0", latest: "2.17.0" },
      ]),
    });
    // Visible label = count form.
    expect(screen.getByText("⬆ updates (2)")).toBeInTheDocument();
    // Title/aria names every per-tool transition.
    const chip = screen.getByLabelText(
      "Update: run-kit v3.8.0 → v3.9.0, fab-kit v2.16.0 → v2.17.0",
    );
    expect(chip).toBeInTheDocument();
  });

  it("uses the count form for a SINGLE non-run-kit tool", () => {
    renderChip({
      daemonVersion: "3.9.0",
      updateAvailable: updateAvailable([{ tool: "fab-kit", current: "2.16.0", latest: "2.17.0" }]),
    });
    expect(screen.getByText("⬆ updates (1)")).toBeInTheDocument();
    expect(screen.getByLabelText("Update: fab-kit v2.16.0 → v2.17.0")).toBeInTheDocument();
  });

  it("hides when no update is available", () => {
    renderChip({ daemonVersion: "0.5.3", updateAvailable: null });
    expect(screen.queryByText(/⬆ /)).not.toBeInTheDocument();
  });

  it("hides for a sub-threshold-only payload (notable: false) — patch-only findings are toast-only", () => {
    // The extended payload carries the full verdict list; a tool below its
    // notify threshold must never light the chip (policy-driven chip, B.5).
    renderChip({
      daemonVersion: "0.5.3",
      updateAvailable: {
        tools: [
          { tool: "tu", current: "0.9.1", latest: "0.9.2", updateAvailable: true, notable: false },
        ],
        key: "",
        current: "",
        latest: "",
      },
    });
    expect(screen.queryByText(/⬆ /)).not.toBeInTheDocument();
  });

  it("shows only the notable subset of a mixed verdict payload", () => {
    // run-kit is notable, tu is sub-threshold: the chip renders the single
    // run-kit form (not the count form a 2-tool matched set would use).
    renderChip({
      daemonVersion: "0.5.3",
      updateAvailable: {
        tools: [
          { tool: "run-kit", current: "0.5.3", latest: "0.6.0", updateAvailable: true, notable: true },
          { tool: "tu", current: "0.9.1", latest: "0.9.2", updateAvailable: true, notable: false },
        ],
        key: "run-kit@0.6.0",
        current: "0.5.3",
        latest: "0.6.0",
      },
    });
    expect(screen.getByText("⬆ v0.6.0")).toBeInTheDocument();
    expect(screen.getByLabelText("Update HexoKit: v0.5.3 → v0.6.0")).toBeInTheDocument();
  });

  it("hides when the daemon reports the dev version", () => {
    renderChip({
      daemonVersion: "dev",
      updateAvailable: updateAvailable([{ tool: "run-kit", current: "dev", latest: "0.6.0" }]),
    });
    expect(screen.queryByText(/⬆ /)).not.toBeInTheDocument();
  });

  it("hides when dismissed for the current composite key", () => {
    renderChip({
      daemonVersion: "0.5.3",
      updateAvailable: updateAvailable([runKit("0.5.3", "0.6.0")]),
      updateDismissedKey: "run-kit@0.6.0",
    });
    expect(screen.queryByText(/⬆ /)).not.toBeInTheDocument();
  });

  it("re-shows for a changed composite key even after an older dismissal", () => {
    renderChip({
      daemonVersion: "0.5.3",
      updateAvailable: updateAvailable([runKit("0.5.3", "0.7.0")]),
      updateDismissedKey: "run-kit@0.6.0",
    });
    expect(screen.getByText("⬆ v0.7.0")).toBeInTheDocument();
  });

  it("re-shows when a newly-matching tool changes the key after a run-kit-only dismissal", () => {
    // Dismissed the run-kit-only key; now fab-kit also matches → key changes →
    // the chip re-shows (composite-key dismissal, R14).
    renderChip({
      daemonVersion: "3.8.0",
      updateAvailable: updateAvailable([
        runKit("3.8.0", "3.9.0"),
        { tool: "fab-kit", current: "2.16.0", latest: "2.17.0" },
      ]),
      updateDismissedKey: "run-kit@3.9.0",
    });
    expect(screen.getByText("⬆ updates (2)")).toBeInTheDocument();
  });

  it("leaves no empty flex item in the top bar when hidden (gap regression)", () => {
    // Self-hiding controls must carry their own responsive gating: an
    // always-rendered call-site wrapper stays in the gap-3 flex row as an
    // empty item while the child renders null, doubling the gap between
    // its neighbors.
    const { container } = renderChip({ daemonVersion: "0.5.3", updateAvailable: null });
    const emptyHidden = Array.from(container.querySelectorAll(".hidden")).filter(
      (el) => el.childNodes.length === 0,
    );
    expect(emptyHidden).toHaveLength(0);
  });

  it("no longer self-carries the `hidden sm:flex` cliff — gating is registry-driven (260715-h1ck R14/M2)", () => {
    // The `hidden sm:flex` breakpoint cliff was removed: below `sm` the chip's
    // registry entry OVERFLOWS into the chevron menu (its function merges into
    // the version row) rather than `display:none`-vanishing. A CSS-hidden chip
    // would render in NEITHER bar nor menu and its 0-width probe copy would
    // corrupt the fit input.
    renderChip({
      daemonVersion: "0.5.3",
      updateAvailable: updateAvailable([runKit("0.5.3", "0.6.0")]),
    });
    const root = screen.getByLabelText("Update HexoKit: v0.5.3 → v0.6.0").parentElement;
    expect(root).not.toHaveClass("hidden");
  });

  it("clicking the chip triggers updateNow and enters updating…", async () => {
    let resolveUpdate!: (v: { status: string }) => void;
    const updateNow = vi.fn(
      () =>
        new Promise<{ status: string }>((res) => {
          resolveUpdate = res;
        }),
    );
    renderChip({
      daemonVersion: "0.5.3",
      updateAvailable: updateAvailable([runKit("0.5.3", "0.6.0")]),
      updateNow,
    });
    fireEvent.click(screen.getByLabelText("Update HexoKit: v0.5.3 → v0.6.0"));
    expect(updateNow).toHaveBeenCalledTimes(1);
    // The chip flips to its disabled "Updating HexoKit" state (accessible label);
    // the ✕ dismiss button is hidden while updating.
    await waitFor(() => expect(screen.getByLabelText("Updating HexoKit")).toBeDisabled());
    // The VISIBLE busy label must be exactly "updating…" (real ellipsis, U+2026) —
    // guards against a JS escape sequence leaking into JSX text as literal chars.
    expect(screen.getByText("updating…")).toBeInTheDocument();
    expect(screen.queryByLabelText("Dismiss update notice")).not.toBeInTheDocument();
    resolveUpdate({ status: "updating" });
  });

  it("re-enables and toasts on update failure", async () => {
    const updateNow = vi.fn(() => Promise.reject(new Error("not brew-installed")));
    renderChip({
      daemonVersion: "0.5.3",
      updateAvailable: updateAvailable([runKit("0.5.3", "0.6.0")]),
      updateNow,
    });
    fireEvent.click(screen.getByLabelText("Update HexoKit: v0.5.3 → v0.6.0"));
    // After the rejection settles, the chip is back to its rest label.
    await waitFor(() =>
      expect(screen.getByLabelText("Update HexoKit: v0.5.3 → v0.6.0")).toBeInTheDocument(),
    );
    expect(screen.getByText("not brew-installed")).toBeInTheDocument();
  });

  it("clicking ✕ calls dismissUpdate", () => {
    const dismissUpdate = vi.fn();
    renderChip({
      daemonVersion: "0.5.3",
      updateAvailable: updateAvailable([runKit("0.5.3", "0.6.0")]),
      dismissUpdate,
    });
    fireEvent.click(screen.getByLabelText("Dismiss update notice"));
    expect(dismissUpdate).toHaveBeenCalledTimes(1);
  });

  it("hides on a cleared verdict — a consumed match becomes null (R13, no stale chip)", () => {
    // A siblings-only `shll update` never restarts the daemon; the post-
    // remediation re-check broadcasts a cleared verdict, which the context's
    // applyUpdateAvailable turns into null `updateAvailable`. The chip must then
    // disappear (not sit advertising the already-installed update).
    const { rerender } = renderChip({
      daemonVersion: "3.9.0",
      updateAvailable: updateAvailable([{ tool: "fab-kit", current: "2.16.0", latest: "2.17.0" }]),
    });
    expect(screen.getByText("⬆ updates (1)")).toBeInTheDocument();
    // Re-render with the cleared state the provider computes on an empty-key event.
    rerender(
      <ToastProvider>
        <ThemeProvider>
          <ChromeProvider>
            <SettingsDialogProvider>
            <StandaloneSessionContextProvider value={{ daemonVersion: "3.9.0", updateAvailable: null }}>
              <TopBar
                mode="server"
                sessions={[]}
                currentSession={null}
                currentWindow={null}
                sessionName=""
                windowName=""
                sidebarOpen={false}
                server="runkit"
                onNavigate={vi.fn()}
                onToggleSidebar={vi.fn()}
                onCreateWindow={vi.fn()}
              />
            </StandaloneSessionContextProvider>
            </SettingsDialogProvider>
          </ChromeProvider>
        </ThemeProvider>
      </ToastProvider>,
    );
    expect(screen.queryByText(/⬆ /)).not.toBeInTheDocument();
  });

  it("clears `updating…` when the composite key changes after the click (R13, siblings-only completion)", async () => {
    // The user clicks update; a siblings-only spawn produces no daemon restart /
    // reload, so `updating` can only clear when a later verdict's key differs
    // from the click-time key. Simulate that key change via a re-render.
    let resolveUpdate!: (v: { status: string }) => void;
    const updateNow = vi.fn(
      () => new Promise<{ status: string }>((res) => { resolveUpdate = res; }),
    );
    const before = updateAvailable([{ tool: "fab-kit", current: "2.16.0", latest: "2.17.0" }]);
    const { rerender } = renderChip({ daemonVersion: "3.9.0", updateAvailable: before, updateNow });

    fireEvent.click(screen.getByLabelText("Update: fab-kit v2.16.0 → v2.17.0"));
    resolveUpdate({ status: "updating" }); // the POST resolves 202; no reload follows (siblings-only)
    await waitFor(() => expect(screen.getByLabelText("Updating HexoKit")).toBeDisabled());

    // A later verdict with a DIFFERENT key (fab-kit now updated further) arrives.
    const after = updateAvailable([{ tool: "fab-kit", current: "2.17.0", latest: "2.18.0" }]);
    rerender(
      <ToastProvider>
        <ThemeProvider>
          <ChromeProvider>
            <SettingsDialogProvider>
            <StandaloneSessionContextProvider value={{ daemonVersion: "3.9.0", updateAvailable: after, updateNow }}>
              <TopBar
                mode="server"
                sessions={[]}
                currentSession={null}
                currentWindow={null}
                sessionName=""
                windowName=""
                sidebarOpen={false}
                server="runkit"
                onNavigate={vi.fn()}
                onToggleSidebar={vi.fn()}
                onCreateWindow={vi.fn()}
              />
            </StandaloneSessionContextProvider>
            </SettingsDialogProvider>
          </ChromeProvider>
        </ThemeProvider>
      </ToastProvider>,
    );
    // `updating` cleared → the chip is back to its normal (new-verdict) rest form.
    await waitFor(() =>
      expect(screen.getByLabelText("Update: fab-kit v2.17.0 → v2.18.0")).toBeInTheDocument(),
    );
    expect(screen.queryByText("updating…")).not.toBeInTheDocument();
  });
});

// Overflow-menu version row (260715-h1ck). jsdom reports zero element widths,
// so the fit math overflows EVERYTHING into the chevron menu — the version row
// therefore reflects the update-surface path whenever a qualifying update is
// pending (the update-chip entry is "overflowed").
describe("overflow menu version row (260715-h1ck)", () => {
  it("shows `HexoKit v{version}` and copies the displayed form on click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderChip({ daemonVersion: "0.6.2", updateAvailable: null });
    fireEvent.click(screen.getByLabelText("More controls"));
    const menu = screen.getByRole("menu", { name: "More controls" });
    const row = within(menu).getByText("HexoKit v0.6.2").closest("button")!;
    fireEvent.click(row);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("v0.6.2"));
  });

  it("becomes the update surface (`HexoKit v{current} → v{latest} ⬆`) for a single run-kit match when overflowed", () => {
    renderChip({
      daemonVersion: "0.5.3",
      updateAvailable: updateAvailable([runKit("0.5.3", "0.6.0")]),
    });
    // The chevron carries an attention badge (R7).
    expect(screen.getByTestId("overflow-attention")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("More controls"));
    const menu = screen.getByRole("menu", { name: "More controls" });
    expect(within(menu).getByText("HexoKit v0.5.3 → v0.6.0 ⬆")).toBeInTheDocument();
    // No separate UpdateChip menu row — its function merged into the version row.
    expect(within(menu).queryByText(/⬆ v/)).not.toBeInTheDocument();
  });

  it("becomes a count update surface for a multi-tool match when overflowed", () => {
    renderChip({
      daemonVersion: "3.8.0",
      updateAvailable: updateAvailable([
        runKit("3.8.0", "3.9.0"),
        { tool: "fab-kit", current: "2.16.0", latest: "2.17.0" },
      ]),
    });
    expect(screen.getByTestId("overflow-attention")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("More controls"));
    const menu = screen.getByRole("menu", { name: "More controls" });
    expect(within(menu).getByText("Toolkit updates (2) ⬆")).toBeInTheDocument();
  });

  it("triggers updateNow() from the version-row update surface", () => {
    const updateNow = vi.fn(() => Promise.resolve({ status: "updating" }));
    renderChip({
      daemonVersion: "0.5.3",
      updateAvailable: updateAvailable([runKit("0.5.3", "0.6.0")]),
      updateNow,
    });
    fireEvent.click(screen.getByLabelText("More controls"));
    const menu = screen.getByRole("menu", { name: "More controls" });
    fireEvent.click(within(menu).getByText("HexoKit v0.5.3 → v0.6.0 ⬆").closest("button")!);
    expect(updateNow).toHaveBeenCalledTimes(1);
  });

  it("stays a plain copy row (no attention badge) when no update is pending", () => {
    renderChip({ daemonVersion: "0.6.2", updateAvailable: null });
    expect(screen.queryByTestId("overflow-attention")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("More controls"));
    const menu = screen.getByRole("menu", { name: "More controls" });
    expect(within(menu).getByText("HexoKit v0.6.2")).toBeInTheDocument();
  });
});

describe("shouldReloadOnVersion (reload guard)", () => {
  it("never reloads on the first version seen", () => {
    expect(shouldReloadOnVersion(null, null, "0.5.3", "b1")).toBe(false);
  });

  it("does not reload when version and boot are unchanged", () => {
    expect(shouldReloadOnVersion("0.5.3", "b1", "0.5.3", "b1")).toBe(false);
  });

  it("reloads when a later version differs from the first-seen one", () => {
    expect(shouldReloadOnVersion("0.5.3", "b1", "0.6.0", "b1")).toBe(true);
  });
});

describe("UpdateChip — manual-check feed (260807-s6zs)", () => {
  const manualRunKit: UpdateTool = { tool: "run-kit", current: "3.8.7", latest: "3.9.1" };
  const manualTu: UpdateTool = { tool: "tu", current: "0.9.1", latest: "0.9.2" };

  it("lights the chip from a manual result when the ambient feed is dark", () => {
    renderChip({
      daemonVersion: "3.8.7",
      updateAvailable: null,
      manualCheck: { tools: [manualRunKit], source: "github" },
    });
    expect(screen.getByText("⬆ v3.9.1")).toBeInTheDocument();
    expect(screen.getByLabelText("Update HexoKit: v3.8.7 → v3.9.1")).toBeInTheDocument();
  });

  it("uses the count form + per-tool aria for a multi-tool manual result", () => {
    renderChip({
      daemonVersion: "3.8.7",
      updateAvailable: null,
      manualCheck: { tools: [manualRunKit, manualTu], source: "github" },
    });
    expect(screen.getByText("⬆ updates (2)")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Update: run-kit v3.8.7 → v3.9.1, tu v0.9.1 → v0.9.2"),
    ).toBeInTheDocument();
  });

  it("lets the AMBIENT feed win wholesale when both feeds hold tools", () => {
    renderChip({
      daemonVersion: "0.5.3",
      updateAvailable: updateAvailable([runKit("0.5.3", "0.6.0")]),
      manualCheck: { tools: [manualTu], source: "github" },
    });
    // The ambient run-kit verdict renders; the manual tu row is not surfaced.
    expect(screen.getByText("⬆ v0.6.0")).toBeInTheDocument();
    expect(screen.queryByText("⬆ updates (1)")).not.toBeInTheDocument();
  });

  it("surfaces the manual feed when the ambient key is dismissed", () => {
    renderChip({
      daemonVersion: "0.5.3",
      updateAvailable: updateAvailable([runKit("0.5.3", "0.6.0")]),
      updateDismissedKey: "run-kit@0.6.0",
      manualCheck: { tools: [manualTu], source: "github" },
    });
    expect(screen.getByText("⬆ updates (1)")).toBeInTheDocument();
    expect(screen.getByLabelText("Update: tu v0.9.1 → v0.9.2")).toBeInTheDocument();
  });

  it("hides a manual-fed chip on the dev daemon (same suppression as the ambient feed)", () => {
    renderChip({
      daemonVersion: "dev",
      updateAvailable: null,
      manualCheck: { tools: [manualRunKit], source: "github" },
    });
    expect(screen.queryByText(/⬆ /)).not.toBeInTheDocument();
  });

  it("hides a manual-fed chip dismissed for its CLIENT-COMPUTED composite key", () => {
    renderChip({
      daemonVersion: "3.8.7",
      updateAvailable: null,
      manualCheck: { tools: [manualRunKit], source: "github" },
      updateDismissedKey: "run-kit@3.9.1",
    });
    expect(screen.queryByText(/⬆ /)).not.toBeInTheDocument();
  });

  it("re-shows when a later manual check yields a DIFFERENT key", () => {
    renderChip({
      daemonVersion: "3.8.7",
      updateAvailable: null,
      manualCheck: { tools: [{ tool: "run-kit", current: "3.8.7", latest: "3.9.2" }], source: "github" },
      updateDismissedKey: "run-kit@3.9.1",
    });
    expect(screen.getByText("⬆ v3.9.2")).toBeInTheDocument();
  });

  it("clicking a manual-fed chip runs the FORCE update, not the scoped one", () => {
    const updateNow = vi.fn().mockResolvedValue(undefined);
    const forceUpdateNow = vi.fn().mockResolvedValue(undefined);
    renderChip({
      daemonVersion: "3.8.7",
      updateAvailable: null,
      manualCheck: { tools: [manualRunKit], source: "github" },
      updateNow,
      forceUpdateNow,
    });
    fireEvent.click(screen.getByLabelText("Update HexoKit: v3.8.7 → v3.9.1"));
    expect(forceUpdateNow).toHaveBeenCalledTimes(1);
    expect(updateNow).not.toHaveBeenCalled();
  });

  it("clicking an AMBIENT-fed chip keeps the scoped update path", () => {
    const updateNow = vi.fn().mockResolvedValue(undefined);
    const forceUpdateNow = vi.fn().mockResolvedValue(undefined);
    renderChip({
      daemonVersion: "0.5.3",
      updateAvailable: updateAvailable([runKit("0.5.3", "0.6.0")]),
      manualCheck: { tools: [manualTu], source: "github" },
      updateNow,
      forceUpdateNow,
    });
    fireEvent.click(screen.getByLabelText("Update HexoKit: v0.5.3 → v0.6.0"));
    expect(updateNow).toHaveBeenCalledTimes(1);
    expect(forceUpdateNow).not.toHaveBeenCalled();
  });

  it("clicking ✕ on a manual-fed chip calls dismissUpdate", () => {
    const dismissUpdate = vi.fn();
    renderChip({
      daemonVersion: "3.8.7",
      updateAvailable: null,
      manualCheck: { tools: [manualRunKit], source: "github" },
      dismissUpdate,
    });
    fireEvent.click(screen.getByLabelText("Dismiss update notice"));
    expect(dismissUpdate).toHaveBeenCalledTimes(1);
  });

  it("surfaces a manual-fed update on the overflow-menu version row too (no per-surface wiring)", () => {
    renderChip({
      daemonVersion: "3.8.7",
      updateAvailable: null,
      manualCheck: { tools: [manualRunKit], source: "github" },
      updateDismissedKey: "run-kit@3.9.1", // chip dismissed → menu keeps the surface
    });
    fireEvent.click(screen.getByLabelText("More controls"));
    const menu = screen.getByRole("menu", { name: "More controls" });
    expect(within(menu).getByText("HexoKit v3.8.7 → v3.9.1 ⬆")).toBeInTheDocument();
  });
});
