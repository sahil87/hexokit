/**
 * Desktop native-engine e2e: the web tile's native engine (a shell-hosted
 * WebContentsView "guest") proven end to end against this worktree's derived
 * e2e rig — bounds over the tile rect, palette hide/show, the title relay,
 * ⌘K from inside the guest, host-switch z-order, window-close teardown, and
 * parked bounds while hidden.
 *
 * Shared setup: `beforeAll` creates a tmux session `e2e-desktop-<ts>` on the
 * rig's server and starts the guest stub (a `node:http` loopback listener
 * serving a titled page — on e2e-a the shell's web mode is `direct` (e2e-a's
 * origin IS what `rk url` resolves under the harness env, see _shell.ts), so
 * guests load the stub's LITERAL loopback URL from the per-host
 * `persist:rk-web:<hostId>` partition, which a `page.route` stub cannot
 * serve); `afterAll` kills both. `beforeEach`
 * launches a FRESH shell per test: a fresh `mkdtemp` XDG_CONFIG_HOME seeded
 * with a two-host `hosts.json` (e2e-a `127.0.0.1`, e2e-b `localhost`, both on
 * E2E_PORT — a real host switch against ONE rig), so the developer's real
 * config and any running shell are untouched; `afterEach` closes the app and
 * removes the temp dir even on mid-test failure. `seedWindow(name)` creates a
 * tmux window, stamps the stub's absolute URL + `@rk_win_layout single:web`,
 * and navigates the host page to the window route, waiting for the
 * `web-native-placeholder`. Window ids resolve tmux-side (`listWindows`), not
 * through the backend snapshot: the desktop Playwright config deliberately
 * declares no baseURL, so `_ready.ts`'s request-relative `resolveWindow`
 * cannot run here. Every Electron-side read polls — Electron state changes
 * are async to the SPA's IPC round-trips. The guest's webContents surfaces as
 * a Playwright Page, but a CDP-synthesized keypress never reaches Electron's
 * before-input-event, so (d) drives the chord through `sendInputEvent` via
 * `electronApp.evaluate` — the assertion set is identical.
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
  GUEST_TITLE,
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
// two physical copies of itself in one process. `READY_TIMEOUT` and
// `openPalette` are therefore defined locally, mirroring `_ready.ts`.

/** Readiness gate budget (the frontend convention): wider on CI to absorb
 *  shared-runner latency. */
const READY_TIMEOUT = process.env.CI ? 20_000 : 10_000;

/** Palette-open attempts and per-attempt wait (the `_ready.ts` shape). */
const PALETTE_ATTEMPTS = 3;
const PALETTE_ATTEMPT_TIMEOUT = 3_000;

/** Open the command palette with the SHIFTED chord form, which reaches the
 *  palette from every focus context on this rig, retrying with a blur between
 *  attempts; the last attempt asserts. Returns the palette's input. */
async function openPalette(page: Page): Promise<ReturnType<Page["getByPlaceholder"]>> {
  const input = page.getByPlaceholder("Type a command");
  for (let attempt = 0; attempt < PALETTE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    }
    await page.keyboard.press("Shift+Control+k");
    if (attempt === PALETTE_ATTEMPTS - 1) {
      await expect(
        input,
        `command palette did not open after ${PALETTE_ATTEMPTS} chord presses`,
      ).toBeVisible({ timeout: PALETTE_ATTEMPT_TIMEOUT });
      return input;
    }
    const opened = await input
      .waitFor({ state: "visible", timeout: PALETTE_ATTEMPT_TIMEOUT })
      .then(() => true)
      .catch(() => false);
    if (opened) return input;
  }
  return input;
}

const TEST_SESSION = `e2e-desktop-${Date.now()}`;

/** Host-view DIPs vs the placeholder's CSS-px bounding box — rounding only. */
const BOUNDS_TOLERANCE_PX = 1;
/** The chord table uploads shortly after engine mount; the (d) press retries
 *  are bounded by this count, never an unbounded loop. */
