import { test, expect, type Page } from "@playwright/test";
import { focusGrabCodeStubHtml, startCodeStub, type CodeStub } from "./_ports";
import { READY_TIMEOUT, resolveWindow as resolveWindowRaw, seedComposeStrip } from "./_ready";
import { TMUX_SERVER, createSession, killSession, newWindow } from "./_tmux";

// Surface focus chords e2e — the three-state tile chords (⌘1 tty / ⌘2 code),
// the zen zoom toggle (⇧⌘⏎), and the stateful sidebar chord (⌘B) with its
// Escape return, including the steal-guard recording asymmetry (a chord must
// never write `code` into focus memory; only genuine in-frame interaction
// may). The rig runs a Linux browser host, so the chords resolve to their
// base shifted tier (⇧Ctrl+1/2, ⇧Ctrl+Enter, ⇧Ctrl+B); the mac ⌘ forms are
// pinned by unit tests (keybindings.test.ts per-host resolution).
//
// Shared setup: `beforeAll` creates one dedicated session `e2e-sfc-<ts>` on
// the isolated e2e tmux socket, binds the workbench grab stub (startCodeStub
// from _ports.ts: an HTTP server on the harness-seeded RK_CODE_SERVER_PORT,
// or an ephemeral port when unset, serving one focusable button that grabs
// focus once per load, 300ms in, and retitles its document `grabbed` — the
// stub makes the backend's reachability probe genuinely true, so the code
// tile renders a real iframe), and pays Vite's cold transform with a throwaway
// terminal-route page load outside any test's budget (90s hook budget);
// `afterAll` closes the stub and kills the session. `beforeEach` sets a
// desktop viewport (1440×800) — the chords' stateful arms are desktop-only.
// Chord keydowns disarm the visit's steal guard (the restore effect's
// capture-phase keydown disarm), so the stub's grab STANDS on the visit where
// a chord opens the tile. On an away-and-back return the window's RETAINED
// frame re-shows without a reload (no second grab), so the recording
// asymmetry is proven by where the restore router lands DOM focus, not by a
// revert. Window switches go through the sidebar row
// (switchToWindow), never `page.goto`: focus memory is in-memory by design,
// so a reload would wipe the state under test. Tile focus vs DOM focus: the
// seam's contract is the focused-SLOT (the accent-green border); DOM focus
// enters the iframe only via the stub's grab or a genuine click —
// `expectTileFocused` asserts the border, `expectActiveElement` asserts DOM
// focus, and `expectGrabFired` gates every grab-dependent assertion on the
// grab having actually fired. Every test calls `test.setTimeout(30_000)` —
// each drives iframe reloads and/or in-app window switches, past the 10s
// default.

// Own session so this file never collides with other specs (fullyParallel off).
const TEST_SESSION = `e2e-sfc-${Date.now()}`;
const DESKTOP_VIEWPORT = { width: 1440, height: 800 };

/** How long after its own load the stub waits before grabbing focus — the
 *  stand-in for the code-server workbench's one-shot editor-restore grab
 *  (fed to `focusGrabCodeStubHtml`, whose doc owns the grab mechanics). */
const GRAB_DELAY_MS = 300;

/** Create a window (repo cwd — windows inherit the tmux server's start cwd, so
 *  the code lens is available) and return its stable `@N` id. */
async function makeWindow(page: Page, name: string): Promise<string> {
  newWindow(TEST_SESSION, name);
  return (await resolveWindowRaw(page, TMUX_SERVER, TEST_SESSION, name)).windowId;
}

