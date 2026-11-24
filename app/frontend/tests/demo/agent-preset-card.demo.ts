/**
 * Demo: set a group's agent preset from its card, see the own-preset marker,
 * then set and clear a workspace preset through the same chooser. The card
 * line names the effective preset and its inheritance source throughout.
 *
 * Runs under `just demo agent-preset-card` on desktop and mobile. Every read
 * and write is stubbed in the browser: the state socket carries the group's
 * current preset, `/api/servers` carries the workspace's, `/api/fab-config`
 * supplies the machine list and default, and both POST routes update that
 * mocked state. Mobile uses the drawer and status rails instead of hover.
 */
import type { Page } from "@playwright/test";
import { test, expect, beat } from "./_demo";
import { emitSessions, mockStateSocket } from "../e2e/_state-socket-mock";

const SERVER = "default";
const PRESETS = [
  { name: "claude", description: "All roles on Claude (today's defaults)", source: "built-in" },
  { name: "codex-review", description: "Only the review role on Codex", source: "built-in" },
  { name: "codex-workers", description: "Pipeline workers on Codex; session on Claude", source: "built-in" },
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

async function openCard(page: Page, kind: "group" | "workspace", mobile: boolean) {
  const row = kind === "group"
    ? page.locator(`[data-session-row="${SERVER}:dev"]`)
    : page.locator(`[data-server="${SERVER}"]`);
  const card = page.getByTestId("row-flyout-card");
  await expect(async () => {
    if (mobile) {
      await row.getByTestId("status-rail").tap();
    } else {
      await page.mouse.move(700, 500);
      await row.hover();
    }
    await expect(card).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 10_000 });
  return card;
}

test.describe("agent-preset-card demo", () => {
  /**
   * Proves: the card line, chooser and row marker provide a complete mouse or
   * touch path for group and workspace presets, including inherit.
   *
   * Steps:
   * 1. Open the group card, show its machine-default line, and open the chooser.
   * 2. Pick codex-workers and show the marker on the group row.
   * 3. Open the workspace card, pick codex-review, and show its marker.
   * 4. Reopen the workspace chooser and pick inherit; the marker disappears.
   */
  test("group and workspace cards set and inherit agent presets", async ({ page }, testInfo) => {
    const mobile = testInfo.project.name === "mobile";
    let groupPreset: string | undefined;
    let workspacePreset: string | undefined;

    await page.routeWebSocket(/\/ws\/terminals/, () => {});
    await page.route("**/api/boards", (route) => route.fulfill({ json: [] }));
    await page.route("**/api/servers", (route) =>
      route.fulfill({
        json: [{ name: SERVER, sessionCount: 1, ...(workspacePreset ? { agent_preset: workspacePreset } : {}) }],
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
      groupPreset = body.agent_preset ?? undefined;
      await emitSessions(SERVER, sessionsJson(groupPreset));
      await route.fulfill({ json: { ok: true } });
    });
    await page.route("**/api/servers/agent-preset", async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      workspacePreset = typeof body.agent_preset === "string" ? body.agent_preset : undefined;
      await route.fulfill({ json: { ok: true } });
    });
    await mockStateSocket(page, { sessions: sessionsJson(groupPreset) });

    await page.goto(`/${SERVER}/1`);
    await expect(page.getByRole("button", { name: "Rename tab main" })).toBeVisible({ timeout: 10_000 });
    if (mobile) {
      await page.getByRole("button", { name: "Toggle navigation" }).tap();
      await expect(page.locator(`[data-session-row="${SERVER}:dev"]`)).toBeVisible();
    }
    await beat(page);

    let card = await openCard(page, "group", mobile);
    await expect(card.getByTestId("row-flyout-agent-preset")).toHaveText("agent preset: claude · machine default");
    await beat(page, 1_200);
    await card.getByTestId("row-flyout-agent-preset-action").click();
    let chooser = page.getByRole("radiogroup", { name: "Agent preset for dev" });
    await expect(chooser.getByRole("radio", { name: /^codex-workers/ })).toBeVisible();
    await beat(page, 1_500);
    await chooser.getByRole("radio", { name: /^codex-workers/ }).click();
    await expect.poll(() => groupPreset).toBe("codex-workers");
    await expect(page.locator(`[data-session-row="${SERVER}:dev"]`).getByTestId("agent-preset-marker"))
      .toHaveText("codex-workers");
    await beat(page, 1_500);

    card = await openCard(page, "workspace", mobile);
    await expect(card.getByTestId("row-flyout-agent-preset")).toHaveText("agent preset: claude · machine default");
    await beat(page, 1_000);
    await card.getByTestId("row-flyout-agent-preset-action").click();
    chooser = page.getByRole("radiogroup", { name: "Agent preset for default" });
    await chooser.getByRole("radio", { name: /^codex-review/ }).click();
    await expect.poll(() => workspacePreset).toBe("codex-review");
    await expect(page.locator(`[data-server="${SERVER}"]`).getByTestId("agent-preset-marker"))
      .toHaveText("codex-review");
    await beat(page, 1_500);

    card = await openCard(page, "workspace", mobile);
    await card.getByTestId("row-flyout-agent-preset-action").click();
    chooser = page.getByRole("radiogroup", { name: "Agent preset for default" });
    await expect(chooser.getByRole("radio", { name: /inherit/ })).toBeVisible();
    await beat(page, 1_000);
    await chooser.getByRole("radio", { name: /inherit/ }).click();
    await expect.poll(() => workspacePreset).toBeUndefined();
    await expect(page.locator(`[data-server="${SERVER}"]`).getByTestId("agent-preset-marker")).toHaveCount(0);
    await beat(page, 1_500);
  });
});
