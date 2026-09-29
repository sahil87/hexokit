/**
 * Desktop native-engine e2e: guest RETENTION across tile unmounts (park +
 * adopt), menu-driven hiding, and the "+" draft tab's hide — proven against
 * Electron's own objects and the guest's page-side state.
 *
 * Shared setup: same harness shape as web-native.spec.ts. `beforeAll` creates
 * a tmux session `e2e-desktop-retention-<ts>` on the rig's server and starts
 * the guest stub (a `node:http` loopback listener serving a titled page — on
 * e2e-a the shell's web mode is `direct`, see _shell.ts, so guests load the
 * stub's LITERAL loopback URL from the per-host `persist:rk-web:<hostId>`
 * partition, which a `page.route` stub cannot serve); `afterAll` kills both.
 * `beforeEach` launches a FRESH shell per test over a fresh mkdtemp
 * XDG_CONFIG_HOME seeded with the two-host hosts.json (e2e-a `127.0.0.1`,
 * e2e-b `localhost`, both on E2E_PORT), so the developer's real config and
 * any running shell are untouched; `afterEach` closes the app and removes the
 * temp dir even on mid-test failure. `seedWindow` creates a tmux window
 * stamped with the stub's absolute URL + `@rk_win_layout single:web` and
 * navigates the host page to its route. Window SWITCHES go through a sidebar
 * row click (the SPA router) — never a second `goto`: a full navigation
 * reloads the host SPA, and main destroys every guest of a reloaded host (the
 * did-navigate teardown), which would defeat the retention under test. The
 * load token is the guest document's `performance.timeOrigin`, read main-side
 * through the guest webContents' `executeJavaScript` — it is fixed at the
 * navigation commit, so a reload (a new document in a new renderer) changes
 * it alongside the webContents id, while a park/adopt keeps both. Every
 * Electron-side read polls — Electron state changes are async to the SPA's
 * IPC round-trips.
 */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TMUX_SERVER,
  createSession,
  killSession,
  listWindows,
  newWindow,
  setWindowOption,
  stampWebTab,
} from "../../../frontend/tests/e2e/_tmux";
import {
  hostOrigins,
  launchShell,
  pageByOrigin,
  seedHosts,
  startGuestStub,
  viewTree,
  type GuestStub,
  type ViewNode,
} from "./_shell";

// The frontend's `_tmux` fixture is imported (it uses node builtins only);
// `_ready` is NOT: it imports `@playwright/test`, which would load the
// frontend's own Playwright copy into this process, and Playwright refuses
// two physical copies of itself in one process. `READY_TIMEOUT` is therefore
// defined locally, mirroring `_ready.ts`.

/** Readiness gate budget (the frontend convention): wider on CI to absorb
 *  shared-runner latency. */
const READY_TIMEOUT = process.env.CI ? 20_000 : 10_000;

const TEST_SESSION = `e2e-desktop-retention-${Date.now()}`;

let guest: GuestStub;
let app: ElectronApplication;
let configHome: string;
let hostPage: Page;

/** The guest node in the window's view tree — the child loading the stub's
 *  LITERAL loopback URL (e2e-a's web mode is `direct`, so the native engine
 *  loads `http://127.0.0.1:<stubPort>/` as-is). A parked or draft-hidden
 *  guest stays ON the tree with visible false — only a destroy removes it. */
async function guestNode(): Promise<ViewNode | null> {
  const tree = await viewTree(app);
  return tree.find((node) => node.url.startsWith(guest.literalUrl)) ?? null;
}

/** Poll until the guest exists in the tree and satisfies `pred`. */
async function pollGuest(pred: (node: ViewNode) => boolean): Promise<ViewNode> {
  let node: ViewNode | null = null;
  await expect
    .poll(
      async () => {
        node = await guestNode();
        return node !== null && pred(node);
      },
      { timeout: READY_TIMEOUT },
    )
    .toBe(true);
  return node!;
}

/** Create a tmux window stamped with the guest stub as its active web tab,
 *  navigate the host page to it, and wait for the native placeholder. */
