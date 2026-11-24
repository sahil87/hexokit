import { test, expect, type Page } from "@playwright/test";
import { mockStateSocket } from "./_state-socket-mock";

// This spec is fully mocked: we inject the `sessions` payload (and the
// server list) via the state-socket mock + page.route and navigate to a
// terminal window route. The RefreshButton rides the L3 always-block and
// renders at first paint; the ▦ Layout chip is gated on a current window, so
// IT is the synchronization anchor proving the mocked sessions payload
// landed.
//
// Verifies the top-bar RefreshButton: on a terminal route it renders in-bar
// followed by the always-present overflow chevron as the right-most element,
// and clicking it performs a full `window.location.reload()`. The right
// cluster is registry-driven: controls render directly (no `hidden sm:flex`
// wrapper spans) and the chevron lives inside the trailing exempt block, so
// ordering is asserted by document position at a wide viewport rather than
// by flat wrapper-sibling adjacency. The theme toggle, help link,
// notification bell, and connection dot are GONE from the bar (theme/help/dot
// moved to the sidebar footer; the bell folded into the settings dialog) —
// the spec also asserts their absence.
//
// Shared setup: `beforeEach` installs the routes, navigates to the
// percent-encoded terminal window route `/default/%401` (`@1`), and waits
// for the ▦ Layout chip (terminal-gated on `currentWindow`) to be visible —
// the signal the state-socket payload has landed and `currentWindow` is set.
// The Refresh button cannot be this anchor: it rides the L3 always-block and
// is visible at first paint, before the mocked state-socket event is
// processed, so anchoring on it raced the mount-time `/select` POST.
// `**/api/servers` returns a single server `default` (so the app subscribes
// to exactly one server over the state socket); the state socket
// (mockStateSocket) carries session `dev` with two windows — `@1`
// "feature-work" (the URL target, `isActiveWindow: false`) and `@2` "other"
// (`isActiveWindow: true`) — which satisfies the `currentWindow` gate and,
// because the deep-linked `@1` is NOT the tmux-active window, makes the
// mount-time alignment fire exactly one `selectWindow(server, "@1")` POST so
// the `/select` mock is genuinely exercised (a same-window payload would
// take the no-op path and never call `/select`; the switch overlay holds the
// URL on `@1` for up to the 5 s overlay deadline — this static payload never
// confirms — so `currentWindow` resolves to `@1` while each test runs). `**/api/windows/*/select*`
// fulfills `{ ok: true }` — the trailing `*` is required because Playwright
// globs match the full URL including the query string, and client.ts
// `withServer` appends `?server=default`; without it the POST would fall
// through to the real backend and issue a live tmux `select-window`,
// breaking the "no real backend reads" guarantee. The `/ws/terminals` mux
// WebSocket is stubbed (accepted and held open) so the terminal route mounts
// without a backend.
//
// The RefreshButton calls window.location.reload() — the routes installed
// via page.route persist across the in-page reload, so the app re-mounts on
// the same mocked data and the button reappears after the reload settles.

const SERVER = "default";

// One session with two windows. The URL deep-links to `@1`, but `@2` is the
// tmux-active window (`isActiveWindow: true`) — so app.tsx's mount-time
// alignment fires exactly one `selectWindow(server, "@1")` POST to bring tmux
// into agreement with the URL, and starts a switch overlay that holds the URL
// on `@1` until a newer sessions snapshot arrives or the 5 s overlay deadline
// passes (this static payload sends none, so the deadline bounds the hold). This is
// deliberate: it makes the `/select` mock actually fire (so its interception is
// verifiable — see `selectHits` below) instead of the no-op path a URL that
// already matches the active window would take. `currentWindow` keys on the URL
// (`@1`), so the Close/Split cluster still renders.
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
        isActiveWindow: false,
        activityTimestamp: 0,
      },
      {
        windowId: "@2",
        index: 1,
        name: "other",
        worktreePath: "/tmp/wt2",
        activity: "active",
        isActiveWindow: true,
        activityTimestamp: 0,
      },
    ],
  },
]);

// The terminal window route `/$server/$window` (`@` percent-encoded to `%40`),
// where a current window exists and the full three-level cluster renders.
const WINDOW_URL = `/${SERVER}/%401`;

