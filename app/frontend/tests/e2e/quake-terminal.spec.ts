import { test, expect, type Page } from "@playwright/test";
import { openPalette } from "./_ready";
import { mockStateSocket } from "./_state-socket-mock";

// Quake terminal — the pull-down operator chat overlay: the ⌘J two-state
// toggle (rest ⇄ open — docked-compose focus and drawer linked), the compose
// DOCKED at the drawer's bottom edge while open (the shared compose seam's
// one desktop view: status line, ◉ → operator header row + context chip +
// key hints, bounded auto-grow textarea; Enter sends once with focus
// retained, ⇧Enter newline, Esc yields to the embedded terminal first on the
// Operator Terminal segment and collapses on the list segments), the top-bar
// quake launcher as the standing affordance (standing box at ≥ lg, ghost at
// md–lg — at open BOTH collapse to the glyph + chord control whose click
// re-focuses the docked textarea; the page heading is never hidden), the ONE
// header row (segments + server/state/tick meta + pin + ▼), the pin
// (suspends only the outside-click collapse; ephemeral, reset at rest), the
// palette action + Ask-operator fallback row, operator-absent degradation,
// and inline send-error surfacing (the status line's one home is inside the
// strip). The drawer carries: the true slide (mounted-through-exit), mouse
// resize from every exposed edge (full bottom edge with the tongue tab, both
// sides, both bottom corners — independent edges, so a corner tracks the
// pointer and the drawer may rest off-center) with per-viewer geometry
// persistence (`{heightVh, widthPx, centerOffsetPx}`), the glass background
// (default α 0.95) + settings-dialog opacity row,
// the launcher ◉ live-state dot on every launcher rung, and drawer/launcher
// image paste (upload to the operator window's session + insert-delivery)
// with the route terminals' strip-forward guard. The drawer's
// Operator Terminal | Operator Tasks | Cron List | Cron Log segment strip
// swaps the body between the embedded terminal, the watched worker table, and
// the cron tabs (one relay stream max per drawer); the status-bar ◷ chip
// opens the drawer on Cron List; the operator window's own route IS the quake
// surface on desktop too (the operator page: the segment strip above the tty
// tile, the compose strip forced on and footer-docked, `?tab=` live as the
// page's segment state — the legacy `?tab=activity` token normalizes to
// `log`), so a desktop `?tab=` deep link lands on the page's segment with the
// param retained and openers on that route (⌘J, palette rows) focus the
// page's compose strip or switch its segment instead of opening a drawer;
// the drawer's `⤢ open as tab` header control navigates to that route. The
// operator-less body carries the Start operator button. The palette carries `Operator: Show tasks` plus `Operator: Show cron
// list` before `Operator: Show cron log`; the retired `Panel: Toggle Clock`
// and `Server: Clock dashboard` entries stay gone. The watched-worker specs
// seed the sessions payload with a `monitored: true` window carrying
// `monitoredChange`/`monitoredStage`/`monitoredRepo` plus `operatorLastTickAt`
// and `operatorTracked` on the sessions (the server-watched-zone spec's stub
// shape): `operatorTracked` is the whole tracked set the Operator Tasks
// segment lists — the @2 worker item (pane %2, windowId @2) and a pane-less
// n3 note item with refs/text.
// On MOBILE there is no
// sheet: every quake terminal entry point navigates to the operator window's
// ordinary terminal route (the tongue is the standing affordance, an
// operator-less server toasts the hint instead), the palette fallback's
// query lands as the route's compose-strip draft unsent, and the origin
// window rides `?from=` so the operator route's compose strip keeps the
// templated chat lane behind its dismissable context chip — with a subject
// attached, sends POST
// /api/windows/{subjectId}/operator-request {template:"user-message", text}
// instead of the direct /send lane (chip dismissed, or a subject-less route,
// keeps the direct lane).
//
// Shared setup: fully mocked (no tmux). The sessions payload rides the
// state-socket mock — a work window `@1` plus, when the test wants one, an
// operator window `@9` with `role: "operator"` in `_rk-operator` — and BOTH
// send endpoints (window send + window operator-request) are stubbed via
// page.route with recorded call lists. `GET /api/cron` is stubbed with one
// entry (carrying a `nextFire`, so the status bar's ◷ chip renders) and one
// delivery, so the drawer's Cron List / Cron Log segments each have a row.
// The route mocks carry a trailing `*` — the client appends `?server=`
// (withServer), so a bare glob would silently miss. `/ws/terminals`
// is a no-op socket mock: the quake terminal's embedded terminal mounts its xterm
// frame without needing stream data. Each spec lands on the `@1` terminal
// route (server "default") before driving the drawer, except the mobile
// specs, which run at 375px and gate arrivals on the terminal's
// `__rkTerminals` registration (not the desktop visible-text gate), the
// no-subject chip spec (the tmux Server route), and the md–lg spec,
// which runs at 900px (between the mobile rule and lg).
// Synthetic file pastes dispatch a real ClipboardEvent carrying a
// DataTransfer file (Chromium populates clipboardData from the init).

const SERVER = "default";
/** A second tmux server for the per-server draft spec; the state-socket
 *  mock's `sessions` fallback serves it the same operator payload. */
const OTHER_SERVER = "other";
const MOBILE_VIEWPORT = { width: 375, height: 812 };

const NOW = Math.floor(Date.now() / 1000);

function sessionsPayload(withOperator: boolean, operatorState = "idle", watched = false) {
  const work = {
    windowId: "@1",
    index: 0,
    name: "feature-work",
    worktreePath: "/tmp/wt",
    activity: "active",
    isActiveWindow: true,
    activityTimestamp: 0,
    agentState: "idle",
    panes: [
      { paneId: "%1", paneIndex: 0, cwd: "/tmp/wt", command: "zsh", isActive: true },
    ],
  };
  // A watched worker (the WATCHED zone / Operator Tasks row): the monitored
  // facets plus the operator tick stamps that mark the watchlist live. The
  // operatorTracked list is the whole tracked set the Operator Tasks segment
  // renders: the worker item for @2 plus a pane-less note item.
  const watchedWorker = {
    windowId: "@2",
    index: 1,
    name: "watched-worker",
    worktreePath: "/tmp/wt2",
    activity: "idle",
    isActiveWindow: false,
    activityTimestamp: 0,
    monitored: true,
    monitoredChange: "wuiu",
    monitoredStage: "review",
    monitoredRepo: "/home/user/code/run-kit",
    agentState: "waiting",
    agentIdleDuration: "6m",
    panes: [
      { paneId: "%2", paneIndex: 0, cwd: "/tmp/wt2", command: "claude", isActive: true },
    ],
  };
  const operatorTracked = [
    {
      id: "wuiu",
      kind: "fab-change",
      pane: "%2",
      windowId: "@2",
      repo: "/home/user/code/run-kit",
      stage: "review",
      updatedAt: NOW - 120,
    },
    {
      id: "n3",
      kind: "note",
      refs: ["bf1l"],
      text: "Daemon reliability plan — A=71yx PR #834 still open, awaiting user merge — archive once merged.",
      updatedAt: NOW - 3600,
    },
  ];
  return JSON.stringify([
    {
      name: "dev",
      ...(watched ? { operatorLastTickAt: NOW - 60, operatorTracked } : {}),
      windows: watched ? [work, watchedWorker] : [work],
    },
    ...(withOperator
      ? [
          {
            name: "_rk-operator",
            ...(watched ? { operatorLastTickAt: NOW - 60, operatorTracked } : {}),
            windows: [
              {
                windowId: "@9",
                index: 0,
                name: "operator",
                worktreePath: "/tmp/op",
                activity: "idle",
                isActiveWindow: false,
                activityTimestamp: 0,
                role: "operator",
                agentState: operatorState,
                panes: [
                  { paneId: "%9", paneIndex: 0, cwd: "/tmp/op", command: "claude", isActive: true },
                ],
              },
            ],
          },
        ]
      : []),
  ]);
}

type SendBehavior = { status: number; body: Record<string, unknown> };

const SEND_OK: SendBehavior = { status: 200, body: { ok: true } };

// The cron payload — one entry with a next fire (the status-bar ◷ chip reads
// it) and one delivery, so both cron segments of the drawer have a row.
const CRON = JSON.stringify({
  entries: [
    {
      id: "a3f9",
      name: "operator tick",
      schedule: { kind: "backoff", min: "60s", max: "30m" },
      target: { kind: "role", role: "operator" },
      payload: "tick",
      lastFired: NOW - 120,
      nextFire: NOW + 3600,
    },
  ],
  deliveries: [
    {
      ts: NOW - 120,
      entry: "a3f9",
      name: "operator tick",
      target: "%9",
      reason: "schedule",
      outcome: "delivered",
    },
  ],
});

/** Install the fully-mocked backend; returns the recorded send/request calls. */
async function mockBackend(
  page: Page,
  withOperator: boolean,
  behavior: SendBehavior = SEND_OK,
  operatorState = "idle",
  watched = false,
) {
  const sendBodies: Record<string, unknown>[] = [];
  const requestCalls: { url: string; body: Record<string, unknown> }[] = [];
  await page.routeWebSocket(/\/ws\/terminals/, () => {});
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
  // The window send seam — trailing `*` required (withServer appends
  // `?server=`).
  await page.route("**/api/windows/*/send*", (route) => {
    sendBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({
      status: behavior.status,
      contentType: "application/json",
      body: JSON.stringify(behavior.body),
    });
  });
  // The templated chat lane — same trailing-`*` rule.
  await page.route("**/api/windows/*/operator-request*", (route) => {
    requestCalls.push({
      url: route.request().url(),
      body: route.request().postDataJSON() as Record<string, unknown>,
    });
    return route.fulfill({
      status: behavior.status,
      contentType: "application/json",
      body: JSON.stringify(behavior.body),
    });
  });
  // The cron read seam — same trailing-`*` rule.
  await page.route("**/api/cron*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: CRON }),
  );
  await mockStateSocket(page, { sessions: sessionsPayload(withOperator, operatorState, watched) });
  return { sendBodies, requestCalls };
}

/** Stub the file-upload endpoint (multipart body — only the URL/session is
 *  asserted). Trailing `*` like the send mock. Returns the hit list. */
async function mockUploads(page: Page) {
  const uploads: { session: string; url: string }[] = [];
  await page.route("**/api/sessions/*/upload*", (route) => {
    const url = route.request().url();
    const session = decodeURIComponent(/\/api\/sessions\/([^/]+)\/upload/.exec(url)?.[1] ?? "");
    uploads.push({ session, url });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, path: "/tmp/op/.uploads/shot.png" }),
    });
  });
  return uploads;
}

/** Dispatch a real file-carrying paste event at the element matching
 *  `selector` (Chromium fills clipboardData from the event init). */
