import { test, expect, type Page } from "@playwright/test";
import { openPalette } from "./_ready";
import { mockStateSocket } from "./_state-socket-mock";

// Group and workspace agent presets from the command palette — `Group: Set
// Agent Preset…`, `Group: Clear Agent Preset`, `Workspace: Set Agent Preset…`,
// `Workspace: Clear Agent Preset`. Set opens the palette's single-select
// chooser (one row per fab preset plus `none`) and POSTs the matching route;
// Clear exists only while the group/workspace carries a preset; Set is hidden
// when fab reports no presets.
//
// Shared setup: fully mocked — no tmux, no wt, no fab, no real backend.
// Injected via page.route: `**/api/servers` → a single server `default`
// (carrying `agent_preset` when a test sets one); `/ws/state` (via
// mockStateSocket) → session `dev` with one active window `@1` "main" (carrying
// `agent_preset` when a test sets one); `**/api/fab-config` → the machine-wide
// preset list (`installed` + `agent_presets`, omitted to model a fab that
// cannot list presets); `**/api/riff/presets*` → the group chooser's repo-scoped
// list; the two POST routes capture their bodies and answer `{ok:true}`; the
// terminals mux WebSocket (`/ws/terminals`) is stubbed. Trailing `*` globs
// because the client's withServer appends `?server=`.

const SERVER = "default";

const PRESETS = [
  { name: "claude", description: "All roles on Claude", source: "built-in" },
  { name: "codex-review", description: "Only the review role on Codex", source: "built-in" },
];

type Mock = {
  /** The group's current agent preset (session payload), if any. */
  groupPreset?: string;
  /** The workspace's current agent preset (servers payload), if any. */
  workspacePreset?: string;
  /** False models a fab that cannot list presets. */
  presets?: boolean;
};

async function mockBackend(page: Page, mock: Mock) {
  const groupPosts: Record<string, unknown>[] = [];
  const workspacePosts: Record<string, unknown>[] = [];
  const presets = mock.presets !== false;

  await page.routeWebSocket(/\/ws\/terminals/, () => {});
  await page.route("**/api/windows/*/select*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }),
  );
  await page.route("**/api/servers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { name: SERVER, sessionCount: 1, ...(mock.workspacePreset ? { agent_preset: mock.workspacePreset } : {}) },
      ]),
    }),
  );
  await mockStateSocket(page, {
    sessions: JSON.stringify([
      {
        name: "dev",
        ...(mock.groupPreset ? { agent_preset: mock.groupPreset } : {}),
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
    ]),
  });
  await page.route("**/api/fab-config", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ installed: true, ...(presets ? { agent_presets: PRESETS } : {}) }),
    }),
  );
  await page.route("**/api/riff/presets*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ riff_presets: [], tiers: [], ...(presets ? { agent_presets: PRESETS } : {}) }),
    }),
  );
  await page.route("**/api/sessions/dev/agent-preset*", async (route) => {
    groupPosts.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  });
  await page.route("**/api/servers/agent-preset", async (route) => {
    workspacePosts.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  });
  return { groupPosts: () => groupPosts, workspacePosts: () => workspacePosts };
}

async function gotoTerminal(page: Page) {
  await page.goto(`/${SERVER}/1`);
  await expect(page.getByText("main").first()).toBeVisible({ timeout: 10_000 });
}

/** Type `query` into the palette; the result rows are its `option`s. */
async function searchPalette(page: Page, query: string) {
  const input = await openPalette(page);
  await input.fill(query);
}