async function seedWindow(name: string): Promise<string> {
  newWindow(TEST_SESSION, name);
  const found = listWindows(TEST_SESSION).find((w) => w.name === name);
  if (!found) throw new Error(`window "${name}" not found in ${TEST_SESSION}`);
  stampWebTab(found.windowId, `${guest.origin}/`);
  setWindowOption(found.windowId, "@rk_win_layout", "single:web");
  await hostPage.goto(
    `${hostOrigins().a}/${TMUX_SERVER}/${encodeURIComponent(found.windowId)}`,
  );
  await expect(hostPage.getByTestId("web-native-placeholder")).toBeVisible({
    timeout: READY_TIMEOUT,
  });
  return found.windowId;
}

/** In-app window switch through the sidebar row (the SPA router — a `goto`
 *  would reload the host SPA and main's did-navigate teardown would destroy
 *  the guest, defeating the retention under test). Gates on the row's
 *  aria-current so the route change has settled before the caller reads
 *  Electron state. */
async function switchToWindow(windowId: string): Promise<void> {
  const row = hostPage
    .locator(`[data-window-id="${windowId}"]`)
    .getByRole("button")
    .first();
  await expect(row).toBeVisible({ timeout: READY_TIMEOUT });
  await row.click();
  await expect(row).toHaveAttribute("aria-current", "page", { timeout: READY_TIMEOUT });
}

/** The guest document's load token (`performance.timeOrigin`), read main-side
 *  through the guest webContents — reachable while the guest is parked or
 *  hidden, and null while no committed guest exists. */
async function guestLoadToken(): Promise<number | null> {
  return app.evaluate(async ({ webContents }, match) => {
    const target = webContents
      .getAllWebContents()
      .find((wc) => wc.getURL().startsWith(match));
    if (!target || target.isDestroyed()) return null;
    return target.executeJavaScript("performance.timeOrigin", true);
  }, guest.literalUrl);
}

/** Whether a webContents id still names a live renderer — the parked guest
 *  keeps running, so its id survives the tile unmount. */
async function guestWebContentsAlive(id: number): Promise<boolean> {
  return app.evaluate(
    ({ webContents }, wcId) =>
      webContents.getAllWebContents().some((wc) => wc.id === wcId && !wc.isDestroyed()),
    id,
  );
}

test.beforeAll(async () => {
  createSession(TEST_SESSION);
  guest = await startGuestStub();
});

test.afterAll(async () => {
  killSession(TEST_SESSION);
  await new Promise<void>((resolve) => guest.server.close(() => resolve()));
});

test.beforeEach(async () => {
  configHome = mkdtempSync(join(tmpdir(), "rk-desktop-e2e-"));
  seedHosts(configHome);
  app = await launchShell(configHome);
  hostPage = await pageByOrigin(app, hostOrigins().a, READY_TIMEOUT);
});

