import { test, expect } from "@playwright/test";
import { execFileSync, execSync } from "node:child_process";
import { pinWindow } from "./_boards";
import { reserveDeadPort } from "./_ports";
import { expectActiveElement, openPalette, READY_TIMEOUT, resolveWindow, seedComposeStrip } from "./_ready";
import { TMUX_SERVER, createSession, killSession, listWindows, stampWebTab } from "./_tmux";

/**
 * Docked compose strip e2e coverage. The strip replaces the modal
 * ComposeBuffer: a single global surface toggled by the `a▏` chip /
 * `Compose: Toggle` palette action, persisted as a chrome preference and ON BY
 * DEFAULT (only an explicit stored "false" reads off), sending to the LIVE
 * focused pane. The tests in the main describe start from the explicit
 * opt-out — a `beforeEach` seeds `hexokit-compose-strip=false` — so their
 * "enable via the chip" flows stay literal; the nested "on by default"
 * describe drops that seed and proves the default itself (the first-render
 * notice, the desktop first-visit focus landing in the textarea, the
 * Escape hand-off to the pane, and the tab-walk chords still stepping windows
 * from the focused textarea — the navigation family carries `ignoreInputs`). The compose SURFACE always mounts at its dock: the
 * preference picks the FORM — the expanded strip, or a one-row collapsed
 * tongue (`compose-tongue`: `a▏` glyph, "Compose", the `compose-toggle` chord
 * as a `<kbd>` on fine pointers) whose click expands the strip. An enabled strip
 * with no focused terminal collapses to an inert no-target tongue
 * (`data-state="no-target"`) instead of a disabled card. It renders at exactly one of TWO docks: INSIDE the
 * first tty tile on the desktop terminal route (single-send — the tile frame
 * makes the target self-evident), or full-width at the shell footer (selection
 * broadcast, the board route, mobile, no-tty layouts). The dock split doubles
 * as the mode signal: in-tile = sends to this terminal, footer =
 * broadcast/fallback. Enter matrix (terminal-faithful): plain Enter = verified
 * insert-line (stages the text without Enter and clears the draft; empty Enter
 * is a full no-op);
 * Cmd/Ctrl+Enter = submit; EMPTY textarea sends a bare Enter; Alt+Enter =
 * chord-only byte-exact raw insert; Shift+Enter is the only local newline.
 * Every terminal-target intent uses `POST /api/windows/:id/send`; the backend
 * chooses bracketed verified delivery, byte-exact raw delivery, or bare Enter.
 * Drafts are PER TARGET: keyed by the
 * focused window and persisted (text only) to localStorage, so they stay with
 * their addressee across navigation, dock flips, and survive reloads.
 * Both docks are container-aligned — no measurement, no inline margin/width
 * styles. The layout is ONE card model on both pointers: with no draft it is a
 * single compact row (📎 · a| on fine · textarea · Send); the card — a
 * bordered box holding the full-width transparent textarea with a quiet chip
 * row below it — morphs in on per-pointer triggers (coarse: focus /
 * multi-line draft / attachments; fine: draft presence with a hysteresis
 * latch released only by blur-while-empty). The `a|` closer is dropped on
 * coarse, the ⏎ chip hides while the composer is empty, and the fine header
 * folds at the in-tile dock (the tile frame names the target; the footer dock
 * and broadcast keep it). Once a send records history, the card adds an ↑ chip
 * that opens a fixed-position, portalled newest-first list on touch and fine
 * pointers alike; choosing a row loads the text back into the textarea and
 * never sends it.
 *
 * Shared setup: `beforeAll` creates two tmux sessions on the `rk-test-e2e`
 * server — `e2e-compose-<ts>`, a single window running `cat` so STDIN typed
 * via the strip echoes back into the pane (its window carries a stamped web tab,
 * stamped up front: the backend's window payload refreshes on an interval, and
 * the split-layout test's web tile reads the active web tab from it), and
 * `e2e-compose-board-<ts>`, two named windows (`cs-alpha`, `cs-bravo`) pinned
 * to a fresh per-run-unique board (`cs<digits>`) for the target-label test.
 * `afterAll` breaks out of `cat` (C-c) and kills both sessions. Each test
 * resolves the tmux `windowId` via `GET /api/sessions` (by session, optionally
 * by window name) with a 5s poll. The coarse-pointer coverage runs via a
 * nested touch-emulated describe (`hasTouch: true` flips Chromium's
 * `(pointer: coarse)` media query), which also pins the bottom bar hiding
 * while the textarea owns focus.
 */

const TERM_SESSION = `e2e-compose-${Date.now()}`;
const BOARD_SESSION = `e2e-compose-board-${Date.now()}`;
const BOARD_NAME = `cs${Date.now().toString().slice(-6)}`;

function tmux(cmd: string): void {
  execSync(`tmux -L ${TMUX_SERVER} ${cmd}`, { stdio: "ignore" });
}

function tmuxCapture(session: string): string {
  return execSync(`tmux -L ${TMUX_SERVER} capture-pane -p -t ${session}`, {
    encoding: "utf8",
  });
}

async function resolveWindowId(
  page: import("@playwright/test").Page,
  session: string,
  name?: string,
): Promise<string> {
  return (await resolveWindow(page, TMUX_SERVER, session, name)).windowId;
}

/** Bounding box or throw (a hidden/absent element is a real failure here). */
async function boxOf(
  locator: import("@playwright/test").Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no bounding box");
  return box;
}

/** Poll until the locator's left/width land within `tol` px of the target's —
 * used for the footer dock's full-width assertion (the box settles with the
 * layout, so a one-shot assert could catch it mid-paint). */
async function expectAlignedTo(
  locator: import("@playwright/test").Locator,
  target: { x: number; width: number },
  tol = 4,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const b = await locator.boundingBox();
        if (!b) return Infinity;
        return Math.max(Math.abs(b.x - target.x), Math.abs(b.width - target.width));
      },
      { timeout: 5_000 },
    )
    .toBeLessThanOrEqual(tol);
}

