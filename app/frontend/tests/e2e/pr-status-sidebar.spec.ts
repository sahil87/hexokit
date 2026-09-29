import { test, expect, type Page } from "@playwright/test";
import { mockStateSocket } from "./_state-socket-mock";

// The Pane panel's live PR-status row: it renders for a change-bound window
// that has a PR and is hidden for a scratch window, at both mobile and
// desktop viewports. PR status renders in the Pane panel (the per-window
// metadata panel in the sidebar), NOT on the window-tree rows — so each
// assertion first selects the target window, then reads the Pane panel.
//
// This spec is fully mocked: the isolated e2e tmux server has no real
// change-bound PRs and `gh` is unavailable in CI, so we inject the SSE
// `sessions` payload (and the server list) via page.route. That lets us
// exercise the frontend display gate deterministically without any network or
// gh dependency.
//
// Shared setup: **/api/servers → a single server `default` (so the app
// attaches exactly one state-socket connection); /ws/state (via
// mockStateSocket) carries session `dev` with two windows — @1
// "feature-work" (change-bound, with prNumber 386, prUrl, prState open,
// prChecks pass, prReview approved — the gate satisfied; @1 is the active
// window, so the Pane panel reflects it on load) and @2 "scratch-shell" (no
// fabChange — the gate fails). beforeEach installs both routes before
// navigation and seeds localStorage['hexokit-sidebar-section-pane'] = 'true'
// via addInitScript — the Pane panel is visibility-gated and defaults OFF,
// and the seed re-runs on every navigation, keeping the panel mounted through
// the in-test goto sequences.

const SERVER = "default";

// One change-bound window with a PR (gate satisfied) and one scratch window
// with NO fabChange (gate fails — PR row must be absent even if a prNumber
// were present). The change-bound window carries prState/prChecks/prReview as
// the backend SSE join would attach them.
const sessionsPayload = JSON.stringify([
  {
    name: "dev",
    windows: [
      {
        windowId: "@1",
        index: 0,
        name: "feature-work",
        worktreePath: "/tmp/wt",
        activity: "active",
        isActiveWindow: true,
        activityTimestamp: 0,
        fabChange: "260610-596o-pr-status-sidebar",
        fabStage: "apply",
        prUrl: "https://github.com/o/r/pull/386",
        prNumber: 386,
        prState: "open",
        prChecks: "pass",
        prReview: "approved",
      },
      {
        windowId: "@2",
        index: 1,
        name: "scratch-shell",
        worktreePath: "/tmp/scratch",
        activity: "idle",
        isActiveWindow: false,
        activityTimestamp: 0,
      },
    ],
  },
]);

// The Pane panel renders the *selected* window (URL `/$server/$window`), so the
// tests navigate to the window route. The URL segment is the window id's numeric
// part (`@N` sans `@`); parse restores `@N`.
const BOUND_WINDOW_URL = `/${SERVER}/1`; // @1 — change-bound window with a PR
const SCRATCH_WINDOW_URL = `/${SERVER}/2`; // @2 — scratch window, no PR

/** Install routes that fully mock the server list and the SSE sessions stream. */
async function mockBackend(page: Page) {
  // Stub the terminals mux WebSocket (/ws/terminals — the per-pane /relay/
  // socket was retired in 260717-803u) so the terminal route mounts without a backend —
  // the Pane panel lives in the sidebar and renders regardless, but stubbing
  // the WS keeps the page from churning on failed stream reconnects.
  await page.routeWebSocket(/\/ws\/terminals/, () => {
    /* accept and hold the socket open; send nothing */
  });

  // Selecting a window POSTs to /select — accept it so clicks/nav don't error.
  await page.route("**/api/windows/*/select", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );

  // Single known server so the app attaches exactly one SSE connection.
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: SERVER, sessionCount: 1 }]),
    }),
  );

  // State socket: the mock answers hello + subscribe, delivering the mocked
  // sessions payload as the subscribe ack snapshot + a live `sessions` event.
  await mockStateSocket(page, { sessions: sessionsPayload });
}