test.describe("Agent preset palette actions", () => {
  /**
   * Proves: `Group: Set Agent Preset…` lists fab's presets plus `none` in a
   * chooser, and choosing one POSTs the group route with that name.
   *
   * Steps:
   * 1. Mock the backend (no preset set yet); gotoTerminal.
   * 2. Open the palette, search `Group: Set Agent Preset`, press Enter.
   * 3. Assert the chooser lists claude, codex-review and none.
   * 4. Click `codex-review`.
   * 5. Assert exactly one POST reached the group route with
   *    { agent_preset: "codex-review" }.
   */
  test("Group: Set Agent Preset… chooses a preset and POSTs the group route", async ({ page }) => {
    const { groupPosts } = await mockBackend(page, {});
    await gotoTerminal(page);

    await searchPalette(page, "Group: Set Agent Preset");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: /^claude/ })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("option", { name: /^none/ })).toBeVisible();
    await page.getByRole("option", { name: /^codex-review/ }).click();

    await expect.poll(() => groupPosts().length).toBe(1);
    expect(groupPosts()[0]).toEqual({ agent_preset: "codex-review" });
  });

  /**
   * Proves: `Group: Clear Agent Preset` appears only while the group has a
   * preset, and running it POSTs the group route with a null name.
   *
   * Steps:
   * 1. Mock the backend with the group carrying `claude`; gotoTerminal.
   * 2. Open the palette, search `Group: Clear Agent Preset`; assert the row
   *    is offered and press Enter.
   * 3. Assert the group route received { agent_preset: null }.
   * 4. Reload against a group with no preset (fresh mock); assert the Clear
   *    row is absent while `Group: Set Agent Preset…` remains.
   */
  test("Group: Clear Agent Preset exists only when the group has one and POSTs null", async ({ page }) => {
    const set = await mockBackend(page, { groupPreset: "claude" });
    await gotoTerminal(page);

    await searchPalette(page, "Group: Clear Agent Preset");
    await expect(page.getByRole("option", { name: "Group: Clear Agent Preset" })).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Enter");
    await expect.poll(() => set.groupPosts().length).toBe(1);
    expect(set.groupPosts()[0]).toEqual({ agent_preset: null });

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockBackend(page, {});
    await page.reload();
    await expect(page.getByText("main").first()).toBeVisible({ timeout: 10_000 });
    await searchPalette(page, "Agent Preset");
    await expect(page.getByRole("option", { name: "Group: Set Agent Preset…" })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("option", { name: "Group: Clear Agent Preset" })).toHaveCount(0);
  });

  /**
   * Proves: the workspace pair works the same way against the server route —
   * Set chooses a preset (including `none`) and Clear (offered because the
   * workspace carries one) POSTs null.
   *
   * Steps:
   * 1. Mock the backend with the workspace carrying `claude`; gotoTerminal.
   * 2. Search `Workspace: Set Agent Preset`, Enter, click `none`.
   * 3. Assert the server route received { name: "default", agent_preset: "none" }.
   * 4. Search `Workspace: Clear Agent Preset`, Enter.
   * 5. Assert the server route then received { name: "default", agent_preset: null }.
   */
  test("Workspace: Set and Clear Agent Preset POST the server route", async ({ page }) => {
    const { workspacePosts } = await mockBackend(page, { workspacePreset: "claude" });
    await gotoTerminal(page);

    await searchPalette(page, "Workspace: Set Agent Preset");
    await page.keyboard.press("Enter");
    await page.getByRole("option", { name: /^none/ }).click();
    await expect.poll(() => workspacePosts().length).toBe(1);
    expect(workspacePosts()[0]).toEqual({ name: SERVER, agent_preset: "none" });

    await searchPalette(page, "Workspace: Clear Agent Preset");
    await expect(page.getByRole("option", { name: "Workspace: Clear Agent Preset" })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect.poll(() => workspacePosts().length).toBe(2);
    expect(workspacePosts()[1]).toEqual({ name: SERVER, agent_preset: null });
  });

  /**
   * Proves: when fab reports no presets the Set actions are hidden entirely
   * (Clear stays, since clearing needs no fab).
   *
   * Steps:
   * 1. Mock the backend with `presets: false` and a group preset set;
   *    gotoTerminal.
   * 2. Open the palette, search `Agent Preset`.
   * 3. Assert both Set actions are absent and `Group: Clear Agent Preset` is
   *    offered.
   */
  test("hides both Set actions when fab lists no presets", async ({ page }) => {
    await mockBackend(page, { presets: false, groupPreset: "stale" });
    await gotoTerminal(page);

    await searchPalette(page, "Agent Preset");
    await expect(page.getByRole("option", { name: "Group: Clear Agent Preset" })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("option", { name: /Set Agent Preset/ })).toHaveCount(0);
  });
});
