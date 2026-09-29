/**
 * Web tile lens e2e (ui-state.md § Layout in tmux): the tile arrangement is
 * SHARED tab state — the `@rk_win_layout` window option — so a lens flip IS
 * an option write (the palette's `View: …` actions write the tree form — a
 * bare `<view>` leaf — through the shared POST seam), and every layout
 * assertion here reads the
 * option via `windowOption`, never the URL. The web lens is always tileable
 * (availability does not derive from the web tab family): an empty web tab
 * family selects the tile's onboarding content state (reduced live URL bar +
 * the three fill-path instructions) in place of the iframe, and an external
 * `@rk_win_web_1` write flips onboarding ↔ live with no user action. The
 * retired `?view=` param is inbound-only — a deep link translates to the
 * tree form `web` in the option once, then the URL is replaced with the bare
 * route.
 *
 * Shared setup: `beforeEach` route-stubs the derived dead port's
 * `/proxy/<port>/**` with a static 200 page (`stubProxyPorts` from
 * `_web-tile.ts`, port from `reserveDeadPort` in `_ports.ts`) — the dead-port
 * error state hides the iframe when nothing listens on the stamped dead URL,
 * and these tests assert tile chrome, never
 * frame content. `beforeAll` creates a dedicated session `e2e-webview-<ts>`
 * (80×24) so this file never collides with other specs; `afterAll` kills it.
 * `beforeEach` also sets a wide desktop viewport (1440×800); the mobile test
 * overrides to 375px. `makeWindow(name, {url?, layout?, cwd?})` creates a
 * window via `tmux new-window` and stamps the slot-1 web tab (`stampWebTab`)
 * and/or `@rk_win_layout` directly with tmux; `cwd: "/tmp"` creates a window
 * outside any git repo (its code folder falls back to the raw cwd, so it is
 * code-capable like any other window). The stamped options surface as
 * `webTabs`/`webActive`/`layout` in the SSE snapshot, so no live HTTP server
 * behind the iframe is needed.
 * `gotoWindow(id, view?)` navigates to `/<server>/<@N>[?view=…]` and waits
 * for the status bar's `Connected` dot. `expectWindowLayout` is a retrying
 * read of the window's `@rk_win_layout` option (a verb's POST and the option
 * tick land asynchronously); `expectBareUrl` asserts the route carries no
 * search params. Palette helpers: `openPaletteWith(query)` opens the palette
 * via the shared `openPalette` and fills the search input; `switchLens(label)`
 * runs the palette's
 * `View: {label}` option and waits for the palette to close.
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { openPalette, READY_TIMEOUT, resolveWindow as resolveWindowRaw } from "./_ready";
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

// Own session so this file never collides with other specs (fullyParallel off).
const TEST_SESSION = `e2e-webview-${Date.now()}`;
const MOBILE_VIEWPORT = { width: 375, height: 812 };
// The ViewSwitcher is RETIRED (260812-0c6o): on desktop the palette's
// `View: …` actions are the ONLY lens-switch surface (plus the top-bar
// open-tile toggles for non-hidden surfaces); on MOBILE the `View:` entries
// are superseded by the top-bar switch group and its `Tile: Switch to
// <Surface>` palette twin — the chevron menu carries no `View:` rows and the
// `view-toggle` testid exists nowhere. Lens switching in this suite therefore
// routes through the palette (or `?view=` deep links where the lens itself is
// under test). The generous 1440px desktop width remains a valid
// "everything fits" width.
const DESKTOP_VIEWPORT = { width: 1440, height: 800 };

// A URL the proxy converts to a same-origin `/proxy/<port>/…` path. The port
// is a reserved-then-released ephemeral (dead by construction — no fixed-port
// occupancy can flip the tile's posture); we assert on chrome/heading/render,
// never on iframe content. Resolved once in the file-level beforeAll below.
let DEAD: DeadPort;
let IFRAME_URL: string;

test.beforeAll(async () => {
  DEAD = await reserveDeadPort();
  IFRAME_URL = DEAD.url;
});

/** Resolve a window's stable tmux id (`@N`) from the backend snapshot by name. */
async function resolveWindow(page: Page, windowName: string): Promise<string> {
  return (await resolveWindowRaw(page, TMUX_SERVER, TEST_SESSION, windowName)).windowId;
}

