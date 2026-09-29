// Touch-input path for the embedded xterm.js terminal on mobile:
// swipe-to-scroll, tap-to-focus, and wrapper measurability. Chromium doesn't
// ship with `pointer:coarse` by default, so each test shims
// window.matchMedia('(pointer: coarse)') via page.addInitScript before
// navigation.
// Per-file timeout is 30s — terminal mounts and tmux scrollback generation
// can each take several seconds. beforeAll creates `e2e-scroll-<timestamp>`;
// afterAll kills it. Each test sets a 375×812 viewport and calls
// mockTouchDevice(page) before navigating. The terminal route is keyed by the
// tmux window id (`@N`), not the index, so each test first calls
// resolveFirstWindowId(page) — which polls the backend snapshot for
// TEST_SESSION's first window id — and deep-links to the 2-segment route
// `/${TMUX_SERVER}/<@id>` (id URL-encoded); the owning session is derived
// server-side from the SSE snapshot. Touch events are dispatched via CDP
// (Input.dispatchTouchEvent) rather than page.touchscreen — the raw CDP path
// mirrors iOS input most closely.
import { test, expect } from "@playwright/test";
import { harnessOrigin } from "./_harness";
import { resolveWindow } from "./_ready";
import { TMUX_SERVER, createSession, killSession } from "./_tmux";

const TEST_SESSION = `e2e-scroll-${Date.now()}`;
const BASE = harnessOrigin();

/**
 * Resolve the first window's stable tmux id (`@N`) for TEST_SESSION from the
 * backend snapshot. The terminal route is keyed by window id, not index, so a
 * deep-link must carry `@N`.
 */
async function resolveFirstWindowId(
  page: import("@playwright/test").Page,
): Promise<string> {
  return (await resolveWindow(page, TMUX_SERVER, TEST_SESSION)).windowId;
}

// Mock pointer:coarse so the touch scroll handler activates in desktop Chromium
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

