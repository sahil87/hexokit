import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { READY_TIMEOUT, resolveWindow as resolveWindowRaw } from "./_ready";
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

// The surface-toggle e2e — formerly the right RAIL spec, retargeted to the
// surface-layout model when the rail (right-panel.tsx + the `right-panel-rail`
// testid) was deleted: its availability-gated open-tile toggles relocated
// into the top bar's right cluster as ONE bordered sub-group
// (SurfaceToggleGroup in top-bar.tsx, `data-testid="surface-toggles"`),
// terminal route only, on desktop leftmost in the cluster and the FIRST
// overflow fit candidate. On MOBILE the same entry forks to SWITCH mode:
// radio semantics (pressed = the visible tile, tap runs the switch-to-tile
// verb), pinned in-bar (never overflows, no Tiles menu rows), gated on ≥2
// shown surfaces; the bottom-bar ▦ Surfaces chip and mobile-surface-sheet it
// replaces are gone. The button grammar is the rail's, unchanged: one
// Tip-wrapped button per available surface, tty first, "<Label> tile" aria
// names, SURFACE_GLYPH glyphs (`>_`/`://`/`{}`), aria-pressed = tile open
// (toggle mode) / tile visible (switch mode), a corner availability dot on
// every button, floor-disabled unlit buttons with the "No room for another
// tile" tip when no split fits the 150×100 px size floor (toggle mode only —
// there is no tile-count cap). The
// rail-collapse chrome (the "Toggle panel" top-bar chip, the
// `runkit-rail-open` preference, the `Panel: Toggle rail` palette action) is
// gone — its tests are deleted with it, not migrated.
//
// LOCATOR RULE (the top-bar-overflow.spec.ts pattern): the top bar ALWAYS
// renders an aria-hidden off-screen (-left-[9999px]) measurement PROBE
// duplicating every in-bar control. Playwright treats the probe as visible, so
// testid/CSS queries (`getByTestId("surface-toggles")`, `:visible` filters)
// match BOTH copies. Locate toggle buttons by ACCESSIBLE NAME scoped to the
// banner landmark — getByRole excludes the aria-hidden probe subtree.
//
// Shared setup: runs against the isolated rk-test-e2e socket
// (E2E_TMUX_SERVER). beforeAll creates one dedicated session
// `e2e-rightpanel-<ts>` (80×24) so this file never collides with other specs
// (fullyParallel off); afterAll kills it best-effort. beforeEach route-stubs
// the derived dead port's /proxy/<port>/** (stubProxyPorts, _web-tile.ts;
// port from reserveDeadPort, _ports.ts) with a static 200 page — the
// dead-port error state hides the iframe when nothing listens on the stamped
// URL, and these tests assert tile chrome, never frame content. The
// describe's beforeEach sets a wide desktop viewport (1440×800) — the toggle
// group is desktop-only and the first overflow fit candidate, so a wide
// viewport keeps it in-bar; the mobile test overrides to 375×812.
// makeWindow(name, {url?}) creates a window via tmux new-window, then stamps
// the slot-1 web tab (`stampWebTab` — `@rk_win_web_1` + `@rk_win_web_active
// 1`); the tabs ride the SSE snapshot, so no live HTTP server behind the
// iframe is needed. Default-cwd windows inherit the tmux server's repo-root
// cwd, so they are code-capable (gitRoot derived). The layout a toggle
// mutation produces is SHARED tab state — every layout assertion reads the
// window's `@rk_win_layout` tmux option (`expectWindowLayout`), never the
// URL or localStorage; the retired `?layout=`/`?view=`/`?panel=` params are
// inbound-only (translated into the option once at route entry), and the URL
// stays bare (`expectBareUrl`). gotoWindow waits for the STATUS BAR's
// `Connected` dot (the desktop sidebar renders no footer; the footer dot is
// mobile-drawer-only). Also used: the `surface-tile-web` /
// `surface-tile-code` tiles, the `Proxied content` iframe, and the `.xterm`
// terminal surface. Divider-ratio drag coverage lives in
// surface-layout.spec.ts; the overflow menu's Tiles section (when the group
// drops out of the bar) is the top-bar-overflow spec's beat.

