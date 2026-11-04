import { test, expect, type Page } from "@playwright/test";
import { isTerminalsSocket, pinWindow } from "./_boards";
import { READY_TIMEOUT, gotoServerReady, gotoWindow } from "./_ready";
import { TMUX_SERVER, createSession, killSession, listWindows } from "./_tmux";

// Connection-budget guard for the socket-unification effort.
//
// EVERY long-lived stream rides ONE of two muxed WebSockets: session-state +
// host-metrics ride `/ws/state`, and ALL terminal pane relays ride
// `/ws/terminals`. NO route holds an SSE anymore. This spec asserts the
// user-facing budget invariant across every route type (Host, Workspace,
// Terminal, Board): a tab holds AT MOST two rk WebSockets
// total — exactly one `/ws/state` plus (only on routes with live panes)
// exactly one `/ws/terminals` — and ZERO `text/event-stream` responses from rk
// endpoints (the Vite HMR WS is excluded by URL). An established WebSocket
// holds no HTTP/1.1 connection-pool slot, so this is what clears the pool
// starvation that blocked terminal-relay handshakes on Firefox/WebKit for
// plaintext origins.
//
// Shared setup: runs against the live isolated e2e backend (real tmux via
// `just test-e2e`). `beforeAll` creates one tmux session on `E2E_TMUX_SERVER`;
// `afterAll` kills it. Each test installs two counters on the page before
// navigating: `page.on("websocket")` counts LIVE sockets per class (opened −
// closed via each socket's `close` event — NOT a URL-keyed Set, which would
// dedupe two concurrent same-URL sockets to 1 and silently pass the budget,
// the exact shape a StrictMode double-mount leak or a reconnect-without-close
// bug would produce), and `page.on("response")` records any response whose
// `content-type` includes `text/event-stream` (the budget requires that list
// to be empty).

const TEST_SESSION = `e2e-connbudget-${Date.now()}`;

/** True for the state socket URL (`/ws/state`), excluding Vite HMR. */
function isStateSocket(url: string): boolean {
  return /\/ws\/state(\?|$)/.test(url);
}

/** Install WS + response counters on a page. Returns live accessors.
 *
 *  Sockets are counted as (opened − closed), NOT via a URL-keyed Set: neither
 *  `/ws/state` nor `/ws/terminals` carries a distinguishing query param, so a
 *  Set would dedupe two concurrent same-URL sockets to 1 and silently pass the
 *  budget guard — exactly the failure a StrictMode double-mount leak or a
 *  reconnect-without-close bug would produce. Counting live sockets makes a
 *  duplicate detectable. */
function installCounters(page: Page) {
  let stateOpened = 0;
  let stateClosed = 0;
  let terminalsOpened = 0;
  let terminalsClosed = 0;
  const eventStreamResponses: string[] = [];
  page.on("websocket", (ws) => {
    const url = ws.url();
    if (isStateSocket(url)) {
      stateOpened++;
      ws.on("close", () => stateClosed++);
    } else if (isTerminalsSocket(url)) {
      terminalsOpened++;
      ws.on("close", () => terminalsClosed++);
    }
  });
  page.on("response", (res) => {
    const ct = res.headers()["content-type"] ?? "";
    if (ct.includes("text/event-stream")) eventStreamResponses.push(res.url());
  });
  return {
    // Live (currently-open) sockets: opened minus closed.
    stateSocketCount: () => stateOpened - stateClosed,
    terminalsSocketCount: () => terminalsOpened - terminalsClosed,
    eventStreamUrls: () => eventStreamResponses,
  };
}