test.describe("Docked compose strip", () => {
  // Every test below starts from the explicit opt-out (the strip is on by
  // default); the "on by default" describe further down states its own seed.
  test.beforeEach(async ({ page }, testInfo) => {
    if (testInfo.titlePath.includes("on by default")) return;
    await seedComposeStrip(page, false);
  });

  test.beforeAll(async () => {
    // Terminal-route session runs `cat` so typed STDIN echoes into the pane —
    // this is how we verify Enter sends `text + \r` end-to-end.
    createSession(TERM_SESSION);
    tmux(`send-keys -t ${TERM_SESSION} 'cat' Enter`);
    // Stamp the slot-1 web tab up front: the split-layout test's web tile reads
    // the active tab
    // from the backend's window payload, which refreshes on an interval —
    // setting the option mid-test raced that propagation (a >10s cold wait).
    // The URL's port is a reserved-then-released ephemeral (dead by
    // construction — the split-layout test asserts dock placement, never
    // iframe content, so no proxy stub is needed).
    const first = listWindows(TERM_SESSION)[0];
    if (first) {
      stampWebTab(first.windowId, (await reserveDeadPort()).url);
    }
    // Board-route session with two named windows for the target-label test.
    createSession(BOARD_SESSION, { windows: ["cs-alpha", "cs-bravo"] });
  });

  test.afterAll(() => {
    try { tmux(`send-keys -t ${TERM_SESSION} C-c`); } catch { /* ok */ }
    killSession(TERM_SESSION);
    killSession(BOARD_SESSION);
  });

  /**
   * Proves: the `a▏` bottom-bar chip is an `aria-pressed` toggle that
   * shows/hides the strip; the toggle state persists across a page reload; and
   * the `Compose: Toggle` palette action toggles the same preference
   * (Constitution V palette parity).
   *
   * Steps:
   * 1. Resolve the first window of the `cat` session; navigate to
   *    `/<server>/<windowId>`.
   * 2. Wait for `.xterm-screen` to render.
   * 3. Assert the `Compose` chip has `aria-pressed="false"`, the collapsed
   *    tongue (`compose-tongue`) is visible and the textarea is absent (the
   *    seeded opt-out renders the tongue, not an empty dock).
   * 4. Click the chip; assert `aria-pressed="true"`, the textarea is visible and
   *    the tongue is gone.
   * 5. Reload the page; assert the chip is still pressed and the textarea still
   *    visible (the `hexokit-compose-strip` preference was persisted and
   *    rehydrated).
   * 6. Open the palette (`openPalette`), click `Compose: Toggle`; assert the chip
   *    returns to `aria-pressed="false"`, the textarea is gone and the tongue is
   *    back.
   */
  test("toggle via a▏ chip and via the command palette; persists across reload", async ({ page }) => {
    test.setTimeout(60_000);
    const windowId = await resolveWindowId(page, TERM_SESSION);
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });

    const chip = page.getByRole("button", { name: "Compose", exact: true });
    const input = page.getByTestId("compose-strip-input");
    const tongue = page.getByTestId("compose-tongue");

    // Seeded off: the chip is not pressed; the dock shows the collapsed
    // tongue, not an empty row and not a textarea.
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await expect(tongue).toBeVisible();
    await expect(tongue).toHaveText(/Compose/);
    await expect(input).toHaveCount(0);

    // Chip toggles it ON.
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(input).toBeVisible();
    await expect(tongue).toHaveCount(0);

    // Persistence: reload keeps it on.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Compose", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("compose-strip-input")).toBeVisible();

    // Command-palette parity: `Compose: Toggle` toggles it back OFF — to the
    // tongue.
    await openPalette(page);
    await page.getByRole("option", { name: "Compose: Toggle" }).click();
    await expect(page.getByRole("button", { name: "Compose", exact: true })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.getByTestId("compose-strip-input")).toHaveCount(0);
    await expect(page.getByTestId("compose-tongue")).toBeVisible();
  });

  /**
   * Proves: at the fine-pointer in-tile dock the strip's header row — and its × —
   * is folded (the tile frame names the target), so the `a|` chip is the
   * on-strip closer there: clicking it fires the same `toggleComposeStrip`
   * action as the `a▏` chip, collapsing the strip to the tongue INSIDE the same
   * tile and returning the chip to `aria-pressed="false"` — with no
   * confirmation dialog. Clicking the tongue re-expands the strip in place,
   * focuses the textarea, and the unsent draft survives the round trip (the
   * per-target module store outlives the body's unmount).
   *
   * Steps:
   * 1. Navigate to the `cat` session's window; wait for `.xterm-screen` and for
   *    the relay stream to attach (`window.__rkTerminals[windowId]` present) so
   *    the strip has a live target.
   * 2. Enable the strip via the `a▏` chip; fill the input with a unique draft
   *    marker.
   * 3. Assert `compose-strip-close` is ABSENT (the in-tile header fold); click
   *    the `a|` chip (`compose-strip-a-close`); assert the textarea is gone, the
   *    tongue (`compose-tongue`) is visible inside `surface-tile-tty`, and the
   *    chip reads `aria-pressed="false"` (same preference the chip toggles).
   * 4. Click the tongue to reopen; assert the input is visible, focused, and
   *    still holds the draft marker (closing was lossless — no confirmation
   *    needed).
   */
  test("the on-strip a| closes the strip (the in-tile header is folded); the draft survives close→reopen", async ({ page }) => {
    test.setTimeout(60_000);
    const windowId = await resolveWindowId(page, TERM_SESSION);
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
    // Wait for the relay stream to attach so the strip has a live target (the
    // textarea is disabled without one).
    await expect
      .poll(() => page.evaluate((w) => Boolean(window.__rkTerminals?.[w]), windowId), {
        timeout: 15_000,
      })
      .toBe(true);

    // Enable the strip via the `a▏` chip and type a draft.
    const chip = page.getByRole("button", { name: "Compose", exact: true });
    await chip.click();
    const input = page.getByTestId("compose-strip-input");
    await expect(input).toBeVisible();
    const draft = `CS_CLOSE_${Date.now()}`;
    await input.click();
    await input.fill(draft);

    // At the fine in-tile dock the header row — and its × — is folded (the
    // tile frame names the target), so the `a|` chip is the on-strip closer.
    // Same toggle as the `a▏` chip: no confirmation dialog appears.
    await expect(page.getByTestId("compose-strip-close")).toHaveCount(0);
    await page.getByTestId("compose-strip-a-close").click();
    await expect(input).toHaveCount(0);
    const tongue = page.getByTestId("surface-tile-tty").getByTestId("compose-tongue");
    await expect(tongue).toBeVisible();
    await expect(chip).toHaveAttribute("aria-pressed", "false");

    // Reopen via the tongue itself: the strip re-expands in place, takes
    // focus (the open transition), and the unsent draft survived the close
    // (the per-target module store outlives the body's unmount).
    await tongue.click();
    await expect(page.getByTestId("compose-strip-input")).toHaveValue(draft);
    await expect(page.getByTestId("compose-strip-input")).toBeFocused();
    await expect(page.getByTestId("compose-tongue")).toHaveCount(0);
  });

  /**
   * Proves: drafts are keyed by the send target (the focused window), not
   * shared globally: a draft typed for window A never shows while window B is
   * targeted (the draft does not "travel"), navigating back to A recalls A's
   * draft, and a page reload preserves the draft text (persisted to
   * localStorage under `hexokit-compose-drafts`).
   *
   * Steps:
   * 1. Resolve the `cs-alpha` and `cs-bravo` window IDs from the board session.
   * 2. Navigate to `cs-alpha`'s terminal route; enable the strip via the `a▏`
   *    chip; fill the input with a unique draft-A marker.
   * 3. Navigate to `cs-bravo`'s terminal route; wait for the strip input to be
   *    enabled (B is the focused target); assert the input is EMPTY (A's draft
   *    did not travel); fill a unique draft-B marker.
   * 4. Navigate back to `cs-alpha`; assert the input shows the draft-A marker
   *    (per-target recall).
   * 5. Reload the page; assert the input still shows the draft-A marker (text
   *    persistence survives a refresh).
   * 6. Navigate to `cs-bravo` again; assert the input shows the draft-B marker
   *    (B's draft stayed with B through the reload).
   */
  test("drafts are per-target and survive a reload (260801-cyth)", async ({ page }) => {
    test.setTimeout(60_000);
    const alpha = await resolveWindowId(page, BOARD_SESSION, "cs-alpha");
    const bravo = await resolveWindowId(page, BOARD_SESSION, "cs-bravo");

    // Window A: enable the strip and type a draft for A.
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(alpha)}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Compose", exact: true }).click();
    const input = page.getByTestId("compose-strip-input");
    await expect(input).toBeVisible();
    const draftA = `CSA_${Date.now()}`;
    await input.click();
    await input.fill(draftA);

    // Window B: the strip shows B's (empty) draft — A's did not travel.
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(bravo)}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
    await expect(input).toBeEnabled({ timeout: 15_000 }); // B is the focused target
    await expect(input).toHaveValue("");
    const draftB = `CSB_${Date.now()}`;
    await input.click();
    await input.fill(draftB);

    // Back on A: A's draft is recalled (and B's stays with B).
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(alpha)}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(input).toHaveValue(draftA, { timeout: 15_000 });

    // Refresh survival: a reload rehydrates the draft text from localStorage.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(input).toHaveValue(draftA, { timeout: 15_000 });

    // And B still has its own draft after the reload.
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(bravo)}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(input).toHaveValue(draftB, { timeout: 15_000 });
  });

  /**
   * Proves: plain Enter in the strip performs a verified insert-line and
   * clears the draft without pressing Enter in the pane, so the `cat` pane
   * shows one tty input echo. An EMPTY textarea + Enter is a FULL no-op (the
   * keydown is consumed — no local newline appears, nothing is sent).
   * Cmd/Ctrl+Enter remains the only submit chord, and Escape blurs the
   * textarea without closing the strip.
   *
   * Steps:
   * 1. Navigate to the `cat` session's window; wait for `.xterm-screen` and for
   *    the relay stream to attach (`window.__rkTerminals[windowId]` present).
   * 2. Enable the strip via the `a▏` chip; assert the input is visible.
   * 3. With the input empty, press Enter; assert the value stays `""` (no local
   *    newline — the keydown was consumed and nothing was sent).
   * 4. Fill the input with a unique marker and press Enter; assert the input
   *    clears to `""` and the strip stays visible.
   * 5. Poll `capture-pane` until the marker appears exactly once, proving the
   *    verified insert-line reached the pane without pressing Enter.
   * 6. Fill a second marker and press `ControlOrMeta+Enter`; assert the input
   *    clears; poll `capture-pane` until it contains the marker (proves
   *    `text + \r` still submits).
   * 7. Focus the input, press Escape; assert the input is no longer focused and
   *    the strip is still visible.
   */
  test("Enter stages the line; empty Enter is a no-op; Cmd/Ctrl+Enter submits; Escape blurs", async ({ page }) => {
    test.setTimeout(60_000);
    const windowId = await resolveWindowId(page, TERM_SESSION);
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
    // Wait for the relay stream to attach.
    await expect
      .poll(() => page.evaluate((w) => Boolean(window.__rkTerminals?.[w]), windowId), {
        timeout: 15_000,
      })
      .toBe(true);

    // Enable the strip.
    await page.getByRole("button", { name: "Compose", exact: true }).click();
    const input = page.getByTestId("compose-strip-input");
    await expect(input).toBeVisible();

    // Empty textarea + plain Enter = FULL no-op: the keydown is consumed, so
    // no local newline appears and nothing is sent (260802-lj98).
    await input.click();
    await input.press("Enter");
    await expect(input).toHaveValue("");

    const marker = `CSENT${Date.now()}`;
    await input.fill(marker);
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await expect(page.getByTestId("compose-strip")).toBeVisible();
    await expect
      .poll(
        () => (tmuxCapture(TERM_SESSION).match(new RegExp(marker, "g")) ?? []).length,
        { timeout: 10_000 },
      )
      .toBe(1);

    // Cmd/Ctrl+Enter — the ONLY submit chord — still sends `text + \r`.
    const chordMarker = `CSSUB${Date.now()}`;
    await input.fill(chordMarker);
    await input.press("ControlOrMeta+Enter");
    await expect(input).toHaveValue("");
    await expect
      .poll(() => tmuxCapture(TERM_SESSION), { timeout: 10_000 })
      .toContain(chordMarker);

    // Escape blurs the strip textarea (does NOT close the strip).
    await input.click();
    await expect(input).toBeFocused();
    await input.press("Escape");
    await expect(input).not.toBeFocused();
    await expect(page.getByTestId("compose-strip")).toBeVisible();
  });

  /**
   * Proves: a MULTI-LINE draft submitted with Cmd/Ctrl+Enter reaches the pane
   * with every line intact through the unified window-send route, and the
   * draft clears on delivery. On the `cat` pane
   * (no bracketed-paste mode requested) the paste degrades to raw bytes and
   * each line commits, so both markers echo back.
   *
   * Steps:
   * 1. Navigate to the `cat` session's window; wait for `.xterm-screen` and the
   *    relay stream (`window.__rkTerminals[windowId]`).
   * 2. Enable the strip via the `a▏` chip; click the input.
   * 3. Type marker A, press Shift+Enter (local newline), type marker B; assert
   *    the textarea holds both lines separated by `\n`.
   * 4. Press `ControlOrMeta+Enter`; assert the input clears to `""`.
   * 5. Poll `capture-pane` until it contains BOTH markers.
   */
  test("multi-line Cmd/Ctrl+Enter delivers every line", async ({ page }) => {
    test.setTimeout(60_000);
    const windowId = await resolveWindowId(page, TERM_SESSION);
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => page.evaluate((w) => Boolean(window.__rkTerminals?.[w]), windowId), {
        timeout: 15_000,
      })
      .toBe(true);

    await page.getByRole("button", { name: "Compose", exact: true }).click();
    const input = page.getByTestId("compose-strip-input");
    await expect(input).toBeVisible();
    await input.click();

    const lineA = `CSMLA${Date.now()}`;
    const lineB = `CSMLB${Date.now()}`;
    await input.pressSequentially(lineA);
    await input.press("Shift+Enter");
    await input.pressSequentially(lineB);
    await expect(input).toHaveValue(`${lineA}\n${lineB}`);

    await input.press("ControlOrMeta+Enter");
    await expect(input).toHaveValue("");

    await expect
      .poll(() => tmuxCapture(TERM_SESSION), { timeout: 10_000 })
      .toContain(lineA);
    await expect
      .poll(() => tmuxCapture(TERM_SESSION), { timeout: 10_000 })
      .toContain(lineB);
  });

  /**
   * Proves: a SINGLE-line Cmd/Ctrl+Enter submit uses the unified `/send`
   * request and reaches the active pane without writing through the relay.
   *
   * Steps:
   * 1. Navigate to the `cat` session's window and wait for the terminal stream.
   * 2. Enable the compose strip and fill it with a unique single-line marker.
   * 3. Start observing the window's `/send` request, then press
   *    `ControlOrMeta+Enter` and assert its body carries `mode: "submit"`.
   * 4. Assert the draft clears and poll `capture-pane` for the marker.
   */
  test("single-line Cmd/Ctrl+Enter reaches the pane through send", async ({ page }) => {
    test.setTimeout(60_000);
    const windowId = await resolveWindowId(page, TERM_SESSION);
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => page.evaluate((w) => Boolean(window.__rkTerminals?.[w]), windowId), {
        timeout: 15_000,
      })
      .toBe(true);

    await page.getByRole("button", { name: "Compose", exact: true }).click();
    const input = page.getByTestId("compose-strip-input");
    const marker = `CSSINGLE${Date.now()}`;
    await input.fill(marker);

    const sendRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === "POST" && url.pathname.endsWith(`/api/windows/${encodeURIComponent(windowId)}/send`);
    });
    await input.press("ControlOrMeta+Enter");
    const request = await sendRequest;
    expect(request.postDataJSON()).toEqual({ text: marker, mode: "submit" });
    await expect(input).toHaveValue("");
    await expect
      .poll(() => tmuxCapture(TERM_SESSION), { timeout: 10_000 })
      .toContain(marker);
  });

  /**
   * Proves: Alt+Enter — the chord-only raw insert — delivers the byte-exact
   * text WITHOUT any trailing byte (staged on the pane's input line, appearing
   * exactly once), with the same clear-on-delivery as a submit. An empty
   * Cmd/Ctrl+Enter then sends a bare `\r` ("press Enter in the pane"),
   * committing the staged line — the keyboard-complete stage-then-submit loop.
   * The Insert button follows Enter (verified insert-line): it stages text
   * without Enter on the `cat` pane. Also asserts `enterkeyhint="send"` (the
   * truthful keyboard hint — Enter transmits the line).
   *
   * Steps:
   * 1. Navigate to the `cat` session's window; wait for `.xterm-screen` and the
   *    relay stream to attach.
   * 2. Enable the strip via the `a▏` chip; assert the input is visible and
   *    carries `enterkeyhint="send"`.
   * 3. Fill a unique staged marker and press `Alt+Enter`.
   * 4. Assert the input clears (same clear-on-delivery as submit).
   * 5. Poll `capture-pane` until it contains the staged marker; assert it
   *    appears EXACTLY once — the tty echo of the input line (a committed line
   *    would appear twice: input echo + `cat`'s output line).
   * 6. With the input now EMPTY, press `ControlOrMeta+Enter` (bare `\r`); poll
   *    `capture-pane` until the staged marker appears at least twice — proving
   *    the raw insert was truly staged and the empty chord truly pressed Enter.
   * 7. Fill a second marker and click the `Insert` button
   *    (`compose-strip-insert`); assert the input clears; poll `capture-pane`
   *    until that marker appears exactly once (the button staged it without
   *    pressing Enter).
   */
  test("Alt+Enter stages raw text; empty Cmd/Ctrl+Enter presses Enter in the pane; Insert button inserts the line (260802-lj98)", async ({ page }) => {
    test.setTimeout(60_000);
    const windowId = await resolveWindowId(page, TERM_SESSION);
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => page.evaluate((w) => Boolean(window.__rkTerminals?.[w]), windowId), {
        timeout: 15_000,
      })
      .toBe(true);

    await page.getByRole("button", { name: "Compose", exact: true }).click();
    const input = page.getByTestId("compose-strip-input");
    await expect(input).toBeVisible();
    // Enter transmits the line to the pane (insert-line) and clears the
    // draft, so the keyboard hint states the "send" action.
    await expect(input).toHaveAttribute("enterkeyhint", "send");

    // Alt+Enter — the chord-only raw insert: byte-exact text with NO trailing
    // byte, staged on cat's input line, never committed.
    const staged = `CSRAW${Date.now()}`;
    await input.click();
    await input.fill(staged);
    await input.press("Alt+Enter");
    // Same clear-on-delivery as submit; the strip stays open.
    await expect(input).toHaveValue("");
    await expect
      .poll(() => tmuxCapture(TERM_SESSION), { timeout: 10_000 })
      .toContain(staged);
    // Exactly ONE occurrence — the tty echo of the staged input line. A
    // committed line would appear twice (input echo + cat's output line).
    expect(
      (tmuxCapture(TERM_SESSION).match(new RegExp(staged, "g")) ?? []).length,
    ).toBe(1);

    // The stage-then-submit loop: the textarea is now EMPTY, and Cmd/Ctrl+Enter
    // on an empty textarea sends a bare `\r` — "press Enter in the pane" —
    // committing the previously-staged line (it now appears a second time as
    // cat's echoed output line). This proves both halves of the loop: the raw
    // insert really was staged, and the empty chord really pressed Enter.
    await input.press("ControlOrMeta+Enter");
    await expect
      .poll(
        () => (tmuxCapture(TERM_SESSION).match(new RegExp(staged, "g")) ?? []).length,
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(2);

    const inserted = `CSINS${Date.now()}`;
    await input.fill(inserted);
    await page.getByTestId("compose-strip-insert").click();
    await expect(input).toHaveValue("");
    await expect
      .poll(
        () => (tmuxCapture(TERM_SESSION).match(new RegExp(inserted, "g")) ?? []).length,
        { timeout: 10_000 },
      )
      .toBe(1);
  });

  /**
   * Proves: on the board route, the strip's `→ {window}` target label tracks
   * the focused pane. Cycling focus with `Cmd+]` / `Cmd+[` updates the label to
   * the newly-focused pane's window name — the live-target signal.
   *
   * Steps:
   * 1. Resolve `cs-alpha` and `cs-bravo` window IDs; POST
   *    `/api/boards/<name>/pin` for both.
   * 2. Navigate to `/board/<name>`; assert two `.xterm` instances mount.
   * 3. Enable the strip via the `a▏` chip; assert the target label is visible
   *    and the strip textarea took focus (focus-on-open), then press Escape to
   *    blur it — the pane-cycle chords are suppressed while a real text input
   *    owns focus.
   * 4. Assert the label reads `cs-alpha` (initial focused pane, index 0).
   * 5. Press `Meta+]`; assert the label updates to `cs-bravo`.
   * 6. Press `Meta+[`; assert the label returns to `cs-alpha`.
   */
  test("target label follows the focused board pane", async ({ page }) => {
    test.setTimeout(60_000);
    const alpha = await resolveWindowId(page, BOARD_SESSION, "cs-alpha");
    const bravo = await resolveWindowId(page, BOARD_SESSION, "cs-bravo");
    for (const winId of [alpha, bravo]) {
      await pinWindow(page.request, BOARD_NAME, TMUX_SERVER, winId);
    }

    await page.goto(`/board/${BOARD_NAME}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".xterm")).toHaveCount(2, { timeout: 15_000 });

    // Enable the strip on the board route. Opening focuses the strip's
    // textarea (focus-on-open, 260801-sm6g) — blur it with Escape so the
    // board pane-cycle chords below aren't input-suppressed.
    await page.getByRole("button", { name: "Compose", exact: true }).click();
    const label = page.getByTestId("compose-strip-target");
    await expect(label).toBeVisible();
    await expect(page.getByTestId("compose-strip-input")).toBeFocused();
    await page.keyboard.press("Escape");

    // Initial focused pane is index 0 (cs-alpha). Cycle focus to pane 1 and
    // assert the target label follows to cs-bravo.
    await expect(label).toHaveText("cs-alpha");
    await page.keyboard.press("Meta+]");
    await expect(label).toHaveText("cs-bravo");
    await page.keyboard.press("Meta+[");
    await expect(label).toHaveText("cs-alpha");
  });

  /**
   * Proves: on a `split-h:tty,web` terminal layout, the compose strip renders
   * as a DESCENDANT of the tty tile's frame (below the terminal body, inside
   * the tile), never in the shell footer, and carries no pane-alignment inline
   * styles — the in-tile dock is container-aligned by construction. Zooming the
   * tile carries the strip with it (the dock rides the tile).
   *
   * Steps:
   * 1. Set a 1440×800 viewport; resolve the `cat` session's window (its slot-1
   *    web tab was stamped in `beforeAll` — the backend's window payload
   *    refreshes on an interval, so a mid-test set raced that propagation; the
   *    iframe content is never asserted).
   * 2. Navigate to `/<server>/<windowId>?layout=split-h:tty,web`; wait for the
   *    `Connected` dot and both `surface-tile-tty` and `surface-tile-web`.
   * 3. Enable the strip via the `a▏` chip.
   * 4. Assert `compose-strip` is visible INSIDE `surface-tile-tty` and absent
   *    from the shell `<footer>`; assert `compose-strip-inner` has no inline
   *    `margin-left`/`width` style.
   * 5. Click the tty tile's `Expand Terminal` verb; assert the strip is still
   *    inside the tile and still absent from the footer.
   */
  test("the strip docks INSIDE the tty tile on a desktop terminal route (260813-j3jb)", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 800 });
    const windowId = await resolveWindowId(page, TERM_SESSION);
    // The slot-1 web tab was stamped in beforeAll (the backend payload
    // refreshes on an interval — setting it here raced that propagation). The
    // iframe src is
    // deterministic regardless of whether anything listens there (we assert
    // dock placement, never iframe content).
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}?layout=split-h:tty,web`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({ timeout: READY_TIMEOUT });
    const ttyTile = page.getByTestId("surface-tile-tty");
    await expect(ttyTile).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("surface-tile-web")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Compose", exact: true }).click();
    const strip = page.getByTestId("compose-strip");
    await expect(strip).toBeVisible();

    // In-tile dock: the strip is a DESCENDANT of the tty tile's frame (below
    // the terminal body) — and NOT in the shell footer.
    await expect(ttyTile.getByTestId("compose-strip")).toBeVisible();
    await expect(page.locator("footer").getByTestId("compose-strip")).toHaveCount(0);
    // It carries no pane-alignment inline styles (container-aligned by
    // construction — 260812-fryz's measurement hack is retired).
    await expect(page.getByTestId("compose-strip-inner")).not.toHaveAttribute(
      "style",
      /margin-left|width/,
    );

    // Zooming the tty tile carries the strip with it (the dock rides the tile).
    await ttyTile.getByRole("button", { name: "Expand Terminal" }).click();
    await expect(ttyTile.getByTestId("compose-strip")).toBeVisible();
    await expect(page.locator("footer").getByTestId("compose-strip")).toHaveCount(0);
  });

  /**
   * Proves: the board route has no surface tiles, so the strip docks at the
   * shell footer — a child of `<footer>`, never inside a board pane — and spans
   * the full row with no inline alignment styles. The fine footer dock KEEPS
   * the header row (no tile frame names the target there), so the × close
   * renders and collapses the strip to the footer tongue.
   *
   * Steps:
   * 1. Set a 1440×800 viewport; resolve `cs-alpha`/`cs-bravo`; pin both to a
   *    fresh per-run board (`csa<digits>`).
   * 2. Navigate to the board; assert two `.xterm` instances mount.
   * 3. Enable the strip via the `a▏` chip; assert the inner wrapper is visible.
   * 4. Assert the strip is a descendant of `<footer>` and NOT inside
   *    `board pane cs-alpha`.
   * 5. Measure the strip's outer row; poll until the inner wrapper spans it
   *    (±2px) and assert no `margin-left` inline style.
   * 6. Assert the header's target label is visible (the footer dock keeps the
   *    header); click the × (`compose-strip-close`); assert the strip is gone.
   */
  test("the board route docks the strip at the shell footer, full width (260813-j3jb)", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 800 });
    const alpha = await resolveWindowId(page, BOARD_SESSION, "cs-alpha");
    const bravo = await resolveWindowId(page, BOARD_SESSION, "cs-bravo");
    // A second, per-run-unique board so this test's pins never tangle with the
    // target-label test's board above.
    const alignBoard = `csa${Date.now().toString().slice(-6)}`;
    for (const winId of [alpha, bravo]) {
      await pinWindow(page.request, alignBoard, TMUX_SERVER, winId);
    }

    await page.goto(`/board/${alignBoard}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".xterm")).toHaveCount(2, { timeout: 15_000 });

    await page.getByRole("button", { name: "Compose", exact: true }).click();
    const strip = page.getByTestId("compose-strip");
    const inner = page.getByTestId("compose-strip-inner");
    await expect(inner).toBeVisible();

    // The board has no surface tiles, so the strip docks at the shell footer —
    // a child of <footer>, never inside a board pane — and spans the FULL row
    // (no pane alignment on this dock).
    await expect(page.locator("footer").getByTestId("compose-strip")).toBeVisible();
    await expect(
      page.getByRole("group", { name: "board pane cs-alpha" }).getByTestId("compose-strip"),
    ).toHaveCount(0);
    const rowBox = await boxOf(strip);
    await expectAlignedTo(inner, rowBox, 2);
    await expect(inner).not.toHaveAttribute("style", /margin-left/);

    // The fine footer dock KEEPS the header (no tile frame names the target
    // here), so the × close renders — and collapses the strip to the tongue,
    // still at the footer dock.
    await expect(page.getByTestId("compose-strip-target")).toBeVisible();
    await page.getByTestId("compose-strip-close").click();
    await expect(page.getByTestId("compose-strip-input")).toHaveCount(0);
    await expect(page.locator("footer").getByTestId("compose-tongue")).toBeVisible();
  });

  /**
   * Proves: on a desktop terminal route the strip starts inside the tty tile
   * (single-send); activating selection broadcast (`Selection: Send prompt to
   * N agents` — a frozen multi-window target, a shell-level concern) moves the
   * strip to the shell footer, where it renders full width with the
   * `2 selected` target label. The dock split IS the mode signal.
   *
   * Steps:
   * 1. Set a 1440×800 viewport; resolve `cs-alpha`/`cs-bravo` and navigate to
   *    cs-alpha's terminal route (`/<server>/<windowId>`); wait for the
   *    `Connected` dot and the tty tile.
   * 2. Enable the strip via the `a▏` chip; assert it renders INSIDE
   *    `surface-tile-tty`; press Escape to blur the textarea (focus-on-open).
   * 3. Cmd/Ctrl-click both window rows in the sidebar tree to select them.
   * 4. Open the palette (`openPalette`), run `Selection: Send prompt to 2 agents`;
   *    assert the strip's target label reads `2 selected`.
   * 5. Assert the strip is gone from the tty tile and visible inside
   *    `<footer>`; measure the outer row and poll until the inner wrapper spans
   *    it (±2px); assert no `margin-left` inline style.
   */
  test("selection broadcast flips the strip from the tile to the footer dock (260813-j3jb)", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 800 });
    const alpha = await resolveWindowId(page, BOARD_SESSION, "cs-alpha");
    const bravo = await resolveWindowId(page, BOARD_SESSION, "cs-bravo");

    // Start on cs-alpha's TERMINAL route with the strip enabled: single-send
    // mode docks it inside the tty tile.
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(alpha)}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({ timeout: READY_TIMEOUT });
    const ttyTile = page.getByTestId("surface-tile-tty");
    await expect(ttyTile).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Compose", exact: true }).click();
    await expect(ttyTile.getByTestId("compose-strip")).toBeVisible();
    // Focus-on-open grabbed the textarea; blur it so nothing below is
    // input-suppressed.
    await page.keyboard.press("Escape");

    // Select both windows in the sidebar tree, then open the broadcast strip
    // via the palette action (no send — dock placement only).
    for (const winId of [alpha, bravo]) {
      const row = page.locator(`[data-row-key="${TMUX_SERVER}:${winId}"] button`).first();
      await expect(row).toBeVisible({ timeout: 10_000 });
      await row.click({ modifiers: ["ControlOrMeta"] });
    }
    const paletteInput = await openPalette(page);
    await paletteInput.fill("Selection: Send prompt to 2 agents");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("compose-strip-target")).toHaveText("2 selected");

    // The flip: broadcast is a shell-level concern, so the strip leaves the
    // tile and renders at the shell footer — full width, no alignment styles.
    await expect(ttyTile.getByTestId("compose-strip")).toHaveCount(0);
    const footerStrip = page.locator("footer").getByTestId("compose-strip");
    await expect(footerStrip).toBeVisible();
    const rowBox = await boxOf(footerStrip);
    await expectAlignedTo(page.getByTestId("compose-strip-inner"), rowBox, 2);
    await expect(page.getByTestId("compose-strip-inner")).not.toHaveAttribute(
      "style",
      /margin-left/,
    );
  });

  /**
   * Proves: at a 375px viewport the tile chrome does not render, so the strip
   * docks at the shell footer (never inside the chromeless tile) and causes no
   * page-level horizontal overflow — its visible box stays fully inside the
   * viewport. With a fine pointer (viewport-only emulation), focus-on-open does
   * NOT morph the strip (the fine trigger is draft presence, never focus), and
   * the first character morphs it to the card — still without overflow.
   *
   * Steps:
   * 1. Set a 375×812 viewport; navigate to the `cat` session's window; wait for
   *    the terminal (no `Connected` dot on mobile — the sidebar is an unmounted
   *    drawer).
   * 2. Enable the strip via the palette (`openPalette` → `Compose: Toggle`) — at 375px
   *    with a fine pointer neither bar renders (the bottom bar is
   *    pointer-gated to coarse, the status bar width-gated to desktop), so the
   *    keyboard-first path is the opener; assert the inner wrapper is visible
   *    and the strip is a descendant of `<footer>`.
   * 3. Assert `compose-strip-card` is ABSENT (fine focus never morphs — the
   *    strip stays a compact single row).
   * 4. Poll `document.documentElement.scrollWidth` until ≤ 375 (no horizontal
   *    page overflow); assert the inner box's `x ≥ 0` and `x + width ≤ 375`.
   * 5. Fill the input with a two-line draft; assert `compose-strip-card`
   *    renders (draft presence morphs to the card) and `scrollWidth` stays
   *    ≤ 375.
   */
  test("375px mobile: the strip docks at the shell footer with no horizontal overflow (260813-j3jb)", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 375, height: 812 });
    const windowId = await resolveWindowId(page, TERM_SESSION);
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`, {
      waitUntil: "domcontentloaded",
    });
    // No `Connected` dot on mobile (the sidebar is an unmounted drawer) — gate
    // on the terminal itself.
    await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 15_000 });

    // 260814-ldbs: at 375px with a FINE pointer (viewport-only emulation)
    // neither bar renders — the bottom bar is pointer-gated to coarse and the
    // status bar is width-gated to desktop — so the keyboard-first palette
    // path (Constitution V) is the opener here.
    await openPalette(page);
    await page.getByRole("option", { name: "Compose: Toggle" }).click();
    const inner = page.getByTestId("compose-strip-inner");
    await expect(inner).toBeVisible();
    const input = page.getByTestId("compose-strip-input");

    // Fine pointer (viewport-only emulation): opening focused the textarea,
    // but focus NEVER morphs on fine — the strip stays a compact single row
    // until the first character.
    await expect(page.getByTestId("compose-strip-card")).toHaveCount(0);

    // Mobile renders no tile chrome, so the strip docks at the shell footer —
    // never inside the (chromeless) tile — and causes no page-level
    // horizontal overflow; the visible box stays fully inside the viewport.
    await expect(page.locator("footer").getByTestId("compose-strip")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(375);
    const innerBox = await boxOf(inner);
    expect(innerBox.x).toBeGreaterThanOrEqual(0);
    expect(innerBox.x + innerBox.width).toBeLessThanOrEqual(375);

    // The first character morphs to the card (full-width textarea, chips
    // below) — still with no horizontal overflow.
    await input.fill("line one\nline two");
    await expect(page.getByTestId("compose-strip-card")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(375);
  });

  /**
   * Proves: with the preference off, the desktop terminal route renders the
   * collapsed tongue INSIDE the first tty tile (the same dock the expanded
   * strip uses), as a `Show compose strip` button carrying the `a▏` glyph, the
   * "Compose" label, and the platform `compose-toggle` chord in a `<kbd>` (fine
   * pointers show chords). It is a single compact row. Clicking it enables the
   * preference, mounts the expanded strip in the same tile, and focuses the
   * textarea (the open transition).
   *
   * Steps:
   * 1. Set a 1440×800 viewport; navigate to the `cat` window with
   *    `?layout=split-h:tty,web`; wait for both tiles.
   * 2. Assert `compose-tongue` is a descendant of `surface-tile-tty`, absent
   *    from `<footer>`, has the accessible name `Show compose strip`, contains
   *    "Compose", and its `<kbd>` text is the platform chord (`⌘I` or `Shift+Ctrl+E`).
   * 3. Assert the tongue's height is at most 36px.
   * 4. Click the tongue; assert `compose-strip-input` is visible inside the tty
   *    tile and focused, the tongue is gone, and the `Compose` chip reads
   *    `aria-pressed="true"`.
   */
  test("the collapsed tongue renders at the in-tile dock with the chord; clicking it expands and focuses", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 800 });
    const windowId = await resolveWindowId(page, TERM_SESSION);
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}?layout=split-h:tty,web`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({ timeout: READY_TIMEOUT });
    const ttyTile = page.getByTestId("surface-tile-tty");
    await expect(ttyTile).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("surface-tile-web")).toBeVisible({ timeout: 15_000 });

    const tongue = ttyTile.getByTestId("compose-tongue");
    await expect(tongue).toBeVisible();
    await expect(page.locator("footer").getByTestId("compose-tongue")).toHaveCount(0);
    await expect(tongue).toHaveAccessibleName("Show compose strip");
    await expect(tongue).toHaveAttribute("aria-expanded", "false");
    await expect(tongue).toContainText("a▏");
    await expect(tongue).toContainText("Compose");
    await expect(tongue.locator("kbd")).toHaveText(/^(⌘I|Shift\+Ctrl\+E)$/);
    const box = await boxOf(tongue);
    expect(box.height).toBeLessThanOrEqual(36);

    await tongue.click();
    const input = ttyTile.getByTestId("compose-strip-input");
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
    await expect(page.getByTestId("compose-tongue")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Compose", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  /**
   * Proves: an ENABLED strip with no focused terminal collapses to the inert
   * no-target tongue at the footer dock instead of a disabled card: a
   * `role="status"` line (`data-state="no-target"`) reading the recovery copy,
   * with no textarea, no Send, no attach chip, no `→ no target` header, and no
   * chord hint. The tmux Server route (`/<server>`, no window) is the
   * route-level way to reach that state — no terminal mounts, so nothing
   * registers as the focused terminal.
   *
   * Steps:
   * 1. Seed `hexokit-compose-strip=true` via an init script; navigate to
   *    `/<server>`; wait for the status bar to report Connected.
   * 2. Assert `compose-tongue` is a descendant of `<footer>` with
   *    `data-state="no-target"` and `role="status"`, reading
   *    `No focused terminal — click a pane to target it`.
   * 3. Assert `compose-strip-input`, `compose-strip-send`, `compose-strip-target`
   *    are absent and the tongue has no `<kbd>`.
   */
  test("an enabled strip with no focused terminal shows the inert no-target tongue at the footer dock", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.addInitScript(() => localStorage.setItem("hexokit-compose-strip", "true"));
    await page.goto(`/${TMUX_SERVER}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({ timeout: READY_TIMEOUT });

    const tongue = page.locator("footer").getByTestId("compose-tongue");
    await expect(tongue).toBeVisible();
    await expect(tongue).toHaveAttribute("data-state", "no-target");
    await expect(tongue).toHaveAttribute("role", "status");
    await expect(tongue).toContainText("No focused terminal — click a pane to target it");
    await expect(tongue.locator("kbd")).toHaveCount(0);
    await expect(page.getByTestId("compose-strip-input")).toHaveCount(0);
    await expect(page.getByTestId("compose-strip-send")).toHaveCount(0);
    await expect(page.getByTestId("compose-strip-target")).toHaveCount(0);
  });

  /**
   * Proves: on the BOARD route an enabled strip follows the board's own focus
   * authority — an EMPTY board (no pinned panes, so no `BoardPane` registers a
   * focused terminal) shows the inert no-target tongue at the footer dock and
   * none of the disabled card's controls; pinning a window mounts its pane,
   * which registers itself as the focused terminal on mount, and the expanded
   * strip replaces the tongue with that pane as its target.
   *
   * Steps:
   * 1. Seed `hexokit-compose-strip=true` via an init script; navigate to a
   *    fresh, empty per-run board (`csnt<digits>`); wait for its empty-state
   *    copy ("No panes pinned to this board yet").
   * 2. Assert `compose-tongue` inside `<footer>` has `data-state="no-target"`
   *    and the recovery copy; assert `compose-strip-input`, `compose-strip-send`
   *    and `compose-strip-target` are absent.
   * 3. Pin `cs-alpha` to the board through the API; wait for its `.xterm`.
   * 4. Assert the tongue is gone and `compose-strip-input` is visible in
   *    `<footer>` with `compose-strip-target` reading `cs-alpha`.
   */
  test("board route: an empty board shows the no-target tongue; pinning a pane swaps in the expanded strip", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.addInitScript(() => localStorage.setItem("hexokit-compose-strip", "true"));
    const board = `csnt${Date.now().toString().slice(-6)}`;
    const alpha = await resolveWindowId(page, BOARD_SESSION, "cs-alpha");

    await page.goto(`/board/${board}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText(/No panes pinned to this board yet/)).toBeVisible({ timeout: 15_000 });

    const tongue = page.locator("footer").getByTestId("compose-tongue");
    await expect(tongue).toBeVisible();
    await expect(tongue).toHaveAttribute("data-state", "no-target");
    await expect(tongue).toContainText("No focused terminal — click a pane to target it");
    await expect(page.getByTestId("compose-strip-input")).toHaveCount(0);
    await expect(page.getByTestId("compose-strip-send")).toHaveCount(0);
    await expect(page.getByTestId("compose-strip-target")).toHaveCount(0);

    // Pin a pane: the board mounts it as the initial focused pane, which
    // registers the focused terminal — the strip's target appears.
    await pinWindow(page.request, board, TMUX_SERVER, alpha);
    await expect(page.locator(".xterm")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId("compose-tongue")).toHaveCount(0);
    await expect(page.locator("footer").getByTestId("compose-strip-input")).toBeVisible();
    await expect(page.getByTestId("compose-strip-target")).toHaveText("cs-alpha");
  });

  /**
   * Proves: a file pasted while the strip is collapsed still reaches the
   * compose flow — the terminal's document-level paste forward enables the
   * preference and hands the file over; the expanded body mounts and its
   * mount-time drain uploads it, inserting the returned path as a line in the
   * textarea. The upload endpoint is stubbed so the test never writes into a
   * worktree.
   *
   * Steps:
   * 1. Stub `POST /api/sessions/:session/upload` to return a fixed path.
   * 2. Navigate to the `cat` window (preference off); wait for the relay stream
   *    to attach and for the window's sidebar row (the session identity the
   *    upload is scoped to); assert the tongue is visible and the textarea
   *    absent.
   * 3. Dispatch a real `ClipboardEvent("paste")` carrying a PNG `File` on
   *    `document.body` (outside any xterm textarea and the quake terminal).
   * 4. Assert the textarea appears and its value contains the stubbed path; the
   *    `compose-strip-uploading` status has cleared; the tongue is gone.
   */
  test("a file pasted while collapsed expands the strip and uploads", async ({ page }) => {
    test.setTimeout(60_000);
    const uploadedPath = `/tmp/e2e-wt/.uploads/${Date.now()}-shot.png`;
    await page.route(/\/api\/sessions\/[^/?]+\/upload(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, path: uploadedPath }),
      }),
    );
    const windowId = await resolveWindowId(page, TERM_SESSION);
    await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => page.evaluate((w) => Boolean(window.__rkTerminals?.[w]), windowId), {
        timeout: 15_000,
      })
      .toBe(true);
    // The upload is scoped to the focused terminal's SESSION, which the
    // terminal registers once the session list has delivered — wait for the
    // sidebar row so the paste never lands on an unnamed target.
    await expect(
      page.locator(`[data-row-key="${TMUX_SERVER}:${windowId}"]`).first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("compose-tongue")).toBeVisible();
    await expect(page.getByTestId("compose-strip-input")).toHaveCount(0);

    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["fake-png"], "shot.png", { type: "image/png" }));
      document.body.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    });

    const input = page.getByTestId("compose-strip-input");
    await expect(input).toBeVisible();
    await expect(input).toHaveValue(new RegExp(uploadedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await expect(page.getByTestId("compose-strip-uploading")).toHaveCount(0);
    await expect(page.getByTestId("compose-tongue")).toHaveCount(0);
  });


  // The default itself. No seed here: a fresh context has no stored preference,
  // so the strip renders expanded and the desktop restore router's first-visit
  // resolver lands focus in its textarea.
  test.describe("on by default", () => {

    /**
     * Proves: with no stored preference the strip is on, and a fresh desktop
     * navigation lands focus in its textarea with no click — the first
     * keystroke goes to the compose strip, not the pane. The one-time notice
     * names the platform chord (Playwright's Desktop Chrome pins a Windows UA,
     * so the win/linux face), and a reload — a second fresh load with the
     * sentinel written — shows no notice while still landing focus in the
     * textarea.
     *
     * Steps:
     * 1. Navigate to the `cat` window (no seed); wait for the relay stream.
     * 2. Assert the `Compose` chip reads `aria-pressed="true"`, the tongue is
     *    absent, and `compose-strip-input` becomes `document.activeElement`.
     * 3. Type a marker; assert it is the textarea's value and NOT in the pane.
     * 4. Assert the toast `Compose is on by default — Shift+Ctrl+E hides it`
     *    is visible, and `hexokit-compose-default-notice` is `"1"`.
     * 5. Reload; assert the textarea is focused again and no toast appears.
     */
    test("a fresh navigation lands focus in the textarea and shows the one-time notice", async ({ page }) => {
      test.setTimeout(60_000);
      const windowId = await resolveWindowId(page, TERM_SESSION);
      await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => page.evaluate((w) => Boolean(window.__rkTerminals?.[w]), windowId), {
          timeout: 15_000,
        })
        .toBe(true);

      await expect(page.getByRole("button", { name: "Compose", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("compose-tongue")).toHaveCount(0);
      await expectActiveElement(page, "compose");

      const marker = `CS_DEFAULT_${Date.now()}`;
      await page.keyboard.type(marker);
      await expect(page.getByTestId("compose-strip-input")).toHaveValue(marker);
      expect(tmuxCapture(TERM_SESSION)).not.toContain(marker);

      await expect(page.getByText("Compose is on by default — Shift+Ctrl+E hides it")).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem("hexokit-compose-default-notice"))).toBe("1");

      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
      await expectActiveElement(page, "compose");
      await expect(page.getByText(/Compose is on by default/)).toHaveCount(0);
    });

    /**
     * Proves: the first-visit resolver is consulted only when a window has no
     * recorded focus kind. A sidebar-row switch into a never-visited window
     * lands in the textarea; switching back to a window the user clicked the
     * pane in (memory says `tty`) lands on `.xterm` — the recorded kind wins.
     *
     * Steps:
     * 1. Navigate to `cs-alpha`; assert the textarea takes focus.
     * 2. Click the xterm (records `tty` for alpha); assert `.xterm` is active.
     * 3. Click `cs-bravo`'s sidebar row (never visited); assert the textarea
     *    takes focus without a click.
     * 4. Click `cs-alpha`'s row; assert `.xterm` is active.
     */
    test("a never-visited window lands in the textarea; a tty-recorded window lands on the pane", async ({ page }) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width: 1440, height: 800 });
      const alpha = await resolveWindowId(page, BOARD_SESSION, "cs-alpha");
      const bravo = await resolveWindowId(page, BOARD_SESSION, "cs-bravo");
      await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(alpha)}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({ timeout: READY_TIMEOUT });
      await expectActiveElement(page, "compose");

      await page.locator(".xterm-screen").first().click();
      await expectActiveElement(page, "xterm");

      const row = (winId: string) =>
        page.locator(`[data-row-key="${TMUX_SERVER}:${winId}"] button`).first();
      await expect(row(bravo)).toBeVisible({ timeout: 10_000 });
      await row(bravo).click();
      await expectActiveElement(page, "compose");

      await row(alpha).click();
      await expectActiveElement(page, "xterm");
    });

    /**
     * Proves: the strip is the keyboard and the terminal is the control
     * surface — Escape in the textarea hands focus to the xterm (never
     * collapses the strip), and a key typed afterwards reaches the tmux pane.
     * The placeholder teaches that hand-off.
     *
     * Steps:
     * 1. Navigate to the `cat` window; wait for the relay stream; assert the
     *    textarea is focused and its placeholder ends with `· Esc → terminal`.
     * 2. Press Escape; assert `.xterm` is active and the strip is still
     *    expanded (textarea present, tongue absent).
     * 3. Type a marker + Enter; poll `tmux capture-pane` for the marker.
     */
    test("Escape hands focus to the pane and typing then reaches tmux", async ({ page }) => {
      test.setTimeout(60_000);
      const windowId = await resolveWindowId(page, TERM_SESSION);
      await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => page.evaluate((w) => Boolean(window.__rkTerminals?.[w]), windowId), {
          timeout: 15_000,
        })
        .toBe(true);
      const input = page.getByTestId("compose-strip-input");
      await expectActiveElement(page, "compose");
      await expect(input).toHaveAttribute("placeholder", /· Esc → terminal$/);

      await page.keyboard.press("Escape");
      await expectActiveElement(page, "xterm");
      await expect(input).toBeVisible();
      await expect(page.getByTestId("compose-tongue")).toHaveCount(0);

      const marker = `CS_ESC_${Date.now()}`;
      await page.keyboard.type(marker);
      await page.keyboard.press("Enter");
      await expect.poll(() => tmuxCapture(TERM_SESSION), { timeout: 15_000 }).toContain(marker);
    });

    /**
     * Proves: the on-by-default persist loop — the chip reads pressed with no
     * stored value, clicking it collapses the strip to the tongue and stores
     * the explicit opt-out `"false"`, which survives a reload as off, and the
     * palette's `Compose: Toggle` turns it back on.
     *
     * Steps:
     * 1. Navigate to the `cat` window; assert the chip is `aria-pressed="true"`
     *    and the textarea is visible.
     * 2. Click the chip; assert the tongue shows and
     *    `localStorage["hexokit-compose-strip"] === "false"`.
     * 3. Reload; assert the tongue still shows and the chip reads
     *    `aria-pressed="false"`.
     * 4. Open the palette and click `Compose: Toggle`; assert the textarea is
     *    visible and the chip reads pressed.
     */
    test("on by default → chip stores the opt-out → reload stays off → palette Compose: Toggle turns it on", async ({ page }) => {
      test.setTimeout(60_000);
      const windowId = await resolveWindowId(page, TERM_SESSION);
      await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
      const chip = page.getByRole("button", { name: "Compose", exact: true });
      await expect(chip).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("compose-strip-input")).toBeVisible();

      await chip.click();
      await expect(page.getByTestId("compose-tongue")).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem("hexokit-compose-strip"))).toBe("false");

      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("compose-tongue")).toBeVisible();
      await expect(page.getByRole("button", { name: "Compose", exact: true })).toHaveAttribute("aria-pressed", "false");

      await openPalette(page);
      await page.getByRole("option", { name: "Compose: Toggle" }).click();
      await expect(page.getByTestId("compose-strip-input")).toBeVisible();
      await expect(page.getByRole("button", { name: "Compose", exact: true })).toHaveAttribute("aria-pressed", "true");
    });

    /**
     * Proves: the tab-walk chords keep working from the compose textarea. The
     * first-visit landing puts focus in the strip, and `window-next` carries
     * `ignoreInputs`, so a second press — which now targets a TEXTAREA — still
     * reaches the dispatcher and steps the window list again instead of being
     * swallowed by the text-input gate. The second press is the regression
     * under test; a single press from the pane always worked.
     *
     * Steps:
     * 1. Navigate to `cs-alpha` (no seed → strip on); wait for `Connected`;
     *    assert the textarea is `document.activeElement`.
     * 2. Press Shift+Control+ArrowDown (the win/linux `window-next` face);
     *    assert the URL leaves `cs-alpha`'s window.
     * 3. Assert the textarea is active again on the new window (first-visit
     *    landing).
     * 4. Press Shift+Control+ArrowDown again; assert the URL changes again.
     */
    test("Shift+Ctrl+Down steps the window list twice from the focused compose textarea", async ({ page }) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width: 1440, height: 800 });
      const alpha = await resolveWindowId(page, BOARD_SESSION, "cs-alpha");
      await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(alpha)}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']")).toBeVisible({ timeout: READY_TIMEOUT });
      await expectActiveElement(page, "compose");
      const startUrl = page.url();

      await page.keyboard.press("Shift+Control+ArrowDown");
      await expect.poll(() => page.url(), { timeout: READY_TIMEOUT }).not.toBe(startUrl);
      const secondUrl = page.url();
      await expectActiveElement(page, "compose");

      await page.keyboard.press("Shift+Control+ArrowDown");
      await expect.poll(() => page.url(), { timeout: READY_TIMEOUT }).not.toBe(secondUrl);
    });
  });

  // Coarse-pointer card model. hasTouch flips Chromium's `(pointer: coarse)`
  // media query (the same seam bottom-bar-chip-size.spec.ts uses): the strip
  // is a single compact row (📎 · textarea · Send) while blurred and empty,
  // and morphs to the CARD — full-width transparent textarea with a quiet
  // chip row (📎 · ⏎ · spacer · Send) below it — on focus, a multi-line
  // draft, or attachments. The bottom bar hides while the textarea owns focus.
  test.describe("coarse pointer card morph", () => {
    test.use({ hasTouch: true, viewport: { width: 375, height: 812 } });

    /**
     * Proves: on a coarse pointer the collapsed tongue renders too — at the
     * footer dock, directly ABOVE the bottom bar (whose `a▏` chip stays a second
     * opener) — as a lightweight row: no chord `<kbd>` (chords are noise on
     * touch), at most 36px tall, no horizontal overflow at 375px, and the bottom
     * bar still present beneath it.
     *
     * Steps:
     * 1. Navigate to the `cat` window at 375×812 with touch (preference off);
     *    wait for `.xterm`.
     * 2. Assert `compose-tongue` is visible inside `<footer>`, reads "Compose",
     *    and has no `<kbd>`.
     * 3. Assert the tongue's height ≤ 36px and its bottom edge is at or above
     *    the bottom bar's (`role=toolbar` "Terminal keys") top edge.
     * 4. Assert `document.body.scrollWidth` ≤ 375.
     */
    test("the tongue renders above the bottom bar on coarse pointers, chord-less and ≤ 36px", async ({ page }) => {
      test.setTimeout(60_000);
      const windowId = await resolveWindowId(page, TERM_SESSION);
      await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.locator(".xterm")).toBeVisible({ timeout: 15_000 });

      const tongue = page.locator("footer").getByTestId("compose-tongue");
      await expect(tongue).toBeVisible();
      await expect(tongue).toContainText("Compose");
      await expect(tongue.locator("kbd")).toHaveCount(0);
      const toolbar = page.getByRole("toolbar", { name: "Terminal keys" });
      await expect(toolbar).toBeVisible();

      const tongueBox = await boxOf(tongue);
      const barBox = await boxOf(toolbar);
      expect(tongueBox.height).toBeLessThanOrEqual(36);
      expect(tongueBox.y + tongueBox.height).toBeLessThanOrEqual(barBox.y + 1);
      await expect
        .poll(() => page.evaluate(() => document.body.scrollWidth))
        .toBeLessThanOrEqual(375);
    });

    /**
     * Proves: on a coarse pointer at 375px, focusing the compose textarea hides
     * the bottom-bar key row AND morphs the strip to the card — a full-width
     * transparent textarea (`rows=1`) above a quiet chip row (no Insert, no
     * `a|` closer on coarse; the ⏎ chip hidden while the composer is empty).
     * With text, the ⏎ chip appears on the chip row BELOW the textarea, level
     * with Send, and inserts a local newline at the caret without sending or
     * dropping focus. The `→ {target}` header row folds away and the target
     * name moves into the textarea placeholder. Escape blurs: the bottom bar
     * returns, and a multi-line draft HOLDS the card. The no-dead-space
     * regression stays pinned: the bar owns its 48px frame, so its early-return
     * removes the reserved height.
     *
     * Steps:
     * 1. Set a 375×812 touch viewport; navigate to the `cat` session's window;
     *    wait for `.xterm` and for the relay stream to attach
     *    (`window.__rkTerminals[windowId]` present).
     * 2. Assert the bottom bar (`role=toolbar` "Terminal keys") is visible.
     * 3. Enable the strip via the `a▏` chip; assert the input is visible and
     *    focused (focus-on-open), and the bottom bar is now absent.
     * 4. Assert zero dead space: the footer's bottom edge equals the strip's
     *    bottom edge while the bar is hidden (gap regression).
     * 5. Assert the card (`compose-strip-card`) renders with `rows="1"`, no
     *    Insert, no `compose-strip-a-close`, and no `compose-strip-newline`
     *    (hidden while empty); assert `compose-strip-target` is absent (header
     *    folded) and the input's placeholder matches `→ ……`.
     * 6. Fill `"hello"`; assert the ⏎ chip appears on the card's chip row — its
     *    top level with Send's, at or below the textarea's bottom edge — and
     *    that both chips keep the 36px coarse touch-target floor.
     * 7. Click the ⏎ chip; assert the input value is `"hello\n"` and the input
     *    is still focused.
     * 8. Press Escape; assert the input is blurred, the bottom bar is visible
     *    again, and the card persists (the multi-line draft holds it).
     */
    test("compose focus hides the bottom bar and morphs to the card; blur-while-empty returns compact", async ({ page }) => {
      test.setTimeout(60_000);
      const windowId = await resolveWindowId(page, TERM_SESSION);
      await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 15_000 });
      // Wait for the relay stream to attach so the strip has a live target.
      await expect
        .poll(() => page.evaluate((w) => Boolean(window.__rkTerminals?.[w]), windowId), {
          timeout: 15_000,
        })
        .toBe(true);

      const toolbar = page.getByRole("toolbar", { name: "Terminal keys" });
      await expect(toolbar).toBeVisible();

      // Enable the strip — focus-on-open grabs the textarea (on mobile that
      // summons the IME), which must hide the bottom bar AND morph coarse to
      // the card.
      await page.getByRole("button", { name: "Compose", exact: true }).click();
      const input = page.getByTestId("compose-strip-input");
      await expect(input).toBeVisible();
      await expect(input).toBeFocused();
      await expect(toolbar).toHaveCount(0);

      // No dead space where the bar was: the bar owns its 48px frame, so
      // hiding it must collapse the footer to the strip alone — the strip's
      // bottom edge IS the footer's bottom edge (260814 gap regression).
      const deadSpace = await page.evaluate(() => {
        const footer = document.querySelector('footer[style*="bottombar"]');
        const strip = document.querySelector('[data-testid="compose-strip"]');
        if (!footer || !strip) return -1;
        return footer.getBoundingClientRect().bottom - strip.getBoundingClientRect().bottom;
      });
      expect(deadSpace).toBe(0);

      // Card form: the textarea spans the card's full width with the chip row
      // below it — no flanking chips. rows=1, no Insert, no a| (dropped on
      // coarse), and the ⏎ chip hides while the composer is empty.
      const card = page.getByTestId("compose-strip-card");
      await expect(card).toBeVisible();
      await expect(input).toHaveAttribute("rows", "1");
      await expect(page.getByTestId("compose-strip-insert")).toHaveCount(0);
      await expect(page.getByTestId("compose-strip-a-close")).toHaveCount(0);
      await expect(page.getByTestId("compose-strip-newline")).toHaveCount(0);

      // Header folded: no target label / × close; the target moved into the
      // placeholder.
      await expect(page.getByTestId("compose-strip-target")).toHaveCount(0);
      await expect(input).toHaveAttribute("placeholder", /^→ .+…$/);

      // With text the ⏎ chip appears — on the card's chip row BELOW the
      // textarea, level with Send.
      await input.fill("hello");
      const newline = page.getByTestId("compose-strip-newline");
      await expect(newline).toBeVisible();
      const cardGeo = await page.evaluate(() => {
        const r = (tid: string) =>
          document.querySelector(`[data-testid="${tid}"]`)?.getBoundingClientRect() ?? null;
        return {
          ta: r("compose-strip-input"),
          nl: r("compose-strip-newline"),
          send: r("compose-strip-send"),
        };
      });
      expect(cardGeo.nl?.top).toBe(cardGeo.send?.top);
      expect(cardGeo.nl?.top).toBeGreaterThanOrEqual(cardGeo.ta?.bottom ?? Infinity);
      // Coarse touch floors hold inside the card's quiet chip row.
      expect(cardGeo.nl?.height).toBeGreaterThanOrEqual(36);
      expect(cardGeo.send?.height).toBeGreaterThanOrEqual(36);

      // The ⏎ chip is the mobile Shift+Enter: a local newline at the caret —
      // nothing is sent, and the textarea keeps focus (the keyboard must not
      // dismiss).
      await newline.click();
      await expect(input).toHaveValue("hello\n");
      await expect(input).toBeFocused();
      await expect(page.getByTestId("compose-strip")).toBeVisible();

      // Escape blurs the textarea → the bottom bar returns; the multi-line
      // draft ("hello\n") HOLDS the card.
      await page.keyboard.press("Escape");
      await expect(input).not.toBeFocused();
      await expect(toolbar).toBeVisible();
      await expect(card).toBeVisible();
    });

    /**
     * Proves: on a coarse pointer, blurring the strip while the draft is EMPTY
     * returns it to the compact single row (the card morph's release), and the
     * compact row keeps the pinned 36px alignment: the textarea and Send share
     * one height with flush tops and bottoms.
     *
     * Steps:
     * 1. Set a 375×812 touch viewport; navigate to the `cat` session's window;
     *    wait for `.xterm` and the relay stream.
     * 2. Enable the strip via the `a▏` chip; assert the input took focus
     *    (focus-on-open → card form on coarse).
     * 3. Press Escape (blur while empty); assert `compose-strip-card` is ABSENT
     *    — the strip is back to the compact row.
     * 4. Measure the textarea and Send chip boxes: textarea height is exactly
     *    36px and both chips share its top and bottom edges.
     */
    test("coarse compact is a single 36px-flush row — 📎 · textarea · Send", async ({ page }) => {
      test.setTimeout(60_000);
      const windowId = await resolveWindowId(page, TERM_SESSION);
      await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => page.evaluate((w) => Boolean(window.__rkTerminals?.[w]), windowId), {
          timeout: 15_000,
        })
        .toBe(true);

      // Enable the strip (focus-on-open focuses → card), then blur with
      // Escape while the draft is EMPTY → the compact single row returns.
      await page.getByRole("button", { name: "Compose", exact: true }).click();
      const input = page.getByTestId("compose-strip-input");
      await expect(input).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(input).not.toBeFocused();
      await expect(page.getByTestId("compose-strip-card")).toHaveCount(0);

      // Single-line alignment: the textarea and its flanking chips share one
      // 36px height, so tops and bottoms are flush (260814 alignment fix).
      const rowGeo = await page.evaluate(() => {
        const r = (tid: string) =>
          document.querySelector(`[data-testid="${tid}"]`)?.getBoundingClientRect() ?? null;
        return {
          ta: r("compose-strip-input"),
          send: r("compose-strip-send"),
        };
      });
      expect(rowGeo.ta?.height).toBe(36);
      expect(rowGeo.send?.top).toBe(rowGeo.ta?.top);
      expect(rowGeo.send?.bottom).toBe(rowGeo.ta?.bottom);
    });

    /**
     * Proves: a touch user can open the newest-first sent-history list, inspect
     * it without widening a 375px page, and load a prior send into the composer
     * without transmitting it again.
     *
     * Steps:
     * 1. Navigate to the live `cat` window at the 375×812 touch viewport and
     *    wait for the terminal relay target.
     * 2. Enable the compose strip, send one unique line, and wait until that
     *    line appears in the pane and the ↑ history chip is visible.
     * 3. Tap ↑; assert the flyout and its newest row show the sent line.
     * 4. Assert `document.body.scrollWidth` remains within the 375px viewport.
     * 5. Record the pane's marker count, tap the row, and assert the flyout
     *    closes while the textarea contains the exact line and has focus.
     * 6. Re-capture the pane after the interaction settles and assert the marker
     *    count did not change.
     */
    test("touch sent-history flyout loads a prior send without resending or overflowing", async ({ page }) => {
      test.setTimeout(60_000);
      const windowId = await resolveWindowId(page, TERM_SESSION);
      await page.goto(`/${TMUX_SERVER}/${encodeURIComponent(windowId)}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(() => page.evaluate((w) => Boolean(window.__rkTerminals?.[w]), windowId), {
          timeout: 15_000,
        })
        .toBe(true);

      await page.getByRole("button", { name: "Compose", exact: true }).click();
      const input = page.getByTestId("compose-strip-input");
      const marker = `CSHISTORY${Date.now()}`;
      await input.fill(marker);
      await input.press("Enter");
      await expect(input).toHaveValue("");
      await expect
        .poll(() => tmuxCapture(TERM_SESSION), { timeout: 10_000 })
        .toContain(marker);

      const history = page.getByTestId("compose-strip-history");
      await expect(history).toBeVisible();
      await history.click();
      const flyout = page.getByTestId("compose-history-flyout");
      const row = page.getByTestId("compose-history-entry").first();
      await expect(flyout).toBeVisible();
      await expect(row).toHaveText(marker);
      await expect
        .poll(() => page.evaluate(() => document.body.scrollWidth))
        .toBeLessThanOrEqual(375);

      const occurrencesBeforeLoad = (tmuxCapture(TERM_SESSION).match(new RegExp(marker, "g")) ?? []).length;
      await row.click();
      await expect(flyout).toHaveCount(0);
      await expect(input).toHaveValue(marker);
      await expect(input).toBeFocused();

      await page.waitForTimeout(250);
      const occurrencesAfterLoad = (tmuxCapture(TERM_SESSION).match(new RegExp(marker, "g")) ?? []).length;
      expect(occurrencesAfterLoad).toBe(occurrencesBeforeLoad);
    });
  });
});
