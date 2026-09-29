/**
 * Desktop surface-popout e2e: the SPA's Pop out verb over the shell's
 * `windows.popout` bridge — a second chrome-less shell window on the `?pop=`
 * route, the opener's per-viewer reflow, the repeat-pop-out dedupe (focus,
 * never a third window), and the web tile's LIVE GUEST moving between the
 * opener and the popout window with its renderer state intact.
 *
 * Shared setup: `beforeAll` creates a tmux session `e2e-desktop-popout-<ts>`
 * on the rig's server and starts the guest stub (a spec-owned `node:http`
 * loopback listener serving a page whose inline script increments
 * `window.loads` on every document load — together with
 * `performance.timeOrigin`, fixed at the navigation commit, and a
 * test-planted `window.marker`, a reload is distinguishable from a move; on
 * e2e-a the shell's web mode is `direct`, see _shell.ts, so guests load the
 * stub's LITERAL loopback URL from the per-host `persist:rk-web:<hostId>`
 * partition, which a `page.route` stub cannot serve); `afterAll` kills both.
 * `beforeEach` launches a FRESH shell per test over a fresh `mkdtemp`
 * XDG_CONFIG_HOME seeded with the two-host hosts.json (e2e-a `127.0.0.1`,
 * e2e-b `localhost`, both on E2E_PORT — cold start opens exactly one window
 * on e2e-a), so the developer's real config and any running shell are
 * untouched; `afterEach` closes the app and removes the temp dir even on
 * mid-test failure. `seedTtyWebWindow(name)` creates a tmux window stamped
 * with the stub as its active web tab plus `@rk_win_layout h(tty,web)` and
 * navigates the host page to the window route — two tiles, so the header's
 * Pop out verb is offered (a single-tile render never offers it). No global
 * state outside the shell's temp config home is written, so nothing is
 * restored. Every Electron-side read polls — window opens, guest moves, and
 * focus changes are all async to the SPA's IPC round-trips. Registry claims
 * (window count, per-window view trees, focus) are read from Electron's own
 * objects (`BrowserWindow.getAllWindows()`, `win.contentView.children`,
 * `webContents.getURL()`) through `electronApp.evaluate`; guest page state is
 * read main-side through the guest webContents' `executeJavaScript`, which
 * reaches the guest while parked or mid-move too.
 */
import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TMUX_SERVER,
  createSession,
  killSession,
  listClients,
  listWindows,
  newWindow,
  setWindowOption,
  stampWebTab,
} from "../../../frontend/tests/e2e/_tmux";
import {
  findPage,
  hostOrigins,
  launchShell,
  pageByOrigin,
  seedHosts,
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

/** Host-view DIPs vs the placeholder's CSS-px bounding box — rounding only
 *  (the web-native.spec.ts convention). */
const BOUNDS_TOLERANCE_PX = 1;

const TEST_SESSION = `e2e-desktop-popout-${Date.now()}`;

const STUB_TITLE = "rk e2e popout guest";

let stub: GuestStub;
let app: ElectronApplication;
let configHome: string;
let hostPage: Page;

/** The spec-owned guest stub: like _shell.ts's, but the page carries a load
 *  counter (`window.loads` increments per document) so a reload is visible
 *  page-side, next to the `performance.timeOrigin` load token. */
function startCounterStub(): Promise<GuestStub> {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<!doctype html><html><head><title>${STUB_TITLE}</title>` +
        `<script>window.loads = (window.loads ?? 0) + 1;</script>` +
        `</head><body><p>popout guest</p></body></html>`,
    );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        server.close();
        reject(new Error("guest stub bind returned no port"));
        return;
      }
      resolve({
        server,
        port: addr.port,
        origin: `http://127.0.0.1:${addr.port}`,
        literalUrl: `http://127.0.0.1:${addr.port}/`,
      });
    });
  });
}

/** One shell window, read through Electron's own objects: its id, focus
 *  state, and contentView children bottom → top (array index IS z-order). */
interface WindowTree {
  windowId: number;
  focused: boolean;
  children: ViewNode[];
}

/** Every shell window's tree — the popout is a second BrowserWindow, so the
 *  single-window `viewTree` cannot see its children. */