const GUEST_CHORD_ATTEMPTS = 3;
const CHORD_ATTEMPT_TIMEOUT_MS = 3_000;
/** (g) settle window: a mis-applied hidden-time setBounds re-shows the view
 *  synchronously in main's handler; this window catches any late show. */
const LATE_APPLY_WINDOW_MS = 1_000;
/** (g) probe shift: the parked-bounds probe rect must differ from the tile's
 *  measured rect on every field. */
const PARK_PROBE_SHIFT_PX = 10;

let guest: GuestStub;
let app: ElectronApplication;
let configHome: string;
let hostPage: Page;

/** The guest node in the window's view tree — the child loading the stub's
 *  LITERAL loopback URL (e2e-a's web mode is `direct`: its origin is what
 *  `rk url` resolves under the harness env, so the native engine skips the
 *  `/proxy/<port>/` hop and loads `http://127.0.0.1:<stubPort>/` as-is). */
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

/** The shell bridge on the host page, narrowed to the invokers this spec
 *  uses (the preload's exact argument shapes). */
interface ShellBridge {
  servers: { switch: (id: string) => Promise<unknown> };
  web: {
    bounds: (
      tabKey: string,
      x: number,
      y: number,
      width: number,
      height: number,
    ) => Promise<unknown>;
  };
}

/** Press the palette chord INSIDE the guest via `sendInputEvent` (focus
 *  first — before-input-event follows focus). The guest's webContents DOES
 *  surface as a Playwright Page, but a CDP-synthesized key press never
 *  reaches Electron's before-input-event (verified on this lane: the main
 *  process logs no input event and the palette stays closed), so the chord
 *  goes through the main process instead; the matched-chord assertions are
 *  identical either way. */
