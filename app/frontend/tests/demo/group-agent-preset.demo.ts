/**
 * Demo: a group can carry its own agent preset. `Group: Set Agent Preset…`
 * (command palette) opens a chooser of fab's presets plus `none`; choosing
 * `codex-workers` makes the group's flyout card read `agent preset:
 * codex-workers`, and the spawn dialog then labels its inherit option `Group
 * default: codex-workers` — i.e. a new tab in that group launches under the
 * group's preset instead of the machine default.
 *
 * Runs only under `just demo group-agent-preset` (playwright.demo.config.ts —
 * testDir ./tests/demo), against the throwaway e2e rig, once per project
 * (desktop 1280x800, mobile 375x812). On mobile the sidebar is a drawer, so the
 * card step is skipped there; the palette and spawn-dialog steps are the same.
 *
 * Shared setup: everything the flow reads is stubbed in the browser, so the
 * recording never touches fab, tmux or the developer's config. `/api/fab-config`
 * lists fab 2.31.1's three built-in presets (the palette's availability signal);
 * `GET /api/riff/presets*` returns the repo-scoped list plus the inherited pick
 * derived from the stub's current group preset; `POST
 * /api/sessions/dev/agent-preset*` records the choice and pushes a fresh
 * `sessions` event over the mocked state socket, standing in for the backend's
 * SSE repaint.
 */
import { test, expect, beat } from "./_demo";
import { openPalette } from "../e2e/_ready";
import { emitSessions, mockStateSocket } from "../e2e/_state-socket-mock";

const SERVER = "default";

const PRESETS = [
  { name: "claude", description: "All roles on Claude (today's defaults)", source: "built-in", session: "claude", workers: "claude" },
  { name: "codex-review", description: "Only the review role on Codex", source: "built-in", profiles: { review: { cli: "codex" } } },
  { name: "codex-workers", description: "Pipeline workers on Codex; session on Claude", source: "built-in", workers: "codex" },
];

function sessionsJson(agentPreset: string | undefined): string {
  return JSON.stringify([
    {
      name: "dev",
      ...(agentPreset ? { agent_preset: agentPreset } : {}),
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

test.describe("group-agent-preset demo", () => {
  /**
   * Proves: a reviewer can watch a group preset being set from the palette,
   * shown on the group's card, and picked up by the spawn dialog as the group
   * default.
   *
   * Steps:
   * 1. Install the stubs (no group preset yet); load `/default/1`.
   * 2. Run `Group: Set Agent Preset…` from the palette; assert the chooser lists
   *    the three presets plus `none`; `beat()`.
   * 3. Choose `codex-workers`; the stub records it and pushes the sessions event.
   * 4. Desktop only: hover the `dev` row; assert the card reads `agent preset:
   *    codex-workers`; `beat()`.
   * 5. Run `Agent: Spawn`; assert the Agent preset field's inherit option reads
   *    `Group default: codex-workers`; `beat()`.
   */
  test("setting a group agent preset from the palette changes what its spawn dialog inherits", async ({ page }, testInfo) => {
    let groupPreset: string | undefined;

    await page.routeWebSocket(/\/ws\/terminals/, () => {});
    await page.route("**/api/servers", (route) =>
      route.fulfill({ json: [{ name: SERVER, sessionCount: 1 }] }),
    );
    await page.route("**/api/fab-config", (route) =>
      route.fulfill({ json: { installed: true, agent_presets: PRESETS } }),
    );
    await page.route("**/api/riff/presets*", (route) =>
      route.fulfill({
        json: {
          riff_presets: [
            { name: "discuss", layout: "", paneCount: 1 },
            { name: "blank", layout: "", paneCount: 1 },
          ],
          tiers: ["default", "doing", "fast", "operator", "review"],
          agent_presets: PRESETS,
          ...(groupPreset ? { agent_preset_inherited: { name: groupPreset, from: "group" } } : {}),
        },
      }),
    );
    await page.route("**/api/sessions/dev/agent-preset*", (route) => {
      const body = route.request().postDataJSON() as { agent_preset: string | null };
      groupPreset = body.agent_preset ?? undefined;
      emitSessions(SERVER, sessionsJson(groupPreset));
      return route.fulfill({ json: { ok: true } });
    });
    await mockStateSocket(page, { sessions: sessionsJson(undefined) });

    await page.goto(`/${SERVER}/1`);
    // The window heading is the one place the window name shows on both viewports
    // (the sidebar that lists it is a drawer on mobile).
    await expect(page.getByRole("button", { name: "Rename tab main" })).toBeVisible({ timeout: 10_000 });
    await beat(page);

    const palette = await openPalette(page);
    await palette.fill("Group: Set Agent Preset");
    await beat(page, 800);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("option", { name: /^codex-workers/ })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("option", { name: /^none/ })).toBeVisible();
    await beat(page, 1_500);
    await page.getByRole("option", { name: /^codex-workers/ }).click();
    await expect.poll(() => groupPreset).toBe("codex-workers");

    if (testInfo.project.name !== "mobile") {
      const row = page.locator(`[data-session-row="${SERVER}:dev"]`);
      const card = page.getByTestId("row-flyout-card");
      await expect(async () => {
        await page.mouse.move(700, 500);
        await row.hover();
        await expect(card).toContainText("agent preset: codex-workers", { timeout: 3_000 });
      }).toPass({ timeout: 15_000 });
      await beat(page, 2_000);
      await page.mouse.move(700, 500);
      await expect(card).toHaveCount(0);
    }

    const spawn = await openPalette(page);
    await spawn.fill("Agent: Spawn");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Spawn agent in dev" })).toBeVisible({ timeout: 5_000 });
    const field = page.getByLabel("Agent preset");
    await expect(field.locator("option:checked")).toHaveText("Group default: codex-workers", { timeout: 5_000 });
    await beat(page, 2_000);
  });
});
