import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { READY_TIMEOUT, openPalette, resolveWindow as resolveWindowRaw } from "./_ready";
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

// Surface-layout core e2e (spec docs/specs/surface-layout.md + ui-state.md §
// Layout in tmux). The window's layout is SHARED tab state — the
// `@rk_win_layout` tmux window option holding a CANONICAL SPLIT TREE
// (`h(tty,web)`, `h(tty,v(web,code))`, …; legacy preset strings still parse,
// but every writer emits the tree form): tile verbs, the header drag-to-snap,
// and the top-bar surface-toggle group POST it through /options, and every
// assertion here reads tmux (`windowOption`), never the URL or localStorage.
// The retired `?layout=`/`?view=`/`?panel=` params are inbound-only (one
// release of route-entry translation into the option); history entries are
// bare routes. Per-viewer state stays local: divider sizes
// (`rk-layout-sizes:*`, keyed by structure signature, persisted across
// reload) and zoom (`rk-layout-zoom:*`, the surface KIND — desktop zoom AND
// the mobile single-tile choice). Also covered: the mobile slot-A + top-bar
// switch-group branch, the focused-tile accent border, the tty-scoped
// split-chord gate, the tty pane segment (Split H · Split V · Close Pane —
// any arity, zoom-visible, tty-only) + the terminal bar's split demotion
// (menuOnly; the chevron menu keeps the three rows), the gap-seam chrome
// (rest grip dots, hover/drag sash pill, the divider-intersection zone), the
// header drag (center swap / tile-edge split / layout-edge span / Escape
// cancel, via page.mouse), and the two-viewer convergence/isolation contract
// (a toggle in one browser context repaints a second; zoom stays per-viewer).
//
// Perf budget (binding): the plaintext e2e origin is HTTP/1.1 with a 6-slot
// connection pool — only ONE test mounts 3 tiles (the verbs test, which also
// hosts the header-drag flows); every other flow stays at ≤2 tiles.
//
// Shared setup: `beforeAll` creates one dedicated session
// `e2e-surflayout-<ts>` (80×24) so this file never collides with other specs
// (`fullyParallel` off), then warms the dev server with a throwaway
// terminal-route page load (Vite's cold transform of the app + xterm graph
// would otherwise eat the first test's budget); `afterAll` kills the session
// (best-effort). `beforeEach` stubs the derived dead port's `/proxy/<port>/**`
// with a static 200 page (stubProxyPorts from _web-tile.ts, port from
// reserveDeadPort in _ports.ts — the dead-port error state hides the
// iframe when nothing listens on the stamped URL, and these tests assert
// tile chrome, never frame content) and sets a wide desktop viewport
// (1440×800) — multi-tile is desktop-only; the mobile test overrides to
// 375×812 with `hasTouch`. `makeWindow(name, {url?})` creates a window via
// tmux and stamps the slot-1 web tab (`stampWebTab` — `@rk_win_web_1` +
// `@rk_win_web_active 1`); windows inherit the tmux server's repo-root cwd,
// so every window is code-capable. `paneCount(id)` reads the live tmux pane
// count (the split-chord gate's ground truth, not a DOM read).
// `expectWindowLayout` is a retrying read of the window's `@rk_win_layout`
// option (the POST + option tick land asynchronously); `expectBareUrl`
// asserts the route carries no search params. Focus clicks target the tile
// header at {x: 6, y: 15} — the focus seam is pointerdown-capture anywhere
// in the tile, and a sub-4px press is never a drag (the header drag arms
// past DRAG_THRESHOLD_PX). `dragTileHeader` drives a header drag with
// page.mouse (down on the header, stepped moves past the threshold, up).

// Own session so this file never collides with other specs (fullyParallel off).
const TEST_SESSION = `e2e-surflayout-${Date.now()}`;
const DESKTOP_VIEWPORT = { width: 1440, height: 800 };
const MOBILE_VIEWPORT = { width: 375, height: 812 };

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

/** Create a window and (optionally) stamp its slot-1 web tab via tmux
 *  (`stampWebTab` — `@rk_win_web_1` + `@rk_win_web_active 1`). Windows
 *  inherit the tmux server's repo-root cwd, so every window here is
 *  code-capable (gitRoot derived). Returns the @N id. */
async function makeWindow(page: Page, name: string, opts: { url?: string } = {}): Promise<string> {
  newWindow(TEST_SESSION, name);
  const id = await resolveWindow(page, name);
  if (opts.url !== undefined) {
    stampWebTab(id, opts.url);
  }
  return id;
}

/** The window's live tmux pane count (the split-chord gate's ground truth). */
function paneCount(windowId: string): number {
  return Number(
    execFileSync("tmux", ["-L", TMUX_SERVER, "display-message", "-t", windowId, "-p", "#{window_panes}"])
      .toString()
      .trim(),
  );
}

/** Navigate to a window's terminal route (optionally with a search string) and
 *  wait for the SSE connection. Desktop-only gate (the `Connected` dot lives in
 *  the full-width bottom STATUS BAR since the composed-frame unification — the
 *  desktop sidebar renders no footer; the mobile test gates on the terminal
 *  instead). Unscoped query: the status-bar dot is now the ONLY `Connected`
 *  element on a desktop route. */