/** Navigate to a window's terminal route and wait for the SSE connection. */
async function gotoWindow(page: Page, windowId: string): Promise<void> {
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`);
  await expect(page.locator("[aria-label='Connected']")).toBeVisible({
    timeout: READY_TIMEOUT,
  });
}

/** Switch windows through the sidebar row — the ONLY switch path usable here:
 *  focus memory is in-memory by design, so a `page.goto` reload would wipe the
 *  very state under test (the focus-restore spec's pattern). */
async function switchToWindow(page: Page, windowId: string): Promise<void> {
  const row = page
    .locator("nav[aria-label='Groups']")
    .locator(`[data-window-id="${windowId}"]`)
    .getByRole("button")
    .first();
  await expect(row).toBeVisible({ timeout: READY_TIMEOUT });
  await row.click();
  await expect(row).toHaveAttribute("aria-current", "page", {
    timeout: READY_TIMEOUT,
  });
}

// The chords under test, as they resolve on the e2e rig's Linux browser host
// (base shifted tier — the mac ⌘ forms are unit-tested in keybindings.test.ts).
const CHORD_TTY = "Shift+Control+Digit1"; // ⌘1 on mac
const CHORD_CODE = "Shift+Control+Digit2"; // ⌘2 on mac
const CHORD_ZEN = "Shift+Control+Enter"; // ⇧⌘⏎ on mac
const CHORD_SIDEBAR = "Shift+Control+KeyB"; // ⌘B on mac

// Scoped to the ACTIVE window's tile: code frames of other windows stay
// mounted display-hidden (`surface-tile-code-retained`), so a bare title
// match resolves to several iframes once a second window has opened one.
const codeIframe = (page: Page) => page.getByTestId("surface-tile-code").getByTitle("Code editor");
const ttyTile = (page: Page) => page.getByTestId("surface-tile-tty");
const codeTile = (page: Page) => page.getByTestId("surface-tile-code");
const railCodeButton = (page: Page) =>
  page.getByRole("button", { name: "Code tile" });
const sidebarAside = (page: Page) => page.locator('aside[aria-label="Sidebar"]');

/** The window's sidebar row wrapper (the roving treeitem). */
const windowRow = (page: Page, windowId: string) =>
  page.locator("nav[aria-label='Groups']").locator(`[data-window-id="${windowId}"]`);

/** Poll until the stub's grab has FIRED inside the iframe (its document title
 *  flips to "grabbed") — keeps the specs non-vacuous (the focus-restore
 *  spec's gate). */
async function expectGrabFired(page: Page): Promise<void> {
  const handle = await codeIframe(page).elementHandle();
  expect(handle, "code iframe element").not.toBeNull();
  await expect
    .poll(
      () =>
        page.evaluate(
          (f) => (f as HTMLIFrameElement).contentDocument?.title ?? "",
          handle,
        ),
      { timeout: READY_TIMEOUT },
    )
    .toBe("grabbed");
}

/** Poll `document.activeElement` until it lands on the expected focus target. */
async function expectActiveElement(
  page: Page,
  target: "xterm" | "code-iframe",
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((kind) => {
          const el = document.activeElement;
          if (!el) return false;
          if (kind === "xterm") return el.closest(".xterm") !== null;
          return el.tagName === "IFRAME" && el.getAttribute("title") === "Code editor";
        }, target),
      { timeout: READY_TIMEOUT },
    )
    .toBe(true);
}

/** One-shot check whether the xterm holds DOM focus right now. */
async function isXtermFocused(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement?.closest(".xterm") !== null);
}

const tile = (page: Page, kind: "tty" | "code") =>
  kind === "tty" ? ttyTile(page) : codeTile(page);

/** Tile FOCUS is the focused-slot accent border (the tmux active-pane
 *  metaphor) — the observable the focus-hop e2e (shortcut-registry.spec.ts)
 *  already asserts; the seam's contract is slot focus, not DOM focus. */
async function expectTileFocused(page: Page, kind: "tty" | "code"): Promise<void> {
  await expect(tile(page, kind)).toHaveClass(/border-accent-green/, {
    timeout: READY_TIMEOUT,
  });
  const other = kind === "tty" ? "code" : "tty";
  await expect(tile(page, other)).not.toHaveClass(/border-accent-green/);
}

let stub: CodeStub;

test.beforeAll(async ({ browser }, testInfo) => {
  // The hook's own budget: the warm-up below pays Vite's cold transform of
  // the app + xterm graph (the focus-restore spec's pattern).
  testInfo.setTimeout(90_000);
  createSession(TEST_SESSION);
  stub = await startCodeStub(focusGrabCodeStubHtml(GRAB_DELAY_MS));
  const page = await browser.newPage();
  const first = await resolveWindowRaw(page, TMUX_SERVER, TEST_SESSION);
  await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(first.windowId)}`);
  await expect(page.locator("[aria-label='Connected']")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 60_000 });
  await page.close();
});

test.afterAll(async () => {
  await new Promise((resolve) => stub.server.close(resolve));
  killSession(TEST_SESSION);
});

