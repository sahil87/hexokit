import { test, expect, type Page } from "@playwright/test";
import { mockStateSocket } from "./_state-socket-mock";

// Fully-mocked spec (same technique as top-bar-refresh.spec.ts): the server
// list, boards list, and board entries are injected via page.route and the
// sessions payload via the state-socket mock, so no live tmux backend is
// needed.
//
// Regression coverage for the persistent TopBar: the bar mounts ONCE in the
// persistent root layout (`AppLayout`, above the router `<Outlet>`) rather
// than three separate per-page copies. This asserts the user-facing outcomes
// of that lift:
//   1. The bar is present (its brand link visible) immediately after each
//      CLIENT-SIDE cross-route navigation settles — it is not torn down and
//      rebuilt as a blank between pages (the old "navbar reload" flicker).
//      This is the persistence claim, and it holds only for genuine in-app
//      router navigation: hops 1 (server tile → `/$server`) and 3 (board
//      tile → `/board/$name`) click TanStack-Router-driven controls.
//   2. Its center heading is route-derived and updates per route — Host →
//      `tmux Server <server>` → back to Host → `Board <board>` — including
//      the board heading, which renders from the URL param while the lazy
//      board chunk loads.
//   3. On an unmatched route (`/board/x/y`), the bar falls back to the
//      minimal `host` heading rather than leaking the fuzzy-matched board
//      param as `Board x` (the not-found-fallback fix).
//
// NOTE on hop 1's server choice: a Host-page server tile is a SWITCH
// affordance, and a switch resolves a landing window for the target server,
// so a tile for a server that HAS windows navigates to `/$server/$window`,
// not `/$server`. Hop 1 therefore clicks EMPTY_SERVER — a mocked server with
// no sessions, where the resolution has nothing to pick and correctly falls
// through to the bare server route. That keeps hop 1 a genuine client-side
// hop into `tmux Server` mode (which is what this spec is about) while
// staying truthful about the switch contract; the populated-server case is
// covered by its own test below.
//
// NOTE on hop 2 (brand link → `/`): the brand link is a RAW `<a href="/">`
// (top-bar.tsx), which TanStack Router does NOT intercept — clicking it is a
// FULL document navigation, not client-side. So hop 2 is a RELOAD BOUNDARY,
// not a persistence hop: it verifies the persistent-layout chrome mounts
// correctly on a COLD load at `/`, NOT that the bar survived without a
// remount. Only hops 1 and 3 test no-remount persistence.
//
// Shared setup: `beforeEach` installs the routes. `**/api/servers` returns
// two servers (`default` with one session, `spare` with zero — two clickable
// Host-page tiles); `**/api/boards` returns one board `myboard`;
// `**/api/boards/myboard` returns one board entry (server `default`, window
// `@1`) so the board route has content; the state socket (mockStateSocket)
// carries a per-server payload (`sessionsByServer`: `default` gets session
// `dev` with a single active window `@1` "feature-work", `spare` gets `[]`);
// `**/api/windows/*/select*` fulfills `{ ok: true }` (the trailing `*`
// matches the `?server=` query) so window-selection POSTs during nav don't
// error; the `/ws/terminals` mux WebSocket is stubbed (accepted, held open)
// so any terminal pane mounts without a backend. Heading aria-labels carry
// no colon (the `PageType: name` colon is presentational): `Host`,
// `tmux Server default`, `Board myboard`; the `Host` heading is matched with
// `exact: true` to disambiguate it from the Host page's `Host health` region
// (`getByLabel` is a substring match by default).
//
// (The internal implementation — a single non-remounting `RootTopBar` fed by
// a route-derived mode + a page-registered slot context — is unit-tested in
// top-bar-slot-context.test.tsx; this e2e covers the observable cross-route
// behavior.)

const SERVER = "default";
// A second mocked server with NO sessions. Its tile is the one Host-page switch
// affordance that still lands on the bare `/$server` route.
const EMPTY_SERVER = "spare";
const BOARD = "myboard";

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
      },
    ],
  },
]);