/**
 * Install routes that fully mock the server list and the state-socket sessions payload.
 * Returns a `selectHits` counter proving the /select mock actually intercepts
 * (rather than falling through to the real e2e backend — see the mock below).
 */
async function mockBackend(page: Page): Promise<{ selectHits: () => number }> {
  let selectHits = 0;

  // Stub the terminals mux WebSocket so the terminal route mounts without a
  // backend (the per-pane /relay/ socket was retired for /ws/terminals in
  // 260717-803u).
  await page.routeWebSocket(/\/ws\/terminals/, () => {
    /* accept and hold the socket open; send nothing */
  });

  // Selecting a window POSTs to /select — accept it so nav doesn't error.
  // Trailing `*` is REQUIRED: Playwright globs match the FULL URL including the
  // query string, and client.ts `withServer` appends `?server=default`. Without
  // it the POST falls through to the real e2e backend and issues a live tmux
  // select-window on the default socket. `selectHits` records interception so a
  // regression to the no-trailing-star glob (silent fallthrough) fails loudly.
  await page.route("**/api/windows/*/select*", (route) => {
    selectHits += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"ok":true}',
    });
  });

  // Single known server so the app attaches exactly one SSE connection.
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: SERVER, sessionCount: 1 }]),
    }),
  );

  // State socket: one `sessions` event carrying the mocked payload.
  await mockStateSocket(page, { sessions: sessionsPayload });

  return { selectHits: () => selectHits };
}

const refreshButton = (page: Page) => page.getByRole("button", { name: "Refresh page" });
// The currentWindow-gated sync anchor. The ✕ left the bar (menuOnly,
// 260731-oiho) and the split chip followed (menuOnly in terminal mode,
// 260813-w1lf), so the ▦ Layout chip — still terminal-gated on `currentWindow`
// and in-bar at the default wide viewport — is the anchor now.
const layoutChipAnchor = (page: Page) => page.getByRole("button", { name: "Layout", exact: true });

