import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { STAGE_PADDING_PX } from "../../src/lib/stage-geometry";
import { READY_TIMEOUT, openPalette, resolveWindow as resolveWindowRaw } from "./_ready";
import {
  TMUX_SERVER,
  createSession,
  killSession,
  newWindow,
  setWindowOption,
  stampWebTab,
  windowOption,
} from "./_tmux";
import { reserveDeadPort, type DeadPort } from "./_ports";
import { stubProxyPorts } from "./_web-tile";

// Surface popout e2e (spec docs/specs/surface-layout.md § Verbs → Pop out /
// Pop back in): a tile pops out into its own browser window — the terminal
// route with `?pop=<leaf-id>` renders that one surface chrome-less — while
// the opener hides the popped tile for THIS viewer only (localStorage
// `rk-layout-popped:{server}:{@N}` + the rk-popout BroadcastChannel) and
// reflows over the rest; the shared `@rk_win_layout` is never written by
// pop-out/pop-in (every layout assertion reads the tmux option, ground
// truth). Covered: pop via the header verb (popup caught with
// `context.waitForEvent("page")`), the chrome-less render + `<Surface> ·
// <window>` title, close-to-restore, palette `Tile: Pop Back In`, the tty
// popout's isolated session surviving the opener's sibling-tab switch, a
// foreign (`@N/tty`) leaf's popout titled by its HOME window, the ended
// "Window closed" state when the surface's window dies, single-tile pop out
// (arity-1 header/palette offers, the opener's all-popped placeholder), the
// top-bar toggle's per-viewer reveal/hide of a popped leaf's placeholder
// with no layout write (bring back closes the popout), and the popout
// page's sidebar-free stage (the tile's left edge sits at the stage padding
// with the sidebar preference open).
//
// Shared setup: `beforeAll` creates one dedicated session `e2e-popout-<ts>`
// (80×24) so this file never collides with other specs (`fullyParallel` off),
// then warms the dev server with a throwaway terminal-route page load
// (Vite's cold transform of the app + xterm graph would otherwise eat the
// first test's budget); `afterAll` kills the session (best-effort).
// `beforeEach` sets a wide desktop viewport (1440×800 — multi-tile is
// desktop-only) and stubs the derived dead port's `/proxy/<port>/**` with a
// static 200 page (stubProxyPorts from _web-tile.ts, port from
// reserveDeadPort in _ports.ts — the popped tile's web sibling probes its
// stamped URL, and these tests assert tile chrome, never frame content).
// `makeWindow(name)` creates a window via tmux and resolves its stable `@N`
// id from the backend snapshot. Windows are created FRESH PER TEST — layouts
// mutate as the scenarios run. The popout page carries NO status bar
// (chrome-less), so its readiness gate is the tile testid, never the
// `Connected` dot.

// Own session so this file never collides with other specs (fullyParallel off).
const TEST_SESSION = `e2e-popout-${Date.now()}`;
const DESKTOP_VIEWPORT = { width: 1440, height: 800 };

// A URL the proxy converts to a same-origin `/proxy/<port>/…` path (dead by
// construction). Resolved once in the file-level beforeAll below.
let DEAD: DeadPort;

test.beforeAll(async () => {
  DEAD = await reserveDeadPort();
});

/** Resolve a window's stable tmux id (`@N`) from the backend snapshot by name. */
async function resolveWindow(page: Page, windowName: string): Promise<string> {
  return (await resolveWindowRaw(page, TMUX_SERVER, TEST_SESSION, windowName)).windowId;
}

/** Create a named window in the test session and return its `@N` id. */
async function makeWindow(page: Page, name: string): Promise<string> {
  newWindow(TEST_SESSION, name);
  return resolveWindow(page, name);
}

/** A window's display name from the backend snapshot (the popout title and
 *  the foreign tile's home chip render it). */
