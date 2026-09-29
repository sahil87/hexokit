import { test, expect, type Page } from "@playwright/test";
import { mockStateSocket } from "./_state-socket-mock";
import { openPalette } from "./_ready";

// Fully mocked (no tmux/gh) — inject the SSE `sessions` payload + server list
// via page.route. Exercises the PANE panel's four-register view
// (docs/specs/status-pyramid.md § Row Minimalism): out (L0) / agt (L1) /
// fab (L2) / PR (L3) render as separate orthogonal lines, never collapsed, so
// the sidebar StatusDot is a pure function of what the panel shows. The
// L0/L1 register keys are fixed-width 3-char (`out`/`agt`, matching
// tmx/cwd/git). Absent layers render as absent (a plain shell shows only
// `out`). The L3 PR register shows for ANY pane with a prNumber (ungated from
// fabChange — universal derivation, Principle X). The fab register drops its
// slug when the pane's branch carries the change (the slug is written once —
// the branch carries it), and the cwd row is basename-first: the abbreviated
// parent head-truncates while the basename never clips. The `pr` and `fab`
// rows are two-line rows: the decisive tokens on the key line (`#n · state`,
// `id · stage · state`) and the expendable tail (the PR health facts; the slug
// when the branch does not carry it) on a dim continuation line — a row never
// exceeds two lines and a continuation line renders only with content.
//
// Shared setup: **/api/servers → a single server `default`;
// **/api/windows/*/select* → 200; /ws/state (via mockStateSocket) carries the
// subscribe ack + sessions event with session `dev` and three windows — @1
// "full-stack" (all four layers: agentState waiting 3m, fabChange/fabStage
// review/fabDisplayState failed, derived PR #386, branch + long cwd carrying
// the change slug), @2 "plain-shell" (a bare shell — only L0 output), @3
// "pr-only" (no fabChange, derived PR #999); the terminals mux WebSocket
// (/ws/terminals) is stubbed. beforeEach seeds hexokit-sidebar-section-pane =
// "true" via addInitScript, then installs the routes before navigation.
//
// The PANE panel is visibility-gated and default-off on every viewport (its
// registers live in the desktop status bar), so the mobile suite seeds the
// section on, runs test.use({ hasTouch: true, viewport: 375×812 }), and opens
// the drawer (Toggle navigation button → role="dialog") before asserting.
//
// The second describe runs at the default desktop viewport (1280px, fine
// pointer) with the SAME mocked backend and does NOT seed the section: it
// proves the status bar's window cluster (`status-bar-window`) yields to the
// PANE panel while the panel is on screen — section on (via the palette's
// `Panel: Toggle Pane`) AND the sidebar open — and comes back when either is
// false (section off again, or the sidebar collapsed via the top bar's
// `Toggle navigation` button). The host cluster (`status-bar-host`) stays in
// every state.

const SERVER = "default";

