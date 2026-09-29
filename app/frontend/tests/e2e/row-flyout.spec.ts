import { test, expect, type Page } from "@playwright/test";
import { mockStateSocket } from "./_state-socket-mock";

// Row-hover register flyout card, the rest-state PR glyph, and the
// right-edge status rail — the one status-detail surface that replaced the
// per-dot StatusDotTip hover-card (whose status-dot-tip.spec.ts this file
// replaces). Fully mocked: the isolated e2e tmux server has no real
// change-bound PRs and `gh` is unavailable in CI, so the SSE `sessions`
// payload (and the server list) is injected via page.route / the
// state-socket mock — the same idiom as the retired status-dot-tip.spec.ts.
// `/api/boards` is mocked EMPTY too: boards are derived from `_rk-pin-*`
// pin-sessions that earlier board specs leave on the shared e2e tmux server,
// and a late board-list resolve grows the Boards panel and shifts the
// Sessions section mid-hover — cancelling the hover intent under test.
//
// The flyout opens on WHOLE-ROW hover (500ms delay, warm-window retarget),
// keyboard row focus, and the coarse-pointer rail; placement is
// pointer-conditional — "right" (the sidebar's right edge) on fine pointers,
// "bottom-start" below the row on coarse, with the card width capped short of
// the row's 56px status rail. Card actions (change color / fork / pin / kill)
// are explicit sectioned rows at the card's bottom on BOTH pointer worlds —
// the title bar carries only the ⓘ docs link. The card is the fine-pointer
// hover/focus surface on EVERY tier — window rows, session rows,
// server-group headers, and the SERVER-panel tiles (the tile is
// fine-pointer-only: no rail, no coarse trigger) — with the coarse rail's
// tap/scrub as the coarse trigger on the three railed tiers. The old
// fine-pointer hover icon clusters (session palette/bot/plus/kill, header
// palette/plus/close) and the per-row identity tips are retired; the card
// carries their content and actions. `Change color…` is the first action row
// of every tier's card, no `Set tab label` affordance exists, and the marker
// strip is interactive at 22px on fine pointers and 36px on coarse pointers
// while the scrub retargets cards ACROSS tiers via the shared
// `data-rail-row` handle.
//
// Shared setup: **/api/servers → a single server `default`;
// **/api/windows/*/select* → 200 (window-select POSTs don't error); the
// /ws/terminals WebSocket is accepted and held open; /ws/state (via
// mockStateSocket) carries a session `dev` (with sessionId/sessionPath) and
// two windows — @1 "feature-work" (change-bound, a waiting agent, a
// reconciled claude chat, an owned open PR #386, and two panes with %425
// active so the identity title bar renders its full `Tab @1 · pane %425 · 2
// panes` form) and @2 "scratch-shell" (plain window — gray idle dot, no
// glyph, a body-less card, no panes → degraded `Tab @2` title — carrying
// color orange + marker manual:2 so the pointer-parity test can prove the
// interactive strip preserves the well on coarse). Rows are
// located by [role='treeitem'][data-window-id]; the card by
// data-testid="row-flyout-card"; registers/links by
// row-flyout-fab|fab-slug|pr|pr-link|docs-link; the sectioned action rows by
// row-flyout-{color,fork,pin,kill}-action (+ row-flyout-{spawn,create}-action
// on the session/server tiers); the glyph by row-pr-glyph; the coarse status
// rail by status-rail; the dot's tap wrapper by status-dot-tap; the session
// row by [data-session-row='default:dev']; the server-group header by
// [data-server='default']; the server tile by role=option inside the
// `Tmux servers` listbox. The coarse-pointer describe additionally mocks
// `(pointer: coarse)` via matchMedia (Playwright desktop Chromium cannot flip
// the real pointer media feature — the tooltips.spec.ts precedent) and
// enables hasTouch so tap() dispatches real touch input.

const SERVER = "default";

// @1: change-bound window WITH an owned open PR (blue "building — at rest" dot
// — waiting agent ⇒ ring + halo under shape=liveness; the PR never owns the
// dot; the rest PR glyph + the card's fab/pr registers
// carry the PR story) AND a reconciled claude chat (so the conversation-fork
// affordance renders — 260806-s4av), carrying two panes (%425 active) so the
// identity title bar renders its full `Tab @N · pane %N · N panes` form.
// @2: plain scratch window (gray "idle" dot, no glyph, a body-less card — the
// title bar + action rows only, no fork link, no panes → degraded `Tab @N`
// title) carrying an orange color + manual:2 marker so the pointer-parity
// test can prove the interactive strip preserves the well on coarse.
const sessionsPayload = JSON.stringify([
  {
    name: "dev",
    sessionId: "$4",
    sessionPath: "/home/sahil/code/sahil87/run-kit",
    windows: [
      {
        windowId: "@1",
        index: 0,
        name: "feature-work",
        worktreePath: "/tmp/wt",
        activity: "idle",
        isActiveWindow: true,
        activityTimestamp: 0,
        agentState: "waiting",
        agentIdleDuration: "3m",
        agentProvider: "claude",
        agentSessionRef: "5d80479e-8f25-46cd-a0d4-e51435508a37",
        fabChange: "260805-93dy-window-row-pr-glyph-register-flyout",
        fabStage: "apply",
        fabDisplayState: "active",
        prUrl: "https://github.com/o/r/pull/386",
        prNumber: 386,
        prState: "open",
        prChecks: "pass",
        prReview: "approved",
        prFetchedAt: new Date().toISOString(),
        panes: [
          { paneId: "%7", paneIndex: 0, cwd: "/tmp/wt", command: "zsh", isActive: false },
          { paneId: "%425", paneIndex: 1, cwd: "/tmp/wt", command: "claude", isActive: true },
        ],
      },
      {
        windowId: "@2",
        index: 1,
        name: "scratch-shell",
        worktreePath: "/tmp/scratch",
        activity: "idle",
        isActiveWindow: false,
        activityTimestamp: 0,
        color: "orange",
        marker: "manual:2",
      },
    ],
  },
]);

/** Install routes that fully mock the server list, the board list, and the
 *  state socket. The boards mock keeps the Boards panel empty — leftover
 *  `_rk-pin-*` sessions from earlier board specs would otherwise resolve a
 *  non-empty list late and shift the Sessions section mid-hover (the hover
 *  intent these tests exercise is cancelled by layout shifts under the
 *  stationary pointer). */
async function mockBackend(page: Page) {
  await page.routeWebSocket(/\/ws\/terminals/, () => {
    /* accept and hold the socket open; send nothing */
  });

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

  await page.route("**/api/boards", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );

  await mockStateSocket(page, { sessions: sessionsPayload });
}

/** Mock `(pointer: coarse)` as matching (the tooltips.spec.ts precedent —
 *  Playwright's desktop Chromium cannot flip the real pointer media feature). */
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

const tree = (page: Page) => page.locator("[role='tree']");
const prRow = (page: Page) => tree(page).locator("[role='treeitem'][data-window-id='@1']");
const scratchRow = (page: Page) => tree(page).locator("[role='treeitem'][data-window-id='@2']");
// The two non-window rail tiers (260817-ve5m): the session row (a level-1
// treeitem keyed `${server}:${name}`) and the server-group header (NOT a
// treeitem — the shared `data-rail-row` attribute is what unifies the shapes).
const sessionRow = (page: Page) => tree(page).locator("[data-session-row='default:dev']");
const serverHeader = (page: Page) => page.locator("[data-server='default']");
const card = (page: Page) => page.getByTestId("row-flyout-card");

