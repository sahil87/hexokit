import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODE_BOOT_RESCUE_RECHECK_MS, CODE_BOOT_RESCUE_WAIT_MS } from "../../src/lib/code-boot-rescue";
import { plainCodeStubHtml, focusGrabCodeStubHtml, reserveDeadPort, startCodeStub, type CodeStub, type DeadPort } from "./_ports";
import { openPalette, READY_TIMEOUT, expectActiveElement, resolveWindow as resolveWindowRaw, switchToWindow } from "./_ready";
import {
  TMUX_SERVER,
  createSession,
  killSession,
  newWindow,
  stampWebTab,
  windowOption,
} from "./_tmux";
import { stubProxyPorts } from "./_web-tile";

/**
 * The code surface end to end (`docs/specs/right-panel.md` § The code lens +
 * § Surface Registry; `docs/specs/surface-layout.md`): the `code` lens joins
 * the view registry through the palette's `View: Code` action and the
 * tileable code surface (`Code tile` top-bar toggle —
 * the right rail is REMOVED, its toggles moved into the top bar's
 * `surface-toggles` group; `?panel=code` → the tree form `h(tty,code)` via
 * the same translation), with availability =
 * gitRoot derived (the port resolves by convention — `RK_CODE_SERVER_PORT`
 * preset, else `RK_PORT+2` — and no longer gates), and code-server
 * reachability governing only the surface CONTENT (live iframe vs the
 * not-running empty state). The iframe mounts at the tab-keyed
 * `/code/?workspace=<path>` URL — `<path>` comes from the test's own
 * `GET /api/windows/<id>/code-workspace` call (the harness's per-run
 * XDG_STATE_HOME makes the absolute path run-specific, so it is never
 * hardcoded) — and the terse `code-surface-pending` state precedes the
 * iframe on first open. Also covers the `/code` → `/code/` redirect.
 *
 * Shared setup:
 * - `beforeEach`: `stubProxyPorts(page, <derived>)` (`_web-tile.ts`)
 *   route-stubs the derived dead port's `/proxy/<port>/**` with a static 200
 *   page (port from `reserveDeadPort`, `_ports.ts`) — the dead-port error
 *   state hides the iframe when nothing listens on the stamped dead URL, and
 *   these tests assert tile chrome, never frame content. Each
 *   describe's `beforeEach` also sets a wide desktop viewport (1440×800) — the
 *   top-bar surface-toggle group is desktop terminal-route only.
 * - tmux server: the isolated `rk-test-e2e` socket (`E2E_TMUX_SERVER`); never
 *   run Playwright directly — `just test-e2e code-surface`.
 * - code-server stub: code-server is not installable in the test env, so the
 *   first describe binds a stub HTTP server (`startCodeStub`, `_ports.ts`) on
 *   `RK_CODE_SERVER_PORT` — the same env the test-e2e script seeds the
 *   backend with; an ephemeral port when unset, so bare runs never collide —
 *   serving a minimal page with a focusable `#inner` button; the second
 *   describe runs with the stub DOWN. The backend's reachability probe is
 *   TTL-cached (~5s), so down-state assertions use a 30s budget; the
 *   down-state test also asserts NEITHER code-tile header verb renders (no
 *   mounted frame for Reload editor, no drift for Follow terminal). The helper
 *   validates the env against the backend's own 1-65535 range before binding,
 *   so an out-of-range value fails with a named error instead of surfacing as
 *   unrelated missing-affordance assertions. The backend resolves the same
 *   port server-side (the preset wins) and forwards `/code/*` to it.
 * - `beforeAll`: create one dedicated session `e2e-codesurface-<ts>` (80×24) so
 *   this file never collides with other specs (`fullyParallel` off), then warm
 *   the dev server with a throwaway TERMINAL-route page load (Vite's cold
 *   transform of the app + xterm graph would otherwise eat the first test's
 *   10s budget). `afterAll` kills the session (best-effort); the
 *   stub-listening describe also closes the stub.
 * - `makeWindow(name, {cwd?})`: create a window via `tmux new-window`
 *   (optionally with `-c <dir>` for a non-repo cwd — code-capable via the
 *   cwd fallback, so the code root is that dir itself; the dir must live
 *   under $HOME, the `@rk_win_code_root` write path's constraint). Returns
 *   the stable `@N` id.
 * - `GIT_ROOT`: `git rev-parse --show-toplevel` from the spec process — the
 *   toplevel every in-repo test window derives (windows inherit the tmux
 *   server's repo-root cwd).
 * - `fetchWorkspace(page, id)`: the test's own GET of
 *   `/api/windows/<id>/code-workspace` — the derived workspace file's
 *   run-specific absolute path (per-run XDG_STATE_HOME, never hardcoded).
 *   `expectWorkspaceFile(path, root, id)` asserts the on-disk identity
 *   payload (`folders[0].path`, `rk.tab`, `rk.server`).
 *   `holdWorkspaceFetch(page)` route-holds the frontend's GET so the
 *   pending → iframe transition is observable regardless of box load.
 * - The first-boot-rescue tests write fake pid-alive bridge registry files —
 *   a host record into `${XDG_STATE_HOME}/hexokit/cb/hosts/` (the negative
 *   arm) and an empty-boot marker into `${XDG_STATE_HOME}/hexokit/cb/boots/`
 *   (the positive arm) — after the tile's baseline status read, using the
 *   harness's per-run state home (forwarded from the harness, so the backend
 *   reads the SAME dir), and count `Code editor` iframe loads via an
 *   addInitScript capture listener; every written path lands in
 *   `rescueRecordFiles` and is removed by the describe's `afterEach`. The
 *   backend's `installed` answer is deterministic here: the harness forwards
 *   a per-run XDG_DATA_HOME carrying a fixture bridge-extension manifest to
 *   the dev server (`scripts/test-e2e.sh`), so the rescue decision never
 *   depends on the box's real extensions dir.
 * - `expectWindowLayout(id, expected)`: retrying read of the window's
 *   `@rk_win_layout` tmux option — the SHARED layout the translation / verbs
 *   write (never the URL; the URL stays bare after translation drops the
 *   inbound params).
 * - `switchToWindow(page, id)` (from `_ready.ts`, shared with the
 *   focus-restore spec): an IN-APP window switch through the sidebar row —
 *   the only switch path the frame-retention tests can use: the frame
 *   LRU is in-memory component state, so a `page.goto` reload would wipe the
 *   state under test.
 * - The retention describe re-binds the stub port with the focus-grab page
 *   (`focusGrabCodeStubHtml`, `_ports.ts`): it runs AFTER the stub-down
 *   describe (the first describe's afterAll has closed its stub), and its
 *   tests count `Code editor` iframe `load`s via the same addInitScript
 *   capture listener the rescue tests use — a retained frame re-showing must
 *   not fire a second `load` (no remount, no second focus grab), and the
 *   `Reload editor` verb must move the counter for the ACTIVE window's frame
 *   only (the retained frame's element untouched).
 * - Locators: the `Code tile` / `Web tile` top-bar toggles (role + accessible
 *   name SCOPED to the `banner` — the top bar's aria-hidden measurement probe
 *   duplicates every in-bar control, so accessible-name queries are the only
 *   unambiguous ones), the `surface-tile-code` tile testid, the `Code editor`
 *   iframe title, the `code-surface-empty` testid, the `.xterm` terminal
 *   surface, and the command palette (the only lens-switch surface).
 */