const sessionsPayload = JSON.stringify([
  {
    name: "dev",
    windows: [
      {
        // @1: all four layers present — a fab window with an agent and a PR.
        // The pane's branch CARRIES the change, so the fab register shows the
        // id form (`y1ar · review · failed`) — the slug is written once, on
        // the git row. The long cwd exercises the basename-first rule: the
        // parent yields (head-truncates), the basename never clips.
        windowId: "@1",
        index: 0,
        name: "full-stack",
        worktreePath: "/home/sahil/code/sahil87/run-kit.worktrees/status-pyramid-ui-surfacing",
        activity: "idle",
        isActiveWindow: true,
        activityTimestamp: 0,
        agentState: "waiting",
        agentIdleDuration: "3m",
        fabChange: "260706-y1ar-status-pyramid-ui-surfacing",
        fabStage: "review",
        fabDisplayState: "failed",
        prUrl: "https://github.com/o/r/pull/386",
        prNumber: 386,
        prState: "open",
        prChecks: "fail",
        panes: [{ paneId: "%1", paneIndex: 0, cwd: "/home/sahil/code/sahil87/run-kit.worktrees/status-pyramid-ui-surfacing", command: "claude", isActive: true, gitBranch: "260706-y1ar-status-pyramid-ui-surfacing" }],
      },
      {
        // @2: a plain shell — only the L0 output register is present.
        windowId: "@2",
        index: 1,
        name: "plain-shell",
        worktreePath: "/tmp/scratch",
        activity: "idle",
        isActiveWindow: false,
        activityTimestamp: 0,
        panes: [{ paneId: "%2", paneIndex: 0, cwd: "/tmp/scratch", command: "zsh", isActive: true }],
      },
      {
        // @3: a plain pane WITH a PR but no fab change — the L3 PR register
        // still shows (universal derivation) even though the dot stays gray.
        windowId: "@3",
        index: 2,
        name: "pr-only",
        worktreePath: "/tmp/pr",
        activity: "idle",
        isActiveWindow: false,
        activityTimestamp: 0,
        prUrl: "https://github.com/o/r/pull/999",
        prNumber: 999,
        prState: "open",
        prChecks: "pass",
        panes: [{ paneId: "%3", paneIndex: 0, cwd: "/tmp/pr", command: "zsh", isActive: true }],
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
      body: JSON.stringify([{ name: SERVER, sessionCount: 1 }]),
    }),
  );
  await mockStateSocket(page, { sessions: sessionsPayload });
}

test.describe("PANE panel four-register view", () => {
  // The PANE panel is visibility-gated and DEFAULT-OFF (iha5 — the 260814-ldbs
  // drawer-only fork became a `hexokit-sidebar-section-pane` default): seed the
  // section on via addInitScript (the sidebar-panels.spec.ts idiom), run at the
  // mobile viewport, and open the drawer before asserting. `hasTouch` flips
  // both `(pointer: coarse)` and `(any-pointer: coarse)`, so `useIsMobile()`
  // reports mobile.
  test.use({ hasTouch: true, viewport: { width: 375, height: 812 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("hexokit-sidebar-section-pane", "true");
    });
    await mockBackend(page);
  });

  /** Navigate to a window, then open the drawer (the panel's home). Gates on
   *  the Toggle navigation button — the sidebar-footed `Connected` dot is
   *  unmounted while the drawer is closed. */
  async function gotoWindowWithDrawer(page: Page, windowId: string) {
    await page.goto(`/${SERVER}/${windowId}`);
    const toggle = page.getByRole("button", { name: "Toggle navigation" });
    await expect(toggle).toBeVisible({ timeout: 10_000 });
    await toggle.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10_000 });
  }

  /**
   * Proves: every signal layer that exists for a window renders as its own
   * register line — out (L0), agt (L1, with the waiting duration), fab (L2,
   * change · stage), and PR (L3) — and the L0/L1 keys use the fixed-width
   * 3-char vocabulary (`out`/`agt`). The fab register reads in the id form
   * (`y1ar · review · failed`, no slug) because the pane's branch carries the
   * change — the slug is written once, on the git row. The long cwd renders
   * basename-first: the basename element stays fully inside the row (never
   * clipped) while the abbreviated parent span yields.
   *
   * Steps:
   * 1. Navigate to /default/1, then open the drawer.
   * 2. Assert the register-output (L0) test id is visible and contains the
   *    key text "out" as a whole token (/\bout\b/, not a bare substring — a
   *    regressed `output` key would still contain "out").
   * 3. Assert register-agent (L1) is visible and contains the key text "agt"
   *    and "waiting 3m".
   * 4. Assert the fab register (L2) reads `y1ar · review · failed` and does
   *    NOT contain the slug (the branch carries it), and that no
   *    `fab-line-cont` continuation line exists.
   * 5. Assert the PR register (L3) key line `pr-line` reads `#386 · open`
   *    and the continuation line `pr-line-cont` carries `checks fail`.
   * 6. Assert the cwd basename element's box lies fully inside its row and
   *    the dim parent span is present (the basename lookup is scoped to the
   *    cwd row — the git row's branch rest renders the same text).
   */
  test("a full window shows all four registers (out/agt/fab/PR)", async ({ page }) => {
    await gotoWindowWithDrawer(page, "1");
    // L0 out register (always present) — fixed-width 3-char key.
    const output = page.getByTestId("register-output");
    await expect(output).toBeVisible();
    // Match `out` as a whole token (word boundaries), not a bare substring:
    // a regressed `output` key still contains "out", so toContainText("out")
    // would pass even if the 3-char normalization broke. /\bout\b/ matches the
    // "out " key but NOT "output" (t→p is not a word boundary).
    await expect(output).toContainText(/\bout\b/);
    // L1 agt register — 3-char key + the waiting agent + duration.
    const agent = page.getByTestId("register-agent");
    await expect(agent).toBeVisible();
    await expect(agent).toContainText("agt");
    await expect(agent).toContainText("waiting 3m");
    // L2 fab register — id · stage · displayState, NO slug: the pane's branch
    // carries the change, so the slug is written once (on the git row).
    const fabRow = page.getByRole("button", { name: /^fab y1ar/ });
    await expect(fabRow).toContainText("y1ar · review · failed");
    await expect(fabRow).not.toContainText("status-pyramid-ui-surfacing");
    await expect(page.getByTestId("fab-line-cont")).toHaveCount(0);
    // L3 PR register — identity on the key line, the health facts on the
    // dim continuation line (two lines, never a truncated one-liner).
    await expect(page.getByTestId("pr-line")).toHaveText("#386 · open");
    await expect(page.getByTestId("pr-line-cont")).toContainText("checks fail");
    // cwd basename-first: the basename never clips (the parent head-truncates).
    // Scoped to the cwd row's button (its title is the full path) — the bare
    // text also appears as the git row's branch rest, so an unscoped lookup
    // resolves two elements and fails strict mode.
    const cwdRow = page.locator('button[title="/home/sahil/code/sahil87/run-kit.worktrees/status-pyramid-ui-surfacing"]');
    const basename = cwdRow.getByText("status-pyramid-ui-surfacing", { exact: true });
    await expect(basename).toBeVisible();
    const parent = page.locator("bdi", { hasText: "run-kit.worktrees/" });
    await expect(parent).toBeVisible();
    const fits = await basename.evaluate((el) => {
      const row = el.closest("button");
      if (!row) return false;
      const b = el.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      return b.left >= r.left && b.right <= r.right;
    });
    expect(fits, "the cwd basename must render fully inside its row").toBe(true);
  });

  /**
   * Proves: a bare shell pane (no agent, no change, no PR) renders only the
   * L0 output register — the agent/fab/PR registers are absent, not
   * placeholder rows.
   *
   * Steps:
   * 1. Navigate to /default/2, then open the drawer.
   * 2. Assert register-output is visible.
   * 3. Assert register-agent has count 0 and the PR `pr-line` has count 0.
   */
  /**
   * Proves: the register rows form a monospace grid — the tmx, cwd, git, pr,
   * and out rows' leading icons share one x-coordinate (a 4-advance key
   * column), and the rows whose icon is a Nerd Font glyph (tmx, cwd, git, pr)
   * share a value column too, so the panel reads as aligned columns rather
   * than ragged rows. The cwd and pr rows are flex rows: their key gap would
   * be trimmed as flex whitespace, and their icon→value gap would measure at
   * the icon's larger font size, without the non-collapsible gaps placed as
   * they are. The out row's braille glyph has a font-dependent advance, so
   * its value column is not asserted.
   *
   * Steps:
   * 1. Navigate to /default/1, then open the drawer.
   * 2. Locate each row's icon span (the first `aria-hidden` span in the tmx,
   *    cwd, git buttons, the pr anchor, and the register-output line) and
   *    the value element that follows it.
   * 3. Assert all five icon boxes share the tmx icon's left edge (±0.5px).
   * 4. Assert the tmx, cwd, git, and pr value boxes share the tmx value's
   *    left edge (±0.5px).
   */
  test("the tmx/cwd/git/pr/out icons and values align into columns", async ({ page }) => {
    await gotoWindowWithDrawer(page, "1");
    const glyphRows = [
      page.getByRole("button", { name: /^tmx/ }),
      page.locator('button[title="/home/sahil/code/sahil87/run-kit.worktrees/status-pyramid-ui-surfacing"]'),
      page.getByRole("button", { name: /^git/ }),
      page.locator("a", { has: page.getByTestId("pr-line") }),
    ];
    const rows = [...glyphRows, page.getByTestId("register-output")];
    const iconLefts: number[] = [];
    const valueLefts: number[] = [];
    for (const row of rows) {
      const icon = row.locator('span[aria-hidden="true"]').first();
      await expect(icon).toBeVisible();
      const value = icon.locator("xpath=following-sibling::span[1]");
      const iconBox = await icon.boundingBox();
      const valueBox = await value.boundingBox();
      expect(iconBox).not.toBeNull();
      expect(valueBox).not.toBeNull();
      iconLefts.push(iconBox!.x);
      valueLefts.push(valueBox!.x);
    }
    for (const x of iconLefts) expect(Math.abs(x - iconLefts[0])).toBeLessThanOrEqual(0.5);
    for (const x of valueLefts.slice(0, glyphRows.length)) expect(Math.abs(x - valueLefts[0])).toBeLessThanOrEqual(0.5);
  });

  test("a plain shell shows only the output register (absent layers absent)", async ({ page }) => {
    await gotoWindowWithDrawer(page, "2");
    await expect(page.getByTestId("register-output")).toBeVisible();
    // No agent, fab, or PR registers for a bare shell.
    await expect(page.getByTestId("register-agent")).toHaveCount(0);
    await expect(page.getByTestId("pr-line")).toHaveCount(0);
  });

  /**
   * Proves: the L3 PR register is ungated from fabChange — a plain pane on a
   * branch with a PR still surfaces its PR in the panel (even though the dot
   * stays on the gray floor via D1).
   *
   * Steps:
   * 1. Navigate to /default/3, then open the drawer.
   * 2. Assert the PR `pr-line` contains "#999".
   * 3. Assert the agent register has count 0 (no change bound, no agent).
   */
  test("the PR register (L3) shows for a plain pane with a PR (universal derivation)", async ({ page }) => {
    await gotoWindowWithDrawer(page, "3");
    // No fab change on this window, yet the PR register still surfaces the PR.
    await expect(page.getByTestId("pr-line")).toContainText("#999");
    // No fab register (no change bound).
    await expect(page.getByTestId("register-agent")).toHaveCount(0);
  });
});

