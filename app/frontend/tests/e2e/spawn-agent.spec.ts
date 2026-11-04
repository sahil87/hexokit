import { test, expect, type Page } from "@playwright/test";
import { openPalette } from "./_ready";
import { mockStateSocket } from "./_state-socket-mock";

// Web-UI agent spawn flow — surfacing `rk riff` as a one-action spawn
// dialog. The dialog opens from ALL THREE entry points (Cmd+K
// `Agent: Spawn`, the New split button's `Agent tab…` row, and the sidebar
// session flyout card's `Spawn agent…` row), renders the mockup-v2 field set (Where radio /
// Worktree name / Agent tier) with the correct defaults and conditional
// Worktree visibility, hides the Agent Tier field when the presets endpoint
// returns `tiers: []` (a non-fab repo), carries `where`/`tier` in the POST
// body on a checkout + tier task-submit, and renders a 400's error in-dialog
// without navigating.
//
// Shared setup: fully mocked — no tmux, no wt, no fab, no real backend.
// Injected via page.route: `**/api/servers` → a single server `default`;
// `**/api/windows/*/select*` → 200; `/ws/state` (state socket, via
// mockStateSocket) → the subscribe ack + `sessions` event carry the mocked
// payload: session `dev` with one active window `@1` "main";
// `**/api/riff/presets*` → `{presets: [...], tiers: [...]}` (empty presets +
// the fab-kit built-in tiers by default); `**/api/riff*` → intercepts POST
// only (falls back otherwise so the presets GET, which also matches this
// glob, is not swallowed), captures the request body and fulfills with the
// mock's status/body; the terminals mux WebSocket (`/ws/terminals`) is
// stubbed. The riff-endpoint mocks use TRAILING `*` globs because the
// client's withServer appends `?server=` — a no-star glob would silently
// fall through and hit live tmux. BUILTIN_TIERS mirrors the backend's
// fabconfig.BuiltinTiers (`default, doing, fast, operator, review`); the
// presets mock returns these as `tiers` unless a test overrides them.
// gotoTerminal(page) navigates to `/default/1` and waits for the "main"
// window to render (the state-socket payload landed). openViaPalette opens
// the palette via `openPalette`, fills "Agent: Spawn", presses Enter.
// openViaNewMenu clicks the New split button's caret then its `Agent tab…`
// menu row. openViaSidebarCard hovers the session row to open its flyout
// card, then clicks the card's `Spawn agent…` action row.
// OK_SPAWN is the success mock: POST /api/riff → 200
// {server, session:"dev", window:"riff-swift-fox", windowId:"@7"}.

const SERVER = "default";

function sessionsPayload() {
  return JSON.stringify([
    {
      name: "dev",
      windows: [
        {
          windowId: "@1",
          index: 0,
          name: "main",
          worktreePath: "/tmp/repo",
          activity: "active",
          isActiveWindow: true,
          activityTimestamp: 0,
        },
      ],
    },
  ]);
}

// The fab-kit built-in tiers, mirrored by the backend's fabconfig.BuiltinTiers.
const BUILTIN_TIERS = ["default", "doing", "fast", "operator", "review"];

type RiffMock = {
  // When set, POST /api/riff fulfills with this status + body.
  spawnStatus: number;
  spawnBody: string;
  // Presets list returned by GET /api/riff/presets.
  presets: unknown[];
  // Tiers returned by GET /api/riff/presets (defaults to the built-ins).
  tiers?: string[];
};

async function mockBackend(page: Page, riff: RiffMock): Promise<{ spawnBodies: () => Record<string, unknown>[] }> {
  const spawnBodies: Record<string, unknown>[] = [];

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
  await mockStateSocket(page, { sessions: sessionsPayload() });

  // GET /api/riff/presets* — MUST match the presets glob BEFORE the broader
  // riff glob, so register it first (Playwright matches most-recently-added
  // first, but keeping the specific one first is clearest).
  await page.route("**/api/riff/presets*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ presets: riff.presets, tiers: riff.tiers ?? BUILTIN_TIERS }),
    }),
  );

  // POST /api/riff* — the spawn. Capture the body; only intercept POST so the
  // presets GET (which also matches `**/api/riff*`) is not swallowed here.
  await page.route("**/api/riff*", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    spawnBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: riff.spawnStatus,
      contentType: "application/json",
      body: riff.spawnBody,
    });
  });

  return { spawnBodies: () => spawnBodies };
}

