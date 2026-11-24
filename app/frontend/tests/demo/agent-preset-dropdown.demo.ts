/**
 * Demo: the Settings dialog's Agents tab gains an Agent preset dropdown — one
 * named role assignment for the machine instead of a hand-edited per-role grid
 * — and the spawn dialog's preset field is now labelled "Riff preset", so the
 * two kinds of preset can never be confused.
 *
 * The recording opens Settings → Agent preset… from the command palette (the
 * dropdown arrives focused), opens the Customize disclosure, picks
 * `codex-workers` (the grid then shows Codex for the worker roles with a
 * `preset` chip and no reset links), picks `codex-review` over an explicit
 * review-role override (the override note appears), clears the preset with
 * None, then opens the spawn dialog to show the `Riff preset` field.
 *
 * Runs only under `just demo agent-preset-dropdown` (playwright.demo.config.ts —
 * testDir ./tests/demo), against the throwaway e2e rig, once per project
 * (desktop 1280x800, mobile 375x812).
 *
 * Shared setup: `/api/fab-config` is stubbed in the browser with presets
 * enabled (the stateful `_fab-config-stub` helper), so the recording never
 * touches the developer's real ~/.fab-kit/config.yaml; the riff-presets
 * preflight, the state socket and the server list are stubbed too, so the
 * spawn dialog opens without tmux or a repo. The settings dialog opens through
 * the palette on both projects; the spawn dialog through the palette's
 * `Agent: Spawn` entry.
 */
import { test, expect, beat } from "./_demo";
import { openPalette } from "../e2e/_ready";
import { stubFabConfig } from "../e2e/_fab-config-stub";
import { mockStateSocket } from "../e2e/_state-socket-mock";

const SERVER = "default";

test.describe("agent-preset-dropdown demo", () => {
  /**
   * Proves: a reviewer can see the preset dropdown take over the role grid —
   * focus from the palette action, the Customize disclosure, a preset's values
   * read as preset-supplied, the override note, None — and the spawn dialog's
   * renamed Riff preset field.
   *
   * Steps:
   * 1. Install the stateful `/api/fab-config` stub (presets on, one explicit
   *    review-role override) and the spawn-dialog stubs; load `/default/1`.
   * 2. Run `Settings: Agent preset…` from the palette; assert the Agent preset
   *    select is focused; `beat()`.
   * 3. Expand Customize; `beat()`.
   * 4. Choose `codex-workers`; assert the Worker CLI row reads `codex` with a
   *    `preset` chip; `beat()`.
   * 5. Choose `codex-review`; assert the override note; `beat()`.
   * 6. Choose None; assert the select is back to None; `beat()`.
   * 7. Close Settings, run `Agent: Spawn`; assert the `Riff preset (optional):`
   *    field; `beat()`.
   */
  test("the agent preset dropdown, Customize, and the Riff preset field", async ({ page }) => {
    await stubFabConfig(page, {
      systemPath: "/home/demo/.fab-kit/config.yaml",
      presets: true,
      system: { "agent.profiles.review.tool": "claude" },
    });
    await page.routeWebSocket(/\/ws\/terminals/, () => {});
    await page.route("**/api/servers", (route) =>
      route.fulfill({ json: [{ name: SERVER, sessionCount: 1 }] }),
    );
    await page.route("**/api/riff/presets*", (route) =>
      route.fulfill({
        json: {
          riff_presets: [
            { name: "discuss", layout: "", paneCount: 1 },
            { name: "incognito", layout: "", paneCount: 1 },
            { name: "blank", layout: "", paneCount: 1 },
          ],
          tiers: ["default", "doing", "fast", "operator", "review"],
        },
      }),
    );
    await mockStateSocket(page, {
      sessions: JSON.stringify([
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
      ]),
    });

    await page.goto(`/${SERVER}/1`);
    // The window heading is the one place the window name shows on both viewports
    // (the sidebar that lists it is a drawer on mobile).
    await expect(page.getByRole("button", { name: "Rename tab main" })).toBeVisible({ timeout: 10_000 });

    const palette = await openPalette(page);
    await palette.fill("Settings: Agent preset");
    await page.keyboard.press("Enter");
    const preset = page.getByTestId("agent-preset-select");
    await expect(preset).toBeFocused({ timeout: 10_000 });
    await beat(page);

    // The stub's explicit review-role override opens Customize by default; make
    // sure the grid is visible either way.
    const customize = page.getByTestId("agent-customize-toggle");
    if ((await customize.getAttribute("aria-expanded")) !== "true") await customize.click();
    await beat(page);

    await preset.selectOption("codex-workers");
    const workers = page.getByTestId("fab-row-agent.workers");
    await expect(workers.getByRole("button", { name: "codex" })).toHaveAttribute("aria-pressed", "true");
    await expect(workers.getByTestId("provenance-chip")).toHaveText("preset");
    await workers.scrollIntoViewIfNeeded();
    await beat(page, 1_500);

    await preset.scrollIntoViewIfNeeded();
    await preset.selectOption("codex-review");
    await expect(page.getByTestId("agent-preset-override-note")).toBeVisible();
    await beat(page, 1_500);

    await preset.selectOption("");
    await expect(preset).toHaveValue("");
    await beat(page);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
    const spawn = await openPalette(page);
    await spawn.fill("Agent: Spawn");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Spawn agent in dev" })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Riff preset (optional):")).toBeVisible();
    await beat(page, 1_500);
  });
});
