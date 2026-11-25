import { test, expect, type Page } from "@playwright/test";
import { emitSessions, mockStateSocket } from "./_state-socket-mock";

// Agent-preset controls on the group and workspace cards. Everything is
// browser-mocked: `/api/servers` and `/ws/state` carry the current workspace
// and group presets, `/api/fab-config` supplies the preset list and machine
// default, `/api/riff/presets` supplies the repo list, and both preset POST
// routes record bodies and update the mocked state. The coarse describe also
// stubs pointer media queries and opens the mobile drawer before using the
// group row's status rail. No real fab, tmux, or machine config is touched.

const SERVER = "default";
const PRESETS = [
  { name: "claude", description: "All roles on Claude", source: "built-in" },
  { name: "codex-review", description: "Only the review role on Codex", source: "built-in" },
];

function sessionsJson(groupPreset: string | undefined) {
  return JSON.stringify([
    {
      name: "dev",
      ...(groupPreset ? { agent_preset: groupPreset } : {}),
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

type ServerFlags = { protected?: boolean; managed?: boolean };

async function mockBackend(page: Page, options: { workspacePreset?: string; serverFlags?: ServerFlags } = {}) {
  let groupPreset: string | undefined;
  let workspacePreset = options.workspacePreset;
  const groupPosts: Array<Record<string, unknown>> = [];
  const workspacePosts: Array<Record<string, unknown>> = [];

  await page.routeWebSocket(/\/ws\/terminals/, () => {});
  await page.route("**/api/boards", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      json: [
        {
          name: SERVER,
          sessionCount: 1,
          ...options.serverFlags,
          ...(workspacePreset ? { agent_preset: workspacePreset } : {}),
        },
      ],
    }),
  );
  await page.route("**/api/fab-config", (route) =>
    route.fulfill({
      json: {
        installed: true,
        agent_presets: PRESETS,
        fields: { "agent.preset": { value: "claude", origin: "system" } },
      },
    }),
  );
  await page.route("**/api/riff/presets*", (route) =>
    route.fulfill({ json: { riff_presets: [], tiers: [], agent_presets: PRESETS } }),
  );
  await page.route("**/api/sessions/dev/agent-preset*", async (route) => {
    const body = route.request().postDataJSON() as { agent_preset: string | null };
    groupPosts.push(body);
    groupPreset = body.agent_preset ?? undefined;
    await emitSessions(SERVER, sessionsJson(groupPreset));
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/servers/agent-preset", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    workspacePosts.push(body);
    workspacePreset = typeof body.agent_preset === "string" ? body.agent_preset : undefined;
    await route.fulfill({ json: { ok: true } });
  });
  await mockStateSocket(page, { sessions: sessionsJson(groupPreset) });
  return { groupPosts, workspacePosts };
}

async function gotoTerminal(page: Page) {
  await page.goto(`/${SERVER}/1`);
  await expect(page.locator(`[data-session-row="${SERVER}:dev"]`)).toBeVisible({ timeout: 10_000 });
}

async function openGroupChooser(page: Page) {
  await page.mouse.move(700, 500);
  await page.locator(`[data-session-row="${SERVER}:dev"]`).hover();
  const card = page.getByTestId("row-flyout-card");
  await expect(card).toBeVisible();
  await card.getByTestId("row-flyout-agent-preset-action").click();
  await expect(card).toHaveCount(0);
  return page.getByRole("radiogroup", { name: "Agent preset for dev" });
}

async function openWorkspaceChooser(page: Page) {
  await page.mouse.move(700, 500);
  const tile = page.getByRole("listbox", { name: "Workspaces" }).getByRole("option", { name: /default/ });
  await tile.hover();
  const card = page.getByTestId("row-flyout-card");
  await expect(card).toBeVisible();
  await card.getByTestId("row-flyout-agent-preset-action").click();
  await expect(card).toHaveCount(0);
  return page.getByRole("radiogroup", { name: "Agent preset for default" });
}

async function expectWorkspaceTileGeometry(page: Page) {
  const tile = page.getByRole("listbox", { name: "Workspaces" }).getByRole("option", { name: /default/ });
  const name = tile.getByText("default", { exact: true });
  const marker = tile.getByTestId("agent-preset-marker");
  await expect(name).toBeVisible();
  await expect(marker).toBeVisible();
  const tileBox = (await tile.boundingBox())!;
  const nameBox = (await name.boundingBox())!;
  const markerBox = (await marker.boundingBox())!;
  expect(nameBox.width).toBeGreaterThan(0);
  expect(markerBox.width).toBeGreaterThan(0);
  for (const box of [nameBox, markerBox]) {
    expect(box.x).toBeGreaterThanOrEqual(tileBox.x);
    expect(box.x + box.width).toBeLessThanOrEqual(tileBox.x + tileBox.width + 0.5);
    expect(box.y).toBeGreaterThanOrEqual(tileBox.y);
    expect(box.y + box.height).toBeLessThanOrEqual(tileBox.y + tileBox.height + 0.5);
  }
}

function mockCoarsePointer(page: Page) {
  return page.addInitScript(() => {
    const original = window.matchMedia;
    window.matchMedia = function (query: string) {
      if (query === "(pointer: coarse)" || query === "(any-pointer: coarse)") {
        return {
          matches: true,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          onchange: null,
          dispatchEvent: () => true,
        } as MediaQueryList;
      }
      return original.call(window, query);
    };
  });
}

test.describe("agent preset cards", () => {
  /**
   * Proves: the group card resolves inheritance, opens a keyboard-accessible
   * chooser, and set / none / inherit update the existing route and own-only
   * row marker.
   *
   * Steps:
   * 1. Open the group card and assert the machine-default line and hint.
   *    Open the chooser and assert it sits fully inside the viewport (it is
   *    wider than the sidebar row it anchors to).
   * 2. Arrow to codex-review and press Enter; assert its POST and marker.
   * 3. Pick none; assert its POST and literal none marker.
   * 4. Pick inherit; assert a null POST and the marker disappears.
   */
  test("group chooser supports keyboard set, none and inherit with row-marker updates", async ({ page }) => {
    test.setTimeout(30_000);
    const { groupPosts } = await mockBackend(page);
    await gotoTerminal(page);

    await page.locator(`[data-session-row="${SERVER}:dev"]`).hover();
    const card = page.getByTestId("row-flyout-card");
    await expect(card.getByTestId("row-flyout-agent-preset")).toHaveText(
      "agent preset: claude · machine default",
    );
    await card.getByTestId("row-flyout-agent-preset-action").click();
    const chooser = page.getByRole("radiogroup", { name: "Agent preset for dev" });
    await expect(chooser.getByRole("radio", { name: /^codex-review/ })).toBeVisible();
    await expect(chooser.getByRole("radio", { name: /inherit/ })).toBeFocused();
    const chooserBox = (await chooser.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(chooserBox.x).toBeGreaterThanOrEqual(0);
    expect(chooserBox.x + chooserBox.width).toBeLessThanOrEqual(viewport.width);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(chooser.getByRole("radio", { name: /^codex-review/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => groupPosts.length).toBe(1);
    expect(groupPosts[0]).toEqual({ agent_preset: "codex-review" });
    const groupRow = page.locator(`[data-session-row="${SERVER}:dev"]`);
    await expect(groupRow.getByTestId("agent-preset-marker")).toHaveText("codex-review");

    let next = await openGroupChooser(page);
    await next.getByRole("radio", { name: /^none/ }).click();
    await expect.poll(() => groupPosts.length).toBe(2);
    expect(groupPosts[1]).toEqual({ agent_preset: "none" });
    await expect(groupRow.getByTestId("agent-preset-marker")).toHaveText("none");

    next = await openGroupChooser(page);
    await next.getByRole("radio", { name: /inherit/ }).click();
    await expect.poll(() => groupPosts.length).toBe(3);
    expect(groupPosts[2]).toEqual({ agent_preset: null });
    await expect(groupRow.getByTestId("agent-preset-marker")).toHaveCount(0);
  });

  /**
   * Proves: the workspace tile's shared card offers the same chooser and sends
   * set / none / inherit to the workspace route with the workspace name.
   *
   * Steps:
   * 1. Open the workspace card and assert its machine-default line. Open the
   *    chooser and assert it sits fully inside the viewport (it is wider than
   *    the tile it anchors to).
   * 2. Pick codex-review; assert the route body and own-preset tile marker.
   * 3. Pick none; assert the route body and literal none marker.
   * 4. Pick inherit; assert the null body and marker removal.
   */
  test("workspace chooser supports set, none and inherit", async ({ page }) => {
    test.setTimeout(30_000);
    const { workspacePosts } = await mockBackend(page);
    await gotoTerminal(page);

    await page.getByRole("listbox", { name: "Workspaces" }).getByRole("option", { name: /default/ }).hover();
    const card = page.getByTestId("row-flyout-card");
    await expect(card.getByTestId("row-flyout-agent-preset")).toHaveText(
      "agent preset: claude · machine default",
    );
    await card.getByTestId("row-flyout-agent-preset-action").click();
    const first = page.getByRole("radiogroup", { name: "Agent preset for default" });
    await expect(first).toBeVisible();
    const firstBox = (await first.boundingBox())!;
    expect(firstBox.x).toBeGreaterThanOrEqual(0);
    expect(firstBox.x + firstBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await first.getByRole("radio", { name: /^codex-review/ }).click();
    await expect.poll(() => workspacePosts.length).toBe(1);
    expect(workspacePosts[0]).toEqual({ name: SERVER, agent_preset: "codex-review" });
    const tile = page.getByRole("listbox", { name: "Workspaces" }).getByRole("option", { name: /default/ });
    await expect(tile.getByTestId("agent-preset-marker")).toHaveText("codex-review");

    let next = await openWorkspaceChooser(page);
    await next.getByRole("radio", { name: /^none/ }).click();
    await expect.poll(() => workspacePosts.length).toBe(2);
    expect(workspacePosts[1]).toEqual({ name: SERVER, agent_preset: "none" });
    await expect(tile.getByTestId("agent-preset-marker")).toHaveText("none");

    next = await openWorkspaceChooser(page);
    await next.getByRole("radio", { name: /inherit/ }).click();
    await expect.poll(() => workspacePosts.length).toBe(3);
    expect(workspacePosts[2]).toEqual({ name: SERVER, agent_preset: null });
    await expect(tile.getByTestId("agent-preset-marker")).toHaveCount(0);
  });

  /**
   * Proves: a desktop Workspaces tile keeps both the workspace name and its
   * own-preset chip rendered instead of collapsing either one.
   *
   * Steps:
   * 1. Use a 1280×720 viewport and a workspace with own codex-review.
   * 2. Locate the workspace name and marker on its tile.
   * 3. Assert both have non-zero width and stay inside the tile's box.
   */
  test("desktop tile keeps the workspace name and preset marker visible", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await mockBackend(page, { workspacePreset: "codex-review" });
    await gotoTerminal(page);
    await expectWorkspaceTileGeometry(page);
  });
});

test.describe("agent preset cards on coarse pointers", () => {
  test.use({ hasTouch: true, viewport: { width: 375, height: 812 } });

  /**
   * Proves: a 375px touch viewport can open the group card from its status
   * rail and use the same anchored chooser without viewport overflow.
   *
   * Steps:
   * 1. Open the mobile drawer and tap the group row's status rail.
   * 2. Tap Agent preset… and assert the chooser and touch-sized entries.
   * 3. Assert the chooser stays inside the viewport and pick none.
   * 4. Assert the group route receives the reserved opt-out value.
   */
  test("mobile rail opens a viewport-contained chooser", async ({ page }) => {
    test.setTimeout(30_000);
    const { groupPosts } = await mockBackend(page);
    await mockCoarsePointer(page);
    await page.goto(`/${SERVER}/1`);
    await page.getByRole("button", { name: "Toggle navigation" }).tap();
    const row = page.locator(`[data-session-row="${SERVER}:dev"]`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByTestId("status-rail").tap();
    await page.getByTestId("row-flyout-agent-preset-action").tap();

    const chooser = page.getByRole("radiogroup", { name: "Agent preset for dev" });
    await expect(chooser).toBeVisible();
    const none = chooser.getByRole("radio", { name: /^none/ });
    expect((await none.boundingBox())!.height).toBeGreaterThanOrEqual(36);
    const box = (await chooser.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(box.y + box.height).toBeLessThanOrEqual(812);
    await none.tap();
    await expect.poll(() => groupPosts.length).toBe(1);
    expect(groupPosts[0]).toEqual({ agent_preset: "none" });
  });

  /**
   * Proves: the 375px mobile Workspaces tile also keeps both the workspace
   * name and own-preset chip rendered inside the tile.
   *
   * Steps:
   * 1. Mock a coarse pointer and a workspace with own codex-review.
   * 2. Open the mobile drawer and locate the tile's name and marker.
   * 3. Assert both have non-zero width and stay inside the tile's box.
   */
  test("mobile tile keeps the workspace name and preset marker visible", async ({ page }) => {
    await mockBackend(page, { workspacePreset: "codex-review" });
    await mockCoarsePointer(page);
    await page.goto(`/${SERVER}/1`);
    await page.getByRole("button", { name: "Toggle navigation" }).tap();
    await expectWorkspaceTileGeometry(page);
  });

  /**
   * Proves: on the 375px mobile Workspaces tile, a workspace that is both
   * protected and external still shows its own-preset chip — the shield and
   * external glyphs fill the name line, so the chip must stay visible on the
   * count row instead of being clipped off the tile.
   *
   * Steps:
   * 1. Mock a coarse pointer and a protected, unmanaged (external) workspace
   *    with own codex-review.
   * 2. Open the mobile drawer and assert both glyphs render on the tile.
   * 3. Assert the name and marker have non-zero width inside the tile's box.
   * 4. Assert the marker sits on its own row below the name, with at least
   *    three characters' worth of visible width.
   */
  test("mobile protected external tile keeps its preset marker visible", async ({ page }) => {
    await mockBackend(page, { workspacePreset: "codex-review", serverFlags: { protected: true, managed: false } });
    await mockCoarsePointer(page);
    await page.goto(`/${SERVER}/1`);
    await page.getByRole("button", { name: "Toggle navigation" }).tap();
    const tile = page.getByRole("listbox", { name: "Workspaces" }).getByRole("option", { name: /default/ });
    await expect(tile.getByTestId(`shield-${SERVER}`)).toBeVisible();
    await expect(tile.getByTestId(`external-${SERVER}`)).toBeVisible();
    await expectWorkspaceTileGeometry(page);
    const nameBox = (await tile.getByText(SERVER, { exact: true }).boundingBox())!;
    const markerBox = (await tile.getByTestId("agent-preset-marker").boundingBox())!;
    expect(markerBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 0.5);
    expect(markerBox.width).toBeGreaterThanOrEqual(18);
  });
});