test.afterEach(async () => {
  try {
    await app.close();
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test.describe("web tile — native guest retention in the desktop shell", () => {
  /**
   * Proves: switching to another tmux window and back does NOT reload the web
   * tab — the guest is parked hidden while the tile is unmounted (its
   * renderer keeps running) and ADOPTED on return: the same webContents id
   * and the same page-side load token (`performance.timeOrigin`), visible
   * again, with no new renderer booted.
   * Steps:
   * 1. Create a plain window and a web window stamped with the stub URL;
   *    navigate the host page to the web window; poll the guest visible and
   *    record its webContents id and load token (non-null ⇒ the stub
   *    document committed, so the token is the real page's).
   * 2. Sidebar-click the plain window; poll the guest hidden (parked) and
   *    assert its webContents is still alive — hidden, not destroyed.
   * 3. Sidebar-click back to the web window; poll the guest visible again
   *    and assert its webContents id AND load token are unchanged — an
   *    adoption, not a reload.
   */
  test("a window switch parks the guest and returning adopts it without a reload", async () => {
    const ts = Date.now();
    const plainName = `wr-plain-${ts}`;
    newWindow(TEST_SESSION, plainName);
    const plain = listWindows(TEST_SESSION).find((w) => w.name === plainName);
    if (!plain) throw new Error(`window "${plainName}" not found in ${TEST_SESSION}`);
    const webWindowId = await seedWindow(`wr-web-${ts}`);

    const before = await pollGuest((n) => n.visible && n.id !== null);
    const guestId = before.id!;
    const tokenBefore = await guestLoadToken();
    expect(tokenBefore, "guest document committed (load token readable)").not.toBeNull();

    await switchToWindow(plain.windowId);
    await pollGuest((n) => !n.visible);
    await expect
      .poll(() => guestWebContentsAlive(guestId), { timeout: READY_TIMEOUT })
      .toBe(true);

    await switchToWindow(webWindowId);
    const after = await pollGuest((n) => n.visible && n.id !== null);
    expect(after.id, "adopted the parked guest (same webContents — no re-create)").toBe(guestId);
    await expect
      .poll(() => guestLoadToken(), { timeout: READY_TIMEOUT })
      .toBe(tokenBefore);
  });

  /**
   * Proves: opening a click-opened menu (the top-bar overflow menu) hides the
   * guest — a native layer paints above everything the DOM draws, so the menu
   * would render underneath it — and closing the menu with Escape shows the
   * guest again, read from Electron's `View.getVisible()`, not the DOM.
   * Steps:
   * 1. Seed + navigate; poll the guest visible.
   * 2. Click the top bar's `More controls` chevron; assert the menu is
   *    visible; poll the guest's visible to false.
   * 3. Press Escape; assert the menu is gone; poll the guest's visible back
   *    to true.
   */
  test("the top-bar overflow menu hides the guest and Escape shows it again", async () => {
    await seedWindow(`wr-menu-${Date.now()}`);
    await pollGuest((n) => n.visible);

    await hostPage.getByRole("button", { name: "More controls" }).click();
    const menu = hostPage.getByRole("menu", { name: "More controls" });
    await expect(menu).toBeVisible({ timeout: READY_TIMEOUT });
    await pollGuest((n) => !n.visible);

    await hostPage.keyboard.press("Escape");
    await expect(menu).toBeHidden({ timeout: READY_TIMEOUT });
    await pollGuest((n) => n.visible);
  });

  /**
   * Proves: selecting a draft ("+") hides the previous tab's guest and shows
   * the blank new-tab panel instead of the old page, and re-selecting the tab
   * re-activates the SAME guest — visible again, same webContents id and load
   * token (the frame stayed mounted; no reload).
   * Steps:
   * 1. Seed + navigate; poll the guest visible and record its webContents id
   *    and load token.
   * 2. Click the tab strip's `+`; assert the `web-draft-panel` is visible and
   *    poll the guest hidden — still on the view tree (hidden, not
   *    destroyed).
   * 3. Click the web tab; assert the draft panel is gone; poll the guest
   *    visible again and assert its webContents id and load token are
   *    unchanged.
   */
  test("the \"+\" draft hides the previous guest; re-selecting the tab restores it without a reload", async () => {
    await seedWindow(`wr-draft-${Date.now()}`);
    const before = await pollGuest((n) => n.visible && n.id !== null);
    const guestId = before.id!;
    const tokenBefore = await guestLoadToken();
    expect(tokenBefore, "guest document committed (load token readable)").not.toBeNull();

    await hostPage.getByTestId("web-tab-add").click();
    await expect(hostPage.getByTestId("web-draft-panel")).toBeVisible({
      timeout: READY_TIMEOUT,
    });
    await pollGuest((n) => !n.visible);

    await hostPage.getByTestId("web-tab").click();
    await expect(hostPage.getByTestId("web-draft-panel")).toHaveCount(0, {
      timeout: READY_TIMEOUT,
    });
    const after = await pollGuest((n) => n.visible && n.id !== null);
    expect(after.id, "the same guest re-activated (no reload)").toBe(guestId);
    await expect
      .poll(() => guestLoadToken(), { timeout: READY_TIMEOUT })
      .toBe(tokenBefore);
  });
});
