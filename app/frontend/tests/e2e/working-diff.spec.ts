import { test, expect, type Page } from "@playwright/test";
import { READY_TIMEOUT } from "./_ready";
import { mockStateSocket } from "./_state-socket-mock";

// Working-directory surface e2e (spec docs/specs/working-diff.md).
//
// FULLY MOCKED — no tmux, no git, no real backend. `page.route` stubs
// `**/api/servers`, `**/api/windows/*/options*` (the surface toggle's layout
// write), `**/api/diff*` and `/ws/terminals`; `mockStateSocket` injects one
// session with two windows — @1 `in-repo` (a `gitRoot`, so the surface is
// available) and @2 `no-repo` (none, so it is unreachable).
//
// The mock is what makes this deterministic: the real payload is whatever
// happens to be uncommitted on the machine running the test.
//
// Viewport is desktop (1440×800): the surface-toggle group renders in toggle
// mode only on a fine pointer at desktop width.

const SERVER = "default";

const SNAPSHOT = {
  root: "/repo",
  readAt: "2026-09-29T12:00:00Z",
  clean: false,
  files: [
    {
      path: "app/backend/api/widget.go",
      status: "modified",
      staged: true,
      additions: 2,
      deletions: 1,
      hasPatch: true,
      rowCount: 4,
      rows: [
        { kind: "hunk", header: "@@ -1,3 +1,4 @@" },
        { kind: "ctx", side: "R", l: 1, left: 1, right: 1, at: 1, spans: [{ t: "package api" }] },
        { kind: "del", side: "L", l: 2, left: 2, at: 2, spans: [{ t: "var Old = 1" }] },
        { kind: "add", side: "R", l: 2, right: 2, at: 2, spans: [{ t: "var New = 2" }] },
      ],
    },
    {
      path: "notes.txt",
      status: "untracked",
      staged: false,
      additions: 1,
      deletions: 0,
      hasPatch: true,
      rowCount: 1,
      rows: [{ kind: "add", side: "R", l: 1, right: 1, at: 1, spans: [{ t: "scratch" }] }],
    },
  ],
};

function sessionsPayload(clean = false) {
  return JSON.stringify([
    {
      name: "dev",
      windows: [
        {
          windowId: "@1",
          index: 0,
          name: "in-repo",
          worktreePath: "/repo",
          activity: "idle",
          isActiveWindow: true,
          activityTimestamp: 0,
          gitRoot: "/repo",
        },
        {
          windowId: "@2",
          index: 1,
          name: "no-repo",
          worktreePath: "/tmp/b",
          activity: "idle",
          isActiveWindow: false,
          activityTimestamp: 0,
        },
      ],
    },
  ]);
}

async function mockBackend(page: Page, body: unknown = SNAPSHOT) {
  await page.routeWebSocket(/\/ws\/terminals/, () => {});
  await page.route("**/api/windows/*/options*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: SERVER, sessionCount: 1 }]),
    }),
  );
  await page.route("**/api/diff/file*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        path: "notes.txt",
        rows: SNAPSHOT.files[1].rows,
        refine: false,
        totalLines: 1,
        headSha: "",
        baseSha: "",
        highlighted: true,
      }),
    }),
  );
  // Registered LAST so the more specific sub-path above wins.
  await page.route("**/api/diff?*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }),
  );
  await mockStateSocket(page, { sessions: sessionsPayload() });
}

/** The bar renders TWO `surface-toggles` nodes: the real chip, and the probe
 *  the fit pipeline measures the group with. The probe sits at
 *  `absolute -left-[9999px]`, which Playwright still counts as visible, so
 *  `filter({ visible: true })` does NOT disambiguate them. The chip is first in
 *  DOM order; the probe follows inside the off-screen measuring container. */
function toggleGroup(page: Page) {
  return page.getByTestId("surface-toggles").first();
}

/** `windowNumber` is 1-BASED, the way the route addresses windows — not the
 *  payload's 0-based `index`. */