// Own session so this file never collides with other specs (fullyParallel off).
const TEST_SESSION = `e2e-rightpanel-${Date.now()}`;
const MOBILE_VIEWPORT = { width: 375, height: 812 };
// The toggle group's TOGGLE mode is desktop-only; mobile registers the SWITCH
// mode (radio semantics, pinned in-bar, ≥2 shown surfaces). The suite runs at
// a wide desktop width (the group is the first overflow fit candidate there,
// so a wide viewport keeps it in-bar); the mobile test overrides to 375px.
const DESKTOP_VIEWPORT = { width: 1440, height: 800 };

// A URL the proxy converts to a same-origin `/proxy/<port>/…` path. The port
// is a reserved-then-released ephemeral (dead by construction — no fixed-port
// occupancy can flip the tile's posture); we assert on chrome/layout/render,
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

/** Create a window and (optionally) stamp its slot-1 web tab (`stampWebTab`).
 *  Windows inherit the tmux server's repo-root cwd, so every default-cwd
 *  window here is code-capable (gitRoot derived — the surface-layout.spec.ts
 *  pattern). Returns the @N id. */
async function makeWindow(page: Page, name: string, opts: { url?: string } = {}): Promise<string> {
  newWindow(TEST_SESSION, name);
  const id = await resolveWindow(page, name);
  if (opts.url !== undefined) {
    stampWebTab(id, opts.url);
  }
  return id;
}

/** The status bar's connection dot — the desktop readiness signal. The
 *  sidebar footer's own dot is MOBILE-ONLY since 260815-19me, so the old
 *  `nav [aria-label='Connected']` gate no longer resolves on desktop. */
const statusDot = (page: Page) =>
  page.getByTestId("status-bar").locator("[aria-label='Connected']");

/** Navigate to a window's terminal route (optionally with a search string) and
 *  wait for the connection. Desktop-only gate (mobile gates on the terminal). */