test.describe("PANE-on yields the status bar's window cluster (desktop)", () => {
  // Default desktop viewport (1280px, fine pointer): the status bar renders
  // and the PANE section starts OFF (nothing seeded) — the bar is the register
  // view until the user opts the panel in.
  test.beforeEach(async ({ page }) => {
    await mockBackend(page);
  });

  const windowCluster = (page: Page) => page.getByTestId("status-bar-window");
  const hostCluster = (page: Page) => page.getByTestId("status-bar-host");
  const paneHeader = (page: Page) =>
    page.locator("nav[aria-label='Sessions']").getByRole("button", { name: /^Pane/ });

  /** Run a palette action by its exact label. */
  async function runPalette(page: Page, label: string) {
    const input = await openPalette(page);
    await input.fill(label);
    await page.getByRole("option", { name: label }).click();
  }

  /**
   * Proves: the register view has one desktop home at a time — toggling the
   * PANE section on (palette `Panel: Toggle Pane`) mounts the panel in the
   * open sidebar and REMOVES the status bar's window cluster, while the host
   * cluster stays; toggling it off again brings the cluster back.
   *
   * Steps:
   * 1. Navigate to /default/1; wait for the status bar's host cluster.
   * 2. Assert `status-bar-window` count 1 and no PANE header in the sidebar.
   * 3. Run `Panel: Toggle Pane`; assert the PANE header is visible,
   *    `status-bar-window` count 0, `status-bar-host` still visible.
   * 4. Run `Panel: Toggle Pane` again; assert `status-bar-window` count 1
   *    and the PANE header is gone.
   */
  test("toggling the Pane section on yields the window cluster; off restores it", async ({ page }) => {
    await page.goto(`/${SERVER}/1`);
    await expect(hostCluster(page)).toBeVisible({ timeout: 10_000 });
    await expect(windowCluster(page)).toHaveCount(1);
    await expect(paneHeader(page)).toHaveCount(0);

    await runPalette(page, "Panel: Toggle Pane");
    await expect(paneHeader(page)).toBeVisible();
    await expect(windowCluster(page)).toHaveCount(0);
    await expect(hostCluster(page)).toBeVisible();

    await runPalette(page, "Panel: Toggle Pane");
    await expect(windowCluster(page)).toHaveCount(1);
    await expect(paneHeader(page)).toHaveCount(0);
  });

  /**
   * Proves: the yield is gated on the panel being ON SCREEN, not merely
   * opted in — with the section on, collapsing the sidebar (the top bar's
   * `Toggle navigation` button) unmounts the panel and the bar's window
   * cluster returns; reopening the sidebar yields it again.
   *
   * Steps:
   * 1. Seed `hexokit-sidebar-section-pane = "true"`; navigate to /default/1.
   * 2. Assert the PANE header is visible and `status-bar-window` count 0.
   * 3. Click `Toggle navigation`; assert the PANE header is gone and
   *    `status-bar-window` count 1.
   * 4. Click `Toggle navigation` again; assert `status-bar-window` count 0.
   */
  test("collapsing the sidebar with the Pane section on hands the registers back to the bar", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("hexokit-sidebar-section-pane", "true");
    });
    await page.goto(`/${SERVER}/1`);
    await expect(hostCluster(page)).toBeVisible({ timeout: 10_000 });
    await expect(paneHeader(page)).toBeVisible();
    await expect(windowCluster(page)).toHaveCount(0);

    const sidebarToggle = page.getByRole("button", { name: "Toggle navigation" });
    await sidebarToggle.click();
    await expect(paneHeader(page)).toHaveCount(0);
    await expect(windowCluster(page)).toHaveCount(1);

    await sidebarToggle.click();
    await expect(paneHeader(page)).toBeVisible();
    await expect(windowCluster(page)).toHaveCount(0);
  });

  /**
   * Proves: collapsing the PANE panel has the same effect on the bar as
   * hiding it — a collapsed header shows no registers, so the bar's window
   * cluster returns while the header stays; expanding the panel yields the
   * cluster again.
   *
   * Steps:
   * 1. Seed `hexokit-sidebar-section-pane = "true"`; navigate to /default/1.
   * 2. Assert the PANE header is expanded (aria-expanded true) and
   *    `status-bar-window` count 0.
   * 3. Click the PANE header; assert aria-expanded false, the header still
   *    visible, and `status-bar-window` count 1.
   * 4. Click the header again; assert aria-expanded true and
   *    `status-bar-window` count 0.
   */
  test("collapsing the PANE panel hands the registers back to the bar; expanding yields them", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("hexokit-sidebar-section-pane", "true");
    });
    await page.goto(`/${SERVER}/1`);
    await expect(hostCluster(page)).toBeVisible({ timeout: 10_000 });
    await expect(paneHeader(page)).toHaveAttribute("aria-expanded", "true");
    await expect(windowCluster(page)).toHaveCount(0);

    await paneHeader(page).click();
    await expect(paneHeader(page)).toHaveAttribute("aria-expanded", "false");
    await expect(paneHeader(page)).toBeVisible();
    await expect(windowCluster(page)).toHaveCount(1);

    await paneHeader(page).click();
    await expect(paneHeader(page)).toHaveAttribute("aria-expanded", "true");
    await expect(windowCluster(page)).toHaveCount(0);
  });
});