async function pressGuestChord(): Promise<void> {
  await app.evaluate(({ webContents }, match) => {
    const target = webContents
      .getAllWebContents()
      .find((wc) => wc.getURL().includes(match));
    if (!target) throw new Error("guest webContents not found");
    target.focus();
    target.sendInputEvent({ type: "keyDown", keyCode: "k", modifiers: ["control"] });
    target.sendInputEvent({ type: "keyUp", keyCode: "k", modifiers: ["control"] });
  }, guest.literalUrl);
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

test.describe("web tile — native engine in the desktop shell", () => {
  /**
   * Proves: opening a web tab creates exactly one guest view, visible, whose
   * bounds match the tile's content rect on every field (within rounding) —
   * the guest paints exactly over its tile.
   * Steps:
   * 1. Seed a window with the stub URL + single:web; navigate the host page.
   * 2. Poll the view tree: exactly one child loads the stub's literal loopback
   *    URL, and it is visible with non-zero bounds.
   * 3. Poll the guest's live bounds against a FRESH placeholder bounding box
   *    until every field matches within 1 px — the engine re-measures on a
   *    rAF loop, so the guest converges onto the final layout; a one-shot box
   *    read would race that settling.
   */
  test("a web tab creates one visible guest whose bounds match the tile rect", async () => {
    await seedWindow(`wn-bounds-${Date.now()}`);

    await pollGuest((n) => n.visible && n.bounds.width > 0);
    const tree = await viewTree(app);
    expect(tree.filter((n) => n.url.startsWith(guest.literalUrl))).toHaveLength(1);
    await expect
      .poll(
        async () => {
          const node = await guestNode();
          const box = await hostPage.getByTestId("web-native-placeholder").boundingBox();
          if (!node || !box || !node.visible) return false;
          return (["x", "y", "width", "height"] as const).every(
            (field) => Math.abs(node.bounds[field] - box[field]) <= BOUNDS_TOLERANCE_PX,
          );
        },
        { timeout: READY_TIMEOUT },
      )
      .toBe(true);
  });

  /**
   * Proves: opening the command palette (a modal-class overlay) hides the
   * guest — nothing the SPA draws can paint over a native layer — and closing
   * the palette shows it again.
   * Steps:
   * 1. Seed + navigate; poll the guest visible.
   * 2. Open the palette with the shifted chord; assert its input is visible.
   * 3. Poll the guest's visible to false.
   * 4. Press Escape; poll visible back to true.
   */
  test("the palette hides the guest and Escape shows it again", async () => {
    await seedWindow(`wn-palette-${Date.now()}`);
    await pollGuest((n) => n.visible);

    const input = await openPalette(hostPage);
    await expect(input).toBeVisible();
    await pollGuest((n) => !n.visible);

    await hostPage.keyboard.press("Escape");
    await expect(input).toBeHidden({ timeout: READY_TIMEOUT });
    await pollGuest((n) => n.visible);
  });

  /**
   * Proves: the guest's document title reaches the tab strip through the
   * page-title-updated relay (guest → main → host web:event → engine state →
   * chrome).
   * Steps:
   * 1. Seed + navigate; wait for the placeholder.
   * 2. Assert the strip's web tab contains the stub page's title.
   */
  test("the guest's title reaches the tab strip", async () => {
    await seedWindow(`wn-title-${Date.now()}`);
    await expect(hostPage.locator('[data-testid="web-tab"]')).toContainText(GUEST_TITLE, {
      timeout: READY_TIMEOUT,
    });
  });

  /**
   * Proves: the palette chord pressed inside the guest opens the SPA's
   * palette on the host page — the web:chords table upload, main's
   * before-input-event match + preventDefault, the focus hop to the host
   * webContents, and the chord relay + document re-dispatch end to end.
   * Steps:
   * 1. Seed + navigate; poll the guest visible.
   * 2. Send Control+k to the guest webContents via sendInputEvent (focus hop
   *    first), up to 3 attempts — the chord table uploads shortly after mount.
   * 3. Assert the palette input becomes visible on the host page.
   */
  test("the palette chord pressed inside the guest opens the palette", async () => {
    await seedWindow(`wn-chord-${Date.now()}`);
    await pollGuest((n) => n.visible);

    const input = hostPage.getByPlaceholder("Type a command");
    let opened = false;
    for (let attempt = 0; attempt < GUEST_CHORD_ATTEMPTS && !opened; attempt++) {
      await pressGuestChord();
      opened = await input
        .waitFor({ state: "visible", timeout: CHORD_ATTEMPT_TIMEOUT_MS })
        .then(() => true)
        .catch(() => false);
    }
    expect(
      opened,
      `palette did not open after ${GUEST_CHORD_ATTEMPTS} in-guest chord presses`,
    ).toBe(true);
  });

  /**
   * Proves: a host switch hides the outgoing host's guest, and switching back
   * re-raises the guest above its host view and shows it — the detach hide
   * and the attach plan's re-add, read from Electron's contentView order
   * (bottom → top), not from any registry export.
   * Steps:
   * 1. Seed + navigate; poll the guest visible.
   * 2. From the host page, switch to e2e-b; poll: the e2e-b host child is
   *    present and the guest's visible is false.
   * 3. Switch back to e2e-a; poll: the guest is visible AND its contentView
   *    index is greater than the e2e-a host child's index.
   */
  test("a host switch hides the guest; switching back re-raises it above the host view", async () => {
    await seedWindow(`wn-switch-${Date.now()}`);
    await pollGuest((n) => n.visible);
    const origins = hostOrigins();
    const isHostA = (n: ViewNode) => n.url.startsWith(`${origins.a}/`);
    const isHostB = (n: ViewNode) => n.url.startsWith(`${origins.b}/`);

    await hostPage.evaluate((id) => {
      const shell = (window as unknown as { runkitShell: ShellBridge }).runkitShell;
      return shell.servers.switch(id);
    }, "e2e-b");
    await expect
      .poll(
        async () => {
          const tree = await viewTree(app);
          const node = tree.find((n) => n.url.startsWith(guest.literalUrl));
          return tree.some(isHostB) && node !== undefined && !node.visible;
        },
        { timeout: READY_TIMEOUT },
      )
      .toBe(true);

    await hostPage.evaluate((id) => {
      const shell = (window as unknown as { runkitShell: ShellBridge }).runkitShell;
      return shell.servers.switch(id);
    }, "e2e-a");
    await expect
      .poll(
        async () => {
          const tree = await viewTree(app);
          const guestIndex = tree.findIndex((n) => n.url.startsWith(guest.literalUrl));
          const hostIndex = tree.findIndex(isHostA);
          return (
            guestIndex >= 0 &&
            hostIndex >= 0 &&
            tree[guestIndex].visible &&
            guestIndex > hostIndex
          );
        },
        { timeout: READY_TIMEOUT },
      )
      .toBe(true);
  });

  /**
   * Proves: closing the shell window destroys its guest webContents — guests
   * die with their window, never leaking a renderer past it.
   * Steps:
   * 1. Seed + navigate; read the guest's webContents id from the view tree.
   * 2. In main, create a hidden keep-alive BrowserWindow (so
   *    window-all-closed cannot quit the app before the assertion), then
   *    close the shell window.
   * 3. Poll webContents.getAllWebContents(): the guest id is gone; and
   *    BrowserWindow.getAllWindows() no longer contains the shell window.
   */
  test("closing the window destroys its guest", async () => {
    await seedWindow(`wn-close-${Date.now()}`);
    const node = await pollGuest((n) => n.visible && n.id !== null);
    const guestId = node.id!;
    const shellWindowId = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.id ?? null,
    );
    expect(shellWindowId, "shell window exists").not.toBeNull();

    await app.evaluate(({ BrowserWindow }) => {
      new BrowserWindow({ show: false });
    });
    await app.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.fromId(id)?.close();
    }, shellWindowId);

    await expect
      .poll(
        async () =>
          app.evaluate(
            ({ webContents }, id) =>
              webContents.getAllWebContents().some((wc) => wc.id === id),
            guestId,
          ),
        { timeout: READY_TIMEOUT },
      )
      .toBe(false);
    await expect
      .poll(
        async () =>
          app.evaluate(
            ({ BrowserWindow }, id) =>
              BrowserWindow.getAllWindows().some((win) => win.id === id),
            shellWindowId,
          ),
        { timeout: READY_TIMEOUT },
      )
      .toBe(false);
  });

  /**
   * Proves: a web:bounds call while the guest is hidden (palette open) parks
   * the rect and leaves the guest hidden with unchanged live bounds —
   * setBounds on a hidden view would re-show it (Electron 43/Linux), so main
   * must not apply it before web:visible {true}.
   * Steps:
   * 1. Seed + navigate; poll the guest visible; read its bounds and the
   *    placeholder's data-tab-key.
   * 2. Open the palette; poll the guest hidden.
   * 3. Call runkitShell.web.bounds(tabKey, …) with a rect distinct on every
   *    field from the pre-call read.
   * 4. After a settle window, assert the guest's visible is still false and
   *    its bounds still equal the pre-call read.
   */
  test("a hidden-time web:bounds parks the rect and leaves the guest hidden", async () => {
    await seedWindow(`wn-park-${Date.now()}`);
    const before = await pollGuest((n) => n.visible && n.bounds.width > 0);
    const tabKey = await hostPage
      .getByTestId("web-native-placeholder")
      .getAttribute("data-tab-key");
    expect(tabKey, "placeholder carries the guest's tabKey").not.toBeNull();

    await openPalette(hostPage);
    await pollGuest((n) => !n.visible);

    const probe = {
      x: before.bounds.x + PARK_PROBE_SHIFT_PX,
      y: before.bounds.y + PARK_PROBE_SHIFT_PX,
      width: Math.max(1, before.bounds.width - PARK_PROBE_SHIFT_PX),
      height: Math.max(1, before.bounds.height - PARK_PROBE_SHIFT_PX),
    };
    await hostPage.evaluate(
      ({ key, rect }) => {
        const shell = (window as unknown as { runkitShell: ShellBridge }).runkitShell;
        return shell.web.bounds(key, rect.x, rect.y, rect.width, rect.height);
      },
      { key: tabKey!, rect: probe },
    );

    await hostPage.waitForTimeout(LATE_APPLY_WINDOW_MS);
    const after = await guestNode();
    expect(after, "guest still in the view tree").not.toBeNull();
    expect(after!.visible).toBe(false);
    expect(after!.bounds).toEqual(before.bounds);
  });
});