async function windowNameOf(page: Page, windowId: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const res = await page.request.get(
      `/api/sessions?server=${encodeURIComponent(TMUX_SERVER)}`,
    );
    if (res.ok()) {
      const sessions = (await res.json()) as Array<{
        windows: Array<{ windowId: string; name: string }>;
      }>;
      for (const s of sessions) {
        const found = s.windows.find((w) => w.windowId === windowId);
        if (found) return found.name;
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`window ${windowId} not found in snapshot`);
}

/** Navigate to a window's terminal route and wait for the SSE connection. */
async function gotoWindow(page: Page, windowId: string): Promise<void> {
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`);
  await expect(page.locator("[aria-label='Connected']")).toBeVisible({
    timeout: READY_TIMEOUT,
  });
}

/** Assert the shared layout a window carries — its `@rk_win_layout` tmux
 *  option (retrying: a verb's POST and the option tick land asynchronously). */
async function expectWindowLayout(windowId: string, expected: string): Promise<void> {
  await expect
    .poll(() => windowOption(windowId, "@rk_win_layout"), { timeout: 10_000 })
    .toBe(expected);
}

/** The window's pane text (tmux ground truth for "typed here, landed there"). */
function paneText(windowId: string): string {
  return execFileSync("tmux", ["-L", TMUX_SERVER, "capture-pane", "-p", "-t", windowId]).toString();
}

/** Click a tile header's Pop out verb and return the popup page. */
async function popOutTile(
  page: Page,
  context: BrowserContext,
  tileTestId: string,
  label: string,
): Promise<Page> {
  const tileEl = page.getByTestId(tileTestId);
  await expect(tileEl).toBeVisible({ timeout: 10_000 });
  const [popup] = await Promise.all([
    context.waitForEvent("page", { timeout: 15_000 }),
    tileEl.getByLabel(`Pop out ${label}`).click(),
  ]);
  await popup.waitForLoadState("domcontentloaded");
  return popup;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await stubProxyPorts(page, DEAD.port);
});

test.beforeAll(async ({ browser }) => {
  createSession(TEST_SESSION);
  // Cold-boot warm-up (the surface-layout precedent): a throwaway
  // terminal-route load in beforeAll (outside the per-test budget) absorbs
  // Vite's cold transform of the app + xterm graph.
  const page = await browser.newPage();
  const first = await resolveWindowRaw(page, TMUX_SERVER, TEST_SESSION);
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(first.windowId)}`);
  await expect(page.locator("[aria-label='Connected']")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 60_000 });
  await page.close();
});

test.afterAll(() => {
  killSession(TEST_SESSION);
});