test.describe("Top-bar RefreshButton", () => {
  let selectHits: () => number;

  test.beforeEach(async ({ page }) => {
    ({ selectHits } = await mockBackend(page));
    await page.goto(WINDOW_URL);
    // Wait for the currentWindow-gated cluster to render (the SSE payload
    // landed → currentWindow set). The refresh button can no longer be this
    // anchor: it rides the L3 always-block (260704-9o7k) and is visible at
    // first paint, BEFORE the mocked SSE event is processed — anchoring on it
    // raced the mount-time /select POST and `selectHits` read 0. The ▦ Layout
    // chip is still terminal-gated on `currentWindow` (the ✕ left the bar in
    // 260731-oiho, the split chip in 260813-w1lf), so its visibility proves
    // the session data arrived.
    await expect(layoutChipAnchor(page)).toBeVisible({ timeout: 10_000 });
  });

  /**
   * Proves: the `/select` mock intercepted the window-selection POST fired
   * during navigation (so no real backend read/write occurred — the "fully
   * mocked" guarantee holds); and on a terminal route at a wide viewport
   * the Refresh page button renders in-bar followed by the always-present
   * overflow chevron ("More controls") as the right-most element of the
   * right cell (`data-testid="top-bar-right"`) — while the moved chrome
   * (theme toggle, help anchor, notification bell, connection dot) renders
   * NOWHERE in the bar. Ordering is asserted by document position
   * (coordinate-free), robust to the registry-driven structure where a
   * control may render in-bar or in the hidden measurement probe.
   *
   * Steps:
   * 1. Poll the `/select` route-mock hit counter until `> 0` — proof the
   *    trailing-`*` glob intercepts the `?server=default` URL rather than
   *    falling through to the real backend (the POST fires in a mount-time
   *    effect fractionally after the ▦ Layout anchor renders).
   * 2. Set a wide 1280px viewport so the L3 controls stay in-bar.
   * 3. Assert the `Refresh page` button is visible.
   * 4. In the page, assert the right cell contains NO theme button, help
   *    anchor, bell, or `role="status"` dot; resolve refresh + chevron and
   *    assert the document-position chain Refresh → chevron, with the
   *    chevron inside the cluster's last child (the trailing exempt block).
   */
  test("renders refresh before the right-most chevron, with theme/help/bell/dot gone from the bar, on a terminal route", async ({
    page,
  }) => {
    // The /select mock intercepted the window-selection POST fired during nav —
    // it did NOT fall through to the real e2e backend (which would issue a live
    // tmux select-window on the default socket). This guards the trailing-`*`
    // glob fix: a regression to `**/api/windows/*/select` (no trailing star)
    // misses the `?server=default` query string and this count drops to 0.
    // Polled: the POST fires in a mount-time effect that runs fractionally
    // after the close button (the beforeEach anchor) becomes visible.
    await expect.poll(selectHits).toBeGreaterThan(0);

    // Wide viewport so the L3 controls stay IN-BAR (registry-driven overflow,
    // 260715-h1ck). After 260724-6j1v the surviving L3 always-block is Refresh
    // (+ the context-gated UpdateChip): theme/help moved to the sidebar footer,
    // the bell folded into the settings dialog, and the connection dot moved to
    // the footer too — the always-present overflow chevron is now the
    // right-most element of the cluster (the trailing exempt block).
    await page.setViewportSize({ width: 1280, height: 800 });

    // Refresh renders in-bar on a terminal route at a wide width.
    await expect(refreshButton(page)).toBeVisible();

    // Order + absences via document position (coordinate-free, robust to
    // whether a control is in-bar or the measurement probe): Refresh → chevron
    // last; NO theme button, help anchor, bell, or status dot in the bar.
    const order = await page.evaluate(() => {
      const cluster = document.querySelector('[data-testid="top-bar-right"]');
      if (!cluster) return "no-cluster";
      if (cluster.querySelector('button[aria-label$=" theme"]')) return "theme-still-in-bar";
      if (cluster.querySelector('a[aria-label^="Help"]')) return "help-still-in-bar";
      if (cluster.querySelector('button[aria-label^="Notifications"]')) return "bell-still-in-bar";
      if (cluster.querySelector('[role="status"]')) return "dot-still-in-bar";
      const refresh = document.querySelector('button[aria-label="Refresh page"]');
      const chevron = document.querySelector('button[aria-label="More controls"]');
      if (!refresh || !chevron) return "missing";
      const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
      const follows = (a: Element, b: Element) =>
        Boolean(a.compareDocumentPosition(b) & FOLLOWING);
      if (!follows(refresh, chevron)) return "refresh-not-before-chevron";
      // The chevron rides the cluster's LAST child (the trailing exempt block).
      return cluster.lastElementChild?.contains(chevron) ? "pyramid" : "chevron-not-last";
    });
    expect(order).toBe("pyramid");
  });

  /**
   * Proves: clicking the RefreshButton performs a genuine full-page reload
   * (`window.location.reload()`), not an in-app state change.
   *
   * Steps:
   * 1. Plant a marker `window.__refreshMarker = true` on the current window
   *    object and confirm it reads back as `true`.
   * 2. Click the `Refresh page` button and wait for the page `load` event
   *    (a real navigation fires it).
   * 3. After the reload settles, assert the `Refresh page` button is
   *    visible again (the app re-mounts on the same mocked routes, which
   *    persist across the reload).
   * 4. Assert `window.__refreshMarker` is now `undefined` — the fresh
   *    window created by the reload discarded the pre-reload marker,
   *    proving a real reload occurred.
   */
  test("clicking the refresh button reloads the page", async ({ page }) => {
    // Plant a marker on the current window object. A full reload creates a fresh
    // window, so the marker is gone afterwards — the observable proof of reload.
    await page.evaluate(() => {
      (window as unknown as { __refreshMarker?: boolean }).__refreshMarker = true;
    });
    expect(
      await page.evaluate(
        () => (window as unknown as { __refreshMarker?: boolean }).__refreshMarker === true,
      ),
    ).toBe(true);

    // Clicking triggers window.location.reload() → a real navigation.
    await Promise.all([page.waitForEvent("load"), refreshButton(page).click()]);

    // After the reload settles the app re-mounts on the same mocked data and the
    // button reappears — but the pre-reload marker is gone (fresh window).
    await expect(refreshButton(page)).toBeVisible({ timeout: 10_000 });
    expect(
      await page.evaluate(
        () => (window as unknown as { __refreshMarker?: boolean }).__refreshMarker,
      ),
    ).toBeUndefined();
  });
});