test.describe("Connection budget — 2 muxed WS (state + terminals), zero SSE", () => {
  test.beforeAll(() => {
    // A session so the board/terminal routes have real content.
    createSession(TEST_SESSION, { windows: ["cb-win"] });
  });

  test.afterAll(() => {
    killSession(TEST_SESSION);
  });

  /**
   * Proves: the bare Host home — which attaches zero tmux servers, subscribes
   * only to metrics, and renders no live pane — opens exactly one `/ws/state`
   * WebSocket, no `/ws/terminals` socket, and no SSE.
   *
   * Steps:
   * 1. Install the counters, `goto('/')`.
   * 2. Wait for the Host health region (readiness = the metrics subscription is
   *    live).
   * 3. Poll until the state-socket count is 1; assert the terminals-socket
   *    count is 0 and the `text/event-stream` response list is empty.
   */
  test("the Host home (/) holds one /ws/state WS, no terminals WS, and zero SSE", async ({ page }) => {
    test.setTimeout(30_000);
    const c = installCounters(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // Host health region is the readiness signal (metrics subscription acked).
    await expect(page.getByRole("region", { name: "Host health" })).toBeVisible({ timeout: 15_000 });
    // Give any stray SSE / extra socket a chance to appear before asserting.
    await expect.poll(() => c.stateSocketCount(), { timeout: 5_000 }).toBe(1);
    // The Host home has no live panes — no terminals socket.
    expect(c.terminalsSocketCount(), "no terminals WS on the Host home").toBe(0);
    expect(c.eventStreamUrls(), "no text/event-stream responses").toEqual([]);
  });

  /**
   * Proves: a single-server route subscribes to one server over the one state
   * socket and renders static session-tile previews (not live terminals), so it
   * opens no `/ws/terminals` socket and no SSE.
   *
   * Steps:
   * 1. Install the counters, `goto('/${TMUX_SERVER}')`.
   * 2. Wait for the status bar's Connected dot (the server subscription acked;
   *    the desktop sidebar footer is gone).
   * 3. Poll state-socket count === 1; assert terminals-socket count === 0 and
   *    no `text/event-stream` responses.
   */
  test("a Workspace route (/$server) holds one /ws/state WS, no terminals WS, and zero SSE", async ({ page }) => {
    test.setTimeout(30_000);
    const c = installCounters(page);
    await gotoServerReady(page, TMUX_SERVER);
    await expect.poll(() => c.stateSocketCount(), { timeout: 5_000 }).toBe(1);
    // The server overview renders session tiles (static capture-pane previews),
    // not live terminals — no terminals socket.
    expect(c.terminalsSocketCount(), "no terminals WS on the server overview").toBe(0);
    expect(c.eventStreamUrls(), "no text/event-stream responses").toEqual([]);
  });

  /**
   * Proves: the terminal route keeps state on the one state socket while its
   * terminal I/O rides the one terminals mux socket — exactly two rk WebSockets
   * total, and no SSE.
   *
   * Steps:
   * 1. Resolve the session's first window id via `tmux list-windows`.
   * 2. Install the counters, `goto('/${TMUX_SERVER}/${windowId}')`.
   * 3. Wait for the Connected dot; poll state-socket count === 1 AND
   *    terminals-socket count === 1; assert no `text/event-stream` responses.
   */
  test("a Terminal route (/$server/$window) holds exactly 2 WS (state + terminals) and zero SSE", async ({ page }) => {
    test.setTimeout(30_000);
    const c = installCounters(page);
    // Resolve the first window id of the test session.
    const windowId = listWindows(TEST_SESSION)[0]?.windowId.replace(/^@/, "");
    expect(windowId, "first window id").toBeTruthy();

    await gotoWindow(page, TMUX_SERVER, windowId!);
    // The terminal route opens the ONE terminals mux socket in addition to the
    // one state socket — exactly two rk WebSockets total.
    await expect.poll(() => c.stateSocketCount(), { timeout: 5_000 }).toBe(1);
    await expect.poll(() => c.terminalsSocketCount(), { timeout: 5_000 }).toBe(1);
    expect(c.eventStreamUrls(), "no text/event-stream responses").toEqual([]);
  });

  /**
   * Proves: the board route — historically the pool-starvation hotspot, because
   * it attaches every contributing tmux server AND held one relay socket per
   * pane — now subscribes to all servers over the SINGLE state socket AND muxes
   * every pane's terminal I/O over the SINGLE terminals socket, so the total is
   * still exactly two rk WebSockets regardless of pane count, with zero SSE.
   *
   * Steps:
   * 1. Pin the session's first window to a fresh board via
   *    `POST /api/boards/{name}/pin`.
   * 2. Install the counters, `goto('/board/${board}')`.
   * 3. Wait for the Connected dot; poll state-socket count === 1 AND
   *    terminals-socket count === 1; assert no `text/event-stream` responses.
   * 4. Unpin the window (cleanup), in a `finally`.
   */
  test("a Board route (/board/$name) holds exactly 2 WS (state + terminals) and zero SSE", async ({ page, request }) => {
    test.setTimeout(40_000);
    const board = `cb-board-${Date.now().toString().slice(-6)}`;
    // Pin the session's first window to a board so the board route has content.
    const windowId = listWindows(TEST_SESSION)[0]?.windowId;
    await pinWindow(request, board, TMUX_SERVER, windowId!);

    try {
      const c = installCounters(page);
      await page.goto(`/board/${board}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("status-bar").locator("[aria-label='Connected']").first()).toBeVisible({ timeout: READY_TIMEOUT });
      // The board attaches every contributing server's STATE over the SINGLE
      // state socket AND every live pane's terminal I/O over the SINGLE
      // terminals mux (this is the exact pool-starvation case the effort fixes)
      // — still exactly two rk WebSockets total, regardless of pane count.
      await expect.poll(() => c.stateSocketCount(), { timeout: 5_000 }).toBe(1);
      await expect.poll(() => c.terminalsSocketCount(), { timeout: 5_000 }).toBe(1);
      expect(c.eventStreamUrls(), "no text/event-stream responses").toEqual([]);
    } finally {
      // Best-effort cleanup — deliberately NOT ok-asserted: a throw from a
      // `finally` block would REPLACE the try-block's in-flight exception,
      // masking the socket-count diagnostic this test exists to surface.
      await request.post(`/api/boards/${board}/unpin`, {
        data: { server: TMUX_SERVER, windowId },
      });
    }
  });
});