async function gotoWindow(page: Page, windowId: string, search = ""): Promise<void> {
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}${search}`);
  await expect(statusDot(page)).toBeVisible({ timeout: READY_TIMEOUT });
}

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

// Toggle buttons: accessible-name role queries scoped to the banner landmark —
// the ONLY probe-safe locator form (see the LOCATOR RULE above). Exact names:
// a substring "Terminal" would also hit the demoted "Terminal font size" menu
// row when the chevron menu is open.
const toggleButton = (page: Page, label: "Terminal" | "Web" | "Code") =>
  page.getByRole("banner").getByRole("button", { name: `${label} tile`, exact: true });
const webTile = (page: Page) => page.getByTestId("surface-tile-web");
const codeTile = (page: Page) => page.getByTestId("surface-tile-code");
const webIframe = (page: Page) => page.getByTitle("Proxied content");
const terminal = (page: Page) => page.locator(".xterm").first();

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

test.describe("Top-bar surface toggles — open-tile toggles over the surface layout", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
  });

  /**
   * Proves: the group renders on the desktop terminal route with `tty` always
   * available — lit for the default bare-`tty` layout (the option unset) —
   * `web` always
   * available with its corner dot driven by the stamped web tab (the dot
   * means "has
   * content", not "exists"), and `code` available via the derived gitRoot (a
   * repo-cwd window). Also pins the shared glyph vocabulary (`>_`, `{}`,
   * `://`) and the per-surface dot semantics.
   *
   * Steps:
   * 1. Create a plain repo-cwd window (no stamped web tab); navigate; assert the
   *    terminal, the lit `Terminal tile` toggle (with the `>_` glyph and one
   *    corner dot), the unlit `Web tile` toggle (with the `://` glyph and NO
   *    corner dot), and the unlit `Code tile` toggle (with the `{}` glyph).
   * 2. Create a window WITH a stamped web tab; navigate; assert the terminal and
   *    the visible (unlit) `Web tile` toggle now carrying its corner dot.
   */
  test("the toggle group renders on the desktop terminal route with the always-available tty + web toggles; the web dot follows the stamped web tab", async ({ page }) => {
    test.setTimeout(30_000);
    // A plain repo-cwd window (no stamped web tab) gets the group with the tty toggle
    // (always available, R8) LIT for the default bare-tty layout, the web
    // toggle (always available, 260821-zqlq) UNLIT with NO corner dot (the dot
    // signals "has content" — hasWebUrl), and the CODE toggle (gitRoot derived
    // from the inherited repo cwd).
    const plain = await makeWindow(page, `rp-plain-${Date.now()}`);
    await gotoWindow(page, plain);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    const ttyToggle = toggleButton(page, "Terminal");
    await expect(ttyToggle).toBeVisible();
    await expect(ttyToggle).toHaveAttribute("aria-pressed", "true");
    await expect(ttyToggle).toContainText(">_"); // SURFACE_GLYPH
    // tty's corner dot stays always-on.
    await expect(ttyToggle.locator("span.rounded-full")).toHaveCount(1);
    const plainWebToggle = toggleButton(page, "Web");
    await expect(plainWebToggle).toBeVisible();
    await expect(plainWebToggle).toHaveAttribute("aria-pressed", "false");
    await expect(plainWebToggle).toContainText("://");
    // No content → no dot.
    await expect(plainWebToggle.locator("span.rounded-full")).toHaveCount(0);
    // gitRoot rides the SSE window payload — the same readiness class the
    // shared CI-aware budget exists for.
    const codeToggle = toggleButton(page, "Code");
    await expect(codeToggle).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(codeToggle).toHaveAttribute("aria-pressed", "false");
    await expect(codeToggle).toContainText("{}");

    // A window with a stamped web tab: the web toggle's dot lights (content
    // present — hasWebUrl reads the webTabs family).
    const web = await makeWindow(page, `rp-cap-${Date.now()}`, { url: IFRAME_URL });
    await gotoWindow(page, web);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    const webToggle = toggleButton(page, "Web");
    await expect(webToggle).toBeVisible({ timeout: READY_TIMEOUT });
    // Not lit yet — only the tty tile is open.
    await expect(webToggle).toHaveAttribute("aria-pressed", "false");
    await expect(webToggle).toContainText("://");
    await expect(webToggle.locator("span.rounded-full")).toHaveCount(1);
  });

  /**
   * Proves: a non-repo window (cwd /tmp — no git root, no stamped web tab) is
   * still fully surface-capable: the toggle group renders the always-available
   * tty toggle, the web toggle (dotless until a URL lands), AND the `Code
   * tile` toggle — the code folder falls back to the raw cwd (`/tmp`).
   *
   * Steps:
   * 1. Create a window with cwd /tmp and no stamped web tab; navigate.
   * 2. Assert the terminal is visible (proving the SSE window payload landed,
   *    so the assertions are settled), the `Terminal tile` toggle renders, the
   *    `Web tile` toggle renders with NO corner dot, and the `Code tile`
   *    toggle renders.
   */
  test("a non-repo window with no web tab shows the tty + web + code toggles", async ({ page }) => {
    test.setTimeout(30_000);
    // cwd /tmp has no git ancestor, so the code folder falls back to the raw
    // cwd itself; web is always available (260821-zqlq) — the group renders
    // all three toggles, the web one dotless until a URL lands.
    const name = `rp-nocap-${Date.now()}`;
    newWindow(TEST_SESSION, name, { cwd: "/tmp" });
    const plain = await resolveWindow(page, name);
    await gotoWindow(page, plain);
    // The terminal mounting proves the SSE window payload landed, so the
    // assertions below are settled (not a pre-payload snapshot).
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    await expect(toggleButton(page, "Terminal")).toBeVisible();
    const webToggle = toggleButton(page, "Web");
    await expect(webToggle).toBeVisible();
    await expect(webToggle.locator("span.rounded-full")).toHaveCount(0);
    await expect(toggleButton(page, "Code")).toBeVisible();
  });

  /**
   * Proves: the toggle semantics — an unlit click APPENDS the tile (1→2
   * growth splits the tty leaf rightward into `h(tty,web)`, the visual
   * continuation of the legacy main+panel split) with the proxied iframe
   * rendering BESIDE the still-mounted terminal; the URL mirrors the layout
   * and the toggle lights; a lit click CLOSES the tile (the tree collapses
   * 2→1 to the bare `tty` leaf).
   *
   * Steps:
   * 1. Create a web-capable window; navigate; assert the terminal and wait
   *    for the `Web tile` toggle.
   * 2. Click it; assert the web iframe is visible, the terminal is still
   *    visible, the shared `@rk_win_layout` option reads
   *    `h(tty,web)`, the toggle is aria-pressed, and the tile keeps its
   *    URL textbox.
   * 3. Click the toggle again; assert the web tile is hidden, the option
   *    reads `tty` (the bare leaf), the URL is bare, the toggle is unlit, and
   *    the terminal is still visible.
   */
  test("clicking a surface toggle opens a web tile beside a live terminal; clicking again closes it", async ({ page }) => {
    test.setTimeout(30_000);
    const id = await makeWindow(page, `rp-toggle-${Date.now()}`, { url: IFRAME_URL });
    await gotoWindow(page, id);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    const webToggle = toggleButton(page, "Web");
    await expect(webToggle).toBeVisible({ timeout: READY_TIMEOUT });

    // Open: 1→2 growth writes the `h(tty,web)` tree (R10) — the proxied
    // iframe renders BESIDE the terminal, which stays mounted and visible (the
    // layout is additive, like the panel was). The write lands in the shared
    // option and the toggle lights.
    await webToggle.click();
    await expect(webIframe(page)).toBeVisible({ timeout: 10_000 });
    await expect(terminal(page)).toBeVisible();
    await expectWindowLayout(id, "h(tty,web)");
    await expect(webToggle).toHaveAttribute("aria-pressed", "true");
    // The tile-context iframe keeps its URL bar.
    await expect(webTile(page).getByRole("textbox", { name: "URL" })).toBeVisible();

    // Close via the same toggle: the web tile hides (R7 close semantics — the
    // layout collapses 2→1 and the option carries the bare `tty` leaf).
    await webToggle.click();
    await expect(webTile(page)).toBeHidden();
    await expectWindowLayout(id, "tty");
    expectBareUrl(page);
    await expect(webToggle).toHaveAttribute("aria-pressed", "false");
    await expect(terminal(page)).toBeVisible();
  });

  /**
   * Proves: the add/close arity walk through the top-bar group — 1→2 growth
   * is `h(tty,web)`, 2→3 growth is `h(tty,v(web,code))` (the new tile splits
   * the FOCUSED tile along its longer axis — the test focuses the web tile,
   * taller than wide at half width in desktop landscape, so code lands below
   * it: the legacy main-left
   * arrangement, stored as a tree), and a lit click closes 3→2 back to
   * `h(tty,web)` (remove + normalise, structure kept). The file's heaviest
   * mounts are this flow and the size-floor disable test's nine-row all-tty
   * tree (all-tty stays on the one muxed terminals socket); they run serially
   * in fresh browser contexts, so the h1 6-slot pool budget is per-page and
   * never contended.
   *
   * Steps:
   * 1. Create a web-capable (and repo-cwd, so code-capable) window; navigate;
   *    wait for both the `Web tile` and `Code tile` toggles.
   * 2. Click `Web tile`; assert the option reads `h(tty,web)`, the
   *    visible web tile, and the lit toggle.
   * 3. Click the web tile's header (focus — the add splits the FOCUSED tile),
   *    then click `Code tile`; assert the option reads `h(tty,v(web,code))`,
   *    the visible code tile, and the lit toggle.
   * 4. Click `Code tile` again; assert the option reads `h(tty,web)`,
   *    the hidden code tile, and the unlit toggle.
   */
  test("toggles grow the layout 1→2 h(tty,web) then 2→3 h(tty,v(web,code)); a lit click closes back down (R10/R7)", async ({ page }) => {
    test.setTimeout(30_000);
    // The file's other heavy mount is the size-floor disable test's nine-row
    // all-tty tree (all-tty stays on the one muxed terminals socket) — they
    // run serially in fresh browser contexts, so the h1 6-slot pool budget
    // (surface-layout.spec.ts's Performance note) is per-page and never
    // contended.
    const id = await makeWindow(page, `rp-arity-${Date.now()}`, { url: IFRAME_URL });
    await gotoWindow(page, id);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    const webToggle = toggleButton(page, "Web");
    const codeToggle = toggleButton(page, "Code");
    await expect(webToggle).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(codeToggle).toBeVisible({ timeout: READY_TIMEOUT });

    // 1→2 appends web beside tty; 2→3 splits the FOCUSED tile along its
    // longer axis — so focus the web tile first (header click; the focus seam
    // is pointerdown capture), letting code land below it (the main-left
    // arrangement). Unsteered, slot A (tty) is focused and the add would land
    // h(v(tty,code),web).
    await webToggle.click();
    await expectWindowLayout(id, "h(tty,web)");
    await expect(webTile(page)).toBeVisible({ timeout: 10_000 });
    await expect(webToggle).toHaveAttribute("aria-pressed", "true");

    await webTile(page).click({ position: { x: 6, y: 15 } });
    await codeToggle.click();
    await expectWindowLayout(id, "h(tty,v(web,code))");
    await expect(codeTile(page)).toBeVisible({ timeout: 10_000 });
    await expect(codeToggle).toHaveAttribute("aria-pressed", "true");

    // A lit click closes: 3→2 removes the leaf and normalises — the remaining
    // structure is kept, so `h(tty,web)` (R7).
    await codeToggle.click();
    await expectWindowLayout(id, "h(tty,web)");
    await expect(codeTile(page)).toBeHidden();
    await expect(codeToggle).toHaveAttribute("aria-pressed", "false");
  });

  /**
   * Proves: the size-floor gate (there is no tile-count cap) — with the
   * layout stamped to nine tty ROWS, splitting any tile would push the
   * resulting rows under the 100px height floor in this viewport, so the
   * UNLIT toggles render disabled instead of no-oping silently, and the
   * disabled button still tips "No room for another tile" (the Tip wraps a
   * span so the tooltip survives the disabled control's swallowed pointer
   * events). The gate is floor-derived, not a count: closing rows (the lit
   * Terminal toggle removes one leaf per click) shrinks the tree until a
   * split fits the floor again, re-enabling the unlit toggle.
   *
   * Steps:
   * 1. Create a window; stamp `@rk_win_layout` to `v(...)` with nine bare
   *    tty rows via tmux (repeated bare tty is legal); navigate; assert the
   *    terminal and the option value.
   * 2. Assert `Terminal tile` is lit while `Web tile` is unlit and disabled.
   * 3. Hover the Web toggle's PARENT SPAN; assert a role="tooltip" element
   *    reads "No room for another tile" (expect's retry absorbs the open
   *    delay); move the mouse away.
   * 4. Click the lit `Terminal tile` toggle once; assert eight rows and the
   *    Web toggle still disabled (a 9th row still breaks the floor).
   * 5. Click it twice more; assert the option reads six rows and the Web
   *    toggle enabled again (a split of any row fits the floor).
   */
  test("the unlit toggle is disabled only when no split fits the size floor, tipping 'No room for another tile'", async ({ page }) => {
    test.setTimeout(40_000);
    const name = `rp-floor-${Date.now()}`;
    newWindow(TEST_SESSION, name);
    const id = await resolveWindow(page, name);
    // Nine tty rows: at this 1440×800 viewport each row is ~75px tall, so
    // any add (a row split keeps the row's height) lands under the 100px
    // floor and every candidate is refused. Repeated bare tty is legal.
    const rows = (n: number) => `v(${Array.from({ length: n }, () => "tty").join(",")})`;
    setWindowOption(id, "@rk_win_layout", rows(9));

    await gotoWindow(page, id);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    await expectWindowLayout(id, rows(9));

    const webToggle = toggleButton(page, "Web");
    await expect(webToggle).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(toggleButton(page, "Terminal")).toHaveAttribute("aria-pressed", "true");
    await expect(webToggle).toHaveAttribute("aria-pressed", "false");
    await expect(webToggle).toBeDisabled();

    // The Tip wraps a span so the DISABLED button still tips (disabled
    // controls swallow the pointer events Tip listens for) — hover the
    // button's parent span; expect's retry absorbs the open delay.
    await webToggle.locator("xpath=..").hover();
    await expect(page.getByRole("tooltip")).toContainText("No room for another tile");
    await page.mouse.move(0, 0);

    // The gate follows the floor, not the count: at eight rows a 9th still
    // breaks the floor; at six rows a split fits and the toggle re-enables.
    const ttyToggle = toggleButton(page, "Terminal");
    await ttyToggle.click();
    await expectWindowLayout(id, rows(8));
    await expect(webToggle).toBeDisabled();
    await ttyToggle.click();
    await expectWindowLayout(id, rows(7));
    await ttyToggle.click();
    await expectWindowLayout(id, rows(6));
    await expect(webToggle).toBeEnabled();
  });

  /**
   * Proves: one-shot inbound translation — the retired `?panel=web` maps to
   * the two-tile tree `h(tty,web)` (a bare panel value against the tty
   * default slot A),
   * is written to `@rk_win_layout` once, and the URL is replaced with the
   * bare route; the native `?layout=` form translates identically; on a
   * window WITHOUT a stamped web tab the web tile is still always available
   * and renders its ONBOARDING content state in place of the iframe. Never a
   * broken iframe. The test
   * carries a 30s budget (test.setTimeout, the sidebar-panels precedent):
   * three full page loads plus three window creations exceed the 10s default
   * on a loaded box.
   *
   * Steps:
   * 1. Create a web-capable window; navigate with `?panel=web`; assert the
   *    option reads `h(tty,web)`, the URL is bare, and the web iframe
   *    and the terminal are both visible.
   * 2. Create a second web-capable window; navigate with
   *    `?layout=split-h:tty,web`; assert the same option write and render.
   * 3. Create a plain window (no stamped web tab); navigate with
   *    `?panel=web`; assert the terminal, both `Terminal tile` AND
   *    `Web tile` toggle buttons, the `web-tile-onboarding` panel, and no
   *    iframe.
   */
  test("?panel=web and ?layout=split-h:tty,web deep links translate into @rk_win_layout once", async ({ page }) => {
    // Three full page loads + three tmux window creations — wider budget for a
    // loaded box (the sidebar-panels precedent); the per-assertion waits stay
    // at their own timeouts.
    test.setTimeout(30_000);
    // The retired ?panel=web param translates through the inbound shim (a bare
    // panel value maps against the tty default slot A → h(tty,web), stored in
    // the tree form) — one
    // option write on a web-capable window, then the URL goes bare.
    const web = await makeWindow(page, `rp-deep-${Date.now()}`, { url: IFRAME_URL });
    await gotoWindow(page, web, "?panel=web");
    await expectWindowLayout(web, "h(tty,web)");
    await expect.poll(() => new URL(page.url()).search, { timeout: 10_000 }).toBe("");
    await expect(webIframe(page)).toBeVisible({ timeout: 10_000 });
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });

    // The native ?layout= form translates identically (the legacy preset
    // parses permanently; the write lands in tree form).
    const web2 = await makeWindow(page, `rp-deep2-${Date.now()}`, { url: IFRAME_URL });
    await gotoWindow(page, web2, "?layout=split-h:tty,web");
    await expectWindowLayout(web2, "h(tty,web)");
    await expect(webIframe(page)).toBeVisible({ timeout: 10_000 });
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });

    // ?panel=web on a window with NO stamped web tab → web is always available
    // (260821-zqlq), so the tile opens and renders the ONBOARDING state in
    // place of the iframe; the group shows the web toggle.
    const plain = await makeWindow(page, `rp-nourl-${Date.now()}`);
    await gotoWindow(page, plain, "?panel=web");
    await expectWindowLayout(plain, "h(tty,web)");
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    await expect(toggleButton(page, "Terminal")).toBeVisible();
    await expect(toggleButton(page, "Web")).toBeVisible();
    await expect(page.getByTestId("web-tile-onboarding")).toBeVisible({ timeout: 10_000 });
    await expect(webIframe(page)).toHaveCount(0);
  });

  /**
   * Proves: both persisted layout directions round-trip through tmux: an open
   * web tile returns after a bare reload, and after closing it the bare route
   * returns to the terminal-only layout.
   *
   * Steps:
   * 1. Create a web-capable window; navigate and open the web tile; assert
   *    `h(tty,web)`.
   * 2. Reload the bare route; assert the iframe returns and the URL is bare.
   * 3. Close the web tile; assert the bare `tty` leaf and the hidden tile
   *    state.
   * 4. Reload the bare route; assert the terminal renders, no web tile mounts,
   *    and the URL remains bare.
   */
  test("open and closed tile states persist across reload", async ({ page }) => {
    test.setTimeout(30_000);
    const id = await makeWindow(page, `rp-persist-${Date.now()}`, { url: IFRAME_URL });
    await gotoWindow(page, id);
    const webToggle = toggleButton(page, "Web");
    await expect(webToggle).toBeVisible({ timeout: READY_TIMEOUT });

    // Open → reload → still open (the shared option resolves on the bare
    // re-arrival).
    await webToggle.click();
    await expect(webIframe(page)).toBeVisible({ timeout: 10_000 });
    await expectWindowLayout(id, "h(tty,web)");
    await gotoWindow(page, id);
    await expect(webIframe(page)).toBeVisible({ timeout: 10_000 });
    expectBareUrl(page);

    // Open then close (closing writes the bare `tty` leaf as the window's
    // shared layout) → reload → still closed: no web tile mounts and the
    // terminal renders.
    await webToggle.click();
    await expect(webTile(page)).toBeHidden();
    await expectWindowLayout(id, "tty");
    await gotoWindow(page, id);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    await expect(webTile(page)).toHaveCount(0);
    expectBareUrl(page);
  });

  /**
   * Proves: the layout grammar's duplicate-kind rejection — the inbound
   * shim maps `?view=web&panel=web` to `split-h:web,web`, which is INVALID
   * (one tile per surface kind, tty excepted); the unparsable carried value
   * writes NOTHING to `@rk_win_layout` and the bare `tty` fallback
   * renders. The retired two-independent-web-slots arrangement (main lens +
   * panel) has no layout-model successor — the intent it served (two
   * surfaces at once) is covered by the two-tile tests.
   *
   * Steps:
   * 1. Create a web-capable window; navigate with `?view=web&panel=web`.
   * 2. Assert the terminal renders, exactly one `surface-layout` grid
   *    exists, no web tile mounts, and the option stays UNSET (nothing valid
   *    to write) while the URL goes bare.
   */
  test("?view=web&panel=web (a repeated non-tty kind after the shim) writes nothing and renders the bare-tty fallback", async ({ page }) => {
    test.setTimeout(30_000);
    // The shim maps ?view=web&panel=web to split-h:web,web — a REPEATED
    // non-tty kind, which the layout grammar rejects (R1: one tile per surface
    // kind). The invalid carried value is never written; no malformed tile
    // ever mounts.
    const id = await makeWindow(page, `rp-dupe-${Date.now()}`, { url: IFRAME_URL });
    await gotoWindow(page, id, "?view=web&panel=web");
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    // Exactly ONE layout render with a valid single tile — never two web
    // slots (the retired main+panel arrangement).
    await expect(page.getByTestId("surface-layout")).toHaveCount(1);
    await expect(webTile(page)).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).search, { timeout: 10_000 }).toBe("");
    expect(windowOption(id, "@rk_win_layout")).toBe("");
  });

  /**
   * Proves: the route gate — the top-bar registry entry is hidden unless
   * mode === "terminal" && currentWindow && surfaceToggles, so the server
   * route (mode `server`, no current window) renders no group anywhere (bar,
   * probe, or menu).
   *
   * Steps:
   * 1. Navigate to /<server>; wait for the status-bar `Connected` dot.
   * 2. Assert the banner carries no `Terminal tile`, `Web tile`, or
   *    `Code tile` button.
   */
  test("the toggle group does not render off the terminal route (the server route's banner carries no tile toggles)", async ({ page }) => {
    // The top-bar registry entry is hidden unless mode==="terminal" &&
    // currentWindow && surfaceToggles — the server route (mode "server", no
    // current window) renders no group anywhere (bar, probe, or menu).
    await page.goto(`/${TMUX_SERVER}`);
    await expect(statusDot(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(toggleButton(page, "Terminal")).toHaveCount(0);
    await expect(toggleButton(page, "Web")).toHaveCount(0);
    await expect(toggleButton(page, "Code")).toHaveCount(0);
  });

  test.describe("mobile (375px, coarse pointer)", () => {
    // hasTouch flips Chromium's `(pointer: coarse)` media query — a real phone
    // is coarse AND narrow (the bottom-bar-chip-size seam). 260814-ldbs made
    // the bottom bar pointer-gated, so a viewport-only "mobile" emulation
    // (fine pointer, narrow width) exercises a different bar — the iPad/phone
    // seam is pointer-decided.
    test.use({ hasTouch: true });

    /**
     * Proves: the mobile SWITCH fork of the surface-toggles entry — at 375px
     * with ≥2 shown surfaces the banner carries one `<Label> tile` button per
     * shown surface (the visible one pressed), the retired ▦ Surfaces chip is
     * gone, and tapping an unpressed button swaps the visible tile
     * PER-VIEWER when the target is already open in the shared layout (only
     * the zoom key changes — the option, and so the desktop arrangement,
     * never does). The nested describe runs test.use({ hasTouch: true })
     * so `(pointer: coarse)` matches — a real phone is coarse AND narrow, and
     * the bottom bar is pointer-gated: a fine-pointer narrow window exercises
     * a different bar by design.
     *
     * Steps:
     * 1. Set a 375×812 viewport (context already has hasTouch); create a
     *    web-capable window.
     * 2. Navigate with `?layout=split-h:tty,web` (inbound translation parses
     *    the legacy preset and writes the option in tree form; gate on the
     *    terminal, not the `Connected` dot — on
     *    mobile the dot lives in the drawer's footer, which is unmounted
     *    until the drawer opens).
     * 3. Assert the option reads `h(tty,web)`, the terminal is visible,
     *    the banner's `Web tile` button renders (READY_TIMEOUT — the second
     *    surface resolves with the window payload), the `Terminal tile`
     *    button reads aria-pressed=true and `Web tile` reads false, the web
     *    tile is hidden (mounted), and no `mobile-surfaces-chip` exists in
     *    the DOM.
     * 4. Click `Web tile`; assert the web tile becomes visible, the pressed
     *    state flips (Web pressed, Terminal not), the zoom key holds `web`,
     *    and the option still reads `h(tty,web)` — the swap sent NO
     *    layout write.
     */
    test("375px mobile: the top-bar switch group renders with radio semantics and switches the open web tile per-viewer", async ({ page }) => {
      test.setTimeout(30_000);
      await page.setViewportSize(MOBILE_VIEWPORT);
      const id = await makeWindow(page, `rp-mobile-${Date.now()}`, { url: IFRAME_URL });
      // Do NOT gate on the `Connected` dot here: it lives in the desktop
      // status bar (and the mobile drawer's footer) — at 375px neither is
      // mounted until the drawer opens. Gate on the terminal instead.
      await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}?layout=split-h:tty,web`);
      await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
      await expectWindowLayout(id, "h(tty,web)");
      // The mobile banner carries the switch group (app.tsx registers switch
      // mode when ≥2 surfaces survive the hidden filter): one button per
      // shown surface, the VISIBLE surface pressed (slot A = tty on arrival).
      // The center renders ONLY slot A (tty) full-width; the web tile stays
      // mounted-hidden until switched to.
      const ttyToggle = toggleButton(page, "Terminal");
      const webToggle = toggleButton(page, "Web");
      // READY_TIMEOUT: on a cold deep link the second surface (and so the
      // group) resolves only once the window payload lands with webTabs.
      await expect(webToggle).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(ttyToggle).toHaveAttribute("aria-pressed", "true");
      await expect(webToggle).toHaveAttribute("aria-pressed", "false");
      await expect(webTile(page)).toBeHidden();
      // The ▦ Surfaces chip + sheet are retired — the top-bar group subsumes
      // them, so no `mobile-surfaces-chip` testid exists anywhere in the DOM.
      await expect(page.getByTestId("mobile-surfaces-chip")).toHaveCount(0);
      // Tapping the unpressed Web button switches the visible tile. The web
      // tile is OPEN in the shared layout, so the swap is PER-VIEWER: the
      // zoom key changes; the option (and every desktop viewer's arrangement)
      // stays untouched.
      await webToggle.click();
      await expect(webTile(page)).toBeVisible({ timeout: 10_000 });
      await expect(webToggle).toHaveAttribute("aria-pressed", "true");
      await expect(ttyToggle).toHaveAttribute("aria-pressed", "false");
      expect(
        await page.evaluate(
          (key) => localStorage.getItem(key),
          `rk-layout-zoom:${TMUX_SERVER}:${id}`,
        ),
      ).toBe("web");
      expect(windowOption(id, "@rk_win_layout")).toBe("h(tty,web)");
      expectBareUrl(page);
    });
  });
});
