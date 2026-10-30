// Frontend→API contract for unnamed windows auto-naming to their folder: the
// sidebar `+ New Tab` action issues a create request with NO `name` key,
// which the backend interprets as "let tmux auto-name the window to its
// folder basename" (via `automatic-rename-format '#{b:pane_current_path}'`).
// The tmux-native rename behavior itself is covered by the Go config/arg
// tests; this e2e verifies only the deterministic request-shape seam (the e2e
// tmux server's config application to `automatic-rename-format` is not
// guaranteed, so asserting the rendered folder name in the sidebar would be
// flaky).
// File-level beforeAll creates a dedicated tmux session (`e2e-unnamed-<ts>`)
// on the isolated test server so this file never collides with other specs;
// file-level afterAll kills it. The `+ New Tab` seam is the session flyout
// card's `New tab` row: hover the session row to open the card, then click
// the card's `row-flyout-create-action` row.
import { test, expect } from "@playwright/test";
import { gotoServerReady } from "./_ready";
import { TMUX_SERVER, createSession, killSession } from "./_tmux";

const TEST_SESSION = `e2e-unnamed-${Date.now()}`;

test.describe("Unnamed tab creation (+ New Tab)", () => {
  test.beforeAll(() => {
    createSession(TEST_SESSION);
  });

  test.afterAll(() => {
    killSession(TEST_SESSION);
  });

  /**
   * Proves: the session flyout card's `New tab` action row sends
   * `POST /api/sessions/<session>/windows` with a body that contains NO
   * `name` key. An omitted name is the signal that tmux should auto-name the
   * window to its folder basename.
   *
   * Steps:
   * 1. Register a route interception on the session-windows API glob
   *    (trailing `*` so the `?server=` query the client appends still
   *    matches). For a POST, capture the request body via `postDataJSON()`
   *    and fulfill with a 201 `{ ok: true }` so the optimistic flow settles
   *    without mutating real tmux.
   * 2. Navigate to `/<server>` and wait for the `Connected` indicator AND the
   *    session row to render (same-server gate — the sidebar subscribes SSE
   *    to the route's server only, so the create flow must stay on it).
   * 3. Hover the session row until ITS flyout card is open (a row
   *    layout-shift under the stationary pointer can fire a sibling row's
   *    hover intent while SSE settles), enter the card at the row's own band
   *    (a diagonal sweep to a bottom action row crosses the sibling sidebar
   *    row and hover-intent retargets the card), then click the card's
   *    `New tab` action row.
   * 4. Poll until the create request has been captured, then assert the
   *    captured body does NOT have a `name` property.
   */
  test("+ New Tab omits the name from the create request (tmux auto-names)", async ({
    page,
  }) => {
    // Intercept the window-create request to inspect its body without mutating
    // real tmux — this is the deterministic frontend→API contract seam. We
    // fulfill with a 201 so the optimistic flow settles cleanly; the tmux-native
    // auto-rename itself is covered by the Go config/arg tests (the e2e server's
    // automatic-rename-format application is not guaranteed, so asserting the
    // visual folder name here would be flaky). The glob ends in `*` so the
    // `?server=` query withServer appends still matches (a no-star glob would
    // fall through and mutate live tmux).
    let capturedBody: Record<string, unknown> | null = null;
    await page.route("**/api/sessions/*/windows*", async (route) => {
      if (route.request().method() === "POST") {
        capturedBody = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }
      await route.continue();
    });

    await gotoServerReady(page, TMUX_SERVER, TEST_SESSION);

    const sidebar = page.locator("nav[aria-label='Groups']");
    // The session flyout card's `New tab` row is the create seam: hover the
    // session row to open the card, then click its create action. The
    // flow is deliberately SAME-server (the sidebar subscribes SSE to the
    // route's server only — a cross-server ghost never settles; see plan.md
    // ## Notes for the recorded pre-existing bug).
    const sessionRow = sidebar.locator(
      `[data-session-row="${TMUX_SERVER}:${TEST_SESSION}"]`,
    );
    await expect(sessionRow).toBeVisible({ timeout: 5_000 });
    const card = page.getByTestId("row-flyout-card");
    // Hover until THIS session's card is the open one: while SSE is still
    // settling, a row layout-shift under the stationary pointer can fire a
    // sibling row's hover intent (a mouseover with no mousemove) and open
    // THAT row's card.
    await expect(async () => {
      await page.mouse.move(700, 500);
      await sessionRow.hover();
      await expect(card).toContainText(`Group ${TEST_SESSION}`, { timeout: 3_000 });
    }).toPass({ timeout: 15_000 });
    // Enter the card at the reference row's own band before descending to a
    // lower action row (a diagonal sweep crosses the sibling sidebar row and
    // hover-intent retargets the card mid-transit).
    const rowBox = (await sessionRow.boundingBox())!;
    const cardBox = (await card.boundingBox())!;
    await page.mouse.move(cardBox.x + 16, rowBox.y + rowBox.height / 2);
    await card.getByTestId("row-flyout-create-action").click();

    // The intercepted create request body must carry NO `name` key — an omitted
    // name is the "let tmux auto-name to the folder basename" signal. (The old
    // behavior hardcoded name: "zsh".)
    await expect
      .poll(() => capturedBody, { timeout: 5_000 })
      .not.toBeNull();
    expect(capturedBody!).not.toHaveProperty("name");
  });
});