// Own session so this file never collides with other specs (fullyParallel off).
const TEST_SESSION = `e2e-codesurface-${Date.now()}`;
const DESKTOP_VIEWPORT = { width: 1440, height: 800 };

// The git root every in-repo window derives (windows inherit the tmux server's
// start cwd — the repo root). FindGitRoot walks to the toplevel, so the seeded
// code root — the workspace file's folders[0].path — is the worktree root.
const GIT_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf-8",
}).trim();

/** Resolve a window's stable tmux id (`@N`) from the backend snapshot by name. */
async function resolveWindow(page: Page, windowName: string): Promise<string> {
  return (await resolveWindowRaw(page, TMUX_SERVER, TEST_SESSION, windowName))
    .windowId;
}

/** Create a window (optionally in a NON-repo cwd) and return its @N id. */
async function makeWindow(
  page: Page,
  name: string,
  opts: { cwd?: string } = {},
): Promise<string> {
  newWindow(TEST_SESSION, name, opts);
  return resolveWindow(page, name);
}

/** Navigate to a window's terminal route (optionally with a search string) and
 *  wait for the SSE connection. The `Connected` dot lives in the full-width
 *  bottom status bar since the composed-frame unification (the desktop sidebar
 *  renders no footer), so the query is unscoped — it is the only `Connected`
 *  element on a desktop route. */
