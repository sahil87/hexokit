/**
 * Demo: Settings > Agents defines presets in one place. A Leftover settings
 * box offers to move loose machine-wide values into a new preset; the Presets
 * section creates, edits, duplicates, renames and deletes presets with no Save
 * button; a built-in is read-only until it is duplicated.
 *
 * Runs only under `just demo agent-presets-editor` (playwright.demo.config.ts —
 * testDir ./tests/demo), against the throwaway e2e rig, once per project
 * (desktop 1280x800, mobile 375x812; the list stacks above the editor on the
 * phone).
 *
 * Shared setup: `/api/fab-config` and its preset routes are stubbed in the
 * browser (the stateful `_fab-config-stub` helper, presets on, two loose
 * system values seeded), so the recording never touches the developer's real
 * ~/.fab-kit/config.yaml. The dialog opens through the palette on both
 * projects (`Settings: Agents`).
 */
import type { Page } from "@playwright/test";
import { test, expect, beat } from "./_demo";
import { openPalette } from "../e2e/_ready";
import { stubFabConfig } from "../e2e/_fab-config-stub";

const editor = (page: Page) => page.getByTestId("preset-editor");
// The machine default's native <option>s share the role, so scope to the list.
const option = (page: Page, name: RegExp) => page.getByRole("listbox", { name: "Presets" }).getByRole("option", { name });

test.describe("agent-presets-editor demo", () => {
  /**
   * Proves: a reviewer can see leftover settings moved into a preset, a preset
   * created and edited in place, a built-in duplicated (the way to change it),
   * and a preset renamed and deleted.
   *
   * Steps:
   * 1. Install the stub with two loose system values; load `/`; open
   *    Settings → Agents; `beat()` on the Leftover settings box.
   * 2. Move the leftovers into `my-overrides`; assert the box is gone and the
   *    Machine default reads it; `beat()`.
   * 3. Click `+ New preset`, create `night-shift` with a description; set its
   *    review CLI to codex; `beat()`.
   * 4. Open the built-in `codex-review`; assert it is read-only; duplicate it;
   *    `beat()`.
   * 5. Rename the copy to `late-shift`; `beat()`.
   * 6. Delete `late-shift` through its confirm; `beat()`.
   */
  test("leftovers move into a preset; presets are created, duplicated, renamed and deleted", async ({ page }) => {
    await stubFabConfig(page, {
      systemPath: "/home/demo/.fab-kit/config.yaml",
      presets: true,
      system: { "agent.workers": "codex", "agent.profiles.review.effort": "low" },
    });

    await page.goto("/");
    const palette = await openPalette(page);
    await palette.fill("Settings: Agents");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
    const box = page.getByTestId("leftover-settings");
    await expect(box).toBeVisible({ timeout: 10_000 });
    await beat(page, 1_500);

    await box.getByRole("button", { name: "Move into a new preset" }).click();
    await beat(page);
    await box.getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByTestId("leftover-settings")).toHaveCount(0);
    await expect(page.getByTestId("agent-preset-select")).toHaveValue("my-overrides");
    await beat(page, 1_500);

    await page.getByRole("button", { name: "+ New preset" }).scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "+ New preset" }).click();
    await page.getByLabel("Preset name").fill("night-shift");
    await page.getByLabel("Preset description").fill("Overnight runs");
    await beat(page);
    await page.keyboard.press("Enter");
    await expect(editor(page)).toContainText("Editing night-shift");
    await editor(page).getByLabel("review CLI").selectOption("codex");
    await expect(editor(page).getByLabel("review CLI")).toHaveValue("codex");
    await beat(page, 1_500);

    await option(page, /^codex-review/).click();
    await expect(editor(page)).toContainText("built-in · read-only");
    await beat(page);
    await editor(page).getByRole("button", { name: "Duplicate" }).click();
    await beat(page);
    await page.keyboard.press("Enter");
    await expect(editor(page)).toContainText("Editing codex-review-copy");
    await beat(page);

    await editor(page).getByRole("button", { name: "Rename" }).click();
    await page.getByLabel("Preset name").fill("late-shift");
    await beat(page);
    await page.keyboard.press("Enter");
    await expect(editor(page)).toContainText("Editing late-shift");
    await beat(page);

    await editor(page).getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("alertdialog", { name: "Delete preset" })).toBeVisible();
    await beat(page);
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(option(page, /^late-shift/)).toHaveCount(0);
    await beat(page, 1_500);
  });
});