function windowTrees(): Promise<WindowTree[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((win) => ({
      windowId: win.id,
      focused: win.isFocused(),
      children: win.contentView.children.map((view) => {
        const wc = "webContents" in view ? (view as Electron.WebContentsView).webContents : null;
        return {
          id: wc ? wc.id : null,
          url: wc ? wc.getURL() : "",
          visible: view.getVisible(),
          bounds: view.getBounds(),
        };
      }),
    })),
  );
}

/** Live shell-window count. */
function windowCount(): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

/** Clicks a control whose handler closes the window it lives in (the popout's
 *  Pop back in verb). The shell can destroy the window before Playwright's
 *  mouse-up dispatch returns, so the click may reject with "Target page,
 *  context or browser has been closed" although the app behaved correctly.
 *  That rejection is tolerated only once the page is actually closed; the
 *  close itself is awaited, so a verb that never closes the window still
 *  fails here. */
async function clickClosingControl(page: Page, control: Locator): Promise<void> {
  await Promise.all([
    page.waitForEvent("close", { timeout: READY_TIMEOUT }),
    control.click().catch((err: unknown) => {
      if (!page.isClosed()) throw err;
    }),
  ]);
}

/** The id of the window whose host view shows a `?pop=<leaf>` route, or
 *  null — the host view's URL carries the popout posture. */
async function popoutWindowId(leaf: string): Promise<number | null> {
  const marker = `pop=${leaf}`;
  const trees = await windowTrees();
  const found = trees.find((tree) => tree.children.some((c) => c.url.includes(marker)));
  return found?.windowId ?? null;
}

/** Poll until a window showing `?pop=<leaf>` exists; return its id. */
async function pollPopoutWindow(leaf: string): Promise<number> {
  let id: number | null = null;
  await expect
    .poll(
      async () => {
        id = await popoutWindowId(leaf);
        return id;
      },
      { timeout: READY_TIMEOUT },
    )
    .not.toBeNull();
  return id!;
}

/** Poll a window's focus state by id. */
async function pollFocused(windowId: number): Promise<boolean> {
  const trees = await windowTrees();
  return trees.find((tree) => tree.windowId === windowId)?.focused ?? false;
}

/** Where the stub's guest currently lives: the window whose contentView
 *  carries it, its webContents id, and its visibility. A mid-move guest is
 *  on NO window's tree (a parked entry the move has not re-attached yet) —
 *  null. */
interface GuestProbe {
  windowId: number;
  id: number;
  visible: boolean;
  bounds: ViewNode["bounds"];
}

async function guestProbe(): Promise<GuestProbe | null> {
  const trees = await windowTrees();
  for (const tree of trees) {
    const node = tree.children.find((c) => c.url.startsWith(stub.literalUrl));
    if (node && node.id !== null) {
      return {
        windowId: tree.windowId,
        id: node.id,
        visible: node.visible,
        bounds: node.bounds,
      };
    }
  }
  return null;
}

/** Poll until the guest is on some window's tree and satisfies `pred`. */
async function pollGuest(pred: (probe: GuestProbe) => boolean): Promise<GuestProbe> {
  let probe: GuestProbe | null = null;
  await expect
    .poll(
      async () => {
        probe = await guestProbe();
        return probe !== null && pred(probe);
      },
      { timeout: READY_TIMEOUT },
    )
    .toBe(true);
  return probe!;
}

/** The guest page's reload detectors, read main-side through the guest
 *  webContents — reachable while the guest is parked or mid-move, and null
 *  while no committed guest exists. */
interface GuestState {
  loads: number;
  timeOrigin: number;
  marker: string | null;
}

async function guestState(): Promise<GuestState | null> {
  return app.evaluate(async ({ webContents }, match) => {
    const target = webContents
      .getAllWebContents()
      .find((wc) => wc.getURL().startsWith(match));
    if (!target || target.isDestroyed()) return null;
    return target.executeJavaScript(
      "({ loads: window.loads ?? 0, timeOrigin: performance.timeOrigin, marker: window.marker ?? null })",
      true,
    );
  }, stub.literalUrl);
}

/** Poll until the guest document is committed and satisfies `pred`. */
async function pollGuestState(pred: (state: GuestState) => boolean): Promise<GuestState> {
  let state: GuestState | null = null;
  await expect
    .poll(
      async () => {
        state = await guestState();
        return state !== null && pred(state);
      },
      { timeout: READY_TIMEOUT },
    )
    .toBe(true);
  return state!;
}

