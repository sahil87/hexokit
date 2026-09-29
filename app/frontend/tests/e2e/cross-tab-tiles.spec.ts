import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  READY_TIMEOUT,
  openPalette,
  resolveWindow as resolveWindowRaw,
  seedComposeStrip,
} from "./_ready";
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

// Cross-tab tiles e2e (spec docs/specs/surface-layout.md § tiles from other
// tabs): a layout tile may show ANOTHER tab's surface, addressed `@N/<kind>`,
// live in exactly one place. Covered here: borrowing A's terminal into B by
// dragging A's sidebar window row (WINDOW_DRAG_MIME HTML5 drag) onto a tile
// edge — the drop-catcher overlay arms mid-drag and the drop inserts
// `@A/tty`; the borrowed tile streams A's pane (typing lands in A's window);
// the home tab's slot renders the away placeholder ("Terminal is in tab
// <holder>", bring back, go to, status dot, ✕) instead of mounting the
// surface; ✕ dismisses the slot so the remaining tile fills; the top-bar
// surface toggle re-adds the slot (placeholder again) and carries the amber
// away marker; bring back and the foreign tile's ↩ header verb both send the
// surface home via POST /api/layout/return; and killing the home window while
// borrowed prunes the foreign leaf at read time (B renders a single tty).
// Everything runs against the REAL backend + private tmux server (the rig's
// `E2E_TMUX_SERVER`) — no route stubbing; all layout assertions read the
// `@rk_win_layout` tmux window option (ground truth), and pane output is read
// with `tmux capture-pane`.
//
// Shared setup: `beforeAll` creates one dedicated session `e2e-xttiles-<ts>`
// (80×24) so this file never collides with other specs (`fullyParallel` off),
// then warms the dev server with a throwaway terminal-route page load
// (Vite's cold transform of the app + xterm graph would otherwise eat the
// first test's budget); `afterAll` kills the session (best-effort).
// `beforeEach` sets a wide desktop viewport (1440×800 — multi-tile is
// desktop-only) and stubs the derived dead port's `/proxy/<port>/**` with a
// static 200 page (stubProxyPorts from _web-tile.ts, port from
// reserveDeadPort in _ports.ts — the dead-port error state hides the iframe
// when nothing listens on the stamped URL; the placeholder test asserts tile
// chrome, never frame content). `makeWindow(name)` creates a window via tmux
// and resolves its stable `@N` id from the backend snapshot. Windows are
// created FRESH PER TEST — layouts mutate as the scenarios run. The sidebar
// row drag is driven with page.mouse (down on the row's draggable root,
// stepped moves — dragstart arms the drop-catcher — release over the tile's
// right-edge band).

// Own session so this file never collides with other specs (fullyParallel off).
const TEST_SESSION = `e2e-xttiles-${Date.now()}`;
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

// Locators. The top-bar toggle query is scoped to the banner landmark by
// ACCESSIBLE NAME because the top bar always renders an aria-hidden
// off-screen measurement probe duplicating every in-bar control (the
// right-panel.spec.ts LOCATOR RULE) — getByRole excludes the probe.
const ttyToggle = (page: Page) =>
  page.getByRole("banner").getByRole("button", { name: "Terminal tile", exact: true });
const tile = (page: Page, testId: string) => page.getByTestId(testId);
const foreignTtyTile = (page: Page, homeId: string) =>
  page.getByTestId(`surface-tile-tty-${homeId}`);
const placeholder = (page: Page) => page.getByTestId("surface-placeholder");
const terminal = (page: Page) => page.locator(".xterm").first();

/** Drag a sidebar window row onto a point (page coordinates) — the row root
 *  (`[data-window-id]`) is the HTML5 draggable; the stepped moves let
 *  dragstart fire and arm the layout's drop-catcher before the pointer
 *  crosses the tiles. With `assertPreview` the drop is held while the
 *  result-preview overlay (`tile-drop-overlay` + the `tile-drop-dest`
 *  destination rect) is asserted, then released at the target. */