test.describe("Mobile touch scroll", () => {
  test.setTimeout(30_000);

  test.beforeAll(() => {
    createSession(TEST_SESSION);
  });

  test.afterAll(() => {
    killSession(TEST_SESSION);
  });

  /**
   * Proves: a vertical swipe on the terminal wrapper produces SGR
   * mouse-scroll escape sequences (`\x1b[<64;col;rowM`) sent to the tmux PTY
   * via the `/ws/terminals` mux.
   *
   * Steps:
   * 1. Resolve the first window id and navigate to
   *    `/${TMUX_SERVER}/<@id>` (2-segment route); wait for `.xterm-screen`
   *    (xterm mount complete) plus a 2s settle.
   * 2. Type `seq 1 200\n` into the terminal to guarantee scrollback content.
   * 3. Monkey-patch `WebSocket.prototype.send` to append any frame whose
   *    decoded payload contains `\x1b[<6` into `window.__scrollSeqs` — pane
   *    keystrokes ride the mux as binary `[u32 BE streamId][payload]` frames,
   *    so binary sends are decoded past the 4-byte header before matching
   *    (strings pass through as-is).
   * 4. Dispatch `touchStart` at the wrapper center, then 15 small downward
   *    `touchMove` events (simulating finger drag down), then `touchEnd`.
   * 5. Read back `window.__scrollSeqs` and assert: at least one sequence was
   *    captured; the first matches `\x1b[<64;\d+;\d+M` (button 64 = scroll up
   *    in SGR encoding — finger down = see older content); and it does NOT
   *    contain the degenerate `;1;1M` coordinates, which would indicate the
   *    terminal bounding box wasn't measured correctly.
   */
  test("touch swipe sends SGR scroll sequences via WebSocket", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await mockTouchDevice(page);

    const windowId = await resolveFirstWindowId(page);
    await page.goto(`${BASE}/${TMUX_SERVER}/${encodeURIComponent(windowId)}`);
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(2000);

    // Generate scrollback
    await page.keyboard.type("seq 1 200\n", { delay: 10 });
    await page.waitForTimeout(2000);

    // Intercept WebSocket sends. Pane traffic rides the /ws/terminals mux as
    // binary [u32 BE streamId][payload] frames (260717-803u) — decode the
    // payload behind the 4-byte header. Control/state frames remain JSON
    // strings and carry no SGR bytes, so the string branch stays for safety.
    await page.evaluate(() => {
      (window as any).__scrollSeqs = [];
      const orig = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        let text = "";
        if (typeof data === "string") {
          text = data;
        } else if (data instanceof ArrayBuffer) {
          text = new TextDecoder().decode(new Uint8Array(data).subarray(4));
        } else if (ArrayBuffer.isView(data)) {
          const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          text = new TextDecoder().decode(u8.subarray(4));
        }
        if (text.includes("\x1b[<6")) {
          (window as any).__scrollSeqs.push(text);
        }
        return orig.call(this, data);
      };
    });

    // Simulate touch swipe via CDP (closest to real iOS touch)
    const box = await page.locator('[role="application"]').boundingBox();
    expect(box).not.toBeNull();
    const cx = Math.round(box!.x + box!.width / 2);
    const startY = Math.round(box!.y + box!.height / 2);

    const client = await page.context().newCDPSession(page);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: cx, y: startY }],
    });
    await page.waitForTimeout(50);
    // Swipe down (finger moves down) = see older content = scroll up
    for (let i = 1; i <= 15; i++) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: cx, y: startY + i * 20 }],
      });
      await page.waitForTimeout(30);
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForTimeout(500);

    // Verify SGR scroll-up sequences were sent
    const seqs = await page.evaluate(
      () => (window as any).__scrollSeqs as string[],
    );
    expect(seqs.length).toBeGreaterThan(0);
    // Button 64 = scroll up, with valid terminal coordinates
    expect(seqs[0]).toMatch(/\x1b\[<64;\d+;\d+M/);
    expect(seqs[0]).not.toContain(";1;1M");
  });

  /**
   * Proves: the xterm wrapper stays mounted and has positive dimensions at
   * mobile size. A navigation-driven unmount would leave the locator present
   * but un-measurable, which has caused past flakes.
   *
   * Steps:
   * 1. Navigate to the terminal route.
   * 2. Wait for `.xterm-screen` to be visible.
   * 3. Assert `[role='application']` has exactly one match within 3s.
   * 4. Read its `boundingBox()` with a 3s timeout.
   * 5. Assert `box.width > 0` and `box.height > 0`.
   */
  test("role=application wrapper has measurable bounding box at 375x812", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await mockTouchDevice(page);

    const windowId = await resolveFirstWindowId(page);
    await page.goto(`${BASE}/${TMUX_SERVER}/${encodeURIComponent(windowId)}`);
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 10_000 });

    // Wrapper must stay mounted and measurable — a selector-count assertion
    // catches navigation-driven unmounts that would make boundingBox hang.
    const wrapper = page.locator('[role="application"]');
    await expect(wrapper).toHaveCount(1, { timeout: 3000 });

    const box = await wrapper.boundingBox({ timeout: 3000 });
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  });

  /**
   * Proves: a bare tap (touchStart + touchEnd without movement) focuses
   * `.xterm-helper-textarea`. On iOS, this is what triggers the virtual
   * keyboard — regressions here break mobile typing.
   *
   * Steps:
   * 1. Navigate to the terminal route and wait for `.xterm-screen` + a 2s
   *    settle.
   * 2. Blur any active element via `page.evaluate`.
   * 3. Dispatch `touchStart` + `touchEnd` at the wrapper center with a 100ms
   *    gap between them; wait 500ms for focus handlers to run.
   * 4. Assert `document.activeElement` has the class `xterm-helper-textarea`.
   */
  test("tap on terminal focuses textarea for keyboard", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await mockTouchDevice(page);

    const windowId = await resolveFirstWindowId(page);
    await page.goto(`${BASE}/${TMUX_SERVER}/${encodeURIComponent(windowId)}`);
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(2000);

    // Blur any active element first
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());

    // Tap via CDP (touch start + end, no movement = tap)
    const box = await page.locator('[role="application"]').boundingBox();
    expect(box).not.toBeNull();
    const client = await page.context().newCDPSession(page);
    const cx = Math.round(box!.x + box!.width / 2);
    const cy = Math.round(box!.y + box!.height / 2);

    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: cx, y: cy }],
    });
    await page.waitForTimeout(100);
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForTimeout(500);

    // Verify xterm textarea received focus (triggers keyboard on iOS)
    const focused = await page.evaluate(() =>
      document.activeElement?.classList.contains("xterm-helper-textarea"),
    );
    expect(focused).toBe(true);
  });
});
