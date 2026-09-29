// Coarse-pointer focus gate e2e — on touch devices the hidden xterm helper
// textarea must gain focus ONLY from a deliberate tap. The long-press path
// (WebKit's recognizer fires `contextmenu` during a slow scroll-drag →
// xterm's rightClickHandler → moveTextAreaUnderMouseCursor → focus) is
// suppressed by an ALWAYS-ON capture-phase gate (not scroll-lock-gated), so
// the phantom-keyboard state — keyboard up, hollow cursor, nothing visibly
// focused — is unreachable in the normal unlocked state.
//
// Shared setup: file-level `beforeAll` creates a dedicated tmux session on
// the isolated test server; `afterAll` kills it. Each test sets an
// iPad-portrait viewport (820×1180, the reported device class) and shims
// `window.matchMedia` for the coarse-pointer queries (`pointer` + `any-pointer`) via `mockTouchDevice` (desktop
// Chromium reports a fine pointer) BEFORE navigation. The terminal route is
// keyed by the tmux window id (`@N`), resolved via `_ready.ts`'s
// `resolveWindow`. Touch input goes through raw CDP
// (`Input.dispatchTouchEvent`) — the closest mirror of iOS input. The xterm
// helper textarea is located by its `.xterm-helper-textarea` class.
import { test, expect } from "@playwright/test";
import { harnessOrigin } from "./_harness";
import { resolveWindow } from "./_ready";
import { TMUX_SERVER, createSession, killSession } from "./_tmux";

const TEST_SESSION = `e2e-touchfocus-${Date.now()}`;
const BASE = harnessOrigin();

// iPad portrait — the device class the phantom keyboard was reported on.
const IPAD_VIEWPORT = { width: 820, height: 1180 };

// Mock pointer:coarse so the always-on contextmenu gate activates in desktop
// Chromium (same shim as mobile-touch-scroll.spec.ts).
function mockTouchDevice(page: import("@playwright/test").Page) {
  return page.addInitScript(() => {
    const orig = window.matchMedia;
    window.matchMedia = function (q: string) {
      if (q === "(pointer: coarse)" || q === "(any-pointer: coarse)") {
        return {
          matches: true,
          media: q,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          onchange: null,
          dispatchEvent: () => true,
        } as MediaQueryList;
      }
      return orig.call(window, q);
    };
  });
}

/** True when the xterm helper textarea owns DOM focus. */
function helperTextareaFocused(page: import("@playwright/test").Page) {
  return page.evaluate(
    () => document.activeElement?.classList.contains("xterm-helper-textarea") ?? false,
  );
}

test.describe("Coarse-pointer focus gate", () => {
  test.setTimeout(30_000);

  test.beforeAll(() => {
    createSession(TEST_SESSION);
  });

  test.afterAll(() => {
    killSession(TEST_SESSION);
  });

  /**
   * Proves: on a coarse pointer with the terminal in its normal UNLOCKED
   * state, the long-press path — a `contextmenu` event inside the terminal —
   * never moves focus into the xterm helper textarea (the phantom-keyboard
   * bug), because the capture-phase gate suppresses the event before xterm's
   * element-level rightClickHandler can run.
   *
   * Steps:
   * 1. Shim the coarse-pointer queries, set an iPad-portrait viewport, navigate to
   *    the session's first window; wait for `.xterm-screen` and a settle.
   * 2. Blur whatever holds focus so the assertion starts from no-owner.
   * 3. Dispatch a bubbling/cancelable `contextmenu` on `.xterm-screen`
   *    (WebKit's long-press recognizer delivers exactly this during a slow
   *    scroll-drag).
   * 4. Wait 500ms (past any async focus work), then assert the helper
   *    textarea is NOT `document.activeElement`.
   * 5. Non-vacuous control: repeat on a SECOND page WITHOUT the coarse shim
   *    (fine pointer) and assert the same synthetic dispatch DOES focus the
   *    textarea — proving xterm's contextmenu→focus path genuinely fires
   *    under this harness and the coarse gate is what stopped it.
   */
  test("long-press contextmenu on an unlocked coarse terminal does not focus the helper textarea", async ({
    page,
    browser,
  }) => {
    await page.setViewportSize(IPAD_VIEWPORT);
    await mockTouchDevice(page);

    const { windowId } = await resolveWindow(page, TMUX_SERVER, TEST_SESSION);
    await page.goto(`${BASE}/${TMUX_SERVER}/${encodeURIComponent(windowId)}`);
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(2000);

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator(".xterm-screen").dispatchEvent("contextmenu");
    await page.waitForTimeout(500);
    expect(
      await helperTextareaFocused(page),
      "contextmenu focused the helper textarea despite the coarse gate",
    ).toBe(false);

    // Control: the identical dispatch on a fine-pointer page must focus the
    // textarea through xterm's own rightClickHandler — otherwise the coarse
    // assertion above proves nothing.
    const control = await browser.newPage();
    try {
      await control.setViewportSize(IPAD_VIEWPORT);
      await control.goto(`${BASE}/${TMUX_SERVER}/${encodeURIComponent(windowId)}`);
      await expect(control.locator(".xterm-screen")).toBeVisible({ timeout: 10_000 });
      await control.waitForTimeout(2000);
      await control.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await control.locator(".xterm-screen").dispatchEvent("contextmenu");
      await control.waitForTimeout(500);
      expect(
        await helperTextareaFocused(control),
        "control (fine pointer): xterm's contextmenu→focus path did not fire — the coarse assertion is vacuous",
      ).toBe(true);
    } finally {
      await control.close();
    }
  });

  /**
   * Proves: the gate targets only the side-effect path — a plain deliberate
   * tap on an unlocked coarse-pointer terminal still focuses the xterm
   * helper textarea (the synthetic mousedown→focus chain stays intact;
   * mousedown suppression remains scroll-lock-gated), so the on-screen
   * keyboard opens with a visible owner.
   *
   * Steps:
   * 1. Shim the coarse-pointer queries, set an iPad-portrait viewport, navigate to
   *    the session's first window; wait for `.xterm-screen` and a settle.
   * 2. Blur whatever holds focus so the assertion starts from no-owner.
   * 3. Send a clean tap (touchStart + touchEnd, no moves) via CDP at the
   *    center of the terminal wrapper.
   * 4. Wait 500ms, then assert the helper textarea IS
   *    `document.activeElement`.
   */
  test("a plain tap on an unlocked coarse terminal focuses the helper textarea", async ({
    page,
  }) => {
    await page.setViewportSize(IPAD_VIEWPORT);
    await mockTouchDevice(page);

    const { windowId } = await resolveWindow(page, TMUX_SERVER, TEST_SESSION);
    await page.goto(`${BASE}/${TMUX_SERVER}/${encodeURIComponent(windowId)}`);
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(2000);

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    const box = await page.locator('[role="application"]').boundingBox();
    expect(box).not.toBeNull();
    const cx = Math.round(box!.x + box!.width / 2);
    const cy = Math.round(box!.y + box!.height / 2);
    const client = await page.context().newCDPSession(page);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: cx, y: cy }],
    });
    await page.waitForTimeout(50);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForTimeout(500);

    expect(
      await helperTextareaFocused(page),
      "a deliberate tap did not focus the terminal — the gate killed the tap path",
    ).toBe(true);
  });
});
