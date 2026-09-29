import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { READY_TIMEOUT, resolveWindow as resolveWindowRaw } from "./_ready";
import {
  TMUX_SERVER,
  createSession,
  killSession,
  newWindow,
  stampWebTab,
  windowOption,
} from "./_tmux";
import { reserveDeadPort, type DeadPort } from "./_ports";
import { stubProxyPorts } from "./_web-tile";

// External layout writes (ui-state.md § Layout in tmux — the layout write IS
// the expand): a viewer MOUNTED on a window's terminal route repaints from an
// EXTERNAL `tmux set-option -w @rk_win_layout …` on the next option tick, with
// no client-side state machine — this is the mechanism an agent uses to show
// the web tile on a tab. The per-viewer toggle POSTs the bare `tty` leaf back
// through the same option.
//
// Shared setup: beforeEach route-stubs the derived dead port's
// /proxy/<port>/** (stubProxyPorts, _web-tile.ts; port from reserveDeadPort,
// _ports.ts) with a static 200 page — the dead-port error state hides the
// iframe when nothing listens on the stamped URL, and these tests assert tile
// chrome, never frame content. Runs against the isolated rk-test-e2e socket
// (E2E_TMUX_SERVER). beforeAll creates one dedicated session
// `e2e-present-<ts>` (80×24) so this file never collides with other specs
// (fullyParallel off); afterAll kills it best-effort. The describe's
// beforeEach sets a wide desktop viewport (1440×800) — the `Connected`
// readiness dot is read from the status bar (getByTestId("status-bar")); the
// sidebar footer's own dot is mobile-only. setLayoutOption(id, value) stamps
// @rk_win_layout via tmux set-option -w (execFileSync argument arrays — no
// shell strings); the write is invisible to the control-mode parser, so every
// post-write assertion budgets OPTION_TICK_TIMEOUT (30s) to clear the 12s SSE
// safety ticker on a quiet server. makeWindow(name) creates a window with
// cwd: "/tmp" (a plain non-repo cwd — the code surface is still available via
// the cwd fallback, but nothing here asserts on it; the layout starts at a
// deterministic bare `tty` leaf regardless) and returns the @N id. awaitSnapshotReady(page, id) waits for the
// tty tile's role="application" aria-label to carry the SSE-derived session
// name — proof the route's window record resolved, so an option write issued
// after it is always an OBSERVED transition, never a cold first read (the
// sidebar row renders from an earlier, shallower payload and is NOT
// sufficient). Locators: the `Proxied content` iframe, the `.xterm` terminal
// surface, and the top-bar SurfaceToggleGroup's `Web tile` toggle — its
// aria-pressed tracks the open tile. Every flow peaks at 2 tiles (tty + web).
const TEST_SESSION = `e2e-present-${Date.now()}`;
const DESKTOP_VIEWPORT = { width: 1440, height: 800 };

// A proxy-rewritten URL on a reserved-then-released ephemeral port (dead by
// construction — assertions are on render, never on iframe content). Resolved
// once in the file-level beforeAll below.
let DEAD: DeadPort;
let URL_A: string;

test.beforeAll(async () => {
  DEAD = await reserveDeadPort();
  URL_A = DEAD.url;
});

// A `tmux set-option -w` write is invisible to the control-mode parser, so on
// a quiet server the guaranteed pickup is the 12s safety ticker — the repaint
// assertions budget well past it.
const OPTION_TICK_TIMEOUT = 30_000;

/** Resolve a window's stable tmux id (`@N`) from the backend snapshot by name. */
async function resolveWindow(page: Page, windowName: string): Promise<string> {
  return (await resolveWindowRaw(page, TMUX_SERVER, TEST_SESSION, windowName)).windowId;
}

/** Write the shared layout — a HAND-WRITTEN external write in the legacy
 *  preset grammar (parse permanence is the point of these inputs; `rk
 *  present`'s --show arm itself now writes the tree form). The `rk present` ≡
 *  `rk tab web add --show` equivalence is pinned on a real
 *  socket by TestPresentEquivalentToWebAddShow (app/backend/cmd/rk). */
