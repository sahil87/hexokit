import { test, expect, type Page } from "@playwright/test";
import { mockStateSocket } from "./_state-socket-mock";
import { TMUX_SERVER } from "./_tmux";

/**
 * Tier-1 tooltip system: the styled `Tip` replaces native `title=`
 * attributes on interactive chrome controls. These tests prove the three
 * approved behaviors that native titles could not deliver:
 *   1. keyboard focus opens the tip (Constitution V — keyboard-first),
 *   2. hover opens the styled tip (no OS bubble, no native title attribute),
 *   3. coarse pointers get NO tooltip layer at all.
 * The second describe covers the surfaces the register labels and
 * ⌘K/compose hints live on now: the full-width status bar (the sidebar PANE
 * panel went drawer-only and the fine-pointer bottom bar was deleted).
 *
 * Shared setup: the first describe needs no tmux session fixtures — every
 * test navigates to the tmux Server route (`/${TMUX_SERVER}`), whose top
 * bar renders the L3 always-block (theme / refresh / help) with tipped
 * controls at the default desktop viewport; the coarse-pointer test
 * installs an init script mocking `window.matchMedia("(pointer: coarse)")`
 * as matching (desktop Chromium cannot flip the real pointer media
 * feature). The second describe is fully mocked (no tmux/gh — the
 * pane-register-panel.spec.ts idiom): the state socket is mocked with one
 * session/window so the terminal route (`/default/1`) renders the status
 * bar's window cluster; `/ws/terminals` is stubbed and `/api/servers` +
 * window-select are fulfilled inline (`beforeEach` installs the mock).
 */


/** Mock `(pointer: coarse)` as matching so `Tip` self-suppresses in desktop
 *  Chromium (the mobile-touch-scroll.spec.ts precedent — Playwright's desktop
 *  Chromium cannot flip the real pointer media feature). */
function mockCoarsePointer(page: Page) {
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

test.describe("Tier-1 tooltips (Tip)", () => {
  /**
   * Proves: tooltips are visible to keyboard users — `Tip` opens on
   * `:focus-visible` with no delay and wires the ARIA tooltip pattern
   * (`role="tooltip"` + `aria-describedby` on the anchored control).
   * Native titles were mouse-only; this is the Constitution V fix.
   *
   * Steps:
   * 1. Navigate to `/${TMUX_SERVER}` and wait for the Refresh page button
   *    (top-bar chrome rendered).
   * 2. Press Tab (bounded loop, ≤12 presses, keyboard modality from a
   *    fresh page) until the brand link (`HexoKit home`) is
   *    `document.activeElement`. At this desktop viewport with the sidebar
   *    open, that link is the sidebar head's brand anchor over the bar's
   *    left end (the nav's brand crumb renders only while the head does
   *    not) — it carries the same `Tip`.
   * 3. Assert a `role="tooltip"` element is visible and reads "Host" (the
   *    link's level name).
   * 4. Assert the brand link carries `aria-describedby`.
   */
  test("keyboard focus opens the styled tip immediately", async ({ page }) => {
    await page.goto(`/${TMUX_SERVER}`);
    const refresh = page.getByRole("button", { name: "Refresh page" });
    await expect(refresh).toBeVisible({ timeout: 10_000 });

    // Tab from a fresh page (keyboard modality) until the brand link has
    // focus — its Tip names the link's level ("Host"). Bounded loop: the
    // brand link is among the first few tab stops on every route.
    const brand = page.getByRole("link", { name: "HexoKit home" });
    let focused = false;
    for (let i = 0; i < 12 && !focused; i++) {
      await page.keyboard.press("Tab");
      focused = await brand.evaluate((el) => el === document.activeElement);
    }
    expect(focused, "brand link never received keyboard focus").toBe(true);

    // Focus-visible opens with NO delay and wires the tooltip ARIA pattern.
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(/Host/);
    await expect(brand).toHaveAttribute("aria-describedby", /.+/);
  });

  /**
   * Proves: hover shows the styled quiet-card tip after the open delay, the
   * old parenthesized shortcut text ("(Shift+click: force reload)") now
   * renders as the dim modifier note ("⇧click: force"), the native `title`
   * attribute is gone wherever `Tip` landed (no OS bubble doubling the
   * styled tip), and Escape dismisses.
   *
   * Steps:
   * 1. Navigate to `/${TMUX_SERVER}` and wait for the Refresh page button.
   * 2. Assert the button has NO `title` attribute.
   * 3. Hover the button; assert the `role="tooltip"` element becomes
   *    visible and contains both "Refresh page" and "⇧click: force".
   * 4. Press Escape; assert the tooltip is gone.
   */
  test("hover opens the styled tip (label + dim note), no native title bubble", async ({
    page,
  }) => {
    await page.goto(`/${TMUX_SERVER}`);
    const refresh = page.getByRole("button", { name: "Refresh page" });
    await expect(refresh).toBeVisible({ timeout: 10_000 });

    // Migration rule: the native `title` is REMOVED wherever Tip lands —
    // never both, or the OS bubble doubles the styled tip.
    await expect(refresh).not.toHaveAttribute("title", /.*/);

    // Hover past the 300ms open delay: the quiet-card tip shows the label and
    // the dim "⇧click: force" modifier note (the old parenthesized title).
    await refresh.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("Refresh page");
    await expect(tooltip).toContainText("⇧click: force");

    // Escape dismisses (useDismiss) without activating the control.
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
  });

  /**
   * Proves: under `pointer: coarse` the `Tip` layer is fully suppressed —
   * no tooltip on hover or focus, and no `aria-describedby` wiring — the
   * control's `aria-label` alone carries the name (there is no long-press
   * tooltip on touch).
   *
   * Steps:
   * 1. Install the coarse-pointer matchMedia mock (init script), then
   *    navigate to `/${TMUX_SERVER}`.
   * 2. Hover AND focus the Refresh page button.
   * 3. Wait past the 300ms open delay (600ms), assert zero `role="tooltip"`
   *    elements.
   * 4. Assert the button has no `aria-describedby` attribute.
   */
  test("coarse pointers get no tooltip layer at all", async ({ page }) => {
    await mockCoarsePointer(page);
    await page.goto(`/${TMUX_SERVER}`);
    const refresh = page.getByRole("button", { name: "Refresh page" });
    await expect(refresh).toBeVisible({ timeout: 10_000 });

    // Hover AND focus — neither may open a tip under pointer: coarse (the
    // control's aria-label carries the name; there is no long-press layer).
    await refresh.hover();
    await refresh.focus();
    // Wait past the 300ms open delay before asserting absence.
    await page.waitForTimeout(600);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    // Suppressed means UNWIRED: no aria-describedby is attached either.
    await expect(refresh).not.toHaveAttribute("aria-describedby", /.*/);
  });
});

/**
 * Status-bar label + hint tips: the register labels and the ⌘K/compose
 * hints moved from the (desktop-retired) PANE panel and
 * (fine-pointer-deleted) bottom bar into the full-width status bar.
 */

const MOCK_SERVER = "default";

const mockSessions = JSON.stringify([
  {
    name: "dev",
    windows: [
      {
        windowId: "@1",
        index: 0,
        name: "shell",
        worktreePath: "/tmp/wt",
        activity: "idle",
        isActiveWindow: true,
        activityTimestamp: 0,
        panes: [{ paneId: "%1", paneIndex: 0, cwd: "/tmp/wt", command: "zsh", isActive: true }],
      },
    ],
  },
]);

async function mockBackend(page: Page) {
  await page.routeWebSocket(/\/ws\/terminals/, () => {});
  await page.route("**/api/windows/*/select*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: MOCK_SERVER, sessionCount: 1 }]),
    }),
  );
  await mockStateSocket(page, { sessions: mockSessions });
}

