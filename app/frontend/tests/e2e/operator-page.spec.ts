import { test, expect, type Page } from "@playwright/test";
import { openPalette } from "./_ready";
import { mockStateSocket, emitSessions } from "./_state-socket-mock";

// The operator page — the operator window's own terminal route wearing the
// quake surface on DESKTOP (the mobile form is mobile-cron-tabs.spec's): the
// `terminal-activity-tabs` strip above the tty tile, `?tab=` as the page's
// live segment state (non-terminal tabs hide-never-unmount the terminal
// column and swap the body), and the route's compose strip FORCED on and
// footer-docked (visible under a non-terminal tab) regardless of the
// `hexokit-compose-strip` preference. The operator-less shapes: the drawer's
// Start operator button (pending → the SSE-equivalent sessions event carries
// the new operator window and the embed mounts; failures surface inline) and
// the sidebar's placeholder row (the pinned slot's operator-less form —
// activation opens the drawer on Operator Terminal; a carrier swap replaces
// it with the ordinary pinned row).
//
// Shared setup: fully mocked (no tmux). The sessions payload rides the
// state-socket mock — a work window `@1` plus, when the test wants one, an
// operator window `@9` with `role: "operator"` in `_rk-operator` — and
// `emitSessions` pushes a mid-test payload flip (the SSE-equivalent of the
// operator appearing). `POST /api/operator/start` is stubbed per test via
// page.route (202 receipt or a 502 error body) and records each call's URL
// AND body — a Start from the `@1` Terminal route must carry the viewed
// window (`{"window":"@1"}`) so the daemon can derive its pane cwd. CI has no
// fab-kit, so the real `rk operator` launch is a dev-box manual check, never
// an e2e. The route mock carries a trailing `*` — the client appends
// `?server=` (withServer), so a bare glob would silently miss.
// `/ws/terminals` is a no-op socket mock: terminals mount their xterm frame
// without stream data. `GET /api/cron` is stubbed with one entry so the Cron
// List segment has a row.

const SERVER = "default";
const NOW = Math.floor(Date.now() / 1000);