async function gotoAndWait(page: Page) {
  await page.goto(`/${SERVER}`);
  await expect(prRow(page)).toBeVisible({ timeout: 10_000 });
  await expect(scratchRow(page)).toBeVisible();
}

test.describe("Row flyout card (fine pointer)", () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page);
    await gotoAndWait(page);
  });

  /**
   * Proves: whole-row hover (500ms delay) opens the flyout card anchored at
   * the sidebar's right edge and vertically aligned to the hovered row. Its
   * first element is the identity title bar (`Tab @1 · pane %425 · 2 panes`),
   * carrying ONLY the docs link on its right edge (fork is gone from the
   * title bar — one affordance, one home); the body is the `fab` and `pr`
   * registers ONLY — no status-label line, no `out`, no `agt` (the row
   * already carries the name, dot, glyph and label). The `fab` register leads
   * with its decisive tokens and the slug continues on an indented line; the
   * `pr` register is a single anchored line carrying number, state, checks
   * and review. The card's bottom carries the sectioned action rows in the
   * fixed change-color → fork → pin → kill order, each with its sub-hint. The
   * pr identity line is itself the open-first anchor (the panel's PrLinkRow
   * idiom): it wraps the colored identity segments, ends in an always-visible
   * inline ↗, and opens the PR in a new tab (noopener noreferrer).
   *
   * Steps:
   * 1. Hover the @1 row; assert the card is visible.
   * 2. Assert the title bar contains "Tab @1 · pane %425 · 2 panes", holds
   *    the docs link, and contains NO fork affordance; assert the title text
   *    precedes the `fab` register text, the card does NOT contain the dot
   *    label ("building — at rest"), the row-flyout-out/row-flyout-agt
   *    testids are absent, the fab register reads `93dy · apply · active`
   *    with the slug on its continuation line, and the pr register carries
   *    `#386`.
   * 3. Assert the sectioned action rows: change color ("Change color…"),
   *    fork ("Fork conversation" / "new tab, same directory"), pin ("Pin to
   *    board…" / "not pinned"), kill ("Kill tab" / "confirms first"), in that
   *    vertical order (bounding-box y).
   * 4. Assert the pr-register anchor wraps the identity segments (`#386`,
   *    `↗`), carries the "Open PR #386 in a new tab" aria-label +
   *    href/target/rel, and the docs link href.
   * 5. Assert the row-aligned notch: the card's arrow SVG is present and its
   *    vertical center falls inside the hovered row's band (the connection
   *    cue — the notch points at the row that owns the card).
   * 6. Compare bounding boxes: the card's x ≥ the sidebar <aside>'s right
   *    edge, and the card vertically overlaps the hovered row (±8px).
   * 7. Assert no line paints outside the max-w-xs card box: the card's
   *    scrollWidth does not exceed its clientWidth (the register and
   *    continuation lines' `truncate` keeps content inside the box).
   */
  test("hovering a row opens the register card at the sidebar's right edge", async ({ page }) => {
    await prRow(page).hover();
    await expect(card(page)).toBeVisible();

    // Content: the identity title bar (`Tab @N · pane %N · N panes`, the
    // card's first element, carrying ONLY the ⓘ docs affordance on its right
    // edge — actions live in the sectioned rows at the card's bottom), then
    // the body — the `fab` and `pr` registers ONLY (the row already carries
    // the name/dot/glyph/label, so no status-label line, no `out`, no `agt`):
    // critical tokens lead, long values continue on indented lines, freshness
    // lives inside the pr group.
    const titleBar = page.getByTestId("popup-title-bar");
    await expect(titleBar).toContainText("Tab @1 · pane %425 · 2 panes");
    await expect(titleBar.getByTestId("row-flyout-docs-link")).toBeVisible();
    await expect(titleBar.getByTestId("row-flyout-fork-action")).toHaveCount(0);
    // Sectioned action rows (change color → fork → pin → kill, one home per
    // action, BOTH pointer worlds): labels + sub-hints, in order. `Change
    // color…` is the FIRST row of every tier's card (260817-ve5m).
    const colorRow = card(page).getByTestId("row-flyout-color-action");
    const forkRow = card(page).getByTestId("row-flyout-fork-action");
    const pinRow = card(page).getByTestId("row-flyout-pin-action");
    const killRow = card(page).getByTestId("row-flyout-kill-action");
    await expect(colorRow).toContainText("Change color…");
    await expect(forkRow).toContainText("Fork conversation");
    await expect(forkRow).toContainText("new tab, same directory");
    await expect(pinRow).toContainText("Pin to board…");
    await expect(pinRow).toContainText("not pinned");
    await expect(killRow).toContainText("Kill tab");
    await expect(killRow).toContainText("confirms first");
    const colorBox = (await colorRow.boundingBox())!;
    const forkBox = (await forkRow.boundingBox())!;
    const pinBox = (await pinRow.boundingBox())!;
    const killBox = (await killRow.boundingBox())!;
    expect(colorBox.y).toBeLessThan(forkBox.y);
    expect(forkBox.y).toBeLessThan(pinBox.y);
    expect(pinBox.y).toBeLessThan(killBox.y);
    const cardText = (await card(page).innerText()).replaceAll("\n", " ");
    expect(cardText.indexOf("Tab @1")).toBeLessThan(cardText.indexOf("93dy"));
    // No line restates the row: no status-label text, no out/agt registers.
    await expect(card(page)).not.toContainText("building — at rest");
    await expect(page.getByTestId("row-flyout-out")).toHaveCount(0);
    await expect(page.getByTestId("row-flyout-agt")).toHaveCount(0);
    // fab: the decisive tokens lead; the slug continues on an indented line.
    await expect(page.getByTestId("row-flyout-fab")).toContainText("93dy · apply · active");
    await expect(page.getByTestId("row-flyout-fab-slug")).toContainText(
      "window-row-pr-glyph-register-flyout",
    );
    // pr: identity inside the anchor; health + freshness as continuation lines.
    await expect(page.getByTestId("row-flyout-pr")).toContainText("#386");
    // The pr register LINE itself is the open-first anchor (PrLinkRow idiom):
    // it wraps the segments and carries an always-visible inline ↗.
    const prLink = page.getByTestId("row-flyout-pr-link");
    await expect(prLink).toContainText("#386");
    await expect(prLink).toContainText("↗");
    await expect(prLink).toHaveAttribute("aria-label", "Open PR #386 in a new tab");
    await expect(prLink).toHaveAttribute("href", "https://github.com/o/r/pull/386");
    await expect(prLink).toHaveAttribute("target", "_blank");
    await expect(prLink).toHaveAttribute("rel", "noopener noreferrer");
    // Row-aligned notch (E1): the arrow renders on the card's row-side edge,
    // vertically inside the hovered row's band (its center ≈ the row's center).
    const arrowBox = await page.getByTestId("row-flyout-arrow").boundingBox();
    const anchorRowBox = await prRow(page).boundingBox();
    expect(arrowBox).not.toBeNull();
    const arrowCenterY = arrowBox!.y + arrowBox!.height / 2;
    expect(arrowCenterY).toBeGreaterThanOrEqual(anchorRowBox!.y - 1);
    expect(arrowCenterY).toBeLessThanOrEqual(anchorRowBox!.y + anchorRowBox!.height + 1);
    const docsLink = page.getByTestId("row-flyout-docs-link");
    await expect(docsLink).toBeVisible();
    await expect(docsLink).toHaveAttribute(
      "href",
      "https://github.com/sahil87/hexokit/blob/main/docs/site/status-dot.md",
    );

    // Fixed-x anchor: the card sits at (right of) the sidebar's right edge,
    // vertically overlapping the hovered row.
    const aside = page.locator('aside[aria-label="Sidebar"]');
    const asideBox = (await aside.boundingBox())!;
    const cardBox = (await card(page).boundingBox())!;
    const rowBox = (await prRow(page).boundingBox())!;
    expect(cardBox.x).toBeGreaterThanOrEqual(asideBox.x + asideBox.width - 1);
    expect(cardBox.y).toBeLessThan(rowBox.y + rowBox.height + 8);
    expect(cardBox.y + cardBox.height).toBeGreaterThan(rowBox.y - 8);

    // No line paints OUTSIDE the max-w-xs card box: the register and
    // continuation lines' `truncate` keeps content inside the box (the cycle-1
    // regression measured 435 vs 318 without it).
    const overflow = await card(page).evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  /**
   * Proves: sweeping the pointer to a sibling row closes the first card and
   * opens the sibling's (the shared warm-window delay scope) — only one card
   * exists at a time, and the content follows the hovered row (the scratch
   * row's card has no body at all — no change, no PR — so no fab register and
   * no PR link). It also proves the title's degradation: the pane-less
   * scratch window's title bar reads `Tab @2` alone, with no pane segment.
   *
   * Steps:
   * 1. Hover @1; assert the card shows the pr register (`#386`).
   * 2. Hover @2; assert exactly one card exists, its title bar reads "Tab @2"
   *    without any "pane" segment, and the fab register and PR link are
   *    absent.
   */
  test("moving between rows retargets the card (warm window, single card)", async ({ page }) => {
    await prRow(page).hover();
    await expect(card(page)).toContainText("#386");

    // Sweep to the sibling row: the first card closes and the sibling's opens
    // (warm retarget — no strobing, never two cards). The pane-less scratch
    // window's title degrades to `Tab @N` alone, and with no change and no
    // PR the card renders NO body — title bar and action rows only.
    await scratchRow(page).hover();
    await expect(card(page)).toHaveCount(1);
    const titleBar = page.getByTestId("popup-title-bar");
    await expect(titleBar).toContainText("Tab @2");
    await expect(titleBar).not.toContainText("pane");
    await expect(page.getByTestId("row-flyout-fab")).toHaveCount(0);
    await expect(page.getByTestId("row-flyout-pr-link")).toHaveCount(0);
  });

  /**
   * Proves: the conversation-fork action row is gated on the window carrying
   * a reconciled `claude` chat, its tooltip names the same-directory
   * semantics, and clicking it POSTs the window-keyed
   * POST /api/windows/{windowId}/fork endpoint — with no body, since every
   * other input is derived server-side — without selecting or navigating the
   * underlying row.
   *
   * Steps:
   * 1. Hover @1 (the claude-chat window); assert the fork action row is
   *    visible and its `title` mentions "same directory".
   * 2. Hover @2 (a plain shell window, no agentProvider); assert the card is
   *    the scratch one ("Tab @2", no body) and carries zero fork rows.
   * 3. Route the window-fork API glob to a 200 recording each request URL,
   *    returning an EMPTY windowId so the app deliberately skips navigation
   *    (the best-effort window-id contract) and the assertion stays on this
   *    route.
   * 4. Hover @1 again and click the fork action row; assert exactly one fork
   *    request fired and its decoded URL is /api/windows/@1/fork
   *    (window-keyed, the source window's id in the path).
   * 5. Assert the URL is still /default — forking never also selects the row.
   */
  test("the fork action row renders only on a claude-chat row and POSTs the fork endpoint", async ({
    page,
  }) => {
    // Gate: @1 carries a reconciled claude chat → the fork action row renders
    // in the card's sectioned action list; @2 (plain shell, no agentProvider)
    // does not.
    await prRow(page).hover();
    const forkRow = page.getByTestId("row-flyout-fork-action");
    await expect(forkRow).toBeVisible();
    await expect(forkRow).toHaveAttribute("title", /same directory/i);

    await scratchRow(page).hover();
    await expect(card(page)).toContainText("Tab @2");
    await expect(page.getByTestId("row-flyout-fork-action")).toHaveCount(0);

    // Clicking it POSTs the window-keyed fork endpoint with NO body (every input
    // is derived server-side). Mocked with an empty windowId so the app skips
    // navigation and the assertion stays on this route.
    const forkRequests: string[] = [];
    await page.route("**/api/windows/*/fork*", (route) => {
      forkRequests.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ server: SERVER, session: "dev", window: "feature-work-fork", windowId: "" }),
      });
    });

    await prRow(page).hover();
    await page.getByTestId("row-flyout-fork-action").click();
    await expect.poll(() => forkRequests.length).toBe(1);
    // Window-keyed: the source window's id is in the path (percent-encoded '@').
    expect(forkRequests[0]).toContain("/fork");
    expect(decodeURIComponent(forkRequests[0])).toContain("/api/windows/@1/fork");
    // Forking never also selects/navigates the row.
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/?$`));
  });

  /**
   * Proves: the other half of the fork's navigation contract — a fork
   * returning a NON-empty windowId routes the app to that window's
   * /$server/$window URL, the same navigation the spawn dialog performs with
   * a riff result. (The empty-windowId skip is proven by the test above.)
   *
   * Steps:
   * 1. Route the window-fork API glob to a 200 returning windowId: "@9".
   * 2. Hover @1 and click the fork action row.
   * 3. Assert the URL becomes /default/9 — @9 with the route's `@` stripped.
   */
  test("a successful fork navigates to the returned window", async ({ page }) => {
    // The navigation half of the fork contract: a NON-empty returned
    // windowId routes to that window (the empty-id skip is the case above).
    await page.route("**/api/windows/*/fork*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          server: SERVER,
          session: "dev",
          window: "feature-work-fork",
          windowId: "@9",
        }),
      }),
    );

    await prRow(page).hover();
    await page.getByTestId("row-flyout-fork-action").click();

    // @9 → URL segment `9` (the route strips the '@'), the same navigation the
    // spawn dialog performs with a riff result.
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/9(?:$|[/?#])`), { timeout: 5_000 });
  });

  /**
   * Proves: the PR link's stopPropagation guard — activating a card link
   * never selects the underlying row (the SPA URL stays on the server route).
   *
   * Steps:
   * 1. Hover @1; wait for the PR link.
   * 2. Remove the link's href (so no real new-tab navigation) and click it.
   * 3. Assert the URL is still /default (no window route).
   */
  test("clicking the card's PR link does not select/navigate the window row", async ({ page }) => {
    await prRow(page).hover();
    const prLink = page.getByTestId("row-flyout-pr-link");
    await expect(prLink).toBeVisible();
    // Block the new-tab navigation so the assertion stays on the SPA route.
    await prLink.evaluate((a) => a.removeAttribute("href"));
    await prLink.click();
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/?$`));
  });

  /**
   * Proves: the card opens on row focus (the roving-tabindex treeitem —
   * Constitution V, replacing the retired dot tabIndex stop); the card's
   * links are Tab-reachable from the focused row (FloatingFocusManager
   * modal={false} + the portal's tab-order guards — the PR/docs links must
   * not be mouse-only); Escape closes it (floating-ui useDismiss) with focus
   * returning into the row so arrow-key tree nav continues.
   *
   * Steps:
   * 1. Focus the @1 row element; assert the card is visible with the pr
   *    register (`#386`).
   * 2. Press Tab (up to 6 times, walking the row's action icons first) and
   *    assert the docs link receives focus; one more Tab focuses the PR link.
   * 3. Press Escape (focus inside the card); assert the card is removed and
   *    the active element is the row or a descendant of it.
   */
  test("keyboard: focusing the row opens the card; Tab reaches its links; Escape dismisses it", async ({
    page,
  }) => {
    await prRow(page).focus();
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText("#386");

    // The card's links are Tab-reachable from the focused row
    // (FloatingFocusManager modal={false} + the portal's tab-order guards).
    // Tab walks the row's action icons first (pin, kill), then enters the
    // portalled card: docs link, then the PR link.
    const docsLink = page.getByTestId("row-flyout-docs-link");
    let reachedDocs = false;
    for (let i = 0; i < 6 && !reachedDocs; i++) {
      await page.keyboard.press("Tab");
      reachedDocs = await docsLink.evaluate((el) => el === document.activeElement);
    }
    expect(reachedDocs).toBe(true);
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("row-flyout-pr-link")).toBeFocused();

    // Escape still dismisses with focus inside the card, and focus returns
    // INTO the row (the root when it is the roving tab stop, else its first
    // tabbable child) — either way the tree keydown anchors on
    // closest('[role="treeitem"]'), so arrow-key nav continues from this row.
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
    const focusInRow = await prRow(page).evaluate(
      (row) => row === document.activeElement || row.contains(document.activeElement),
    );
    expect(focusInRow).toBe(true);
  });

  /**
   * Proves: a row with an owned PR carries a rest-state git-pull-request
   * glyph in the far-right (✕) slot; on hover it display-swaps away while the
   * kill ✕ takes the slot; the no-PR row never shows a glyph; leaving the row
   * restores it.
   *
   * Steps:
   * 1. At rest: assert @1's glyph is visible and @2 has none.
   * 2. Hover @1: assert the glyph is hidden and the kill button's computed
   *    opacity is 1 (the opacity-revealed action now owns the slot).
   * 3. Hover @2: assert @1's glyph is visible again.
   */
  test("rest PR glyph shows for an owned PR and hover swaps it for the actions", async ({ page }) => {
    const glyph = prRow(page).getByTestId("row-pr-glyph");
    // At rest: the glyph is visible in the last (✕) slot; the plain scratch
    // row has none.
    await expect(glyph).toBeVisible();
    await expect(scratchRow(page).getByTestId("row-pr-glyph")).toHaveCount(0);

    // On hover the glyph display-swaps away and the kill ✕ takes the slot
    // (the buttons are opacity-revealed, so assert computed opacity).
    await prRow(page).hover();
    await expect(glyph).toBeHidden();
    const kill = prRow(page).getByLabel("Kill tab feature-work");
    await expect(kill).toHaveCSS("opacity", "1");

    // Leaving the row restores the rest glyph.
    await scratchRow(page).hover();
    await expect(glyph).toBeVisible();
  });

  /**
   * Proves: the fine-pointer 22px marker strip opens the pad without selecting
   * the row while preserving the flush well, the 15px stage-two fill, and
   * approximately 30px content offset.
   *
   * Steps:
   * 1. Locate the marked row and assert no `Set tab label` element exists.
   * 2. Press and release the marker strip without moving, then assert the pad
   *    opens and the terminal route remains unchanged.
   * 3. Measure the strip, row, well, and status content; assert the strip and
   *    well are flush and 22px wide, the stage-two fill is 15px, and content
   *    begins near 30px.
   */
  test("fine left zone: the interactive 22px marker strip preserves well and content geometry", async ({
    page,
  }) => {
    await expect(page.locator('[aria-label="Set tab label"]')).toHaveCount(0);
    const strip = scratchRow(page).getByTestId("marker-strip");
    const stripBox = (await strip.boundingBox())!;
    await page.mouse.move(stripBox.x + stripBox.width / 2, stripBox.y + stripBox.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.getByTestId("marker-pad")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/?$`));

    const rowBox = (await scratchRow(page).boundingBox())!;
    const wellBox = (await scratchRow(page).getByTestId("marker-well").boundingBox())!;
    const contentBox = (await scratchRow(page).getByTestId("status-dot-tap").boundingBox())!;
    await expect(scratchRow(page).getByTestId("marker-fill")).toHaveCSS("width", "15px");
    expect(Math.abs(stripBox.x - rowBox.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(stripBox.width - 22)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(wellBox.x - rowBox.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(wellBox.width - 22)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(contentBox.x - rowBox.x - 30)).toBeLessThanOrEqual(1);
  });

  /**
   * Proves: the session-tier card is the fine-pointer hover surface — whole-row
   * hover opens the shared-shell card with the `Session dev` title, the facts
   * line (`$4 · 2 tabs · ~/code/sahil87/run-kit`), and the action rows in the
   * fixed order (`Change color…` first, then `Spawn agent…` → `New tab` →
   * `Kill session`), and the retired hover icon cluster (palette/bot/plus/kill)
   * is absent from the DOM on fine pointers too. Keyboard focus also opens the
   * card and Escape dismisses it.
   *
   * Steps:
   * 1. Assert the retired cluster buttons (`Set color for dev`, `Spawn agent
   *    in dev`, `New tab in dev`, `Kill session dev`) are absent from the DOM.
   * 2. Hover the session row; assert the card shows the `Session dev` title
   *    bar, the facts line, and the four action rows in vertical order.
   * 3. Move the pointer away and assert the card closes; focus the row and
   *    assert the card reopens; press Escape and assert the card is removed
   *    (Escape with focus in the sidebar also rides the nav's Escape-return
   *    rule, so no focus assertion here).
   */
  test("fine pointer: hovering/focusing the session row opens the session card (cluster retired)", async ({
    page,
  }) => {
    // The retired hover icon cluster is gone from the DOM on fine pointers too.
    await expect(sessionRow(page).getByLabel("Set color for dev")).toHaveCount(0);
    await expect(sessionRow(page).getByLabel("Spawn agent in dev")).toHaveCount(0);
    await expect(sessionRow(page).getByLabel("New tab in dev")).toHaveCount(0);
    await expect(sessionRow(page).getByLabel("Kill session dev")).toHaveCount(0);

    await sessionRow(page).hover();
    await expect(card(page)).toBeVisible();
    await expect(page.getByTestId("popup-title-bar")).toContainText("Session dev");
    await expect(card(page)).toContainText("$4 · 2 tabs · ~/code/sahil87/run-kit");
    const colorRow = card(page).getByTestId("row-flyout-color-action");
    const spawnRow = card(page).getByTestId("row-flyout-spawn-action");
    const createRow = card(page).getByTestId("row-flyout-create-action");
    const killRow = card(page).getByTestId("row-flyout-kill-action");
    await expect(colorRow).toContainText("Change color…");
    await expect(spawnRow).toContainText("Spawn agent…");
    await expect(createRow).toContainText("New tab");
    await expect(killRow).toContainText("Kill session");
    const ys = await Promise.all(
      [colorRow, spawnRow, createRow, killRow].map(async (r) => (await r.boundingBox())!.y),
    );
    expect(ys[0]).toBeLessThan(ys[1]);
    expect(ys[1]).toBeLessThan(ys[2]);
    expect(ys[2]).toBeLessThan(ys[3]);

    // Sweep away closes; keyboard focus opens the same card; Escape dismisses
    // it (focus then rides the nav's Escape-return rule out of the sidebar —
    // the focus-return assertion lives in the window-tier keyboard test, where
    // Escape lands while focus is inside the portalled card).
    await page.mouse.move(700, 500);
    await expect(card(page)).toHaveCount(0);
    await sessionRow(page).focus();
    await expect(card(page)).toBeVisible();
    await expect(page.getByTestId("popup-title-bar")).toContainText("Session dev");
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
  });

  /**
   * Proves: the session card's `Change color…` row is the fine-pointer color
   * entry — clicking it closes the card and opens the row's color popover,
   * and popover-over-card precedence holds (re-hovering the row while the
   * picker is open does not reopen the card).
   *
   * Steps:
   * 1. Hover the session row; assert the card is visible.
   * 2. Click the card's `Change color…` action row; assert the card is gone
   *    and the "Label picker" listbox is visible.
   * 3. Move the pointer away, hover the session row again, wait past the open
   *    delay, and assert NO card reopens (the picker's suppression gate).
   */
  test("fine pointer: the session card's Change color… row opens the picker with popover-over-card precedence", async ({
    page,
  }) => {
    await sessionRow(page).hover();
    await expect(card(page)).toBeVisible();

    await card(page).getByTestId("row-flyout-color-action").click();
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByRole("listbox", { name: "Label picker" })).toBeVisible();

    // Suppression: hovering the row while the picker is open flashes nothing.
    await page.mouse.move(700, 500);
    await sessionRow(page).hover();
    await page.waitForTimeout(800); // past the 500ms open delay
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByRole("listbox", { name: "Label picker" })).toBeVisible();
  });

  /**
   * Proves: the server-tier card is the fine-pointer hover surface on the
   * group header — hovering the header opens the card with the `Server
   * default` title, the `tmux -L default · 1 session` facts line, and the
   * action rows (`Change color…` → `New session` → Protect toggle →
   * `Kill server`); the retired header cluster (palette/plus/close) is absent
   * from the DOM; the card's `Change color…` row closes the card and opens the
   * header-anchored picker; and none of it toggles the group's expand/collapse.
   *
   * Steps:
   * 1. Assert the retired header cluster buttons (`Set color for server
   *    default`, `New session on default`, `Kill server default`) are absent.
   * 2. Hover the server-group header; assert the card shows the `Server
   *    default` title bar, the facts line, and the color/create/protect/kill
   *    rows.
   * 3. Click `Change color…`: assert the card is gone and the "Label picker"
   *    listbox is visible.
   * 4. Assert the group was never toggled: the header still reads "Collapse
   *    default sessions" and the window rows are still visible.
   */
  test("fine pointer: hovering the server-group header opens the server card; Change color… opens the picker without toggling the group", async ({
    page,
  }) => {
    const header = serverHeader(page);
    await expect(header.getByLabel("Set color for server default")).toHaveCount(0);
    await expect(header.getByLabel("New session on default")).toHaveCount(0);
    await expect(header.getByLabel("Kill server default")).toHaveCount(0);

    await header.hover();
    await expect(card(page)).toBeVisible();
    await expect(page.getByTestId("popup-title-bar")).toContainText("Server default");
    await expect(card(page)).toContainText("tmux -L default · 1 session");
    await expect(card(page).getByTestId("row-flyout-color-action")).toContainText("Change color…");
    await expect(card(page).getByTestId("row-flyout-create-action")).toContainText("New session");
    await expect(card(page).getByTestId("row-flyout-protect-toggle")).toBeVisible();
    await expect(card(page).getByTestId("row-flyout-kill-action")).toContainText("Kill server");

    await card(page).getByTestId("row-flyout-color-action").click();
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByRole("listbox", { name: "Label picker" })).toBeVisible();

    // Opening the card and its picker never toggled the group.
    await expect(header.getByRole("button", { name: /Collapse default sessions/ })).toBeVisible();
    await expect(prRow(page)).toBeVisible();
  });

  /**
   * Proves: the SERVER-panel tile hosts the same server card on fine pointers —
   * hovering the tile opens the card (title `Server default`, facts line, the
   * shared action rows), and its `Change color…` row closes the card and opens
   * the tile-anchored color popover (the tile's first color entry).
   *
   * Steps:
   * 1. Locate the `default` tile in the `Tmux servers` listbox and hover it.
   * 2. Assert the card shows the `Server default` title bar, the
   *    `tmux -L default · 1 session` facts line, and the `Change color…` /
   *    `New session` / `Kill server` rows.
   * 3. Click `Change color…`: assert the card is gone and the picker's listbox
   *    is visible.
   */
  test("fine pointer: hovering the server tile opens the same server card; Change color… opens the tile-anchored picker", async ({
    page,
  }) => {
    const tile = page
      .getByRole("listbox", { name: /Tmux servers/ })
      .getByRole("option", { name: /default/ });

    await tile.hover();
    await expect(card(page)).toBeVisible();
    await expect(page.getByTestId("popup-title-bar")).toContainText("Server default");
    await expect(card(page)).toContainText("tmux -L default · 1 session");
    await expect(card(page).getByTestId("row-flyout-color-action")).toContainText("Change color…");
    await expect(card(page).getByTestId("row-flyout-create-action")).toContainText("New session");
    await expect(card(page).getByTestId("row-flyout-kill-action")).toContainText("Kill server");

    await card(page).getByTestId("row-flyout-color-action").click();
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByRole("listbox", { name: "Color picker" })).toBeVisible();
  });
});

test.describe("Row flyout card (coarse pointer)", () => {
  test.use({ hasTouch: true });

  /** Coarse ⇒ `useIsMobile()` ⇒ the sidebar is a closed drawer: open it via
   *  the hamburger before reaching for rows (mobile-layout.spec.ts idiom). */
  async function gotoCoarseDrawer(page: Page) {
    await mockCoarsePointer(page);
    await mockBackend(page);
    await page.goto(`/${SERVER}`);
    await page.getByRole("button", { name: "Toggle navigation" }).tap();
    await expect(prRow(page)).toBeVisible({ timeout: 10_000 });
    await expect(scratchRow(page)).toBeVisible();
  }

  /**
   * Proves: on coarse pointers every non-ghost row renders the 56px
   * right-edge rail, the rest-state PR glyph lives in the rail's fixed 16px
   * slot, and the chevron hint renders on every row (glyph or not); the
   * pin/✕ cluster is render-gated off (the buttons are absent from the DOM,
   * not merely hidden); the status dot is a plain glyph whose tap selects the
   * row; tapping the RAIL (the sole flyout target) opens the card — anchored
   * BELOW the row, fully on-screen, its
   * right edge stopping before the rail column, notch pointing up — WITHOUT
   * selecting the row; tapping the row body still selects (navigates) and
   * never hover-opens a card. Also asserts the widened mobile drawer (92% of
   * the viewport, capped at 340px) and that the card's `Change color…` row
   * leads the action rows on coarse too.
   *
   * Steps:
   * 1. With the coarse mock + hasTouch: coarse ⇒ useIsMobile() ⇒ the sidebar
   *    is a closed drawer, so first open it via the "Toggle navigation"
   *    hamburger (the mobile-layout.spec.ts idiom).
   * 2. Assert the drawer width is min(92vw, 340px).
   * 3. Assert both rows render a visible status-rail exactly 56px wide; @1's
   *    rail contains the row-pr-glyph and @2's does not; both rails show the
   *    › chevron hint; @1 contains NO pin/kill buttons.
   * 4. Tap @1's rail: assert the card opens with the pr register (`#386`),
   *    carries the change-color/fork/pin/kill action rows (color first, by
   *    bounding-box y), and the URL is still the bare server route (the tap
   *    did not select the row).
   * 5. Assert coarse placement + containment via bounding boxes: the card's
   *    top is at/below the row's bottom edge (bottom-start), the whole card
   *    is inside the viewport, the card's right edge is ≤ the rail's left
   *    edge, and the arrow notch rides the card's top edge (pointing up at
   *    the rail).
   * 6. Escape-dismiss, tap @2's status dot, and assert the URL leaves the bare
   *    server route (dot tap = row select) while no card appears.
   */
  test("rail renders on every row with aligned slots; rail-tap opens a contained bottom-start card without selecting the row", async ({
    page,
  }) => {
    await gotoCoarseDrawer(page);

    // The widened mobile drawer: 92% of the viewport capped at 340px.
    const drawerBox = (await page.locator('aside[aria-label="Navigation"]').boundingBox())!;
    expect(Math.round(drawerBox.width)).toBe(
      Math.min(Math.round(page.viewportSize()!.width * 0.92), 340),
    );

    // Coarse rest state: the rest-state PR glyph lives in the rail's fixed
    // 16px slot; the pin/✕ cluster is fine-pointer-only — the buttons are not
    // in the DOM at all (pin/kill moved into the flyout card). The rail is
    // 56px wide (260817-ve5m — one constant, all tiers).
    const prRail = prRow(page).getByTestId("status-rail");
    const scratchRail = scratchRow(page).getByTestId("status-rail");
    await expect(prRail).toBeVisible();
    await expect(scratchRail).toBeVisible();
    expect(Math.round((await prRail.boundingBox())!.width)).toBe(56);
    expect(Math.round((await scratchRail.boundingBox())!.width)).toBe(56);
    await expect(prRail.getByTestId("row-pr-glyph")).toBeVisible();
    await expect(scratchRail.getByTestId("row-pr-glyph")).toHaveCount(0);
    // The chevron hint renders on EVERY row — glyph or not (a consistent rail
    // is a learnable rail).
    await expect(prRail).toContainText("›");
    await expect(scratchRail).toContainText("›");
    await expect(prRow(page).getByLabel("Pin feature-work to a board")).toHaveCount(0);
    await expect(prRow(page).getByLabel("Kill tab feature-work")).toHaveCount(0);

    // Tapping the RAIL (the sole flyout target) opens the card and does NOT
    // select the row (stopPropagation) — the URL stays on the server route
    // (@1's select would navigate to /default/1).
    await prRail.tap();
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText("#386");
    // The card is the coarse color/pin/kill home — and fork's only home.
    // `Change color…` leads the action rows on every tier (260817-ve5m).
    const colorRow = card(page).getByTestId("row-flyout-color-action");
    await expect(colorRow).toContainText("Change color…");
    await expect(card(page).getByTestId("row-flyout-fork-action")).toBeVisible();
    await expect(card(page).getByTestId("row-flyout-pin-action")).toBeVisible();
    await expect(card(page).getByTestId("row-flyout-kill-action")).toBeVisible();
    const colorBox = (await colorRow.boundingBox())!;
    const forkBox = (await card(page).getByTestId("row-flyout-fork-action").boundingBox())!;
    expect(colorBox.y).toBeLessThan(forkBox.y);
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/?$`));

    // Coarse placement + containment: the card anchors BELOW its row
    // (bottom-start), renders fully on-screen, and its right edge stops
    // BEFORE the rail column — the finger's column stays visible/touchable.
    const cardBox = (await card(page).boundingBox())!;
    const rowBox = (await prRow(page).boundingBox())!;
    const railBox = (await prRail.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(cardBox.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height - 1);
    expect(cardBox.x).toBeGreaterThanOrEqual(0);
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(viewport.height);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(viewport.width);
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(railBox.x + 1);
    // The notch points UP at the row/rail: the arrow rides the card's top
    // edge.
    const arrowBox = (await page.getByTestId("row-flyout-arrow").boundingBox())!;
    expect(arrowBox.y + arrowBox.height).toBeLessThanOrEqual(cardBox.y + 2);

    // The status dot is a plain glyph. Dismiss the card, tap @2's dot,
    // and prove normal bubbling selects the row instead of opening a card.
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
    await scratchRow(page).getByTestId("status-dot-tap").tap();
    await expect(page).not.toHaveURL(new RegExp(`/${SERVER}/?$`));
    await page.waitForTimeout(800); // past the 500ms open delay
    await expect(card(page)).toHaveCount(0);
  });

  /**
   * Proves: the card's Kill action row routes through the EXISTING KillDialog
   * confirmation path — no new kill path, no confirm bypass (there is no
   * modifier-force on touch) — and activating it never selects the row.
   *
   * Steps:
   * 1. Route the window-kill API glob to a 200 that records each request.
   * 2. Open the drawer, tap @1's status rail to open the card.
   * 3. Tap the card's Kill action row: assert the "Kill tab?" dialog is
   *    visible, ZERO kill requests have fired, and the URL is still /default.
   * 4. Tap Cancel: assert the dialog closes and still no kill request fired.
   */
  test("card kill row opens the existing kill confirmation dialog (no force-kill on touch)", async ({
    page,
  }) => {
    const killRequests: string[] = [];
    await page.route("**/api/windows/*/kill*", (route) => {
      killRequests.push(route.request().url());
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    });
    await gotoCoarseDrawer(page);

    await prRow(page).getByTestId("status-rail").tap();
    await expect(card(page)).toBeVisible();
    await card(page).getByTestId("row-flyout-kill-action").tap();

    // The existing KillDialog confirm path — no kill POST has fired.
    await expect(page.getByText("Kill tab?")).toBeVisible();
    expect(killRequests).toHaveLength(0);
    // The row was not selected either.
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/?$`));

    await page.getByRole("button", { name: "Cancel" }).tap();
    await expect(page.getByText("Kill tab?")).toHaveCount(0);
    expect(killRequests).toHaveLength(0);
  });

  /**
   * Proves: the card's Pin action row closes the card and hands off to the
   * row's existing PinPopover (popover-over-flyout precedence is pre-wired
   * via the flyout's `suppressed` gate) — the coarse pin path — without
   * selecting the row.
   *
   * Steps:
   * 1. Open the drawer, tap @1's status rail to open the card.
   * 2. Tap the card's Pin action row.
   * 3. Assert the card is gone, the "Pin tab to board" dialog is visible, and
   *    the URL is still /default.
   */
  test("card pin row closes the card and opens the existing pin popover", async ({ page }) => {
    await gotoCoarseDrawer(page);

    await prRow(page).getByTestId("status-rail").tap();
    await expect(card(page)).toBeVisible();
    await card(page).getByTestId("row-flyout-pin-action").tap();

    // Popover-over-flyout precedence: the card is gone, the row's PinPopover
    // is open, and the row was never selected.
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Pin tab to board" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/?$`));
  });

  /**
   * Proves: the slide-to-scrub gesture starting from the RAIL (the primary
   * target) — pointerdown on the rail opens that row's card and captures the
   * pointer; sliding across a sibling row retargets the single-open card (one
   * card at a time); the retargeted card still never covers the finger's rail
   * column (the containment invariant mid-scrub); releasing keeps the last
   * card open; the gesture never selects or navigates a row; and the existing
   * outside-press dismissal still works afterwards.
   *
   * Steps:
   * 1. Open the drawer; move the mouse to the center of @1's rail and press
   *    (mouse.down dispatches pointerdown — the scrub trigger under the
   *    coarse mock).
   * 2. Assert the card opens with "Tab @1".
   * 3. Slide (mouse.move, still pressed) onto @2's row: assert exactly one
   *    card, now showing "Tab @2", and the URL still /default (no
   *    navigation).
   * 4. Assert containment on the retargeted card: its right edge is ≤ @2's
   *    rail's left edge.
   * 5. Release (mouse.up): assert the @2 card stays open and the drawer/rows
   *    are still visible.
   * 6. Click a neutral spot in the main content: assert the card is
   *    dismissed.
   */
  test("scrub: press the rail + slide retargets the single card across rows; release keeps it; tap-elsewhere dismisses", async ({
    page,
  }) => {
    await gotoCoarseDrawer(page);

    // Press the rail (the primary scrub target — pointerdown opens the card
    // and captures the pointer), then slide onto the sibling row without
    // lifting.
    const railBox = (await prRow(page).getByTestId("status-rail").boundingBox())!;
    await page.mouse.move(railBox.x + railBox.width / 2, railBox.y + railBox.height / 2);
    await page.mouse.down();
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText("Tab @1");

    const scratchBox = (await scratchRow(page).boundingBox())!;
    await page.mouse.move(scratchBox.x + scratchBox.width / 2, scratchBox.y + scratchBox.height / 2, {
      steps: 5,
    });
    // One card, retargeted to @2 (the scrub never selects/navigates).
    await expect(card(page)).toHaveCount(1);
    await expect(card(page)).toContainText("Tab @2");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/?$`));

    // Containment mid-scrub: the retargeted card never covers the finger's
    // rail column on the row it now belongs to.
    const retargetedCardBox = (await card(page).boundingBox())!;
    const scratchRailBox = (await scratchRow(page).getByTestId("status-rail").boundingBox())!;
    expect(retargetedCardBox.x + retargetedCardBox.width).toBeLessThanOrEqual(scratchRailBox.x + 1);

    // Release keeps the last card open and the drawer stays put.
    await page.mouse.up();
    await expect(card(page)).toContainText("Tab @2");
    await expect(prRow(page)).toBeVisible();

    // Tapping elsewhere dismisses via the existing outside-press path.
    await page.mouse.click(700, 300);
    await expect(card(page)).toHaveCount(0);
  });

  /**
   * Proves: the coarse-pointer 36px marker strip opens the pad without
   * selecting the row, anchors the pad at the track edge, and preserves the
   * flush square track with approximately 44px content offset.
   *
   * Steps:
   * 1. Open the coarse drawer, locate the marked row, and assert no `Set tab
   *    label` element exists.
   * 2. Tap the marker strip, then assert the pad opens, the drawer remains
   *    visible, and the terminal route remains unchanged.
   * 3. Measure the strip, row, well, pad, and status content; assert the strip
   *    and well are flush and 36px wide, the pad begins at the track edge, the
   *    stage-two fill is 24px, and content begins near 44px.
   */
  test("coarse left zone: the tappable 36px marker strip preserves track and content geometry", async ({
    page,
  }) => {
    await gotoCoarseDrawer(page);

    await expect(page.locator('[aria-label="Set tab label"]')).toHaveCount(0);
    const strip = scratchRow(page).getByTestId("marker-strip");
    await strip.tap();
    await expect(page.getByTestId("marker-pad")).toBeVisible();
    await expect(scratchRow(page)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/?$`));

    const rowBox = (await scratchRow(page).boundingBox())!;
    const stripBox = (await strip.boundingBox())!;
    const wellBox = (await scratchRow(page).getByTestId("marker-well").boundingBox())!;
    const padBox = (await page.getByTestId("marker-pad").boundingBox())!;
    const zoneBox = (await scratchRow(page).getByTestId("status-dot-tap").boundingBox())!;
    expect(Math.abs(stripBox.x - rowBox.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(stripBox.width - 36)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(wellBox.x - rowBox.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(wellBox.width - 36)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(padBox.x - rowBox.x - 36)).toBeLessThanOrEqual(1);
    await expect(scratchRow(page).getByTestId("marker-fill")).toHaveCSS("width", "24px");
    expect(Math.abs(zoneBox.x - rowBox.x - 44)).toBeLessThanOrEqual(1);
  });

  /**
   * Proves: the session-tier card — the session row renders the rail on
   * coarse, its 4-icon cluster is gone from the DOM, and a rail tap opens the
   * shared-shell card with the `Session dev` title, the facts line
   * (`$4 · 2 tabs · ~/code/sahil87/run-kit`), and the relocated actions
   * in the fixed order (`Change color…` → `Spawn agent…` → `New window` →
   * `Kill session`, spawn wired on this route). Kill session routes through
   * the EXISTING kill confirmation dialog (no force-kill on touch, no kill
   * POST), and `Change color…` closes the card and opens the row's existing
   * color popover with popover-over-card precedence (a rail tap while the
   * popover is open flashes nothing).
   *
   * Steps:
   * 1. Route the session-kill API glob to a 200 that records each request.
   * 2. Open the drawer; assert the session row's rail is visible and its
   *    Kill/New-window cluster buttons are absent from the DOM.
   * 3. Tap the session rail: assert the card shows the `Session dev` title
   *    bar, the facts line, and the four action rows in vertical order;
   *    assert the URL is still /default and the window rows are still visible
   *    (no navigation, no collapse).
   * 4. Tap `Kill session`: assert the "Kill session?" dialog (with "and all 2
   *    tabs") is visible and ZERO kill requests fired; Cancel it.
   * 5. Re-open the card, tap `Change color…`: assert the card is gone and the
   *    "Label picker" listbox is visible; tap the rail again and assert NO
   *    card opens (suppression precedence).
   */
  test("session rail tap opens the session card; its actions route (kill confirms first)", async ({
    page,
  }) => {
    const killRequests: string[] = [];
    await page.route("**/api/sessions/*/kill*", (route) => {
      killRequests.push(route.request().url());
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    });
    await gotoCoarseDrawer(page);

    // The session row carries the rail; its retired 4-icon hover cluster is
    // absent from the DOM (retired on every pointer class).
    const rail = sessionRow(page).getByTestId("status-rail");
    await expect(rail).toBeVisible();
    await expect(sessionRow(page).getByLabel("Kill session dev")).toHaveCount(0);
    await expect(sessionRow(page).getByLabel("New tab in dev")).toHaveCount(0);

    await rail.tap();
    await expect(card(page)).toBeVisible();
    // Title + facts line + the relocated action rows in the fixed order
    // (Spawn agent… is wired on this route).
    await expect(page.getByTestId("popup-title-bar")).toContainText("Session dev");
    await expect(card(page)).toContainText("$4 · 2 tabs · ~/code/sahil87/run-kit");
    const colorRow = card(page).getByTestId("row-flyout-color-action");
    const spawnRow = card(page).getByTestId("row-flyout-spawn-action");
    const createRow = card(page).getByTestId("row-flyout-create-action");
    const killRow = card(page).getByTestId("row-flyout-kill-action");
    await expect(colorRow).toContainText("Change color…");
    await expect(spawnRow).toContainText("Spawn agent…");
    await expect(createRow).toContainText("New tab");
    await expect(killRow).toContainText("Kill session");
    await expect(killRow).toContainText("confirms first");
    const ys = await Promise.all(
      [colorRow, spawnRow, createRow, killRow].map(async (r) => (await r.boundingBox())!.y),
    );
    expect(ys[0]).toBeLessThan(ys[1]);
    expect(ys[1]).toBeLessThan(ys[2]);
    expect(ys[2]).toBeLessThan(ys[3]);
    // Nothing navigated or collapsed.
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/?$`));
    await expect(prRow(page)).toBeVisible();

    // Kill session routes through the EXISTING confirm dialog — no kill POST.
    await killRow.tap();
    await expect(page.getByText("Kill session?")).toBeVisible();
    await expect(page.getByText(/and all 2 tabs/)).toBeVisible();
    expect(killRequests).toHaveLength(0);
    await page.getByRole("button", { name: "Cancel" }).tap();
    await expect(page.getByText("Kill session?")).toHaveCount(0);

    // Change color… closes the card and opens the row's existing color
    // popover (popover-over-card precedence holds: no card flash while open).
    await rail.tap();
    await expect(card(page)).toBeVisible();
    await card(page).getByTestId("row-flyout-color-action").tap();
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByRole("listbox", { name: "Label picker" })).toBeVisible();
    await rail.tap();
    await expect(card(page)).toHaveCount(0);
  });

  /**
   * Proves: the server-tier card — the server-group header renders the rail
   * on coarse, its 3-icon cluster is gone from the DOM, and a rail tap opens
   * the card with the `Server default` title, the socket-name facts line
   * (`tmux -L default · 1 session` — the count from the group's own data),
   * and the action rows (`Change color…` → `New session` → `Kill server`).
   * Kill server routes through the EXISTING killServerTarget confirm dialog,
   * no kill POST fires, the group is never toggled, and the URL never
   * changes. (The rk-daemon warning case is NOT exercised here — the mocked
   * server is not the daemon.)
   *
   * Steps:
   * 1. Route the server-kill API glob to a 200 that records each request.
   * 2. Open the drawer; assert the `default` header's rail is visible and its
   *    Kill/New-session cluster buttons are absent from the DOM.
   * 3. Tap the header rail: assert the card shows the `Server default` title
   *    bar, the `tmux -L default · 1 session` facts line, and the three
   *    action rows.
   * 4. Tap `Kill server`: assert the confirm dialog ("and all its sessions")
   *    is visible, ZERO kill requests fired, the header still reads "Collapse
   *    default sessions" (never toggled), and the URL is still /default;
   *    Cancel it.
   */
  test("server rail tap opens the server card; Kill server routes to the existing dialog without toggling the group", async ({
    page,
  }) => {
    const killRequests: string[] = [];
    await page.route("**/api/servers/kill*", (route) => {
      killRequests.push(route.request().url());
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    });
    await gotoCoarseDrawer(page);

    // The group header carries the rail; its 3-icon cluster is absent on
    // coarse.
    const header = serverHeader(page);
    const rail = header.getByTestId("status-rail");
    await expect(rail).toBeVisible();
    await expect(header.getByLabel("Kill server default")).toHaveCount(0);
    await expect(header.getByLabel("New session on default")).toHaveCount(0);

    await rail.tap();
    await expect(card(page)).toBeVisible();
    await expect(page.getByTestId("popup-title-bar")).toContainText("Server default");
    // Server names ARE socket names; the count is the group's own data (the
    // singular form degrades to `1 session`).
    await expect(card(page)).toContainText("tmux -L default · 1 session");
    const colorRow = card(page).getByTestId("row-flyout-color-action");
    const createRow = card(page).getByTestId("row-flyout-create-action");
    const killRow = card(page).getByTestId("row-flyout-kill-action");
    await expect(colorRow).toContainText("Change color…");
    await expect(createRow).toContainText("New session");
    await expect(killRow).toContainText("Kill server");
    await expect(killRow).toContainText("confirms first");

    // Kill server routes through the existing killServerTarget dialog (the
    // rk-daemon warning is not in play for this mocked non-daemon server), no
    // kill POST fires, and the group header was never toggled.
    await killRow.tap();
    await expect(page.getByText(/and all its sessions/)).toBeVisible();
    expect(killRequests).toHaveLength(0);
    await expect(header.getByRole("button", { name: /Collapse default sessions/ })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/?$`));
    await page.getByRole("button", { name: "Cancel" }).tap();
    await expect(page.getByText(/and all its sessions/)).toHaveCount(0);
  });

  /**
   * Proves: the cross-tier scrub — all three tiers register in the ONE scrub
   * registry and the shared `data-rail-row` hit-test covers all three DOM
   * shapes, so a single press-and-slide from a window row's rail across the
   * session row onto the server-group header retargets the single-open card
   * window → session → server in sequence; release keeps the last (server)
   * card open; the gesture never selects, navigates, or collapses.
   *
   * Steps:
   * 1. Open the drawer; press (mouse.down) the center of @1's rail; assert
   *    the card opens with "Tab @1".
   * 2. Slide (still pressed) onto the session row's rail: assert exactly one
   *    card, now titled "Session dev".
   * 3. Slide onto the server header's rail: assert exactly one card, now
   *    titled "Server default".
   * 4. Release: assert the server card stays open ("tmux -L default · 1
   *    session"), the URL is still /default, the group is still expanded, and
   *    the window rows are still visible.
   */
  test("cross-tier scrub: window → session → server retarget; release keeps the server card; nothing navigates or collapses", async ({
    page,
  }) => {
    await gotoCoarseDrawer(page);

    // Press @1's rail, then slide up across the session row onto the
    // server-group header without lifting.
    const winRailBox = (await prRow(page).getByTestId("status-rail").boundingBox())!;
    await page.mouse.move(winRailBox.x + winRailBox.width / 2, winRailBox.y + winRailBox.height / 2);
    await page.mouse.down();
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText("Tab @1");

    const sessionRailBox = (await sessionRow(page).getByTestId("status-rail").boundingBox())!;
    await page.mouse.move(
      sessionRailBox.x + sessionRailBox.width / 2,
      sessionRailBox.y + sessionRailBox.height / 2,
      { steps: 5 },
    );
    // One card, retargeted across the tier boundary to the session card.
    await expect(card(page)).toHaveCount(1);
    await expect(page.getByTestId("popup-title-bar")).toContainText("Session dev");

    const headerRailBox = (await serverHeader(page).getByTestId("status-rail").boundingBox())!;
    await page.mouse.move(
      headerRailBox.x + headerRailBox.width / 2,
      headerRailBox.y + headerRailBox.height / 2,
      { steps: 5 },
    );
    await expect(card(page)).toHaveCount(1);
    await expect(page.getByTestId("popup-title-bar")).toContainText("Server default");

    // Release keeps the server card; the scrub never selected, navigated, or
    // toggled anything.
    await page.mouse.up();
    await expect(card(page)).toContainText("tmux -L default · 1 session");
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/?$`));
    await expect(
      serverHeader(page).getByRole("button", { name: /Collapse default sessions/ }),
    ).toBeVisible();
    await expect(prRow(page)).toBeVisible();
  });
});