async function gotoWindow(page: Page, windowId: string, search = ""): Promise<void> {
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}${search}`);
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

/** Assert the route is bare — layout state lives in tmux, never the URL. */
function expectBareUrl(page: Page): void {
  expect(new URL(page.url()).search).toBe("");
}

// The surface toggles live in the top bar's `surface-toggles` group (the right
// rail is REMOVED — composed-frame unification). Locate by ACCESSIBLE NAME
// scoped to the banner: the top bar always renders an aria-hidden off-screen
// measurement probe duplicating every in-bar control, so testid / `:visible`
// queries are ambiguous (two copies) — getByRole excludes the probe.
const surfaceToggle = (page: Page, label: "Terminal" | "Web" | "Code") =>
  page.getByRole("banner").getByRole("button", { name: `${label} tile` });
const tile = (page: Page, kind: "tty" | "web" | "code", occ = 1) =>
  page.getByTestId(`surface-tile-${kind}${occ > 1 ? `-${occ}` : ""}`);
const divider = (page: Page, index = 0) => page.getByTestId(`surface-divider-${index}`);
const terminal = (page: Page) => page.locator(".xterm").first();
const webIframe = (page: Page) => page.getByTitle("Proxied content");

/** A header drag (drop to snap): press the tile's header at its left padding
 *  (never a verb button), move in steps past the 4px threshold to each
 *  waypoint, then release — or hold for an Escape cancel. Coordinates are
 *  page-level. Returns after the final move when `hold` is set. */
async function dragTileHeader(
  page: Page,
  kind: "tty" | "web" | "code",
  waypoints: { x: number; y: number }[],
  opts: { occ?: number; hold?: boolean } = {},
): Promise<void> {
  const box = await tile(page, kind, opts.occ ?? 1).boundingBox();
  if (!box) throw new Error(`no ${kind} tile box`);
  await page.mouse.move(box.x + 60, box.y + 15);
  await page.mouse.down();
  for (const p of waypoints) await page.mouse.move(p.x, p.y, { steps: 4 });
  if (!opts.hold) await page.mouse.up();
}

// The dead-port error state (260819-v6y4 R8) hides the iframe when nothing
// listens on the stamped port — these tests assert tile chrome, never frame
// content, so the proxy path is route-stubbed live (see _web-tile.ts).
test.beforeEach(async ({ page }) => {
  await stubProxyPorts(page, DEAD.port);
});

test.beforeAll(async ({ browser }) => {
  createSession(TEST_SESSION);
  // Cold-boot warm-up (the code-surface precedent): when this file runs
  // standalone, the first test would otherwise pay Vite's cold transform of
  // the app + xterm graph INSIDE its budget. A throwaway terminal-route load
  // in beforeAll (outside the per-test budget) absorbs it.
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

test.describe("Surface layout — ladder, verbs, history, sizes, mobile", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
  });

  /**
   * Proves: one-shot inbound translation — a legacy `?view=code&panel=web`
   * deep link on a window whose `@rk_win_layout` is UNSET lands the mapped
   * layout in tmux in the TREE form (`h(code,web)` — the legacy
   * `split-h:code,web` mapping parses, and the writer emits the tree) with
   * exactly one option write, the URL is replaced with the bare route (legacy
   * params gone), and both tiles render (code iframe + proxied web iframe),
   * never a broken tile.
   *
   * Steps:
   * 1. Create a web-capable window (stamped web tab; repo cwd ⇒ code-capable).
   * 2. Navigate with `?view=code&panel=web`.
   * 3. Assert `@rk_win_layout` reads `h(code,web)` and the URL is bare.
   * 4. Assert the `surface-tile-code` and `surface-tile-web` tiles are
   *    visible and the `Proxied content` iframe renders.
   */
  test("legacy ?view=code&panel=web deep link translates into @rk_win_layout once and drops the params", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    const id = await makeWindow(page, `sl-shim-${Date.now()}`, { url: IFRAME_URL });
    await gotoWindow(page, id, "?view=code&panel=web");

    // The route-entry translation maps the retired params to split-h:code,web
    // (view in slot A) and POSTs the option in the tree form; the URL is
    // replaced with the bare route.
    await expectWindowLayout(id, "h(code,web)");
    await expect.poll(() => new URL(page.url()).search, { timeout: 10_000 }).toBe("");
    // Both tiles render: the code tile (a repo-cwd window is code-capable) and
    // the web tile with its proxied iframe.
    await expect(tile(page, "code")).toBeVisible({ timeout: 10_000 });
    await expect(tile(page, "web")).toBeVisible();
    await expect(webIframe(page)).toBeVisible({ timeout: READY_TIMEOUT });
  });

  /**
   * Proves: the shared layout WINS over a carried param — on a window whose
   * `@rk_win_layout` is already set, a `?view=web` deep link writes nothing
   * (the option keeps its value), the URL is still cleaned to the bare
   * route, and the set layout renders (the code tile, not the web one the
   * param asked for). The option is stamped via tmux in the LEGACY preset
   * grammar (`single:code`) — external writes may use either grammar, the
   * legacy parse is permanent, and an untouched option is never rewritten.
   *
   * Steps:
   * 1. Create a web-capable window and stamp `@rk_win_layout single:code`
   *    (legacy preset grammar, via tmux).
   * 2. Navigate with `?view=web`.
   * 3. Assert the option still reads `single:code` verbatim and the URL is
   *    bare.
   * 4. Assert the code tile is visible and no web tile exists.
   */
  test("a set @rk_win_layout beats a carried ?view= param: no write, params dropped, shared layout renders", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    const id = await makeWindow(page, `sl-setwins-${Date.now()}`, { url: IFRAME_URL });
    execFileSync("tmux", ["-L", TMUX_SERVER, "set-option", "-w", "-t", id, "@rk_win_layout", "single:code"]);
    await gotoWindow(page, id, "?view=web");

    // No write — the option keeps its value; the param only gets dropped.
    // (A beat so a would-be write could land before asserting the value.)
    await expect.poll(() => new URL(page.url()).search, { timeout: 10_000 }).toBe("");
    expect(windowOption(id, "@rk_win_layout")).toBe("single:code");
    await expect(tile(page, "code")).toBeVisible({ timeout: 10_000 });
    await expect(tile(page, "web")).toHaveCount(0);
  });

  /**
   * Proves: the top-bar `surface-toggles` group's open-tile toggles grow the
   * layout (1→2 `h(tty,web)`, 2→3 `h(tty,v(web,code))` — the add splits the
   * FOCUSED tile along its longer axis, so the test steers focus with a tile
   * header click before each add) and every tile-level verb mutates the
   * tree exactly as specified, each outcome POSTed to the shared
   * `@rk_win_layout` option in the tree form. Rearrangement runs through the
   * palette (`Layout: Promote Code`, `Tile: Swap Up` on the focused tile) and
   * the header DRAG (drop to snap): a center drop swaps, a tile-edge drop
   * splits beside, a layout-edge drop spans that side at 50 %, and Escape
   * cancels mid-drag — each committing exactly one option write. Also the
   * divider-intersection zone: a mid-seam hover lights only that sash, the
   * junction hover lights BOTH, and a diagonal drag moves BOTH fraction pairs
   * (persisted on release under the structure-signature sizes key, URL
   * untouched, terminal still the same mounted element) — and a leaf swap
   * keeps the dragged sizes (the structure, so the key, is unchanged).
   * Folded onto the same mount at the end: the close-a-column behaviour —
   * closing the middle tile of `v(code,tty,web)` leaves `v(code,web)` (the
   * structure is kept). This is the file's ONE bounded 3-tile test (the
   * origin's 6-slot connection-pool budget).
   *
   * Steps:
   * 1. Create a web-capable window; navigate; assert the terminal.
   * 2. Click the `Web tile` top-bar toggle; assert the option reads
   *    `h(tty,web)`, the web tile visible, and the button lit
   *    (`aria-pressed`).
   * 3. Click the web tile's header (focus — the add splits the FOCUSED tile),
   *    then the `Code tile` top-bar toggle; assert the option reads
   *    `h(tty,v(web,code))` and the code tile visible.
   * 4. Intersection: assert the `surface-divider-intersection` zone is
   *    visible; hover divider 0 mid-seam (`y: 100`, far from the junction)
   *    and assert only its `.rk-sash` lights (opacity 1, after the ~150ms
   *    delay) while divider 1's stays 0; hover the junction and assert BOTH
   *    sashes light.
   * 5. Intersection drag: capture both dividers' `aria-valuenow` and the
   *    xterm element; mouse down on the junction, move diagonally
   *    (+80/−60px), up; assert BOTH `aria-valuenow`s changed, the terminal
   *    is the SAME element, the localStorage
   *    `rk-layout-sizes:{server}:{@N}:h(0,v(1,2))` entry holds both fraction
   *    pairs (JSON array-of-arrays, each summing to 1, neither first
   *    fraction the template default), and the option still reads
   *    `h(tty,v(web,code))` (a drag mutates sizes only).
   * 6. Palette `Layout: Promote Code`; assert the option reads
   *    `h(code,v(web,tty))` (code swapped with slot A, structure unchanged)
   *    and divider 0 still reads the dragged value — sizes key on the
   *    structure signature, so a leaf swap keeps them.
   * 7. Click the tty tile's header (focus; the code workbench's one-shot
   *    boot-time focus grab may steal focus once — re-assert until the
   *    palette offers `Tile: Swap Up`), then take that row; assert the
   *    option reads `h(code,v(tty,web))` (tty swapped with its geometric
   *    neighbour above).
   * 8. Hover the web tile, click `Close Web`; assert the option reads
   *    `h(code,tty)` (the nested split lifts), the web tile hidden, the
   *    code tile and terminal still visible, and the web top-bar toggle
   *    unlit.
   * 9. Close-a-column: re-focus the tty tile, re-add web via the toggle
   *    (`h(code,v(tty,web))` — the focused tty splits);
   *    apply the Column template from the palette (`Layout: Column` →
   *    `v(code,tty,web)`); close the middle tile (Terminal); assert the
   *    option reads `v(code,web)` — a column stays a column.
   * 10. Header drag (same mount): re-focus the web tile, re-add tty
   *    (`v(code,h(web,tty))` — the focused web row splits horizontally); drag the
   *    tty header onto the code tile's CENTER — assert the overlay renders
   *    with a `tile-drop-dest`, release, and the option reads
   *    `v(tty,h(web,code))` (a center drop swaps); drag the tty header onto
   *    the code tile's RIGHT edge band — the option reads `h(web,code,tty)`
   *    (a tile-edge drop splits beside); drag the tty header to the layout's
   *    TOP edge (the outer 18px band) — the option reads `v(tty,h(web,code))`
   *    (a layout-edge drop spans the top at 50 %); start a fourth drag,
   *    press Escape mid-hold — the overlay disappears and the option stays
   *    `v(tty,h(web,code))`. The URL stays bare throughout.
   */
  test("build a 3-tile layout via the top-bar surface toggles; palette promote/swap, header close, and header drag-to-snap mutate the layout tree (option, never the URL)", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // The ONE bounded 3-tile test in this file (h1 6-slot pool discipline).
    const id = await makeWindow(page, `sl-verbs-${Date.now()}`, { url: IFRAME_URL });
    await gotoWindow(page, id);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });

    // The top-bar surface toggles grow the layout: 1→2 h(tty,web), then 2→3
    // h(tty,v(web,code)) — the add splits the FOCUSED tile along its longer
    // axis, so before adding code the test focuses the web tile (header
    // click; the focus seam is pointerdown capture). Unsteered, slot A (tty)
    // is focused and the add would land h(v(tty,code),web).
    const webToggle = surfaceToggle(page, "Web");
    const codeToggle = surfaceToggle(page, "Code");
    await expect(webToggle).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(codeToggle).toBeVisible({ timeout: READY_TIMEOUT });

    await webToggle.click();
    await expectWindowLayout(id, "h(tty,web)");
    await expect(tile(page, "web")).toBeVisible({ timeout: 10_000 });
    await expect(webToggle).toHaveAttribute("aria-pressed", "true");

    await tile(page, "web").click({ position: { x: 6, y: 15 } });
    await codeToggle.click();
    await expectWindowLayout(id, "h(tty,v(web,code))");
    await expect(tile(page, "code")).toBeVisible({ timeout: 10_000 });
    await expect(codeToggle).toHaveAttribute("aria-pressed", "true");

    // — Gap-seam intersection, folded into THIS 3-tile mount (the h1 6-slot
    // pool budget allows only one): the nested tree renders the two-axis
    // T-junction zone where divider 0's end meets divider 1; a mid-seam
    // hover lights only that seam, the junction hover lights BOTH sashes,
    // and a diagonal drag moves BOTH fraction pairs, persisted on release
    // under the structure-signature sizes key.
    const junction = page.getByTestId("surface-divider-intersection");
    await expect(junction).toBeVisible();
    const sash0 = divider(page, 0).locator(".rk-sash");
    const sash1 = divider(page, 1).locator(".rk-sash");
    // Mid-seam hover (y=100 is far above the junction) lights only that seam —
    // after the ~150ms anti-flicker delay.
    await divider(page, 0).hover({ position: { x: 7, y: 100 } });
    await expect(sash0).toHaveCSS("opacity", "1", { timeout: 2_000 });
    await expect(sash1).toHaveCSS("opacity", "0");
    // The junction hover lights BOTH sashes (the zone sits above the dividers
    // and wins the hit-test at the crossing).
    await junction.hover();
    await expect(sash0).toHaveCSS("opacity", "1", { timeout: 2_000 });
    await expect(sash1).toHaveCSS("opacity", "1", { timeout: 2_000 });
    // Diagonal drag from the junction: x → pair 0, y → pair 1, each clamped
    // independently. Exact values are viewport-dependent — assert BOTH moved
    // and BOTH persisted on release.
    const value0Before = await divider(page, 0).getAttribute("aria-valuenow");
    const value1Before = await divider(page, 1).getAttribute("aria-valuenow");
    const xtermBefore = await terminal(page).elementHandle();
    const jBox = await junction.boundingBox();
    expect(jBox).not.toBeNull();
    const jcx = jBox!.x + jBox!.width / 2;
    const jcy = jBox!.y + jBox!.height / 2;
    await page.mouse.move(jcx, jcy);
    await page.mouse.down();
    await page.mouse.move(jcx + 40, jcy - 30, { steps: 3 });
    await page.mouse.move(jcx + 80, jcy - 60, { steps: 3 });
    await page.mouse.up();
    await expect
      .poll(async () => divider(page, 0).getAttribute("aria-valuenow"))
      .not.toBe(value0Before);
    await expect
      .poll(async () => divider(page, 1).getAttribute("aria-valuenow"))
      .not.toBe(value1Before);
    const value0Dragged = (await divider(page, 0).getAttribute("aria-valuenow"))!;
    // The terminal stayed MOUNTED (same xterm element) through the drag.
    const xtermAfter = await terminal(page).elementHandle();
    expect(await page.evaluate(([x, y]) => x === y, [xtermBefore, xtermAfter])).toBe(true);
    // Both fraction pairs persisted per (window, structure signature) on
    // release: one array per split in pre-order, each summing to 1, and
    // neither first fraction is the template default (main-left root 0.58,
    // nested equal split 0.5).
    const stored = await page.evaluate(
      (key) => localStorage.getItem(key),
      `rk-layout-sizes:${TMUX_SERVER}:${id}:h(0,v(1,2))`,
    );
    const persisted = JSON.parse(stored ?? "null") as number[][];
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toHaveLength(2);
    expect(persisted[1]).toHaveLength(2);
    expect(persisted[0][0] + persisted[0][1]).toBeCloseTo(1, 6);
    expect(persisted[1][0] + persisted[1][1]).toBeCloseTo(1, 6);
    expect(persisted[0][0]).not.toBeCloseTo(0.58, 2);
    expect(persisted[1][0]).not.toBeCloseTo(0.5, 2);
    // The shared option is untouched by the drag — sizes are per-viewer.
    expect(windowOption(id, "@rk_win_layout")).toBe("h(tty,v(web,code))");
    expectBareUrl(page);

    // Palette `Layout: Promote Code`: code swaps with slot A (tty) — the
    // structure is unchanged, so the dragged sizes (keyed by the structure
    // signature) keep applying: divider 0 still reads the dragged value.
    const promoteInput = await openPalette(page);
    await promoteInput.fill("Layout: Promote Code");
    await page.getByRole("option", { name: /^Layout: Promote Code/ }).click();
    await expectWindowLayout(id, "h(code,v(web,tty))");
    await expect(divider(page, 0)).toHaveAttribute("aria-valuenow", value0Dragged);

    // Palette directional swap: the row set keys off the FOCUSED tile, and
    // the code workbench's one-shot load-time focus grab flips focus to the
    // code tile at whatever moment its frame finishes booting. The grab fires
    // ONCE, so re-assert the tty header click (a sub-threshold press never
    // drags) until the `Tile: Swap Up` row exists, then take it: tty swaps
    // with its geometric neighbour above (web).
    let swapRowFound = false;
    for (let attempt = 0; attempt < 3 && !swapRowFound; attempt++) {
      await tile(page, "tty").click({ position: { x: 6, y: 15 } });
      const swapInput = await openPalette(page);
      await swapInput.fill("Tile: Swap Up");
      const swapRow = page.getByRole("option", { name: /^Tile: Swap Up/ });
      const offered = await swapRow
        .waitFor({ state: "visible", timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
      if (offered) {
        await swapRow.click();
        swapRowFound = true;
      } else {
        await page.keyboard.press("Escape");
      }
    }
    expect(swapRowFound).toBe(true);
    await expectWindowLayout(id, "h(code,v(tty,web))");

    // ✕ Close on the web tile: the leaf drops out and the single-child nested
    // split lifts — h(code,v(tty,web)) → h(code,tty), reading order kept.
    // exact — the strip's per-tab "Close web tab N" button substring-matches
    // "Close Web" now that the strip renders from one tab.
    await tile(page, "web").hover();
    await tile(page, "web").getByRole("button", { name: "Close Web", exact: true }).click();
    await expectWindowLayout(id, "h(code,tty)");
    await expect(tile(page, "web")).toBeHidden();
    await expect(tile(page, "code")).toBeVisible();
    await expect(terminal(page)).toBeVisible();
    // The top-bar toggle reflects the close (web unlit again).
    await expect(webToggle).toHaveAttribute("aria-pressed", "false");

    // — Close-a-column, on the SAME mount: rebuild a column and close its
    // middle tile — the remaining structure is kept (v(code,web), not a
    // horizontal split). The add splits the FOCUSED tile: the ✕ click above
    // focused web and its close reset focus to slot A (code), so re-focus
    // tty (taller than wide at half width — splits vertically) before the
    // re-add: h(code,v(tty,web)); the Column
    // template then rebuilds v(code,tty,web) from the slot order.
    await tile(page, "tty").click({ position: { x: 6, y: 15 } });
    await webToggle.click();
    await expectWindowLayout(id, "h(code,v(tty,web))");
    await expect(tile(page, "web")).toBeVisible({ timeout: 10_000 });
    const paletteInput = await openPalette(page);
    await paletteInput.fill("Layout: Column");
    await page.getByRole("option", { name: /^Layout: Column/ }).click();
    await expectWindowLayout(id, "v(code,tty,web)");
    await tile(page, "tty").hover();
    await tile(page, "tty").getByRole("button", { name: "Close Terminal", exact: true }).click();
    await expectWindowLayout(id, "v(code,web)");
    await expect(tile(page, "tty")).toBeHidden();
    await expect(tile(page, "code")).toBeVisible();
    await expect(tile(page, "web")).toBeVisible();

    // — Header drag (drop to snap), still on the SAME 3-tile mount: re-add
    // tty. The add splits the FOCUSED tile — the Terminal close above reset
    // focus to slot A (code), so focus web first (the full-width bottom row —
    // wider than tall, so the add splits it horizontally): v(code,h(web,tty)).
    const ttyToggle = surfaceToggle(page, "Terminal");
    await tile(page, "web").click({ position: { x: 6, y: 15 } });
    await ttyToggle.click();
    await expectWindowLayout(id, "v(code,h(web,tty))");
    await expect(tile(page, "tty")).toBeVisible({ timeout: 10_000 });

    // Center drop: drag the tty header onto the code tile's center — the
    // overlay previews the swapped result (a `tile-drop-dest` marks tty's
    // destination), and the release commits one option write.
    const codeBox = await tile(page, "code").boundingBox();
    expect(codeBox).not.toBeNull();
    await dragTileHeader(page, "tty", [
      { x: codeBox!.x + codeBox!.width / 2, y: codeBox!.y + codeBox!.height / 2 },
    ], { hold: true });
    await expect(page.getByTestId("tile-drop-overlay")).toBeVisible();
    await expect(page.getByTestId("tile-drop-dest")).toBeVisible();
    await page.mouse.up();
    await expectWindowLayout(id, "v(tty,h(web,code))");

    // Tile-edge drop: drag the tty header into the code tile's RIGHT edge
    // band — tty splits beside code (h(web,code,tty)). 40px in: inside the
    // tile's band (clamp(25%, 28, 110)px) but clear of the layout's own 18px
    // edge band, which would win the hit-test.
    const codeBox2 = await tile(page, "code").boundingBox();
    expect(codeBox2).not.toBeNull();
    await dragTileHeader(page, "tty", [
      { x: codeBox2!.x + codeBox2!.width - 40, y: codeBox2!.y + codeBox2!.height / 2 },
    ]);
    await expectWindowLayout(id, "h(web,code,tty)");

    // Layout-edge drop: drag the tty header into the layout box's outer 18px
    // TOP band — tty spans the top half (v(tty,h(web,code))).
    const gridBox = await page.getByTestId("surface-layout").boundingBox();
    expect(gridBox).not.toBeNull();
    await dragTileHeader(page, "tty", [
      { x: gridBox!.x + gridBox!.width / 2, y: gridBox!.y + 6 },
    ]);
    await expectWindowLayout(id, "v(tty,h(web,code))");
    expectBareUrl(page);

    // Escape cancels: start a drag toward the code tile's center (its box
    // re-read after the repaints), hold, Escape — the overlay disappears and
    // no write lands.
    const codeBox3 = await tile(page, "code").boundingBox();
    expect(codeBox3).not.toBeNull();
    await dragTileHeader(page, "tty", [
      { x: codeBox3!.x + codeBox3!.width / 2, y: codeBox3!.y + codeBox3!.height / 2 },
    ], { hold: true });
    await expect(page.getByTestId("tile-drop-overlay")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tile-drop-overlay")).toHaveCount(0);
    await page.mouse.up();
    await page.waitForTimeout(500);
    expect(windowOption(id, "@rk_win_layout")).toBe("v(tty,h(web,code))");
    expectBareUrl(page);
  });

  /**
   * Proves: the two verb families — the tty tile's bordered pane segment
   * (content verbs: Split pane horizontally / Split pane vertically / Close
   * pane, the last carrying the boxed ⊠ `close-pane-boxed` glyph) renders
   * at arity 1 (a lone `tty` leaf, where zero LAYOUT verbs render), stays
   * tty-only at arity 2 (the web tile's header has none), and remains
   * visible while the tile is zoomed (✕/⛶ stay) — while the
   * terminal-mode top bar carries NO in-bar split chip (the `split`
   * registry entry is `menuOnly`) and the chevron menu always carries the
   * Split horizontal / Split vertical / Close pane rows. Stays within the
   * ≤2-tile perf budget.
   *
   * Steps:
   * 1. Create a web-capable window; navigate (a lone tty leaf); assert
   *    the terminal.
   * 2. Assert the tty tile's `pane-segment` testid is visible with the
   *    three content-verb buttons; assert the Close pane button carries the
   *    `close-pane-boxed` glyph and NO `Expand Terminal` layout verb
   *    renders.
   * 3. Assert the top bar (banner) has NO `Split horizontally` button; open
   *    the `More controls` chevron menu and assert the Split horizontal /
   *    Split vertical / Close pane rows are visible; Escape-close it.
   * 4. Open the web tile via the top-bar toggle; assert the option reads
   *    `h(tty,web)`, the segment still visible on the tty
   *    tile, and NO `pane-segment` on the web tile.
   * 5. Click the tty tile's `Expand Terminal` verb; assert the segment
   *    stays visible while zoomed and `Close Terminal` stays.
   */
  test("the tty header carries the pane segment at any arity (visible while zoomed); the terminal bar dropped its split chip (260813-w1lf)", async ({
    page,
  }) => {
    test.setTimeout(40_000);
    const id = await makeWindow(page, `sl-paneverbs-${Date.now()}`, { url: IFRAME_URL });
    await gotoWindow(page, id);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    const bar = page.getByRole("banner");

    // Arity 1 (a lone tty leaf — a header that renders zero LAYOUT verbs):
    // the bordered pane segment is right there with its three content verbs.
    const segment = tile(page, "tty").getByTestId("pane-segment");
    await expect(segment).toBeVisible();
    await expect(segment.getByRole("button", { name: "Split pane horizontally" })).toBeVisible();
    await expect(segment.getByRole("button", { name: "Split pane vertically" })).toBeVisible();
    const closePane = segment.getByRole("button", { name: "Close pane" });
    await expect(closePane).toBeVisible();
    // The boxed ⊠ glyph — the misclick-trap distinction from the tile-close ✕.
    await expect(closePane.locator('[data-icon="close-pane-boxed"]')).toBeVisible();
    await expect(tile(page, "tty").getByRole("button", { name: "Expand Terminal" })).toHaveCount(0);

    // The terminal-mode bar carries NO in-bar split chip (menuOnly, 260813-w1lf);
    // the chevron menu keeps the Split horizontal / Split vertical / Close pane
    // rows (mobile path + muscle-memory fallback).
    await expect(bar.getByRole("button", { name: "Split horizontally" })).toHaveCount(0);
    await bar.getByRole("button", { name: "More controls" }).click();
    const menu = page.getByRole("menu", { name: "More controls" });
    await expect(menu.getByRole("menuitem", { name: "Split horizontal" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Split vertical" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Close pane" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    // Arity 2 (h(tty,web) — within the ≤2-tile perf budget): the segment
    // stays tty-only — the web tile's header carries layout verbs, no segment.
    const webToggle = surfaceToggle(page, "Web");
    await expect(webToggle).toBeVisible({ timeout: READY_TIMEOUT });
    await webToggle.click();
    await expect(tile(page, "web")).toBeVisible({ timeout: 10_000 });
    await expectWindowLayout(id, "h(tty,web)");
    await expect(segment).toBeVisible();
    await expect(tile(page, "web").getByTestId("pane-segment")).toHaveCount(0);

    // Zoomed: the pane segment remains visible (pane ops stay valid on a
    // zoomed tile); ✕/⛶ stay, as today.
    await page.getByRole("button", { name: "Expand Terminal", exact: true }).click();
    await expect(tile(page, "web")).toBeHidden({ timeout: 10_000 });
    await expect(segment).toBeVisible();
    await expect(
      tile(page, "tty").getByRole("button", { name: "Close Terminal" }),
    ).toBeVisible();
  });

  /**
   * Proves: a top-bar toggle POSTs the shared `@rk_win_layout` option, and a
   * FULL load of the bare route re-renders the same tile set — persistence
   * comes from tmux, not the browser; the URL stays bare throughout.
   *
   * Steps:
   * 1. Create a web-capable window; navigate; open the web tile via the
   *    top-bar toggle.
   * 2. Assert the option reads `h(tty,web)`, the web tile visible, and
   *    the URL bare.
   * 3. `page.goto` the BARE window route (a real reload, no search string).
   * 4. Assert the web tile and terminal render again and the URL is still
   *    bare.
   */
  test("a user-built layout persists in tmux across a bare-route reload", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    const id = await makeWindow(page, `sl-persist-${Date.now()}`, { url: IFRAME_URL });
    await gotoWindow(page, id);

    // A user mutation (top-bar toggle) POSTs the shared option.
    const webToggle = surfaceToggle(page, "Web");
    await expect(webToggle).toBeVisible({ timeout: READY_TIMEOUT });
    await webToggle.click();
    await expectWindowLayout(id, "h(tty,web)");
    await expect(tile(page, "web")).toBeVisible({ timeout: 10_000 });
    expectBareUrl(page);

    // Re-arrive via a FULL load of the BARE route — the option supplies the
    // layout (no localStorage, no URL state).
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}`);
    await expect(page.locator("[aria-label='Connected']")).toBeVisible({
      timeout: READY_TIMEOUT,
    });
    await expect(tile(page, "web")).toBeVisible({ timeout: 10_000 });
    await expect(terminal(page)).toBeVisible();
    expectBareUrl(page);
  });

  /**
   * Proves: internal navigation (sidebar) targets the bare route, so each
   * window renders its own `@rk_win_layout`: B (never customized) renders
   * the single-tty fallback, while A renders its option's `h(tty,web)`. The
   * A→B hop is a REAL client-side navigation (sidebar row click), not a
   * `page.goto`, and the URL stays bare throughout.
   *
   * Steps:
   * 1. Create window A (web-capable) and window B (plain).
   * 2. On A, open the web tile via the top-bar toggle; assert the option
   *    reads `h(tty,web)`.
   * 3. Click B's row in the `Sessions` sidebar; assert selection settles on
   *    B (`aria-current="page"`), no web tile exists, and the URL is bare.
   * 4. Click A's row; assert the web tile renders again and the URL stays
   *    bare.
   */
  test("window switch A→B→A renders each window's own shared layout", async ({ page }) => {
    test.setTimeout(40_000);
    const a = await makeWindow(page, `sl-switch-a-${Date.now()}`, { url: IFRAME_URL });
    const b = await makeWindow(page, `sl-switch-b-${Date.now()}`);

    // On A, build h(tty,web) (a user mutation → @rk_win_layout write).
    await gotoWindow(page, a);
    const webToggle = surfaceToggle(page, "Web");
    await expect(webToggle).toBeVisible({ timeout: READY_TIMEOUT });
    await webToggle.click();
    await expectWindowLayout(a, "h(tty,web)");
    await expect(tile(page, "web")).toBeVisible({ timeout: 10_000 });

    // Switch to B via a REAL client-side navigation (sidebar row click) —
    // internal nav targets the BARE route; B renders its own (unset) layout:
    // the single-tty fallback.
    const sidebar = page.locator("nav[aria-label='Sessions']");
    const rowB = sidebar.locator(`[data-window-id="${b}"]`).getByRole("button").first();
    await expect(rowB).toBeVisible({ timeout: 10_000 });
    await rowB.click();
    await expect(rowB).toHaveAttribute("aria-current", "page", { timeout: 10_000 });
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    await expect(tile(page, "web")).toHaveCount(0);
    expectBareUrl(page);

    // Back to A via the sidebar (bare route again) — A's option renders
    // again.
    const rowA = sidebar.locator(`[data-window-id="${a}"]`).getByRole("button").first();
    await rowA.click();
    await expect(rowA).toHaveAttribute("aria-current", "page", { timeout: 10_000 });
    await expect(tile(page, "web")).toBeVisible({ timeout: 10_000 });
    expectBareUrl(page);
  });

  /**
   * Proves: every history entry is a BARE route — layout mutations never
   * touch the URL (the shared option changed), and window switches push, so
   * back/forward re-render each window's CURRENT shared layout (A's
   * `h(tty,web)` — a mutation mid-session is shared state, not a URL
   * snapshot), and backing past the window lands on the pre-window route
   * with no stale entry in between.
   *
   * Steps:
   * 1. Create windows A (web-capable) and B (plain).
   * 2. Navigate to the server route (history entry E0), then to A (E1).
   * 3. Open the web tile on A via the top-bar toggle; assert the option
   *    reads `h(tty,web)` and the URL stays bare.
   * 4. Sidebar-click B (push E2); assert B renders the single-tty fallback
   *    (its option is unset) and the URL stays bare.
   * 5. `goBack` → A renders `h(tty,web)` again (its shared layout).
   * 6. `goForward` → B's fallback renders.
   * 7. `goBack` twice → the SECOND back lands on the bare server route
   *    (`/<server>`, E0) — no per-mutation entries exist to strand.
   */
  test("back/forward re-render the shared layout; layout tweaks add NO history entries", async ({
    page,
  }) => {
    test.setTimeout(40_000);
    const a = await makeWindow(page, `sl-hist-a-${Date.now()}`, { url: IFRAME_URL });
    const b = await makeWindow(page, `sl-hist-b-${Date.now()}`);

    // History: [E0 server route] → [E1 window A] → (top-bar toggle: an option
    // POST, E1 untouched — the URL never carries layout state) → [E2 window B
    // via sidebar push].
    await page.goto(`/${TMUX_SERVER}`);
    await expect(page.locator("[aria-label='Connected']")).toBeVisible({
      timeout: READY_TIMEOUT,
    });
    await gotoWindow(page, a);
    const webToggle = surfaceToggle(page, "Web");
    await expect(webToggle).toBeVisible({ timeout: READY_TIMEOUT });
    await webToggle.click();
    await expectWindowLayout(a, "h(tty,web)");
    expectBareUrl(page);

    const sidebar = page.locator("nav[aria-label='Sessions']");
    const rowB = sidebar.locator(`[data-window-id="${b}"]`).getByRole("button").first();
    await expect(rowB).toBeVisible({ timeout: 10_000 });
    await rowB.click();
    await expect(rowB).toHaveAttribute("aria-current", "page", { timeout: 10_000 });
    expectBareUrl(page);

    // Back → A's shared layout renders again.
    await page.goBack();
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    await expect(tile(page, "web")).toBeVisible({ timeout: 10_000 });
    expectBareUrl(page);

    // Forward → B's fallback (single tty leaf) renders.
    await page.goForward();
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    await expect(tile(page, "web")).toHaveCount(0);
    expectBareUrl(page);

    // Back twice more: past A, straight to the E0 server route — a mutation
    // never adds a history entry.
    await page.goBack();
    await expect(tile(page, "web")).toBeVisible({ timeout: 10_000 });
    await page.goBack();
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 10_000 })
      .toBe(`/${TMUX_SERVER}`);
  });

  /**
   * Proves: divider drags mutate SIZES only — clamped, persisted per
   * (window, structure signature) on release under `rk-layout-sizes:*` (a
   * JSON array of per-split fraction arrays), and never encoded in the URL;
   * tiles stay mounted and live mid-drag (no suspension/unmount). Also the
   * gap-seam sash states: rest shows 3 grip dots and no fill, hover lights
   * the sash pill after the ~150ms delay, and the sash stays lit through
   * the drag.
   *
   * Steps:
   * 1. Create a web-capable window; navigate; open the web tile via the
   *    top-bar toggle.
   * 2. Assert the `surface-divider-0` separator reads `aria-valuenow=50`
   *    (equal split) and capture the xterm element handle.
   * 3. Sash states: assert the divider carries 3 `.rk-grips i` dots and its
   *    `.rk-sash` is at opacity 0; hover the divider and assert the sash
   *    reaches opacity 1 (retrying — the ~150ms anti-flicker delay plus
   *    fade).
   * 4. Drag the divider 150px right (mouse down/move/up in steps), asserting
   *    the sash is still lit mid-drag.
   * 5. Assert `aria-valuenow` grew past 50, the terminal is the SAME element
   *    (still mounted, still visible), the shared option is unchanged, and
   *    the stored value is one fraction pair summing to 1 with the first
   *    fraction past 0.5.
   * 6. Re-arrive via a full load of the bare route; assert the web tile
   *    renders and the divider reads exactly the dragged value (sizes
   *    persisted per window+structure).
   */
  test("a divider drag persists the sizes across reload and never touches the URL", async ({
    page,
  }) => {
    test.setTimeout(40_000);
    const id = await makeWindow(page, `sl-sizes-${Date.now()}`, { url: IFRAME_URL });
    await gotoWindow(page, id);
    const webToggle = surfaceToggle(page, "Web");
    await expect(webToggle).toBeVisible({ timeout: READY_TIMEOUT });
    await webToggle.click();
    await expect(tile(page, "web")).toBeVisible({ timeout: 10_000 });

    // The h(tty,web) divider starts at the equal split (50).
    const div = divider(page, 0);
    await expect(div).toHaveAttribute("aria-valuenow", "50");
    const box = await div.boundingBox();
    expect(box).not.toBeNull();

    // Gap-seam sash states: at rest the seam shows 3 grip
    // dots and NO sash fill; hover lights the rounded pill after the ~150ms
    // anti-flicker delay.
    await expect(div.locator(".rk-grips i")).toHaveCount(3);
    const sash = div.locator(".rk-sash");
    await expect(sash).toHaveCSS("opacity", "0");
    await div.hover();
    await expect(sash).toHaveCSS("opacity", "1", { timeout: 2_000 });

    // Drag 150px RIGHT — the first sibling's share grows. Tiles stay live
    // mid-drag (no suspension/unmount — the board pane-resize bug class). The
    // sash stays lit for the whole drag (immediate, zero delay).
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;
    const xtermBefore = await terminal(page).elementHandle();
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 75, startY, { steps: 3 });
    await expect(sash).toHaveCSS("opacity", "1");
    await page.mouse.move(startX + 150, startY, { steps: 3 });
    await page.mouse.up();

    let dragged: number | null = null;
    await expect
      .poll(async () => {
        dragged = Number(await div.getAttribute("aria-valuenow"));
        return dragged;
      })
      .toBeGreaterThan(50);
    // The terminal stayed MOUNTED (same xterm element) through the drag.
    const xtermAfter = await terminal(page).elementHandle();
    expect(await page.evaluate(([x, y]) => x === y, [xtermBefore, xtermAfter])).toBe(true);
    // Sizes are per-viewer local state — the shared option is untouched by
    // a drag, and the URL never carries layout state.
    expect(windowOption(id, "@rk_win_layout")).toBe("h(tty,web)");
    expectBareUrl(page);
    // Persisted under the structure-signature key as one fraction array per
    // split (pre-order): h(tty,web) has one split, so [[f, 1−f]] with f > ½.
    const storedSizes = await page.evaluate(
      (key) => localStorage.getItem(key),
      `rk-layout-sizes:${TMUX_SERVER}:${id}:h(0,1)`,
    );
    const parsed = JSON.parse(storedSizes ?? "null") as number[][];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toHaveLength(2);
    expect(parsed[0][0] + parsed[0][1]).toBeCloseTo(1, 6);
    expect(parsed[0][0]).toBeGreaterThan(0.5);

    // The sizes persist per (window, structure): a bare reload resolves the
    // same layout AND the dragged divider position.
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}`);
    await expect(page.locator("[aria-label='Connected']")).toBeVisible({
      timeout: READY_TIMEOUT,
    });
    await expect(tile(page, "web")).toBeVisible({ timeout: 10_000 });
    await expect(divider(page, 0)).toHaveAttribute("aria-valuenow", String(dragged), {
      timeout: 10_000,
    });
  });

  /**
   * Proves: the `layout-zoom` default binding is REMOVED (Ctrl+` collides
   * with code-server's own toggle-terminal chord), so the chord falls
   * through untouched even with xterm focused; the zoom action itself
   * survives via the tile's ⛶ verb (the same seam as the palette's
   * `Layout: Expand`/`Restore`) and stays PER-VIEWER (the zoomed KIND under
   * `rk-layout-zoom:{server}:{@N}` — the shared option and the URL are
   * untouched).
   *
   * Steps:
   * 1. Create a web-capable window; navigate; open the web tile via the
   *    top-bar toggle; assert the option reads `h(tty,web)`.
   * 2. Click the terminal (xterm focus), then press `Control+``; after a
   *    500ms grace beat assert BOTH tiles and the divider are still visible
   *    (no zoom).
   * 3. Click the tty tile's `Expand Terminal` verb; assert the web tile
   *    hides at display level (still mounted — count 1), the divider is
   *    gone, the terminal stays visible, the option and URL are untouched,
   *    and the zoom key holds `tty`.
   * 4. Click the now-`Restore Terminal` verb; assert the web tile and the
   *    divider return and the zoom key is cleared.
   */
  test("Ctrl+` is inert (binding removed, 260813-j3jb); the ⛶ verb toggles the slot-A zoom", async ({
    page,
  }) => {
    test.setTimeout(40_000);
    const id = await makeWindow(page, `sl-zoom-${Date.now()}`, { url: IFRAME_URL });
    await gotoWindow(page, id);
    const webToggle = surfaceToggle(page, "Web");
    await expect(webToggle).toBeVisible({ timeout: READY_TIMEOUT });
    await webToggle.click();
    await expect(tile(page, "web")).toBeVisible({ timeout: 10_000 });
    await expectWindowLayout(id, "h(tty,web)");

    // The Ctrl+` layout-zoom binding is REMOVED (it collides with code-server's
    // own Ctrl+`): the chord must fall through untouched — no zoom, both tiles
    // stay. Focus the terminal first, the spot the old chord interception won.
    await terminal(page).click();
    await page.keyboard.press("Control+`");
    await page.waitForTimeout(500);
    await expect(tile(page, "web")).toBeVisible();
    await expect(divider(page, 0)).toBeVisible();

    // Zoom still works through the tile's ⛶ verb: slot A (tty) goes
    // full-center — the web tile hides (display-level, still mounted) and the
    // divider leaves.
    await page.getByRole("button", { name: "Expand Terminal", exact: true }).click();
    await expect(tile(page, "web")).toBeHidden({ timeout: 10_000 });
    await expect(tile(page, "web")).toHaveCount(1);
    await expect(divider(page, 0)).toHaveCount(0);
    await expect(terminal(page)).toBeVisible();
    // Zoom is per-viewer (spec ui-state.md): the shared option and the URL
    // are untouched; the zoomed KIND lands in the viewer's zoom key.
    expect(windowOption(id, "@rk_win_layout")).toBe("h(tty,web)");
    expectBareUrl(page);
    expect(
      await page.evaluate(
        (key) => localStorage.getItem(key),
        `rk-layout-zoom:${TMUX_SERVER}:${id}`,
      ),
    ).toBe("tty");

    // Restore via the same verb (now labeled Restore) — both tiles and the
    // divider return, and the zoom key clears.
    await page.getByRole("button", { name: "Restore Terminal", exact: true }).click();
    await expect(tile(page, "web")).toBeVisible({ timeout: 10_000 });
    await expect(divider(page, 0)).toBeVisible();
    expect(
      await page.evaluate(
        (key) => localStorage.getItem(key),
        `rk-layout-zoom:${TMUX_SERVER}:${id}`,
      ),
    ).toBeNull();
  });

  // The ▦ Surfaces chip lives in the bottom bar, which 260814-ldbs
  // pointer-gated to COARSE pointers — a real phone is coarse AND narrow, so
  // this mobile test runs with `hasTouch` (a viewport-only emulation would get
  // no chip bar by design).
  test.describe("mobile (375px, coarse pointer)", () => {
    test.use({ hasTouch: true });

    /**
     * Proves: below `isMobileViewport()` the layout manager renders only
     * the active tile — no grid, no dividers — and the remaining resolved
     * surfaces are reachable via the top-bar switch group (radio semantics:
     * the visible tile pressed), whose tap on an ALREADY-OPEN surface is
     * PER-VIEWER (only the zoom key changes — the shared option, and so the
     * desktop arrangement, never does). The nested describe runs
     * `test.use({ hasTouch: true })` so `(pointer: coarse)` matches — a
     * real phone is coarse AND narrow, and the bottom bar is pointer-gated,
     * so a fine-pointer narrow window would exercise a different bar by
     * design.
     *
     * Steps:
     * 1. Set the 375×812 viewport (context already has `hasTouch`); create
     *    a web-capable window.
     * 2. Navigate to `?layout=main-left:tty,code,web` (a LEGACY-grammar
     *    inbound param — it parses permanently; the translation writes the
     *    option in the tree form), gating on the terminal (not the
     *    `Connected` dot — it lives in the desktop-only status bar; the
     *    sidebar is an unmounted drawer at 375px anyway).
     * 3. Assert the option reads `h(tty,v(code,web))`, the tty tile is
     *    visible, the code/web tiles are mounted-hidden, no divider exists
     *    (and no `surface-divider-intersection` — the gap-seam chrome is
     *    desktop-only), the banner's `Terminal tile` / `Code tile` /
     *    `Web tile` buttons render with Terminal `aria-pressed=true`, and
     *    no `mobile-surfaces-chip` exists in the DOM.
     * 4. Click the `Code tile` button; assert the code tile becomes visible
     *    (tty hidden), the pressed state flips (Code pressed, Terminal
     *    not), the zoom key holds `code`, and the option still reads
     *    `h(tty,v(code,web))` — the tap sent NO layout write.
     */
    test("375px mobile: a 3-tile layout renders slot A + the top-bar switch group; switching an open tile writes only the zoom key", async ({
      page,
    }) => {
      test.setTimeout(30_000);
      await page.setViewportSize(MOBILE_VIEWPORT);
      const id = await makeWindow(page, `sl-mobile-${Date.now()}`, { url: IFRAME_URL });
      // Do NOT gate on the `Connected` dot: it lives in the desktop-only status
      // bar now (the sidebar footer is gone; at 375px the sidebar is an
      // unmounted drawer anyway). Gate on the terminal.
      await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(id)}?layout=main-left:tty,code,web`);
      await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
      await expectWindowLayout(id, "h(tty,v(code,web))");

      // Slot A (tty) renders full-width; the other resolved surfaces stay
      // mounted-hidden (no multi-tile grid, no dividers below the threshold).
      await expect(tile(page, "tty")).toBeVisible();
      await expect(tile(page, "code")).toBeHidden();
      await expect(tile(page, "web")).toBeHidden();
      await expect(divider(page, 0)).toHaveCount(0);
      // Gap-seam chrome is desktop-only (260814-011r R5): no intersection zone.
      await expect(page.getByTestId("surface-divider-intersection")).toHaveCount(0);
      // The top-bar switch group renders with RADIO semantics: one button per
      // shown surface, the VISIBLE one (slot A) pressed. The retired ▦
      // Surfaces chip is gone.
      const banner = page.getByRole("banner");
      const ttyToggle = banner.getByRole("button", { name: "Terminal tile", exact: true });
      const codeToggle = banner.getByRole("button", { name: "Code tile", exact: true });
      const webToggle = banner.getByRole("button", { name: "Web tile", exact: true });
      // READY_TIMEOUT: on a cold deep link the multi-surface layout (and so the
      // group) resolves only once the window payload lands with webTabs/gitRoot.
      await expect(webToggle).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(ttyToggle).toHaveAttribute("aria-pressed", "true");
      await expect(codeToggle).toHaveAttribute("aria-pressed", "false");
      await expect(page.getByTestId("mobile-surfaces-chip")).toHaveCount(0);

      // Tapping the Code button swaps the mobile single tile — PER-VIEWER:
      // the shared option (and so every desktop viewer's arrangement) is
      // untouched; only this viewer's zoom key changes.
      await codeToggle.click();
      await expect(tile(page, "code")).toBeVisible({ timeout: 10_000 });
      await expect(tile(page, "tty")).toBeHidden();
      await expect(codeToggle).toHaveAttribute("aria-pressed", "true");
      await expect(ttyToggle).toHaveAttribute("aria-pressed", "false");
      expect(
        await page.evaluate(
          (key) => localStorage.getItem(key),
          `rk-layout-zoom:${TMUX_SERVER}:${id}`,
        ),
      ).toBe("code");
      expect(windowOption(id, "@rk_win_layout")).toBe("h(tty,v(code,web))");
      expectBareUrl(page);
    });
  });

  /**
   * Proves: in the resting desktop state (fine pointer, compose strip
   * closed — the bottombar row is empty) the sidebar card and the content
   * column share one bottom edge, exactly 6px (the stage padding) above the
   * status bar. Guards the row-gap regression class: grid gaps charge
   * between tracks even at zero track height, so a stage row-gap would sink
   * the content column 6px below the row-spanning sidebar; the seam is
   * footer-owned and content-gated (`:has(>*)`) instead.
   *
   * Steps:
   * 1. Create a fresh window; navigate to its terminal route; wait for the
   *    Connected gate and the terminal tile.
   * 2. Measure bounding boxes of the sidebar `<aside>`, the `status-bar`
   *    testid, and the tty tile.
   * 3. Assert sidebar bottom == tile bottom (±1px) and status-bar top −
   *    sidebar bottom == 6px (±1px).
   */
  test("stage bottom-edge parity: sidebar card and content column both end 6px above the status bar", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    // Resting desktop state (fine pointer, compose strip closed): the
    // bottombar row is empty, so the content column's bottom edge must land
    // flush with the row-spanning sidebar card's — both exactly 6px (the
    // stage padding) above the status bar. A stage row-gap would charge the
    // content column an extra 6px even at zero row height (grid gaps apply
    // between tracks regardless of track size), which is the regression this
    // guards against.
    const id = await makeWindow(page, `sl-parity-${Date.now()}`);
    await gotoWindow(page, id);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });

    const sidebar = await page.locator("aside[aria-label='Sidebar']").boundingBox();
    const statusBar = await page.getByTestId("status-bar").boundingBox();
    const ttyTile = await tile(page, "tty").boundingBox();
    expect(sidebar).not.toBeNull();
    expect(statusBar).not.toBeNull();
    expect(ttyTile).not.toBeNull();

    const sidebarBottom = sidebar!.y + sidebar!.height;
    const tileBottom = ttyTile!.y + ttyTile!.height;
    expect(Math.abs(sidebarBottom - tileBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(statusBar!.y - sidebarBottom - 6)).toBeLessThanOrEqual(1);
  });

  /**
   * Proves: the focused-tile state — the framed tile border turns
   * `border-accent-green` on the tile that last received pointer
   * interaction (the tmux active-pane metaphor), defaults to slot A, and
   * moves with each click. Unfocused tiles carry the dimmed gap-seam
   * `rk-card-border`.
   *
   * Steps:
   * 1. Create a web-capable window; navigate; open the web tile via the
   *    top-bar toggle.
   * 2. Assert the tty tile (slot A) carries `border-accent-green` and the
   *    web tile the dimmed `rk-card-border`.
   * 3. Click the web tile's header (`{x: 6, y: 15}`); assert the accent
   *    border moved to the web tile and left the tty tile.
   * 4. Click the tty tile's header; assert the border returned.
   */
  test("the focused-tile accent border follows clicks across tiles (260812-wfic R2, A-013)", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    const id = await makeWindow(page, `sl-focus-${Date.now()}`, { url: IFRAME_URL });
    await gotoWindow(page, id);
    const webToggle = surfaceToggle(page, "Web");
    await expect(webToggle).toBeVisible({ timeout: READY_TIMEOUT });
    await webToggle.click();
    await expect(tile(page, "web")).toBeVisible({ timeout: 10_000 });

    // Default focus = slot A (tty): its framed border reads accent-green, the
    // web tile's stays the dimmed gap-seam card border (rk-card-border,
    // 260814-011r R1).
    await expect(tile(page, "tty")).toHaveClass(/border-accent-green/);
    await expect(tile(page, "web")).toHaveClass(/rk-card-border/);

    // Click the web tile (its header — the focus seam is pointerdown-capture
    // anywhere in the tile) → the accent border moves.
    await tile(page, "web").click({ position: { x: 6, y: 15 } });
    await expect(tile(page, "web")).toHaveClass(/border-accent-green/);
    await expect(tile(page, "tty")).not.toHaveClass(/border-accent-green/);

    // Click back into the tty tile → the border returns.
    await tile(page, "tty").click({ position: { x: 6, y: 15 } });
    await expect(tile(page, "tty")).toHaveClass(/border-accent-green/);
    await expect(tile(page, "web")).not.toHaveClass(/border-accent-green/);
  });

  /**
   * Proves: the `ttyOnly` dispatcher gate — a `ttyOnly` binding's handler
   * is absent unless the tty tile owns focus, so the split chord (⇧Ctrl+\
   * on this Linux host) falls through untouched (no `preventDefault`, no
   * split POST) while the code tile is focused, and splits exactly as
   * before while the tty tile is focused. Ground truth is the live tmux
   * pane count, not the DOM.
   *
   * Steps:
   * 1. Create a plain (code-capable) window; navigate; assert the terminal.
   * 2. Open the code tile via the top-bar toggle; assert the tile renders.
   *    Pane count = 1.
   * 3. Click the code tile's header; assert its `border-accent-green` (the
   *    gate's input is visibly engaged).
   * 4. Press `Shift+Control+Backslash`; wait a beat; assert the pane count
   *    is UNCHANGED (the chord fell through — code-server would own it on a
   *    real reachable code-server).
   * 5. Click the tty tile's header; assert its `border-accent-green`.
   * 6. Press `Shift+Control+Backslash` again; assert the pane count grows
   *    to 2 (retrying — the split POST + tmux mutation land asynchronously).
   */
  test("the split chord is tty-scoped: inert with the code tile focused, splits with tty focused (260812-wfic R8, A-014)", async ({
    page,
  }) => {
    test.setTimeout(40_000);
    const id = await makeWindow(page, `sl-ttyonly-${Date.now()}`);
    await gotoWindow(page, id);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });

    // Open the code tile (every window here is code-capable — repo-root cwd).
    const codeToggle = surfaceToggle(page, "Code");
    await expect(codeToggle).toBeVisible({ timeout: READY_TIMEOUT });
    await codeToggle.click();
    await expect(tile(page, "code")).toBeVisible({ timeout: 10_000 });

    const before = paneCount(id);
    expect(before).toBe(1);

    // Focus the CODE tile (header click) — the accent border confirms the
    // gate's input. The split chord (⇧Ctrl+\ on this Linux host) must fall
    // through untouched: NO split, pane count unchanged.
    await tile(page, "code").click({ position: { x: 6, y: 15 } });
    await expect(tile(page, "code")).toHaveClass(/border-accent-green/);
    await page.keyboard.press("Shift+Control+Backslash");
    // Give a would-be split a beat to land — then assert nothing happened.
    await page.waitForTimeout(750);
    expect(paneCount(id)).toBe(before);

    // Focus the tty tile — the SAME chord splits exactly as today (the
    // tty-focused path is byte-equivalent to the pre-gate behavior).
    await tile(page, "tty").click({ position: { x: 6, y: 15 } });
    await expect(tile(page, "tty")).toHaveClass(/border-accent-green/);
    await page.keyboard.press("Shift+Control+Backslash");
    await expect
      .poll(() => paneCount(id), { timeout: 10_000 })
      .toBe(before + 1);
  });

  /**
   * Proves: the layout is SHARED tab state — a tile toggle in one browser
   * context repaints a SECOND, already-mounted context with no interaction
   * on it (the options handler wakes the SSE hub, so the tick lands within
   * the poll bound).
   *
   * Steps:
   * 1. Create a web-capable window; open it in context A (the default page)
   *    and in a second browser context B; assert both render the single-tty
   *    fallback.
   * 2. In A, click the `Web tile` toggle; assert the option reads
   *    `h(tty,web)` and A's web tile appears.
   * 3. Assert B's web tile appears with NO interaction on B; close B.
   */
  test("two viewers of one window converge: a toggle in context A repaints context B", async ({
    page,
    browser,
  }) => {
    test.setTimeout(40_000);
    const id = await makeWindow(page, `sl-shared-${Date.now()}`, { url: IFRAME_URL });
    const ctxB = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
    const pageB = await ctxB.newPage();
    await stubProxyPorts(pageB, DEAD.port);
    try {
      await gotoWindow(page, id);
      await gotoWindow(pageB, id);
      await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
      await expect(terminal(pageB)).toBeVisible({ timeout: 10_000 });
      await expect(tile(pageB, "web")).toHaveCount(0);

      // A toggles the web tile on; B never touches anything.
      const webToggle = surfaceToggle(page, "Web");
      await expect(webToggle).toBeVisible({ timeout: READY_TIMEOUT });
      await webToggle.click();
      await expectWindowLayout(id, "h(tty,web)");
      await expect(tile(page, "web")).toBeVisible({ timeout: 10_000 });

      // B repaints on the option tick — no interaction, no reload.
      await expect(tile(pageB, "web")).toBeVisible({ timeout: 10_000 });
    } finally {
      await ctxB.close();
    }
  });

  /**
   * Proves: zoom is PER-VIEWER — zooming the tty tile in context A writes
   * only A's `rk-layout-zoom:` key; context B keeps both tiles unzoomed,
   * and B has no zoom key of its own.
   *
   * Steps:
   * 1. Create a web-capable window with `h(tty,web)` stamped via tmux (the
   *    tree form — an external writer); open it in context A and in a second
   *    context B; assert both render both tiles.
   * 2. In A, click the tty tile's `Expand Terminal` verb; assert A's web
   *    tile hides (display-level, still mounted) and A's zoom key holds
   *    `tty`.
   * 3. Assert B's web tile stays VISIBLE (unzoomed) and B's zoom key is
   *    absent; the shared option is unchanged.
   */
  test("zoom in context A does not zoom context B (per-viewer zoom key)", async ({
    page,
    browser,
  }) => {
    test.setTimeout(40_000);
    const id = await makeWindow(page, `sl-zoomiso-${Date.now()}`, { url: IFRAME_URL });
    execFileSync("tmux", ["-L", TMUX_SERVER, "set-option", "-w", "-t", id, "@rk_win_layout", "h(tty,web)"]);
    const ctxB = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
    const pageB = await ctxB.newPage();
    await stubProxyPorts(pageB, DEAD.port);
    try {
      await gotoWindow(page, id);
      await gotoWindow(pageB, id);
      await expect(tile(page, "web")).toBeVisible({ timeout: 10_000 });
      await expect(tile(pageB, "web")).toBeVisible({ timeout: 10_000 });

      // A zooms the tty tile (the ⛶ verb) — a per-viewer posture.
      await page.getByRole("button", { name: "Expand Terminal", exact: true }).click();
      await expect(tile(page, "web")).toBeHidden({ timeout: 10_000 });
      expect(
        await page.evaluate(
          (key) => localStorage.getItem(key),
          `rk-layout-zoom:${TMUX_SERVER}:${id}`,
        ),
      ).toBe("tty");

      // B is untouched: both tiles stay visible and B holds no zoom key.
      // (A settle beat so a would-be repaint could land first.)
      await pageB.waitForTimeout(500);
      await expect(tile(pageB, "web")).toBeVisible();
      expect(
        await pageB.evaluate(
          (key) => localStorage.getItem(key),
          `rk-layout-zoom:${TMUX_SERVER}:${id}`,
        ),
      ).toBeNull();
      expect(windowOption(id, "@rk_win_layout")).toBe("h(tty,web)");
    } finally {
      await ctxB.close();
    }
  });
});