function sessionsPayload(withOperator: boolean) {
  const work = {
    windowId: "@1",
    index: 0,
    name: "feature-work",
    worktreePath: "/tmp/wt",
    activity: "active",
    isActiveWindow: true,
    activityTimestamp: 0,
    agentState: "idle",
    panes: [{ paneId: "%1", paneIndex: 0, cwd: "/tmp/wt", command: "zsh", isActive: true }],
  };
  return JSON.stringify([
    { name: "dev", windows: [work] },
    ...(withOperator
      ? [
          {
            name: "_rk-operator",
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
                agentState: "idle",
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
  deliveries: [],
});

type StartBehavior = { status: number; body: Record<string, unknown> };

/** Install the mocked backend; the Start stub answers with `behavior` and
 *  records its calls. Returns the recorded start-call URLs and bodies. */
async function mockBackend(page: Page, withOperator: boolean, behavior?: StartBehavior) {
  const startCalls: string[] = [];
  const startBodies: string[] = [];
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
  await page.route("**/api/cron*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: CRON }),
  );
  if (behavior) {
    await page.route("**/api/operator/start*", (route) => {
      startCalls.push(route.request().url());
      startBodies.push(route.request().postData() ?? "");
      return route.fulfill({
        status: behavior.status,
        contentType: "application/json",
        body: JSON.stringify(behavior.body),
      });
    });
  }
  await mockStateSocket(page, { sessions: sessionsPayload(withOperator) });
  return { startCalls, startBodies };
}

const WINDOW_URL = `/${SERVER}/%401`;
const OPERATOR_PATH = `/${SERVER}/9`;

async function gotoWindow(page: Page) {
  await page.goto(WINDOW_URL);
  await expect(page.getByText("feature-work").first()).toBeVisible({ timeout: 10_000 });
}

const drawer = (page: Page) => page.getByTestId("quake-terminal");

test.describe("operator page (desktop)", () => {
  /**
   * Proves: the desktop operator route renders the segment strip above the
   * tty tile and the route's compose strip even with the
   * `hexokit-compose-strip` preference off — the operator page has an input by
   * definition.
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on its route.
   * 2. Assert the page's segment strip is visible with Operator Terminal
   *    selected, the terminal frame is mounted, and the compose strip input
   *    is visible below it.
   */
  test("the desktop operator route shows the strip and the forced compose strip", async ({
    page,
  }) => {
    await mockBackend(page, true);
    await page.goto(OPERATOR_PATH);

    const tabs = page.getByTestId("terminal-activity-tabs");
    await expect(tabs).toBeVisible({ timeout: 10_000 });
    await expect(tabs.getByRole("tab", { name: "Operator Terminal" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator(".xterm").first()).toBeVisible();
    await expect(page.getByTestId("compose-strip-input")).toBeVisible();
  });

  /**
   * Proves: a non-terminal `?tab=` on the desktop operator route swaps the
   * body to the cron segment while the terminal column stays mounted-but-
   * hidden, and the footer-docked compose strip stays visible (the in-tile
   * dock would have hidden with the terminal column).
   *
   * Steps:
   * 1. Mock the backend with an operator window; land on the operator route
   *    carrying `?tab=list`.
   * 2. Assert Cron List is selected on the page's strip and its body renders.
   * 3. Assert the xterm frame is still mounted but hidden, and the compose
   *    strip input is still visible.
   */
  test("?tab=list swaps the body, keeps the terminal mounted-but-hidden, and keeps the compose strip visible", async ({
    page,
  }) => {
    await mockBackend(page, true);
    await page.goto(`${OPERATOR_PATH}?tab=list`);

    const tabs = page.getByTestId("terminal-activity-tabs");
    await expect(tabs.getByRole("tab", { name: "Cron List" })).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 10_000 },
    );
    await expect(page.getByTestId("cron-list")).toBeVisible({ timeout: 10_000 });
    const xterm = page.locator(".xterm").first();
    await expect(xterm).toHaveCount(1);
    await expect(xterm).toBeHidden();
    await expect(page.getByTestId("compose-strip-input")).toBeVisible();
  });

  /**
   * Proves: the Start operator button in the drawer's operator-less body
   * posts to /api/operator/start carrying the viewed Terminal-route window
   * (`{"window":"@1"}`, so the daemon derives its pane cwd), holds its
   * pending state, and unmounts itself once the sessions payload carries the
   * new operator window (the drawer's embed mounts on the resolved target) —
   * no client polling.
   *
   * Steps:
   * 1. Mock the backend without an operator; land on the @1 route and open
   *    the drawer via the palette.
   * 2. Click Start operator; assert one POST fired with the viewed window in
   *    the body, the button reads `starting…` and is disabled.
   * 3. Push the operator-bearing sessions payload; assert the empty body and
   *    button are gone and the drawer's terminal embed is up.
   */
  test("Start operator posts, pends, and unmounts when the operator appears in the sessions payload", async ({
    page,
  }) => {
    const { startCalls, startBodies } = await mockBackend(page, false, {
      status: 202,
      body: { windowId: "@9", server: SERVER },
    });
    await gotoWindow(page);
    // The placeholder row is the pinned slot's operator-less form.
    await expect(page.getByTestId("operator-placeholder-row")).toBeVisible();

    const paletteInput = await openPalette(page);
    await paletteInput.fill("Open quake terminal");
    await page.getByRole("option", { name: /^Operator: Open quake terminal/ }).click();
    await expect(drawer(page)).toBeVisible();

    const button = page.getByTestId("quake-terminal-start-operator");
    await expect(button).toBeVisible();
    await button.click();
    await expect(button).toBeDisabled();
    await expect(button).toHaveText("starting…");
    await expect.poll(() => startCalls.length).toBe(1);
    expect(new URL(startCalls[0]).pathname).toBe("/api/operator/start");
    expect(new URL(startCalls[0]).searchParams.get("server")).toBe(SERVER);
    expect(JSON.parse(startBodies[0])).toEqual({ window: "@1" });

    // The SSE-equivalent repaint: the operator window arrives.
    emitSessions(SERVER, sessionsPayload(true));
    await expect(page.getByTestId("quake-terminal-empty")).toHaveCount(0);
    await expect(drawer(page).locator(".xterm")).toHaveCount(1);
    // The placeholder row swapped to the real pinned row.
    await expect(page.getByTestId("operator-placeholder-row")).toHaveCount(0);
    await expect(page.locator('[data-row-key="default:@9"]')).toBeVisible();
  });

  /**
   * Proves: a Start failure surfaces the server's message inline (role=alert
   * under the button) and re-arms the button — no toast, no navigation.
   *
   * Steps:
   * 1. Mock the backend without an operator, the Start stub answering 502
   *    with the CLI's precondition line; open the drawer.
   * 2. Click Start operator.
   * 3. Assert the inline error line carries the stubbed message and the
   *    button is enabled again.
   */
  test("a Start failure surfaces the server's message inline and re-arms the button", async ({
    page,
  }) => {
    await mockBackend(page, false, {
      status: 502,
      body: { error: "run-kit operator: fab not found on PATH — install fab-kit" },
    });
    await gotoWindow(page);

    const paletteInput = await openPalette(page);
    await paletteInput.fill("Open quake terminal");
    await page.getByRole("option", { name: /^Operator: Open quake terminal/ }).click();
    await expect(drawer(page)).toBeVisible();

    const button = page.getByTestId("quake-terminal-start-operator");
    await button.click();

    const errorLine = page.getByTestId("quake-terminal-start-error");
    await expect(errorLine).toBeVisible();
    await expect(errorLine).toHaveText("run-kit operator: fab not found on PATH — install fab-kit");
    await expect(button).toBeEnabled();
    await expect(button).toHaveText("Start operator");
  });

  /**
   * Proves: the sidebar's operator placeholder row opens the drawer on the
   * Operator Terminal segment (where the Start button sits) when activated
   * from the keyboard — Enter through the roving-tabindex tree path.
   *
   * Steps:
   * 1. Mock the backend without an operator; land on the @1 route.
   * 2. Press Enter on the placeholder row.
   * 3. Assert the drawer is open on Operator Terminal with the Start button.
   */
  test("Enter on the placeholder row opens the drawer on Operator Terminal with the Start button", async ({
    page,
  }) => {
    await mockBackend(page, false);
    await gotoWindow(page);

    const row = page.getByTestId("operator-placeholder-row");
    await expect(row).toBeVisible();
    await row.press("Enter");

    await expect(drawer(page)).toBeVisible();
    const tabs = drawer(page).getByTestId("terminal-activity-tabs");
    await expect(tabs.getByRole("tab", { name: "Operator Terminal" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByTestId("quake-terminal-start-operator")).toBeVisible();
  });
});