test.describe("Status-bar label and hint tips (260723-fm08, retargeted 260814-ldbs)", () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page);
  });

  /**
   * Proves: the status bar's window-cluster register labels (terse 3-char
   * keys like `tmx`) carry tier-1 tips naming the register in plain words.
   * The label is a non-focusable span, so the tip is hover-only — no new
   * tab stops were added for a non-actionable element.
   *
   * Steps:
   * 1. Navigate to `/default/1` (mocked backend) and wait for the
   *    `status-bar-window` cluster to be visible.
   * 2. Hover the exact-text `tmx` label span inside the cluster.
   * 3. Assert a `role="tooltip"` element becomes visible reading
   *    "tmux pane".
   */
  test("hovering a status-bar register label opens its plain-words tip", async ({ page }) => {
    await page.goto(`/${MOCK_SERVER}/1`);
    const cluster = page.getByTestId("status-bar-window");
    await expect(cluster).toBeVisible({ timeout: 10_000 });

    // The register KEY is a non-focusable span — hover-only (no new tab
    // stops, the 73al connection-dot precedent). Hover past the open delay.
    // The tmx label: always in the strip at the default desktop viewport
    // (the out register no longer exists in the bar).
    await cluster.getByText("tmx", { exact: true }).hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(/tmux pane/);
  });

  /**
   * Proves: the status bar's hint chips (bare symbol glyphs — the relocated
   * bottom-bar pair) carry tier-1 tips; the ⌘K hint pairs its "Command
   * palette" label with the REGISTRY-resolved shortcut rendered as a real
   * `<kbd>` keycap chip (platform-aware via `useKeybindings` +
   * `chordHintFor`; the pinned `devices["Desktop Chrome"]` UA is Windows, so
   * `detectPlatform()` resolves `other` and the tip lists BOTH Win/Linux
   * palette chords — the primary Ctrl+K and its shifted alias — on any host
   * OS, while the chip's button face keeps the ⌘K brand glyph), and the
   * migration contract holds (no native `title` on the chip).
   *
   * Steps:
   * 1. Navigate to `/default/1` (mocked backend) and wait for the status
   *    bar's `Open command palette` chip to be visible.
   * 2. Assert the chip has NO `title` attribute.
   * 3. Hover the chip; assert the `role="tooltip"` element becomes visible,
   *    contains "Command palette", and its `<kbd>` reads
   *    "Ctrl+K / Shift+Ctrl+K" — primary first, then the alias, the chords
   *    effective under the pinned Windows device UA.
   */
  test("hovering the status bar's ⌘K hint shows its tip with the keycap slot", async ({ page }) => {
    await page.goto(`/${MOCK_SERVER}/1`);
    const chip = page
      .getByTestId("status-bar")
      .getByRole("button", { name: "Open command palette" });
    await expect(chip).toBeVisible({ timeout: 10_000 });

    // Migration rule holds on the chips too: styled tip, no native title.
    await expect(chip).not.toHaveAttribute("title", /.*/);

    await chip.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("Command palette");
    // The REGISTRY-resolved palette chords render as a real <kbd> keycap chip:
    // Win/Linux carries two — plain Ctrl+K plus the shifted alias, the form
    // that survives terminal focus — listed primary-first. devices["Desktop
    // Chrome"] pins a Windows UA, so detectPlatform() resolves "other" on any
    // host OS (the chip's button face keeps the ⌘K brand glyph).
    await expect(tooltip.locator("kbd")).toHaveText("Ctrl+K / Shift+Ctrl+K");
  });
});
