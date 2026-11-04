import { test, expect, type Page } from "@playwright/test";
import { mockStateSocket } from "./_state-socket-mock";
import { openPalette, seedComposeStrip } from "./_ready";

// Status bar e2e. Fully mocked (no tmux/gh) — the pane-register-panel.spec.ts /
// tooltips.spec.ts idiom: the state socket (mockStateSocket from
// _state-socket-mock.ts) delivers one session (`dev`) with one window (`@1`,
// all signal layers: waiting agent, fab change, open PR, git branch), a
// host-metrics snapshot (`e2e-box`), and a version slot (`0.9.3`).
// `/ws/terminals` is stubbed; `/api/servers` + window-select are fulfilled
// inline. `beforeEach` installs the mock. Default Playwright desktop viewport
// (1280px) unless a test resizes. The clock-chip test additionally stubs
// `GET /api/cron` via page.route (trailing `*` — withServer appends
// `?server=`) with one nextFire-bearing entry so the chip renders
// deterministically and the quake terminal drawer's Cron List has rows.
//
// Subjects: the full-width attached status strip at the shell bottom
// (desktop-only), the width-or-coarse mobile predicate that suppresses it, the
// fine-pointer bottom-bar DELETION, the window-cluster / host-cluster route
// split, the measured priority fold with the `…` overflow chevron (every
// segment renders at natural width or folds into the menu, one ladder across
// both clusters), and the `◷` clock chip that opens the quake terminal on the
// Cron List segment.

const SERVER = "default";

const sessionsPayload = JSON.stringify([
  {
    name: "dev",
    windows: [
      {
        // @1: all signal layers present — agent waiting, fab change, open PR.
        windowId: "@1",
        index: 0,
        name: "full-stack",
        worktreePath: "/tmp/wt",
        activity: "idle",
        isActiveWindow: true,
        activityTimestamp: 0,
        agentState: "waiting",
        agentIdleDuration: "3m",
        fabChange: "260814-ldbs-shell-stage-status-bar",
        fabStage: "apply",
        prUrl: "https://github.com/o/r/pull/603",
        prNumber: 603,
        prState: "open",
        prChecks: "pass",
        panes: [
          { paneId: "%1", paneIndex: 0, cwd: "/tmp/wt", command: "claude", isActive: true, gitBranch: "main" },
        ],
      },
    ],
  },
]);

const metricsPayload = {
  hostname: "e2e-box",
  cpu: { samples: [10, 17], current: 17, cores: 8 },
  memory: { used: 24 * 1024 ** 3, total: 59 * 1024 ** 3 },
  load: { avg1: 1.12, avg5: 0.9, avg15: 0.7, cpus: 8 },
  disk: { used: 100 * 1024 ** 3, total: 500 * 1024 ** 3 },
  uptime: 3600,
};

async function mockBackend(page: Page) {
  await page.routeWebSocket(/\/ws\/terminals/, () => {});
  await page.route("**/api/windows/*/select*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
  // The InstanceName provider reads the REAL /api/health — pin it so the
  // host segment's `instanceName ?? metrics.hostname` chain is deterministic
  // (a dev machine's own instance-name override would otherwise win).
  await page.route("**/api/health*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ hostname: "e2e-box", instanceName: null }),
    }),
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: SERVER, sessionCount: 1 }]),
    }),
  );
  await mockStateSocket(page, {
    sessions: sessionsPayload,
    metrics: metricsPayload,
    version: { version: "0.9.3", boot: "b1", brew: false },
  });
}

const statusBar = (page: Page) => page.getByTestId("status-bar");
const windowCluster = (page: Page) => page.getByTestId("status-bar-window");
const hostCluster = (page: Page) => page.getByTestId("status-bar-host");
// The bottom bar's toolbar role — absent on fine pointers (R3).
const keyToolbar = (page: Page) => page.getByRole("toolbar", { name: "Terminal keys" });