/** Create a window and (optionally) stamp its slot-1 web tab (`stampWebTab`)
 *  and/or its shared `@rk_win_layout` via tmux (argument arrays — no shell
 *  strings). `cwd: "/tmp"` creates a window outside any git repo — its code
 *  folder falls back to the raw cwd, so it is code-capable; nothing in this
 *  file keys on the code surface either way. Returns the @N id. */
async function makeWindow(
  page: Page,
  name: string,
  opts: { url?: string; layout?: string; cwd?: string } = {},
): Promise<string> {
  newWindow(TEST_SESSION, name, { cwd: opts.cwd });
  const id = await resolveWindow(page, name);
  if (opts.url !== undefined) {
    stampWebTab(id, opts.url);
  }
  if (opts.layout !== undefined) {
    execFileSync("tmux", ["-L", TMUX_SERVER, "set-option", "-w", "-t", id, "@rk_win_layout", opts.layout], {
      stdio: "ignore",
    });
  }
  return id;
}

/** Navigate to a window's terminal route (optionally with a view param) and wait
 *  for the SSE connection. */
async function gotoWindow(
  page: Page,
  windowId: string,
  // Only `web` is a supported deep-link value; `tty` is the ABSENCE of the
  // param (the router drops any non-`web` value), so it is never passed here.
  view?: "web",
): Promise<void> {
  const q = view ? `?view=${view}` : "";
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}${q}`);
  await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({
    timeout: READY_TIMEOUT,
  });
}

const iframe = (page: Page) => page.getByTitle("Proxied content");
const terminal = (page: Page) => page.locator(".xterm").first();

/** Assert the shared layout a window carries — its `@rk_win_layout` tmux
 *  option (retrying: a verb's POST and the option tick land asynchronously). */
async function expectWindowLayout(windowId: string, expected: string): Promise<void> {
  await expect
    .poll(() => windowOption(windowId, "@rk_win_layout"), { timeout: 10_000 })
    .toBe(expected);
}

/** Assert the route is bare — layout state lives in tmux, never the URL. */
function expectBareUrl(page: Page): void {
  expect(new URL(page.url()).search).toBe("");
}

// The retired switcher leaves no surface in the top bar — lens switching is
// palette-only (260812-0c6o). `inBarSwitcher`/`view-toggle` must always be
// empty; the chevron menu never carries `View:` lens rows.
const controlsMenu = (page: Page) =>
  page.getByRole("menu", { name: "More controls" });
const inBarSwitcher = (page: Page) =>
  page.getByRole("group", { name: "Window view" });

/** Open the command palette, fill the query, and return the input. */
async function openPaletteWith(page: Page, query: string) {
  const paletteInput = await openPalette(page);
  await paletteInput.fill(query);
  return paletteInput;
}

/** Switch the lens via the palette's `View: {label}` action. */
async function switchLens(page: Page, label: "Terminal" | "Web"): Promise<void> {
  await openPaletteWith(page, `View: ${label}`);
  const option = page.getByRole("option", { name: `View: ${label}` });
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
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

test.describe("Web view lens — iframe as a per-viewer lens", () => {
  // Default every test in this describe to a wide desktop width — the
  // distinguishing menu-only case (260722-n2n4): the bar has room, yet the
  // switcher lives only in the chevron menu. The mobile test overrides this to
  // 375px at its own start.
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
  });

  /**
   * Proves: web availability is unconditional (the palette's `View: Web`
   * action renders even on a window with NO stamped web tab; it opens the
   * onboarding tile) — and the retired-switcher contract: there is no in-bar
   * pill, no `view-toggle` testid anywhere in the DOM (bar or probe), and no
   * `View:` rows in the chevron menu. The plain window uses a non-repo cwd
   * (`/tmp`) — code is available there via the cwd fallback, but nothing in
   * this test asserts on the code surface; the assertions are web-only.
   *
   * Steps:
   * 1. Create a plain window (no stamped web tab, `/tmp` cwd); navigate to it;
   *    assert the terminal.
   * 2. Open the palette with `View: Web`; assert the `View: Web` option IS
   *    visible (web is always offered); Escape.
   * 3. Create a window WITH a stamped web tab; navigate to it.
   * 4. Assert no in-bar "Window view" group and no `view-toggle` testid; open
   *    the palette and assert the `View: Web` option is visible; Escape.
   * 5. Open the "More controls" menu; assert it carries NO `View:` rows;
   *    Escape.
   */
  test("lens switching is palette-only — web is always offered, the menu carries no `View:` rows (260812-0c6o, 260821-zqlq)", async ({ page }) => {
    test.setTimeout(30_000);
    // A plain window (no stamped web tab) offers web unconditionally: the
    // palette's `View: Web` action renders even before the window has a URL
    // (it opens the onboarding tile — the discovery path the gating used to
    // block).
    const plain = await makeWindow(page, `wv-plain-${Date.now()}`, { cwd: "/tmp" });
    await gotoWindow(page, plain);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    await openPaletteWith(page, "View: Web");
    await expect(page.getByRole("option", { name: "View: Web" })).toBeVisible();
    await page.keyboard.press("Escape");

    // A window with a stamped web tab offers tty + web → the palette's `View: Web` action
    // renders — and there is STILL no in-bar pill and no `view-toggle` testid
    // anywhere; the chevron menu carries no `View:` lens rows (the retired
    // switcher's removal).
    const web = await makeWindow(page, `wv-cap-${Date.now()}`, { url: IFRAME_URL });
    await gotoWindow(page, web);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    await expect(inBarSwitcher(page)).toHaveCount(0);
    await expect(page.getByTestId("view-toggle")).toHaveCount(0);
    await openPaletteWith(page, "View: Web");
    await expect(page.getByRole("option", { name: "View: Web" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "More controls" }).click();
    await expect(controlsMenu(page)).toBeVisible();
    await expect(
      controlsMenu(page).getByRole("menuitemradio", { name: /^View:/ }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  /**
   * Proves: a lens flip is a SHARED layout write — `View: Web` POSTs the
   * tree form `web` to `@rk_win_layout` and `View: Terminal` POSTs `tty`
   * (the choice is tab state, never the retired `@rk_win_lens`),
   * the URL stays bare throughout, and the flip does not destroy the window.
   *
   * Steps:
   * 1. Create a window with a stamped web tab; register a
   *    `page.on("request")` recorder for any `POST /api/windows/…/options`.
   * 2. Navigate (the fallback layout is the bare `tty` leaf — the option is
   *    unset); assert the terminal.
   * 3. `switchLens("Web")` — run the palette's `View: Web` action; assert
   *    the iframe renders and the option reads `web`.
   * 4. `switchLens("Terminal")`; assert the terminal renders and the option
   *    reads `tty`; assert the URL stayed bare.
   * 5. Re-resolve the window by name; assert the id is unchanged AND the
   *    recorded /options bodies wrote ONLY `@rk_win_layout` (never the
   *    retired `@rk_win_lens`).
   */
  test("flipping web↔tty preserves the window and writes only @rk_win_layout (never @rk_win_lens)", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    const name = `wv-flip-${Date.now()}`;
    const id = await makeWindow(page, name, { url: IFRAME_URL });

    // Record window-option mutations: a lens flip writes the SHARED layout
    // option — and must never touch the retired `@rk_win_lens`.
    const optionBodies: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && /\/api\/windows\/.*\/options/.test(req.url())) {
        optionBodies.push(req.postData() ?? "");
      }
    });

    // The option is unset → the bare `tty` leaf fallback renders.
    await gotoWindow(page, id);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });

    // Flip to web via the palette's `View: Web` action → iframe renders; the
    // selection POSTs the tree form `web` to the shared option.
    await switchLens(page, "Web");
    await expect(iframe(page)).toBeVisible({ timeout: 10_000 });
    await expectWindowLayout(id, "web");

    // Flip back to tty via `View: Terminal` → terminal renders; the option
    // carries the explicit `tty`.
    await switchLens(page, "Terminal");
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    await expectWindowLayout(id, "tty");
    expectBareUrl(page);

    // The window still exists in the snapshot (never destroyed) and its id is
    // unchanged; every recorded /options body wrote only `@rk_win_layout`.
    const stillId = await resolveWindow(page, name);
    expect(stillId).toBe(id);
    expect(optionBodies.length).toBeGreaterThan(0);
    for (const body of optionBodies) {
      expect(body).toContain("@rk_win_layout");
      expect(body).not.toContain("@rk_win_lens");
    }
  });

  /**
   * Proves: web is always tileable — the deep link keeps its tile instead of
   * degrading to tty, and with no stamped web tab the tile renders the
   * ONBOARDING content state in place of the iframe (the
   * availability-vs-content split; availability never adds a surface to the
   * layout — the deep link alone writes the tree form `web`).
   *
   * Steps:
   * 1. Create a plain window (no stamped web tab, `/tmp` cwd).
   * 2. Navigate to `…?view=web`.
   * 3. Assert the `web-tile-onboarding` panel renders, there is no iframe,
   *    the tty tile is hidden-but-mounted (hide-never-unmount), and the
   *    option reads `web` (the deep link keeps its tile).
   * 4. Open the palette with `View: Terminal`; assert the option is visible
   *    (web is current, so the palette offers the way back); Escape.
   */
  test("?view=web on a window with no web tab resolves to the onboarding web tile (260821-zqlq)", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    // Web is always tileable, so the deep link keeps its tile instead of
    // degrading to tty; with no stamped web tab the tile renders the
    // ONBOARDING content state in place of the iframe.
    const id = await makeWindow(page, `wv-nourl-${Date.now()}`, { cwd: "/tmp" });
    await gotoWindow(page, id, "web");
    await expect(page.getByTestId("web-tile-onboarding")).toBeVisible({ timeout: 10_000 });
    await expect(iframe(page)).toHaveCount(0);
    // The tty tile stays mounted (hidden) under the `web` layout — the
    // hide-never-unmount rule keeps the terminal's scrollback alive.
    await expect(terminal(page)).toBeHidden();
    await expectWindowLayout(id, "web");
    // The palette still offers the way back (web is current).
    await openPaletteWith(page, "View: Terminal");
    await expect(page.getByRole("option", { name: "View: Terminal" })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  /**
   * Proves: the web-toggle chord is availability-driven, so it mounts on every
   * desktop window route — on a URL-less window ⇧Ctrl+3 (the non-mac default;
   * mac is ⌘3) opens the web tile beside the terminal, and the tile renders
   * onboarding with the REDUCED URL bar (refresh + the fully-live address
   * input; back/forward, find ⌕, and ↗ hidden until content exists).
   *
   * Steps:
   * 1. Create a plain window (no stamped web tab, `/tmp` cwd); navigate; assert
   *    the terminal.
   * 2. Press `Shift+Control+Digit3`.
   * 3. Assert `web-tile-onboarding` renders with the "Nothing to show yet"
   *    heading and the `rk present ./report.html` instruction row; no iframe.
   * 4. Assert the address input is visible with the
   *    `localhost:3000 · /present/… · https://…` placeholder, Refresh
   *    renders, and Back/Forward/Find in page/Open in browser render nowhere.
   * 5. Assert the option reads `h(tty,web)` (the chord added the tile
   *    — 1→2 growth).
   */
  test("⌘3 on a URL-less window opens the web tile's onboarding state (260821-zqlq)", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    // The web-toggle chord is availability-driven, so it now mounts on every
    // desktop window route — on a URL-less window it opens the web tile, and
    // the tile renders onboarding with the REDUCED URL bar (refresh + the
    // live address input only: no back/forward, no find ⌕, no ↗).
    const id = await makeWindow(page, `wv-onboard-${Date.now()}`, { cwd: "/tmp" });
    await gotoWindow(page, id);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    // ⇧Ctrl+3 (the non-mac web-toggle default; mac is ⌘3).
    await page.keyboard.press("Shift+Control+Digit3");
    const onboarding = page.getByTestId("web-tile-onboarding");
    await expect(onboarding).toBeVisible({ timeout: 10_000 });
    await expect(onboarding).toContainText("Nothing to show yet");
    await expect(onboarding).toContainText("rk present ./report.html");
    await expect(iframe(page)).toHaveCount(0);
    // Tile-scoped: the top bar carries its own "Refresh page" button.
    const webTile = page.getByTestId("surface-tile-web");
    const address = webTile.getByLabel("URL");
    await expect(address).toBeVisible();
    await expect(address).toHaveAttribute(
      "placeholder",
      "localhost:3000 · /present/… · https://…",
    );
    await expect(webTile.getByLabel("Refresh")).toBeVisible();
    await expect(webTile.getByLabel("Back")).toHaveCount(0);
    await expect(webTile.getByLabel("Forward")).toHaveCount(0);
    await expect(webTile.getByLabel("Find in page")).toHaveCount(0);
    await expect(webTile.getByLabel("Open in browser")).toHaveCount(0);
    // The chord ADDED the web tile beside the terminal (1→2 h-split).
    await expectWindowLayout(id, "h(tty,web)");
  });

  /**
   * Proves: the onboarding address input is fully live — Enter runs the
   * existing submit pipeline (`normalizeAddressInput` → `isAllowedUrl` →
   * `POST /options` on `@rk_win_web_1`, the active slot), SSE delivers the
   * new value, and the tile flips onboarding → live iframe with no further
   * action.
   *
   * Steps:
   * 1. Create a plain window (no stamped web tab, `/tmp` cwd); navigate to
   *    `…?view=web`; assert `web-tile-onboarding`.
   * 2. Fill the `URL` input with `localhost:<derived dead port>`; press Enter.
   * 3. Assert the iframe renders (the stubbed `/proxy/<port>/` page), the
   *    onboarding panel is gone, the option holds `/proxy/<port>/` in slot 1,
   *    and the layout option still reads `web`.
   */
  test("the onboarding address bar boots the tile for real (Enter → @rk_win_web_1 POST)", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    const id = await makeWindow(page, `wv-boot-${Date.now()}`, { cwd: "/tmp" });
    await gotoWindow(page, id, "web");
    const onboarding = page.getByTestId("web-tile-onboarding");
    await expect(onboarding).toBeVisible({ timeout: 10_000 });
    // Typing a bare loopback address and pressing Enter runs the existing
    // pipeline: normalize → /proxy/<port>/ → POST /options (@rk_win_web_1) —
    // SSE delivers the new value and the tile flips live with no further
    // action.
    const address = page.getByTestId("surface-tile-web").getByLabel("URL");
    await address.fill(`localhost:${DEAD.port}`);
    await address.press("Enter");
    await expect(iframe(page)).toBeVisible({ timeout: 10_000 });
    await expect(onboarding).toHaveCount(0);
    expect(windowOption(id, "@rk_win_web_1")).toBe(`/proxy/${DEAD.port}/`);
    await expectWindowLayout(id, "web");
  });

  /**
   * Proves: the live flip rides the web-tab sync seam — an agent-side
   * `rk present` (here: an external `tmux set-option -w @rk_win_web_1`)
   * transitions the open tile onboarding → iframe in place, and clearing the
   * option returns it to onboarding.
   *
   * Steps:
   * 1. Create a plain window (no stamped web tab, `/tmp` cwd); navigate to
   *    `…?view=web`; assert `web-tile-onboarding`.
   * 2. `tmux set-option -w -t <id> @rk_win_web_1 <the derived dead URL>`;
   *    assert the iframe renders and onboarding is gone.
   * 3. `tmux set-option -w -u -t <id> @rk_win_web_1`; assert onboarding
   *    returns and the iframe is gone.
   */
  test("tmux set-option @rk_win_web_1 flips the open onboarding tile live; unsetting returns to onboarding", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    // The live flip rides the web-tab sync seam — an agent-side `rk present`
    // (or any external set-option) transitions the tile onboarding → iframe
    // in place, and clearing the option returns it.
    const id = await makeWindow(page, `wv-setopt-${Date.now()}`, { cwd: "/tmp" });
    await gotoWindow(page, id, "web");
    const onboarding = page.getByTestId("web-tile-onboarding");
    await expect(onboarding).toBeVisible({ timeout: 10_000 });
    execFileSync("tmux", ["-L", TMUX_SERVER, "set-option", "-w", "-t", id, "@rk_win_web_1", IFRAME_URL], {
      stdio: "ignore",
    });
    await expect(iframe(page)).toBeVisible({ timeout: 10_000 });
    await expect(onboarding).toHaveCount(0);
    execFileSync("tmux", ["-L", TMUX_SERVER, "set-option", "-w", "-u", "-t", id, "@rk_win_web_1"], { stdio: "ignore" });
    await expect(onboarding).toBeVisible({ timeout: 10_000 });
    await expect(iframe(page)).toHaveCount(0);
  });

  /**
   * Proves: per-window SHARED persistence — a lens flip lands in A's
   * `@rk_win_layout`, switching windows targets the bare route (no params
   * anywhere), and B renders its own (unset) fallback while A re-renders its
   * option's `web` tree on return. The A→B switch is a REAL client-side
   * navigation (sidebar row click), not a `page.goto`.
   *
   * Steps:
   * 1. Create window A (with a stamped web tab) and window B (plain).
   * 2. On A, `switchLens("Web")` (the palette's `View: Web` action); assert
   *    the iframe and A's option reading `web`.
   * 3. Switch to B by clicking B's row button in the `Sessions` sidebar
   *    (`[data-window-id=<idB>]` → first `button`); assert selection settles
   *    on B (`aria-current="page"`), the terminal renders, B's option stays
   *    UNSET, and the URL is bare.
   * 4. Navigate back to A on the bare route; assert the iframe renders and
   *    the URL stays bare — A's shared layout resolved from tmux.
   */
  test("the shared layout persists across a window switch away and back", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    const a = await makeWindow(page, `wv-persist-a-${Date.now()}`, { url: IFRAME_URL });
    const b = await makeWindow(page, `wv-persist-b-${Date.now()}`);

    // On A, switch to web via the palette — a view selection is a
    // single-tile layout mutation written to the shared option.
    await gotoWindow(page, a);
    await switchLens(page, "Web");
    await expect(iframe(page)).toBeVisible({ timeout: 10_000 });
    await expectWindowLayout(a, "web");

    // Switch to B via a REAL client-side navigation (sidebar row click), not a
    // page.goto — B renders its own (unset) layout: the bare `tty` fallback.
    const sidebar = page.locator("nav[aria-label='Sessions']");
    const rowB = sidebar
      .locator(`[data-window-id="${b}"]`)
      .getByRole("button")
      .first();
    await expect(rowB).toBeVisible({ timeout: 10_000 });
    await rowB.click();

    // Selection settles on B — the client-side switch was accepted.
    await expect(rowB).toHaveAttribute("aria-current", "page", { timeout: 10_000 });
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    expect(windowOption(b, "@rk_win_layout")).toBe("");
    expectBareUrl(page);

    // Back to A on the bare route — A's shared layout (`web`) renders
    // from the option.
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(a)}`);
    await expect(iframe(page)).toBeVisible({ timeout: 10_000 });
    expectBareUrl(page);
  });

  /**
   * Proves: at 375px with a realistically long window name the center heading
   * keeps its room WITH the pinned switch group present (the retained
   * single-line / no-horizontal-overflow contract), the mobile palette
   * supersedes the `View:` lens entries with `Tile: Switch to <Surface>`, the
   * top-bar Web button performs the one-tap tty→web switch by GROWING the
   * shared layout (`h(tty,web)` lands in the option) and setting the
   * per-viewer zoom key, and no switcher
   * chrome (`view-toggle` testid, "Window view" group) exists anywhere. The
   * lens itself still resolves and renders on mobile.
   *
   * Steps:
   * 1. Set the 375×812 viewport; create a window with a stamped web tab and
   *    a long worktree-style name.
   * 2. Navigate to `…?view=web` and gate on the IFRAME, not the `Connected`
   *    dot — the dot lives in the desktop status bar (the sidebar footer is
   *    mobile-only), and at 375px the status bar never renders, so it never
   *    becomes visible. Assert the iframe renders.
   * 3. Assert no in-bar switcher group ("Window view") AND no `view-toggle`
   *    testid anywhere in the DOM.
   * 4. Assert the banner's `Web tile` button reads `aria-pressed=true` and
   *    `Terminal tile` reads `false` (radio semantics — the visible tile
   *    pressed).
   * 5. Open the palette with `View: Web`; assert NO `View: Web` option
   *    (mobile supersession). Refill with `Switch`; click `Tile: Switch to
   *    Terminal`; assert the terminal renders, the zoom key holds `tty`,
   *    and the option reads `h(web,tty)` — switching to a NOT-OPEN
   *    surface grows the shared layout through the add mutation (a phone
   *    posture must not collapse it).
   * 6. Click the banner's `Web tile` button; assert the iframe renders and
   *    the option still reads `h(web,tty)` (web is open in the grown
   *    layout — a zoom-key-only switch back).
   * 7. Assert no horizontal page overflow (`body.scrollWidth <= 375`).
   * 8. Resize to the desktop viewport (1440×800); assert the ≥ lg compact
   *    heading renders beside the standing quake launcher (the `Tab:` prefix span
   *    hidden at this rung), there is STILL no in-bar pill and no
   *    `view-toggle` testid; open the palette with `View:
   *    Terminal`, assert the option renders; refill with `Switch` and assert
   *    NO `Tile: Switch to …` options (desktop keeps `View:`).
   */
  test("375px mobile: the switch group + `Tile: Switch` palette entries are the lens switchers; no switcher chrome at any width", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    // At 375px with a realistically long window name the heading keeps its
    // room WITH the switch group present (the retained single-line /
    // no-overflow contract), `View:` palette entries are superseded by
    // `Tile: Switch to <Surface>` on mobile only, and the pill never renders
    // anywhere. The lens itself still resolves + renders on mobile without
    // horizontal overflow.
    await page.setViewportSize(MOBILE_VIEWPORT);
    const id = await makeWindow(page, `wv-mobile-long-worktree-name-${Date.now()}`, {
      url: IFRAME_URL,
    });
    // Do NOT gate on the `Connected` dot here: it lives in the sidebar footer
    // (260724-6j1v), and at 375px the sidebar is an unmounted drawer, so the
    // dot never becomes visible (same reason window-heading.spec.ts's mobile
    // test gates on the heading, not the dot).
    // Gate directly on the iframe — the thing under test.
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}?view=web`);
    await expect(iframe(page)).toBeVisible({ timeout: 10_000 });

    // No in-bar pill, no probe copy — the testid exists nowhere.
    await expect(inBarSwitcher(page)).toHaveCount(0);
    await expect(page.getByTestId("view-toggle")).toHaveCount(0);

    // The top-bar switch group renders with the VISIBLE surface (web)
    // pressed; its palette twin lists `Tile: Switch to Terminal` and the
    // mobile palette carries NO `View:` LENS entries (superseded — other
    // `View:` entries like Fixed Width remain).
    const banner = page.getByRole("banner");
    const ttyToggle = banner.getByRole("button", { name: "Terminal tile", exact: true });
    const webToggle = banner.getByRole("button", { name: "Web tile", exact: true });
    await expect(webToggle).toHaveAttribute("aria-pressed", "true", {
      timeout: READY_TIMEOUT,
    });
    await expect(ttyToggle).toHaveAttribute("aria-pressed", "false");
    const paletteInput = await openPaletteWith(page, "View: Web");
    await expect(page.getByRole("option", { name: "View: Web", exact: true })).toHaveCount(0);
    await paletteInput.fill("Switch");
    const switchToTty = page.getByRole("option", { name: "Tile: Switch to Terminal" });
    await expect(switchToTty).toBeVisible({ timeout: 10_000 });
    // Switch to tty via the palette twin — tty is NOT open in the `web`
    // layout, so the switch grows the SHARED layout (`addSurface`) and sets
    // this viewer's zoom key.
    await switchToTty.click();
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    await expectWindowLayout(id, "h(web,tty)");
    expect(
      await page.evaluate(
        (key) => localStorage.getItem(key),
        `rk-layout-zoom:${TMUX_SERVER}:${id}`,
      ),
    ).toBe("tty");

    // The one-tap phone flow back: the top-bar Web button switches to the
    // OPEN web surface — a zoom-key-only write; the shared option is
    // untouched.
    await webToggle.click();
    await expect(iframe(page)).toBeVisible({ timeout: 10_000 });
    expect(windowOption(id, "@rk_win_layout")).toBe("h(web,tty)");
    expect(
      await page.evaluate(
        (key) => localStorage.getItem(key),
        `rk-layout-zoom:${TMUX_SERVER}:${id}`,
      ),
    ).toBe("web");

    // No horizontal page overflow at 375px (with the group present and the
    // long window name).
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);

    // Still no switcher chrome at desktop width either — at ≥ lg the center
    // is the compact heading (the `Tab:` prefix span hides) beside the
    // standing quake launcher — and the desktop palette keeps its `View:` entries
    // with NO `Tile: Switch` ones.
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await expect(page.getByTestId("quake-launcher-input")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Tab:", { exact: true })).toBeHidden();
    await expect(inBarSwitcher(page)).toHaveCount(0);
    await expect(page.getByTestId("view-toggle")).toHaveCount(0);
    const desktopPaletteInput = await openPaletteWith(page, "View: Terminal");
    await expect(
      page.getByRole("option", { name: "View: Terminal" }),
    ).toBeVisible({ timeout: 10_000 });
    await desktopPaletteInput.fill("Switch");
    await expect(
      page.getByRole("option", { name: /^Tile: Switch to / }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
  });
});
