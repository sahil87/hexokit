/**
 * Demo: the Settings dialog's All settings tab gains an `operator.merge_mode`
 * row. Before: the registry has no such key, so searching `merge_mode` finds
 * nothing. After: the row renders under Behavior as an enum select
 * (cherry-pick-ladder | stacked-prs | merge-auto) defaulting to
 * cherry-pick-ladder.
 *
 * Runs only under `just demo operator-merge-mode-row` (optionally `--before`),
 * against the throwaway e2e rig, once per project (desktop 1280x800, mobile
 * 375x812).
 *
 * Shared setup: none mocked — the rig's backend serves the registry-driven
 * `GET /api/settings` from its per-run temp config root, so the row comes from
 * the real settings registry and the recording only reads it (no write). Both
 * projects open the tab with the palette deep-link (`Settings: All`).
 */
import { test, expect, beat } from "./_demo";
import { openPalette } from "../e2e/_ready";

test.describe("operator-merge-mode-row demo", () => {
  /**
   * Proves: a reviewer can find the new `operator.merge_mode` setting in the
   * registry-driven All settings tab, with its three merge modes and the
   * cherry-pick-ladder default.
   *
   * Steps:
   * 1. Load `/`; open Settings → All settings via the palette; `beat()`.
   * 2. Search `merge_mode`; `beat()` on the filtered table (on the base ref
   *    the table reports no match and the row assertions are skipped).
   * 3. Assert the row's select holds `cherry-pick-ladder` and offers the
   *    three modes; scroll it into view and `beat()` for the still.
   */
  test("the All settings tab shows the operator.merge_mode row", async ({ page }) => {
    await page.goto("/");
    const palette = await openPalette(page);
    await palette.fill("Settings: All");
    await page.keyboard.press("Enter");
    const panel = page.getByTestId("settings-all-panel");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await beat(page);

    await panel.getByRole("searchbox", { name: "Search settings" }).fill("merge_mode");
    await beat(page, 1_000);

    if (process.env.DEMO_VARIANT !== "before") {
      const row = panel.getByTestId("setting-row-operator.merge_mode");
      await expect(row).toBeVisible();
      const select = row.getByRole("combobox", { name: "operator.merge_mode" });
      await expect(select).toHaveValue("cherry-pick-ladder");
      await expect(select.locator("option")).toHaveText([
        "cherry-pick-ladder",
        "stacked-prs",
        "merge-auto",
      ]);
      await row.scrollIntoViewIfNeeded();
    } else {
      await expect(panel.getByTestId("setting-row-operator.merge_mode")).toHaveCount(0);
    }
    await beat(page, 3_000);
  });
});