/** Plant an in-page marker on the live guest document. */
async function setGuestMarker(marker: string): Promise<void> {
  await app.evaluate(
    async ({ webContents }, args) => {
      const target = webContents
        .getAllWebContents()
        .find((wc) => wc.getURL().startsWith(args.match));
      if (!target || target.isDestroyed()) throw new Error("guest webContents not found");
      await target.executeJavaScript(`window.marker = ${JSON.stringify(args.value)}`, true);
    },
    { match: stub.literalUrl, value: marker },
  );
}

/** Create a tmux window stamped with the stub as its active web tab and the
 *  `h(tty,web)` layout, navigate the host page to it, and wait for both
 *  tiles — Pop out is offered only at arity > 1. */
async function seedTtyWebWindow(name: string): Promise<string> {
  newWindow(TEST_SESSION, name);
  const found = listWindows(TEST_SESSION).find((w) => w.name === name);
  if (!found) throw new Error(`window "${name}" not found in ${TEST_SESSION}`);
  stampWebTab(found.windowId, `${stub.origin}/`);
  setWindowOption(found.windowId, "@rk_win_layout", "h(tty,web)");
  await hostPage.goto(
    `${hostOrigins().a}/${TMUX_SERVER}/${encodeURIComponent(found.windowId)}`,
  );
  await expect(hostPage.getByTestId("surface-tile-tty")).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(hostPage.getByTestId("surface-tile-web")).toBeVisible({ timeout: READY_TIMEOUT });
  return found.windowId;
}

/** The shell bridge on the host page, narrowed to the invoker this spec
 *  uses (the preload's exact argument shape). */
interface ShellBridge {
  windows: {
    popout: (payload: { route: string; width?: number; height?: number }) => Promise<unknown>;
  };
}

test.beforeAll(async () => {
  createSession(TEST_SESSION);
  stub = await startCounterStub();
});

