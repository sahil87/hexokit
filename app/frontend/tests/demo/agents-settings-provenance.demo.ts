/**
 * Demo: Agents-tab provenance follow-ups. The split floor shows each leaf's
 * own provenance chip (a saved `min_rows` no longer reads as "default"), and a
 * role whose saved provider is shadowed by an env var keeps its reset link so
 * the saved value can still be cleared.
 *
 * Runs only under `just demo agents-settings-provenance` (optionally
 * `--before`), against the throwaway e2e rig, once per project (desktop
 * 1280x800, mobile 375x812). The spec is tolerant of the base build: it
 * records what is on screen and clicks the reset link only when it exists.
 *
 * Shared setup: `/api/fab-config` is stubbed in the browser (the stateful
 * `_fab-config-stub` helper) seeded with a system `dispatch.min_rows: 30` and
 * a system `review` provider `codex` that an env var overrides with `kimi`.
 */
import { test, expect, beat } from "./_demo";
import { openPalette } from "../e2e/_ready";
import { stubFabConfig } from "../e2e/_fab-config-stub";

test.describe("agents-settings-provenance demo", () => {
  /**
   * Proves: per-leaf split-floor provenance, and a reachable reset for an
   * env-shadowed saved role value.
   *
   * Steps:
   * 1. Install the seeded stub; load `/`; open Settings → Agents via the palette.
   * 2. Scroll to the split floor row; `beat()` on its chips.
   * 3. Scroll to the `review` role row; `beat()`; click its reset link when
   *    present and wait for the POST; `beat()`.
   */
  test("split floor and env-shadowed role provenance", async ({ page }) => {
    const posts = await stubFabConfig(page, {
      systemPath: "/home/demo/.fab-kit/config.yaml",
      system: { "dispatch.min_rows": 30, "agent.profiles.review.provider": "codex" },
      env: { "agent.profiles.review.provider": "kimi" },
    });

    await page.goto("/");
    const palette = await openPalette(page);
    await palette.fill("Settings: Agents");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");

    const floor = page.getByTestId("fab-row-dispatch.split-floor");
    await floor.scrollIntoViewIfNeeded();
    await expect(floor.getByTestId("provenance-chip").first()).toBeVisible();
    await beat(page, 1_500);

    const review = page.getByTestId("role-row-review");
    await review.scrollIntoViewIfNeeded();
    await beat(page, 1_500);
    const reset = review.getByRole("button", { name: "Reset review overrides" });
    if (await reset.isVisible()) {
      await reset.click();
      await expect.poll(() => posts.length).toBe(1);
      await expect(reset).toBeHidden();
    }
    await beat(page, 1_500);
  });
});