test.describe("Status bar (260814-ldbs)", () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page);
  });

  /**
   * Proves: on the desktop terminal route the status bar renders with BOTH
   * clusters — the window cluster mirrors the current window's registers
   * (tmux pane, cwd basename, git branch, agent state, fab change, PR as an
   * open-first anchor) and the host cluster shows compact metrics (mem as a
   * percentage), host+version, and the connection dot — while the
   * fine-pointer bottom bar is gone from the DOM entirely.
   *
   * Steps:
   * 1. Navigate to `/default/1`; wait for the status bar.
   * 2. Assert zero `Terminal keys` toolbars in the DOM.
   * 3. Assert the window cluster's register values (`%1` — the pane id leads;
   *    the ordinal only disambiguates multi-pane windows, `wt`,
   *    `main`, `waiting 3m`, the fab line, the `Open PR #603` link).
   * 4. Assert the host cluster (`17%` cpu, `41%` mem — 24G of 59G as a
   *    percentage, `e2e-box`, `v0.9.3`) and the `Connected` dot.
   */
  test("desktop terminal route: status bar present with BOTH clusters; no bottom bar exists", async ({ page }) => {
    await page.goto(`/${SERVER}/1`);
    await expect(statusBar(page)).toBeVisible({ timeout: 10_000 });

    // R3: the fine-pointer desktop has NO bottom bar at all.
    await expect(keyToolbar(page)).toHaveCount(0);

    // R4 left cluster — the current window's registers (same resolvers as the
    // retired desktop PANE panel).
    await expect(windowCluster(page).getByText("%1", { exact: true })).toBeVisible();
    await expect(windowCluster(page).getByText("wt")).toBeVisible(); // cwd basename
    await expect(windowCluster(page).getByText("main")).toBeVisible(); // git branch
    await expect(windowCluster(page).getByText("waiting 3m")).toBeVisible(); // agt
    // The fixture branch is `main` — the off-branch case, so the fab segment
    // keeps its slug (a branch carrying the change would drop it).
    await expect(windowCluster(page).getByText(/ldbs shell-stage-status-bar · apply/)).toBeVisible();
    // PR register: an open-first anchor.
    await expect(
      windowCluster(page).getByRole("link", { name: "Open PR #603 in a new tab" }),
    ).toBeVisible();

    // R4 right cluster — host metrics + host/version + the connection dot.
    await expect(hostCluster(page).getByText("17%")).toBeVisible();
    await expect(hostCluster(page).getByText("41%")).toBeVisible(); // mem as a percentage
    await expect(hostCluster(page).getByText("e2e-box")).toBeVisible();
    await expect(hostCluster(page).getByText("v0.9.3")).toBeVisible();
    await expect(statusBar(page).getByLabel("Connected")).toBeVisible();
  });

  /**
   * Proves: off the terminal route the status bar still renders (uniform
   * frame) but with the host cluster only — a route with no live window data
   * renders no window segments and no placeholder rows, and the bottom bar
   * is absent there too.
   *
   * Steps:
   * 1. Navigate to `/default`; wait for the status bar.
   * 2. Assert no `status-bar-window` element exists.
   * 3. Assert the host cluster shows the hostname and server name.
   * 4. Assert zero `Terminal keys` toolbars.
   */
  test("server route (no window): host cluster only — no window cluster, no errors", async ({ page }) => {
    await page.goto(`/${SERVER}`);
    await expect(statusBar(page)).toBeVisible({ timeout: 10_000 });
    await expect(windowCluster(page)).toHaveCount(0);
    await expect(hostCluster(page).getByText("e2e-box")).toBeVisible();
    await expect(hostCluster(page).getByText(SERVER)).toBeVisible();
    await expect(keyToolbar(page)).toHaveCount(0);
  });

  /**
   * Proves: the measured priority fold at a narrow desktop width. Every
   * segment renders at natural width or folds whole into the `…` menu, one
   * ladder across both clusters decided by fold priority (lowest first:
   * `ld`, then the `a▏`/`⌘K` hints, then `cwd`, then `tmx`) — never by CSS
   * breakpoint, never by truncation. At 1440px everything fits and no
   * chevron exists in the DOM; at 1050px (above the 640px mobile predicate,
   * ~170px under the fixture's ~1220px natural width) the lowest-priority segments
   * fold, the bar never scrolls, the chevron appears, and its menu lists
   * exactly the folded segments in strip order with full keyboard reach.
   *
   * Steps:
   * 1. Navigate to `/default/1`; wait for the window cluster.
   * 2. At 1440px assert all window segments visible and the chevron absent
   *    (count 0 — it renders only while something is folded).
   * 3. Resize to 1050×600; assert `wt`/`%1` folded away, `main`/`waiting 3m`/
   *    the fab line/the PR anchor still visible, and `scrollWidth ≤
   *    clientWidth` on the bar.
   * 4. Click the chevron; assert the menu lists `tmx`/`cwd` copy rows and no
   *    `out` row (the register is deleted outright).
   * 5. Assert focus enters the panel on the first row (the leftmost folded
   *    segment in strip order — `tmx`), that ArrowDown/ArrowUp rove to `cwd`
   *    and back, and that ArrowUp off the first row wraps to the last row
   *    (the compose action). Every rendered row is a folded segment, so no
   *    hidden-row skipping remains. This is the browser-only half of the
   *    contract; the unit suite covers the rove itself, where jsdom computes
   *    no layout.
   * 6. Press Escape; assert the menu closes.
   */
  test("narrow desktop width: low-priority segments fold (never scroll) and the … chevron lists them", async ({ page }) => {
    await page.goto(`/${SERVER}/1`);
    await expect(windowCluster(page)).toBeVisible({ timeout: 10_000 });

    // Wide (1440): every window segment shows, no chevron in the DOM.
    await page.setViewportSize({ width: 1440, height: 800 });
    await expect(windowCluster(page).getByText("%1", { exact: true })).toBeVisible();
    await expect(windowCluster(page).getByText("wt")).toBeVisible();
    await expect(statusBar(page).getByTestId("status-bar-overflow")).toHaveCount(0);

    // 1050px desktop band: the lowest-priority segments fold — ld, the two
    // hints, cwd, tmx — while the never-fold registers (git/agt/fab/PR)
    // survive at natural width; the bar does not scroll.
    await page.setViewportSize({ width: 1050, height: 600 });
    await expect(windowCluster(page).getByText("wt")).toBeHidden();
    await expect(windowCluster(page).getByText("%1", { exact: true })).toBeHidden();
    await expect(windowCluster(page).getByText("main")).toBeVisible();
    await expect(windowCluster(page).getByText("waiting 3m")).toBeVisible();
    await expect(windowCluster(page).getByText(/ldbs shell-stage-status-bar · apply/)).toBeVisible();
    await expect(
      windowCluster(page).getByRole("link", { name: "Open PR #603 in a new tab" }),
    ).toBeVisible();
    const bar = statusBar(page);
    const scrolls = await bar.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrolls, "the status bar must never scroll").toBe(false);

    // The chevron carries exactly the folded segments, in strip order.
    const chevron = statusBar(page).getByTestId("status-bar-overflow");
    await expect(chevron).toBeVisible();
    await chevron.click();
    const menu = page.getByRole("menu", { name: "Overflow status segments" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Copy tmux pane id" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Copy working directory path" })).toBeVisible();
    // No out row exists at any width — the register is deleted outright.
    await expect(menu.getByText(/^out /)).toHaveCount(0);
    // Keyboard: focus enters the panel on open on the FIRST row — the
    // leftmost folded segment in strip order (`tmx`, a copy row).
    await expect(menu.getByRole("menuitem", { name: "Copy tmux pane id" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Copy working directory path" })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(menu.getByRole("menuitem", { name: "Copy tmux pane id" })).toBeFocused();
    // Wrapping backwards off the first row lands on the LAST row — the
    // compose action (the last foldable segment in strip order).
    await page.keyboard.press("ArrowUp");
    await expect(menu.getByRole("menuitem", { name: "a▏ Compose" })).toBeFocused();
    // Escape closes and refocuses the trigger.
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });

  /**
   * Proves: the status bar's `a▏` hint is the desktop compose opener (the
   * relocated bottom-bar affordance): clicking it mounts the compose strip
   * and the hint reflects the pressed state.
   *
   * Steps:
   * 1. Seed the explicit opt-out (the strip is on by default; this test is
   *    about the hint OPENING it); navigate to `/default/1`; wait for the
   *    `status-bar-compose` button and assert it reads `aria-pressed="false"`.
   * 2. Click it; assert the strip's textarea (`compose-strip-input`) renders.
   * 3. Assert the hint is `aria-pressed="true"`.
   */
  test("the compose hint opens the compose strip (the relocated bottom-bar affordance)", async ({ page }) => {
    await seedComposeStrip(page, false);
    await page.goto(`/${SERVER}/1`);
    const compose = statusBar(page).getByTestId("status-bar-compose");
    await expect(compose).toBeVisible({ timeout: 10_000 });
    await expect(compose).toHaveAttribute("aria-pressed", "false");
    await compose.click();
    await expect(page.getByTestId("compose-strip-input")).toBeVisible();
    await expect(compose).toHaveAttribute("aria-pressed", "true");
  });

  /**
   * Proves: status-bar segments are click-to-copy of their RAW values (the
   * Pane panel's CopyableRow contract) — the cwd segment copies the FULL
   * absolute path (the strip shows only the basename), shows the transient
   * `copied ✓` label swap, and the host cluster's version fragment copies its
   * displayed `v…` form — with a real clipboard write, not a mocked seam.
   *
   * Steps:
   * 1. Grant clipboard permissions; navigate to `/default/1`.
   * 2. Click the `Copy working directory path` segment button.
   * 3. Assert the clipboard holds `/tmp/wt` (full path, not the `wt` basename)
   *    and the window cluster shows the `copied ✓` swap.
   * 4. Click the host cluster's `Copy version` button; assert the clipboard
   *    holds `v0.9.3`.
   */
  test("segments copy raw values to the real clipboard with the copied ✓ swap", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(`/${SERVER}/1`);
    await expect(statusBar(page)).toBeVisible({ timeout: 10_000 });

    await windowCluster(page).getByRole("button", { name: "Copy working directory path" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("/tmp/wt");
    await expect(windowCluster(page).getByText("copied ✓")).toBeVisible();

    await hostCluster(page).getByRole("button", { name: "Copy version" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("v0.9.3");
  });

  /**
   * Proves: an overflow-menu copy row is keyboard-activatable end to end —
   * at a fold-inducing width opening the `…` menu moves roving focus onto
   * the first folded row in strip order (the `tmx` copy row), a real Enter
   * keypress copies the RAW pane id (`%1`, not the row's `tmx %1` display
   * text), and the menu stays open (the user may want to read the row).
   *
   * Steps:
   * 1. Grant clipboard permissions; resize to 1050px (the fixture's natural
   *    width folds the low-priority segments, `tmx`/`cwd` among them, so the
   *    `…` chevron renders).
   * 2. Navigate to `/default/1`; click the chevron; wait for focus to land
   *    on the `Copy tmux pane id` row (the menu's focus-on-open contract).
   * 3. Press Enter; assert the clipboard holds `%1` and the row shows the
   *    `copied ✓` swap.
   * 4. Assert the menu is still open.
   */
  test("overflow copy rows activate via keyboard: Enter copies the raw value and keeps the menu open", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width: 1050, height: 600 });
    await page.goto(`/${SERVER}/1`);
    await expect(statusBar(page)).toBeVisible({ timeout: 10_000 });

    await page.getByTestId("status-bar-overflow").click();
    const menu = page.getByRole("menu", { name: "Overflow status segments" });
    const tmxRow = menu.getByRole("menuitem", { name: "Copy tmux pane id" });
    await expect(tmxRow).toBeFocused();

    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("%1");
    await expect(tmxRow).toContainText("copied ✓");
    await expect(menu).toBeVisible();
  });

  /**
   * Proves: the copy segments have command-palette parity (Constitution V —
   * the palette is the complete action registry): `Copy: Git Branch` copies
   * the raw branch name and confirms with a toast; the server/host copy
   * entries are listed too.
   *
   * Steps:
   * 1. Grant clipboard permissions; navigate to `/default/1`.
   * 2. Open the palette (openPalette); filter to `Copy:` and assert the
   *    Server Name / Host Name entries exist.
   * 3. Select `Copy: Git Branch`; assert the clipboard holds `main` and the
   *    `Git branch copied` toast shows.
   */
  test("copy actions have command-palette parity — Copy: Git Branch copies the raw value with a toast", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(`/${SERVER}/1`);
    await expect(statusBar(page)).toBeVisible({ timeout: 10_000 });

    const input = await openPalette(page);
    await input.fill("Copy:");
    await expect(page.getByRole("option", { name: "Copy: Workspace Name" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Copy: Host Name" })).toBeVisible();
    await page.getByRole("option", { name: "Copy: Git Branch" }).click();

    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("main");
    await expect(page.getByText("Git branch copied")).toBeVisible();
  });

  /**
   * Proves: either a narrow viewport or a coarse pointer selects the mobile
   * experience and removes the desktop status bar; only the coarse-pointer
   * case retains the terminal key toolbar.
   *
   * Steps:
   * 1. Open isolated narrow/fine and wide/coarse browser contexts.
   * 2. Navigate each context to `/default/1` and gate on mobile navigation.
   * 3. Assert the status bar is absent in both contexts.
   * 4. Assert the key toolbar is absent for fine input and visible for coarse
   *    input.
   */
  test("width or coarse pointer selects the mobile status-bar treatment", async ({ browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL;
    if (!baseURL) throw new Error("Playwright baseURL is required");

    const cases = [
      { label: "narrow fine pointer", hasTouch: false, viewport: { width: 375, height: 812 } },
      { label: "wide coarse pointer", hasTouch: true, viewport: { width: 1440, height: 800 } },
    ];

    for (const device of cases) {
      // Spread the project's contextOptions (notably `reducedMotion: "reduce"`)
      // so these hand-rolled contexts keep the config-level animation guard.
      const context = await browser.newContext({
        ...testInfo.project.use.contextOptions,
        baseURL,
        hasTouch: device.hasTouch,
        viewport: device.viewport,
      });
      try {
        const page = await context.newPage();
        await mockBackend(page);
        await page.goto(`/${SERVER}/1`);
        await expect(page.getByRole("button", { name: "Toggle navigation" }), device.label).toBeVisible({
          timeout: 10_000,
        });
        await expect(statusBar(page), device.label).toHaveCount(0);
        if (device.hasTouch) {
          await expect(keyToolbar(page), device.label).toBeVisible();
        } else {
          await expect(keyToolbar(page), device.label).toHaveCount(0);
        }
      } finally {
        await context.close();
      }
    }
  });

  /**
   * Proves: with a cron entry carrying a `nextFire`, the status bar's `◷`
   * clock chip renders in the right cluster, and clicking it opens the
   * quake terminal drawer directly on the Cron List segment.
   *
   * Steps:
   * 1. Stub `GET /api/cron` with one nextFire-bearing entry (the chip's
   *    next-fire state); navigate to `/default/1`.
   * 2. Assert the `status-bar-clock` chip is visible — the default 1280px
   *    viewport fits every segment, so the fold keeps the chip in the strip.
   * 3. Click the chip; assert the quake terminal drawer opens with the Cron List tab
   *    selected and the cron registry visible.
   */
  test("the clock chip opens the quake terminal on Cron List", async ({ page }) => {
    await page.route("**/api/cron*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          entries: [
            {
              id: "a3f9",
              name: "operator tick",
              schedule: { kind: "backoff", min: "60s", max: "30m" },
              target: { kind: "role", role: "operator" },
              payload: "tick",
              lastFired: 0,
              nextFire: Math.floor(Date.now() / 1000) + 600,
            },
          ],
          deliveries: [],
        }),
      }),
    );
    await page.goto(`/${SERVER}/1`);
    const chip = statusBar(page).getByTestId("status-bar-clock");
    await expect(chip).toBeVisible({ timeout: 10_000 });

    await chip.click();

    const drawer = page.getByTestId("quake-terminal");
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByTestId("terminal-activity-tabs").getByRole("tab", { name: "Cron List" }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(drawer.getByTestId("cron-list")).toBeVisible({ timeout: 10_000 });
  });
});