async function gotoTerminal(page: Page) {
  await page.goto(`/${SERVER}/1`);
  await expect(page.getByText("main").first()).toBeVisible({ timeout: 10_000 });
}

async function openViaPalette(page: Page) {
  const paletteInput = await openPalette(page);
  await paletteInput.fill("Agent: Spawn");
  await page.keyboard.press("Enter");
}

async function openViaNewMenu(page: Page) {
  await page.getByTestId("new-split-caret").click();
  await page.getByTestId("new-split-menu").getByRole("menuitem", { name: "Agent tab…" }).click();
}

// The sidebar session-card spawn row — the third entry point. Hover the
// session row until ITS flyout card is the open one (while SSE is still
// settling, a row layout-shift under the stationary pointer can fire a
// sibling row's hover intent — a mouseover with no mousemove — and open THAT
// row's card), enter the card at the row's own band (a diagonal sweep from
// the row to a lower action row crosses the sibling sidebar row and
// hover-intent retargets the card mid-transit), then click the card's
// `Spawn agent…` action row.
async function openViaSidebarCard(page: Page, session: string) {
  const row = page.locator(`[data-session-row="${SERVER}:${session}"]`);
  await expect(row).toBeVisible({ timeout: 5_000 });
  const card = page.getByTestId("row-flyout-card");
  await expect(async () => {
    await page.mouse.move(700, 500);
    await row.hover();
    await expect(card).toContainText(`Group ${session}`, { timeout: 3_000 });
  }).toPass({ timeout: 15_000 });
  const rowBox = (await row.boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  await page.mouse.move(cardBox.x + 16, rowBox.y + rowBox.height / 2);
  await card.getByTestId("row-flyout-spawn-action").click();
}

const OK_SPAWN: RiffMock = {
  spawnStatus: 200,
  spawnBody: JSON.stringify({ server: SERVER, session: "dev", window: "riff-swift-fox", windowId: "@7" }),
  presets: [],
};

test.describe("Web-UI Spawn Agent", () => {
  /**
   * Proves: the palette action opens the spawn-agent dialog on the terminal
   * route, titled with the target session.
   *
   * Steps:
   * 1. Mock the backend (OK_SPAWN); gotoTerminal.
   * 2. openViaPalette.
   * 3. Assert the `Spawn agent in dev` dialog and its `Task` field are
   *    visible.
   */
  test("opens the spawn dialog from the Cmd+K Agent: Spawn action", async ({ page }) => {
    await mockBackend(page, OK_SPAWN);
    await gotoTerminal(page);

    await openViaPalette(page);

    // Title carries the target session (mockup-v2).
    await expect(page.getByRole("dialog", { name: "Spawn agent in dev" })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByLabel("Task")).toBeVisible();
  });

  /**
   * Proves: the second entry point — the `Agent tab…` row in the New split
   * button's caret menu — opens the same dialog.
   *
   * Steps:
   * 1. Mock the backend (OK_SPAWN); gotoTerminal.
   * 2. openViaNewMenu (click the split's caret, then `Agent tab…`).
   * 3. Assert the `Spawn agent in dev` dialog and its `Task` field are
   *    visible.
   */
  test("opens the spawn dialog from the New split button's Agent tab… row", async ({ page }) => {
    await mockBackend(page, OK_SPAWN);
    await gotoTerminal(page);

    await openViaNewMenu(page);

    await expect(page.getByRole("dialog", { name: "Spawn agent in dev" })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByLabel("Task")).toBeVisible();
  });

  /**
   * Proves: the v2 dialog renders the new fields with the mockup defaults —
   * the Where radio defaults to "new worktree", the Worktree name field is
   * visible in worktree mode, the Agent tier dropdown defaults to "default",
   * and selecting "this checkout" hides the Worktree field.
   *
   * Steps:
   * 1. Mock the backend (OK_SPAWN); gotoTerminal; openViaPalette.
   * 2. Assert the "new worktree" radio is checked and "this checkout" is not.
   * 3. Assert the Worktree name field is visible and the Agent dropdown
   *    value is "default".
   * 4. Check the "this checkout" radio; assert the Worktree name field is
   *    hidden.
   */
  test("renders the mockup-v2 fields (Where radio, Worktree, Agent tier)", async ({ page }) => {
    await mockBackend(page, OK_SPAWN);
    await gotoTerminal(page);

    await openViaPalette(page);
    await expect(page.getByRole("dialog", { name: "Spawn agent in dev" })).toBeVisible({ timeout: 5_000 });

    // Where radio — new worktree checked by default.
    await expect(page.getByRole("radio", { name: /new worktree/i })).toBeChecked();
    await expect(page.getByRole("radio", { name: /this checkout/i })).not.toBeChecked();
    // Worktree field visible in worktree mode; Agent tier dropdown defaults to
    // "default". `exact` on the Agent label — a loose match also hits the dialog
    // (accessible name "Spawn agent in dev" contains "agent").
    await expect(page.getByLabel("Worktree name")).toBeVisible();
    await expect(page.getByLabel("Agent tier", { exact: true })).toHaveValue("default");

    // Selecting "this checkout" hides the Worktree field.
    await page.getByRole("radio", { name: /this checkout/i }).check();
    await expect(page.getByLabel("Worktree name")).toBeHidden();
  });

  /**
   * Proves: typing a task and pressing Enter POSTs /api/riff with the task +
   * session and, on success, navigates to the returned window; a
   * defaults-only body omits `where`/`tier` (backend defaults), keeping the
   * shipped path's body.
   *
   * Steps:
   * 1. Mock the backend (OK_SPAWN); gotoTerminal.
   * 2. openViaPalette; fill the `Task` field with "fix the bug"; press Enter.
   * 3. Assert the URL navigated to /default/7 (the returned windowId @7).
   * 4. Assert the captured POST body matches
   *    { task: "fix the bug", session: "dev" } and carries neither `where`
   *    nor `tier`.
   */
  test("submitting a task spawns and navigates to the returned window", async ({ page }) => {
    const { spawnBodies } = await mockBackend(page, OK_SPAWN);
    await gotoTerminal(page);

    await openViaPalette(page);
    const task = page.getByLabel("Task");
    await task.fill("fix the bug");
    await task.press("Enter");

    // Navigates to the returned windowId (@7 → URL segment `7`).
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/7(?:$|[/?#])`), { timeout: 5_000 });
    // The POST carried the task + session (server rides ?server=). Defaults-only
    // body omits where/tier (worktree + default are the backend defaults).
    await expect.poll(() => spawnBodies().length).toBeGreaterThan(0);
    expect(spawnBodies()[0]).toMatchObject({ task: "fix the bug", session: "dev" });
    expect(spawnBodies()[0]).not.toHaveProperty("where");
    expect(spawnBodies()[0]).not.toHaveProperty("tier");
  });

  /**
   * Proves: selecting "this checkout" and a non-default tier sends those
   * choices in the POST body (and omits `worktreeName` in checkout mode),
   * then navigates on success.
   *
   * Steps:
   * 1. Mock the backend (OK_SPAWN); gotoTerminal; openViaPalette.
   * 2. Check the "this checkout" radio; select tier "doing" in the Agent
   *    dropdown.
   * 3. Fill the `Task` field with "explore the code"; press Enter.
   * 4. Assert the URL navigated to /default/7.
   * 5. Assert the captured POST body matches
   *    { task: "explore the code", session: "dev", where: "checkout",
   *    tier: "doing" } and carries no `worktreeName`.
   */
  test("a checkout + tier task-submit carries where and tier in the POST body", async ({ page }) => {
    const { spawnBodies } = await mockBackend(page, OK_SPAWN);
    await gotoTerminal(page);

    await openViaPalette(page);
    await expect(page.getByRole("dialog", { name: "Spawn agent in dev" })).toBeVisible({ timeout: 5_000 });
    await page.getByRole("radio", { name: /this checkout/i }).check();
    await page.getByLabel("Agent tier", { exact: true }).selectOption("doing");
    const task = page.getByLabel("Task");
    await task.fill("explore the code");
    await task.press("Enter");

    await expect(page).toHaveURL(new RegExp(`/${SERVER}/7(?:$|[/?#])`), { timeout: 5_000 });
    await expect.poll(() => spawnBodies().length).toBeGreaterThan(0);
    expect(spawnBodies()[0]).toMatchObject({
      task: "explore the code",
      session: "dev",
      where: "checkout",
      tier: "doing",
    });
    // No worktree name in checkout mode.
    expect(spawnBodies()[0]).not.toHaveProperty("worktreeName");
  });

  /**
   * Proves: a 400 (e.g. non-repo cwd) renders the error message inside the
   * still-open dialog and performs no navigation (nothing was created).
   *
   * Steps:
   * 1. Mock POST /api/riff → 400 {error: "The session's working directory
   *    is not inside a git repository"}.
   * 2. gotoTerminal; openViaPalette; fill the `Task` field; press Enter.
   * 3. Assert the error text is visible, the `Spawn agent in dev` dialog is
   *    still visible, and the URL is unchanged (/default/1).
   */
  test("a 400 renders its error in-dialog and does not navigate", async ({ page }) => {
    await mockBackend(page, {
      spawnStatus: 400,
      spawnBody: JSON.stringify({ error: "The session's working directory is not inside a git repository" }),
      presets: [],
    });
    await gotoTerminal(page);

    await openViaPalette(page);
    const task = page.getByLabel("Task");
    await task.fill("whatever");
    await task.press("Enter");

    // Error is shown in-dialog; the dialog stays open and the URL is unchanged.
    await expect(page.getByText(/not inside a git repository/i)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("dialog", { name: "Spawn agent in dev" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${SERVER}/1(?:$|[/?#])`));
  });

  /**
   * Proves: the fab gate — when the presets endpoint returns `tiers: []` (a
   * git repo that is not a fab project), the dialog hides the Agent Tier
   * field entirely (no label, no control), while the rest of the dialog is
   * unaffected.
   *
   * Steps:
   * 1. Mock the backend with { ...OK_SPAWN, tiers: [] }; gotoTerminal;
   *    openViaPalette.
   * 2. Assert the `Spawn agent in dev` dialog and its `Task` field are
   *    visible.
   * 3. Assert the `Agent tier` control has count 0 (absent).
   */
  test("a non-fab repo (tiers: []) renders the dialog WITHOUT the Agent Tier field", async ({ page }) => {
    // The fab gate (gsmu): a non-fab repo's presets endpoint returns tiers:[],
    // so the dialog hides the Agent Tier field entirely.
    await mockBackend(page, { ...OK_SPAWN, tiers: [] });
    await gotoTerminal(page);

    await openViaPalette(page);
    await expect(page.getByRole("dialog", { name: "Spawn agent in dev" })).toBeVisible({ timeout: 5_000 });
    // The dialog is up (Task always present) but the Agent Tier field is absent.
    await expect(page.getByLabel("Task")).toBeVisible();
    await expect(page.getByLabel("Agent tier", { exact: true })).toHaveCount(0);
  });

  /**
   * Proves: the third entry point — the session flyout card's `Spawn agent…`
   * row in the sidebar — opens the spawn dialog targeting that row's session.
   *
   * Steps:
   * 1. Mock the backend (OK_SPAWN); gotoTerminal.
   * 2. openViaSidebarCard(page, "dev") — hover the `dev` session row until
   *    ITS flyout card is the open one, enter the card at the row's own
   *    band, then click the card's `Spawn agent…` action row.
   * 3. Assert the `Spawn agent in dev` dialog and its `Task` field are
   *    visible.
   */
  test("the sidebar session-card spawn row opens the dialog titled with the row's session", async ({ page }) => {
    // The third entry point: the session flyout card's Spawn agent… row.
    await mockBackend(page, OK_SPAWN);
    await gotoTerminal(page);

    await openViaSidebarCard(page, "dev");

    await expect(page.getByRole("dialog", { name: "Spawn agent in dev" })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByLabel("Task")).toBeVisible();
  });
});