async function openWorking(page: Page, windowNumber: number) {
  await page.goto(`/${SERVER}/${windowNumber}`);
  const toggle = toggleGroup(page).getByRole("button", { name: "Working tile" });
  await expect(toggle).toBeVisible({ timeout: READY_TIMEOUT });
  await toggle.click();
  await expect(page.getByTestId("working-surface")).toBeVisible({ timeout: READY_TIMEOUT });
}

test.describe("working-directory surface", () => {
  // Wide enough that the top bar never folds the surface-toggle group into the
  // overflow menu: this spec asserts on the BAR chip, and the fold threshold
  // moves with the sidebar state.
  test.use({ viewport: { width: 1920, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await mockBackend(page);
  });

  /**
   * Proves: the surface is REPO-backed — the toggle is offered on a window
   * whose pane sits in a git repo and withheld on one that does not, off the
   * `gitRoot` already on the SSE payload (spec § W1).
   */
  test("the toggle appears only for a window inside a git repository", async ({ page }) => {
    await page.goto(`/${SERVER}/1`);
    const group = toggleGroup(page);
    await expect(group.getByRole("button", { name: "Working tile" })).toBeVisible({
      timeout: READY_TIMEOUT,
    });

    await page.goto(`/${SERVER}/2`);
    await expect(group).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(group.getByRole("button", { name: "Working tile" })).toHaveCount(0);
  });

  /**
   * Proves: the file list renders the tree's changes with git's own status
   * letters, and staged-ness is a per-file badge rather than a second view
   * (spec § W3).
   */
  test("the changed files render with git status letters and a staged badge", async ({ page }) => {
    await openWorking(page, 1);
    const surface = page.getByTestId("working-surface");
    await expect(surface.getByTestId("working-status")).toHaveText(["M", "?"]);
    await expect(surface.getByTestId("working-staged")).toHaveCount(1);
    await expect(page.getByTestId("working-tree")).toBeVisible();
  });

  /**
   * Proves: READ-ONLY. A working-tree line has no GitHub address to anchor a
   * thread to, so the row offers no comment affordance at all rather than one
   * that opens a composer with nowhere to post (spec § W5).
   */
  test("a diff row offers no comment composer", async ({ page }) => {
    await openWorking(page, 1);
    const row = page.getByTestId("working-surface").locator("[data-side]").first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByPlaceholder(/comment/i)).toHaveCount(0);
  });

  /**
   * Proves: a clean tree is a STATE, not an absence — the lens stays available
   * and renders an empty state, because a tile that vanished when you
   * committed is an absence the reader has to interpret (spec § W1).
   */
  test("a clean tree keeps its tile and says so", async ({ page }) => {
    await page.unroute("**/api/diff?*");
    await page.route("**/api/diff?*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...SNAPSHOT, files: [], clean: true }),
      }),
    );
    await page.goto(`/${SERVER}/1`);
    const toggle = toggleGroup(page).getByRole("button", { name: "Working tile" });
    await expect(toggle).toBeVisible({ timeout: READY_TIMEOUT });
    await toggle.click();
    await expect(page.getByTestId("working-empty")).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByTestId("working-empty")).toContainText(/clean/i);
  });

  /**
   * Proves: the diff rows carry the same data-side / data-l / data-at
   * anchoring contract the PR surface renders, because they come through the
   * same row model (internal/diffrows).
   */
  test("diff rows carry the shared anchoring contract", async ({ page }) => {
    await openWorking(page, 1);
    const file = page.locator('[data-path="app/backend/api/widget.go"]');
    // The added line is post-image line 2 on the RIGHT; the deleted line is
    // pre-image line 2 on the LEFT and anchors AT post-image line 2, which is
    // the whole point of data-at — a deletion has no post-image line of its own.
    await expect(file.locator('[data-side="R"][data-l="2"]')).toHaveCount(1);
    const deleted = file.locator('[data-side="L"][data-l="2"]');
    await expect(deleted).toHaveCount(1);
    await expect(deleted).toHaveAttribute("data-at", "2");
  });
});