async function gotoWindow(
  page: Page,
  windowId: string,
  search = "",
): Promise<void> {
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}${search}`);
  await expect(page.locator("[aria-label='Connected']")).toBeVisible({
    timeout: READY_TIMEOUT,
  });
}

// In-app window switches (`switchToWindow` from `_ready.ts` — shared with the
// focus-restore spec): the ONLY switch path usable by the retention tests,
// since the code-frame LRU is in-memory component state and a `page.goto`
// reload would wipe the state under test.

// The surface toggles live in the top bar's `surface-toggles` group (the right
// rail is REMOVED — composed-frame unification). Banner-scoped accessible-name
// queries: the top bar always renders an aria-hidden off-screen measurement
// probe duplicating every in-bar control, so testid / `:visible` queries are
// ambiguous — getByRole excludes the probe.
const codeToggle = (page: Page) =>
  page.getByRole("banner").getByRole("button", { name: "Code tile" });
const webToggle = (page: Page) =>
  page.getByRole("banner").getByRole("button", { name: "Web tile" });
// The panel slot is gone (260812-ab5v) — surfaces render as layout TILES.
const codeTile = (page: Page) => page.getByTestId("surface-tile-code");
// Scoped to the active tile: other windows' retained frames stay mounted
// hidden under `surface-tile-code-retained`, so a bare title match is not unique.
const codeIframe = (page: Page) => page.getByTestId("surface-tile-code").getByTitle("Code editor");
const pending = (page: Page) => page.getByTestId("code-surface-pending");
const notRunning = (page: Page) => page.getByTestId("code-surface-empty");
const terminal = (page: Page) => page.locator(".xterm").first();

/** The window's derived workspace file, fetched exactly the way the tile does:
 *  GET /api/windows/{id}/code-workspace (the route's single writer). The
 *  harness runs with a per-run temp XDG_STATE_HOME, so the returned absolute
 *  path is run-specific — the response is the only legitimate source. */
async function fetchWorkspace(
  page: Page,
  windowId: string,
): Promise<{ path: string; root: string }> {
  const res = await page.request.get(
    `/api/windows/${encodeURIComponent(windowId)}/code-workspace?server=${encodeURIComponent(TMUX_SERVER)}`,
  );
  expect(res.ok(), `code-workspace GET for ${windowId}: ${res.status()}`).toBe(true);
  return (await res.json()) as { path: string; root: string };
}

/** The expected iframe `src` for a derived workspace path. */
function workspaceSrc(path: string): string {
  return `/code/?workspace=${encodeURIComponent(path)}`;
}

/** Read the derived workspace file off disk and assert its identity payload:
 *  the folder it was derived from, the window id (`rk.tab`), and the tmux
 *  server (`rk.server`). */
function expectWorkspaceFile(path: string, root: string, windowId: string): void {
  expect(existsSync(path), `workspace file exists: ${path}`).toBe(true);
  const doc = JSON.parse(readFileSync(path, "utf-8")) as {
    folders: Array<{ path: string }>;
    settings: Record<string, string>;
  };
  expect(doc.folders).toEqual([{ path: root }]);
  expect(doc.settings["rk.tab"]).toBe(windowId);
  expect(doc.settings["rk.server"]).toBe(TMUX_SERVER);
}

/** Route-hold the frontend's code-workspace GET until the returned release
 *  runs — makes the pending → iframe transition deterministic regardless of
 *  box load (the pending state's natural lifetime can be shorter than a
 *  paint). The test's own `fetchWorkspace` goes through `page.request`, which
 *  page routing does not intercept. */
async function holdWorkspaceFetch(page: Page): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/windows/*/code-workspace*", async (route) => {
    await gate;
    await route.continue();
  });
  return release;
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

// The dead-port error state (260819-v6y4 R8) hides the iframe when nothing
// listens on the stamped port — these tests assert tile chrome, never frame
// content, so the proxy path is route-stubbed live (see _web-tile.ts). The
// port is a reserved-then-released ephemeral (dead by construction).
let DEAD: DeadPort;

test.beforeAll(async () => {
  DEAD = await reserveDeadPort();
});

test.beforeEach(async ({ page }) => {
  await stubProxyPorts(page, DEAD.port);
});

test.beforeAll(async ({ browser }) => {
  createSession(TEST_SESSION);
  // Cold-boot warm-up: when this file runs standalone (`just test-e2e
  // code-surface`), the first test would otherwise pay Vite's cold transform
  // of the app + xterm graph INSIDE its 10s budget (observed: `Connected`
  // never landing in time). A throwaway TERMINAL-route load of this session's
  // first window (beforeAll is outside the per-test budget) absorbs it — the
  // xterm chunk is what a server-route warm-up would miss.
  const page = await browser.newPage();
  const first = await resolveWindowRaw(page, TMUX_SERVER, TEST_SESSION);
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(first.windowId)}`);
  await expect(page.locator("[aria-label='Connected']")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 60_000 });
  await page.close();
});

test.afterAll(() => {
  killSession(TEST_SESSION);
});

test.describe("Code lens & CODE surface (phase 2) — stub reachable", () => {
  let stub: CodeStub;

  // Fake bridge registry files (host records, boot markers) written by the
  // rescue tests — removed after each test so a later run's registry never
  // carries a stale entry.
  const rescueRecordFiles: string[] = [];

  test.beforeAll(async () => {
    stub = await startCodeStub(plainCodeStubHtml());
  });

  test.afterAll(async () => {
    await new Promise((resolve) => stub.server.close(resolve));
  });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
  });

  test.afterEach(() => {
    while (rescueRecordFiles.length) {
      rmSync(rescueRecordFiles.pop()!, { force: true });
    }
  });

  /**
   * Proves: availability derives from the SSE `gitRoot` field alone (no
   * client-side declaration; the port is conventional and does not gate); a
   * non-repo cwd (a scratch dir under $HOME) is code-capable too — the
   * backend falls back to the raw cwd, so the seeded code root is that dir
   * itself. The `View: Code` lens switch is palette-only — the chevron menu
   * carries no `View:` rows. On first open the tile shows the terse pending
   * state until the derived workspace path resolves, then mounts the iframe
   * at the `?workspace=` URL. The test carries a 30s budget: two window
   * creations plus two full page loads land marginal at the 10s default
   * under suite load.
   *
   * Steps:
   * 1. Create a repo-cwd window; navigate; assert the terminal, then the `Code
   *    tile` top-bar toggle (SSE-gated).
   * 2. Open the palette with `View: Code`; assert the option is visible;
   *    Escape. Open the "More controls" menu; assert it carries NO `View:`
   *    rows; Escape.
   * 3. Create a non-repo-cwd window (a scratch dir under $HOME — the
   *    `@rk_win_code_root` write path rejects outside-home roots); navigate;
   *    assert the `Code tile` button IS visible and the `View: Code` palette
   *    option IS offered.
   * 4. Route-hold the window's code-workspace GET, open the code tile, and
   *    assert `code-surface-pending` renders before the iframe; release the
   *    GET, then assert the iframe src is `/code/?workspace=<encoded path>`
   *    (path from the window's code-workspace GET) and the GET's `root` is
   *    the raw non-repo cwd (not a git root). Remove the scratch dir.
   */
  test("the Code tile top-bar toggle appears on repo and non-repo windows alike; the non-repo code folder is the raw cwd", async ({
    page,
  }) => {
    // Two window creations + two full page loads + palette interactions —
    // carries the 30s budget (the sidebar-panels precedent); at the 10s
    // default this lands marginal under suite load.
    test.setTimeout(30_000);
    // A repo-cwd window gains the code affordances once the SSE window payload
    // carries gitRoot (availability = gitRoot derived — since 260811-a2bo the
    // port resolves by convention and no longer gates; never reachability).
    const repo = await makeWindow(page, `cs-repo-${Date.now()}`);
    await gotoWindow(page, repo);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    await expect(codeToggle(page)).toBeVisible({ timeout: READY_TIMEOUT });
    // The ViewSwitcher is retired (260812-0c6o): the palette is the lens-switch
    // surface, and the chevron menu carries no `View:` rows.
    const paletteInput = await openPalette(page);
    await paletteInput.fill("View: Code");
    await expect(page.getByRole("option", { name: "View: Code" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "More controls" }).click();
    await expect(
      page
        .getByRole("menu", { name: "More controls" })
        .getByRole("menuitemradio", { name: /^View:/ }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");

    // A non-repo cwd falls back to the raw cwd as its code root — both
    // affordances render, keyed on that dir itself. The dir lives under $HOME
    // because the @rk_win_code_root write path validates that constraint (an
    // outside-home cwd's seed is rejected and the tile never resolves).
    const offRepoRoot = mkdtempSync(join(homedir(), "rk-e2e-nonrepo-"));
    try {
      const offRepo = await makeWindow(page, `cs-nonrepo-${Date.now()}`, {
        cwd: offRepoRoot,
      });
      await gotoWindow(page, offRepo);
      await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
      await expect(codeToggle(page)).toBeVisible({ timeout: READY_TIMEOUT });
      const paletteInput2 = await openPalette(page);
      await paletteInput2.fill("View: Code");
      await expect(
        page.getByRole("option", { name: "View: Code", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      // Open the code tile: the pending state renders while the derivation GET
      // is unresolved (the seed POST must land and the payload must carry the
      // new code root first — the GET is route-held so the state is observable
      // under any load); the iframe then mounts at the derived ?workspace=
      // URL, whose root is the raw non-repo cwd, not a git root.
      const release = await holdWorkspaceFetch(page);
      await codeToggle(page).click();
      await expect(pending(page)).toBeVisible({ timeout: READY_TIMEOUT });
      release();
      await expect(codeIframe(page)).toBeVisible({ timeout: READY_TIMEOUT });
      const ws = await fetchWorkspace(page, offRepo);
      expect(ws.root).toBe(offRepoRoot);
      await expect(codeIframe(page)).toHaveAttribute("src", workspaceSrc(ws.path));
    } finally {
      rmSync(offRepoRoot, { recursive: true, force: true });
    }
  });

  /**
   * Proves: the retired `?panel=code` deep link translates inbound (a bare
   * panel value maps against the tty default slot A → the tree form
   * `h(tty,code)`, written to `@rk_win_layout` once, params dropped from the
   * URL); the tile's
   * renderer iframes the derived RELATIVE `/code/?workspace=<path>` URL (never
   * an absolute origin; the port never appears) with the sandbox set (incl.
   * `allow-downloads`); and the workspace file behind that path exists on disk
   * carrying the window's identity (`folders[0].path` = the git root,
   * `rk.tab` = the window id, `rk.server` = the tmux server). The terminal
   * stays mounted beside the tile (the layout is additive).
   *
   * Steps:
   * 1. Create a repo-cwd window; navigate with `?panel=code`.
   * 2. Assert the `surface-tile-code` tile and the `Code editor` iframe are
   *    visible, the option reads `h(tty,code)`, and the URL is bare.
   * 3. GET the window's code-workspace; assert the iframe `src` attribute is
   *    exactly `/code/?workspace=<url-encoded path>`, the GET's `root` is the
   *    git root, and the sandbox contains `allow-downloads`.
   * 4. Read the workspace file off disk; assert `folders[0].path` is the git
   *    root, `rk.tab` is the window id, and `rk.server` is the tmux server.
   * 5. Assert the terminal is still visible.
   */
  test("?panel=code opens the code tile (inbound translation); the iframe src is the derived /code/?workspace=<path>", async ({
    page,
  }) => {
    const id = await makeWindow(page, `cs-panel-${Date.now()}`);
    await gotoWindow(page, id, "?panel=code");

    // The retired ?panel= param translates inbound (bare panel value →
    // h(tty,code), one option write in the tree form). The code TILE renders
    // its iframe
    // (stub reachable) at the fully DERIVED relative src on the STABLE /code/
    // route — never an absolute origin, and the port never
    // appears (it's a server-side implementation detail).
    await expect(codeTile(page)).toBeVisible({ timeout: 10_000 });
    await expectWindowLayout(id, "h(tty,code)");
    await expect.poll(() => new URL(page.url()).search, { timeout: 10_000 }).toBe("");
    const iframe = codeIframe(page);
    await expect(iframe).toBeVisible({ timeout: READY_TIMEOUT });
    const ws = await fetchWorkspace(page, id);
    expect(ws.root).toBe(GIT_ROOT);
    await expect(iframe).toHaveAttribute("src", workspaceSrc(ws.path));
    // The sandbox carries the prerequisite set incl. allow-downloads.
    const sandbox = await iframe.getAttribute("sandbox");
    expect(sandbox).toContain("allow-downloads");
    // The derived workspace file on disk carries the window's identity.
    expectWorkspaceFile(ws.path, GIT_ROOT, id);
    // The terminal stays mounted beside the code tile (the layout is additive).
    await expect(terminal(page)).toBeVisible();
  });

  /**
   * Proves: the relative-base rule on the stable route — code-server resolves
   * `./x` against the trailing slash, so the backend 308-redirects the bare
   * `/code` to `/code/` with the query preserved.
   *
   * Steps:
   * 1. `GET /code?folder=/repo` through the dev proxy with `maxRedirects: 0`.
   * 2. Assert status 308 and `Location: /code/?folder=/repo`.
   */
  test("/code 308-redirects to /code/ (query preserved) before proxying", async ({
    page,
  }) => {
    // The relative-base rule (code-server resolves "./x" against the trailing
    // slash) enforced by the backend route — asserted through the Vite dev
    // proxy (maxRedirects: 0 so the redirect itself is observed).
    const res = await page.request.get("/code?folder=/repo", {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(308);
    expect(res.headers()["location"]).toBe("/code/?folder=/repo");
  });

  /**
   * Proves: hide-never-unmount generalized to tiles — with two surfaces
   * available, opening web then code renders BOTH iframes simultaneously (tiles
   * are additive), and closing the web tile keeps its iframe subtree mounted
   * (display-level hide); the re-opened web iframe is the identical element
   * (in-memory state preserved).
   *
   * Steps:
   * 1. Create a repo-cwd window and stamp the slot-1 web tab (both surfaces
   *    available); navigate; assert both top-bar toggles.
   * 2. Open web; assert the `Proxied content` iframe is visible. Click the code
   *    top-bar toggle; assert the code iframe is visible AND the web iframe
   *    still is.
   * 3. Close web via its lit toggle; assert the web iframe is hidden but still
   *    in the DOM (count 1). Capture its element handle, reopen web, and assert
   *    the visible iframe is the same element.
   */
  test("tiles coexist and a closed tile hides but never unmounts its iframe (P3 across surfaces)", async ({
    page,
  }) => {
    const id = await makeWindow(page, `cs-p3-${Date.now()}`);
    // Stamp the slot-1 web tab so BOTH surfaces are available on this repo-cwd
    // window.
    stampWebTab(id, DEAD.url);
    await gotoWindow(page, id);
    await expect(webToggle(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(codeToggle(page)).toBeVisible();

    // Open web, then code — tiles are ADDITIVE now (R10 growth): both
    // iframes render simultaneously (a 3-tile tree).
    await webToggle(page).click();
    const webIframe = page.getByTitle("Proxied content");
    await expect(webIframe).toBeVisible({ timeout: 10_000 });
    await codeToggle(page).click();
    await expect(codeIframe(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(webIframe).toBeVisible();

    // Close web via its lit toggle: hidden but STILL MOUNTED — the same
    // element returns when the tile reopens.
    await webToggle(page).click();
    await expect(webIframe).toBeHidden();
    await expect(webIframe).toHaveCount(1);
    const handleBefore = await webIframe.elementHandle();
    await webToggle(page).click();
    await expect(webIframe).toBeVisible({ timeout: 10_000 });
    const handleAfter = await webIframe.elementHandle();
    expect(
      await page.evaluate(([a, b]) => a === b, [handleBefore, handleAfter]),
    ).toBe(true);
  });

  /**
   * Proves: a same-server window switch no longer reboots the editor — the
   * code tile's frame is retained (hide-never-unmount extended across
   * windows), so opening the tile in window A, switching to B and back, fires
   * exactly ONE iframe `load` for A's frame across the whole round trip, and
   * the frame element is the identical node (no remount, no re-boot).
   *
   * Steps:
   * 1. Register a capture-phase `load` counter via addInitScript (the iframe
   *    `load` does not bubble, so document-level capture is the counter),
   *    then create repo-cwd windows A and B and navigate to A.
   * 2. Open the code tile via the `Code tile` top-bar toggle, await the
   *    iframe, capture its element handle, and assert the counter reads 1.
   * 3. Switch to B and back to A via the sidebar (in-app — a reload would
   *    wipe the in-memory frame list under test).
   * 4. Assert the code iframe is visible again, the element is the identical
   *    node, and the counter still reads 1 after a settle window (a remount
   *    or a reload would have fired a second `load`).
   */
  test("a switch away and back re-shows the retained code frame — exactly one iframe load, same element", async ({
    page,
  }) => {
    // Two windows, two in-app switches, plus a settle window — carries the
    // 30s budget (the sidebar-panels precedent).
    test.setTimeout(30_000);
    await page.addInitScript(() => {
      const w = window as unknown as { __codeIframeLoads: number };
      w.__codeIframeLoads = 0;
      document.addEventListener(
        "load",
        (e) => {
          if (e.target instanceof HTMLIFrameElement && e.target.title === "Code editor") {
            w.__codeIframeLoads++;
          }
        },
        true,
      );
    });
    const idA = await makeWindow(page, `cs-keep-a-${Date.now()}`);
    const idB = await makeWindow(page, `cs-keep-b-${Date.now()}`);
    await gotoWindow(page, idA);

    await codeToggle(page).click();
    await expect(codeIframe(page)).toBeVisible({ timeout: READY_TIMEOUT });
    const handleBefore = await codeIframe(page).elementHandle();
    expect(handleBefore, "code iframe element").not.toBeNull();
    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __codeIframeLoads: number }).__codeIframeLoads),
        { timeout: READY_TIMEOUT },
      )
      .toBe(1);

    // Away and back IN-APP: the frame is retained display-hidden while B is
    // shown (B has no code tile), then becomes visible again.
    await switchToWindow(page, idB);
    await expect(terminal(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await switchToWindow(page, idA);
    await expect(codeIframe(page)).toBeVisible({ timeout: READY_TIMEOUT });

    const handleAfter = await codeIframe(page).elementHandle();
    expect(
      await page.evaluate(([a, b]) => a === b, [handleBefore, handleAfter]),
    ).toBe(true);
    // No remount and no reload: the counter never moved. The settle window
    // gives a stray second load time to land before the read.
    await page.waitForTimeout(1_000);
    const loads = await page.evaluate(
      () => (window as unknown as { __codeIframeLoads: number }).__codeIframeLoads,
    );
    expect(loads).toBe(1);
  });

  /**
   * Proves: the first-boot rescue never reloads a frame whose boot the bridge
   * host record positively confirms — with a pid-alive tab-keyed record
   * (written into the harness's per-run state home AFTER the tile mounted, so
   * its stamp is newer than the mount's empty baseline) the first verdict
   * settles the generation early and the iframe fires exactly ONE `load` over
   * the rescue wait window plus slack. The rescue reloads only on a newer
   * empty-boot MARKER (the positive arm below); a confirming record is the
   * good-boot signal, and its absence can never trigger a reload.
   * `installed` is deterministically true in this rig (the harness's per-run
   * XDG_DATA_HOME fixture), so this test exercises the real decision path.
   *
   * Steps:
   * 1. Register a capture-phase `load` counter via addInitScript (the iframe
   *    `load` does not bubble, so document-level capture is the counter), then
   *    create a repo-cwd window and navigate.
   * 2. Arm a `waitForResponse` on the code-bridge GET, open the code tile, and
   *    await the iframe — the response await orders the test AFTER the
   *    frontend's baseline read, so the record cannot land in both reads and
   *    compare stale.
   * 3. Write the fake host record `{hostId, folder, pid: process.pid, sock,
   *    extVersion, startedAt: <now>, tab: <window id>, server: <E2E tmux
   *    server>}` into `${XDG_STATE_HOME}/hexokit/cb/hosts/` (read from
   *    process.env, never hardcoded) and register it for afterEach cleanup.
   * 4. Wait CODE_BOOT_RESCUE_WAIT_MS + 2 s, then assert the load counter is
   *    exactly 1 (a rescue reload would have fired a second `load`).
   */
  test("a confirming bridge host record suppresses the rescue reload (exactly one iframe load)", async ({
    page,
  }) => {
    // One window, one navigation, then a 12 s observation window — past the
    // 10s default + READY budgets, so this test carries a 45s budget.
    test.setTimeout(45_000);
    const stateHome = process.env.XDG_STATE_HOME;
    if (!stateHome) {
      throw new Error(
        "XDG_STATE_HOME is unset — run via `just test-e2e code-surface`, which " +
          "seeds the per-run state home and forwards it to the spec process.",
      );
    }

    // Step 1: the load counter must predate the iframe, so it rides an init
    // script — registered before gotoWindow's navigation.
    await page.addInitScript(() => {
      const w = window as unknown as { __codeIframeLoads: number };
      w.__codeIframeLoads = 0;
      document.addEventListener(
        "load",
        (e) => {
          if (e.target instanceof HTMLIFrameElement && e.target.title === "Code editor") {
            w.__codeIframeLoads++;
          }
        },
        true,
      );
    });
    const id = await makeWindow(page, `cs-rescue-${Date.now()}`);
    await gotoWindow(page, id);

    // Step 2: open the tile; the response await proves the baseline status
    // read completed before the record exists.
    const baselineAnswered = page.waitForResponse("**/api/windows/*/code-bridge*");
    await codeToggle(page).click();
    await expect(codeIframe(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await baselineAnswered;

    // Step 3: the confirming record — pid-alive (this process), tab-keyed to
    // the window under test, stamped now (newer than the empty baseline).
    const hostsDir = join(stateHome, "hexokit", "cb", "hosts");
    mkdirSync(hostsDir, { recursive: true });
    const hostId = `e2e-rescue-${id.slice(1)}`;
    const recordPath = join(hostsDir, `${hostId}.json`);
    writeFileSync(
      recordPath,
      JSON.stringify({
        hostId,
        folder: GIT_ROOT,
        pid: process.pid,
        sock: join(stateHome, "hexokit", "cb", `${hostId}.sock`),
        extVersion: "0.0.0-e2e",
        startedAt: new Date().toISOString(),
        tab: id,
        server: TMUX_SERVER,
      }),
    );
    rescueRecordFiles.push(recordPath);

    // Step 4: the rescue verdict lands at the 10 s mark; a reload would fire
    // a second load immediately after.
    await page.waitForTimeout(CODE_BOOT_RESCUE_WAIT_MS + 2_000);
    const loads = await page.evaluate(
      () => (window as unknown as { __codeIframeLoads: number }).__codeIframeLoads,
    );
    expect(loads).toBe(1);
  });

  /**
   * Proves: the first-boot rescue fires exactly ONE reload when the bridge
   * extension positively reports that THIS boot activated with zero folders —
   * a fake pid-alive empty-boot marker written into the harness's per-run
   * boots dir AFTER the tile's baseline read makes the first verdict's
   * `emptyBootAt` strictly newer than the empty baseline, and with
   * `installed` deterministically true (the harness's per-run XDG_DATA_HOME
   * fixture) the verdict is "reload". The settled generation never reloads
   * again: across the re-check window the load counter stays at 2.
   *
   * Steps:
   * 1. Register the capture-phase `load` counter via addInitScript, then
   *    create a repo-cwd window and navigate.
   * 2. Arm a `waitForResponse` on the code-bridge GET, open the code tile, and
   *    await the iframe plus the baseline response — the marker must not
   *    exist before the baseline read, or it would BE the baseline.
   * 3. Write the fake marker `{hostId, workspaceFile, tab: <window id>,
   *    server: <E2E tmux server>, pid: process.pid, extVersion, startedAt:
   *    <now>}` into `${XDG_STATE_HOME}/hexokit/cb/boots/` and register it for
   *    afterEach cleanup.
   * 4. Wait out the verdict AND re-check windows (WAIT + RECHECK + slack),
   *    then assert the load counter is exactly 2: the initial mount and the
   *    single rescue reload.
   */
  test("a newer empty-boot marker reloads the frame exactly once (positive rescue arm)", async ({
    page,
  }) => {
    // One window, one navigation, then a 22 s observation window covering the
    // verdict AND the re-check mark — past the 10s default + READY budgets,
    // so this test carries a 45s budget.
    test.setTimeout(45_000);
    const stateHome = process.env.XDG_STATE_HOME;
    if (!stateHome) {
      throw new Error(
        "XDG_STATE_HOME is unset — run via `just test-e2e code-surface`, which " +
          "seeds the per-run state home and forwards it to the spec process.",
      );
    }

    await page.addInitScript(() => {
      const w = window as unknown as { __codeIframeLoads: number };
      w.__codeIframeLoads = 0;
      document.addEventListener(
        "load",
        (e) => {
          if (e.target instanceof HTMLIFrameElement && e.target.title === "Code editor") {
            w.__codeIframeLoads++;
          }
        },
        true,
      );
    });
    const id = await makeWindow(page, `cs-bootmark-${Date.now()}`);
    await gotoWindow(page, id);

    const baselineAnswered = page.waitForResponse("**/api/windows/*/code-bridge*");
    await codeToggle(page).click();
    await expect(codeIframe(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await baselineAnswered;

    // The positive empty-boot signal: pid-alive (this process), tab-keyed to
    // the window under test, stamped now — newer than the empty baseline.
    const ws = await fetchWorkspace(page, id);
    const bootsDir = join(stateHome, "hexokit", "cb", "boots");
    mkdirSync(bootsDir, { recursive: true });
    const hostId = `e2e-boot-${id.slice(1)}`;
    const markerPath = join(bootsDir, `${hostId}.json`);
    writeFileSync(
      markerPath,
      JSON.stringify({
        hostId,
        workspaceFile: ws.path,
        tab: id,
        server: TMUX_SERVER,
        pid: process.pid,
        extVersion: "0.0.0-e2e",
        startedAt: new Date().toISOString(),
      }),
    );
    rescueRecordFiles.push(markerPath);

    // The verdict lands at the 10 s mark and reloads; the re-check at 20 s
    // must not fire a third load on the settled generation.
    await page.waitForTimeout(CODE_BOOT_RESCUE_WAIT_MS + CODE_BOOT_RESCUE_RECHECK_MS + 2_000);
    const loads = await page.evaluate(
      () => (window as unknown as { __codeIframeLoads: number }).__codeIframeLoads,
    );
    expect(loads).toBe(2);
  });

  /**
   * Proves: the code tile header's `Reload editor` verb reboots the ACTIVE
   * window's frame in place — exactly one additional iframe `load` on the
   * SAME element with the `src` attribute unchanged (the
   * `contentWindow.location.reload()` seam keeps the `?workspace=` URL and
   * tab identity; a `src` write would be a re-navigation). The verb is
   * hidden while the tile pends (no frame to reload).
   *
   * Steps:
   * 1. Register the capture-phase iframe `load` counter via addInitScript,
   *    then create a repo-cwd window and navigate.
   * 2. Route-hold the window's code-workspace GET, open the code tile via the
   *    `Code tile` toggle, assert `code-surface-pending` shows AND the
   *    `Reload editor` verb (scoped to `surface-tile-code`) is hidden;
   *    release the GET.
   * 3. Await the iframe and the counter reaching 1; capture the element
   *    handle and the `src` attribute.
   * 4. Click `Reload editor`; poll the counter to exactly 2; assert the
   *    element handle is IDENTICAL and the `src` is unchanged.
   */
  test("the Reload editor verb reloads the live frame in place — one extra load, same element, same src", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    await page.addInitScript(() => {
      const w = window as unknown as { __codeIframeLoads: number };
      w.__codeIframeLoads = 0;
      document.addEventListener(
        "load",
        (e) => {
          if (e.target instanceof HTMLIFrameElement && e.target.title === "Code editor") {
            w.__codeIframeLoads++;
          }
        },
        true,
      );
    });
    const loadsOf = () =>
      page.evaluate(() => (window as unknown as { __codeIframeLoads: number }).__codeIframeLoads);
    const id = await makeWindow(page, `cs-reload-${Date.now()}`);
    await gotoWindow(page, id);

    // Pending has no frame, so no Reload verb (route-held GET makes the state
    // observable under any load).
    const release = await holdWorkspaceFetch(page);
    await codeToggle(page).click();
    await expect(pending(page)).toBeVisible({ timeout: READY_TIMEOUT });
    const reloadVerb = codeTile(page).getByRole("button", { name: "Reload editor" });
    await expect(reloadVerb).toBeHidden();
    release();

    await expect(codeIframe(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(reloadVerb).toBeVisible();
    await expect.poll(loadsOf, { timeout: READY_TIMEOUT }).toBe(1);
    const handleBefore = await codeIframe(page).elementHandle();
    const srcBefore = await codeIframe(page).getAttribute("src");

    await reloadVerb.click();
    await expect.poll(loadsOf, { timeout: READY_TIMEOUT }).toBe(2);
    const handleAfter = await codeIframe(page).elementHandle();
    expect(await page.evaluate(([a, b]) => a === b, [handleBefore, handleAfter])).toBe(true);
    await expect(codeIframe(page)).toHaveAttribute("src", srcBefore!);
  });

});

test.describe("Code lens & CODE surface (phase 2) — stub down", () => {
  // No stub here: nothing listens on the code-server port (the previous
  // describe's afterAll closed its stub), so the TTL-cached probe flips to
  // unreachable.
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
  });

  /**
   * Proves: reachability governs CONTENT, not availability — with the stub
   * down, the top-bar toggle still renders (capability signals are stable) but
   * the code tile shows the terse portless `code-server not running — check rk
   * doctor` empty state, with its `Restart code-server` recovery button,
   * instead of a dead iframe. Neither code-tile header
   * verb renders on that state: `Reload editor` has no mounted frame to
   * reload, and `Follow terminal` has no drift (the latched root and the
   * derivation agree).
   *
   * Steps:
   * 1. (Stub is closed — this describe never binds the port.)
   * 2. Create a repo-cwd window; navigate with `?panel=code`; assert the `Code
   *    tile` top-bar toggle is visible.
   * 3. Assert the `code-surface-empty` state contains `code-server not running
   *    — check rk doctor` (30s budget — the backend's ~5s probe TTL must expire
   *    first; contains, since the state also holds the button), that it offers
   *    the `Restart code-server` button (not clicked — a click would respawn
   *    the rig daemon's code-server), and that no `Code editor` iframe exists.
   * 4. Assert the `Reload editor` and `Follow terminal` verbs are both absent
   *    from the tile header.
   */
  test("the surface renders the not-running empty state when the port is unreachable", async ({
    page,
  }) => {
    const id = await makeWindow(page, `cs-down-${Date.now()}`);
    await gotoWindow(page, id, "?panel=code");

    // Availability still holds (gitRoot derived — the port is conventional) —
    // the top-bar toggle renders; only the CONTENT is the empty state. Generous
    // timeout: the backend's ~5s probe TTL must expire before the flip lands.
    await expect(codeToggle(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(notRunning(page)).toContainText(
      "code-server not running — check rk doctor",
      {
        timeout: 30_000,
      },
    );
    await expect(notRunning(page).getByRole("button", { name: "Restart code-server" })).toBeVisible();
    await expect(codeIframe(page)).toHaveCount(0);
    // No frame and no drift: neither header verb renders on the empty state.
    await expect(codeTile(page).getByRole("button", { name: "Reload editor" })).toBeHidden();
    await expect(codeTile(page).getByRole("button", { name: "Follow terminal" })).toBeHidden();
  });
});

test.describe("Code frame retention — no focus-grab replay on a switch back", () => {
  // Second stub lifecycle: the first describe's afterAll closed the plain
  // stub, so this describe re-binds the seeded port with the focus-grab page.
  let grabStub: CodeStub;

  test.beforeAll(async () => {
    grabStub = await startCodeStub(focusGrabCodeStubHtml(300));
  });

  test.afterAll(async () => {
    await new Promise((resolve) => grabStub.server.close(resolve));
  });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
  });

  /**
   * Proves: a retained code frame fires no second load-time focus grab on the
   * away-and-back return — the frame never reloads, so the workbench's
   * one-shot grab does not re-fire, the steal guard has nothing to revert,
   * and the window's remembered focus (the terminal) holds.
   *
   * Steps:
   * 1. Register the capture-phase iframe `load` counter via addInitScript,
   *    create windows A and B, navigate to A, and click the terminal (the
   *    genuine pointerdown records `tty` for A).
   * 2. Open the code tile via the `Code tile` toggle (the click disarms this
   *    visit's guard, so the grab stands); await the iframe and the stub's
   *    grab (its document title flips to `grabbed`); assert focus is on the
   *    iframe and the load counter reads 1.
   * 3. Switch to B and back to A via the sidebar; await the code iframe.
   * 4. Assert the load counter still reads 1 (no remount → no second grab),
   *    the frame's title is still `grabbed` from the FIRST load, and
   *    `document.activeElement` is inside `.xterm` — the remembered tty
   *    focus, with the steal guard never re-triggered by the retained frame.
   */
  test("a retained frame does not re-fire the workbench's focus grab; the terminal keeps focus", async ({
    page,
  }) => {
    // Two windows, two in-app switches, the grab delay, and a settle window —
    // carries the 30s budget (the focus-restore.spec precedent).
    test.setTimeout(30_000);
    await page.addInitScript(() => {
      const w = window as unknown as { __codeIframeLoads: number };
      w.__codeIframeLoads = 0;
      document.addEventListener(
        "load",
        (e) => {
          if (e.target instanceof HTMLIFrameElement && e.target.title === "Code editor") {
            w.__codeIframeLoads++;
          }
        },
        true,
      );
    });
    const idA = await makeWindow(page, `cs-grab-a-${Date.now()}`);
    const idB = await makeWindow(page, `cs-grab-b-${Date.now()}`);
    await gotoWindow(page, idA);
    // The genuine terminal interaction that records `tty` for window A.
    await terminal(page).click();

    await codeToggle(page).click();
    await expect(codeIframe(page)).toBeVisible({ timeout: READY_TIMEOUT });
    const frame = await codeIframe(page).elementHandle();
    expect(frame, "code iframe element").not.toBeNull();
    // Gate on the grab having FIRED (the stub's one-shot title flip) so no
    // assertion can pass vacuously.
    await expect
      .poll(
        () =>
          page.evaluate(
            (f) => (f as HTMLIFrameElement).contentDocument?.title ?? "",
            frame,
          ),
        { timeout: READY_TIMEOUT },
      )
      .toBe("grabbed");
    await expectActiveElement(page, "code-iframe");
    await expect
      .poll(
        () => page.evaluate(() => (window as unknown as { __codeIframeLoads: number }).__codeIframeLoads),
        { timeout: READY_TIMEOUT },
      )
      .toBe(1);

    // Away and back: the retained frame re-shows without reloading, so no
    // second grab fires and the remembered tty focus is restored.
    await switchToWindow(page, idB);
    await expect(terminal(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await switchToWindow(page, idA);
    await expect(codeIframe(page)).toBeVisible({ timeout: READY_TIMEOUT });

    await page.waitForTimeout(1_000);
    const loads = await page.evaluate(
      () => (window as unknown as { __codeIframeLoads: number }).__codeIframeLoads,
    );
    expect(loads).toBe(1);
    // The title is the FIRST load's grab mark — a reload would have reset and
    // re-set it (indistinguishable), so the load counter above is the
    // no-second-grab proof; this guards the frame is the same live document.
    await expect
      .poll(
        () =>
          page.evaluate(
            (f) => (f as HTMLIFrameElement).contentDocument?.title ?? "",
            frame,
          ),
        { timeout: READY_TIMEOUT },
      )
      .toBe("grabbed");
    await expectActiveElement(page, "xterm");
  });

  /**
   * Proves: the `Reload editor` verb reloads ONLY the active window's frame —
   * the verb's nonce targets one frame by window id, so a retained
   * (other-window) frame fires no `load` and its iframe element is untouched
   * (a blind reload of every retained frame would destroy editor state the
   * user did not ask to touch).
   *
   * Steps:
   * 1. Register the capture-phase iframe `load` counter via addInitScript;
   *    create repo-cwd windows A and B; navigate to A.
   * 2. Open the code tile on A; await the iframe and the counter at 1;
   *    capture A's element handle.
   * 3. Switch to B in-app (A's tile demotes to `surface-tile-code-retained`
   *    without moving in the DOM); open the code tile on B; await the iframe
   *    and the counter at 2.
   * 4. Click `Reload editor` on B's (active) tile header.
   * 5. Assert the counter reaches exactly 3, B's iframe is the IDENTICAL
   *    element (an in-place reload), and A's retained iframe is still the
   *    SAME element captured in step 2 with no load of its own.
   */
  test("the Reload editor verb reloads only the active window's frame — the retained frame is untouched", async ({
    page,
  }) => {
    // Two windows, one in-app switch, and a reload — carries the 30s budget
    // (the retention round-trip precedent).
    test.setTimeout(30_000);
    await page.addInitScript(() => {
      const w = window as unknown as { __codeIframeLoads: number };
      w.__codeIframeLoads = 0;
      document.addEventListener(
        "load",
        (e) => {
          if (e.target instanceof HTMLIFrameElement && e.target.title === "Code editor") {
            w.__codeIframeLoads++;
          }
        },
        true,
      );
    });
    const loadsOf = () =>
      page.evaluate(() => (window as unknown as { __codeIframeLoads: number }).__codeIframeLoads);
    const idA = await makeWindow(page, `cs-reload-a-${Date.now()}`);
    const idB = await makeWindow(page, `cs-reload-b-${Date.now()}`);
    await gotoWindow(page, idA);

    await codeToggle(page).click();
    await expect(codeIframe(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect.poll(loadsOf, { timeout: READY_TIMEOUT }).toBe(1);
    const handleA = await codeIframe(page).elementHandle();

    // B becomes the active window with its own code tile; A's frame demotes
    // to the retained wrapper (its DOM position is unchanged by this switch —
    // B's tile is INSERTED before it, so A's frame fires no load).
    await switchToWindow(page, idB);
    await expect(terminal(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await codeToggle(page).click();
    await expect(codeIframe(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect.poll(loadsOf, { timeout: READY_TIMEOUT }).toBe(2);
    const handleB = await codeIframe(page).elementHandle();

    // The verb reloads the ACTIVE window's frame only: exactly one more load
    // (B's), same element for both frames.
    await codeTile(page).getByRole("button", { name: "Reload editor" }).click();
    await expect.poll(loadsOf, { timeout: READY_TIMEOUT }).toBe(3);
    const handleBAfter = await codeIframe(page).elementHandle();
    expect(await page.evaluate(([a, b]) => a === b, [handleB, handleBAfter])).toBe(true);
    const retainedA = page.getByTestId("surface-tile-code-retained").getByTitle("Code editor");
    const handleAAfter = await retainedA.elementHandle();
    expect(await page.evaluate(([a, b]) => a === b, [handleA, handleAAfter])).toBe(true);
  });
});