test.describe("Surface popout", () => {
  /**
   * Proves: popping the tty tile of an `h(tty,web)` layout opens a popout
   * window rendering that one surface chrome-less (no top bar, sidebar, or
   * status bar; the header carries Pop back in and no Expand/Close), titled
   * `<Surface> · <window name>` — while the opener hides the tty tile for
   * itself only and reflows, with the shared `@rk_win_layout` never written.
   *
   * Steps:
   * 1. Create window A (layout `h(tty,web)` + a stamped web tab); navigate
   *    to A; both tiles render.
   * 2. Click the tty tile's `Pop out Terminal`; catch the popup page.
   * 3. Assert the popout: `surface-tile-tty` visible, no banner landmark /
   *    sidebar nav / status bar, the header shows `Pop Terminal back in` and
   *    no Expand/Close, and the title is `Terminal · <A name>`.
   * 4. Assert the opener: the tty tile is hidden (still mounted), the web
   *    tile fills the layout, and A's `@rk_win_layout` still reads
   *    `h(tty,web)`.
   */
  test("popping a tile opens a chrome-less popout titled `<Surface> · <window>`; the opener reflows for this viewer only", async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    const aName = `pop-a-${Date.now()}`;
    const a = await makeWindow(page, aName);
    stampWebTab(a, DEAD.url);
    setWindowOption(a, "@rk_win_layout", "h(tty,web)");
    await gotoWindow(page, a);
    await expect(page.getByTestId("surface-tile-tty")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("surface-tile-web")).toBeVisible({ timeout: 10_000 });

    const popup = await popOutTile(page, context, "surface-tile-tty", "Terminal");

    // The popout: one chrome-less tile (the status bar's Connected dot, the
    // banner top bar, and the sidebar nav are all gone), the surface header
    // kept with the Pop back in verb in place of the layout cluster.
    await expect(popup.getByTestId("surface-tile-tty")).toBeVisible({ timeout: 15_000 });
    await expect(popup.locator("[role='banner']")).toHaveCount(0);
    await expect(popup.locator("nav[aria-label='Sessions']")).toHaveCount(0);
    await expect(popup.getByTestId("status-bar")).toHaveCount(0);
    const tile = popup.getByTestId("surface-tile-tty");
    await expect(tile.getByLabel("Pop Terminal back in")).toBeVisible();
    await expect(tile.getByLabel("Expand Terminal")).toHaveCount(0);
    await expect(tile.getByLabel("Close Terminal")).toHaveCount(0);
    await expect(popup).toHaveTitle(`Terminal · ${aName}`);

    // The opener: the popped tile hides (still mounted — the stream
    // survives), the web tile reflows to fill, and the SHARED layout option
    // is never written by the pop.
    // The hidden class is display:none — visibility, not a class substring
    // (`overflow-hidden` would false-match a /hidden/ regex).
    await expect(page.getByTestId("surface-tile-tty")).toBeHidden();
    await expect(page.getByTestId("surface-tile-web")).toBeVisible();
    await expectWindowLayout(a, "h(tty,web)");

    await popup.close();
  });

  /**
   * Proves: closing the popout window restores the tile in the opener — the
   * popout's `pagehide` sign-off (or the stale-mark sweep as backstop) clears
   * the viewer's mark and the tile reflows back, again with no
   * `@rk_win_layout` write.
   *
   * Steps:
   * 1. Create A (layout `h(tty,web)`); navigate; pop the tty tile out.
   * 2. Assert the opener's tty tile hidden and the popup open.
   * 3. Close the popup; assert the opener's tty tile reflows back visible
   *    (polling past the 6s stale window covers a missing pagehide) and the
   *    option still reads `h(tty,web)`.
   */
  test("closing the popout window returns the tile to the opener", async ({ page, context }) => {
    test.setTimeout(90_000);
    const a = await makeWindow(page, `pop-close-${Date.now()}`);
    stampWebTab(a, DEAD.url);
    setWindowOption(a, "@rk_win_layout", "h(tty,web)");
    await gotoWindow(page, a);
    await expect(page.getByTestId("surface-tile-tty")).toBeVisible({ timeout: 10_000 });

    const popup = await popOutTile(page, context, "surface-tile-tty", "Terminal");
    await expect(popup.getByTestId("surface-tile-tty")).toBeVisible({ timeout: 15_000 });
    // The hidden class is display:none — visibility, not a class substring
    // (`overflow-hidden` would false-match a /hidden/ regex).
    await expect(page.getByTestId("surface-tile-tty")).toBeHidden();

    await popup.close();
    await expect(page.getByTestId("surface-tile-tty")).toBeVisible({ timeout: 15_000 });
    await expectWindowLayout(a, "h(tty,web)");
  });

  /**
   * Proves: the palette's `Tile: Pop Back In <Surface>` (Constitution V
   * parity for the popout's window close) closes the popout window and
   * restores the tile in the opener.
   *
   * Steps:
   * 1. Create A (layout `h(tty,web)`); navigate; pop the tty tile out;
   *    assert the opener hides it.
   * 2. Open the command palette in the OPENER and select
   *    `Tile: Pop Back In Terminal`.
   * 3. Assert the popup closes (the pop-in message closes the popout) and
   *    the opener's tty tile reflows back visible.
   */
  test("palette `Tile: Pop Back In` closes the popout and restores the tile", async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    const a = await makeWindow(page, `pop-palette-${Date.now()}`);
    stampWebTab(a, DEAD.url);
    setWindowOption(a, "@rk_win_layout", "h(tty,web)");
    await gotoWindow(page, a);
    await expect(page.getByTestId("surface-tile-tty")).toBeVisible({ timeout: 10_000 });

    const popup = await popOutTile(page, context, "surface-tile-tty", "Terminal");
    await expect(popup.getByTestId("surface-tile-tty")).toBeVisible({ timeout: 15_000 });
    // The hidden class is display:none — visibility, not a class substring
    // (`overflow-hidden` would false-match a /hidden/ regex).
    await expect(page.getByTestId("surface-tile-tty")).toBeHidden();

    const closed = popup.waitForEvent("close", { timeout: 15_000 });
    await openPalette(page);
    await page.getByRole("option", { name: "Tile: Pop Back In Terminal" }).click();
    await closed;
    await expect(page.getByTestId("surface-tile-tty")).toBeVisible();
  });

  /**
   * Proves: a popped-out terminal attaches an ISOLATED session
   * (`_rk-iso-<N>`), so the popout keeps showing its window while the
   * opener's session switches windows — typing in the popout still lands in
   * the popped window's pane after the opener moves to a sibling tab; and
   * when the surface's window dies the popout renders the ended state and
   * does not navigate.
   *
   * Steps:
   * 1. Create sibling windows A and B (A: layout `h(tty,web)`); navigate to
   *    A; pop the tty tile out.
   * 2. Poll tmux until A's `_rk-iso-<N>` session has an attached client (the
   *    popout's relay stream opened isolated).
   * 3. Navigate the OPENER to B; type an `echo <marker>` line into the
   *    popout's terminal; poll `capture-pane` on A until the marker appears
   *    (the popout kept A while the opener's session switched to B).
   * 4. Kill A; assert the popout renders `Window closed` and its URL is
   *    unchanged (no navigation).
   */
  test("a tty popout keeps its window while the opener switches to a sibling tab; a dead window ends the popout", async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    const aName = `pop-iso-a-${Date.now()}`;
    const a = await makeWindow(page, aName);
    stampWebTab(a, DEAD.url);
    setWindowOption(a, "@rk_win_layout", "h(tty,web)");
    const b = await makeWindow(page, `pop-iso-b-${Date.now()}`);
    await gotoWindow(page, a);
    await expect(page.getByTestId("surface-tile-tty")).toBeVisible({ timeout: 10_000 });

    const popup = await popOutTile(page, context, "surface-tile-tty", "Terminal");
    await expect(popup.getByTestId("surface-tile-tty")).toBeVisible({ timeout: 15_000 });
    await expect(popup.locator(".xterm").first()).toBeVisible({ timeout: 15_000 });

    // The popout's stream attaches A's `_rk-iso-<N>` session (a real tmux
    // client on it proves the isolated attach is live — the same oracle the
    // cross-tab borrow test uses).
    const isoName = `_rk-iso-${a.slice(1)}`;
    await expect
      .poll(
        () =>
          execFileSync("tmux", [
            "-L",
            TMUX_SERVER,
            "list-sessions",
            "-F",
            "#{session_name}\t#{session_attached}",
          ])
            .toString()
            .split("\n")
            .some((line) => {
              const [name, attached] = line.split("\t");
              return name === isoName && Number(attached) >= 1;
            }),
        { timeout: 30_000 },
      )
      .toBe(true);

    // The opener switches to the sibling tab; the popout's terminal still
    // drives A's pane (the isolation's whole point — a shared attach would
    // have been yanked to B).
    await gotoWindow(page, b);
    const marker = `POP_${Date.now().toString(36)}`;
    await popup.locator(".xterm").first().click();
    await popup.keyboard.type(`echo ${marker}`);
    await popup.keyboard.press("Enter");
    await expect.poll(() => paneText(a), { timeout: 10_000 }).toContain(marker);

    // The surface's window dies: the popout renders the ended state and
    // never navigates.
    const popupUrl = popup.url();
    execFileSync("tmux", ["-L", TMUX_SERVER, "kill-window", "-t", a]);
    await expect(popup.getByTestId("popout-ended")).toBeVisible({ timeout: 15_000 });
    await expect(popup.getByText("Window closed")).toBeVisible();
    expect(popup.url()).toBe(popupUrl);
    await popup.close();
  });

  /**
   * Proves: a foreign (`@N/tty`) leaf pops out like a bare one — the popout
   * renders only the foreign tile, titles itself with the leaf's HOME window
   * (`Terminal · <home name>`),
   * keeps the fixed opener route in its URL, and streams the home window's
   * pane.
   *
   * Steps:
   * 1. Create A and B; stamp B's layout `h(tty,@A/tty)` (A's terminal
   *    borrowed into B); navigate to B.
   * 2. Click the foreign tile's `Pop out Terminal`; catch the popup.
   * 3. Assert the popup renders the foreign tile (`surface-tile-tty-<A>`)
   *    and no bare tty tile, its title is `Terminal · <A name>`, its URL is
   *    B's route with `pop=%40A%2Ftty`, and the tile streams A's pane (a
   *    typed marker lands in A, read back via `capture-pane`).
   * 4. Assert B's shared layout still reads `h(tty,@A/tty)`.
   */
  test("a foreign (@N/tty) leaf pops out titled with its home window and streams the home pane", async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    const aName = `pop-fa-${Date.now()}`;
    const a = await makeWindow(page, aName);
    const b = await makeWindow(page, `pop-fb-${Date.now()}`);
    setWindowOption(b, "@rk_win_layout", `h(tty,${a}/tty)`);
    await gotoWindow(page, b);
    const foreign = page.getByTestId(`surface-tile-tty-${a}`);
    await expect(foreign).toBeVisible({ timeout: 10_000 });

    const popup = await popOutTile(page, context, `surface-tile-tty-${a}`, "Terminal");
    await expect(popup.getByTestId(`surface-tile-tty-${a}`)).toBeVisible({ timeout: 15_000 });
    await expect(popup.locator(".xterm").first()).toBeVisible({ timeout: 15_000 });
    // The popout's one-leaf tree mounts no bare tty tile (not even hidden).
    await expect(popup.getByTestId("surface-tile-tty")).toHaveCount(0);
    expect(await windowNameOf(page, a)).toBe(aName);
    await expect(popup).toHaveTitle(`Terminal · ${aName}`);
    // The popout is keyed to the OPENER's route window with the encoded
    // foreign leaf id — it never navigates to the home window's route.
    expect(popup.url()).toContain(`/${TMUX_SERVER}/${b.slice(1)}?pop=`);
    expect(decodeURIComponent(popup.url())).toContain(`pop=${a}/tty`);

    const marker = `POPF_${Date.now().toString(36)}`;
    await popup.locator(".xterm").first().click();
    await popup.keyboard.type(`echo ${marker}`);
    await popup.keyboard.press("Enter");
    await expect.poll(() => paneText(a), { timeout: 10_000 }).toContain(marker);

    await expectWindowLayout(b, `h(tty,${a}/tty)`);
    await popup.close();
  });

  /**
   * Proves: `?pop=` is LIVE state the route-entry translation effect never
   * strips — a deep link carrying a retired `?view=` param alongside `?pop=`
   * folds the view into `@rk_win_layout` and rewrites the URL to the bare
   * route PLUS `pop`, so the popout still renders chrome-less.
   *
   * Steps:
   * 1. Create A; navigate to `/{server}/{N}?view=web&pop=tty` directly (no
   *    window.open — the popout posture is URL-driven).
   * 2. Assert the URL keeps `pop=tty` while `view` drops out (the
   *    translation replaced the route), and A's option was translated to
   *    `web`.
   * 3. Assert the popout posture engaged anyway: the tty tile renders with
   *    Pop back in and no banner/status bar exists.
   */
  test("the route-entry translation keeps `?pop=` while folding retired params", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const a = await makeWindow(page, `pop-xlate-${Date.now()}`);
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(a)}?view=web&pop=tty`);
    await expect(page.getByTestId("surface-tile-tty")).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/[?]pop=tty$/);
    await expectWindowLayout(a, "web");
    await expect(page.locator("[role='banner']")).toHaveCount(0);
    await expect(page.getByTestId("status-bar")).toHaveCount(0);
    await expect(
      page.getByTestId("surface-tile-tty").getByLabel("Pop Terminal back in"),
    ).toBeVisible();
  });

  /**
   * Proves: Pop out is offered at arity 1 — a single-tile window's header
   * shows `Pop out Terminal` alone (no Expand/Close cluster) and the palette
   * lists `Tile: Pop Out Terminal`; popping the only tile opens the popout
   * window while the opener renders the all-popped placeholder
   * (`popped-out-placeholder`), the tile staying mounted hidden behind it.
   *
   * Steps:
   * 1. Create window A (no layout stamp — the default single tty tile);
   *    navigate; the tile renders.
   * 2. Assert the header's `Pop out Terminal` is present with no
   *    Expand/Close, open the palette, assert `Tile: Pop Out Terminal` is
   *    listed, close the palette.
   * 3. Click `Pop out Terminal`; catch the popup page.
   * 4. Assert the popup renders `surface-tile-tty` titled
   *    `Terminal · <A name>`, and the opener shows
   *    `popped-out-placeholder` ("Terminal is popped out") with the tty tile
   *    hidden behind it.
   */
  test("popping a single-tile window's only tile opens the popout; the opener renders the all-popped placeholder", async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    const aName = `pop-solo-${Date.now()}`;
    const a = await makeWindow(page, aName);
    await gotoWindow(page, a);
    const tile = page.getByTestId("surface-tile-tty");
    await expect(tile).toBeVisible({ timeout: 10_000 });

    // The arity-1 offers: the header shows Pop out alone (no zoom/close
    // cluster), and the palette lists the row.
    await expect(tile.getByLabel("Pop out Terminal")).toBeVisible();
    await expect(tile.getByLabel("Expand Terminal")).toHaveCount(0);
    await expect(tile.getByLabel("Close Terminal")).toHaveCount(0);
    await openPalette(page);
    await expect(
      page.getByRole("option", { name: "Tile: Pop Out Terminal" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    const popup = await popOutTile(page, context, "surface-tile-tty", "Terminal");

    // The popout renders the one tile chrome-less; the opener's layout is
    // fully popped, so the all-popped placeholder stands in (the tile stays
    // mounted hidden behind it — its stream survives).
    await expect(popup.getByTestId("surface-tile-tty")).toBeVisible({ timeout: 15_000 });
    await expect(popup).toHaveTitle(`Terminal · ${aName}`);
    const allPopped = page.getByTestId("popped-out-placeholder");
    await expect(allPopped).toBeVisible();
    await expect(allPopped).toContainText("Terminal is popped out");
    await expect(page.getByTestId("surface-tile-tty")).toBeHidden();

    await popup.close();
  });

  /**
   * Proves: the top-bar Terminal toggle on a popped tty NEVER writes the
   * shared layout — it reveals the popped placeholder ("Terminal is popped
   * out" + bring back / go to window / ✕) in the tile's slot, a second click
   * hides it again, and the placeholder's bring back closes the popout
   * window and returns the live tile; `@rk_win_layout` reads `h(tty,web)`
   * throughout.
   *
   * Steps:
   * 1. Create A (layout `h(tty,web)`); navigate; pop the tty tile out; the
   *    opener hides it and the Terminal toggle carries the popped marker.
   * 2. Click the banner's `Terminal tile` toggle — the popped placeholder
   *    appears in the tty slot; read `@rk_win_layout` straight from tmux:
   *    still `h(tty,web)` (a direct read, not a poll — proves no write).
   * 3. Click the toggle again — the placeholder hides; the option still
   *    reads `h(tty,web)`.
   * 4. Reveal once more, then click the placeholder's `bring back` — the
   *    popout window closes and the opener's tty tile reflows back visible.
   */
  test("the Terminal toggle on a popped tile reveals/hides its popped placeholder with no layout write; bring back closes the popout", async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    const a = await makeWindow(page, `pop-toggle-${Date.now()}`);
    stampWebTab(a, DEAD.url);
    setWindowOption(a, "@rk_win_layout", "h(tty,web)");
    await gotoWindow(page, a);
    await expect(page.getByTestId("surface-tile-tty")).toBeVisible({ timeout: 10_000 });

    const popup = await popOutTile(page, context, "surface-tile-tty", "Terminal");
    await expect(popup.getByTestId("surface-tile-tty")).toBeVisible({ timeout: 15_000 });
    // The hidden class is display:none — visibility, not a class substring
    // (`overflow-hidden` would false-match a /hidden/ regex).
    await expect(page.getByTestId("surface-tile-tty")).toBeHidden();

    const toggle = page
      .getByRole("banner")
      .getByRole("button", { name: "Terminal tile", exact: true });
    // While hidden the toggle carries the popped marker (scoped inside the
    // button: the top bar's off-screen measurement probe re-renders the
    // toggle group with the same testids, so a page-wide getByTestId would
    // match both copies).
    await expect(toggle.getByTestId("surface-popped-tty")).toBeVisible();

    // Reveal: the popped placeholder stands in the tty slot — and the toggle
    // wrote NOTHING to the shared layout.
    await toggle.click();
    const placeholder = page.getByTestId("surface-placeholder");
    await expect(placeholder).toBeVisible();
    await expect(placeholder).toContainText("Terminal is popped out");
    await expect(placeholder.getByRole("button", { name: "bring back" })).toBeVisible();
    await expect(placeholder.getByRole("button", { name: "go to window" })).toBeVisible();
    await expect(placeholder.getByLabel("Close Terminal")).toBeVisible();
    await expect(page.getByTestId("surface-tile-web")).toBeVisible();
    expect(windowOption(a, "@rk_win_layout")).toBe("h(tty,web)");

    // Hide: the placeholder leaves, still with no layout write.
    await toggle.click();
    await expect(placeholder).toHaveCount(0);
    expect(windowOption(a, "@rk_win_layout")).toBe("h(tty,web)");

    // Reveal again, then bring back: the popout window closes and the live
    // terminal reflows back into its slot.
    await toggle.click();
    await expect(placeholder).toBeVisible();
    const closed = popup.waitForEvent("close", { timeout: 15_000 });
    await placeholder.getByRole("button", { name: "bring back" }).click();
    await closed;
    await expect(page.getByTestId("surface-tile-tty")).toBeVisible();
    await expectWindowLayout(a, "h(tty,web)");
  });

  /**
   * Proves: the popout page reserves NO sidebar column even with the sidebar
   * preference open — no sidebar aside mounts and the tile's left edge sits
   * at the stage padding (6px from the viewport left), not at sidebar width
   * + padding.
   *
   * Steps:
   * 1. Create A; register an init script pinning the shared
   *    `hexokit-sidebar-open` preference to "true" (the popout reads it at
   *    load), then navigate DIRECTLY to A's popout route (`?pop=tty` — the
   *    posture is URL-driven, no window.open needed).
   * 2. Assert the popout posture engaged: the chrome-less tty tile renders
   *    with its `Pop Terminal back in` verb.
   * 3. Assert no `Sidebar` aside mounts, and the tile's bounding-box left
   *    edge is ≈ the stage padding (retrying — the first sessions payload
   *    can briefly re-render a freshly opened popout) — a sidebar column
   *    would push it past the 220px default width + gap.
   */
  test("the popout's tile starts at the stage padding — no sidebar column, even with the sidebar preference open", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const a = await makeWindow(page, `pop-stage-${Date.now()}`);
    await page.addInitScript(() => localStorage.setItem("hexokit-sidebar-open", "true"));
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(a)}?pop=tty`);
    const popTile = page.getByTestId("surface-tile-tty");
    await expect(popTile).toBeVisible({ timeout: 15_000 });
    await expect(popTile.getByLabel("Pop Terminal back in")).toBeVisible();

    await expect(page.locator('aside[aria-label="Sidebar"]')).toHaveCount(0);
    await expect(async () => {
      const tileBox = await popTile.boundingBox();
      if (!tileBox) throw new Error("the popout's tty tile has no bounding box");
      expect(Math.abs(tileBox.x - STAGE_PADDING_PX)).toBeLessThanOrEqual(2);
    }).toPass({ timeout: 10_000 });
  });
});