async function mockBackend(page: Page): Promise<void> {
  await page.routeWebSocket(/\/ws\/terminals/, () => {
    /* accept, send nothing */
  });
  await page.route("**/api/windows/*/select*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { name: SERVER, sessionCount: 1 },
        { name: EMPTY_SERVER, sessionCount: 0 },
      ]),
    }),
  );
  await page.route("**/api/boards", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ name: BOARD, pinCount: 1 }]),
    }),
  );
  await page.route(`**/api/boards/${BOARD}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          server: SERVER,
          windowId: "@1",
          session: "dev",
          windowIndex: 0,
          windowName: "feature-work",
          orderKey: "a0",
        },
      ]),
    }),
  );
  await mockStateSocket(page, {
    sessions: sessionsPayload,
    sessionsByServer: { [SERVER]: sessionsPayload, [EMPTY_SERVER]: "[]" },
  });
}

// The brand link is the always-present bar element on every mode — its
// continuous visibility across navigation is the proxy for "the bar never
// blanks out". Its POSITION is state-dependent: on desktop routes with the
// sidebar open it is the sidebar head's anchor over the bar's left end;
// otherwise it is the breadcrumb nav's root crumb. Selecting by label keeps
// this helper true in both positions.
const brand = (page: Page) => page.getByLabel("HexoKit home");

test.describe("TopBar persistence across routes (260707-4vq2)", () => {
  test.beforeEach(async ({ page }) => {
    await mockBackend(page);
  });

  /**
   * Proves: across Host → tmux Server → Host → Board navigation, the
   * persistent top bar remains present (its brand link visible after every
   * hop) and its route-derived center heading updates to the correct page
   * each time, including the board heading rendered from the URL while the
   * lazy chunk loads.
   *
   * Steps:
   * 1. `goto("/")`; assert the solo `Host` heading and the `HexoKit home`
   *    brand link are visible.
   * 2. Click the `spare` server tile (scoped to the "Tmux servers" region;
   *    `spare` has no sessions, so the switch resolves no landing window —
   *    see the header note). Assert URL `/spare`, heading
   *    `tmux Server spare`, brand link visible, and the previous `Host`
   *    heading is gone (count 0 — the mode is route-derived, not stacked).
   * 3. (Reload boundary) Click the `HexoKit home` brand link — a full
   *    document reload, not client-side nav. Assert URL `/`, the
   *    persistent-layout chrome remounts with the `Host` heading, brand
   *    crumb visible, and the `tmux Server spare` heading gone.
   * 4. Click the `myboard` board tile (scoped to the "Boards" region).
   *    Assert URL `/board/myboard`, heading `Board myboard` (from the URL
   *    param while the lazy board chunk loads), and the brand link still
   *    visible.
   */
  test("the persistent bar stays present and its heading updates across / → /$server → /board", async ({
    page,
  }) => {
    // Host. Solo `Host` center heading + the persistent bar's brand link.
    // `exact: true` disambiguates the bar's `Host` heading from the Host page's
    // `Host health` region (both are aria-labelled and `getByLabel` is a
    // substring match by default).
    await page.goto("/");
    await expect(page.getByLabel("Host", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(brand(page)).toBeVisible();

    // Hop 1: server tile (scoped to the Tmux servers region) → `/$server`. The
    // route-derived heading flips to `tmux Server <server>` (aria-label carries
    // no colon — the `:` is presentational). The bar is present immediately.
    // EMPTY_SERVER has no sessions, so the switch resolves no landing window and
    // lands on the bare server route (see the header note).
    await page
      .getByRole("region", { name: "Tmux servers" })
      .getByRole("button", { name: EMPTY_SERVER, exact: false })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/${EMPTY_SERVER}$`));
    await expect(page.getByLabel(`tmux Server ${EMPTY_SERVER}`)).toBeVisible();
    await expect(brand(page)).toBeVisible();
    // The prior mode's heading is gone (mode is route-derived, not stacked).
    await expect(page.getByLabel("Host", { exact: true })).toHaveCount(0);

    // Hop 2 (RELOAD BOUNDARY, not persistence): the brand link is a raw
    // `<a href="/">` that TanStack Router does NOT intercept, so clicking it is
    // a FULL document navigation. We assert the persistent-layout chrome mounts
    // correctly on a cold load at `/` — route-derived `Host` heading present,
    // prior `tmux Server` heading gone — NOT that the bar survived a remount.
    await brand(page).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByLabel("Host", { exact: true })).toBeVisible();
    await expect(brand(page)).toBeVisible();
    await expect(page.getByLabel(`tmux Server ${EMPTY_SERVER}`)).toHaveCount(0);

    // Hop 3 (client-side): board tile → `/board/$name`. The board chunk is
    // lazy, but the route-derived heading renders `Board <board>` from the URL
    // param while the chunk loads — and the bar (brand link) stays present
    // throughout without a remount (this IS a persistence hop).
    await page
      .getByRole("region", { name: "Boards" })
      .getByRole("button", { name: BOARD, exact: false })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/board/${BOARD}$`));
    await expect(page.getByLabel(`Board ${BOARD}`)).toBeVisible();
    await expect(brand(page)).toBeVisible();
  });

  /**
   * Proves: the switch counterpart of hop 1 — a Host-page server tile for a
   * server that HAS windows resolves a landing window and navigates to the
   * terminal route, instead of dropping the user on the session-tiles
   * overview. This is the behavior that makes hop 1 use `spare`, so the two
   * tests pin both halves of the switch contract.
   *
   * Steps:
   * 1. `goto("/")`; assert the solo `Host` heading is visible.
   * 2. Click the `default` server tile (scoped to the "Tmux servers"
   *    region).
   * 3. Assert URL `/default/1` (the window id `@1` minus its `@`), the
   *    brand link is still visible, and there is NO `tmux Server default`
   *    heading (count 0 — the bar is in terminal mode, not server mode).
   */
  test("a Host-page tile for a server with windows switches into that server's window", async ({
    page,
  }) => {
    // The switch counterpart of hop 1. SERVER has session `dev` with the active
    // window `@1`, so the tile resolves a landing window and navigates to the
    // terminal route — the bar follows with the `Window` heading rather than
    // `tmux Server`. The URL segment is the window id minus its `@`.
    await page.goto("/");
    await expect(page.getByLabel("Host", { exact: true })).toBeVisible({ timeout: 10_000 });

    await page
      .getByRole("region", { name: "Tmux servers" })
      .getByRole("button", { name: SERVER, exact: false })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/1$`));
    await expect(brand(page)).toBeVisible();
    // Terminal mode, not the session-tiles overview.
    await expect(page.getByLabel(`tmux Server ${SERVER}`)).toHaveCount(0);
  });

  /**
   * Proves: on an unmatched route that fuzzy-matches the board route
   * (`/board/x/y`, so `NotFoundPage` renders under the persistent bar), the
   * bar falls back to the minimal `host` heading instead of leaking the
   * partially-matched `name=x` param as a `Board x` heading — TanStack
   * Router retains fuzzy-matched params in `useMatches()`, so
   * `NotFoundPage` signals not-found into the slot context and `RootTopBar`
   * forces the host fallback.
   *
   * Steps:
   * 1. `goto("/board/x/y")`; assert the `Page not found` body is visible.
   * 2. Assert the persistent bar shows the `Host` fallback heading and its
   *    brand link is visible.
   * 3. Assert there is NO `Board x` heading (count 0 — the fuzzy-matched
   *    param did not leak into the bar).
   */
  test("an unmatched route falls back to the minimal host heading (not the fuzzy-matched board param)", async ({
    page,
  }) => {
    // `/board/x/y` fuzzy-matches the board route (`name=x`) then bubbles to the
    // app-layout route's `notFoundComponent` (NotFoundPage). TanStack Router
    // RETAINS the partially-matched param in `useMatches()`, so without the
    // not-found signal the bar would derive `board` mode and show `Board x`.
    // NotFoundPage signals not-found into the slot context, forcing the minimal
    // `host` fallback (T002 fix, R10 / A-015).
    await page.goto("/board/x/y");
    await expect(page.getByText("Page not found")).toBeVisible({ timeout: 10_000 });
    // The persistent bar is present with the host fallback heading …
    await expect(page.getByLabel("Host", { exact: true })).toBeVisible();
    await expect(brand(page)).toBeVisible();
    // … and it did NOT leak the fuzzy-matched board param as a `Board x` heading.
    await expect(page.getByLabel("Board x")).toHaveCount(0);
  });
});