async function pasteImage(page: Page, selector: string) {
  await page.evaluate((sel) => {
    const target = document.querySelector(sel);
    if (!target) throw new Error(`paste target not found: ${sel}`);
    const dt = new DataTransfer();
    dt.items.add(new File(["fake-png"], "shot.png", { type: "image/png" }));
    target.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, selector);
}

const WINDOW_URL = `/${SERVER}/%401`;

async function gotoWindow(page: Page) {
  await page.goto(WINDOW_URL);
  await expect(page.getByText("feature-work").first()).toBeVisible({ timeout: 10_000 });
}

const drawer = (page: Page) => page.getByTestId("quake-terminal");
const composeInput = (page: Page) => page.getByTestId("quake-terminal-compose-input");
// The standing launcher's input exists only at rest — while the drawer is
// open the launcher is the collapsed glyph + chord control.
const launcherInput = (page: Page) => page.getByTestId("quake-launcher-input");

/** The operator window's route (what every mobile quake terminal entry point
 *  navigates to) — `/default/9` with the origin window carried in `?from=`. */
const OPERATOR_PATH = `/${SERVER}/9`;

function operatorUrl(from?: string) {
  const url = new URL(`http://localhost${OPERATOR_PATH}`);
  if (from) url.searchParams.set("from", from);
  return `${url.pathname}${url.search}`;
}

/** Assert the current URL is the operator route (optionally with `?from=`). */
async function expectOperatorRoute(page: Page, from?: string) {
  await expect(page).toHaveURL(operatorUrl(from), { timeout: 10_000 });
}

/** Mobile-pattern arrival: direct `goto` + a poll on the terminal's
 *  `__rkTerminals` registration (the mobile specs' gate — the desktop specs'
 *  visible-text gate is not the mobile idiom). */
async function gotoWindowMobile(page: Page, windowId = "@1") {
  await page.goto(`/${SERVER}/${encodeURIComponent(windowId)}`);
  await expect
    .poll(
      () =>
        page.evaluate(
          (wid) =>
            Boolean(
              (window as unknown as { __rkTerminals?: Record<string, unknown> }).__rkTerminals?.[wid],
            ),
          windowId,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
}

/** Open the desktop drawer from rest: one chord press focuses the docked
 *  compose textarea AND opens the drawer (the two-state toggle). */
async function openDrawerViaChord(page: Page) {
  await page.keyboard.press("Shift+Control+j");
  await expect(composeInput(page)).toBeFocused();
  await expect(drawer(page)).toBeVisible();
}

test.describe("Quake terminal", () => {
  /**
   * Proves: the quake terminal chord (⇧Ctrl+J on this host) is a two-state toggle
   * with docked-compose focus and the drawer linked — one press engages both
   * (drawer open, a peek, nothing sent, the docked textarea focused), the next
   * releases both — and a single Escape does the same release, all without
   * navigation. The drawer carries the docked compose strip and the ONE header
   * row (no `◉ OPERATOR` title strip).
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the @1 terminal route.
   * 2. Press Shift+Control+j; assert the docked compose input is focused AND
   *    the drawer is visible with the header row carrying the server name, an
   *    xterm frame inside, the compose strip present, and no `◉ OPERATOR`
   *    text.
   * 3. Press it again; assert the drawer is gone and the docked compose no
   *    longer holds focus (the standing launcher is back, unfocused).
   * 4. Re-open, then walk the Esc ladder: the first Escape yields focus to
   *    the embedded terminal (the drawer stays open), the second closes the
   *    drawer; the standing launcher is not focused, and the URL is unchanged
   *    throughout.
   */
  test("the chord toggles rest ⇄ open+focused and one Esc releases", async ({
    page,
  }) => {
    await mockBackend(page, true);
    await gotoWindow(page);

    await page.keyboard.press("Shift+Control+j");
    await expect(composeInput(page)).toBeFocused();
    await expect(drawer(page)).toBeVisible();
    await expect(drawer(page).getByTestId("quake-terminal-header")).toBeVisible();
    await expect(drawer(page).getByText("default", { exact: true })).toBeVisible();
    await expect(drawer(page).locator(".xterm")).toBeAttached({ timeout: 10_000 });
    // The docked compose IS the drawer's input — no separate Send button; the
    // standing launcher's input is collapsed away while open.
    await expect(drawer(page).getByTestId("quake-terminal-compose")).toBeVisible();
    await expect(drawer(page).getByRole("button", { name: "Send" })).toHaveCount(0);
    await expect(drawer(page).getByText("◉ OPERATOR")).toHaveCount(0);
    await expect(launcherInput(page)).toHaveCount(0);
    await expect(page.getByTestId("quake-launcher-collapsed")).toBeVisible();

    await page.keyboard.press("Shift+Control+j");
    await expect(drawer(page)).toHaveCount(0);
    await expect(launcherInput(page)).toBeVisible();
    await expect(launcherInput(page)).not.toBeFocused();

    await openDrawerViaChord(page);
    // The Esc ladder: the first Esc in the docked compose yields focus to the
    // embedded terminal (the drawer stays open); the second collapses.
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const el = document.activeElement;
          return (
            el?.classList.contains("xterm-helper-textarea") === true &&
            el.closest('[data-testid="quake-terminal"]') !== null
          );
        }),
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toHaveCount(0);
    await expect(launcherInput(page)).not.toBeFocused();
    expect(page.url()).toContain(WINDOW_URL);
  });

  /**
   * Proves: at ≥ lg the center cell carries the compact heading (the `Tab:`
   * prefix span hidden, the name click-to-rename and ▾ switcher untouched)
   * beside the STANDING launcher; clicking the launcher opens the drawer with
   * focus in the docked compose (the box collapses under the pointer by
   * design), and Enter on a typed message fires exactly
   * one send — on this terminal route the context chip is attached, so the
   * send rides the templated chat lane at the subject
   * window (no direct send fires) — with focus kept in the docked compose
   * textarea for follow-ups.
   *
   * Steps:
   * 1. Mock the backend with an operator window and 200 stubs; land on the
   *    terminal route.
   * 2. Assert the launcher is visible, the `Tab:` prefix is hidden, and the
   *    rename button + ▾ switcher still render.
   * 3. Click the launcher; assert the drawer opened with focus in the docked
   *    compose. Type a message and press Enter.
   * 4. Assert one recorded operator-request `{template: "user-message",
   *    text}` at @1 and no direct send, the drawer open, and the docked
   *    compose textarea focused with its draft cleared.
   */
  test("≥ lg: clicking the standing launcher opens the drawer; Enter from the docked compose sends", async ({ page }) => {
    const { sendBodies, requestCalls } = await mockBackend(page, true);
    await gotoWindow(page);

    await expect(launcherInput(page)).toBeVisible();
    await expect(page.getByText("Tab:", { exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "Rename tab feature-work" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Switch tab" })).toBeVisible();

    await launcherInput(page).click();
    await expect(drawer(page)).toBeVisible();
    await expect(composeInput(page)).toBeFocused();

    await composeInput(page).fill("restart the worker");
    await composeInput(page).press("Enter");

    await expect
      .poll(() => requestCalls.map((c) => ({ path: new URL(c.url).pathname, body: c.body })))
      .toEqual([
        {
          path: "/api/windows/%401/operator-request",
          body: { template: "user-message", text: "restart the worker" },
        },
      ]);
    expect(sendBodies).toEqual([]);
    await expect(drawer(page)).toBeVisible();
    await expect(composeInput(page)).toBeFocused();
    await expect(composeInput(page)).toHaveValue("");
  });

  /**
   * Proves: the compose YIELDS focus to a terminal pane. Clicking into the
   * ROUTE xterm while the drawer is open is an outside click: the drawer
   * collapses, focus lands on that terminal's helper textarea, and typed keys
   * land there, not in the compose draft — the compose neither re-acquires
   * focus nor keeps its engaged chrome. jsdom cannot prove this (its
   * synthetic focus events never move `document.activeElement`), which is
   * exactly how the self-restore regression reached users.
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the @1 terminal
   *    route and wait for the xterm frame.
   * 2. Click the standing launcher (opens the drawer, focus moves to the
   *    docked textarea) and type a partial draft; assert the docked textarea
   *    holds focus, the drawer is open, and the collapsed launcher renders
   *    engaged (accent border).
   * 3. Click the ROUTE terminal's xterm screen (outside the quake terminal's DOM —
   *    the drawer holds its own xterm, so the route one is addressed
   *    explicitly); assert the drawer collapses, `document.activeElement` is
   *    `.xterm-helper-textarea`, and the docked compose is gone with it.
   * 4. Type; assert the store draft is unchanged (the keys went to the pane,
   *    not the compose) — visible in the standing box, which shows the
   *    store-held draft at rest.
   * 5. Assert the launcher has stood down to its resting chrome (the standing
   *    box is back, the collapsed control is gone).
   */
  test("clicking into the terminal takes focus from the compose and keeps it", async ({ page }) => {
    await mockBackend(page, true);
    await gotoWindow(page);
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 10_000 });

    await launcherInput(page).click();
    await composeInput(page).fill("half-written");
    await expect(composeInput(page)).toBeFocused();
    await expect(drawer(page)).toBeVisible();
    await expect(page.getByTestId("quake-launcher-collapsed")).toHaveClass(/border-accent-green/);

    const routeXterm = page.locator('.xterm-screen:not([data-testid="quake-terminal"] *)');
    // The centered drawer overlays the route terminal's middle — click the
    // terminal's bottom-left corner, which the drawer never covers.
    const box = await routeXterm.boundingBox();
    await routeXterm.click({ position: { x: 10, y: (box?.height ?? 20) - 10 } });
    await expect(drawer(page)).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.classList.contains("xterm-helper-textarea"),
        ),
      )
      .toBe(true);

    await page.keyboard.type("ls -la");
    await expect(launcherInput(page)).toHaveValue("half-written");

    await expect(page.getByTestId("quake-launcher-collapsed")).toHaveCount(0);
    await expect(launcherInput(page)).toBeVisible();
    await expect(page.getByTestId("quake-terminal-context")).toBeHidden();
  });

  /**
   * Proves: the md–lg rung renders today's full heading (prefix included)
   * plus the dim `· ◉ ask` ghost; clicking the ghost opens the drawer and
   * swaps the ghost for the collapsed launcher control — the heading STAYS
   * (the machine never hides it) — and the Esc ladder (yield, then release)
   * closes the drawer and restores the ghost.
   *
   * Steps:
   * 1. Set a 900×720 viewport (between the mobile rule and lg); mock the
   *    backend with an operator window; land on the terminal route.
   * 2. Assert the ghost and the `Tab:` prefix are visible and the launcher
   *    input does not exist.
   * 3. Click the ghost; assert the drawer is open, the docked compose is
   *    focused, the collapsed control renders beside the STILL-visible
   *    heading, and no launcher input renders.
   * 4. Walk the Esc ladder — the first Escape yields focus to the embedded
   *    terminal, the second closes the drawer; assert the heading and ghost
   *    are back and the collapsed control is gone.
   */
  test("md–lg: the ghost opens the drawer beside the standing heading and Esc restores the ghost", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 720 });
    await mockBackend(page, true);
    await gotoWindow(page);

    const ghost = page.getByTestId("quake-launcher-ghost");
    await expect(ghost).toBeVisible();
    await expect(page.getByText("Tab:", { exact: true })).toBeVisible();
    await expect(launcherInput(page)).toBeHidden();

    await ghost.click();
    await expect(drawer(page)).toBeVisible();
    await expect(composeInput(page)).toBeFocused();
    await expect(page.getByTestId("quake-launcher-collapsed")).toBeVisible();
    await expect(launcherInput(page)).toHaveCount(0);
    // The heading never yields: prefix and rename button stay put at open.
    await expect(page.getByText("Tab:", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Rename tab feature-work" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(drawer(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toHaveCount(0);
    await expect(page.getByTestId("quake-launcher-collapsed")).toHaveCount(0);
    await expect(ghost).toBeVisible();
    await expect(page.getByRole("button", { name: "Rename tab feature-work" })).toBeVisible();
  });

  /**
   * Proves: the palette carries the `Operator: Open quake terminal` action (the
   * action registry of record), and selecting it lands on open+focused — the
   * drawer opens AND the docked compose textarea takes focus (the same linked
   * state the chord toggles into).
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the terminal route.
   * 2. Open the palette, filter to `Open quake terminal`, select the row (anchored
   *    name — the Ask-operator fallback row is the substring-collision class,
   *    and the option's accessible name carries the chord keycap).
   * 3. Assert the quake terminal is visible and the docked compose is focused.
   */
  test("palette action 'Operator: Open quake terminal' lands open+focused", async ({ page }) => {
    await mockBackend(page, true);
    await gotoWindow(page);

    const paletteInput = await openPalette(page);
    await paletteInput.fill("Open quake terminal");
    await page.getByRole("option", { name: /^Operator: Open quake terminal/ }).click();

    await expect(drawer(page)).toBeVisible();
    await expect(composeInput(page)).toBeFocused();
  });

  /**
   * Proves: the desktop drawer's Operator Terminal | Operator Tasks | Cron
   * List | Cron Log segment strip renders the four segments in that fixed
   * order (Operator Terminal the default), no label truncates, and selecting
   * a cron segment swaps the body — the cron tab mounts and the embedded
   * terminal unmounts (one relay stream max per drawer), until Operator
   * Terminal restores it.
   *
   * Steps:
   * 1. Mock the backend with an operator window (the cron stub gives both
   *    cron tabs a row); land on the @1 terminal route.
   * 2. Open the quake terminal via the palette `Operator: Open quake terminal` action;
   *    assert the four tab labels in exact order, Operator Terminal
   *    selected, no tab truncated (scrollWidth ≤ clientWidth), and the
   *    embedded terminal's xterm frame attached.
   * 3. Click Cron Log; assert the log body renders its delivery row inside
   *    the quake terminal and the xterm frame is gone.
   * 4. Click Cron List; assert the list body renders its entry row.
   * 5. Click Operator Terminal; assert the xterm frame is back.
   */
  test("the segment strip swaps the drawer body between the terminal and the cron tabs", async ({
    page,
  }) => {
    await mockBackend(page, true);
    await gotoWindow(page);

    const paletteInput = await openPalette(page);
    await paletteInput.fill("Open quake terminal");
    await page.getByRole("option", { name: /^Operator: Open quake terminal/ }).click();
    await expect(drawer(page)).toBeVisible();

    const tabs = drawer(page).getByTestId("terminal-activity-tabs");
    const buttons = tabs.getByRole("tab");
    await expect(buttons).toHaveCount(4);
    expect(await buttons.allTextContents()).toEqual([
      "Operator Terminal",
      "Operator Tasks",
      "Cron List",
      "Cron Log",
    ]);
    await expect(buttons.nth(0)).toHaveAttribute("aria-selected", "true");
    const noTruncation = await tabs.evaluate((el) =>
      Array.from(el.querySelectorAll('[role="tab"]')).every((b) => b.scrollWidth <= b.clientWidth),
    );
    expect(noTruncation).toBe(true);
    await expect(drawer(page).locator(".xterm")).toBeAttached({ timeout: 10_000 });

    await tabs.getByRole("tab", { name: "Cron Log" }).click();
    await expect(drawer(page).getByTestId("cron-log")).toBeVisible({ timeout: 10_000 });
    await expect(drawer(page).getByTestId("cron-delivery-row-a3f9")).toBeVisible();
    await expect(drawer(page).locator(".xterm")).toHaveCount(0);

    await tabs.getByRole("tab", { name: "Cron List" }).click();
    await expect(drawer(page).getByTestId("cron-list")).toBeVisible({ timeout: 10_000 });
    await expect(drawer(page).getByTestId("cron-list-row-a3f9")).toBeVisible();

    await tabs.getByRole("tab", { name: "Operator Terminal" }).click();
    await expect(drawer(page).locator(".xterm")).toBeAttached({ timeout: 10_000 });
  });

  /**
   * Proves: the status-bar ◷ chip (visually unchanged, next-fire readout)
   * opens the quake terminal drawer on its Cron List segment.
   *
   * Steps:
   * 1. Mock the backend with an operator window (the cron stub's entry
   *    carries a next fire, so the chip renders); land on the @1 terminal
   *    route.
   * 2. Click the ◷ chip.
   * 3. Assert the drawer is visible with the Cron List tab selected and the
   *    Cron List body rendering its entry row.
   */
  test("the ◷ chip opens the drawer on Cron List", async ({ page }) => {
    await mockBackend(page, true);
    await gotoWindow(page);

    const chip = page.getByTestId("status-bar-clock");
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await chip.click();

    await expect(drawer(page)).toBeVisible();
    const tabs = drawer(page).getByTestId("terminal-activity-tabs");
    await expect(tabs.getByRole("tab", { name: "Cron List" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(drawer(page).getByTestId("cron-list")).toBeVisible({ timeout: 10_000 });
    await expect(drawer(page).getByTestId("cron-list-row-a3f9")).toBeVisible();
  });

  /**
   * Proves: cron needs no operator — on a server WITHOUT an operator window
   * the ◷ chip still renders (its state is entries/staleness, never the
   * operator) and still opens the drawer on Cron List with the registry
   * rendering; the operator-less Start-operator body belongs to the Operator
   * Terminal segment only.
   *
   * Steps:
   * 1. Mock the backend WITHOUT an operator window (the cron stub's entry
   *    carries a next fire, so the chip renders); land on the @1 terminal
   *    route.
   * 2. Click the ◷ chip.
   * 3. Assert the drawer opens with Cron List selected, its entry row
   *    visible, and no operator-less body.
   * 4. Select Operator Terminal; assert the Start operator body appears.
   */
  test("the ◷ chip opens Cron List on an operator-less server", async ({ page }) => {
    await mockBackend(page, false);
    await gotoWindow(page);

    const chip = page.getByTestId("status-bar-clock");
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await chip.click();

    await expect(drawer(page)).toBeVisible();
    const tabs = drawer(page).getByTestId("terminal-activity-tabs");
    await expect(tabs.getByRole("tab", { name: "Cron List" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(drawer(page).getByTestId("cron-list")).toBeVisible({ timeout: 10_000 });
    await expect(drawer(page).getByTestId("cron-list-row-a3f9")).toBeVisible();
    await expect(drawer(page).getByTestId("quake-terminal-empty")).toHaveCount(0);

    await tabs.getByRole("tab", { name: "Operator Terminal" }).click();
    await expect(drawer(page).getByTestId("quake-terminal-start-operator")).toBeVisible();
    await expect(drawer(page).getByTestId("cron-list")).toHaveCount(0);
  });

  /**
   * Proves: the Cron List header row sorts the registry on click (a per-viewer
   * override over the at-rest soonest-first order), and the chosen order
   * survives a page reload via the `hexokit-table-cron-list` view state.
   *
   * Steps:
   * 1. Mock the backend with an operator window; override the cron stub with
   *    two entries whose label order opposes their next-fire order (`zulu`
   *    fires first, `alpha` second); land on the @1 terminal route.
   * 2. Open the drawer on Cron List; assert the at-rest order (zulu first).
   * 3. Click the `entry` header's sort button; assert the order flips to
   *    alpha-first and the header carries `aria-sort="ascending"`.
   * 4. Reload, reopen the drawer on Cron List; assert the alpha-first order
   *    persists.
   */
  test("Cron List header click re-sorts and the order survives a reload", async ({ page }) => {
    await mockBackend(page, true);
    // Two entries, label order ≠ next-fire order (the later Playwright route
    // registration shadows the shared stub).
    await page.route("**/api/cron*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          entries: [
            {
              id: "a-early",
              name: "zulu",
              schedule: { kind: "every", interval: "5m" },
              target: { kind: "role", role: "operator" },
              payload: "tick",
              lastFired: 0,
              nextFire: NOW + 60,
            },
            {
              id: "b-late",
              name: "alpha",
              schedule: { kind: "every", interval: "1h" },
              target: { kind: "role", role: "operator" },
              payload: "tick",
              lastFired: 0,
              nextFire: NOW + 7200,
            },
          ],
          deliveries: [],
        }),
      }),
    );
    await gotoWindow(page);

    const listRowOrder = () =>
      drawer(page)
        .getByTestId("cron-list")
        .evaluate((el) =>
          Array.from(el.querySelectorAll('[data-testid^="cron-list-row-"]')).map((r) =>
            r.getAttribute("data-testid"),
          ),
        );

    const paletteInput = await openPalette(page);
    await paletteInput.fill("Open quake terminal");
    await page.getByRole("option", { name: /^Operator: Open quake terminal/ }).click();
    await expect(drawer(page)).toBeVisible();
    await drawer(page).getByTestId("terminal-activity-tabs").getByRole("tab", { name: "Cron List" }).click();
    await expect(drawer(page).getByTestId("cron-list-row-a-early")).toBeVisible({ timeout: 10_000 });
    expect(await listRowOrder()).toEqual(["cron-list-row-a-early", "cron-list-row-b-late"]);

    await drawer(page).getByLabel("Sort by entry").click();
    await expect(drawer(page).getByLabel("Sort by entry")).toHaveAttribute("aria-pressed", "true");
    expect(await listRowOrder()).toEqual(["cron-list-row-b-late", "cron-list-row-a-early"]);

    await page.reload();
    await expect(page.getByText("feature-work").first()).toBeVisible({ timeout: 10_000 });
    const paletteInput2 = await openPalette(page);
    await paletteInput2.fill("Open quake terminal");
    await page.getByRole("option", { name: /^Operator: Open quake terminal/ }).click();
    await expect(drawer(page)).toBeVisible();
    await drawer(page).getByTestId("terminal-activity-tabs").getByRole("tab", { name: "Cron List" }).click();
    await expect(drawer(page).getByTestId("cron-list-row-a-early")).toBeVisible({ timeout: 10_000 });
    expect(await listRowOrder()).toEqual(["cron-list-row-b-late", "cron-list-row-a-early"]);
  });

  /**
   * Proves: the palette registers `Operator: Show cron list` BEFORE
   * `Operator: Show cron log` — the registry order a `cron` query shows.
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the terminal route.
   * 2. Open the palette and filter to `cron`.
   * 3. Assert both entries render and the cron-list row sits above the
   *    cron-log row in the option list.
   */
  test("palette lists 'Operator: Show cron list' above 'Operator: Show cron log'", async ({
    page,
  }) => {
    await mockBackend(page, true);
    await gotoWindow(page);

    const paletteInput = await openPalette(page);
    await paletteInput.fill("cron");

    const names = await page.getByRole("option").allTextContents();
    const listIndex = names.findIndex((n) => n.includes("Operator: Show cron list"));
    const logIndex = names.findIndex((n) => n.includes("Operator: Show cron log"));
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(logIndex).toBeGreaterThan(listIndex);
  });

  /**
   * Proves: the retired clock palette entries stay gone — a `clock` query
   * surfaces neither `Panel: Toggle Clock` nor `Server: Clock dashboard`.
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the terminal route.
   * 2. Open the palette and filter to `clock`.
   * 3. Assert no option matches either retired label.
   */
  test("the retired clock palette entries are absent", async ({ page }) => {
    await mockBackend(page, true);
    await gotoWindow(page);

    const paletteInput = await openPalette(page);
    await paletteInput.fill("clock");

    await expect(page.getByRole("option", { name: /Toggle Clock/ })).toHaveCount(0);
    await expect(page.getByRole("option", { name: /Clock dashboard/ })).toHaveCount(0);
  });

  /**
   * Proves: a desktop `?tab=activity` deep link (the legacy alias, normalized
   * to `log`) on the operator window's terminal route lands on the PAGE's
   * Cron Log segment — the operator route wears the quake surface on desktop
   * too, so no drawer opens and the `tab` param is retained (it IS the page's
   * segment state now; a reload lands the same way).
   *
   * Steps:
   * 1. Mock the backend with an operator window (the cron stub gives the log
   *    a row); navigate directly to the operator route carrying
   *    `?tab=activity`.
   * 2. Assert no drawer renders; the page's segment strip shows Cron Log
   *    selected and the cron log body is on the page.
   * 3. Assert the URL still carries the tab param.
   */
  test("desktop ?tab=activity deep link lands on the page's Cron Log segment with the param retained", async ({
    page,
  }) => {
    await mockBackend(page, true);
    await page.goto(`${OPERATOR_PATH}?tab=activity`);

    const tabs = page.getByTestId("terminal-activity-tabs");
    await expect(tabs.getByRole("tab", { name: "Cron Log" })).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 10_000 },
    );
    await expect(page.getByTestId("cron-log")).toBeVisible({ timeout: 10_000 });
    await expect(drawer(page)).toHaveCount(0);
    await expect(page).toHaveURL(/[?&]tab=(activity|log)/, { timeout: 10_000 });
  });

  /**
   * Proves: the desktop drawer's Operator Tasks segment lists the operator's
   * WHOLE tracked set — the monitored @2 worker as a navigating worker row
   * and the pane-less n3 note as an item row (kind chip, id, truncated text) —
   * with the `{N} tracked · {W} watched` summary matching the operator's own
   * count (the embedded terminal unmounted — one relay stream max per
   * drawer). Expanding the note reveals its full text without navigating or
   * collapsing the drawer; a worker row-name click navigates to that worker's
   * terminal route and collapses the drawer.
   *
   * Steps:
   * 1. Mock the backend with an operator window plus a monitored @2 worker
   *    (change/stage/repo facets, tick stamps) and a two-item operatorTracked
   *    list (the worker item + the n3 note); land on the @1 terminal route.
   * 2. Open the quake terminal via the palette `Operator: Show tasks` action.
   * 3. Assert the Operator Tasks tab is selected, the summary reads
   *    `2 tracked · 1 watched`, the table lists one worker row (change +
   *    stage) and one tracked-item row (note chip, id, truncated text), and
   *    no xterm frame is mounted.
   * 4. Click the note row's expand toggle; assert the full text is revealed
   *    while the URL and the open drawer are unchanged.
   * 5. Click the worker row's name button; assert the URL becomes the
   *    worker's terminal route and the drawer is gone.
   */
  test("the Operator Tasks segment lists every tracked item, expands notes in place, and a worker row click navigates and collapses the drawer", async ({
    page,
  }) => {
    await mockBackend(page, true, SEND_OK, "idle", true);
    await gotoWindow(page);

    const paletteInput = await openPalette(page);
    await paletteInput.fill("Show tasks");
    await page.getByRole("option", { name: /^Operator: Show tasks/ }).click();
    await expect(drawer(page)).toBeVisible();

    const tabs = drawer(page).getByTestId("terminal-activity-tabs");
    await expect(tabs.getByRole("tab", { name: "Operator Tasks" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const tasks = drawer(page).getByTestId("watched-tasks");
    await expect(tasks).toBeVisible();
    await expect(tasks.getByTestId("watched-tasks-summary")).toHaveText("2 tracked · 1 watched");
    await expect(tasks.getByTestId("watched-row")).toHaveCount(1);
    await expect(tasks.getByText("watched-worker")).toBeVisible();
    await expect(tasks.getByText("wuiu")).toBeVisible();
    await expect(tasks.getByText("review")).toBeVisible();
    const noteRow = tasks.getByTestId("tracked-item-row");
    await expect(noteRow).toHaveCount(1);
    await expect(noteRow.getByText("note")).toBeVisible();
    await expect(noteRow.getByText("n3")).toBeVisible();
    await expect(noteRow.getByTestId("tracked-item-expand")).toBeVisible();
    await expect(drawer(page).locator(".xterm")).toHaveCount(0);

    // Expanding the note is a per-row disclosure, not a navigation.
    const urlBefore = page.url();
    const expand = noteRow.getByTestId("tracked-item-expand");
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expand.click();
    await expect(noteRow.getByTestId("tracked-item-expand")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(
      noteRow.getByText(
        "Daemon reliability plan — A=71yx PR #834 still open, awaiting user merge — archive once merged.",
      ),
    ).toBeVisible();
    expect(page.url()).toBe(urlBefore);
    await expect(drawer(page)).toBeVisible();

    await tasks.getByTestId("watched-row-navigate").click();

    // The router serializes window @2 as the bare segment `2` (router-url.ts).
    await expect(page).toHaveURL(`/${SERVER}/2`, { timeout: 10_000 });
    await expect(drawer(page)).toHaveCount(0);
  });

  /**
   * Proves: a desktop `?tab=tasks` deep link on the operator window's terminal
   * route lands on the PAGE's Operator Tasks segment — the operator route
   * wears the quake surface on desktop too, so no drawer opens and the `tab`
   * param is retained (it IS the page's segment state now).
   *
   * Steps:
   * 1. Mock the backend with an operator window plus a monitored @2 worker;
   *    navigate directly to the operator route carrying `?tab=tasks`.
   * 2. Assert no drawer renders; the page's segment strip shows Operator Tasks
   *    selected and the watched table is on the page.
   * 3. Assert the URL still carries `?tab=tasks`.
   */
  test("desktop ?tab=tasks deep link lands on the page's Operator Tasks segment with the param retained", async ({
    page,
  }) => {
    await mockBackend(page, true, SEND_OK, "idle", true);
    await page.goto(`${OPERATOR_PATH}?tab=tasks`);

    const tabs = page.getByTestId("terminal-activity-tabs");
    await expect(tabs.getByRole("tab", { name: "Operator Tasks" })).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 10_000 },
    );
    await expect(page.getByTestId("watched-tasks")).toBeVisible({ timeout: 10_000 });
    await expect(drawer(page)).toHaveCount(0);
    await expect(page).toHaveURL(/[?&]tab=tasks/, { timeout: 10_000 });
  });

  /**
   * Proves: ⌘J on the desktop operator route focuses the page's compose
   * strip — the route IS the quake surface, so the chord never opens a
   * drawer over the operator's own terminal.
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the operator route
   *    and wait for the page's segment strip (the role has resolved).
   * 2. Press the quake terminal chord.
   * 3. Assert the route's compose-strip input holds focus and no drawer
   *    mounted.
   */
  test("the quake chord on the desktop operator route focuses the page's compose strip (no drawer)", async ({
    page,
  }) => {
    await mockBackend(page, true);
    await page.goto(OPERATOR_PATH);
    await expect(page.getByTestId("terminal-activity-tabs")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("compose-strip-input")).toBeVisible();

    await page.keyboard.press("Shift+Control+j");

    await expect(page.getByTestId("compose-strip-input")).toBeFocused();
    await expect(drawer(page)).toHaveCount(0);
  });

  /**
   * Proves: a segment-carrying palette entry (`Operator: Show cron list`) on
   * the desktop operator route switches the PAGE's segment in place — the
   * URL gains `?tab=list` and the cron list renders on the page; no drawer
   * opens.
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the operator route.
   * 2. Pick `Operator: Show cron list` from the palette.
   * 3. Assert the URL carries `?tab=list`, the page's strip shows Cron List
   *    selected, and no drawer mounted.
   */
  test("Operator: Show cron list on the desktop operator route switches the page to ?tab=list", async ({
    page,
  }) => {
    await mockBackend(page, true);
    await page.goto(OPERATOR_PATH);
    await expect(page.getByTestId("terminal-activity-tabs")).toBeVisible({ timeout: 10_000 });

    const paletteInput = await openPalette(page);
    await paletteInput.fill("Show cron list");
    await page.getByRole("option", { name: /^Operator: Show cron list/ }).click();

    await expect(page).toHaveURL(/[?&]tab=list/, { timeout: 10_000 });
    const tabs = page.getByTestId("terminal-activity-tabs");
    await expect(tabs.getByRole("tab", { name: "Cron List" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByTestId("cron-list")).toBeVisible();
    await expect(drawer(page)).toHaveCount(0);
  });

  /**
   * Proves: the drawer's `⤢ open as tab` header control navigates from a
   * non-operator route to the operator window's own route, carrying the
   * drawer's current segment as `?tab=`, and rests the machine (the drawer
   * unmounts).
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the @1 terminal
   *    route and open the drawer on the Cron List segment via the palette.
   * 2. Click `⤢ open as tab` in the drawer header.
   * 3. Assert the URL is the operator route with `?tab=list`, the page's
   *    strip shows Cron List selected, and the drawer is gone.
   */
  test("⤢ open as tab navigates from the drawer to the operator route carrying the segment", async ({
    page,
  }) => {
    await mockBackend(page, true);
    await gotoWindow(page);

    const paletteInput = await openPalette(page);
    await paletteInput.fill("Show cron list");
    await page.getByRole("option", { name: /^Operator: Show cron list/ }).click();
    await expect(drawer(page)).toBeVisible();

    await page.getByTestId("quake-terminal-open-as-tab").click();

    await expect(page).toHaveURL(/\/default\/9\?tab=list/, { timeout: 10_000 });
    const tabs = page.getByTestId("terminal-activity-tabs");
    await expect(tabs.getByRole("tab", { name: "Cron List" })).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 10_000 },
    );
    await expect(drawer(page)).toHaveCount(0);
  });

  /**
   * Proves: the palette free-text fallback — a query matching no action on an
   * operator-bearing server renders the `Ask operator: "{query}"` row, and
   * Enter on it closes the palette, opens the quake terminal, and fires exactly one
   * send through the SAME lane resolution as a typed message: on this terminal
   * route (chip attached by default) that is one POST to the window-scoped
   * operator-request route at the subject window @1 with
   * `{template: "user-message", text: query}` — no direct `send` POST fires.
   *
   * Steps:
   * 1. Mock the backend with an operator window and 200 stubs; land on the
   *    terminal route.
   * 2. Open the palette and type a query matching no action.
   * 3. Assert the fallback row renders and the "No results" line does not.
   * 4. Press Enter; assert the palette closed, the quake terminal opened, and the
   *    recorded operator-request call targets @1 with the user-message
   *    template while the direct-send list stays empty.
   */
  test("palette fallback row opens the quake terminal and sends the query on the templated chat lane", async ({
    page,
  }) => {
    const { sendBodies, requestCalls } = await mockBackend(page, true);
    await gotoWindow(page);

    const paletteInput = await openPalette(page);
    await paletteInput.fill("the fence deploy is wedged");
    await expect(
      page.getByRole("option", { name: 'Ask operator: "the fence deploy is wedged"' }),
    ).toBeVisible();
    await expect(page.getByText(/^No results/)).toHaveCount(0);

    await paletteInput.press("Enter");
    await expect(paletteInput).toHaveCount(0);
    await expect(drawer(page)).toBeVisible();
    await expect
      .poll(() => requestCalls.map((c) => ({ path: new URL(c.url).pathname, body: c.body })))
      .toEqual([
        {
          path: "/api/windows/%401/operator-request",
          body: { template: "user-message", text: "the fence deploy is wedged" },
        },
      ]);
    expect(sendBodies).toEqual([]);
  });

  /**
   * Proves: the fallback row's length floor — a 2-character query matching no
   * action renders no `Ask operator` row (typo fragments never fire a send).
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the terminal route.
   * 2. Open the palette and type a 2-character query matching no action.
   * 3. Assert no `Ask operator` row renders.
   */
  test("the fallback row is absent below the 3-character query floor", async ({ page }) => {
    await mockBackend(page, true);
    await gotoWindow(page);

    const paletteInput = await openPalette(page);
    await paletteInput.fill("zq");
    await expect(page.getByRole("option", { name: /^Ask operator:/ })).toHaveCount(0);
  });

  /**
   * Proves: degrade-to-absent — with no `role: "operator"` window on the
   * server, the quake terminal opens to the operator-less body (the Start
   * operator button over the hint line; no terminal stream) and the palette
   * renders no fallback row. The docked compose
   * renders (it is the drawer's chrome while open) but with no operator there
   * is no draft to address: the textarea is read-only with a Start-operator
   * placeholder, still focusable, and Enter is a guarded no-op — the hint line
   * is the answer.
   *
   * Steps:
   * 1. Mock the backend WITHOUT an operator window; land on the terminal
   *    route.
   * 2. Focus the standing launcher (read-only, but focus still opens the
   *    machine) to open the quake terminal; assert the Start operator button,
   *    the hint sub-line, and no xterm inside the quake terminal.
   * 3. Assert the docked compose is read-only with the Start-operator
   *    placeholder; focus it and press Enter; assert no send fired on either
   *    lane.
   * 4. Close with Escape (one press — no embedded terminal means no yield
   *    rung), open the palette, type a
   *    floor-length query matching no action; assert no `Ask operator` row.
   */
  test("no operator on the server renders the hint line and omits the fallback row", async ({
    page,
  }) => {
    const { sendBodies, requestCalls } = await mockBackend(page, false);
    await gotoWindow(page);

    await expect(launcherInput(page)).toHaveAttribute("readonly", "");
    await launcherInput(page).click();
    await expect(drawer(page)).toBeVisible();
    const empty = page.getByTestId("quake-terminal-empty");
    await expect(empty.getByTestId("quake-terminal-start-operator")).toBeVisible();
    await expect(empty).toContainText("no operator on this server — run rk operator");
    await expect(drawer(page).locator(".xterm")).toHaveCount(0);

    await expect(composeInput(page)).toHaveAttribute("readonly", "");
    await expect(composeInput(page)).toHaveAttribute("placeholder", "Start the operator to compose…");
    await composeInput(page).focus();
    await composeInput(page).press("Enter");
    await expect.poll(() => sendBodies).toEqual([]);
    expect(requestCalls).toEqual([]);

    // With no embedded terminal mounted the yield rung has nothing to yield
    // to: one Escape collapses.
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toHaveCount(0);
    const paletteInput = await openPalette(page);
    await paletteInput.fill("the fence deploy is wedged");
    await expect(page.getByRole("option", { name: /^Ask operator:/ })).toHaveCount(0);
  });

  /**
   * Proves: the quake compose draft is scoped to the tmux server — it is keyed
   * by the operator window it addresses, so text typed in the drawer on one
   * server never appears in another server's drawer, and it is still there
   * (persisted across the full page load) when the user comes back.
   *
   * Steps:
   * 1. Mock the backend with an operator window, then override `/api/servers`
   *    with TWO servers (`default` and `other`); the state-socket mock's
   *    fallback serves the same operator payload for both keys.
   * 2. Land on `default`'s terminal route, open the drawer via the chord, type
   *    into the docked compose.
   * 3. Load `other`'s terminal route, open the drawer; assert the docked
   *    compose is empty and editable (an operator resolves there too).
   * 4. Load `default`'s terminal route again, open the drawer; assert the
   *    typed text is back.
   */
  test("the docked draft is per tmux server — another server's drawer is empty and the text returns", async ({
    page,
  }) => {
    await mockBackend(page, true);
    // Registered after mockBackend's single-server stub, so this handler wins.
    await page.route("**/api/servers", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { name: SERVER, sessionCount: 1 },
          { name: OTHER_SERVER, sessionCount: 1 },
        ]),
      }),
    );
    await gotoWindow(page);
    await openDrawerViaChord(page);
    await composeInput(page).fill("for default");
    await expect(composeInput(page)).toHaveValue("for default");

    await page.goto(`/${OTHER_SERVER}/%401`);
    await expect(page.getByText("feature-work").first()).toBeVisible({ timeout: 10_000 });
    await openDrawerViaChord(page);
    await expect(composeInput(page)).toHaveValue("");
    await expect(composeInput(page)).not.toHaveAttribute("readonly");

    await gotoWindow(page);
    await openDrawerViaChord(page);
    await expect(composeInput(page)).toHaveValue("for default");
  });

  /**
   * Proves: a structured send failure (409 from the injection engine)
   * surfaces inline inside the docked compose strip (the status line's one
   * home) with the composed text preserved in the draft.
   *
   * Steps:
   * 1. Mock the backend with an operator window and a 409 stub (both send
   *    lanes) carrying the probe-failure message; land on the terminal route.
   * 2. Open the drawer via the chord and type a message into the docked
   *    compose; press Enter.
   * 3. Assert the templated lane fired once (the chip is attached on this
   *    route), the strip's error line carries the server's message, and the
   *    docked textarea still holds the text.
   */
  test("a structured 409 send failure surfaces inline with the composed text preserved", async ({
    page,
  }) => {
    const { requestCalls } = await mockBackend(page, true, {
      status: 409,
      body: { error: "probe failed: no novelty echo" },
    });
    await gotoWindow(page);

    await openDrawerViaChord(page);
    await composeInput(page).fill("restart the worker");
    await composeInput(page).press("Enter");

    await expect.poll(() => requestCalls).toHaveLength(1);
    await expect(drawer(page)).toBeVisible();
    const error = page.getByTestId("quake-terminal-error");
    await expect(error).toHaveText("probe failed: no novelty echo");
    await expect(drawer(page).getByTestId("quake-terminal-compose")).toContainText(
      "probe failed: no novelty echo",
    );
    await expect(composeInput(page)).toHaveValue("restart the worker");
  });

  /**
   * Proves: on a terminal route the docked compose strip shows the attached
   * context chip naming the route window (`from: @1 "feature-work"`), and
   * Enter fires exactly one POST to the window-scoped operator-request route
   * at the SUBJECT window @1 with `{template: "user-message", text}` — the
   * direct send lane (at the operator window @9) is not called.
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the @1 terminal
   *    route.
   * 2. Open the drawer via the chord; assert the chip appears in the strip
   *    naming @1 "feature-work".
   * 3. Type a message into the docked textarea and press Enter.
   * 4. Assert exactly one operator-request call whose path is
   *    `/api/windows/%401/operator-request` with the user-message body, an
   *    empty direct-send list, and the cleared draft.
   */
  test("terminal route: the context chip rides the send onto the templated chat lane", async ({
    page,
  }) => {
    const { sendBodies, requestCalls } = await mockBackend(page, true);
    await gotoWindow(page);

    await openDrawerViaChord(page);
    const strip = drawer(page).getByTestId("quake-terminal-compose");
    await expect(strip.getByTestId("quake-terminal-context")).toContainText(
      'from: @1 "feature-work"',
    );

    await composeInput(page).fill("can you check the failing test?");
    await composeInput(page).press("Enter");

    await expect
      .poll(() => requestCalls.map((c) => ({ path: new URL(c.url).pathname, body: c.body })))
      .toEqual([
        {
          path: "/api/windows/%401/operator-request",
          body: { template: "user-message", text: "can you check the failing test?" },
        },
      ]);
    expect(sendBodies).toEqual([]);
    await expect(composeInput(page)).toHaveValue("");
  });

  /**
   * Proves: dismissing the context chip (✕) drops the envelope — the next
   * send rides the direct lane byte-identically (POST
   * /api/windows/{operatorId}/send with `{text, mode: "submit",
   * target: "agent"}`), and no operator-request fires.
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the @1 terminal
   *    route.
   * 2. Open the drawer via the chord; dismiss the strip's chip via its ✕
   *    button and assert it disappears.
   * 3. Type a message into the docked textarea and press Enter.
   * 4. Assert exactly one direct-send call at @9 with the agent-target body
   *    and an empty operator-request list.
   */
  test("dismissing the chip returns sends to the direct lane", async ({ page }) => {
    const { sendBodies, requestCalls } = await mockBackend(page, true);
    await gotoWindow(page);

    await openDrawerViaChord(page);
    await page.getByRole("button", { name: "Detach window context" }).click();
    await expect(page.getByTestId("quake-terminal-context")).toHaveCount(0);

    await composeInput(page).fill("plain message");
    await composeInput(page).press("Enter");

    await expect.poll(() => sendBodies).toEqual([
      { text: "plain message", mode: "submit", target: "agent" },
    ]);
    expect(requestCalls).toEqual([]);
  });

  /**
   * Proves: on a route with no subject window (the tmux Server route) the
   * chip does not render and sends ride the direct lane unchanged.
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the server route
   *    (`/default`).
   * 2. Open the drawer via the chord; assert no chip renders in the strip.
   * 3. Type a message into the docked textarea and press Enter.
   * 4. Assert exactly one direct-send call at @9 and an empty
   *    operator-request list.
   */
  test("server route: no subject window, no chip, sends ride the direct lane", async ({ page }) => {
    const { sendBodies, requestCalls } = await mockBackend(page, true);
    await page.goto(`/${SERVER}`);
    await expect(page.getByText("feature-work").first()).toBeVisible({ timeout: 10_000 });

    await openDrawerViaChord(page);
    await expect(page.getByTestId("quake-terminal-context")).toHaveCount(0);

    await composeInput(page).fill("hello from the server page");
    await composeInput(page).press("Enter");

    await expect.poll(() => sendBodies).toEqual([
      { text: "hello from the server page", mode: "submit", target: "agent" },
    ]);
    expect(requestCalls).toEqual([]);
  });

  /**
   * Proves: Enter in the docked compose fires exactly one send (the templated
   * lane on this terminal route — the chip is attached by default), clears
   * the draft, and keeps focus in the textarea for follow-ups; the drawer
   * stays open.
   *
   * Steps:
   * 1. Mock the backend with an operator window and 200 stubs; land on the
   *    terminal route and open the drawer via the chord.
   * 2. Type a message into the docked textarea and press Enter.
   * 3. Assert exactly one operator-request call with the user-message body,
   *    no direct send, the cleared draft, focus still in the textarea, and
   *    the drawer still open.
   */
  test("Enter from the docked compose sends exactly once with focus retained", async ({ page }) => {
    const { sendBodies, requestCalls } = await mockBackend(page, true);
    await gotoWindow(page);

    await openDrawerViaChord(page);
    await composeInput(page).fill("Is peui done?");
    await composeInput(page).press("Enter");

    await expect.poll(() => requestCalls).toHaveLength(1);
    expect(sendBodies).toEqual([]);
    await expect(composeInput(page)).toHaveValue("");
    await expect(composeInput(page)).toBeFocused();
    await expect(drawer(page)).toBeVisible();
  });

  /**
   * Proves: the pin suspends only the outside-click collapse — unpinned, a
   * click into the page below collapses the drawer; pinned, the same click
   * leaves the drawer open and focus lands where the click landed; the chord
   * still collapses a pinned drawer, and the next open starts unpinned.
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the terminal route
   *    and open the drawer via the chord.
   * 2. Click the route terminal (outside the quake terminal's DOM); assert
   *    the drawer collapses.
   * 3. Re-open, click the pin; click the route terminal again; assert the
   *    drawer stays open and the route xterm owns focus.
   * 4. Click the collapsed launcher (focus returns to the compose), then press
   *    the chord; assert the drawer collapses. Re-open; assert the pin
   *    is off (`aria-pressed="false"`).
   */
  test("an outside click collapses the drawer unpinned and holds it pinned", async ({ page }) => {
    await mockBackend(page, true);
    await gotoWindow(page);
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 10_000 });
    const routeXterm = page.locator('.xterm-screen:not([data-testid="quake-terminal"] *)');
    const clickRouteTerminal = async () => {
      const box = await routeXterm.boundingBox();
      await routeXterm.click({ position: { x: 10, y: (box?.height ?? 20) - 10 } });
    };

    await openDrawerViaChord(page);
    await clickRouteTerminal();
    await expect(drawer(page)).toHaveCount(0);

    await openDrawerViaChord(page);
    const pin = drawer(page).getByTestId("quake-terminal-pin");
    await pin.click();
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await clickRouteTerminal();
    await expect(drawer(page)).toBeVisible();
    // The click owns its interaction: focus is the route terminal, not the
    // compose.
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.activeElement?.classList.contains("xterm-helper-textarea"),
        ),
      )
      .toBe(true);

    // Back inside the quake terminal (the collapsed launcher re-focuses the
    // compose), the chord still collapses a pinned drawer.
    await page.getByTestId("quake-launcher-collapsed").click();
    await expect(composeInput(page)).toBeFocused();
    await page.keyboard.press("Shift+Control+j");
    await expect(drawer(page)).toHaveCount(0);

    // Every open starts unpinned.
    await openDrawerViaChord(page);
    await expect(drawer(page).getByTestId("quake-terminal-pin")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  /**
   * Proves: selecting the palette's `Operator: Pin quake terminal` entry with
   * the MOUSE pins the still-open drawer — the palette closes around the same
   * click, and the drawer's pending outside-click settle must back off (the
   * action re-asserts the open machine state, bumping its activity) instead
   * of collapsing the drawer and eating the pin.
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the terminal route
   *    and open the drawer via the chord.
   * 2. Open the palette, filter to `Pin quake terminal`, and click the option
   *    with the mouse (the anchored name sidesteps the Ask-operator fallback
   *    row's substring collision).
   * 3. Assert the drawer is still open and the header pin reads pressed; then
   *    click the route terminal and assert the now-pinned drawer holds.
   */
  test("mouse-selecting the palette pin entry pins the still-open drawer", async ({ page }) => {
    await mockBackend(page, true);
    await gotoWindow(page);
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 10_000 });

    await openDrawerViaChord(page);
    const paletteInput = await openPalette(page);
    await paletteInput.fill("Pin quake terminal");
    await page.getByRole("option", { name: /^Operator: Pin quake terminal/ }).click();

    await expect(drawer(page)).toBeVisible();
    await expect(drawer(page).getByTestId("quake-terminal-pin")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const routeXterm = page.locator('.xterm-screen:not([data-testid="quake-terminal"] *)');
    const box = await routeXterm.boundingBox();
    await routeXterm.click({ position: { x: 10, y: (box?.height ?? 20) - 10 } });
    await expect(drawer(page)).toBeVisible();
  });

  /**
   * Proves: at ≥ lg the `PageType: name` heading is never hidden by the
   * machine — the rename button stays visible beside the collapsed launcher
   * while the drawer is open (the `Tab:` prefix stays compacted exactly as at
   * rest).
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the terminal route.
   * 2. Open the drawer via the chord.
   * 3. Assert the rename button and ▾ switcher are visible, the collapsed
   *    launcher renders, and the `Tab:` prefix is hidden as at rest.
   */
  test("≥ lg: the heading stays visible while the drawer is open", async ({ page }) => {
    await mockBackend(page, true);
    await gotoWindow(page);

    await openDrawerViaChord(page);
    await expect(page.getByTestId("quake-launcher-collapsed")).toBeVisible();
    await expect(page.getByRole("button", { name: "Rename tab feature-work" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Switch tab" })).toBeVisible();
    await expect(page.getByText("Tab:", { exact: true })).toBeHidden();
  });

  /**
   * Proves: the collapsed launcher is the re-focus path back to the compose —
   * with the drawer open and focus in the embedded terminal, clicking the
   * collapsed control moves focus to the docked textarea and the machine
   * stays open. The control is quake-owned DOM, so its click never reads as
   * an outside click: the drawer is still open and the compose still focused
   * past the outside-click settle window.
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the terminal route
   *    and open the drawer via the chord.
   * 2. Click the drawer's embedded terminal (inside the quake terminal's DOM —
   *    no collapse); assert focus left the compose.
   * 3. Click the collapsed launcher; assert the docked textarea is focused
   *    and the drawer is still open.
   * 4. Wait past the settle window; assert the drawer is STILL visible and
   *    the textarea still focused (no deferred outside-click collapse).
   */
  test("the collapsed launcher re-focuses the docked compose and holds the drawer open", async ({
    page,
  }) => {
    await mockBackend(page, true);
    await gotoWindow(page);

    await openDrawerViaChord(page);
    await drawer(page).locator(".xterm-screen").click({ position: { x: 10, y: 10 } });
    await expect(composeInput(page)).not.toBeFocused();
    await expect(drawer(page)).toBeVisible();

    await page.getByTestId("quake-launcher-collapsed").click();
    await expect(composeInput(page)).toBeFocused();
    await expect(drawer(page)).toBeVisible();

    // Past the settle window: the click must never collapse the drawer.
    await page.waitForTimeout(250);
    await expect(drawer(page)).toBeVisible();
    await expect(composeInput(page)).toBeFocused();
  });

  test.describe("slide animation", () => {
    // The rig emulates reducedMotion:"reduce" globally — the slide semantics
    // need real motion (the window-switch-transition.spec.ts opt-out).
    test.use({ contextOptions: { reducedMotion: "no-preference" } });

    /**
     * Proves: the desktop drawer is a true quake slide — it carries the slide
     * class and settles out of the raised pose on open, and on Esc it stays
     * MOUNTED with the raised class while the exit slide runs (the stream
     * tears down after the slide, not mid-animation), then unmounts. The
     * first Esc is the ladder's yield rung (focus in the docked compose moves
     * to the embedded terminal); the second starts the exit.
     *
     * Steps:
     * 1. Mock the backend with an operator window; land on the terminal route.
     * 2. Open via the chord cycle; assert the slide class
     *    and wait out the raised (entering) pose.
     * 3. Press Escape twice (yield rung, then release); assert the drawer is
     *    still attached WITH the raised
     *    class (mid-exit-slide), then detaches.
     */
    test("the desktop drawer slides in and stays mounted through the exit slide", async ({
      page,
    }) => {
      await mockBackend(page, true);
      await gotoWindow(page);

      await openDrawerViaChord(page);
      const el = drawer(page);
      await expect(el).toBeVisible();
      await expect(el).toHaveClass(/rk-quake-slide/);
      await expect(el).not.toHaveClass(/rk-quake-closed/);

      await page.keyboard.press("Escape");
      await expect(el).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(el).toHaveClass(/rk-quake-closed/);
      await expect(el).toHaveCount(0);
    });
  });
  /**
   * Proves: the full-width bottom grip drags the drawer's height (clamped at
   * 85vh), the new geometry persists to `hexokit-quake-terminal-geometry`,
   * and a reload reopens the drawer at the persisted size.
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the terminal route
   *    and open the quake terminal.
   * 2. Drag the bottom grip a full viewport-height down; assert the drawer
   *    grew and the style pins at the 85vh clamp.
   * 3. Assert the localStorage key holds heightVh 85.
   * 4. Reload, reopen via the chord; assert the drawer renders at 85vh.
   */
  test("dragging the bottom grip resizes the drawer and persists the geometry across reload", async ({
    page,
  }) => {
    await mockBackend(page, true);
    await gotoWindow(page);

    await openDrawerViaChord(page);
    const el = drawer(page);
    await expect(el).not.toHaveClass(/rk-quake-closed/);
    const before = await el.boundingBox();
    expect(before).not.toBeNull();

    const grip = page.getByTestId("quake-terminal-grip-bottom");
    const gripBox = await grip.boundingBox();
    expect(gripBox).not.toBeNull();
    // Grab a point away from the center so the tongue tab is not what is hit
    // — the plain edge is the affordance under test.
    const x = gripBox!.x + gripBox!.width / 4;
    await page.mouse.move(x, gripBox!.y + gripBox!.height / 2);
    await page.mouse.down();
    // A full-viewport drag overshoots the clamp: height pins at 85vh.
    await page.mouse.move(x, gripBox!.y + 720, { steps: 6 });
    await page.mouse.up();

    await expect(el).toHaveAttribute("style", /height: 85vh/);
    const during = await el.boundingBox();
    expect(during!.height).toBeGreaterThan(before!.height);
    const stored = await page.evaluate(() =>
      localStorage.getItem("hexokit-quake-terminal-geometry"),
    );
    expect(stored).toContain('"heightVh":85');

    await page.reload();
    await expect(page.getByText("feature-work").first()).toBeVisible({ timeout: 10_000 });
    await openDrawerViaChord(page);
    await expect(drawer(page)).toHaveAttribute("style", /height: 85vh/);
  });
  /**
   * Proves: the bottom-right corner grip resizes both axes in one drag with
   * independent edges — the drawer's right and bottom edges land under the
   * pointer while the left edge stays put (so the drawer now rests off-center),
   * the signed `centerOffsetPx` persists, and a reload reopens the drawer at
   * that offset.
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the terminal route,
   *    open the quake terminal, and record the drawer's box.
   * 2. Press on the bottom-right corner grip and drag (+120, +80) px.
   * 3. Assert the drawer's right and bottom edges are within 4px of the
   *    pointer, and the left edge moved by at most 1px.
   * 4. Assert the localStorage key holds a positive centerOffsetPx.
   * 5. Reload, reopen via the chord; assert the `left` style carries the
   *    persisted offset.
   */
  test("dragging the bottom-right corner tracks the pointer on both axes and persists the offset", async ({
    page,
  }) => {
    await mockBackend(page, true);
    await gotoWindow(page);

    await openDrawerViaChord(page);
    const el = drawer(page);
    await expect(el).not.toHaveClass(/rk-quake-closed/);
    const before = await el.boundingBox();
    expect(before).not.toBeNull();

    const grip = page.getByTestId("quake-terminal-grip-bottom-right");
    const gripBox = await grip.boundingBox();
    expect(gripBox).not.toBeNull();
    const startX = gripBox!.x + gripBox!.width / 2;
    const startY = gripBox!.y + gripBox!.height / 2;
    const endX = startX + 120;
    const endY = startY + 80;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 8 });
    await page.mouse.up();

    const after = await el.boundingBox();
    expect(after).not.toBeNull();
    // The grabbed corner sits under the pointer: each edge moved by exactly
    // the pointer delta, and the grip's center was ~2px inside the corner.
    expect(Math.abs(after!.x + after!.width - endX)).toBeLessThanOrEqual(4);
    expect(Math.abs(after!.y + after!.height - endY)).toBeLessThanOrEqual(4);
    expect(Math.abs(after!.x - before!.x)).toBeLessThanOrEqual(1);
    expect(after!.width - before!.width).toBeGreaterThan(110);

    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("hexokit-quake-terminal-geometry") ?? "{}"),
    );
    expect(stored.centerOffsetPx).toBeGreaterThan(0);
    expect(stored.widthPx).toBe(Math.round(before!.width) + 120);

    await page.reload();
    await expect(page.getByText("feature-work").first()).toBeVisible({ timeout: 10_000 });
    await openDrawerViaChord(page);
    await expect(drawer(page)).toHaveAttribute(
      "style",
      new RegExp(`left: calc\\(50% \\+ ${stored.centerOffsetPx}px\\)`),
    );
  });

  /**
   * Proves: the desktop drawer is glass — bg-primary at the per-viewer α
   * (default 0.95) over a fixed 6px backdrop blur — and the settings dialog's
   * "Quake terminal opacity" row (a localStorage resident, no settings API)
   * live-applies to the OPEN drawer; α=1 disables the blur, and the value
   * survives reload.
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the terminal route
   *    and open the quake terminal; assert the 0.95 computed background + blur.
   * 2. Open the settings dialog (top-bar gear), switch to Appearance, and
   *    step the opacity slider down; assert the drawer's computed background
   *    changed live and the localStorage key holds 0.9.
   * 3. Push the slider to the max (End key); assert no backdrop-filter.
   * 4. Reload, reopen; assert the persisted 1.0 background is opaque.
   */
  test("the glass opacity setting live-applies and survives reload; α=1 drops the blur", async ({
    page,
  }) => {
    await mockBackend(page, true);
    await gotoWindow(page);

    await openDrawerViaChord(page);
    const el = drawer(page);

    // Theme-agnostic α read: Chromium serializes the color-mix result as
    // `color(srgb … / α)` — the alpha is the setting, the RGB rides the theme.
    const readAlpha = () =>
      el.evaluate((n) => {
        const bg = getComputedStyle(n).backgroundColor;
        const m = /\/\s*([\d.]+)\)$/.exec(bg);
        return m ? Number(m[1]) : 1;
      });

    await expect(el).toHaveCSS("backdrop-filter", "blur(6px)");
    await expect.poll(readAlpha).toBe(0.95);

    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Appearance" }).click();
    const slider = page.getByRole("slider", { name: "Quake terminal opacity" });
    await expect(slider).toBeVisible();
    // .focus() (not .click()) — a click anywhere on the track jumps the
    // thumb to that position, coupling this test's expected value to the
    // slider's min/max width; focusing preserves the current 0.95 so a single
    // ArrowDown is a deterministic one-step decrement regardless of range.
    await slider.focus();
    await slider.press("ArrowDown");
    await expect.poll(readAlpha).toBe(0.9);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("hexokit-quake-terminal-opacity")))
      .toBe("0.9");

    await slider.press("End");
    await expect.poll(readAlpha).toBe(1);
    await expect(el).toHaveCSS("backdrop-filter", "none");

    await page.reload();
    await expect(page.getByText("feature-work").first()).toBeVisible({ timeout: 10_000 });
    await openDrawerViaChord(page);
    await expect(drawer(page)).toHaveCSS("backdrop-filter", "none");
    await expect
      .poll(() =>
        drawer(page).evaluate((n) => {
          const bg = getComputedStyle(n).backgroundColor;
          const m = /\/\s*([\d.]+)\)$/.exec(bg);
          return m ? Number(m[1]) : 1;
        }),
      )
      .toBe(1);
  });

  /**
   * Proves: the standing desktop launcher is the sole top-bar quake terminal
   * affordance, carries the waiting operator's amber state dot on its ◉, and
   * opens the quake terminal when its input receives focus.
   *
   * Steps:
   * 1. Mock the backend with a WAITING operator; land on the terminal route.
   * 2. Assert no dedicated quake terminal button renders in the banner.
   * 3. Assert the launcher ◉ carries the waiting dot; focus the input and
   *    assert the quake terminal opens.
   */
  test("the standing launcher shows the waiting dot and opens the quake terminal", async ({ page }) => {
    await mockBackend(page, true, SEND_OK, "waiting");
    await gotoWindow(page);

    const banner = page.getByRole("banner");
    await expect(banner.getByRole("button", { name: /^Quake terminal/ })).toHaveCount(0);
    const launcher = page.getByTestId("quake-launcher");
    const dot = page.getByTestId("quake-launcher-state");
    await expect(launcher).toContainText("◉");
    await expect(dot).toHaveAttribute("data-state", "waiting");
    await expect(dot).toHaveClass(/bg-signal-yellow/);

    await launcherInput(page).click();
    await expect(drawer(page)).toBeVisible();
  });

  test.describe("mobile navigation", () => {
    // hasTouch flips Chromium's coarse-pointer media queries, so the bottom
    // bar (a touch-only surface) renders as it does on a real phone.
    test.use({ hasTouch: true });

  /**
   * Proves: at 375px there is no sheet — opening the quake terminal NAVIGATES to the
   * operator window's ordinary terminal route, carrying the origin window as
   * `?from=`, and the route's own chrome (top bar, bottom-bar key chips)
   * stays visible with no horizontal page overflow. Entry rides the top-bar
   * overflow menu's `Quake terminal` row (no keyboard on a phone).
   *
   * Steps:
   * 1. Set the 375×812 viewport; mock the backend with an operator window;
   *    land on the @1 terminal route (direct goto + `__rkTerminals` poll).
   * 2. Open the `More controls` chevron menu and select `Quake terminal`.
   * 3. Assert the URL becomes the operator route with `?from=@1`, no
   *    `quake-terminal` element exists, and the chevron + bottom-bar
   *    toolbar are still visible.
   * 4. Assert `document.body.scrollWidth` ≤ 375 (no horizontal overflow).
   */
  test("mobile: opening the quake terminal navigates to the operator terminal route (no sheet, no overflow)", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockBackend(page, true);
    await gotoWindowMobile(page);

    const chevron = page.getByRole("button", { name: "More controls" });
    await expect(chevron).toBeVisible({ timeout: 10_000 });
    await chevron.click();
    await page.getByRole("menu", { name: "More controls" })
      .getByRole("menuitem", { name: /^Quake terminal/ })
      .click();

    await expectOperatorRoute(page, "@1");
    await expect(drawer(page)).toHaveCount(0);
    await expect(chevron).toBeVisible();
    await expect(page.getByRole("toolbar", { name: "Terminal keys" })).toBeVisible();

    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  });

  /**
   * Proves: on mobile the tongue under the top bar is a TOGGLE — the standing
   * affordance with the amber waiting dot while off the operator route (with
   * no dedicated operator button in the banner), a tap navigates to the
   * operator window's terminal route, and ON that route the tongue stays as the return
   * affordance (`data-tongue-state="return"`, waiting dot suppressed) whose
   * tap navigates back to the `?from=` origin window — a full round trip with
   * no horizontal overflow.
   *
   * Steps:
   * 1. Set the 375×812 viewport; mock the backend with a waiting operator;
   *    land on the @1 terminal route (direct goto + `__rkTerminals` poll).
   * 2. Assert the tongue is visible with the waiting dot and no dedicated
   *    operator button renders in the banner.
   * 3. Tap the tongue; assert the URL becomes the operator route with
   *    `?from=@1`, the tongue REMAINS in the return state, and the waiting
   *    dot is gone.
   * 4. Tap the tongue again; assert the URL is back at the @1 terminal route
   *    and the tongue is the operator-state affordance again.
   * 5. Assert `document.body.scrollWidth` ≤ 375.
   */
  test("mobile: the tongue is a toggle (navigate in, return state back, no overflow)", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockBackend(page, true, SEND_OK, "waiting");
    await gotoWindowMobile(page);

    const tongue = page.getByTestId("quake-terminal-tongue");
    await expect(tongue).toBeVisible();
    await expect(page.getByTestId("quake-terminal-tongue-waiting")).toBeVisible();
    await expect(
      page.getByRole("banner").getByRole("button", { name: /^Quake terminal/ }),
    ).toHaveCount(0);

    await tongue.click();
    await expectOperatorRoute(page, "@1");
    await expect(tongue).toHaveAttribute("data-tongue-state", "return");
    await expect(page.getByTestId("quake-terminal-tongue-waiting")).toHaveCount(0);

    await tongue.click();
    // The router serializes window @1 as the bare segment `1` (router-url.ts).
    await expect(page).toHaveURL(`/${SERVER}/1`, { timeout: 10_000 });
    await expect(tongue).toHaveAttribute("data-tongue-state", "operator");

    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  });

  /**
   * Proves: on the operator window's route the compose strip renders the
   * dismissable context chip naming the `?from=` origin window, and a plain
   * text submit rides the templated chat lane — exactly one POST to
   * `/api/windows/@1/operator-request` with `{template: "user-message",
   * text}` — while the direct send lane stays silent.
   *
   * Steps:
   * 1. Set the 375×812 viewport; pre-enable the compose strip
   *    (`hexokit-compose-strip`); mock the backend with an operator window;
   *    land on the @1 terminal route.
   * 2. Tap the tongue; assert the operator route with `?from=@1` and the
   *    chip naming @1 "feature-work".
   * 3. Type into the compose strip and click its Send.
   * 4. Assert one recorded operator-request at @1 with the user-message body,
   *    an empty direct-send list, and the cleared draft.
   */
  test("mobile: the operator route's compose strip submits ride the templated chat lane behind the ?from= chip", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.addInitScript(() => localStorage.setItem("hexokit-compose-strip", "true"));
    const { sendBodies, requestCalls } = await mockBackend(page, true);
    await gotoWindowMobile(page);

    await page.getByTestId("quake-terminal-tongue").click();
    await expectOperatorRoute(page, "@1");
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Boolean((window as unknown as { __rkTerminals?: Record<string, unknown> }).__rkTerminals?.["@9"]),
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    await expect(page.getByTestId("quake-terminal-context")).toContainText('from: @1 "feature-work"');

    const stripInput = page.getByTestId("compose-strip-input");
    await stripInput.fill("can you check the failing test?");
    await page.getByTestId("compose-strip-send").click();

    await expect
      .poll(() => requestCalls.map((c) => ({ path: new URL(c.url).pathname, body: c.body })))
      .toEqual([
        {
          path: "/api/windows/%401/operator-request",
          body: { template: "user-message", text: "can you check the failing test?" },
        },
      ]);
    expect(sendBodies).toEqual([]);
    await expect(stripInput).toHaveValue("");
  });

  /**
   * Proves: the `?from=` chip's LABEL is the secondary return affordance — a
   * tap on `from: @1 "feature-work"` navigates back to the origin window's
   * terminal route (the chip's ✕ stays dismiss-only, exercised by the
   * dismissal test below).
   *
   * Steps:
   * 1. Set the 375×812 viewport; pre-enable the compose strip; mock the
   *    backend with an operator window; land on the @1 terminal route.
   * 2. Tap the tongue; assert the operator route with `?from=@1` and the chip.
   * 3. Tap the chip's label button (`Back to @1 "feature-work"`).
   * 4. Assert the URL is back at the @1 terminal route.
   */
  test("mobile: the ?from= chip label navigates back to the origin window", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.addInitScript(() => localStorage.setItem("hexokit-compose-strip", "true"));
    await mockBackend(page, true);
    await gotoWindowMobile(page);

    await page.getByTestId("quake-terminal-tongue").click();
    await expectOperatorRoute(page, "@1");
    await expect(page.getByTestId("quake-terminal-context")).toContainText('from: @1 "feature-work"');

    await page
      .getByTestId("quake-terminal-context")
      .getByRole("button", { name: 'Back to @1 "feature-work"' })
      .click();

    // The router serializes window @1 as the bare segment `1` (router-url.ts).
    await expect(page).toHaveURL(`/${SERVER}/1`, { timeout: 10_000 });
  });

  /**
   * Proves: dismissing the `?from=` chip drops the envelope — the compose
   * strip's next plain submit goes through its ordinary direct send at the
   * operator window (no operator-request POST) — and a bottom-bar key chip
   * always drives the pane directly regardless of the chip (no REST call at
   * all).
   *
   * Steps:
   * 1. Set the 375×812 viewport; pre-enable the compose strip; mock the
   *    backend with an operator window; land directly on the operator route
   *    with `?from=@1`.
   * 2. Dismiss the chip via its ✕; assert it disappears.
   * 3. Type and Send; assert one direct `{text, mode: "submit"}` send and an
   *    empty operator-request list.
   * 4. Click the terminal (the bottom bar hides while the strip's textarea
   *    owns focus), then click the bottom bar's Tab key chip; assert no
   *    further REST send or operator-request fired.
   */
  test("mobile: dismissing the chip returns strip submits to the direct lane; bottom-bar keys stay direct", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.addInitScript(() => localStorage.setItem("hexokit-compose-strip", "true"));
    const { sendBodies, requestCalls } = await mockBackend(page, true);
    await page.goto(operatorUrl("@1"));
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Boolean((window as unknown as { __rkTerminals?: Record<string, unknown> }).__rkTerminals?.["@9"]),
          ),
        { timeout: 10_000 },
      )
      .toBe(true);

    await page.getByRole("button", { name: "Detach window context" }).click();
    await expect(page.getByTestId("quake-terminal-context")).toHaveCount(0);

    const stripInput = page.getByTestId("compose-strip-input");
    await stripInput.fill("plain message");
    await page.getByTestId("compose-strip-send").click();
    await expect.poll(() => sendBodies).toEqual([{ text: "plain message", mode: "submit" }]);
    expect(requestCalls).toEqual([]);

    // The bottom bar hides while the strip's textarea owns focus — move focus
    // to the terminal first so the key chips render again.
    await page.locator(".xterm").first().click();
    const tabChip = page.getByRole("button", { name: "Tab", exact: true });
    await expect(tabChip).toBeVisible();
    await tabChip.click();
    await page.waitForTimeout(300);
    expect(sendBodies).toHaveLength(1);
    expect(requestCalls).toEqual([]);
  });

  /**
   * Proves: an invalid `?from=` (a window id the server does not carry)
   * attaches nothing — no chip renders, and a compose-strip submit is the
   * ordinary direct send at the operator window, without error.
   *
   * Steps:
   * 1. Set the 375×812 viewport; pre-enable the compose strip; mock the
   *    backend with an operator window; land on the operator route with
   *    `?from=@42` (unknown).
   * 2. Assert no chip renders.
   * 3. Type and Send; assert one direct send and no operator-request POST.
   */
  test("mobile: an unknown ?from= window renders no chip and sends direct", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.addInitScript(() => localStorage.setItem("hexokit-compose-strip", "true"));
    const { sendBodies, requestCalls } = await mockBackend(page, true);
    await page.goto(operatorUrl("@42"));
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Boolean((window as unknown as { __rkTerminals?: Record<string, unknown> }).__rkTerminals?.["@9"]),
          ),
        { timeout: 10_000 },
      )
      .toBe(true);

    await expect(page.getByTestId("quake-terminal-context")).toHaveCount(0);

    await page.getByTestId("compose-strip-input").fill("still direct");
    await page.getByTestId("compose-strip-send").click();
    await expect.poll(() => sendBodies).toEqual([{ text: "still direct", mode: "submit" }]);
    expect(requestCalls).toEqual([]);
  });

  /**
   * Proves: with no operator window on the server, mobile shows no tongue and
   * the remaining segment-less openers answer with the hint toast instead of
   * navigating — once per activation burst (repeat activations do not stack
   * toasts). Cron-segment requests are the exception (the next test): cron
   * needs no operator.
   *
   * Steps:
   * 1. Set the 375×812 viewport; mock the backend WITHOUT an operator
   *    window; land on the @1 terminal route.
   * 2. Assert the tongue is absent.
   * 3. Fire the overflow menu's `Quake terminal` row twice; assert the
   *    hint toast renders once, the URL is unchanged, and no quake terminal element
   *    exists.
   */
  test("mobile: an operator-less server hides the tongue and toasts the hint without navigating", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockBackend(page, false);
    await gotoWindowMobile(page);

    await expect(page.getByTestId("quake-terminal-tongue")).toHaveCount(0);

    const chevron = page.getByRole("button", { name: "More controls" });
    await expect(chevron).toBeVisible({ timeout: 10_000 });
    for (let i = 0; i < 2; i++) {
      await chevron.click();
      await page.getByRole("menu", { name: "More controls" })
        .getByRole("menuitem", { name: /^Quake terminal/ })
        .click();
    }

    await expect(page.getByText("no operator on this server — run rk operator")).toHaveCount(1);
    expect(page.url()).toContain(WINDOW_URL);
    await expect(drawer(page)).toHaveCount(0);
  });

  /**
   * Proves: cron needs no operator on mobile either — with no operator window
   * on the server, `Operator: Show cron list` navigates to the tmux Server
   * page's Cron section (`/$server#cron`, the phone's operator-less cron home)
   * with the registry row rendering, and no hint toast fires.
   *
   * Steps:
   * 1. Set the 375×812 viewport; mock the backend WITHOUT an operator
   *    window; land on the @1 terminal route.
   * 2. Pick `Operator: Show cron list` from the palette.
   * 3. Assert the URL is the Server page with the `#cron` hash, the Cron
   *    section and its entry row are visible, and no hint toast rendered.
   */
  test("mobile: Operator: Show cron list on an operator-less server lands on the Server page's Cron section", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await mockBackend(page, false);
    await gotoWindowMobile(page);

    const paletteInput = await openPalette(page);
    await paletteInput.fill("Show cron list");
    await page.getByRole("option", { name: /^Operator: Show cron list/ }).click();

    await expect(page).toHaveURL(new RegExp(`/${SERVER}#cron$`), { timeout: 10_000 });
    const zone = page.getByTestId("clock-zone-cron");
    await expect(zone).toBeVisible({ timeout: 10_000 });
    await expect(zone.getByTestId("cron-list-row-a3f9")).toBeVisible();
    await expect(page.getByText("no operator on this server — run rk operator")).toHaveCount(0);
    await expect(drawer(page)).toHaveCount(0);
  });

  /**
   * Proves: the palette's Ask-operator fallback row on mobile navigates to
   * the operator route and seeds the typed query as the compose strip's
   * DRAFT — nothing is sent until the user reviews and sends it.
   *
   * Steps:
   * 1. Set the 375×812 viewport; pre-enable the compose strip; mock the
   *    backend with an operator window; land on the @1 terminal route.
   * 2. Open the palette and type a query matching no action; assert the
   *    fallback row renders.
   * 3. Press Enter; assert the operator route with `?from=@1` and the strip
   *    holding the query as its unsent draft.
   * 4. Assert no send fired on either lane.
   */
  test("mobile: the palette fallback row navigates and seeds the compose draft, unsent", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.addInitScript(() => localStorage.setItem("hexokit-compose-strip", "true"));
    const { sendBodies, requestCalls } = await mockBackend(page, true);
    await gotoWindowMobile(page);

    const paletteInput = await openPalette(page);
    await paletteInput.fill("the fence deploy is wedged");
    await expect(
      page.getByRole("option", { name: 'Ask operator: "the fence deploy is wedged"' }),
    ).toBeVisible();

    await paletteInput.press("Enter");
    await expect(paletteInput).toHaveCount(0);
    await expectOperatorRoute(page, "@1");
    await expect(page.getByTestId("compose-strip-input")).toHaveValue("the fence deploy is wedged");
    expect(requestCalls).toEqual([]);
    expect(sendBodies).toEqual([]);
  });
  });

  /**
   * Proves: an image ⌘V inside the quake terminal surface uploads to the OPERATOR
   * window's session (`_rk-operator`) and insert-delivers the returned path
   * to the operator pane (mode "raw", target "agent", never submitted) — and
   * the route terminals' strip-forward guard keeps the paste OFF the tab
   * below (no upload to the route's `dev` session). Both focus targets are
   * covered: the embedded terminal's xterm textarea (the quake terminal root's
   * CAPTURE-phase handler — xterm stops bubble propagation) and the docked
   * compose textarea (inside the same root; its quake-terminal root attribute
   * excludes it from the route terminals' document-level forward).
   *
   * Steps:
   * 1. Mock the backend with an operator window plus the upload endpoint;
   *    land on the terminal route and open the quake terminal.
   * 2. Dispatch a file-carrying paste at the quake terminal's embedded xterm helper
   *    textarea; assert one upload to `_rk-operator` and one raw/agent send.
   * 3. Dispatch a second paste at the docked compose textarea; assert a second
   *    upload/send pair.
   * 4. Assert no upload ever hit the route session.
   */
  test("image paste inside the quake terminal uploads to the operator session and insert-delivers the path", async ({
    page,
  }) => {
    const { sendBodies } = await mockBackend(page, true);
    const uploads = await mockUploads(page);
    await gotoWindow(page);

    await openDrawerViaChord(page);
    await expect(
      drawer(page).locator(".xterm-helper-textarea"),
    ).toBeAttached({ timeout: 10_000 });

    await pasteImage(page, '[data-testid="quake-terminal"] .xterm-helper-textarea');
    await expect.poll(() => uploads.map((u) => u.session)).toEqual(["_rk-operator"]);
    await expect
      .poll(() => sendBodies)
      .toEqual([{ text: "/tmp/op/.uploads/shot.png ", mode: "raw", target: "agent" }]);

    await pasteImage(page, '[data-testid="quake-terminal-compose-input"]');
    await expect
      .poll(() => uploads.map((u) => u.session))
      .toEqual(["_rk-operator", "_rk-operator"]);
    await expect.poll(() => sendBodies).toHaveLength(2);
    expect(uploads.some((u) => u.session === "dev")).toBe(false);
  });

  /**
   * Proves: with the quake terminal CLOSED, a file paste on the page still forwards
   * to the compose strip exactly as before — the guard only excludes
   * quake-terminal-origin pastes. (The strip forward rides the route terminal's
   * document-level listener, which only ever sees pastes whose target lies
   * OUTSIDE an xterm — xterm's own textarea handler stops propagation — so
   * the reachable production path is a paste with focus outside the
   * terminal.)
   *
   * Steps:
   * 1. Mock the backend with an operator window plus the upload endpoint;
   *    land on the terminal route (quake terminal never opened).
   * 2. Dispatch a file-carrying paste at the page body.
   * 3. Assert one upload to the route's `dev` session (the strip's focused
   *    target) and no quake terminal involvement.
   */
  test("file paste outside the terminal still forwards to the compose strip when the quake terminal is closed", async ({
    page,
  }) => {
    await mockBackend(page, true);
    const uploads = await mockUploads(page);
    await gotoWindow(page);
    await expect(page.locator(".xterm").first()).toBeAttached({ timeout: 10_000 });

    await pasteImage(page, "body");

    await expect.poll(() => uploads.map((u) => u.session), { timeout: 10_000 }).toEqual(["dev"]);
    await expect(drawer(page)).toHaveCount(0);
  });
});