function setLayoutOption(windowId: string, value: string): void {
  execFileSync("tmux", ["-L", TMUX_SERVER, "set-option", "-w", "-t", windowId, "@rk_win_layout", value], {
    stdio: "ignore",
  });
}

/** Create a window and return its @N id. `cwd: "/tmp"` is a plain non-repo
 *  cwd (the code surface resolves to the raw cwd via the fallback — irrelevant
 *  here); the layout starts at a deterministic bare `tty` leaf. */
async function makeWindow(page: Page, name: string): Promise<string> {
  newWindow(TEST_SESSION, name, { cwd: "/tmp" });
  return resolveWindow(page, name);
}

/** Navigate to a window's terminal route and wait for the SSE connection.
 *  Desktop gate: the status bar's dot — the sidebar footer's own dot is
 *  mobile-only since 260815-19me (the right-panel.spec.ts pattern). */
async function gotoWindow(page: Page, windowId: string): Promise<void> {
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`);
  await expect(
    page.getByTestId("status-bar").locator("[aria-label='Connected']"),
  ).toBeVisible({
    timeout: READY_TIMEOUT,
  });
}

const iframe = (page: Page) => page.getByTitle("Proxied content");
const terminal = (page: Page) => page.locator(".xterm").first();
// The top-bar SurfaceToggleGroup's web open-tile toggle — its `aria-pressed`
// tracks the open tile.
const webTileToggle = (page: Page) => page.getByRole("button", { name: "Web tile" });

/** Wait until the CLIENT has applied a snapshot that resolves this window on
 *  the TERMINAL ROUTE: the tty tile's `role="application"` aria-label embeds
 *  the SSE-derived session name, so its full form proves the window record
 *  resolved — an external option write issued after this gate is always an
 *  OBSERVED transition, never a cold first read. (The sidebar row is NOT
 *  sufficient — it renders from an earlier, shallower payload.) */
async function awaitSnapshotReady(page: Page, windowId: string): Promise<void> {
  await expect(
    page.getByRole("application", { name: `Terminal: ${TEST_SESSION}/${windowId}` }),
  ).toBeVisible({ timeout: OPTION_TICK_TIMEOUT });
}

// The dead-port error state (260819-v6y4 R8) hides the iframe when nothing
// listens on the stamped port — these tests assert tile chrome, never frame
// content, so the proxy path is route-stubbed live (see _web-tile.ts).
test.beforeEach(async ({ page }) => {
  await stubProxyPorts(page, DEAD.port);
});

test.beforeAll(() => {
  createSession(TEST_SESSION);
});

test.afterAll(() => {
  killSession(TEST_SESSION);
});

test.describe("External @rk_win_layout writes repaint the mounted viewer", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
  });

  /**
   * Proves: the external-write repaint — a `set-option -w @rk_win_layout`
   * issued while a viewer is mounted opens the web tile beside the terminal
   * on the next option tick (no client-side state machine, no client write),
   * and closing the tile via the top-bar toggle POSTs the bare `tty` leaf
   * back through the same option.
   *
   * Steps:
   * 1. Create a window with a stamped slot-1 web tab; navigate to its route;
   *    assert the terminal renders, the option is UNSET, and the URL is bare;
   *    wait for the snapshot-readiness gate.
   * 2. `tmux set-option -w @rk_win_layout split-h:tty,web` (the external
   *    write — a LEGACY preset string, which parses permanently).
   * 3. Assert the web iframe becomes visible beside the still-visible
   *    terminal and the top-bar `Web tile` toggle reads pressed; assert the
   *    URL stays bare.
   * 4. Click the top-bar `Web tile` toggle; assert the iframe hides and the
   *    option reads `tty` (the bare leaf).
   */
  test("an external set-option -w @rk_win_layout repaints the mounted viewer; the top-bar toggle writes the bare tty leaf back", async ({
    page,
  }) => {
    // The set-option write rides the 12s safety ticker worst-case; the suite's
    // 10s per-test cap can't absorb that (the surface-layout.spec.ts
    // setTimeout precedent).
    test.setTimeout(90_000);
    const id = await makeWindow(page, `pa-open-${Date.now()}`);
    stampWebTab(id, URL_A);
    await gotoWindow(page, id);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    // Cold entry resolved the bare `tty` leaf (the fallback — the option is
    // unset), and the URL never carries layout state.
    expect(windowOption(id, "@rk_win_layout")).toBe("");
    expect(new URL(page.url()).search).toBe("");
    // The client's first snapshot has landed, so the write below is always an
    // OBSERVED transition.
    await awaitSnapshotReady(page, id);

    // The external write — an agent's expand, no client involvement. The
    // LEGACY preset string parses permanently (parse permanence IS the point
    // of this input) and renders its tree.
    setLayoutOption(id, "split-h:tty,web");
    await expect(iframe(page)).toBeVisible({ timeout: OPTION_TICK_TIMEOUT });
    await expect(terminal(page)).toBeVisible();
    await expect(webTileToggle(page)).toHaveAttribute("aria-pressed", "true");
    expect(new URL(page.url()).search).toBe("");

    // The per-viewer close goes back through the same option.
    await webTileToggle(page).click();
    await expect(iframe(page)).toBeHidden({ timeout: 10_000 });
    await expect
      .poll(() => windowOption(id, "@rk_win_layout"), { timeout: 10_000 })
      .toBe("tty");
  });

  /**
   * Proves: the repaint tracks a SECOND external write too — an agent
   * collapsing the layout back to `single:tty` (a legacy preset string —
   * parse permanence) hides the tile on the next
   * tick, with the viewer never having written the option itself.
   *
   * Steps:
   * 1. Create a window with a stamped slot-1 web tab; navigate; wait for the
   *    snapshot-readiness gate.
   * 2. External write `split-h:tty,web` (legacy preset — still parses);
   *    assert the web iframe appears.
   * 3. External write `single:tty` (legacy); assert the iframe hides and the
   *    terminal stays visible.
   */
  test("a second external write (single:tty) collapses the tile back on the next tick", async ({
    page,
  }) => {
    // Two ticker-bounded transitions.
    test.setTimeout(120_000);
    const id = await makeWindow(page, `pa-collapse-${Date.now()}`);
    stampWebTab(id, URL_A);
    await gotoWindow(page, id);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    await awaitSnapshotReady(page, id);

    setLayoutOption(id, "split-h:tty,web");
    await expect(iframe(page)).toBeVisible({ timeout: OPTION_TICK_TIMEOUT });

    setLayoutOption(id, "single:tty");
    await expect(iframe(page)).toBeHidden({ timeout: OPTION_TICK_TIMEOUT });
    await expect(terminal(page)).toBeVisible();
  });

  /**
   * Proves: an invalid hand-written option value degrades to the bare `tty`
   * fallback at render — the option itself is NEVER rewritten by the client
   * (the author sees their mistake with `show-options`).
   *
   * Steps:
   * 1. Create a window with a stamped slot-1 web tab; navigate; wait for the
   *    snapshot-readiness gate.
   * 2. External write `@rk_win_layout garbage:ty,ty,ty`.
   * 3. Assert the terminal stays visible, no web tile mounts, and the option
   *    still reads the invalid value (a settle beat first, so a would-be
   *    rewrite could land).
   */
  test("an invalid @rk_win_layout value renders the bare tty fallback and is never rewritten", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const id = await makeWindow(page, `pa-invalid-${Date.now()}`);
    stampWebTab(id, URL_A);
    await gotoWindow(page, id);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    await awaitSnapshotReady(page, id);

    setLayoutOption(id, "garbage:ty,ty,ty");
    // Give the tick a beat to land — then assert the fallback render AND that
    // the option kept its (invalid) value: degradation never rewrites.
    await page.waitForTimeout(1_000);
    await expect(terminal(page)).toBeVisible();
    await expect(iframe(page)).toHaveCount(0);
    expect(windowOption(id, "@rk_win_layout")).toBe("garbage:ty,ty,ty");
  });
});