test.describe("Pane panel PR status", () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page);
    // The Pane panel is visibility-gated and defaults OFF (iha5) — opt the
    // section in. The init script re-runs on every navigation, so the
    // in-test goto/reload sequences keep the panel mounted.
    await page.addInitScript(() => {
      localStorage.setItem("hexokit-sidebar-section-pane", "true");
    });
  });

  /**
   * Proves: the display gate is fabChange && prNumber — when the selected
   * window is change-bound with a PR, the Pane panel shows the `pr` row (an
   * open-in-new-tab link titled with the PR URL); when the selected window is
   * a scratch window, no PR row appears. (Locators are scoped to the
   * nav[aria-label='Sessions'] sidebar: with the Pane section opted in, the
   * desktop status bar legitimately renders its own PR link copy, and an
   * unscoped [title] locator trips Playwright strict mode.)
   *
   * Steps:
   * 1. Navigate directly to the change-bound window route /default/1 (@1; the
   *    URL segment is the window id's numeric part) — the Pane panel reflects
   *    the URL-selected window.
   * 2. Assert the Pane panel's pr row — the element titled with the PR URL —
   *    is visible and contains `#386` and `open`.
   * 3. Navigate to the scratch window route /default/2 (@2).
   * 4. Assert no element is titled with the PR URL (count 0) and no `#386`
   *    text appears anywhere in the Pane panel.
   */
  test("Pane panel shows the PR row for a change-bound window and hides it for a scratch window", async ({
    page,
  }) => {
    // Select the change-bound window (@1) — the Pane panel reflects the selected
    // window, which is keyed off the URL's window segment.
    await page.goto(BOUND_WINDOW_URL);

    // Change-bound window (@1): Pane panel carries the pr row. Scoped to the
    // sidebar nav — the desktop status bar renders its own PR link copy (the
    // panel is opted-in here, so both surfaces legitimately render it).
    const prRow = page.locator(
      "nav[aria-label='Sessions'] [title='https://github.com/o/r/pull/386']",
    );
    await expect(prRow).toBeVisible();
    await expect(prRow).toContainText("#386");
    await expect(prRow).toContainText("open");

    // Scratch window (@2) — not change-bound → no pr row.
    await page.goto(SCRATCH_WINDOW_URL);
    await expect(
      page.locator("nav[aria-label='Sessions'] [title='https://github.com/o/r/pull/386']"),
    ).toHaveCount(0);
    // No PR-number text anywhere in the Pane panel for the scratch window.
    await expect(page.locator("nav[aria-label='Sessions']").getByText(/#386/)).toHaveCount(0);
  });

  /**
   * Proves: the Pane panel's PR row is present and readable at both the
   * mobile (375px) and desktop (1024px) breakpoints — covering the responsive
   * requirement.
   *
   * Steps:
   * 1. Set viewport to 375×812 and navigate to the change-bound window route
   *    /default/1 (@1).
   * 2. Open the mobile sidebar drawer (which hosts the Pane panel) via the
   *    top-bar `Toggle navigation` button.
   * 3. Assert the pr row (titled with the PR URL) contains `#386`.
   * 4. Set viewport to 1024×800 and navigate to /default/1 again.
   * 5. Assert the pr row (titled with the PR URL) contains `#386` in the
   *    persistent desktop sidebar.
   */
  test("Pane panel PR row renders at 375px (mobile) and 1024px (desktop)", async ({ page }) => {
    // Mobile: open the sidebar drawer (which hosts the Pane panel), assert the
    // pr row for the selected change-bound window (@1).
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(BOUND_WINDOW_URL);
    await page.locator("button[aria-label='Toggle navigation']").click();
    await expect(
      page.locator("nav[aria-label='Sessions'] [title='https://github.com/o/r/pull/386']"),
    ).toContainText("#386");

    // Desktop: persistent sidebar column — the pr row still renders (the Pane
    // section is seeded ON, the opt-in path; scoped to the nav so the status
    // bar's own PR link copy doesn't trip strict mode).
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto(BOUND_WINDOW_URL);
    await expect(
      page.locator("nav[aria-label='Sessions'] [title='https://github.com/o/r/pull/386']"),
    ).toContainText("#386");
  });
});