test.afterAll(async () => {
  killSession(TEST_SESSION);
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
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

test.describe("surface popout in the desktop shell", () => {
  /**
   * Proves: clicking a tty tile's Pop out verb opens a SECOND shell window
   * on the same host showing the `?pop=tty` route chrome-less (no top bar,
   * sidebar, or status bar; the header carries Pop back in), titled
   * `Terminal · <window name>`, while the opener hides the popped tile and
   * reflows — and the popout's Pop back in verb closes the window and
   * returns the tile to the opener.
   * Steps:
   * 1. Seed a window (layout `h(tty,web)`, web tab stamped to the stub);
   *    navigate; both tiles render. Record the opener's window id.
   * 2. Click the tty tile's `Pop out Terminal`.
   * 3. Poll Electron: a second window exists whose host-view URL carries
   *    `pop=tty`; the window count is 2.
   * 4. Assert the popout page: the tty tile visible, no banner landmark /
   *    sessions nav / status bar, `Pop Terminal back in` visible, title
   *    `Terminal · <name>` (the popout page is chrome-less, so its readiness
   *    gate is the tile testid, never the status bar).
   * 5. Assert the opener reflowed: the tty tile hidden (still mounted — the
   *    hidden class is display:none), the web tile visible.
   * 6. Click the popout's `Pop Terminal back in` and await the popout page's
   *    close (clickClosingControl); poll the window count back
   *    to 1 and the opener's tty tile visible again (the `closed` channel
   *    message clears the mark; the 6s stale sweep is the backstop).
   */
  test("a tty tile pops out into a chrome-less second shell window and pops back in", async () => {
    test.setTimeout(60_000);
    const name = `dp-tty-${Date.now()}`;
    await seedTtyWebWindow(name);
    const openerId = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.id ?? null,
    );
    expect(openerId, "the cold-start shell window exists").not.toBeNull();

    await hostPage.getByTestId("surface-tile-tty").getByLabel("Pop out Terminal").click();

    const popWinId = await pollPopoutWindow("tty");
    expect(popWinId, "the popout is its own window, not a reuse of the opener").not.toBe(openerId);
    await expect.poll(windowCount, { timeout: READY_TIMEOUT }).toBe(2);
    const popPage = await findPage(app, (url) => url.includes("pop=tty"), READY_TIMEOUT);

    await expect(popPage.getByTestId("surface-tile-tty")).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(popPage.locator("[role='banner']")).toHaveCount(0);
    await expect(popPage.locator("nav[aria-label='Sessions']")).toHaveCount(0);
    await expect(popPage.getByTestId("status-bar")).toHaveCount(0);
    await expect(
      popPage.getByTestId("surface-tile-tty").getByLabel("Pop Terminal back in"),
    ).toBeVisible();
    await expect(popPage).toHaveTitle(`Terminal · ${name}`);

    await expect(hostPage.getByTestId("surface-tile-tty")).toBeHidden();
    await expect(hostPage.getByTestId("surface-tile-web")).toBeVisible();

    await clickClosingControl(popPage, popPage.getByTestId("surface-tile-tty").getByLabel("Pop Terminal back in"));
    await expect.poll(windowCount, { timeout: READY_TIMEOUT }).toBe(1);
    await expect(hostPage.getByTestId("surface-tile-tty")).toBeVisible({ timeout: READY_TIMEOUT });
  });

  /**
   * Proves: a repeat Pop out of an already-popped leaf does not open a
   * second popout window — the live popout of the same (host, route) is
   * focused instead, and the invoker resolves that same window id.
   * Steps:
   * 1. Seed + navigate; pop the tty tile out via the header verb; poll the
   *    second window and record its id.
   * 2. Focus the OPENER main-side (`BrowserWindow.focus()`), so the dedupe's
   *    focus move is observable.
   * 3. Pop the same leaf out again — SUBSTITUTION: the opener hides the
   *    popped tile, so the header verb is unreachable; the repeat goes
   *    through the same bridge channel the verb invokes
   *    (`window.runkitShell.windows.popout` with the verb's route
   *    `/<server>/<N>?pop=tty`).
   * 4. Assert the result is `{ ok: true, windowId: <the live popout's id> }`,
   *    the window count stays 2, and the popout window is focused.
   */
  test("a repeat pop-out of the same leaf focuses the existing popout instead of opening a second window", async () => {
    test.setTimeout(60_000);
    const windowId = await seedTtyWebWindow(`dp-dupe-${Date.now()}`);

    await hostPage.getByTestId("surface-tile-tty").getByLabel("Pop out Terminal").click();
    const popWinId = await pollPopoutWindow("tty");
    await expect.poll(windowCount, { timeout: READY_TIMEOUT }).toBe(2);
    const popPage = await findPage(app, (url) => url.includes("pop=tty"), READY_TIMEOUT);
    await expect(popPage.getByTestId("surface-tile-tty")).toBeVisible({ timeout: READY_TIMEOUT });

    const openerId =
      (await windowTrees()).find((tree) => tree.windowId !== popWinId)?.windowId ?? null;
    expect(openerId, "the opener window is still live").not.toBeNull();
    await app.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.fromId(id)?.focus();
    }, openerId);
    await expect.poll(() => pollFocused(openerId!), { timeout: READY_TIMEOUT }).toBe(true);

    const route = `/${TMUX_SERVER}/${windowId.slice(1)}?pop=tty`;
    const result = await hostPage.evaluate((r) => {
      const shell = (window as unknown as { runkitShell: ShellBridge }).runkitShell;
      return shell.windows.popout({ route: r });
    }, route);
    expect(result, "the repeat pop-out resolves the LIVE popout, not a new window").toEqual({
      ok: true,
      windowId: popWinId,
    });
    await expect.poll(windowCount, { timeout: READY_TIMEOUT }).toBe(2);
    await expect.poll(() => pollFocused(popWinId), { timeout: READY_TIMEOUT }).toBe(true);
  });

  /**
   * Proves: popping a web tile out MOVES its live guest into the popout
   * window — visible over the popout tile's rect, same webContents id, no
   * reload, in-page state intact (load counter, `performance.timeOrigin`, a
   * planted marker) — without the popout mounting a terminal or attaching a
   * tmux client of its own — and the popout's Pop back in verb returns it: the
   * opener's remounting tile adopts the same guest, visible again, state
   * intact.
   * Steps:
   * 1. Seed + navigate; poll the guest visible in the OPENER window; record
   *    its webContents id, load count, and timeOrigin; plant
   *    `window.marker`.
   * 2. Click the web tile's `Pop out Web`; poll the popout window
   *    (`pop=web`) and its tile.
   * 3. Poll the guest onto the POPOUT window's view tree, VISIBLE, with the
   *    SAME webContents id, and poll its live bounds against a fresh read of
   *    the popout placeholder's box until every field matches within 1 px
   *    (the engine re-measures on a ResizeObserver loop, so the guest
   *    converges onto the final layout; a one-shot read would race that
   *    settling). Poll its state: load count, timeOrigin, and marker all
   *    unchanged (a fresh guest would have a new id, a new timeOrigin,
   *    loads + 1, and no marker). Assert the opener's web tile is hidden —
   *    a popped web leaf unmounts in the opener, so its engine parks the
   *    guest for the popout's adopt.
   * 3a. Assert the popout mounted NO tty tile (a count — a hidden-mounted
   *    tile would pass a visibility check) and that no client is attached to
   *    the window's `_rk-iso-<N>` session on the rig server: a web popout
   *    attaches no terminal, so it cannot clamp the shared tmux window below
   *    the opener's terminal under `window-size smallest`.
   * 4. Click the popout's `Pop Web back in` and await the popout page's
   *    close (clickClosingControl); poll the window count back to
   *    1 and the opener's web tile visible again (the `closed` channel
   *    message clears the mark; the tile remounts).
   * 5. Poll the guest back onto the OPENER window's view tree, visible, with
   *    the same webContents id; poll its state unchanged once more — the
   *    remounting tile's `web:create` adopted the guest the closing popout
   *    returned to the opener's parked set. An adoption, not a reload.
   */
  test("a web tile's guest moves to the popout window and back with its JS state intact", async () => {
    test.setTimeout(60_000);
    const windowId = await seedTtyWebWindow(`dp-web-${Date.now()}`);
    const openerId = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.id ?? null,
    );
    expect(openerId, "the cold-start shell window exists").not.toBeNull();

    const before = await pollGuest((probe) => probe.visible);
    expect(before.windowId, "the guest starts attached to the opener window").toBe(openerId);
    const guestId = before.id;
    const stateBefore = await pollGuestState((state) => state.loads >= 1);
    const marker = `dp-marker-${Date.now()}`;
    await setGuestMarker(marker);

    await hostPage.getByTestId("surface-tile-web").getByLabel("Pop out Web").click();
    const popWinId = await pollPopoutWindow("web");
    const popPage = await findPage(app, (url) => url.includes("pop=web"), READY_TIMEOUT);
    await expect(popPage.getByTestId("surface-tile-web")).toBeVisible({ timeout: READY_TIMEOUT });

    const moved = await pollGuest((probe) => probe.windowId === popWinId && probe.visible);
    expect(moved.id, "the guest MOVED to the popout (same webContents — no re-create)").toBe(
      guestId,
    );
    await expect
      .poll(
        async () => {
          const probe = await guestProbe();
          const box = await popPage.getByTestId("web-native-placeholder").boundingBox();
          if (!probe || !box || probe.windowId !== popWinId || !probe.visible) return false;
          return (["x", "y", "width", "height"] as const).every(
            (field) => Math.abs(probe.bounds[field] - box[field]) <= BOUNDS_TOLERANCE_PX,
          );
        },
        { timeout: READY_TIMEOUT },
      )
      .toBe(true);
    await pollGuestState(
      (state) =>
        state.loads === stateBefore.loads &&
        state.timeOrigin === stateBefore.timeOrigin &&
        state.marker === marker,
    );
    await expect(hostPage.getByTestId("surface-tile-web")).toBeHidden();

    await expect(popPage.getByTestId("surface-tile-tty")).toHaveCount(0);
    const isoSession = `_rk-iso-${windowId.slice(1)}`;
    expect(
      listClients().filter((client) => client.session === isoSession),
      "a web popout attaches no isolated terminal client",
    ).toEqual([]);

    await clickClosingControl(popPage, popPage.getByTestId("surface-tile-web").getByLabel("Pop Web back in"));
    await expect.poll(windowCount, { timeout: READY_TIMEOUT }).toBe(1);
    await expect(hostPage.getByTestId("surface-tile-web")).toBeVisible({ timeout: READY_TIMEOUT });

    const returned = await pollGuest((probe) => probe.windowId === openerId && probe.visible);
    expect(returned.id, "the opener's remounting tile adopted the same guest back").toBe(guestId);
    await pollGuestState(
      (state) =>
        state.loads === stateBefore.loads &&
        state.timeOrigin === stateBefore.timeOrigin &&
        state.marker === marker,
    );
  });
});