test.describe("Surface focus chords (260819-qwr7)", () => {
  test.beforeEach(async ({ page }) => {
    // The subject is focus moving between TILES via chords. The compose strip
    // is on by default and a first visit would land focus in its textarea,
    // so these tests state the explicit opt-out (compose-strip.spec.ts owns
    // the default-on focus rule).
    await seedComposeStrip(page, false);
    await page.setViewportSize(DESKTOP_VIEWPORT);
  });

  /**
   * Proves: all three states of the code tile chord against a real iframe
   * stub — including focus landing after the open — and the recording
   * asymmetry: ⌘2 writes no focus memory, so on an away-and-back return the
   * restore router lands DOM focus on the tty default even though the
   * retained code frame is visible (had the chord recorded `code`, the
   * router would focus the frame — the focus-restore spec's (c) behavior).
   *
   * Steps:
   * 1. Create windows A and B; navigate to A; assert the xterm holds focus
   *    (the first-visit tty default).
   * 2. Press ⌘2; assert the code iframe appears, the stub's grab fires, DOM
   *    focus lands on the iframe element, and the code tile carries the
   *    focused-slot border (hidden → open+focus).
   * 3. Click the terminal tile (a genuine pointerdown: focused slot → tty,
   *    records `tty`, DOM focus → xterm); assert both.
   * 4. Press ⌘2; assert the focused-slot border moves to code and BOTH
   *    tiles stay visible (visible-unfocused → focus; no layout mutation).
   * 5. Press ⌘2 again; assert the code tile hides (display-level — the
   *    hide-never-unmount rule), the tty tile stays, and DOM focus is on
   *    the xterm (focused → hide + restore through the router).
   * 6. Switch to B via the sidebar; press ⌘2; assert the grab fires and DOM
   *    focus lands in the iframe (B has NO focus memory — nothing was ever
   *    recorded).
   * 7. Switch to A and back to B via the sidebar; assert B's retained
   *    iframe is visible (its earlier grab still recorded, no reload) but
   *    DOM focus lands on the xterm — the router took the tty default,
   *    proving ⌘2 recorded nothing.
   */
  test("(a) ⌘2 cycles hidden→open+focus, visible-unfocused→focus, focused→hide+restore; the chord never records `code`", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    const idA = await makeWindow(page, `sfc-a-${Date.now()}`);
    const idB = await makeWindow(page, `sfc-b-${Date.now()}`);
    await gotoWindow(page, idA);
    await expectActiveElement(page, "xterm");
    // Gate the FIRST chord on the code lens being available (the rail toggle
    // renders only for available surfaces): a chord for an unavailable
    // surface mounts no handler and falls through by design (A-016).
    await expect(railCodeButton(page)).toBeVisible({ timeout: READY_TIMEOUT });

    // State 1 — hidden: ⌘2 opens the code tile and focus lands on it once the
    // layout lands (the per-kind landing flag → the focus seam). The chord's
    // own keydown disarmed this visit's guard, so the stub's grab stands and
    // chains real DOM focus into the iframe.
    await page.keyboard.press(CHORD_CODE);
    await expect(codeIframe(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expectGrabFired(page);
    await expectActiveElement(page, "code-iframe");
    await expectTileFocused(page, "code");

    // Make the tile visible-unfocused: click the terminal tile (a genuine
    // pointerdown — flips the focused slot to tty, records `tty`, and lands
    // DOM focus on the xterm).
    await page.locator(".xterm").first().click();
    await expectActiveElement(page, "xterm");
    await expectTileFocused(page, "tty");

    // State 2 — visible, not focused: ⌘2 focuses the code tile with NO layout
    // mutation (both tiles stay visible).
    await page.keyboard.press(CHORD_CODE);
    await expectTileFocused(page, "code");
    await expect(codeTile(page)).toBeVisible();
    await expect(ttyTile(page)).toBeVisible();

    // State 3 — focused at arity 2: ⌘2 hides the code tile and focus restores
    // through the router (memory holds `tty` from the click above — the hide
    // passes `exclude: "code"`, but the recalled kind is already tty).
    await page.keyboard.press(CHORD_CODE);
    await expect(codeTile(page)).toBeHidden({ timeout: READY_TIMEOUT });
    await expect(ttyTile(page)).toBeVisible();
    await expectActiveElement(page, "xterm");

    // The recording asymmetry, isolated on window B (nothing ever recorded
    // there): ⌘2 opens + focuses code, but writes NO focus memory. On the
    // away-and-back return the router therefore resolves the tty default and
    // focuses the xterm while B's RETAINED frame re-shows without a reload —
    // had the chord recorded `code`, the router would focus the frame (the
    // focus-restore spec's (c) behavior).
    await switchToWindow(page, idB);
    await expect(page.locator(".xterm").first()).toBeVisible({ timeout: READY_TIMEOUT });
    // Same availability gate as above, for B's lens.
    await expect(railCodeButton(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await page.keyboard.press(CHORD_CODE);
    await expect(codeIframe(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expectGrabFired(page);
    await expectActiveElement(page, "code-iframe");

    await switchToWindow(page, idA);
    await expect(page.locator(".xterm").first()).toBeVisible({ timeout: READY_TIMEOUT });
    await switchToWindow(page, idB);
    await expect(codeIframe(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expectGrabFired(page);
    await expectActiveElement(page, "xterm");
  });

  /**
   * Proves: the tty chord's focus arm works from INSIDE the code iframe
   * (the chord-reclaim seam re-dispatches it to the parent) and records
   * `tty` through the seam's own `recordTtySlot`; the focused arm hides the
   * tty tile at arity 2; the hidden arm reopens and focuses it.
   *
   * Steps:
   * 1. Create window C; navigate; assert xterm focus.
   * 2. Open the code tile via the `Code tile` rail toggle; wait for the
   *    grab; click the stub editor's button through the frame (the genuine
   *    in-frame interaction that focuses the code tile); assert iframe DOM
   *    focus and the code tile's focused-slot border.
   * 3. Press ⌘1; assert the focused-slot border moves to the tty tile with
   *    BOTH tiles still visible (focus arm, no layout mutation).
   * 4. Click the terminal tile (the hide arm is a PARENT-side gesture: a
   *    chord reclaimed from inside the iframe fires the frame's
   *    `onInteract` first, re-flipping the focused slot to code before the
   *    dispatcher runs, so an in-frame ⌘1 always takes the focus arm);
   *    assert xterm DOM focus.
   * 5. Press ⌘1; assert the tty tile hides and the code tile stays (hide
   *    arm at arity 2).
   * 6. Press ⌘1 again; assert the tty tile reappears and carries the
   *    focused-slot border (hidden → open+focus on landing).
   */
  test("(b) ⌘1 focuses the tty tile from code (recording `tty` via the seam), then hides and reopens it", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    const id = await makeWindow(page, `sfc-c-${Date.now()}`);
    await gotoWindow(page, id);
    await expectActiveElement(page, "xterm");

    // Open code via the rail and click into the stub editor — the genuine
    // in-frame interaction that makes code the focused tile.
    await railCodeButton(page).click();
    await expect(codeIframe(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expectGrabFired(page);
    await codeTile(page).frameLocator('iframe[title="Code editor"]').locator("#inner").click();
    await expectActiveElement(page, "code-iframe");
    await expectTileFocused(page, "code");

    // Focus arm: ⌘1 from inside the iframe (the chord-reclaim seam re-
    // dispatches it to the parent) moves tile focus to the tty — recording
    // `tty` through the seam's own recordTtySlot — with no layout mutation.
    await page.keyboard.press(CHORD_TTY);
    await expectTileFocused(page, "tty");
    await expect(codeTile(page)).toBeVisible();
    await expect(ttyTile(page)).toBeVisible();

    // The hide arm is a PARENT-side gesture: a chord reclaimed from inside
    // the iframe fires the frame's `onInteract` first (any in-frame keydown
    // is editor interaction), which re-flips the focused slot to code before
    // the dispatcher runs — so an in-frame ⌘1 always takes the focus arm.
    // Click the terminal to make tty's focus real, then ⌘1 at arity 2 closes
    // the tty tile (hidden, never unmounted — the P3 rule), leaving
    // single:code.
    await page.locator(".xterm").first().click();
    await expectActiveElement(page, "xterm");
    await page.keyboard.press(CHORD_TTY);
    await expect(ttyTile(page)).toBeHidden({ timeout: READY_TIMEOUT });
    await expect(codeTile(page)).toBeVisible();

    // Hidden arm: the next ⌘1 reopens the tty tile and focuses it on landing.
    await page.keyboard.press(CHORD_TTY);
    await expect(ttyTile(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expectTileFocused(page, "tty");
  });

  /**
   * Proves: the zen chord toggles the existing zoom seam on the FOCUSED
   * tile as part of entering zen (with code focused, code zooms — not slot
   * A by fiat), the second press exits zen and undoes the zen-initiated
   * zoom (reclaimed from inside the iframe), and at arity 1 the chord
   * enters zen (hiding the sidebar) with no zoom attempted, a second press
   * restoring the chrome.
   *
   * Steps:
   * 1. Create windows D (the zoom window) and E (the arity-1 window);
   *    navigate to D.
   * 2. Open the code tile via the rail toggle; wait for the grab; click the
   *    stub editor's button through the frame — the genuine in-frame
   *    interaction (`onInteract`) is what flips the focused slot to code
   *    (the script grab alone produces no parent-side focus event in
   *    Chromium); assert iframe DOM focus and the code tile's focused-slot
   *    border.
   * 3. Press ⇧⌘⏎; assert the tty tile hides at display level while the
   *    code tile stays visible (zen entered; the focused tile zoomed
   *    full-center).
   * 4. Press ⇧⌘⏎ again (from inside the iframe, via the reclaim seam);
   *    assert both tiles are visible again (zen exited; the zen-initiated
   *    zoom undone).
   * 5. Switch to E via the sidebar; assert xterm focus on the single-tty
   *    layout; press ⇧⌘⏎; assert the tty tile stays visible, DOM focus
   *    never leaves the xterm, and the sidebar hides (zen at arity 1 —
   *    chrome-only). Press ⇧⌘⏎ again; assert the sidebar returns.
   * 6. Open the code tile on E via the rail toggle; assert BOTH tiles
   *    render unzoomed — the arity-1 zen round-trip latched no zoom (keeps
   *    the round-trip non-vacuous).
   */
  test("(c) ⇧⌘⏎ enters zen (zooming the focused tile at arity 2) and exits on a second press; arity 1 hides chrome without zooming", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    const idZoom = await makeWindow(page, `sfc-d-${Date.now()}`);
    const idSingle = await makeWindow(page, `sfc-e-${Date.now()}`);
    await gotoWindow(page, idZoom);

    // Arity 2 with the CODE tile focused: rail-open, then click into the stub
    // editor — the genuine in-frame interaction (`onInteract`) is what flips
    // the focused slot to code; the script grab alone produces no
    // parent-side focus event in Chromium.
    await railCodeButton(page).click();
    await expect(codeIframe(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expectGrabFired(page);
    await codeTile(page).frameLocator('iframe[title="Code editor"]').locator("#inner").click();
    await expectActiveElement(page, "code-iframe");
    await expectTileFocused(page, "code");

    // First press: the focused (code) tile zooms — the tty tile hides at
    // display level (never unmounts, the P3 rule).
    await page.keyboard.press(CHORD_ZEN);
    await expect(ttyTile(page)).toBeHidden({ timeout: READY_TIMEOUT });
    await expect(codeTile(page)).toBeVisible();

    // Second press (reclaimed from inside the iframe) exits zen AND undoes
    // the zen-initiated zoom (260820-o8cr): both tiles are back. (The first
    // press also hid the top bar + sidebar — the full zen behavior is the
    // `zen-mode` spec's; here only the zoom seam is under test.)
    await page.keyboard.press(CHORD_ZEN);
    await expect(ttyTile(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(codeTile(page)).toBeVisible();

    // Arity 1 (260820-o8cr R6): the chord now mounts at ANY arity — the press
    // enters zen (no zoom is attempted), so the sidebar and the top-bar rail
    // are hidden while the single tty tile stays visible and focused. A
    // second press exits zen and restores the chrome.
    await switchToWindow(page, idSingle);
    await expect(page.locator(".xterm").first()).toBeVisible({ timeout: READY_TIMEOUT });
    await expectActiveElement(page, "xterm");
    await page.keyboard.press(CHORD_ZEN);
    await expect(ttyTile(page)).toBeVisible();
    await expectActiveElement(page, "xterm");
    await expect(sidebarAside(page)).toBeHidden({ timeout: READY_TIMEOUT });
    await page.keyboard.press(CHORD_ZEN);
    await expect(sidebarAside(page)).toBeVisible({ timeout: READY_TIMEOUT });
    // Non-vacuous: opening the code tile afterwards shows BOTH tiles
    // unzoomed — the arity-1 zen round-trip latched no zoom.
    await railCodeButton(page).click();
    await expect(codeIframe(page)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(ttyTile(page)).toBeVisible();
    await expect(codeTile(page)).toBeVisible();
  });

  /**
   * Proves: the stateful sidebar chord's three arms — visible + focus
   * outside → focus the current window's row with the roving tab stop
   * synced; visible + focus inside → hide + return focus through the
   * route's registered restorer; hidden → open + focus the row — plus the
   * nav-scoped Escape return that restores focus WITHOUT hiding, and the
   * sidebar's no-recording contract (the return target is the remembered
   * surface, here the tty default).
   *
   * Steps:
   * 1. Create window F; navigate; assert xterm focus and a visible sidebar;
   *    wait for F's row to render AND carry `aria-current="page"` (both
   *    arrive via SSE after route mount — the chord's focus arm queries
   *    `[aria-current="page"]` at press time, so pressing earlier would hit
   *    the no-row fallback).
   * 2. Press ⌘B; assert the current row's button holds DOM focus, the row's
   *    treeitem carries `tabindex="0"` (roving sync), and the sidebar stays
   *    visible.
   * 3. Press Escape (up to twice: the row flyout, if keyboard focus opened
   *    it, gets Escape first-refusal — the nav handler is layered after its
   *    dismiss); assert DOM focus returns to the xterm and the sidebar
   *    stays visible.
   * 4. Press ⌘B (row focused again), then ⌘B once more from inside the
   *    sidebar; assert the sidebar unmounts and DOM focus returns to the
   *    xterm (hide + return arm).
   * 5. Press ⌘B with the sidebar hidden; assert it reopens and the row
   *    takes focus once mounted (hidden → open+focus arm).
   */
  test("(d) ⌘B focuses the current window's sidebar row (roving synced); Escape returns focus without hiding; a second ⌘B hides + returns", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    const id = await makeWindow(page, `sfc-f-${Date.now()}`);
    await gotoWindow(page, id);
    await expectActiveElement(page, "xterm");
    await expect(sidebarAside(page)).toBeVisible();
    const rowButton = windowRow(page, id).getByRole("button").first();
    // Gate the first press on the row being rendered AND marked current (both
    // arrive via SSE after route mount) — the chord's focus arm queries
    // `[aria-current="page"]` at press time.
    await expect(rowButton).toHaveAttribute("aria-current", "page", {
      timeout: READY_TIMEOUT,
    });

    // Visible + focus outside → focus the current window's row; the roving
    // tab stop syncs to the row's treeitem (the Wave-2 #262 invariant).
    await page.keyboard.press(CHORD_SIDEBAR);
    await expect(rowButton).toBeFocused({ timeout: READY_TIMEOUT });
    await expect(windowRow(page, id)).toHaveAttribute("tabindex", "0");
    await expect(sidebarAside(page)).toBeVisible();

    // Escape returns focus to the remembered surface (the tty default — the
    // sidebar records nothing) WITHOUT hiding. The row flyout, if keyboard
    // focus opened it, gets Escape first-refusal (the nav handler is layered
    // after its dismiss), so allow one dismiss press before the return press.
    for (let i = 0; i < 2 && !(await isXtermFocused(page)); i++) {
      await page.keyboard.press("Escape");
    }
    await expectActiveElement(page, "xterm");
    await expect(sidebarAside(page)).toBeVisible();

    // Focus the row again, then ⌘B from INSIDE the sidebar → hide + return.
    await page.keyboard.press(CHORD_SIDEBAR);
    await expect(rowButton).toBeFocused({ timeout: READY_TIMEOUT });
    await page.keyboard.press(CHORD_SIDEBAR);
    await expect(sidebarAside(page)).toHaveCount(0);
    await expectActiveElement(page, "xterm");

    // Hidden → open + focus the row (deferred past the mount commit).
    await page.keyboard.press(CHORD_SIDEBAR);
    await expect(sidebarAside(page)).toBeVisible();
    await expect(rowButton).toBeFocused({ timeout: READY_TIMEOUT });
  });
});