async function dragRowTo(
  page: Page,
  windowId: string,
  target: { x: number; y: number },
  opts: { assertPreview?: boolean } = {},
): Promise<void> {
  const row = page
    .locator("nav[aria-label='Sessions']")
    .locator(`[data-window-id="${windowId}"]`);
  await expect(row).toBeVisible({ timeout: READY_TIMEOUT });
  const box = await row.boundingBox();
  if (!box) throw new Error(`no sidebar row box for ${windowId}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 5 });
  // The drop-catcher mounts once dragstart parses the row's payload.
  await expect(tile(page, "row-drop-catcher")).toBeVisible({ timeout: 5_000 });
  await page.mouse.move(target.x, target.y, { steps: 10 });
  if (opts.assertPreview) {
    await expect(tile(page, "tile-drop-overlay")).toBeVisible({ timeout: 5_000 });
    await expect(tile(page, "tile-drop-dest")).toBeVisible();
  }
  await page.mouse.up();
}

/** The right-edge drop point of B's lone tty tile — inside the tile's edge
 *  band but clear of the layout's outer 18px edge band (which would win the
 *  hit-test right at the boundary; both zones yield the same `h(tty,@A/tty)`
 *  on a single-tile layout). */
async function ttyRightEdge(page: Page): Promise<{ x: number; y: number }> {
  const box = await tile(page, "surface-tile-tty").boundingBox();
  if (!box) throw new Error("no tty tile box");
  return { x: box.x + box.width - 40, y: box.y + box.height / 2 };
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

test.describe("Cross-tab tiles — borrow, placeholder, send home, prune", () => {
  /**
   * Proves: dragging tab A's sidebar row onto the right edge of B's tty tile
   * borrows A's terminal into B — the drop-catcher previews the result
   * mid-drag and B's shared `@rk_win_layout` becomes `h(tty,@A/tty)`; the
   * borrowed tile identifies its home tab in the header and streams A's pane
   * (typing into it lands in A's window, read back via `tmux capture-pane`),
   * while A's own slot shows the away placeholder instead of a second
   * terminal.
   *
   * Steps:
   * 1. Create windows A and B; navigate to B; assert the terminal.
   * 2. Drag A's sidebar row onto the right edge of B's tty tile; assert the
   *    drop preview renders and, on release, B's option reads
   *    `h(tty,@A/tty)` and the foreign tile `surface-tile-tty-@A` renders
   *    with its home chip naming A.
   * 3. Click the foreign tile's xterm, type an `echo <marker>` line, press
   *    Enter; poll `capture-pane` on A until the marker appears (the
   *    borrowed stream targets A's pane).
   * 4. Navigate to A; assert the away placeholder shows "Terminal is in tab
   *    <B name>" and no terminal mounts in A's slot.
   */
  test("dragging A's sidebar row onto B's tile edge borrows A's terminal; typing in it lands in A's window; A shows the placeholder", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    // Typing goes straight into the borrowed tile's xterm — pin the compose
    // strip off so no other input surface can claim the keys.
    await seedComposeStrip(page, false);
    const a = await makeWindow(page, `xt-a-${Date.now()}`);
    const bName = `xt-b-${Date.now()}`;
    const b = await makeWindow(page, bName);
    await gotoWindow(page, b);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });

    // Borrow: drag A's row onto the tty tile's right edge. The result preview
    // renders mid-drag (asserted while the drop is held); the release commits
    // one write — B's layout gains the foreign leaf.
    const target = await ttyRightEdge(page);
    await dragRowTo(page, a, target, { assertPreview: true });
    await expectWindowLayout(b, `h(tty,${a}/tty)`);
    const foreign = foreignTtyTile(page, a);
    await expect(foreign).toBeVisible({ timeout: 10_000 });
    await expect(foreign.getByTestId("tile-home")).toHaveText(await windowNameOf(page, a));
    await expect(foreign.locator(".xterm")).toBeVisible({ timeout: 10_000 });

    // Type into the borrowed tile: the keystrokes ride the isolated stream to
    // A's pane — tmux ground truth, not a DOM read. Stream-readiness gate:
    // the isolate path attaches a real tmux client to A's `_rk-iso-<N>`
    // session (proof the borrowed stream opened isolated), and input rides
    // only an OPEN stream — a client attached to the iso session means the
    // relay is live. (An xterm-content gate would not work: the tile renders
    // with the WebGL addon, whose DOM rows stay empty.)
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
        { timeout: 15_000 },
      )
      .toBe(true);
    const marker = `XT_${Date.now().toString(36)}`;
    await foreign.locator(".xterm").click();
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press("Enter");
    await expect.poll(() => paneText(a), { timeout: 10_000 }).toContain(marker);

    // Home tab: A's slot renders the away placeholder (no second relay
    // stream competes for A's pane).
    await gotoWindow(page, a);
    await expect(placeholder(page)).toBeVisible({ timeout: 10_000 });
    await expect(placeholder(page)).toContainText(`Terminal is in tab ${bName}`);
    await expect(terminal(page)).toHaveCount(0);
  });

  /**
   * Proves: the away placeholder's full verb cycle on a two-tile home tab —
   * the placeholder shows the holder message, the status dot, bring back, go
   * to, and ✕; go to navigates to the holder's route; ✕ dismisses the slot so
   * the remaining web tile fills the layout; toggling `tty` back on re-adds
   * the slot as the placeholder with the away marker on the top-bar toggle;
   * and bring back returns the surface (the holder's layout reverts to the
   * bare `tty`, the home slot mounts the live terminal again).
   *
   * Steps:
   * 1. Create A (layout `h(tty,web)` + a stamped web tab) and B (layout
   *    `h(tty,@A/tty)` stamped via tmux — the borrowed state); navigate to A.
   * 2. Assert the placeholder: "Terminal is in tab <B name>", a status dot,
   *    the bring back / go to / ✕ controls, and the web tile beside it; the
   *    top-bar Terminal toggle carries the away marker.
   * 3. Click `go to <B name>`; assert the route lands on B; navigate back
   *    to A.
   * 4. Click ✕ (`Close Terminal`); assert A's option reads `web` and the web
   *    tile fills (placeholder gone).
   * 5. Click the `Terminal tile` top-bar toggle; assert the option grows to
   *    `h(web,tty)`, the placeholder is back, and the toggle's away marker
   *    shows.
   * 6. Click `bring back`; assert B's option reads `tty` and A's terminal
   *    mounts live (placeholder gone, away marker cleared).
   */
  test("the placeholder cycle: go to, ✕ dismisses the slot, toggle re-adds it with the away marker, bring back returns the surface", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const aName = `xt-ha-${Date.now()}`;
    const a = await makeWindow(page, aName);
    stampWebTab(a, DEAD.url);
    setWindowOption(a, "@rk_win_layout", "h(tty,web)");
    const bName = `xt-hb-${Date.now()}`;
    const b = await makeWindow(page, bName);
    setWindowOption(b, "@rk_win_layout", `h(tty,${a}/tty)`);

    await gotoWindow(page, a);
    const ph = placeholder(page);
    await expect(ph).toBeVisible({ timeout: 10_000 });
    await expect(ph).toContainText(`Terminal is in tab ${bName}`);
    // The tty status dot reads the home window's record exactly as the
    // sidebar row shows it (role=img, e.g. "active"/"idle").
    await expect(ph.locator('[role="img"]')).toHaveCount(1);
    await expect(ph.getByRole("button", { name: "bring back" })).toBeVisible();
    await expect(ph.getByRole("button", { name: `go to ${bName}` })).toBeVisible();
    await expect(ph.getByRole("button", { name: "Close Terminal" })).toBeVisible();
    await expect(tile(page, "surface-tile-web")).toBeVisible();
    await expect(terminal(page)).toHaveCount(0);
    // The top-bar toggle signals the away slot.
    const toggle = ttyToggle(page);
    await expect(toggle).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(toggle.getByTestId("surface-away-tty")).toBeVisible();

    // go to → the holder's route (the canonical in-app URL segment is the
    // window id's NUMERIC part — `@N` sans `@`, router.tsx's stringify).
    await ph.getByRole("button", { name: `go to ${bName}` }).click();
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 10_000 })
      .toBe(`/${TMUX_SERVER}/${b.slice(1)}`);
    await gotoWindow(page, a);
    await expect(ph).toBeVisible({ timeout: 10_000 });

    // ✕ dismisses the slot — the remaining web tile fills the layout.
    await ph.getByRole("button", { name: "Close Terminal" }).click();
    await expectWindowLayout(a, "web");
    await expect(ph).toHaveCount(0);
    await expect(tile(page, "surface-tile-web")).toBeVisible();

    // Toggle tty back on: the slot returns, rendered as the placeholder
    // (still borrowed), with the away marker on the toggle.
    await ttyToggle(page).click();
    await expectWindowLayout(a, "h(web,tty)");
    await expect(ph).toBeVisible({ timeout: 10_000 });
    await expect(ttyToggle(page).getByTestId("surface-away-tty")).toBeVisible();

    // bring back: the return endpoint reverts B to its bare tty and A's slot
    // goes live (the stream mounts, the marker clears on the SSE tick — wide
    // timeouts for a contended box).
    await ph.getByRole("button", { name: "bring back" }).click();
    await expectWindowLayout(b, "tty");
    await expect(terminal(page)).toBeVisible({ timeout: 15_000 });
    await expect(ph).toHaveCount(0, { timeout: 15_000 });
    await expect(ttyToggle(page).getByTestId("surface-away-tty")).toHaveCount(0, {
      timeout: 15_000,
    });
  });

  /**
   * Proves: the foreign tile's ↩ header verb sends the surface home (the
   * holder's layout reverts to the bare `tty`, the borrowed tile drops to
   * mounted-hidden — hide-never-unmount keeps ever-opened leaves in the DOM —
   * and the home tab mounts its live terminal again), and killing the home
   * window while borrowed prunes the foreign leaf at READ time — B renders a
   * single tty tile with no broken tile and no background rewrite of the
   * stored option (the pruned tree persists only on the next layout write).
   *
   * Steps:
   * 1. Create A and B; stamp B's layout `h(tty,@A/tty)`; navigate to B;
   *    assert the foreign tile with its home chip and the ↩ verb
   *    (`Send Terminal back to <A name>`).
   * 2. Click ↩; assert B's option reads `tty`, the foreign tile hides, B's
   *    own terminal stays visible, then on A the live terminal renders (no
   *    placeholder).
   * 3. Stamp B's layout `h(tty,@A/tty)` again (borrowed once more); assert
   *    the foreign tile returns.
   * 4. Kill A's window via tmux; assert the next session payload prunes the
   *    leaf: the foreign tile hides, B's own terminal stays visible, and B's
   *    stored option still carries the stale address (read-time prune — no
   *    background writer).
   */
  test("↩ sends the borrowed surface home; killing the home window prunes the foreign tile at read time", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const aName = `xt-ka-${Date.now()}`;
    const a = await makeWindow(page, aName);
    const b = await makeWindow(page, `xt-kb-${Date.now()}`);
    setWindowOption(b, "@rk_win_layout", `h(tty,${a}/tty)`);

    await gotoWindow(page, b);
    const foreign = foreignTtyTile(page, a);
    await expect(foreign).toBeVisible({ timeout: 10_000 });
    await expect(foreign.getByTestId("tile-home")).toHaveText(aName);
    const sendHome = foreign.getByRole("button", { name: `Send Terminal back to ${aName}` });
    // The verb cluster is hover-revealed (the Close verb pattern).
    await foreign.hover();
    await expect(sendHome).toBeVisible();

    // ↩: the return endpoint drops the leaf from B; A still has its slot, so
    // only B is written and A's terminal goes live again. The option write
    // lands first; the repaint follows on the hub wake (wide timeout — a
    // contended box lags). The tile stays MOUNTED-HIDDEN, not unmounted:
    // hide-never-unmount keeps every ever-opened leaf in the DOM at display
    // level (the closed-web-tile semantics), so the assertion is visibility.
    await sendHome.click();
    await expectWindowLayout(b, "tty");
    await expect(foreign).toBeHidden({ timeout: 15_000 });
    await expect(tile(page, "surface-tile-tty")).toBeVisible({ timeout: 15_000 });
    await gotoWindow(page, a);
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    await expect(placeholder(page)).toHaveCount(0, { timeout: 10_000 });

    // Borrow once more, then kill the home window: the next session payload
    // prunes the dead address before render — B shows its single tty tile
    // (the foreign tile drops back to mounted-hidden), and the stored option
    // keeps the stale string until the next write (read-time prune — no
    // background writer).
    setWindowOption(b, "@rk_win_layout", `h(tty,${a}/tty)`);
    await gotoWindow(page, b);
    await expect(foreignTtyTile(page, a)).toBeVisible({ timeout: 10_000 });
    execFileSync("tmux", ["-L", TMUX_SERVER, "kill-window", "-t", a]);
    await expect(foreignTtyTile(page, a)).toBeHidden({ timeout: 15_000 });
    await expect(terminal(page)).toBeVisible({ timeout: 10_000 });
    expect(windowOption(b, "@rk_win_layout")).toBe(`h(tty,${a}/tty)`);
  });
});

/** A window's display name from the backend snapshot (the header home chip
 *  and the ↩ label render it). */
async function windowNameOf(page: Page, windowId: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const res = await page.request.get(
      `/api/sessions?server=${encodeURIComponent(TMUX_SERVER)}`,
    );
    if (res.ok()) {
      const sessions = (await res.json()) as Array<{ windows: Array<{ windowId: string; name: string }> }>;
      for (const s of sessions) {
        const w = s.windows.find((w) => w.windowId === windowId);
        if (w) return w.name;
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`window ${windowId} not found in snapshot`);
}
